import {
  DEFAULT_MODEL_CONFIG,
  displayRating,
  predictMatch,
  stableSigmoid,
} from "./rating-model.js";

export const STARTING_ELO = 1000; // Legacy display baseline; not persisted as authority.
export const ELO_K = 32;

export function normalizePlayerName(value) {
  return String(value).trim().replace(/\s+/g, " ").toLocaleLowerCase("en");
}

export function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed) {
  let value = stableHash(seed) || 1;
  value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
  return (value >>> 0) / 0x100000000;
}

function playerRating(player) {
  const value = Number(player.rating ?? player.elo ?? STARTING_ELO);
  if (!Number.isFinite(value)) throw new Error(`Player ${player.id} has an invalid rating.`);
  return value;
}

export function averageRating(players) {
  if (!Array.isArray(players) || players.length === 0) throw new Error("At least one player is required.");
  return players.reduce((sum, player) => sum + playerRating(player), 0) / players.length;
}

/**
 * Skill on the model's own scale. Prefers the exact fitted theta when the caller
 * supplies it, because the displayed rating is rounded and loses up to half a
 * display point (about 1/240 of a theta unit) per player.
 */
export function playerTheta(player) {
  const theta = Number(player?.theta);
  if (Number.isFinite(theta)) return theta;
  return (playerRating(player) - STARTING_ELO) / DEFAULT_MODEL_CONFIG.ratingScale;
}

function averageTheta(players) {
  if (!Array.isArray(players) || players.length === 0) throw new Error("At least one player is required.");
  return players.reduce((sum, player) => sum + playerTheta(player), 0) / players.length;
}

// Kept only for offline legacy-Elo comparison tooling.
export const averageElo = averageRating;
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}
export function calculateMatchElo(teamA, teamB, scoreA, scoreB, k = ELO_K) {
  if (!teamA.length || !teamB.length) throw new Error("Both teams need at least one player.");
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 || scoreA === scoreB) throw new Error("A match needs decisive whole-number scores.");
  const averageA = averageElo(teamA); const averageB = averageElo(teamB);
  const expectedA = expectedScore(averageA, averageB);
  const deltaA = k * ((scoreA > scoreB ? 1 : 0) - expectedA);
  return { averageA, averageB, expectedA, expectedB: 1 - expectedA, deltaA, deltaB: -deltaA };
}

function candidate(teamA, teamB, beta) {
  const averageA = averageRating(teamA);
  const averageB = averageRating(teamB);
  const probabilityA = predictMatch(averageTheta(teamA), averageTheta(teamB), teamA.length, teamB.length, beta);
  return {
    teamA, teamB, averageA, averageB, probabilityA,
    imbalance: Math.abs(probabilityA - 0.5),
    sizeEffect: beta * (teamA.length - teamB.length),
  };
}

function sortedCandidateKey(result) {
  return `${result.teamA.map((p) => p.id).sort().join(",")}|${result.teamB.map((p) => p.id).sort().join(",")}`;
}

/** Same partition regardless of which side is labelled A. */
function unorderedCandidateKey(result) {
  return [result.teamA.map((p) => p.id).sort().join(","), result.teamB.map((p) => p.id).sort().join(",")].sort().join("|");
}

function heuristicCandidates(players, beta) {
  const sizeLarge = Math.ceil(players.length / 2);
  const sorted = players.slice().sort((a, b) => playerTheta(b) - playerTheta(a) || String(a.id).localeCompare(String(b.id)));
  const results = [];
  for (let offset = 0; offset < Math.min(16, players.length); offset += 1) {
    const rotated = sorted.slice(offset).concat(sorted.slice(0, offset));
    const teamA = []; const teamB = [];
    for (const person of rotated) {
      // An empty side has no average to compare, so seed both sides before weighing them.
      if (teamA.length === sizeLarge) teamB.push(person);
      else if (teamB.length === players.length - sizeLarge) teamA.push(person);
      else if (!teamA.length) teamA.push(person);
      else if (!teamB.length) teamB.push(person);
      else if (averageTheta(teamA) <= averageTheta(teamB)) teamA.push(person);
      else teamB.push(person);
    }
    results.push(candidate(teamA, teamB, beta));
    if (teamA.length !== teamB.length) results.push(candidate(teamB, teamA, beta));
  }
  return results;
}

function exhaustiveCandidates(players, beta, topK, tolerance) {
  const largeSize = Math.ceil(players.length / 2);
  const evenSplit = largeSize === players.length - largeSize;
  const total = players.reduce((sum, player) => sum + playerTheta(player), 0);
  const choice = []; let best = Infinity;
  const imbalanceFor = (largeIsA, sumLarge) => {
    const sizeA = largeIsA ? largeSize : players.length - largeSize;
    const sizeB = players.length - sizeA;
    const sumA = largeIsA ? sumLarge : total - sumLarge;
    const d = sumA / sizeA - (total - sumA) / sizeB + beta * (sizeA - sizeB);
    return Math.abs(stableSigmoid(d) - .5);
  };
  // On an even split a subset and its complement are the same partition with the
  // team labels swapped, and they carry identical imbalance. Pinning the first
  // player to the selected side enumerates each partition exactly once.
  const step = (visit, start, sum) => {
    if (choice.length === largeSize) { visit(sum); return; }
    for (let i = start; i <= players.length - (largeSize - choice.length); i += 1) { choice.push(i); step(visit, i + 1, sum + playerTheta(players[i])); choice.pop(); }
  };
  const walk = (visit) => {
    if (!evenSplit) return step(visit, 0, 0);
    choice.push(0); step(visit, 1, playerTheta(players[0])); choice.pop();
  };
  walk((sumLarge) => {
    best = Math.min(best, imbalanceFor(true, sumLarge));
    if (!evenSplit) best = Math.min(best, imbalanceFor(false, sumLarge));
  });
  const retained = [];
  const consider = (largeIsA, sumLarge) => {
    const imbalance = imbalanceFor(largeIsA, sumLarge);
    if (imbalance > best + tolerance + 1e-12) return;
    if (retained.length >= topK && imbalance >= retained.at(-1).imbalance - 1e-12) return;
    const selected = new Set(choice);
    const teamA = []; const teamB = [];
    for (let i = 0; i < players.length; i += 1) (selected.has(i) === largeIsA ? teamA : teamB).push(players[i]);
    retained.push(candidate(teamA, teamB, beta));
    retained.sort((a, b) => a.imbalance - b.imbalance || sortedCandidateKey(a).localeCompare(sortedCandidateKey(b)));
    if (retained.length > topK) retained.length = topK;
  };
  walk((sumLarge) => { consider(true, sumLarge); if (!evenSplit) consider(false, sumLarge); });
  return retained;
}

/** Exhaustive through 20 participants; deterministic multi-candidate selection above that. */
export function balanceTeams(players, options = {}) {
  if (!Array.isArray(players) || players.length < 2) throw new Error("Select at least two players.");
  if (new Set(players.map((player) => player?.id)).size !== players.length || players.some((player) => !player?.id)) throw new Error("Each participant must be unique.");
  const ordered = players.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const beta = Number.isFinite(options.beta) ? options.beta : 0;
  const topK = Math.max(1, Math.floor(options.topK ?? 6));
  let candidates = [];
  if (ordered.length <= 20) {
    candidates = exhaustiveCandidates(ordered, beta, topK, options.nearOptimalTolerance ?? 0.025);
  } else candidates.push(...heuristicCandidates(ordered, beta));
  candidates.sort((a, b) => a.imbalance - b.imbalance || sortedCandidateKey(a).localeCompare(sortedCandidateKey(b)));
  // Two entries holding the same partition are the same choice unless the side that
  // carries the extra player actually changes the prediction (odd count, non-zero beta).
  const seen = new Map();
  candidates = candidates.filter((item) => {
    const key = unorderedCandidateKey(item);
    const prior = seen.get(key);
    if (prior !== undefined && Math.abs(prior - item.imbalance) <= 1e-12) return false;
    seen.set(key, item.imbalance); return true;
  });
  const nearCutoff = candidates[0].imbalance + (options.nearOptimalTolerance ?? 0.025);
  const topCandidates = candidates.filter((item) => item.imbalance <= nearCutoff).slice(0, topK);
  const seed = options.seed ?? `${ordered.map((p) => p.id).join("|")}|${options.session ?? new Date().toISOString().slice(0, 10)}`;
  const selected = topCandidates[Math.floor(seededUnit(seed) * topCandidates.length)];
  return { ...selected, topCandidates, exhaustive: ordered.length <= 20, seed };
}

export function generatedPlayerRating(theta, config = DEFAULT_MODEL_CONFIG) {
  return displayRating(theta, config);
}
