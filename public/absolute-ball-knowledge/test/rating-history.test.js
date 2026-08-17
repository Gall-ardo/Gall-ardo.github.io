import assert from "node:assert/strict";
import test from "node:test";

import { computeRatingHistory } from "../js/rating-history.js";
import { displayRating, rebuildFromHistory } from "../js/rating-model.js";

const stamp = (iso) => {
  const value = new Date(iso).getTime();
  return { toMillis: () => value, toDate: () => new Date(value), isEqual: (other) => other?.toMillis?.() === value };
};
const roster = () => [{ id: "a", name: "Alex" }, { id: "b", name: "Blair" }, { id: "c", name: "Casey" }, { id: "d", name: "Devon" }];
const match = (id, teamA, teamB, scoreA, scoreB, iso) => ({ id, teamA: { playerIds: teamA }, teamB: { playerIds: teamB }, scoreA, scoreB, createdAt: stamp(iso) });
const history = () => [
  match("m1", ["a"], ["b"], 10, 7, "2025-01-01T10:00:00Z"),
  match("m2", ["a"], ["c"], 10, 4, "2025-01-02T10:00:00Z"),
  match("m3", ["b", "c"], ["a", "d"], 10, 8, "2025-01-03T10:00:00Z"),
];
const seriesFor = (result, id) => result.series.find((item) => item.playerId === id);
const ratingsAt = (result, index) => Object.fromEntries(
  result.series.map((item) => [item.playerId, item.values.find((value) => value.index === index)?.rating]).filter(([, rating]) => rating !== undefined),
);

test("with no matches there is only the baseline point and no player lines", () => {
  const result = computeRatingHistory(roster(), []);
  assert.equal(result.matchCount, 0);
  assert.deepEqual(result.points.map((point) => point.index), [0]);
  assert.deepEqual(result.series, [], "a player with no matches gets no meaningless flat line");
});

test("every line starts from the 1000 baseline at the point before the player's first match", () => {
  const result = computeRatingHistory(roster(), history());
  assert.equal(result.points.length, 4, "one baseline point plus one per match");
  assert.equal(seriesFor(result, "a").firstIndex, 0);
  assert.equal(seriesFor(result, "c").firstIndex, 1, "Casey debuts in match 2, so her line starts at point 1");
  for (const series of result.series) {
    assert.equal(series.values[0].rating, 1000, `${series.playerId} starts at the 1000 baseline`);
    assert.equal(series.values[0].theta, 0);
    assert.equal(series.values.at(-1).index, result.points.length - 1, "every line runs to the newest match");
  }
});

test("points are chronological and carry the match they belong to", () => {
  const result = computeRatingHistory(roster(), history().slice().reverse());
  assert.deepEqual(result.points.map((point) => point.matchId), [null, "m1", "m2", "m3"], "input order does not matter");
  const times = result.points.slice(1).map((point) => point.date.getTime());
  assert.deepEqual(times, times.slice().sort((x, y) => x - y), "matches replay oldest to newest");
  assert.deepEqual(result.points[3], {
    index: 3, matchId: "m3", date: new Date("2025-01-03T10:00:00Z"),
    scoreA: 10, scoreB: 8, teamA: ["b", "c"], teamB: ["a", "d"],
  });
});

test("matches recorded at the same instant replay in document-ID order, whatever the input order", () => {
  const tied = [
    match("zz", ["a"], ["b"], 10, 1, "2025-02-01T09:00:00Z"),
    match("aa", ["b"], ["a"], 10, 2, "2025-02-01T09:00:00Z"),
  ];
  const forwards = computeRatingHistory(roster(), tied);
  const backwards = computeRatingHistory(roster(), tied.slice().reverse());
  assert.deepEqual(forwards.points.map((point) => point.matchId), [null, "aa", "zz"]);
  assert.deepEqual(backwards.points.map((point) => point.matchId), [null, "aa", "zz"]);
  assert.deepEqual(ratingsAt(backwards, 1), ratingsAt(forwards, 1), "the intermediate point is deterministic too");
});

test("the final point is exactly the rating the leaderboard shows", () => {
  const players = roster();
  const matches = history();
  const result = computeRatingHistory(players, matches);
  const leaderboard = rebuildFromHistory(players, matches, { requireTimestamp: true });
  for (const player of leaderboard.players) {
    const series = seriesFor(result, player.id);
    if (!series) { assert.equal(player.games, 0, `${player.id} has no line, so must have no matches`); continue; }
    assert.equal(series.values.at(-1).rating, player.rating, `${player.name}'s last point must equal the leaderboard rating`);
    assert.equal(series.values.at(-1).theta, leaderboard.theta[player.id]);
  }
});

test("a heavier win moves the historical rating further than a narrow one", () => {
  const narrow = computeRatingHistory(roster(), [match("m1", ["a"], ["b"], 10, 9, "2025-01-01T10:00:00Z")]);
  const crushing = computeRatingHistory(roster(), [match("m1", ["a"], ["b"], 10, 0, "2025-01-01T10:00:00Z")]);
  const move = (result, id) => seriesFor(result, id).values.at(-1).rating - 1000;
  assert.ok(move(crushing, "a") > move(narrow, "a"), "10-0 must lift the winner further than 10-9");
  assert.ok(move(crushing, "b") < move(narrow, "b"), "and drop the loser further");
  assert.ok(move(narrow, "a") > 0 && move(narrow, "b") < 0, "a 10-9 still moves both");
});

test("editing the oldest match recomputes every later point", () => {
  const before = computeRatingHistory(roster(), history());
  const edited = history();
  edited[0] = { ...edited[0], scoreA: 10, scoreB: 0 };
  const after = computeRatingHistory(roster(), edited);

  assert.deepEqual(after.points.map((point) => point.matchId), before.points.map((point) => point.matchId), "the timeline is unchanged");
  for (let index = 1; index < before.points.length; index += 1) {
    assert.notDeepEqual(ratingsAt(after, index), ratingsAt(before, index), `point ${index} must be refitted`);
  }
  assert.equal(seriesFor(after, "a").values[0].rating, 1000, "the pre-history baseline never moves");
});

test("deleting an old match reproduces the curve fitted from the remaining history alone", () => {
  const remaining = history().filter((item) => item.id !== "m1");
  const afterDelete = computeRatingHistory(roster(), remaining);
  const fromScratch = computeRatingHistory(roster(), remaining);
  const full = computeRatingHistory(roster(), history());

  assert.deepEqual(afterDelete.series, fromScratch.series, "a rebuild is a pure function of the surviving history");
  assert.equal(afterDelete.points.length, 3);
  assert.notDeepEqual(ratingsAt(afterDelete, afterDelete.points.length - 1), ratingsAt(full, full.points.length - 1));
  assert.equal(seriesFor(afterDelete, "a").firstIndex, 0, "the earliest surviving match now opens the curve");
});

test("renaming a player changes nothing in the reconstruction", () => {
  const before = computeRatingHistory(roster(), history());
  const renamed = roster().map((player) => (player.id === "a" ? { ...player, name: "Alexandra" } : player));
  const after = computeRatingHistory(renamed, history());
  assert.deepEqual(after.series, before.series, "the history is keyed by player ID, never by name");
  assert.equal(after.series.some((series) => "name" in series), false, "names are resolved at render time");
});

test("ratings are the display formula applied to the fitted theta", () => {
  const result = computeRatingHistory(roster(), history());
  for (const series of result.series) {
    for (const value of series.values) {
      assert.equal(value.rating, displayRating(value.theta, result.config));
      assert.ok(Number.isInteger(value.rating) && Number.isFinite(value.theta));
    }
  }
});
