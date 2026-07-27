import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TEAM_SIZE, cleanPlayerName, deleteMatch, deleteUnusedPlayer, documentVersion, editMatch, renamePlayer, validateEditableMatch } from "../js/mutations.js";
import { rebuildFromHistory } from "../js/rating-model.js";

class Stamp {
  constructor(value) { this.value = value; }
  toMillis() { return this.value; }
  toDate() { return new Date(this.value); }
  isEqual(other) { return other instanceof Stamp && other.value === this.value; }
}
const stamp = (value) => new Stamp(value);
const dated = (value) => new Stamp(new Date(value).getTime());
const ref = (collection, id) => ({ collection, id });

/**
 * Shaped after the Firestore Web SDK, not the Admin SDK. Two differences matter and
 * are asserted on below: a DocumentSnapshot carries no `updateTime`, so optimistic
 * concurrency has to ride on the `updatedAt` the client writes, and Transaction.get
 * refuses a query.
 */
function mockDatabase({ players = [], matches = [] } = {}) {
  let clock = new Date("2025-06-01T00:00:00Z").getTime();
  const tick = () => stamp((clock += 1000));
  const data = {
    players: new Map(players.map((item) => [item.id, { ...item }])),
    matches: new Map(matches.map((item) => [item.id, { ...item }])),
  };
  const snap = (item, id) => ({
    id,
    exists: () => Boolean(item),
    data: () => item && { ...item },
    metadata: { hasPendingWrites: false, fromCache: false },
  });
  const resolve = (change) => Object.fromEntries(Object.entries(change).map(([key, value]) => [key, value === "server-time" ? tick() : value]));
  const matching = (collection, condition) => [...data[collection].entries()].filter(([, item]) => {
    const value = condition.field.split(".").reduce((result, key) => result?.[key], item);
    return condition.op === "array-contains" ? Array.isArray(value) && value.includes(condition.value) : value === condition.value;
  }).map(([id, item]) => snap(item, id));
  const api = {
    collection: (_db, name) => ({ collection: name }),
    doc: (_db, collection, id) => ref(collection, id),
    where: (field, op, value) => ({ field, op, value }),
    query: (base, condition) => ({ collection: base.collection, condition }),
    serverTimestamp: () => "server-time",
    async getDocs(query) { return { docs: matching(query.collection, query.condition) }; },
    async runTransaction(_db, callback) {
      const transaction = {
        async get(target) {
          if (target.condition) throw new TypeError("Transaction.get() requires a DocumentReference; queries cannot be read in a transaction.");
          return snap(data[target.collection].get(target.id), target.id);
        },
        update(target, change) {
          data[target.collection].set(target.id, { ...data[target.collection].get(target.id), ...resolve(change) });
        },
        delete(target) { data[target.collection].delete(target.id); },
      };
      return callback(transaction);
    },
  };
  return { api, db: {}, data, tick };
}

function players() {
  return [
    { id: "a", name: "Alex", normalizedName: "alex", createdAt: dated("2025-01-01"), updatedAt: dated("2025-01-01") },
    { id: "b", name: "Blair", normalizedName: "blair", createdAt: dated("2025-01-01"), updatedAt: dated("2025-01-01") },
    { id: "c", name: "Casey", normalizedName: "casey", createdAt: dated("2025-01-01"), updatedAt: dated("2025-01-01") },
  ];
}
function match(id = "m1", scoreA = 10, scoreB = 5) {
  return { id, teamA: { playerIds: ["a"] }, teamB: { playerIds: ["b"] }, scoreA, scoreB, winner: "A", modelVersion: "score_logistic_v1", createdAt: dated("2025-01-02T10:00:00Z"), updatedAt: dated("2025-01-02T10:00:00Z") };
}
function version(item) { return documentVersion(item); }

test("valid player rename preserves document ID and trims whitespace", async () => {
  const store = mockDatabase({ players: players() });
  await renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: "  Alexis   Morgan ", expectedVersion: version(store.data.players.get("a")) });
  const player = store.data.players.get("a");
  assert.equal(player.name, "Alexis Morgan");
  assert.equal(player.normalizedName, "alexis morgan");
  assert.equal(player.id, "a");
});

test("blank and case-insensitive duplicate player renames are rejected", async () => {
  const store = mockDatabase({ players: players() });
  await assert.rejects(renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: "   ", expectedVersion: version(store.data.players.get("a")) }), /cannot be blank/);
  await assert.rejects(renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: " BLAIR ", expectedVersion: version(store.data.players.get("a")) }), /already exists/);
});

test("deleting an unused player succeeds, while deleting a referenced player is blocked", async () => {
  const unused = mockDatabase({ players: players() });
  await deleteUnusedPlayer({ api: unused.api, db: unused.db, playerId: "c", expectedVersion: version(unused.data.players.get("c")) });
  assert.equal(unused.data.players.has("c"), false);
  const used = mockDatabase({ players: players(), matches: [match()] });
  await assert.rejects(deleteUnusedPlayer({ api: used.api, db: used.db, playerId: "a", expectedVersion: version(used.data.players.get("a")) }), /appear in recorded matches/);
  assert.equal(used.data.players.has("a"), true);
});

test("valid match edit preserves createdAt and validates live players", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const original = store.data.matches.get("m1").createdAt;
  await editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: version(store.data.matches.get("m1")), input: { teamA: ["a", "c"], teamB: ["b"], scoreA: 7, scoreB: 3 } });
  const edited = store.data.matches.get("m1");
  assert.deepEqual(edited.teamA.playerIds, ["a", "c"]);
  assert.equal(edited.scoreA, 7); assert.equal(edited.scoreB, 3);
  assert.equal(edited.createdAt, original);
  assert.ok(edited.updatedAt instanceof Object && edited.updatedAt.toMillis() > original.toMillis(), "updatedAt advances");
});

test("overlapping teams and tied scores are rejected before a match write", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const expectedVersion = version(store.data.matches.get("m1"));
  await assert.rejects(editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion, input: { teamA: ["a"], teamB: ["a", "b"], scoreA: 3, scoreB: 2 } }), /both teams/);
  await assert.rejects(editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion, input: { teamA: ["a"], teamB: ["b"], scoreA: 3, scoreB: 3 } }), /draw/);
  assert.equal(store.data.matches.get("m1").scoreA, 10);
});

test("match deletion removes only the selected match", async () => {
  const store = mockDatabase({ players: players(), matches: [match("m1"), match("m2", 4, 9)] });
  await deleteMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: version(store.data.matches.get("m1")) });
  assert.equal(store.data.matches.has("m1"), false); assert.equal(store.data.matches.has("m2"), true);
});

test("rating rebuilds and games/wins/losses stay consistent after edits and deletions", async () => {
  const initialMatches = [match("m1", 10, 2), { ...match("m2", 2, 10), teamA: { playerIds: ["a"] }, teamB: { playerIds: ["c"] }, createdAt: dated("2025-01-03T10:00:00Z") }];
  const store = mockDatabase({ players: players(), matches: initialMatches });
  const before = rebuildFromHistory(players(), [...store.data.matches.values()]);
  await editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: version(store.data.matches.get("m1")), input: { teamA: ["a"], teamB: ["b"], scoreA: 1, scoreB: 10 } });
  const afterEdit = rebuildFromHistory(players(), [...store.data.matches.values()]);
  assert.notEqual(afterEdit.theta.a, before.theta.a);
  const alex = afterEdit.players.find((player) => player.id === "a");
  assert.deepEqual({ games: alex.games, wins: alex.wins, losses: alex.losses }, { games: 2, wins: 0, losses: 2 });
  assert.ok(Object.values(afterEdit.theta).every(Number.isFinite));
  assert.ok(afterEdit.players.every((player) => Number.isFinite(player.rating)));
  await deleteMatch({ api: store.api, db: store.db, matchId: "m2", expectedVersion: version(store.data.matches.get("m2")) });
  const afterDelete = rebuildFromHistory(players(), [...store.data.matches.values()]);
  assert.equal(afterDelete.players.find((player) => player.id === "a").games, 1);
  assert.notEqual(afterDelete.theta.a, afterEdit.theta.a);
  assert.ok(Object.values(afterDelete.theta).every(Number.isFinite));
});

test("stale and concurrently deleted records are not silently overwritten", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const staleVersion = version(store.data.matches.get("m1"));
  store.data.matches.get("m1").updatedAt = store.tick();
  await assert.rejects(editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: staleVersion, input: { teamA: ["a"], teamB: ["b"], scoreA: 3, scoreB: 2 } }), /changed in another browser/);
  store.data.matches.delete("m1");
  await assert.rejects(deleteMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: staleVersion }), /already deleted/);
});

test("a rename never reads a query inside the transaction, which the Web SDK forbids", async () => {
  const store = mockDatabase({ players: players() });
  const reads = [];
  const inner = store.api.runTransaction;
  store.api.runTransaction = (db, callback) => inner(db, (transaction) => callback({
    ...transaction,
    get: (target) => { reads.push(target); return transaction.get(target); },
  }));
  await renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: "Alexis", expectedVersion: version(store.data.players.get("a")) });
  assert.equal(store.data.players.get("a").name, "Alexis");
  assert.ok(reads.length > 0);
  assert.ok(reads.every((target) => target.condition === undefined), "every transactional read is a document reference");
});

test("a duplicate that was renamed away before the commit no longer blocks the rename", async () => {
  const store = mockDatabase({ players: players() });
  const inner = store.api.getDocs;
  // Blair still holds "blair" during the pre-transaction scan, then frees it.
  store.api.getDocs = async (query) => {
    const result = await inner(query);
    store.data.players.get("b").normalizedName = "blaire";
    store.data.players.get("b").name = "Blaire";
    return result;
  };
  await renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: "Blair", expectedVersion: version(store.data.players.get("a")) });
  assert.equal(store.data.players.get("a").name, "Blair");
  assert.equal(store.data.players.get("a").normalizedName, "blair");
});

test("optimistic concurrency rides on updatedAt, since Web SDK snapshots carry no updateTime", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const snapshot = await store.api.runTransaction(store.db, (transaction) => transaction.get({ collection: "players", id: "a" }));
  assert.equal(snapshot.updateTime, undefined, "the double must not offer an Admin-SDK-only field");
  assert.ok(documentVersion(store.data.players.get("a")), "a stored player yields a version token");

  const staleVersion = version(store.data.players.get("a"));
  await renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: "Alexis", expectedVersion: staleVersion });
  await assert.rejects(
    renamePlayer({ api: store.api, db: store.db, playerId: "a", nextName: "Alexandra", expectedVersion: staleVersion }),
    /changed in another browser/,
    "a second write reusing the pre-rename token is refused",
  );
  assert.equal(store.data.players.get("a").name, "Alexis");
});

test("a stale match delete using a pre-edit version token is refused", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const staleVersion = version(store.data.matches.get("m1"));
  await editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: staleVersion, input: { teamA: ["a"], teamB: ["b"], scoreA: 9, scoreB: 4 } });
  await assert.rejects(deleteMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: staleVersion }), /changed in another browser/);
  assert.equal(store.data.matches.has("m1"), true);
});

test("a match edit leaves modelVersion and createdAt untouched", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const legacy = { ...match("m2"), createdAt: dated("2025-01-04T10:00:00Z") };
  delete legacy.modelVersion;
  store.data.matches.set("m2", legacy);

  await editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: version(store.data.matches.get("m1")), input: { teamA: ["a"], teamB: ["b"], scoreA: 6, scoreB: 1 } });
  assert.equal(store.data.matches.get("m1").modelVersion, "score_logistic_v1");

  await editMatch({ api: store.api, db: store.db, matchId: "m2", expectedVersion: version(store.data.matches.get("m2")), input: { teamA: ["a"], teamB: ["c"], scoreA: 8, scoreB: 2 } });
  assert.ok(!("modelVersion" in store.data.matches.get("m2")), "an absent modelVersion is not invented, which the rules would reject");
});

test("a team larger than the security rules admit is rejected before the write", () => {
  // firestore.rules caps a team at MAX_TEAM_SIZE. Without this check the browser would
  // build a valid-looking match and only learn it was refused as a permission error.
  const roster = Array.from({ length: MAX_TEAM_SIZE + 1 }, (_, index) => `p${index}`);
  const known = new Set([...roster, "z"]);
  assert.throws(() => validateEditableMatch({ teamA: roster, teamB: ["z"], scoreA: 3, scoreB: 1 }, known), /more than 20 players/);
  assert.throws(() => validateEditableMatch({ teamA: ["z"], teamB: roster, scoreA: 1, scoreB: 3 }, known), /more than 20 players/);

  const atLimit = roster.slice(0, MAX_TEAM_SIZE);
  assert.deepEqual(
    validateEditableMatch({ teamA: atLimit, teamB: ["z"], scoreA: 3, scoreB: 1 }, new Set([...atLimit, "z"])).teamA.length,
    MAX_TEAM_SIZE,
  );
});

test("an oversized team is refused without touching the match document", async () => {
  const store = mockDatabase({ players: players(), matches: [match()] });
  const roster = Array.from({ length: MAX_TEAM_SIZE + 1 }, (_, index) => `p${index}`);
  await assert.rejects(
    editMatch({ api: store.api, db: store.db, matchId: "m1", expectedVersion: version(store.data.matches.get("m1")), input: { teamA: roster, teamB: ["b"], scoreA: 3, scoreB: 1 } }),
    /more than 20 players/,
  );
  assert.deepEqual(store.data.matches.get("m1").teamA.playerIds, ["a"], "the stored match is untouched");
});

test("names whose lowercase form exceeds the stored limit are rejected with a readable message", () => {
  assert.deepEqual(cleanPlayerName("  Ada   Lovelace "), { name: "Ada Lovelace", normalizedName: "ada lovelace" });
  // "İ" lowercases to "i" plus a combining dot, doubling the normalized length.
  assert.equal("İ".repeat(40).toLocaleLowerCase("en").length, 80);
  assert.throws(() => cleanPlayerName("İ".repeat(40)), /between 2 and 40 characters/);
  assert.throws(() => cleanPlayerName("  "), /cannot be blank/);
  assert.throws(() => cleanPlayerName("--"), /must contain a letter or number/);
});
