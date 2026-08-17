/**
 * The Create Teams screen offers up to three splits. These checks pin the properties
 * that make that list trustworthy: it comes from the existing balancer, option 1 is
 * the best-balanced partition it found, no option repeats another, and every
 * participant lands on exactly one side of every option.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TEAM_OPTION_LIMIT, TEAM_OPTION_TOLERANCE, balanceTeams, playerTheta, teamOptions } from "../js/logic.js";
import { predictMatch } from "../js/rating-model.js";

const player = (id, rating) => ({ id, name: id.toUpperCase(), rating });
const roster = (...ratings) => ratings.map((rating, index) => player(String.fromCharCode(97 + index), rating));

/** The same partition regardless of which side carries the Team A label. */
const unorderedKey = (option) =>
  [option.teamA.map((p) => p.id).sort().join(","), option.teamB.map((p) => p.id).sort().join(",")].sort().join("|");
const orderedKey = (option) => `${option.teamA.map((p) => p.id).sort().join(",")}|${option.teamB.map((p) => p.id).sort().join(",")}`;

function assertPartition(option, players) {
  const each = [...option.teamA, ...option.teamB].map((p) => p.id);
  assert.equal(new Set(each).size, each.length, "no player may appear twice in one option");
  assert.deepEqual(each.slice().sort(), players.map((p) => p.id).sort(), "every participant must appear exactly once");
  assert.ok(option.teamA.length > 0 && option.teamB.length > 0, "both sides need a player");
}

/** The imbalance the app itself ranks by, recomputed from the option's own members. */
function imbalanceOf(option, beta) {
  const mean = (team) => team.reduce((sum, p) => sum + playerTheta(p), 0) / team.length;
  return Math.abs(predictMatch(mean(option.teamA), mean(option.teamB), option.teamA.length, option.teamB.length, beta) - 0.5);
}

test("four players yield several distinct options, best balance first", () => {
  const players = roster(1040, 1020, 1000, 980);
  const options = teamOptions(players, { beta: 0 });
  assert.ok(options.length > 1, `expected multiple options, got ${options.length}`);
  assert.ok(options.length <= TEAM_OPTION_LIMIT);
  for (const option of options) assertPartition(option, players);
  for (let i = 1; i < options.length; i += 1) {
    assert.ok(options[i].imbalance >= options[i - 1].imbalance - 1e-12, "options must be ordered best first");
  }
});

test("option 1 is the minimum-imbalance split over every possible partition", () => {
  for (const players of [roster(1180, 1090, 1010, 940), roster(1300, 1210, 1100, 1000, 900), roster(1150, 1120, 1080, 1000, 980, 900)]) {
    const beta = 0.1;
    const [best] = teamOptions(players, { beta });
    // Brute force every subset, independently of the balancer's own enumeration.
    let minimum = Infinity;
    for (let mask = 1; mask < (1 << players.length) - 1; mask += 1) {
      const teamA = players.filter((_, index) => mask & (1 << index));
      const teamB = players.filter((_, index) => !(mask & (1 << index)));
      if (Math.abs(teamA.length - teamB.length) > 1) continue;
      minimum = Math.min(minimum, imbalanceOf({ teamA, teamB }, beta));
    }
    assert.ok(Math.abs(best.imbalance - minimum) < 1e-12, `best option ${best.imbalance} vs brute-force ${minimum}`);
    assert.ok(Math.abs(imbalanceOf(best, beta) - best.imbalance) < 1e-12, "the reported imbalance matches the option's own members");
  }
});

test("five players keep a valid 3v2 split and a single orientation when beta is zero", () => {
  const players = roster(1300, 1210, 1100, 1000, 900);
  const options = teamOptions(players, { beta: 0 });
  for (const option of options) {
    assertPartition(option, players);
    assert.equal(Math.abs(option.teamA.length - option.teamB.length), 1, "an odd roster splits 3v2");
    assert.equal(option.teamA.length + option.teamB.length, 5);
  }
  const keys = options.map(unorderedKey);
  assert.equal(new Set(keys).size, keys.length, "with no size effect, a swapped orientation is the same option");
});

test("five players expose both orientations only when the size effect makes them differ", () => {
  const players = roster(1300, 1210, 1100, 1000, 900);
  const options = teamOptions(players, { beta: 0.4 });
  for (const option of options) assertPartition(option, players);
  const ordered = options.map(orderedKey);
  assert.equal(new Set(ordered).size, ordered.length, "no option may repeat another exactly");
  for (const [index, option] of options.entries()) {
    const twin = options.findIndex((other, i) => i !== index && unorderedKey(other) === unorderedKey(option));
    if (twin >= 0) {
      assert.ok(
        Math.abs(options[twin].imbalance - option.imbalance) > 1e-12,
        "the same partition may appear twice only when the orientation actually changes the prediction",
      );
    }
  }
});

test("six and eight players return three near-optimal alternatives", () => {
  for (const players of [roster(1150, 1120, 1080, 1000, 980, 900), roster(1200, 1160, 1120, 1080, 1040, 1000, 960, 900)]) {
    const options = teamOptions(players, { beta: 0.1 });
    assert.equal(options.length, TEAM_OPTION_LIMIT);
    for (const option of options) {
      assertPartition(option, players);
      assert.equal(option.teamA.length, option.teamB.length, "an even roster splits evenly");
      assert.ok(option.imbalance <= options[0].imbalance + TEAM_OPTION_TOLERANCE + 1e-12, "alternatives stay inside the near-optimal band");
    }
    const keys = options.map(unorderedKey);
    assert.equal(new Set(keys).size, keys.length, "no duplicate-equivalent partition");
  }
});

test("options are exactly the head of the balancer's own candidate list", () => {
  const players = roster(1180, 1090, 1010, 940, 1200, 870);
  const beta = 0.1;
  const fromBalancer = balanceTeams(players, { beta, topK: 6, nearOptimalTolerance: TEAM_OPTION_TOLERANCE })
    .topCandidates.slice(0, TEAM_OPTION_LIMIT);
  assert.deepEqual(teamOptions(players, { beta }).map(orderedKey), fromBalancer.map(orderedKey));
});

test("a group with only one possible split shows one option", () => {
  const players = roster(1100, 900);
  const options = teamOptions(players, { beta: 0 });
  assert.equal(options.length, 1);
  assertPartition(options[0], players);
});

test("selection is deterministic and free of side effects on the input", () => {
  const players = roster(1180, 1090, 1010, 940, 1200, 870);
  const snapshot = JSON.stringify(players);
  const first = teamOptions(players, { beta: 0.1 }).map(orderedKey);
  const second = teamOptions(players, { beta: 0.1 }).map(orderedKey);
  assert.deepEqual(first, second, "the same roster must produce the same options");
  assert.equal(JSON.stringify(players), snapshot, "the participant list must not be mutated");
});

test("an invalid participant list is rejected rather than silently balanced", () => {
  assert.throws(() => teamOptions([player("a", 1000)], {}), /at least two/i);
  assert.throws(() => teamOptions([player("a", 1000), player("a", 1000)], {}), /unique/i);
});
