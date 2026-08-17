import assert from "node:assert/strict";
import test from "node:test";

import { MAIN_PAGE_MATCH_LIMIT, matchIds, matchSummary, renderMatchList } from "../js/match-list.js";

const stamp = (iso) => { const value = new Date(iso).getTime(); return { toMillis: () => value, toDate: () => new Date(value) }; };
/** The renderer only ever assigns innerHTML, so a plain object stands in for the node. */
const container = () => ({ innerHTML: "" });
const names = { a: "Alex", b: "Blair", c: "Casey" };
const nameFor = (id) => names[id] ?? "Unknown player";
const build = (count) => Array.from({ length: count }, (unused, index) => ({
  id: `m${count - index}`,
  teamA: { playerIds: ["a"] }, teamB: { playerIds: ["b"] },
  scoreA: 10, scoreB: index, modelVersion: "score_logistic_v1",
  createdAt: stamp(`2025-03-${String(count - index).padStart(2, "0")}T10:00:00Z`),
}));
const rowIds = (html) => [...html.matchAll(/data-match-id="([^"]+)"/g)].map((entry) => entry[1]);

test("the main page renders at most the newest five rows, in the order it is given", () => {
  const all = build(9);
  const node = container();
  renderMatchList(node, all.slice(0, MAIN_PAGE_MATCH_LIMIT), { nameFor });
  assert.equal(MAIN_PAGE_MATCH_LIMIT, 5);
  assert.deepEqual(rowIds(node.innerHTML), ["m9", "m8", "m7", "m6", "m5"], "newest first, nothing older");
});

test("the history page renders the complete list with the same markup", () => {
  const all = build(9);
  const short = container();
  const full = container();
  renderMatchList(short, all.slice(0, MAIN_PAGE_MATCH_LIMIT), { nameFor });
  renderMatchList(full, all, { nameFor });
  assert.equal(rowIds(full.innerHTML).length, 9);
  assert.deepEqual(rowIds(full.innerHTML).slice(0, 5), rowIds(short.innerHTML));
  assert.ok(full.innerHTML.startsWith(short.innerHTML.slice(0, 200)), "identical rows, only more of them");
});

test("each row keeps its edit and delete actions, and can be marked busy", () => {
  const node = container();
  renderMatchList(node, build(2), { nameFor, isPending: (key) => key === "match:m2" });
  assert.equal((node.innerHTML.match(/data-edit-match=/g) || []).length, 2);
  assert.equal((node.innerHTML.match(/data-delete-match=/g) || []).length, 2);
  assert.match(node.innerHTML, /data-edit-match="m2" disabled/);
  assert.doesNotMatch(node.innerHTML, /data-edit-match="m1" disabled/);
});

test("an empty list renders the empty state, not an empty grid", () => {
  const node = container();
  renderMatchList(node, [], { nameFor });
  assert.match(node.innerHTML, /No matches recorded yet/);
  assert.deepEqual(rowIds(node.innerHTML), []);
});

test("a match still saving shows the pending label instead of a date", () => {
  const node = container();
  renderMatchList(node, [{ id: "new", teamA: ["a"], teamB: ["b"], scoreA: 10, scoreB: 3 }], { nameFor });
  assert.match(node.innerHTML, /Saving…/);
  assert.match(node.innerHTML, /legacy match/, "a match without modelVersion is labelled, not blank");
});

test("player names are escaped and read from the current roster", () => {
  const node = container();
  renderMatchList(node, build(1), { nameFor: (id) => (id === "a" ? '<script>"x"' : "Blair") });
  assert.doesNotMatch(node.innerHTML, /<script>/);
  assert.match(node.innerHTML, /&lt;script&gt;/);
});

test("team IDs are read from every shape a stored match can have", () => {
  assert.deepEqual(matchIds({ teamA: ["a", "b"] }, "teamA"), ["a", "b"]);
  assert.deepEqual(matchIds({ teamA: { playerIds: ["a"] } }, "teamA"), ["a"]);
  assert.deepEqual(matchIds({ teamA: { players: [{ id: "a" }] } }, "teamA"), ["a"]);
  assert.deepEqual(matchIds({}, "teamA"), []);
});

test("the delete confirmation names both teams and the score", () => {
  const summary = matchSummary({ teamA: { playerIds: ["a", "c"] }, teamB: { playerIds: ["b"] }, scoreA: 10, scoreB: 5 }, nameFor);
  assert.equal(summary, "Alex, Casey 10–5 Blair");
});
