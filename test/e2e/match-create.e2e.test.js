/**
 * Browser end-to-end regression for recording a match.
 *
 *   npm run build
 *   firebase emulators:start --only firestore --project demo-abk
 *   npm run test:e2e
 *
 * This drives the built Astro output in Playwright Chromium through the normal
 * Firebase adapter (`?emulator=1`), not the `?mock=1` in-memory one, so the whole
 * path runs for real: the Firebase Web SDK, a Firestore transaction, server
 * timestamps, and the repository's own firestore.rules inside the emulator.
 *
 * See harness.js for how the run fails closed and blocks production endpoints.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { guardRoutes, instrument, readCollection, requireEmulator, resetEmulator, startSite } from "./harness.js";
import { rebuildFromHistory } from "../../public/absolute-ball-knowledge/js/rating-model.js";

const PLAYERS = ["Alex", "Blair", "Casey", "Devon"];

let site;
let browser;
let context;
let page;
let record;

const live = () =>
  page.waitForFunction(() => document.querySelector("#connection-status")?.textContent === "Live", { timeout: 20000 });

/** The banner the app shows, or null when it is hidden. */
const banner = () =>
  page.$eval("#global-message", (el) =>
    el.hidden ? null : { error: el.className.includes("is-error"), text: el.textContent });

const historyText = async () => (await page.textContent("#recent-matches")).replace(/\s+/g, " ").trim();

const leaderboard = () =>
  page.$$eval("#leaderboard-body tr", (rows) =>
    rows.map((row) => {
      const cells = [...row.children].map((cell) => cell.textContent.trim());
      return { name: cells[1].replace(/(EditDelete|\(provisional\))/g, "").trim(), rating: Number(cells[2]), games: Number(cells[3]), wins: Number(cells[4]), losses: Number(cells[5]) };
    }));

async function addPlayer(name) {
  await page.click("[data-open-player]");
  await page.fill("#player-name", name);
  await page.click("#add-player");
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("#team-a-options .check-option span")].some((s) => s.textContent === n),
    name,
    { timeout: 15000 },
  );
}

async function selectTeams(teamA, teamB) {
  for (const box of await page.$$("#team-a-options input:checked")) await box.click();
  for (const box of await page.$$("#team-b-options input:checked")) await box.click();
  for (const name of teamA) await page.click(`#team-a-options .check-option:has-text("${name}") input`);
  for (const name of teamB) await page.click(`#team-b-options .check-option:has-text("${name}") input`);
}

async function recordMatch(teamA, teamB, scoreA, scoreB, { dblclick = false } = {}) {
  await selectTeams(teamA, teamB);
  await page.fill("#score-a", String(scoreA));
  await page.fill("#score-b", String(scoreB));
  const before = (await readCollection("matches")).length;
  if (dblclick) await page.dblclick("#save-match");
  else await page.click("#save-match");
  // Settle on either the banner or a change in stored documents, whichever comes first.
  await page.waitForFunction(() => !document.querySelector("#global-message").hidden, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);
  return { before, after: (await readCollection("matches")).length, banner: await banner() };
}

/** The most recent Firestore commit the browser sent, decoded. */
function lastCommit() {
  const commits = record.writes.filter((write) => write.isCommit && write.body.includes("/documents/matches/"));
  assert.ok(commits.length, "the browser must have sent a matches commit");
  return JSON.parse(decodeURIComponent(commits.at(-1).body));
}

before(async () => {
  await requireEmulator();
  await resetEmulator();
  site = await startSite();
  browser = await chromium.launch();
  context = await browser.newContext();
  page = await context.newPage();
  record = instrument(page);
  await guardRoutes(context, record);
  await page.goto(site.url, { waitUntil: "domcontentloaded" });
  await live();
  for (const name of PLAYERS) await addPlayer(name);
});

after(async () => {
  await browser?.close();
  await site?.close();
});

describe("recording a match in the browser against the Firestore Emulator", () => {
  it("starts from an empty database with four players and no matches", async () => {
    assert.equal((await readCollection("players")).length, 4);
    assert.equal((await readCollection("matches")).length, 0);
    assert.match(await historyText(), /No matches recorded yet/);
  });

  it("records a valid 1v1 10-7 match", async () => {
    const result = await recordMatch(["Alex"], ["Blair"], 10, 7);
    assert.equal(result.banner?.error, false, `expected success, got: ${result.banner?.text}`);
    assert.match(result.banner.text, /Match saved/);
    assert.equal(result.after, 1, "exactly one match document must exist");
  });

  it("sends exactly the write shape the create rule admits", () => {
    const commit = lastCommit();
    const write = commit.writes.find((item) => item.update?.name.includes("/documents/matches/"));
    assert.ok(write, "the commit must contain a matches document write");

    assert.deepEqual(
      Object.keys(write.update.fields).sort(),
      ["modelVersion", "scoreA", "scoreB", "teamA", "teamB", "winner"],
      "the client must send exactly these literal fields",
    );
    // createdAt and updatedAt travel as server-timestamp transforms, not literals.
    assert.deepEqual(
      write.updateTransforms.map((item) => item.fieldPath).sort(),
      ["createdAt", "updatedAt"],
    );
    for (const transform of write.updateTransforms) assert.equal(transform.setToServerValue, "REQUEST_TIME");

    assert.deepEqual(write.update.fields.scoreA, { integerValue: "10" }, "scores must be integers on the wire");
    assert.deepEqual(write.update.fields.scoreB, { integerValue: "7" });
    assert.deepEqual(write.update.fields.winner, { stringValue: "A" });
    assert.deepEqual(write.update.fields.modelVersion, { stringValue: "score_logistic_v1" });
    // Teams are maps of player-ID arrays, never embedded player objects.
    const ids = (side) => write.update.fields[side].mapValue.fields.playerIds.arrayValue.values.map((v) => v.stringValue);
    assert.equal(ids("teamA").length, 1);
    assert.equal(ids("teamB").length, 1);
    assert.notDeepEqual(ids("teamA"), ids("teamB"));
    // Every player named must exist, verified in the same transaction.
    assert.equal(commit.writes.filter((item) => item.verify).length, 2, "both players must be verified in the transaction");
  });

  it("stores a document the emulator hands back in the intended schema", async () => {
    const [stored] = await readCollection("matches");
    assert.deepEqual(
      Object.keys(stored.fields).sort(),
      ["createdAt", "modelVersion", "scoreA", "scoreB", "teamA", "teamB", "updatedAt", "winner"],
    );
    assert.equal(stored.fields.scoreA.integerValue, "10");
    assert.ok(stored.fields.createdAt.timestampValue, "createdAt must have resolved server-side");
  });

  it("shows the match in history immediately", async () => {
    const text = await historyText();
    assert.match(text, /Alex/);
    assert.match(text, /Blair/);
    assert.match(text, /10–7/);
    assert.doesNotMatch(text, /Saving…/, "the recorded time must have resolved");
    assert.doesNotMatch(text, /Unknown player/);
  });

  it("rebuilds leaderboard ratings and statistics", async () => {
    const rows = await leaderboard();
    const by = Object.fromEntries(rows.map((row) => [row.name, row]));
    assert.equal(by.Alex.games, 1);
    assert.equal(by.Alex.wins, 1);
    assert.equal(by.Alex.losses, 0);
    assert.equal(by.Blair.games, 1);
    assert.equal(by.Blair.wins, 0);
    assert.equal(by.Blair.losses, 1);
    assert.ok(by.Alex.rating > 1000, `winner must rise above 1000, got ${by.Alex.rating}`);
    assert.ok(by.Blair.rating < 1000, `loser must fall below 1000, got ${by.Blair.rating}`);
    assert.equal(by.Casey.games, 0);

    // The page agrees with an independent rebuild from the stored documents.
    const decode = (documents) => documents.map((item) => ({
      id: item.name.split("/").pop(),
      scoreA: Number(item.fields.scoreA.integerValue),
      scoreB: Number(item.fields.scoreB.integerValue),
      teamA: { playerIds: item.fields.teamA.mapValue.fields.playerIds.arrayValue.values.map((v) => v.stringValue) },
      teamB: { playerIds: item.fields.teamB.mapValue.fields.playerIds.arrayValue.values.map((v) => v.stringValue) },
      createdAt: new Date(item.fields.createdAt.timestampValue),
    }));
    const players = (await readCollection("players")).map((item) => ({ id: item.name.split("/").pop(), name: item.fields.name.stringValue }));
    const rebuilt = rebuildFromHistory(players, decode(await readCollection("matches")), { requireTimestamp: true });
    for (const player of rebuilt.players) {
      assert.equal(by[player.name].rating, player.rating, `${player.name}'s displayed rating must match a fresh rebuild`);
    }
  });

  it("survives a reload", async () => {
    await page.reload({ waitUntil: "domcontentloaded" });
    await live();
    await page.waitForFunction(() => document.querySelectorAll("#recent-matches .match-row").length === 1, { timeout: 15000 });
    const text = await historyText();
    assert.match(text, /10–7/);
    assert.doesNotMatch(text, /Saving…/);
    const by = Object.fromEntries((await leaderboard()).map((row) => [row.name, row]));
    assert.equal(by.Alex.wins, 1);
    assert.equal(by.Blair.losses, 1);
  });

  it("records a valid 2v2 match", async () => {
    const result = await recordMatch(["Alex", "Casey"], ["Blair", "Devon"], 10, 5);
    assert.equal(result.banner?.error, false, `expected success, got: ${result.banner?.text}`);
    assert.equal(result.after, 2);

    const write = lastCommit().writes.find((item) => item.update?.name.includes("/documents/matches/"));
    const ids = (side) => write.update.fields[side].mapValue.fields.playerIds.arrayValue.values.map((v) => v.stringValue);
    assert.equal(ids("teamA").length, 2);
    assert.equal(ids("teamB").length, 2);

    const by = Object.fromEntries((await leaderboard()).map((row) => [row.name, row]));
    assert.equal(by.Alex.games, 2);
    assert.equal(by.Casey.games, 1);
    assert.equal(by.Casey.wins, 1);
    assert.equal(by.Devon.losses, 1);
  });

  it("rejects a tie without writing anything", async () => {
    const result = await recordMatch(["Alex"], ["Blair"], 7, 7);
    assert.equal(result.banner?.error, true);
    assert.match(result.banner.text, /cannot end in a draw/);
    assert.equal(result.after, result.before, "a rejected match must not be written");
  });

  it("rejects an empty team without writing anything", async () => {
    const result = await recordMatch([], ["Blair"], 10, 7);
    assert.equal(result.banner?.error, true);
    assert.match(result.banner.text, /Both teams need at least one player/);
    assert.equal(result.after, result.before);
  });

  it("makes overlapping teams unselectable rather than writable", async () => {
    await selectTeams(["Alex"], []);
    const disabled = await page.$eval(
      '#team-b-options .check-option:has-text("Alex") input',
      (input) => input.disabled,
    );
    assert.equal(disabled, true, "a Team A pick must be disabled on the Team B side");
    await selectTeams([], []);
  });

  it("refuses a decimal score at the input", async () => {
    await selectTeams(["Alex"], ["Blair"]);
    await page.fill("#score-a", "10.5");
    await page.fill("#score-b", "7");
    const valid = await page.$eval("#score-a", (input) => input.checkValidity());
    assert.equal(valid, false, "step=1 must make a decimal score invalid, so the form never submits");
  });

  it("creates exactly one match on a rapid double-click", async () => {
    const result = await recordMatch(["Casey"], ["Devon"], 9, 3, { dblclick: true });
    assert.equal(result.banner?.error, false, `expected success, got: ${result.banner?.text}`);
    assert.equal(result.after - result.before, 1, "a double-click must create exactly one match");
    await page.waitForTimeout(1500);
    assert.equal((await readCollection("matches")).length, result.after, "no delayed second write may land");
  });

  it("still edits and deletes a match", async () => {
    const before = (await readCollection("matches")).length;

    await page.click("#recent-matches .match-row:first-child [data-edit-match]");
    await page.fill("#edit-score-a", "12");
    await page.click("#save-match-edit");
    await page.waitForFunction(() => /Match updated/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    assert.match(await historyText(), /12–/);
    assert.equal((await readCollection("matches")).length, before, "an edit must not add a document");

    await page.click("#recent-matches .match-row:first-child [data-delete-match]");
    await page.click("#confirm-delete-match");
    await page.waitForFunction(() => /Match deleted/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });
    assert.equal((await readCollection("matches")).length, before - 1);
  });

  it("reached no host other than loopback and the SDK CDN", () => {
    assert.deepEqual(record.blocked, [], `production endpoints were contacted: ${record.blocked.join(", ")}`);
  });

  it("logged no console errors, page errors, or failed requests", () => {
    assert.deepEqual(record.consoleErrors, []);
    assert.deepEqual(record.pageErrors, []);
    assert.deepEqual(record.failedRequests, []);
  });
});

describe("recording a match on a mobile viewport", () => {
  let mobileContext;
  let mobilePage;
  let mobileRecord;

  before(async () => {
    await resetEmulator();
    mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    mobilePage = await mobileContext.newPage();
    mobileRecord = instrument(mobilePage);
    await guardRoutes(mobileContext, mobileRecord);
  });

  after(async () => {
    await mobileContext?.close();
  });

  it("records a match end to end at 390x844", async () => {
    const saved = page;
    page = mobilePage;
    const savedRecord = record;
    record = mobileRecord;
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded" });
      await live();
      for (const name of PLAYERS) await addPlayer(name);

      const result = await recordMatch(["Alex"], ["Blair"], 10, 7);
      assert.equal(result.banner?.error, false, `expected success, got: ${result.banner?.text}`);
      assert.equal(result.after, 1);
      assert.match(await historyText(), /10–7/);

      assert.deepEqual(mobileRecord.consoleErrors, []);
      assert.deepEqual(mobileRecord.pageErrors, []);
      assert.deepEqual(mobileRecord.failedRequests, []);
      assert.deepEqual(mobileRecord.blocked, []);
    } finally {
      page = saved;
      record = savedRecord;
    }
  });
});
