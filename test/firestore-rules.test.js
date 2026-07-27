/**
 * Security-rules tests for firestore.rules, run against the Firebase Emulator Suite.
 *
 *   firebase emulators:start --only firestore --project demo-abk
 *   npm run test:rules
 *
 * These are deliberately not part of `npm test`: that suite is hermetic, and this one
 * needs a running emulator and a JDK. The suite talks to the emulator's REST API
 * rather than the Firebase SDK so it stays dependency-free, and so every write can
 * pin its exact wire type — `is int` versus a double, a timestamp versus a string.
 *
 * It fails closed. The host must be loopback, the project ID must carry the `demo-`
 * prefix that makes the Firebase tooling refuse non-emulated services, and the rules
 * under test are uploaded from the repository's own firestore.rules on every run. If
 * the emulator is not reachable the suite throws instead of skipping.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, it } from "node:test";

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const PROJECT = "demo-abk-rules-test";
const RULES_PATH = new URL("../firestore.rules", import.meta.url);
const BASE = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(HOST)) throw new Error(`Refusing to run against non-loopback host ${HOST}.`);
if (!PROJECT.startsWith("demo-")) throw new Error("Refusing to run against a non-demo project ID.");

// ---------------------------------------------------------------- wire encoding

/** Escape hatch for a wire type JavaScript cannot express, such as a whole-number double. */
const raw = (value) => ({ __raw: value });

function encode(value) {
  if (value === null) return { nullValue: null };
  if (value && typeof value === "object" && "__raw" in value) return value.__raw;
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  return { mapValue: { fields: fields(value) } };
}

const fields = (document) => Object.fromEntries(Object.entries(document).map(([key, value]) => [key, encode(value)]));

// ---------------------------------------------------------------- emulator calls

async function call(method, path, { body, owner = false, mask } = {}) {
  const query = mask ? `?${mask.map((field) => `updateMask.fieldPaths=${encodeURIComponent(field)}`).join("&")}` : "";
  const response = await fetch(`${BASE}/${path}${query}`, {
    method,
    headers: { "Content-Type": "application/json", ...(owner ? { Authorization: "Bearer owner" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.status;
}

/** A client `setDoc`: a full-document write, judged by the rules. */
const write = (path, document) => call("PATCH", path, { body: { fields: fields(document) } });
/** A client `updateDoc`: only the listed fields are touched, the rest of the document survives. */
const patch = (path, document) => call("PATCH", path, { body: { fields: fields(document) }, mask: Object.keys(document) });
const remove = (path) => call("DELETE", path);
/** Bypasses the rules, so a test can plant a document the rules themselves would refuse. */
const seed = (path, document) => call("PATCH", path, { body: { fields: fields(document) }, owner: true });

const ALLOWED = 200;
const DENIED = 403;
const allowed = (status, message) => assert.equal(status, ALLOWED, `${message}: expected the rules to allow this write, got HTTP ${status}`);
const denied = (status, message) => assert.equal(status, DENIED, `${message}: expected the rules to deny this write, got HTTP ${status}`);

// ---------------------------------------------------------------- document shapes

const NOW = new Date("2026-07-27T12:00:00.000Z");
const LATER = new Date("2026-07-27T13:00:00.000Z");
const PLAYER_A = "name_aaaa";
const PLAYER_B = "name_bbbb";
const PLAYER_C = "name_cccc";

/** The exact shape app.js `addPlayer` commits, with serverTimestamp() already resolved. */
const player = (overrides = {}) => ({ name: "Ada Lovelace", normalizedName: "ada lovelace", createdAt: NOW, updatedAt: NOW, ...overrides });

/** The exact shape app.js `saveMatch` commits. */
const match = (overrides = {}) => ({
  scoreA: 3, scoreB: 1, winner: "A", modelVersion: "score_logistic_v1",
  teamA: { playerIds: [PLAYER_A] }, teamB: { playerIds: [PLAYER_B] },
  createdAt: NOW, updatedAt: NOW, ...overrides,
});

/** The exact field set mutations.js `matchWrite` sends through `transaction.update`. */
const matchEdit = (overrides = {}) => ({
  scoreA: 5, scoreB: 2, winner: "A",
  teamA: { playerIds: [PLAYER_A] }, teamB: { playerIds: [PLAYER_B] },
  updatedAt: LATER, ...overrides,
});

/** The exact field set mutations.js `renamePlayer` sends through `transaction.update`. */
const rename = (overrides = {}) => ({ name: "Ada Byron", normalizedName: "ada byron", updatedAt: LATER, ...overrides });

let counter = 0;
const fresh = (collection) => `${collection}/doc_${counter++}`;

// ---------------------------------------------------------------- fixtures

before(async () => {
  const probe = await fetch(`http://${HOST}/`).catch(() => null);
  if (!probe) throw new Error(`Firestore emulator is not reachable at ${HOST}. Start it with: firebase emulators:start --only firestore --project demo-abk`);

  const content = await readFile(RULES_PATH, "utf8");
  const loaded = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}:securityRules`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rules: { files: [{ name: "firestore.rules", content }] } }),
  });
  if (!loaded.ok) throw new Error(`The emulator rejected firestore.rules: ${loaded.status} ${await loaded.text()}`);

  // If the owner credential did not bypass the rules, every seeded fixture below would
  // silently be a rules-shaped write and the deny tests would prove nothing.
  assert.equal(await seed("players/seed_probe", { junk: "not a player" }), ALLOWED, "owner seeding must bypass the rules");
  assert.equal(await write("players/seed_probe_denied", { junk: "not a player" }), DENIED, "unauthenticated writes must be judged by the rules");
});

after(async () => {
  await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" }).catch(() => {});
});

// ---------------------------------------------------------------- allowed writes

describe("players: operations the client performs", () => {
  it("allows creating a player in the exact shape addPlayer() commits", async () => {
    allowed(await write(fresh("players"), player()), "valid player create");
  });

  it("allows renaming a player, preserving the document ID and createdAt", async () => {
    const path = fresh("players");
    await seed(path, player());
    allowed(await patch(path, rename()), "valid player rename");
    // The rename is a field-level update, so the document ID never changes and
    // createdAt is never part of the write.
    assert.equal(await call("GET", path), ALLOWED, "the renamed document is still readable at the same ID");
  });

  it("allows deleting a player", async () => {
    const path = fresh("players");
    await seed(path, player());
    allowed(await remove(path), "valid player delete");
  });

  it("allows renaming and deleting a player written before updatedAt existed", async () => {
    // `documentVersion` in mutations.js falls back to createdAt for exactly these
    // documents, and the README calls them out, so both mutations have to reach them.
    const { updatedAt, ...legacy } = player();
    const renamed = fresh("players");
    await seed(renamed, legacy);
    allowed(await patch(renamed, rename()), "rename of a player with no updatedAt");

    const deleted = fresh("players");
    await seed(deleted, legacy);
    allowed(await remove(deleted), "delete of a player with no updatedAt");
  });
});

describe("matches: operations the client performs", () => {
  it("allows creating a match in the exact shape saveMatch() commits", async () => {
    allowed(await write(fresh("matches"), match()), "valid match create");
  });

  it("allows editing a match: only teams, scores, winner and updatedAt change", async () => {
    const path = fresh("matches");
    await seed(path, match());
    allowed(await patch(path, matchEdit()), "valid match edit");
  });

  it("allows deleting a match", async () => {
    const path = fresh("matches");
    await seed(path, match());
    allowed(await remove(path), "valid match delete");
  });

  it("allows editing a match written before updatedAt existed, adding the field", async () => {
    // Every match the committed HEAD of app.js wrote lacks updatedAt: it set createdAt
    // only. Those documents have to stay editable.
    const path = fresh("matches");
    const { updatedAt, ...legacy } = match();
    await seed(path, legacy);
    allowed(await patch(path, matchEdit()), "edit of a match with no updatedAt");
  });

  it("allows deleting a match written before updatedAt existed", async () => {
    const path = fresh("matches");
    const { updatedAt, ...legacy } = match();
    await seed(path, legacy);
    allowed(await remove(path), "delete of a match with no updatedAt");
  });

  it("allows editing a match written before modelVersion existed, without inventing it", async () => {
    // mutations.js `editMatch` deliberately omits modelVersion so it is never added to
    // a document that predates the field, and mutations.test.js asserts that. The UI
    // labels such a document "legacy match" and still offers Edit, so the rules have
    // to admit the edit.
    const path = fresh("matches");
    const { modelVersion, ...legacy } = match();
    await seed(path, legacy);
    allowed(await patch(path, matchEdit()), "edit of a match with no modelVersion");
  });

  it("allows deleting a match written before modelVersion existed", async () => {
    const path = fresh("matches");
    const { modelVersion, ...legacy } = match();
    await seed(path, legacy);
    allowed(await remove(path), "delete of a match with no modelVersion");
  });

  it("allows editing a match written before either stamp existed", async () => {
    const path = fresh("matches");
    const { modelVersion, updatedAt, ...legacy } = match();
    await seed(path, legacy);
    allowed(await patch(path, matchEdit()), "edit of a match with neither stamp");
  });

  it("allows the largest team the rules admit", async () => {
    const twenty = Array.from({ length: 20 }, (_, index) => `name_${index}`);
    allowed(await write(fresh("matches"), match({ teamA: { playerIds: twenty } })), "20-player team");
  });
});

// ---------------------------------------------------------------- denied writes

describe("players: writes the rules must refuse", () => {
  it("denies a blank name", async () => {
    denied(await write(fresh("players"), player({ name: "", normalizedName: "" })), "blank name");
  });

  it("denies a one-character name, matching the client's minimum", async () => {
    denied(await write(fresh("players"), player({ name: "A", normalizedName: "a" })), "single-character name");
  });

  it("denies an overlong name", async () => {
    denied(await write(fresh("players"), player({ name: "x".repeat(41) })), "41-character name");
  });

  it("denies an overlong normalizedName", async () => {
    denied(await write(fresh("players"), player({ normalizedName: "x".repeat(41) })), "41-character normalizedName");
  });

  it("denies missing required fields", async () => {
    for (const key of ["name", "normalizedName", "createdAt", "updatedAt"]) {
      const document = player();
      delete document[key];
      denied(await write(fresh("players"), document), `player missing ${key}`);
    }
  });

  it("denies extra arbitrary fields", async () => {
    denied(await write(fresh("players"), player({ rating: 9999 })), "player with an injected rating");
    denied(await write(fresh("players"), player({ isAdmin: true })), "player with an injected flag");
  });

  it("denies wrong field types", async () => {
    denied(await write(fresh("players"), player({ name: 42 })), "numeric name");
    denied(await write(fresh("players"), player({ normalizedName: ["ada"] })), "list normalizedName");
    denied(await write(fresh("players"), player({ name: null })), "null name");
  });

  it("denies malformed timestamps", async () => {
    denied(await write(fresh("players"), player({ createdAt: "2026-07-27T12:00:00Z" })), "createdAt as a string");
    denied(await write(fresh("players"), player({ updatedAt: 1769515200000 })), "updatedAt as a number");
  });

  it("denies changing the immutable createdAt", async () => {
    const path = fresh("players");
    await seed(path, player());
    denied(await patch(path, { ...rename(), createdAt: LATER }), "rename that moves createdAt");
  });

  it("denies an update that introduces a new field", async () => {
    const path = fresh("players");
    await seed(path, player());
    denied(await patch(path, { ...rename(), rating: 4200 }), "rename that injects a rating");
  });

  it("denies an update that drops the document to an arbitrary shape", async () => {
    const path = fresh("players");
    await seed(path, player());
    denied(await write(path, { junk: "corrupted" }), "wholesale player corruption");
  });

  it("denies renaming a player to an invalid name", async () => {
    const path = fresh("players");
    await seed(path, player());
    denied(await patch(path, rename({ name: "", normalizedName: "" })), "rename to blank");
    denied(await patch(path, rename({ name: "x".repeat(41) })), "rename to an overlong name");
  });
});

describe("matches: writes the rules must refuse", () => {
  it("denies empty teams", async () => {
    denied(await write(fresh("matches"), match({ teamA: { playerIds: [] } })), "empty teamA");
    denied(await write(fresh("matches"), match({ teamB: { playerIds: [] } })), "empty teamB");
  });

  it("denies a team larger than the rules admit", async () => {
    const twentyOne = Array.from({ length: 21 }, (_, index) => `name_${index}`);
    denied(await write(fresh("matches"), match({ teamA: { playerIds: twentyOne } })), "21-player team");
  });

  it("denies a malformed team map", async () => {
    denied(await write(fresh("matches"), match({ teamA: { playerIds: [PLAYER_A], players: [PLAYER_A] } })), "team with an extra key");
    denied(await write(fresh("matches"), match({ teamA: [PLAYER_A] })), "team as a bare list");
    denied(await write(fresh("matches"), match({ teamA: { playerIds: "name_aaaa" } })), "playerIds as a string");
  });

  it("denies a player appearing on both teams", async () => {
    denied(await write(fresh("matches"), match({ teamA: { playerIds: [PLAYER_A, PLAYER_C] }, teamB: { playerIds: [PLAYER_A] } })), "shared player across teams");
    denied(await write(fresh("matches"), match({ teamA: { playerIds: [PLAYER_A] }, teamB: { playerIds: [PLAYER_B, PLAYER_A] } })), "shared player, teamB side");
  });

  it("denies negative scores", async () => {
    denied(await write(fresh("matches"), match({ scoreA: -1, scoreB: -3, winner: "A" })), "negative scores");
    denied(await write(fresh("matches"), match({ scoreA: 3, scoreB: -1 })), "one negative score");
  });

  it("denies decimal scores", async () => {
    denied(await write(fresh("matches"), match({ scoreA: 3.5 })), "fractional score");
    // A whole-number double is the shape a careless client produces; `is int` must still reject it.
    denied(await write(fresh("matches"), match({ scoreA: raw({ doubleValue: 3 }) })), "whole-number double score");
    denied(await write(fresh("matches"), match({ scoreA: "3" })), "score as a string");
  });

  it("denies tied scores", async () => {
    denied(await write(fresh("matches"), match({ scoreA: 2, scoreB: 2 })), "draw");
    denied(await write(fresh("matches"), match({ scoreA: 0, scoreB: 0 })), "goalless draw");
  });

  it("denies a winner that disagrees with the scores", async () => {
    denied(await write(fresh("matches"), match({ scoreA: 3, scoreB: 1, winner: "B" })), "winner contradicting the score");
    denied(await write(fresh("matches"), match({ winner: "C" })), "unknown winner label");
    denied(await write(fresh("matches"), match({ winner: "" })), "blank winner");
  });

  it("denies a wrong or missing modelVersion on create", async () => {
    denied(await write(fresh("matches"), match({ modelVersion: "score_logistic_v2" })), "unknown modelVersion");
    const { modelVersion, ...withoutModel } = match();
    denied(await write(fresh("matches"), withoutModel), "match create without modelVersion");
  });

  it("denies missing required fields", async () => {
    for (const key of ["scoreA", "scoreB", "winner", "teamA", "teamB", "createdAt", "updatedAt"]) {
      const document = match();
      delete document[key];
      denied(await write(fresh("matches"), document), `match missing ${key}`);
    }
  });

  it("denies extra arbitrary fields", async () => {
    denied(await write(fresh("matches"), match({ note: "hi" })), "match with an injected note");
    denied(await write(fresh("matches"), match({ ratingDelta: 32 })), "match with an injected rating delta");
  });

  it("denies malformed timestamps", async () => {
    denied(await write(fresh("matches"), match({ createdAt: "yesterday" })), "createdAt as a string");
    denied(await write(fresh("matches"), match({ updatedAt: 0 })), "updatedAt as a number");
  });

  it("denies changing the immutable createdAt on edit", async () => {
    const path = fresh("matches");
    await seed(path, match());
    denied(await patch(path, { ...matchEdit(), createdAt: LATER }), "edit that moves createdAt");
  });

  it("denies changing the immutable modelVersion on edit", async () => {
    const path = fresh("matches");
    await seed(path, match());
    denied(await patch(path, { ...matchEdit(), modelVersion: "score_logistic_v2" }), "edit that rewrites modelVersion");
  });

  it("denies stamping modelVersion onto a match that predates the field", async () => {
    const path = fresh("matches");
    const { modelVersion, ...legacy } = match();
    await seed(path, legacy);
    denied(await patch(path, { ...matchEdit(), modelVersion: "score_logistic_v1" }), "edit that invents modelVersion");
  });

  it("denies an edit that leaves the document without updatedAt", async () => {
    const path = fresh("matches");
    const { updatedAt, ...legacy } = match();
    await seed(path, legacy);
    denied(await patch(path, { scoreA: 5, scoreB: 2 }), "edit that does not stamp updatedAt");
  });

  it("denies an edit that introduces a new field", async () => {
    const path = fresh("matches");
    await seed(path, match());
    denied(await patch(path, { ...matchEdit(), note: "injected" }), "edit that injects a field");
  });

  it("denies an edit into an invalid match", async () => {
    const path = fresh("matches");
    await seed(path, match());
    denied(await patch(path, matchEdit({ scoreA: 2, scoreB: 2 })), "edit into a draw");
    denied(await patch(path, matchEdit({ teamA: { playerIds: [] } })), "edit into an empty team");
    denied(await patch(path, matchEdit({ teamB: { playerIds: [PLAYER_A] } })), "edit into overlapping teams");
  });

  it("denies wholesale corruption of an existing match", async () => {
    const path = fresh("matches");
    await seed(path, match());
    denied(await write(path, { junk: "corrupted" }), "wholesale match corruption");
  });
});

// ---------------------------------------------------------------- Unicode bounds

/**
 * Firestore Rules `string.size()` counts UTF-16 code units, exactly like JavaScript's
 * `String.prototype.length`. It is neither a UTF-8 byte count nor a code point count:
 * an astral character such as an emoji or a mathematical letter counts 2 in both
 * languages, and a combining mark counts as its own unit in both. That is what makes
 * the client's `name.length` checks in mutations.js `cleanPlayerName` and the rules'
 * `name.size()` bounds the same predicate, for every script.
 *
 * These tests pin that equivalence, because a divergence would silently turn a name
 * the client accepts into a permission error in the browser.
 */
describe("Unicode: rules size() agrees with the client's String.length", () => {
  // Built from code points rather than written as literals: an editor or a filesystem
  // normalising this source would otherwise fold a decomposed sample into its
  // precomposed form and quietly stop testing the combining-mark case at all.
  const cp = (...points) => String.fromCodePoint(...points);

  const samples = {
    "Turkish dotted I (U+0130)": cp(0x0130),
    "Turkish lowercase i (U+0069)": cp(0x0069),
    "Turkish dotless i (U+0131)": cp(0x0131),
    "Turkish s-cedilla (U+015F)": cp(0x015f),
    "accented Latin, precomposed e-acute (U+00E9)": cp(0x00e9),
    "accented Latin, decomposed e + combining acute": cp(0x0065, 0x0301),
    "combining i + U+0307, the lowercase of the dotted I": cp(0x0069, 0x0307),
    "BMP emoji, soccer ball (U+26BD)": cp(0x26bd),
    "astral emoji, slightly smiling face (U+1F642)": cp(0x1f642),
    "astral Latin letter, bold capital A (U+1D400)": cp(0x1d400),
  };

  for (const [label, character] of Object.entries(samples)) {
    it(`admits a 40-unit name and refuses a 41-unit name built from ${label}`, async () => {
      // Repeat to the exact JavaScript length the client bounds, never to a
      // character count, so the assertion is about UTF-16 units on both sides.
      const atLimit = character.repeat(Math.floor(40 / character.length));
      const overLimit = character.repeat(Math.floor(40 / character.length) + 1);
      assert.ok(atLimit.length <= 40, `${label}: the 40-unit sample must satisfy the client bound`);
      assert.ok(overLimit.length > 40, `${label}: the over-limit sample must break the client bound`);

      allowed(await write(fresh("players"), player({ name: atLimit, normalizedName: atLimit })), `${label} at the 40-unit limit`);
      denied(await write(fresh("players"), player({ name: overLimit, normalizedName: overLimit })), `${label} past the 40-unit limit`);
    });
  }

  it("admits the shortest name the client admits, in every script", async () => {
    // `cleanPlayerName` requires two UTF-16 units. A single astral character is
    // already two units, so it has to be accepted by the rules as well.
    for (const [label, value] of Object.entries({
      "two Turkish letters": cp(0x0131, 0x0130),
      "one astral letter": cp(0x1d400),
      "one astral emoji": cp(0x1f642),
      "letter plus combining mark": cp(0x0065, 0x0301),
    })) {
      assert.equal(value.length, 2, `${label}: sample must be exactly two UTF-16 units`);
      allowed(await write(fresh("players"), player({ name: value, normalizedName: value })), `${label} at the 2-unit minimum`);
    }
  });

  it("refuses a name one UTF-16 unit below the client's minimum", async () => {
    for (const point of [0x0130, 0x0131, 0x00e9, 0x26bd]) {
      const value = cp(point);
      assert.equal(value.length, 1, "sample must be exactly one UTF-16 unit");
      denied(await write(fresh("players"), player({ name: value, normalizedName: value })), `single-unit name U+${point.toString(16).toUpperCase()}`);
    }
  });

  it("keeps a Turkish name whose lowercase form grows within both bounds", async () => {
    // "İ".toLocaleLowerCase("en") is "i" plus a combining dot above, so normalizing
    // doubles the length. cleanPlayerName bounds the normalized form for exactly this
    // reason; the rules bound it too, and the two bounds have to agree.
    const name = cp(0x0130).repeat(20);
    const normalized = name.toLocaleLowerCase("en");
    assert.equal(name.length, 20);
    assert.equal(normalized.length, 40, "the normalized form must land exactly on the shared 40-unit ceiling");
    allowed(await write(fresh("players"), player({ name, normalizedName: normalized })), "Turkish name normalizing to exactly 40 units");

    const overflowingName = cp(0x0130).repeat(21);
    const overflowing = overflowingName.toLocaleLowerCase("en");
    assert.equal(overflowing.length, 42, "one more dotted I must overflow the ceiling");
    denied(await write(fresh("players"), player({ name: overflowingName, normalizedName: overflowing })), "Turkish name normalizing past 40 units");
  });
});

// ---------------------------------------------------------------- known limitations

/**
 * These assert what the rules deliberately do NOT enforce. They exist so that the
 * limitations documented in firestore.rules and README.md stay honest: if a later
 * change accidentally started enforcing one of them, that would be a welcome surprise
 * worth noticing, and if the documentation ever claims they are enforced, these tests
 * contradict it.
 */
describe("documented limitations: invariants the rules cannot express", () => {
  it("cannot reject a duplicate player ID inside one team", async () => {
    // Rules have no way to detect duplicates within a list. The client's validateMatch
    // rejects this; the rules cannot.
    allowed(await write(fresh("matches"), match({ teamA: { playerIds: [PLAYER_A, PLAYER_A] } })), "duplicate ID within one team");
  });

  it("cannot reject a match that references a player document that does not exist", async () => {
    allowed(await write(fresh("matches"), match({ teamA: { playerIds: ["name_never_created"] } })), "match naming an absent player");
  });

  it("cannot reject a second player claiming a normalizedName already in use", async () => {
    await write(fresh("players"), player({ name: "Duplicate", normalizedName: "duplicate" }));
    allowed(await write(fresh("players"), player({ name: "Duplicate", normalizedName: "duplicate" })), "second player with the same normalizedName");
  });

  it("cannot reject deleting a player who is still named by a match", async () => {
    const path = fresh("players");
    await seed(path, player());
    await write(fresh("matches"), match({ teamA: { playerIds: [path.split("/")[1]] } }));
    allowed(await remove(path), "delete of a player a match still references");
  });
});
