import {
  DEFAULT_MODEL_CONFIG,
  canonicalMatches,
  displayRating,
  fitScoreLogistic,
} from "./rating-model.js";

/**
 * Rating history, reconstructed the only way that can agree with the leaderboard.
 *
 * `score_logistic_v1` is a regularised joint fit, not an incremental Elo update:
 * adding one match moves every player's theta, including players who were not in
 * it. There is therefore no per-match delta to accumulate and no stored legacy
 * field to trust. Instead the same fit the leaderboard shows is re-run over each
 * growing prefix of the history:
 *
 *   point 0        no matches, every theta 0, every rating 1000
 *   point k (k>=1) fitScoreLogistic(players, matches[1..k])
 *
 * so the last point is fitted from the complete history and is bit-for-bit the
 * fit the leaderboard renders. Ordering is `canonicalMatches`: createdAt first,
 * document ID as the deterministic tie-breaker, so matches recorded in the same
 * second always replay in the same order.
 *
 * Cost is one fit per match. That is deliberate rather than approximated, and it
 * is why `js/store.js` memoises the result per snapshot instead of recomputing it
 * per render.
 *
 * Only player IDs are returned. Current names are looked up at render time, so a
 * rename shows up immediately without rewriting any historical match document.
 */
export function computeRatingHistory(players, matches, options = {}) {
  const roster = players.map((player) => (typeof player === "string" ? { id: player } : player));
  const requireTimestamp = options.requireTimestamp ?? true;
  const canonical = canonicalMatches(matches, roster, { requireTimestamp });
  const baselineConfig = { ...DEFAULT_MODEL_CONFIG, ...options };

  const points = [{ index: 0, matchId: null, date: null, scoreA: null, scoreB: null, teamA: [], teamB: [] }];
  // Ratings by point, starting from the pre-history baseline of theta 0 for everybody.
  const byPoint = [Object.fromEntries(roster.map((player) => [player.id, { theta: 0, rating: displayRating(0, baselineConfig) }]))];
  const firstIndex = new Map();
  let last = null;

  for (let k = 1; k <= canonical.length; k += 1) {
    const match = canonical[k - 1];
    for (const id of [...match.teamA, ...match.teamB]) {
      // The point *before* this match is where the player's line starts: it is the
      // last moment their rating was still the 1000 baseline.
      if (!firstIndex.has(id)) firstIndex.set(id, k - 1);
    }
    points.push({
      index: k,
      matchId: match.id || null,
      date: Number.isFinite(match.createdAt) ? new Date(match.createdAt) : null,
      scoreA: match.scoreA, scoreB: match.scoreB,
      teamA: match.teamA.slice(), teamB: match.teamB.slice(),
    });
    const fit = fitScoreLogistic(roster, canonical.slice(0, k), { ...options, requireTimestamp });
    byPoint.push(Object.fromEntries(roster.map((player) => {
      const theta = fit.theta[player.id] ?? 0;
      return [player.id, { theta, rating: displayRating(theta, fit.config) }];
    })));
    last = fit;
  }

  const series = roster
    .filter((player) => firstIndex.has(player.id))
    .map((player) => {
      const start = firstIndex.get(player.id);
      const values = [];
      for (let index = start; index < byPoint.length; index += 1) values.push({ index, ...byPoint[index][player.id] });
      return { playerId: player.id, firstIndex: start, values, rating: values.at(-1).rating, theta: values.at(-1).theta };
    })
    .sort((a, b) => b.rating - a.rating || String(a.playerId).localeCompare(String(b.playerId)));

  return {
    points,
    series,
    matches: canonical,
    matchCount: canonical.length,
    config: last?.config ?? baselineConfig,
    theta: last?.theta ?? Object.fromEntries(roster.map((player) => [player.id, 0])),
    converged: last ? last.converged : true,
  };
}
