import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as mock from "../js/firebase-mock.js";
import { editMatch } from "../js/mutations.js";
import { MODEL_VERSION, rebuildFromHistory } from "../js/rating-model.js";

const source = (name) => readFileSync(new URL(`../js/${name}`, import.meta.url), "utf8");

// Node exposes BroadcastChannel globally and an open one keeps the event loop alive,
// so every database a test opens is closed again when that test ends.
function newDb(t) {
  const db = mock.createMockDb();
  t.after(() => db.channel?.close());
  return db;
}

/**
 * Keys the security rules accept, kept next to the rules file so a client write that
 * grows a field fails here rather than as a permission error in the browser.
 */
const PLAYER_KEYS = ["name", "normalizedName", "createdAt", "updatedAt"];
const MATCH_KEYS = ["teamA", "teamB", "scoreA", "scoreB", "winner", "modelVersion", "createdAt", "updatedAt"];
const MATCH_UPDATE_KEYS = ["teamA", "teamB", "scoreA", "scoreB", "winner", "updatedAt"];

test("firestore.rules still lists exactly the fields the client writes", () => {
  const rules = readFileSync(new URL("../../../firestore.rules", import.meta.url), "utf8");
  const listed = [...rules.matchAll(/hasOnly\(\[([^\]]*)\]\)/g)].map((entry) => entry[1].match(/'[^']*'/g).map((key) => key.slice(1, -1)));
  const has = (keys) => listed.some((entry) => entry.length === keys.length && keys.every((key) => entry.includes(key)));
  assert.ok(has(PLAYER_KEYS), "player document schema");
  assert.ok(has(MATCH_KEYS), "match document schema");
  assert.ok(has(MATCH_UPDATE_KEYS), "match update mask");
  assert.ok(rules.includes(`'${MODEL_VERSION}'`), "rules pin the current model version");
});

test("the mock adapter exposes the Web SDK's DocumentSnapshot surface, not the Admin SDK's", async (t) => {
  const db = newDb(t);
  const found = await mock.getDocs(mock.collection(db, "players"));
  const snapshot = found.docs[0];
  assert.deepEqual(Object.keys(snapshot).sort(), ["data", "exists", "id", "metadata"]);
  assert.equal(snapshot.updateTime, undefined, "updateTime is Admin-SDK-only and must not be simulated");
  assert.ok(snapshot.data().updatedAt.toMillis() > 0, "updatedAt is the version token the client can actually read");
});

test("the mock adapter refuses a transactional query read, exactly as the Web SDK does", async (t) => {
  const db = newDb(t);
  const players = mock.query(mock.collection(db, "players"), mock.where("normalizedName", "==", "alex"));
  await assert.rejects(
    mock.runTransaction(db, (transaction) => transaction.get(players)),
    /requires a DocumentReference/,
  );
  const single = await mock.runTransaction(db, (transaction) => transaction.get(mock.doc(db, "players", "alex")));
  assert.equal(single.id, "alex");
});

test("no client module reads a query inside a transaction", () => {
  for (const name of ["app.js", "mutations.js"]) {
    const withoutComments = source(name).replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(/transaction\.get\(\s*\w*[Qq]uery/.test(withoutComments), false, `${name} passes a query to transaction.get`);
  }
});

test("mock mode is opt-in and never activates for a negative value", () => {
  const firebase = source("firebase.js");
  const enabled = (search) => {
    const params = new URLSearchParams(search);
    const value = params.get("mock");
    return value !== null && ["", "1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  };
  assert.ok(firebase.includes('["", "1", "true", "yes", "on"]'), "firebase.js uses this allow-list");
  assert.equal(enabled("?mock=1"), true);
  assert.equal(enabled("?mock"), true);
  assert.equal(enabled("?mock=true"), true);
  assert.equal(enabled("?mock=0"), false);
  assert.equal(enabled("?mock=false"), false);
  assert.equal(enabled(""), false);
  assert.equal(enabled("?utm_source=mockingbird"), false);
});

test("the mock module never reaches the network or persists outside memory", () => {
  const firebaseMock = source("firebase-mock.js").replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest", "googleapis", "import("]) {
    assert.equal(firebaseMock.includes(forbidden), false, `firebase-mock.js must not use ${forbidden}`);
  }
  assert.ok(source("firebase.js").includes("firebase-mock.js"), "the mock is only reachable through firebase.js");
});

const stamp = (iso) => { const value = new Date(iso).getTime(); return { toMillis: () => value, toDate: () => new Date(value), isEqual: (other) => other?.toMillis?.() === value }; };
const roster = () => [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];
const history = () => [
  { id: "m1", teamA: { playerIds: ["a"] }, teamB: { playerIds: ["b"] }, scoreA: 10, scoreB: 9, createdAt: stamp("2025-01-01T00:00:00Z") },
  { id: "m2", teamA: { playerIds: ["a"] }, teamB: { playerIds: ["c"] }, scoreA: 10, scoreB: 4, createdAt: stamp("2025-01-02T00:00:00Z") },
];
const ratings = (fit) => Object.fromEntries(fit.players.map((player) => [player.id, player.rating]));
const record = (fit, id) => { const player = fit.players.find((item) => item.id === id); return { games: player.games, wins: player.wins, losses: player.losses, provisional: player.provisional }; };

test("a decisive edit moves ratings the right way and reverting restores them exactly", () => {
  const base = rebuildFromHistory(roster(), history());
  const decisive = history(); decisive[0] = { ...decisive[0], scoreA: 10, scoreB: 0 };
  const after = rebuildFromHistory(roster(), decisive);

  assert.ok(after.theta.a > base.theta.a, "the winner gains from a 10-0 instead of a 10-9");
  assert.ok(after.theta.b < base.theta.b, "the loser drops further");
  assert.deepEqual(record(after, "a"), record(base, "a"), "games, wins and losses are unchanged by a score edit");

  const reverted = rebuildFromHistory(roster(), history());
  assert.deepEqual(ratings(reverted), ratings(base), "reverting reproduces the original model");
  assert.deepEqual(reverted.theta, base.theta);
});

test("deleting a match reproduces the model fitted from the remaining history alone", () => {
  const full = rebuildFromHistory(roster(), history());
  const remaining = history().filter((item) => item.id !== "m2");
  const afterDelete = rebuildFromHistory(roster(), remaining);
  const fromScratch = rebuildFromHistory(roster(), remaining);

  assert.deepEqual(afterDelete.theta, fromScratch.theta, "a rebuild is a pure function of the surviving history");
  assert.notDeepEqual(ratings(afterDelete), ratings(full));
  assert.deepEqual(record(afterDelete, "c"), { games: 0, wins: 0, losses: 0, provisional: true }, "an unreferenced player resets");
  assert.deepEqual(record(afterDelete, "a"), { games: 1, wins: 1, losses: 0, provisional: true });
});

test("deleting every match returns each player to the baseline rating", () => {
  const empty = rebuildFromHistory(roster(), []);
  assert.deepEqual(ratings(empty), { a: 1000, b: 1000, c: 1000 });
  assert.ok(Object.values(empty.theta).every((value) => value === 0));
});

test("rebuilt ratings and statistics are always finite", () => {
  const lopsided = [
    { id: "m1", teamA: { playerIds: ["a", "b"] }, teamB: { playerIds: ["c"] }, scoreA: 99, scoreB: 0, createdAt: stamp("2025-01-01T00:00:00Z") },
    { id: "m2", teamA: { playerIds: ["a"] }, teamB: { playerIds: ["b", "c"] }, scoreA: 0, scoreB: 99, createdAt: stamp("2025-01-02T00:00:00Z") },
  ];
  for (const matches of [[], history(), lopsided]) {
    const fit = rebuildFromHistory(roster(), matches);
    assert.ok(Number.isFinite(fit.beta), "beta is finite");
    assert.ok(Object.values(fit.theta).every(Number.isFinite), "every theta is finite");
    for (const player of fit.players) {
      assert.ok(Number.isFinite(player.rating) && Number.isInteger(player.rating), `${player.id} rating`);
      assert.ok([player.games, player.wins, player.losses].every(Number.isInteger));
      assert.equal(player.wins + player.losses, player.games);
    }
  }
});

test("an edited match keeps exactly the fields the update rule permits", async (t) => {
  const db = newDb(t);
  const api = { collection: mock.collection, doc: mock.doc, getDocs: mock.getDocs, query: mock.query, runTransaction: mock.runTransaction, serverTimestamp: mock.serverTimestamp, where: mock.where };
  const before = (await mock.runTransaction(db, (transaction) => transaction.get(mock.doc(db, "matches", "opening-match")))).data();

  await editMatch({ api, db, matchId: "opening-match", expectedVersion: before.updatedAt, input: { teamA: ["alex"], teamB: ["casey"], scoreA: 11, scoreB: 2 } });

  const after = (await mock.runTransaction(db, (transaction) => transaction.get(mock.doc(db, "matches", "opening-match")))).data();
  assert.deepEqual(Object.keys(after).sort(), MATCH_KEYS.slice().sort(), "the stored shape stays within the rules schema");
  const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key]));
  assert.deepEqual(changed.sort(), MATCH_UPDATE_KEYS.filter((key) => changed.includes(key)).sort());
  for (const key of changed) assert.ok(MATCH_UPDATE_KEYS.includes(key), `${key} is outside the update mask`);
  assert.equal(after.createdAt.toMillis(), before.createdAt.toMillis(), "createdAt is immutable");
  assert.equal(after.modelVersion, before.modelVersion, "modelVersion is immutable");
  assert.equal(after.winner, "A");
});
