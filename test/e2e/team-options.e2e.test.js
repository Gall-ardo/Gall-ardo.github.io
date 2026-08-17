/**
 * Browser end-to-end regression for the Create Teams options and the hand-off into
 * Record Match.
 *
 *   npm run build
 *   firebase emulators:start --only firestore --project demo-abk
 *   npm run test:e2e
 *
 * Same terms as the other browser checks: the built site, the real Firebase Web SDK
 * pointed at the emulator, and every host but loopback and the SDK CDN aborted. See
 * harness.js.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chromium } from "playwright";

import { guardRoutes, instrument, readCollection, requireEmulator, resetEmulator, startSite } from "./harness.js";

const PLAYERS = ["Alex", "Blair", "Casey", "Devon", "Emery", "Frankie"];

let site;
let browser;
let context;
let page;
let record;

const live = () =>
  page.waitForFunction(() => document.querySelector("#connection-status")?.textContent === "Live", { timeout: 20000 });

async function addPlayer(name) {
  await page.click("#record [data-open-player]");
  await page.fill("#player-name", name);
  await page.click("#add-player");
  await page.waitForFunction(
    (n) => [...document.querySelectorAll("#team-a-options .check-option span")].some((s) => s.textContent === n),
    name,
    { timeout: 15000 },
  );
}

/** Selects exactly `names` as participants and generates the options. */
async function generate(names) {
  await page.click('.tab[data-tab="teams"]');
  for (const box of await page.$$("#participant-options input:checked")) await box.click();
  for (const name of names) await page.click(`#participant-options .check-option:has-text("${name}") input`);
  await page.click("#generate-teams");
  await page.waitForSelector("#generated-result .team-option", { timeout: 5000 });
}

/** The rendered options, read back exactly as the user sees them. */
const options = () =>
  page.$$eval("#generated-result .team-option", (cards) =>
    cards.map((card) => ({
      label: card.querySelector(".option-label").textContent.trim(),
      best: card.classList.contains("is-best"),
      odds: card.querySelector(".option-odds").textContent.trim(),
      teams: [...card.querySelectorAll(".option-side p")].map((side) =>
        side.textContent.split(",").map((entry) => entry.trim().replace(/\s+\d+$/, "")).filter(Boolean)),
      hasButton: Boolean(card.querySelector("[data-use-option]")),
    })));

const checkedNames = (side) =>
  page.$$eval(`#team-${side}-options .check-option`, (labels) =>
    labels.filter((label) => label.querySelector("input").checked).map((label) => label.querySelector("span").textContent));

const commits = () => record.writes.filter((write) => write.isCommit).length;

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

describe("choosing between generated team options", () => {
  it("offers up to three distinct options, best balance first", async () => {
    await generate(PLAYERS.slice(0, 4));
    const shown = await options();
    assert.ok(shown.length > 1 && shown.length <= 3, `expected 2 or 3 options, got ${shown.length}`);
    assert.equal(shown[0].label, "Best balance");
    assert.equal(shown[0].best, true, "only the first option is marked as the best balance");
    assert.deepEqual(shown.slice(1).map((option) => option.best), shown.slice(1).map(() => false));
    assert.deepEqual(shown.slice(1).map((option) => option.label), ["Alternative 2", "Alternative 3"].slice(0, shown.length - 1));
    for (const option of shown) {
      assert.ok(option.hasButton, "every option carries its own Use these teams button");
      assert.match(option.odds, /^\d+\.\d% \/ \d+\.\d%$/);
      const everyone = option.teams.flat();
      assert.deepEqual(everyone.slice().sort(), PLAYERS.slice(0, 4).slice().sort(), "each participant appears exactly once");
      assert.deepEqual(option.teams.map((team) => team.length), [2, 2]);
    }
    const keys = shown.map((option) => option.teams.map((team) => team.slice().sort().join(",")).sort().join("|"));
    assert.equal(new Set(keys).size, keys.length, "a swapped orientation is not offered as a separate option");
  });

  it("keeps a five-player group on valid 3v2 splits", async () => {
    await generate(PLAYERS.slice(0, 5));
    const shown = await options();
    assert.ok(shown.length >= 1);
    for (const option of shown) {
      const sizes = option.teams.map((team) => team.length);
      assert.deepEqual(sizes.slice().sort(), [2, 3], "an odd group splits 3v2");
      assert.deepEqual(option.teams.flat().slice().sort(), PLAYERS.slice(0, 5).slice().sort());
    }
  });

  it("returns alternatives for a six-player group", async () => {
    await generate(PLAYERS);
    const shown = await options();
    assert.ok(shown.length >= 2, `expected alternatives, got ${shown.length}`);
    for (const option of shown) {
      assert.deepEqual(option.teams.map((team) => team.length), [3, 3]);
      assert.deepEqual(option.teams.flat().slice().sort(), PLAYERS.slice().sort());
    }
  });

  it("writes nothing to Firestore while generating", async () => {
    const before = commits();
    await generate(PLAYERS.slice(0, 4));
    await generate(PLAYERS);
    await page.waitForTimeout(800);
    assert.equal(commits(), before, "generating teams must not send a commit");
    assert.equal((await readCollection("matches")).length, 0, "no match document may exist yet");
  });

  it("opens Record Match with the chosen option preselected and no scores", async () => {
    await generate(PLAYERS.slice(0, 4));
    const [chosen] = await options();
    await page.click('#generated-result .team-option:nth-child(2) [data-use-option]');
    const second = (await options())[1];

    await page.waitForFunction(() => !document.querySelector("#record").hidden, { timeout: 5000 });
    assert.equal(await page.$eval('.tab[data-tab="record"]', (tab) => tab.getAttribute("aria-selected")), "true");
    assert.equal(await page.$eval("#teams", (panel) => panel.hidden), true);

    assert.deepEqual((await checkedNames("a")).slice().sort(), second.teams[0].slice().sort());
    assert.deepEqual((await checkedNames("b")).slice().sort(), second.teams[1].slice().sort());
    assert.notDeepEqual(second.teams, chosen.teams, "the second option is not the first one");
    assert.equal(await page.inputValue("#score-a"), "");
    assert.equal(await page.inputValue("#score-b"), "");
    assert.equal((await readCollection("matches")).length, 0, "choosing an option must not create a match");
  });

  it("leaves the preselected teams fully editable", async () => {
    const before = { a: await checkedNames("a"), b: await checkedNames("b") };
    // Remove one player from Team A, and move another across to Team B.
    await page.click(`#team-a-options .check-option:has-text("${before.a[0]}") input`);
    await page.click(`#team-a-options .check-option:has-text("${before.a[1]}") input`);
    await page.click(`#team-b-options .check-option:has-text("${before.a[1]}") input`);
    // Add a participant who was on neither side.
    const spare = PLAYERS.find((name) => ![...before.a, ...before.b].includes(name));
    await page.click(`#team-a-options .check-option:has-text("${spare}") input`);

    assert.deepEqual((await checkedNames("a")).slice().sort(), [spare]);
    assert.deepEqual((await checkedNames("b")).slice().sort(), [...before.b, before.a[1]].sort());
  });

  it("saves the edited match normally", async () => {
    const teamA = await checkedNames("a");
    const teamB = await checkedNames("b");
    await page.fill("#score-a", "10");
    await page.fill("#score-b", "6");
    await page.click("#save-match");
    await page.waitForFunction(() => /Match saved/.test(document.querySelector("#global-message").textContent), { timeout: 15000 });

    const stored = await readCollection("matches");
    assert.equal(stored.length, 1);
    const ids = (side) => stored[0].fields[side].mapValue.fields.playerIds.arrayValue.values.map((value) => value.stringValue);
    const players = Object.fromEntries((await readCollection("players")).map((item) => [item.name.split("/").pop(), item.fields.name.stringValue]));
    assert.deepEqual(ids("teamA").map((id) => players[id]).sort(), teamA.slice().sort());
    assert.deepEqual(ids("teamB").map((id) => players[id]).sort(), teamB.slice().sort());
    assert.equal(stored[0].fields.scoreA.integerValue, "10");
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

describe("generated team options on a mobile viewport", () => {
  let mobileContext;

  before(async () => {
    await resetEmulator();
    mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  });

  after(async () => {
    await mobileContext?.close();
  });

  it("renders the options without horizontal overflow at 390x844", async () => {
    const saved = page;
    const savedRecord = record;
    page = await mobileContext.newPage();
    record = instrument(page);
    try {
      await guardRoutes(mobileContext, record);
      await page.goto(site.url, { waitUntil: "domcontentloaded" });
      await live();
      for (const name of PLAYERS) await addPlayer(name);

      await generate(PLAYERS);
      assert.ok((await options()).length >= 2);
      const overflow = await page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `the page must not scroll horizontally, overflowed by ${overflow}px`);

      await page.click("#generated-result .team-option:first-child [data-use-option]");
      await page.waitForFunction(() => !document.querySelector("#record").hidden, { timeout: 5000 });
      assert.equal((await checkedNames("a")).length + (await checkedNames("b")).length, PLAYERS.length);

      assert.deepEqual(record.consoleErrors, []);
      assert.deepEqual(record.pageErrors, []);
      assert.deepEqual(record.failedRequests, []);
      assert.deepEqual(record.blocked, []);
    } finally {
      page = saved;
      record = savedRecord;
    }
  });
});
