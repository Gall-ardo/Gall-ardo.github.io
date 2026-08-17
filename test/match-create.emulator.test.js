/**
 * Match-creation regression tests, driven through the real Firebase Web SDK against
 * the Firebase Emulator Suite.
 *
 *   firebase emulators:start --only firestore --project demo-abk
 *   npm run test:emulator
 *
 * These complement, and do not overlap, the two suites that already exist:
 *
 *   - `npm test` exercises the mutation layer against the in-memory adapter, which
 *     applies no security rules at all.
 *   - `npm run test:rules` posts hand-encoded documents to the emulator's REST API,
 *     which proves what the rules accept but never runs a line of client code.
 *
 * Neither of those covers match *creation* through the SDK the browser actually
 * loads. This one does: the same `runTransaction` + `serverTimestamp()` path
 * `app.js` `saveMatch` takes, judged by the repository's own firestore.rules.
 *
 * It fails closed. The emulator host must be loopback, the project ID must carry the
 * `demo-` prefix that makes the Firebase tooling refuse non-emulated services, and an
 * unreachable emulator throws rather than skipping.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { deleteApp, initializeApp } from "firebase/app";
import {
  collection,
  connectFirestoreEmulator,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  runTransaction,
  serverTimestamp,
  setDoc,
  terminate,
} from "firebase/firestore";

import { MODEL_VERSION, rebuildFromHistory, validateMatch } from "../public/absolute-ball-knowledge/js/rating-model.js";
import { MAX_TEAM_SIZE, validateEditableMatch } from "../public/absolute-ball-knowledge/js/mutations.js";

const HOST = process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8080";
const PROJECT = "demo-abk-create-sdk";

if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(HOST)) throw new Error(`Refusing to run against non-loopback host ${HOST}.`);
if (!PROJECT.startsWith("demo-")) throw new Error("Refusing to run against a non-demo project ID.");

const [EMULATOR_HOSTNAME, EMULATOR_PORT] = [HOST.replace(/:\d+$/, ""), Number(HOST.match(/:(\d+)$/)[1])];
const REST = `http://${HOST}/v1/projects/${PROJECT}/databases/(default)/documents`;

let app;
let db;

before(async () => {
  let response;
  try {
    response = await fetch(`http://${HOST}/`);
  } catch (error) {
    throw new Error(
      `Firestore Emulator is not reachable at ${HOST}. Start it with:\n` +
        `  firebase emulators:start --only firestore --project demo-abk\n(cause: ${error.message})`,
    );
  }
  assert.ok(response.ok, `Firestore Emulator answered HTTP ${response.status}`);

  app = initializeApp({ apiKey: "demo-key", projectId: PROJECT, appId: "1:0:web:demo" }, "match-create-tests");
  db = getFirestore(app);
  connectFirestoreEmulator(db, EMULATOR_HOSTNAME, EMULATOR_PORT);
});

after(async () => {
  await terminate(db);
  await deleteApp(app);
});

beforeEach(async () => {
  const response = await fetch(`http://${HOST}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  assert.ok(response.ok, `Could not clear the emulator: HTTP ${response.status}`);
});

// ---------------------------------------------------------------- the client path

/** The exact document `app.js` `saveMatch` commits, kept in one place. */
function matchWrite({ teamA, teamB, scoreA, scoreB }) {
  return {
    scoreA,
    scoreB,
    teamA: { playerIds: teamA },
    teamB: { playerIds: teamB },
    winner: scoreA > scoreB ? "A" : "B",
    modelVersion: MODEL_VERSION,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

/**
 * Mirrors `saveMatch`: validate with the same function the edit path uses, then a
 * transaction that reads every named player before writing. `saveMatch` itself lives
 * in app.js, which cannot be imported outside a browser; the browser end-to-end suite
 * covers the real function, and this reproduces its Firestore-facing half.
 */
async function createMatch(input, knownPlayerIds) {
  const match = validateEditableMatch(input, knownPlayerIds);
  const matchRef = doc(collection(db, "matches"));
  await runTransaction(db, async (transaction) => {
    const ids = [...match.teamA, ...match.teamB];
    const snapshots = await Promise.all(ids.map((id) => transaction.get(doc(db, "players", id))));
    if (snapshots.some((snapshot) => !snapshot.exists())) {
      throw new Error("One or more selected players no longer exist. Refresh and choose again.");
    }
    transaction.set(matchRef, matchWrite(match));
  });
  return matchRef.id;
}

async function addPlayers(...names) {
  const ids = [];
  for (const name of names) {
    const id = `name_${name.toLowerCase()}`;
    await setDoc(doc(db, "players", id), {
      name,
      normalizedName: name.toLowerCase(),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    ids.push(id);
  }
  return ids;
}

async function storedMatches() {
  const found = await getDocs(collection(db, "matches"));
  return found.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function storedPlayers() {
  const found = await getDocs(collection(db, "players"));
  return found.docs.map((item) => ({ id: item.id, ...item.data() }));
}

const permissionDenied = async (run, message) => {
  await assert.rejects(run, (error) => error.code === "permission-denied", `${message}: expected the rules to deny this write`);
};

// ---------------------------------------------------------------- creation

describe("match creation through the real Firebase Web SDK", () => {
  it("creates a valid 1v1 match that the rules accept", async () => {
    const [alex, blair] = await addPlayers("Alex", "Blair");
    const id = await createMatch({ teamA: [alex], teamB: [blair], scoreA: 10, scoreB: 7 }, new Set([alex, blair]));

    const stored = (await getDoc(doc(db, "matches", id))).data();
    assert.equal(stored.scoreA, 10);
    assert.equal(stored.scoreB, 7);
    assert.equal(stored.winner, "A");
    assert.equal(stored.modelVersion, MODEL_VERSION);
    assert.deepEqual(stored.teamA.playerIds, [alex]);
    assert.deepEqual(stored.teamB.playerIds, [blair]);
  });

  it("creates a valid 2v2 match", async () => {
    const ids = await addPlayers("Alex", "Blair", "Casey", "Devon");
    const [alex, blair, casey, devon] = ids;
    const id = await createMatch(
      { teamA: [alex, casey], teamB: [blair, devon], scoreA: 10, scoreB: 5 },
      new Set(ids),
    );

    const stored = (await getDoc(doc(db, "matches", id))).data();
    assert.deepEqual(stored.teamA.playerIds, [alex, casey]);
    assert.deepEqual(stored.teamB.playerIds, [blair, devon]);
    assert.equal(stored.winner, "A");
  });

  it("writes exactly the fields the create rule admits, and no others", async () => {
    const [alex, blair] = await addPlayers("Alex", "Blair");
    const id = await createMatch({ teamA: [alex], teamB: [blair], scoreA: 10, scoreB: 7 }, new Set([alex, blair]));

    const stored = (await getDoc(doc(db, "matches", id))).data();
    assert.deepEqual(
      Object.keys(stored).sort(),
      ["createdAt", "modelVersion", "scoreA", "scoreB", "teamA", "teamB", "updatedAt", "winner"],
      "the stored key set must match validStoredMatch's hasOnly list exactly",
    );
    // Server timestamps must have resolved, not stayed sentinels.
    assert.ok(stored.createdAt?.toDate instanceof Function, "createdAt is a resolved timestamp");
    assert.ok(stored.updatedAt?.toDate instanceof Function, "updatedAt is a resolved timestamp");
    // Scores must be on the wire as integers, which is what `scoreA is int` requires.
    const raw = await (await fetch(`${REST}/matches/${id}`)).json();
    assert.deepEqual(raw.fields.scoreA, { integerValue: "10" });
    assert.deepEqual(raw.fields.scoreB, { integerValue: "7" });
  });

  it("stores a document the app can read back and rebuild from", async () => {
    const ids = await addPlayers("Alex", "Blair", "Casey", "Devon");
    const [alex, blair, casey, devon] = ids;
    await createMatch({ teamA: [alex], teamB: [blair], scoreA: 10, scoreB: 7 }, new Set(ids));
    await createMatch({ teamA: [alex, casey], teamB: [blair, devon], scoreA: 10, scoreB: 5 }, new Set(ids));

    const matches = await storedMatches();
    // The app's own parser accepts the stored shape unchanged.
    for (const match of matches) validateMatch(match, new Set(ids), { requireTimestamp: true });

    const rebuilt = rebuildFromHistory(await storedPlayers(), matches, { requireTimestamp: true });
    const by = Object.fromEntries(rebuilt.players.map((player) => [player.id, player]));

    assert.equal(by[alex].games, 2);
    assert.equal(by[alex].wins, 2);
    assert.equal(by[alex].losses, 0);
    assert.equal(by[blair].games, 2);
    assert.equal(by[blair].wins, 0);
    assert.equal(by[blair].losses, 2);
    assert.equal(by[casey].games, 1);
    assert.equal(by[casey].wins, 1);
    assert.equal(by[devon].games, 1);
    assert.equal(by[devon].losses, 1);

    // Winning lifts a rating above the 1000 baseline and losing pushes it below.
    assert.ok(by[alex].rating > 1000, `expected Alex above 1000, got ${by[alex].rating}`);
    assert.ok(by[blair].rating < 1000, `expected Blair below 1000, got ${by[blair].rating}`);
  });

  it("survives a reload: a created match is still there on a fresh read", async () => {
    const [alex, blair] = await addPlayers("Alex", "Blair");
    const id = await createMatch({ teamA: [alex], teamB: [blair], scoreA: 10, scoreB: 7 }, new Set([alex, blair]));

    // A second app instance, with its own cache, reads the committed document.
    const second = initializeApp({ apiKey: "demo-key", projectId: PROJECT, appId: "1:0:web:demo" }, `reload-${Date.now()}`);
    const secondDb = getFirestore(second);
    connectFirestoreEmulator(secondDb, EMULATOR_HOSTNAME, EMULATOR_PORT);
    try {
      const stored = await getDoc(doc(secondDb, "matches", id));
      assert.ok(stored.exists(), "the match must still exist for a freshly connected client");
      assert.equal(stored.data().scoreA, 10);
    } finally {
      await terminate(secondDb);
      await deleteApp(second);
    }
  });
});

// ---------------------------------------------------------------- rejections

describe("invalid match documents the rules reject", () => {
  let alex;
  let blair;

  beforeEach(async () => {
    [alex, blair] = await addPlayers("Alex", "Blair");
  });

  const write = (fields) => setDoc(doc(collection(db, "matches")), fields);
  const base = () => ({
    scoreA: 10,
    scoreB: 7,
    teamA: { playerIds: [alex] },
    teamB: { playerIds: [blair] },
    winner: "A",
    modelVersion: MODEL_VERSION,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  it("rejects a tied score", async () => {
    await permissionDenied(write({ ...base(), scoreA: 7, scoreB: 7, winner: "A" }), "tie");
  });

  it("rejects overlapping teams", async () => {
    await permissionDenied(write({ ...base(), teamA: { playerIds: [alex] }, teamB: { playerIds: [alex] } }), "overlap");
  });

  it("rejects an empty team", async () => {
    await permissionDenied(write({ ...base(), teamB: { playerIds: [] } }), "empty team");
  });

  it("rejects a decimal score", async () => {
    await permissionDenied(write({ ...base(), scoreA: 10.5 }), "decimal score");
  });

  it("rejects a score sent as a string", async () => {
    await permissionDenied(write({ ...base(), scoreA: "10" }), "string score");
  });

  it("rejects a negative score", async () => {
    await permissionDenied(write({ ...base(), scoreA: -1, winner: "B" }), "negative score");
  });

  it("rejects a winner that disagrees with the score", async () => {
    await permissionDenied(write({ ...base(), winner: "B" }), "winner mismatch");
  });

  it("rejects a create without modelVersion", async () => {
    const fields = base();
    delete fields.modelVersion;
    await permissionDenied(write(fields), "missing modelVersion");
  });

  it("rejects a create without createdAt or updatedAt", async () => {
    const withoutCreated = base();
    delete withoutCreated.createdAt;
    await permissionDenied(write(withoutCreated), "missing createdAt");

    const withoutUpdated = base();
    delete withoutUpdated.updatedAt;
    await permissionDenied(write(withoutUpdated), "missing updatedAt");
  });

  it("rejects an unexpected extra field", async () => {
    await permissionDenied(write({ ...base(), notes: "hello" }), "extra field");
  });

  it("rejects a team above the twenty-player ceiling", async () => {
    const oversized = Array.from({ length: MAX_TEAM_SIZE + 1 }, (_, index) => `name_p${index}`);
    await permissionDenied(write({ ...base(), teamA: { playerIds: oversized } }), "oversized team");
  });
});

// ---------------------------------------------------- rejections before the write

describe("invalid input the client refuses before it reaches Firestore", () => {
  const known = new Set(["a", "b", "c"]);
  const rejects = (input, expected) =>
    assert.throws(() => validateEditableMatch(input, known), new RegExp(expected), `${expected}: expected a client-side rejection`);

  it("rejects a tie", () => rejects({ teamA: ["a"], teamB: ["b"], scoreA: 7, scoreB: 7 }, "cannot end in a draw"));
  it("rejects overlapping teams", () => rejects({ teamA: ["a"], teamB: ["a"], scoreA: 10, scoreB: 7 }, "cannot be on both teams"));
  it("rejects a duplicate inside one team", () => rejects({ teamA: ["a", "a"], teamB: ["b"], scoreA: 10, scoreB: 7 }, "twice on one team"));
  it("rejects an empty team", () => {
    rejects({ teamA: [], teamB: ["b"], scoreA: 10, scoreB: 7 }, "Both teams need at least one player");
    rejects({ teamA: ["a"], teamB: [], scoreA: 10, scoreB: 7 }, "Both teams need at least one player");
  });
  it("rejects a decimal score", () => rejects({ teamA: ["a"], teamB: ["b"], scoreA: 10.5, scoreB: 7 }, "non-negative whole numbers"));
  it("rejects a negative score", () => rejects({ teamA: ["a"], teamB: ["b"], scoreA: -1, scoreB: 7 }, "non-negative whole numbers"));
  it("rejects an unknown player", () => rejects({ teamA: ["a"], teamB: ["zzz"], scoreA: 10, scoreB: 7 }, "unknown player"));
  it("rejects a team above the ceiling", () => {
    const oversized = Array.from({ length: MAX_TEAM_SIZE + 1 }, (_, index) => `p${index}`);
    assert.throws(
      () => validateEditableMatch({ teamA: oversized, teamB: ["b"], scoreA: 10, scoreB: 7 }, new Set([...oversized, "b"])),
      /more than 20 players/,
    );
  });

  it("aborts the transaction when a selected player was deleted meanwhile", async () => {
    const [alex, blair] = await addPlayers("Alex", "Blair");
    // Validation passes -- the ID is known to the client -- but the document is gone.
    await fetch(`${REST}/players/${blair}`, { method: "DELETE" });
    await assert.rejects(
      createMatch({ teamA: [alex], teamB: [blair], scoreA: 10, scoreB: 7 }, new Set([alex, blair])),
      /no longer exist/,
    );
    assert.equal((await storedMatches()).length, 0, "no match document may be left behind");
  });

  it("pins the documented limitation: the rules alone do not check that players exist", async () => {
    // Recorded so that a future rules change closing this is noticed here rather than
    // silently making the client's existence check the only thing that ever mattered.
    const [alex] = await addPlayers("Alex");
    await setDoc(doc(collection(db, "matches")), {
      scoreA: 10,
      scoreB: 7,
      teamA: { playerIds: [alex] },
      teamB: { playerIds: ["name_does_not_exist"] },
      winner: "A",
      modelVersion: MODEL_VERSION,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    assert.equal((await storedMatches()).length, 1, "the rules accept an unknown player ID; only the client refuses it");
  });
});
