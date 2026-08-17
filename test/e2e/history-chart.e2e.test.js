/**
 * Browser end-to-end regression for the latest-5 match list, the full history page
 * and the Rating History chart.
 *
 *   npm run build
 *   firebase emulators:start --only firestore --project demo-abk
 *   npm run test:e2e
 *
 * Same terms as match-create.e2e.test.js: the built site, the real Firebase Web SDK
 * pointed at the emulator, and every host but loopback and the SDK CDN aborted. See
 * harness.js.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { guardRoutes, instrument, readCollection, requireEmulator, resetEmulator, startSite } from "./harness.js";
import { rebuildFromHistory } from "../../public/absolute-ball-knowledge/js/rating-model.js";
import { computeRatingHistory } from "../../public/absolute-ball-knowledge/js/rating-history.js";

const PLAYERS = ["Alex", "Blair", "Casey", "Devon"];

let site;
let browser;

before(async () => {
  await requireEmulator();
  site = await startSite();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await site?.close();
});

/** A page wired to the harness's instrumentation and host guard. */
async function openApp(options = {}) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const record = instrument(page);
  await guardRoutes(context, record);
  await page.goto(site.url, { waitUntil: "domcontentloaded" });
  await live(page);
  return { context, page, record };
}

const live = (page) =>
  page.waitForFunction(() => document.querySelector("#connection-status")?.textContent === "Live", { timeout: 20000 });

async function addPlayer(page, name, opener = "#record [data-open-player]") {
  await page.click(opener);
  await page.fill("#player-name", name);
  await page.click("#add-player");
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("#team-a-options .check-option span")].some((s) => s.textContent === n),
    name,
    { timeout: 15000 },
  );
}

async function recordMatch(page, teamA, teamB, scoreA, scoreB) {
  for (const box of await page.$$("#team-a-options input:checked")) await box.click();
  for (const box of await page.$$("#team-b-options input:checked")) await box.click();
  for (const name of teamA) await page.click(`#team-a-options .check-option:has-text("${name}") input`);
  for (const name of teamB) await page.click(`#team-b-options .check-option:has-text("${name}") input`);
  await page.fill("#score-a", String(scoreA));
  await page.fill("#score-b", String(scoreB));
  const before = (await readCollection("matches")).length;
  await page.click("#save-match");
  await page.waitForFunction(
    (count) => document.querySelector("#match-count")?.textContent.includes(String(count)),
    before + 1,
    { timeout: 15000 },
  );
  // The list first shows "Saving…" and settles once the server timestamp lands.
  await page.waitForFunction(() => !document.querySelector("#recent-matches")?.textContent.includes("Saving…"), { timeout: 15000 });
}

const rowIds = (page, selector) => page.$$eval(`${selector} .match-row`, (rows) => rows.map((row) => row.dataset.matchId));
const rowText = (page, selector) => page.$eval(selector, (element) => element.textContent.replace(/\s+/g, " ").trim());

const leaderboard = (page) =>
  page.$$eval("#leaderboard-body tr", (rows) =>
    rows.map((row) => {
      const cells = [...row.children].map((cell) => cell.textContent.trim());
      return { name: cells[1].replace(/(EditDelete|\(provisional\))/g, "").trim(), rating: Number(cells[2]) };
    }));

/** Each drawn line, as the ratings it actually plots. */
const chartSeries = (page) =>
  page.$$eval("#rating-history svg g[data-player-id]", (groups) =>
    groups.map((group) => ({
      playerId: group.dataset.playerId,
      firstIndex: Number(group.dataset.firstIndex),
      ratings: group.dataset.ratings.split(",").map(Number),
    })));

const chartLegend = (page) =>
  page.$$eval("#rating-history .legend-item", (items) =>
    items.map((item) => ({
      playerId: item.dataset.playerId,
      name: item.querySelector(".legend-name").textContent,
      rating: Number(item.querySelector(".legend-rating").textContent),
      visible: item.getAttribute("aria-pressed") === "true",
    })));

/** Opens the Leaderboard tab and selects one of its two views. */
async function showLeaderboard(page, view) {
  await page.click('.tab[data-tab="leaderboard"]');
  await page.click(`.segment[data-view="${view}"]`);
}

/**
 * Selects the Rating History view, which is where the chart lives and where it gains
 * a width. The table view is the default, so the chart is only measurable after this.
 */
async function showChart(page) {
  await showLeaderboard(page, "chart");
  await page.waitForSelector("#rating-history .chart-svg, #rating-history .empty-state", { timeout: 15000 });
}

/** Which of the two leaderboard views is on screen, and which segment is selected. */
const leaderboardView = (page) =>
  page.evaluate(() => ({
    tableVisible: !document.querySelector("#leaderboard-table-view").hidden,
    chartVisible: !document.querySelector("#leaderboard-chart-view").hidden,
    selected: [...document.querySelectorAll(".segment")]
      .filter((segment) => segment.getAttribute("aria-selected") === "true")
      .map((segment) => segment.dataset.view),
  }));

/** The stored documents, decoded the way the rating model consumes them. */
async function storedHistory() {
  const decode = (documents) => documents.map((item) => ({
    id: item.name.split("/").pop(),
    scoreA: Number(item.fields.scoreA.integerValue),
    scoreB: Number(item.fields.scoreB.integerValue),
    teamA: { playerIds: item.fields.teamA.mapValue.fields.playerIds.arrayValue.values.map((v) => v.stringValue) },
    teamB: { playerIds: item.fields.teamB.mapValue.fields.playerIds.arrayValue.values.map((v) => v.stringValue) },
    createdAt: new Date(item.fields.createdAt.timestampValue),
  }));
  const players = (await readCollection("players")).map((item) => ({ id: item.name.split("/").pop(), name: item.fields.name.stringValue }));
  return { players, matches: decode(await readCollection("matches")) };
}

describe("the main page shows the latest five and the history page shows them all", () => {
  let page;
  let context;
  let record;

  before(async () => {
    await resetEmulator();
    ({ page, context, record } = await openApp());
    for (const name of PLAYERS) await addPlayer(page, name);
  });
  after(async () => { await context?.close(); });

  it("shows an empty state and no Show all link with no matches at all", async () => {
    assert.match(await rowText(page, "#recent-matches"), /No matches recorded yet/);
    assert.equal(await page.$eval("#show-all-matches", (link) => link.hidden), true);
    await showChart(page);
    assert.match(await page.textContent("#rating-history"), /Rating history appears once matches are recorded/);
    assert.deepEqual(await chartSeries(page), []);
    await page.click('.tab[data-tab="record"]');
  });

  it("lists every match while there are five or fewer", async () => {
    for (const [index, scores] of [[10, 7], [10, 3], [9, 10], [10, 8], [10, 1]].entries()) {
      await recordMatch(page, [PLAYERS[index % 2]], [PLAYERS[(index % 2) + 2]], scores[0], scores[1]);
      const rows = await rowIds(page, "#recent-matches");
      assert.equal(rows.length, index + 1, `${index + 1} matches must all be listed`);
      assert.equal(await page.$eval("#show-all-matches", (link) => link.hidden), false, "Show all appears as soon as there is history");
    }
    assert.match(await page.textContent("#match-count"), /5 recorded/);
  });

  it("caps the main page at the newest five once there are more", async () => {
    await recordMatch(page, ["Alex", "Casey"], ["Blair", "Devon"], 10, 6);
    await recordMatch(page, ["Devon"], ["Alex"], 10, 9);
    assert.equal((await readCollection("matches")).length, 7);

    const rows = await rowIds(page, "#recent-matches");
    assert.equal(rows.length, 5, "the main page renders exactly five rows");
    assert.match(await page.textContent("#match-count"), /Latest 5 of 7/);
  });

  it("orders the main page newest to oldest", async () => {
    const stored = (await readCollection("matches"))
      .map((item) => ({ id: item.name.split("/").pop(), at: new Date(item.fields.createdAt.timestampValue).getTime() }))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    assert.deepEqual(await rowIds(page, "#recent-matches"), stored.slice(0, 5).map((item) => item.id));
  });

  it("opens the complete history from Show all", async () => {
    await page.click("#show-all-matches");
    await page.waitForURL(/\/absolute-ball-knowledge\/history\//, { timeout: 15000 });
    await live(page);
    await page.waitForFunction(() => document.querySelectorAll("#full-history .match-row").length === 7, { timeout: 15000 });

    const stored = (await readCollection("matches"))
      .map((item) => ({ id: item.name.split("/").pop(), at: new Date(item.fields.createdAt.timestampValue).getTime() }))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    assert.deepEqual(await rowIds(page, "#full-history"), stored.map((item) => item.id), "every match, newest first");
    assert.match(await page.textContent("#history-count"), /7 matches recorded/);
    assert.doesNotMatch(await rowText(page, "#full-history"), /Unknown player|Saving…/);
  });

  it("edits a match from the history page", async () => {
    const before = (await readCollection("matches")).length;
    const oldest = (await rowIds(page, "#full-history")).at(-1);
    await page.click(`[data-match-id="${oldest}"] [data-edit-match]`);
    await page.fill("#edit-score-a", "12");
    await page.click("#save-match-edit");
    await page.waitForFunction(() => /Match updated/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    await page.waitForFunction((id) => document.querySelector(`[data-match-id="${id}"] .match-score`)?.textContent.startsWith("12"), oldest, { timeout: 15000 });
    assert.equal((await readCollection("matches")).length, before, "an edit must not add a document");
  });

  it("deletes a match from the history page", async () => {
    const before = await rowIds(page, "#full-history");
    await page.click(`[data-match-id="${before[3]}"] [data-delete-match]`);
    await page.click("#confirm-delete-match");
    await page.waitForFunction(() => /Match deleted/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    await page.waitForFunction((count) => document.querySelectorAll("#full-history .match-row").length === count, before.length - 1, { timeout: 15000 });
    assert.deepEqual(await rowIds(page, "#full-history"), before.filter((id) => id !== before[3]));
    assert.equal((await readCollection("matches")).length, before.length - 1);
  });

  it("survives a reload of the history page", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await live(page);
    await page.waitForFunction(() => document.querySelectorAll("#full-history .match-row").length === 6, { timeout: 15000 });
    assert.match(await page.textContent("#history-count"), /6 matches recorded/);
    assert.doesNotMatch(await rowText(page, "#full-history"), /Unknown player/);
  });

  it("returns to the app, where the latest five reflect the deletion", async () => {
    await page.click(".breadcrumb a");
    await page.waitForURL(/absolute-ball-knowledge\/(\?|$)/, { timeout: 15000 });
    await live(page);
    await page.waitForFunction(() => document.querySelectorAll("#recent-matches .match-row").length === 5, { timeout: 15000 });
    assert.match(await page.textContent("#match-count"), /Latest 5 of 6/);
  });

  it("renames a player everywhere the name is shown", async () => {
    await showLeaderboard(page, "table");
    await page.click('#leaderboard-body tr:has-text("Alex") [data-edit-player]');
    await page.fill("#edit-player-name", "Alexandra");
    await page.click("#save-player-edit");
    await page.waitForFunction(() => /Player renamed/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    await showChart(page);
    await page.waitForFunction(() => [...document.querySelectorAll("#rating-history .legend-name")].some((item) => item.textContent === "Alexandra"), { timeout: 15000 });

    assert.ok((await chartLegend(page)).some((entry) => entry.name === "Alexandra"), "the chart legend uses the current name");
    assert.equal((await chartLegend(page)).some((entry) => entry.name === "Alex"), false);
    await page.click('.tab[data-tab="record"]');
    assert.match(await rowText(page, "#recent-matches"), /Alexandra/);

    await page.click("#show-all-matches");
    await page.waitForURL(/\/history\//, { timeout: 15000 });
    await live(page);
    await page.waitForFunction(() => document.querySelectorAll("#full-history .match-row").length === 6, { timeout: 15000 });
    const text = await rowText(page, "#full-history");
    assert.match(text, /Alexandra/, "the history page reads the same current name");
    assert.doesNotMatch(text, /\bAlex\b(?!andra)/, "no historical document was rewritten, and none shows the old name");
  });

  it("logged no console errors, page errors, failed requests or blocked hosts", () => {
    assert.deepEqual(record.consoleErrors, []);
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.failedRequests, []);
    assert.deepEqual(record.blocked, []);
  });
});

describe("the rating history chart", () => {
  let page;
  let context;
  let record;

  before(async () => {
    await resetEmulator();
    ({ page, context, record } = await openApp());
    for (const name of PLAYERS) await addPlayer(page, name);
    await recordMatch(page, ["Alex"], ["Blair"], 10, 9);
    await recordMatch(page, ["Casey"], ["Devon"], 10, 2);
    await recordMatch(page, ["Alex", "Casey"], ["Blair", "Devon"], 10, 5);
    await showChart(page);
  });
  after(async () => { await context?.close(); });

  it("builds one line per player who has played, starting from 1000", async () => {
    const series = await chartSeries(page);
    assert.equal(series.length, 4, "one line per player with a match");
    for (const line of series) {
      assert.equal(line.ratings[0], 1000, "every line starts at the pre-history baseline");
      assert.equal(line.ratings.length, 4 - line.firstIndex, "one point per match from the player's debut onwards");
    }
    assert.deepEqual(series.map((line) => line.firstIndex).sort(), [0, 0, 1, 1]);
  });

  it("agrees exactly with the leaderboard at its final point", async () => {
    const legend = await chartLegend(page);
    const table = Object.fromEntries((await leaderboard(page)).map((row) => [row.name, row.rating]));
    const series = Object.fromEntries((await chartSeries(page)).map((line) => [line.playerId, line.ratings.at(-1)]));
    for (const entry of legend) {
      assert.equal(entry.rating, table[entry.name], `${entry.name}: legend rating must equal the leaderboard`);
      assert.equal(series[entry.playerId], table[entry.name], `${entry.name}: the last plotted point must equal the leaderboard`);
    }

    // And against an independent reconstruction from the stored documents.
    const { players, matches } = await storedHistory();
    const expected = computeRatingHistory(players, matches, { requireTimestamp: true });
    const rebuilt = rebuildFromHistory(players, matches, { requireTimestamp: true });
    for (const line of expected.series) {
      assert.deepEqual(series[line.playerId], line.values.at(-1).rating);
      assert.equal(line.values.at(-1).rating, rebuilt.players.find((player) => player.id === line.playerId).rating);
    }
    assert.deepEqual(
      (await chartSeries(page)).map((line) => line.ratings),
      expected.series.map((line) => line.values.map((value) => value.rating)),
      "every plotted point matches the prefix fit, not just the last one",
    );
  });

  it("shows a tooltip naming the match, the date and the ratings", async () => {
    const svg = await page.$("#rating-history .chart-svg");
    await svg.scrollIntoViewIfNeeded();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    await page.waitForSelector("#rating-history .chart-tooltip:not([hidden])", { timeout: 5000 });
    const tooltip = (await page.textContent("#rating-history .chart-tooltip")).replace(/\s+/g, " ");
    assert.match(tooltip, /Match \d of 3/);
    assert.match(tooltip, /\d{4}/, "the tooltip carries the date");
    assert.match(tooltip, /10–5|10–9|10–2/, "and the match score");
    assert.match(tooltip, /Alex|Blair|Casey|Devon/);
  });

  it("hides and shows a player from the legend", async () => {
    const [first] = await chartLegend(page);
    await page.click(`.legend-item[data-player-id="${first.playerId}"]`);
    await page.waitForFunction((id) => !document.querySelector(`#rating-history svg g[data-player-id="${id}"]`), first.playerId, { timeout: 5000 });
    assert.equal((await chartLegend(page)).find((entry) => entry.playerId === first.playerId).visible, false);
    assert.equal((await chartSeries(page)).length, 3);

    await page.click(`.legend-item[data-player-id="${first.playerId}"]`);
    await page.waitForFunction((id) => Boolean(document.querySelector(`#rating-history svg g[data-player-id="${id}"]`)), first.playerId, { timeout: 5000 });
    assert.equal((await chartSeries(page)).length, 4);
  });

  it("moves the curve further when an old 10-9 becomes a 10-0", async () => {
    const before = await chartSeries(page);
    const alex = (await chartLegend(page)).find((entry) => entry.name === "Alex").playerId;
    const move = (series, index) => series.find((line) => line.playerId === alex).ratings[index] - 1000;

    await page.click('.tab[data-tab="record"]');
    const oldest = (await rowIds(page, "#recent-matches")).at(-1);
    await page.click(`[data-match-id="${oldest}"] [data-edit-match]`);
    await page.fill("#edit-score-b", "0");
    await page.click("#save-match-edit");
    await page.waitForFunction(() => /Match updated/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    await showChart(page);
    await page.waitForFunction(
      (previous) => document.querySelector("#rating-history svg g[data-player-id]")?.dataset.ratings !== previous,
      before[0].ratings.join(","),
      { timeout: 15000 },
    );

    const after = await chartSeries(page);
    assert.ok(move(after, 1) > move(before, 1), "the winner's first point must rise further after a 10-0");
    for (let index = 1; index <= 3; index += 1) {
      assert.notEqual(move(after, index), move(before, index), `point ${index} must be refitted after editing match 1`);
    }
    const table = Object.fromEntries((await leaderboard(page)).map((row) => [row.name, row.rating]));
    for (const entry of await chartLegend(page)) assert.equal(entry.rating, table[entry.name], "the chart still ends where the leaderboard does");
  });

  it("recomputes the whole curve when the oldest match is deleted", async () => {
    await page.click('.tab[data-tab="record"]');
    const oldest = (await rowIds(page, "#recent-matches")).at(-1);
    await page.click(`[data-match-id="${oldest}"] [data-delete-match]`);
    await page.click("#confirm-delete-match");
    await page.waitForFunction(() => /Match deleted/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    await showChart(page);
    await page.waitForFunction(() => document.querySelector("#rating-history svg g[data-player-id]")?.dataset.ratings.split(",").length <= 3, { timeout: 15000 });

    const { players, matches } = await storedHistory();
    assert.equal(matches.length, 2);
    const expected = computeRatingHistory(players, matches, { requireTimestamp: true });
    assert.deepEqual(
      (await chartSeries(page)).map((line) => line.ratings),
      expected.series.map((line) => line.values.map((value) => value.rating)),
      "the curve is refitted from the surviving history alone",
    );
    const table = Object.fromEntries((await leaderboard(page)).map((row) => [row.name, row.rating]));
    for (const entry of await chartLegend(page)) assert.equal(entry.rating, table[entry.name]);
  });

  it("logged no console errors, page errors, failed requests or blocked hosts", () => {
    assert.deepEqual(record.consoleErrors, []);
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.failedRequests, []);
    assert.deepEqual(record.blocked, []);
  });
});

describe("the leaderboard shows one view at a time", () => {
  let page;
  let context;
  let record;

  before(async () => {
    await resetEmulator();
    ({ page, context, record } = await openApp());
    for (const name of PLAYERS) await addPlayer(page, name);
    await recordMatch(page, ["Alex"], ["Blair"], 10, 4);
    await recordMatch(page, ["Casey"], ["Devon"], 10, 6);
    await page.click('.tab[data-tab="leaderboard"]');
  });
  after(async () => { await context?.close(); });

  it("opens on the numeric table with the chart hidden", async () => {
    assert.deepEqual(await leaderboardView(page), { tableVisible: true, chartVisible: false, selected: ["table"] });
    assert.equal(await page.isVisible("#leaderboard-body"), true);
    assert.equal(await page.isVisible("#rating-history"), false);
    assert.equal((await leaderboard(page)).length, 4);
  });

  it("hides the table entirely when Rating History is selected", async () => {
    await showChart(page);
    assert.deepEqual(await leaderboardView(page), { tableVisible: false, chartVisible: true, selected: ["chart"] });
    assert.equal(await page.isVisible("#leaderboard-body"), false);
    assert.equal((await chartSeries(page)).length, 4, "the chart draws once it has a width");
  });

  it("restores the table without rebuilding the chart it leaves behind", async () => {
    // A tag on the live SVG node: if the round trip redrew it, the tag is gone.
    await page.$eval("#rating-history .chart-svg", (svg) => svg.setAttribute("data-probe", "1"));
    await showLeaderboard(page, "table");
    assert.deepEqual(await leaderboardView(page), { tableVisible: true, chartVisible: false, selected: ["table"] });
    assert.equal((await leaderboard(page)).length, 4, "the table is still populated, not re-fetched");

    await showLeaderboard(page, "chart");
    assert.equal(
      await page.$eval("#rating-history .chart-svg", (svg) => svg.getAttribute("data-probe")),
      "1",
      "the same width and data must not trigger a redraw",
    );
  });

  it("keeps Add player and the row actions reachable in the table view", async () => {
    await showLeaderboard(page, "table");
    assert.equal(await page.isVisible("#leaderboard [data-open-player]"), true);
    await addPlayer(page, "Emery", "#leaderboard [data-open-player]");
    await page.waitForFunction(() => document.querySelectorAll("#leaderboard-body tr").length === 5, { timeout: 15000 });

    // Added, renamed and deleted again, all from the table view.
    await page.click('#leaderboard-body tr:has-text("Emery") [data-edit-player]');
    await page.fill("#edit-player-name", "Emerson");
    await page.click("#save-player-edit");
    await page.waitForFunction(() => [...document.querySelectorAll("#leaderboard-body td")].some((cell) => cell.textContent.includes("Emerson")), { timeout: 15000 });

    // The confirmation only opens once the reference scan clears the player.
    await page.click('#leaderboard-body tr:has-text("Emerson") [data-delete-player]');
    await page.waitForFunction(() => document.querySelector("#delete-player-dialog")?.open === true, { timeout: 15000 });
    await page.click("#confirm-delete-player");
    await page.waitForFunction(() => document.querySelectorAll("#leaderboard-body tr").length === 4, { timeout: 15000 });
    assert.equal((await leaderboard(page)).some((row) => row.name === "Emerson"), false);
  });

  it("logged no console errors, page errors, failed requests or blocked hosts", () => {
    assert.deepEqual(record.consoleErrors, []);
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.failedRequests, []);
    assert.deepEqual(record.blocked, []);
  });
});

describe("history and chart on a mobile viewport", () => {
  let page;
  let context;
  let record;
  const overflow = (target) => target.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  before(async () => {
    await resetEmulator();
    ({ page, context, record } = await openApp({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }));
    for (const name of PLAYERS) await addPlayer(page, name);
    for (const scores of [[10, 7], [10, 3], [9, 10], [10, 8], [10, 1], [10, 4]]) {
      await recordMatch(page, ["Alex"], ["Blair"], scores[0], scores[1]);
    }
  });
  after(async () => { await context?.close(); });

  it("caps the main page at five rows and offers Show all at 390x844", async () => {
    assert.equal((await rowIds(page, "#recent-matches")).length, 5);
    assert.match(await page.textContent("#match-count"), /Latest 5 of 6/);
    assert.ok(await page.isVisible("#show-all-matches"));
    assert.ok(await overflow(page) <= 0, "the record tab must not scroll sideways");
  });

  it("draws the chart inside the viewport", async () => {
    await showChart(page);
    const series = await chartSeries(page);
    assert.equal(series.length, 2, "only the two players who played are drawn");
    assert.ok(await overflow(page) <= 0, "the chart must not widen the page");
    const width = await page.$eval("#rating-history .chart-svg", (svg) => svg.getBoundingClientRect().width);
    assert.ok(width > 0 && width <= 390, `the chart fits the viewport, got ${width}`);
  });

  it("opens the full history without overflow", async () => {
    await page.click('.tab[data-tab="record"]');
    await page.click("#show-all-matches");
    await page.waitForURL(/\/history\//, { timeout: 15000 });
    await live(page);
    await page.waitForFunction(() => document.querySelectorAll("#full-history .match-row").length === 6, { timeout: 15000 });
    assert.ok(await overflow(page) <= 0, "the history page must not scroll sideways");
  });

  it("logged no console errors, page errors, failed requests or blocked hosts", () => {
    assert.deepEqual(record.consoleErrors, []);
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.failedRequests, []);
    assert.deepEqual(record.blocked, []);
  });
});
