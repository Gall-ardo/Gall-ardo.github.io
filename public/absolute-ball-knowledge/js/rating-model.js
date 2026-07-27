export const MODEL_VERSION = "score_logistic_v1";
export const DEFAULT_MODEL_CONFIG = Object.freeze({
  lambdaTheta: 4,
  lambdaBeta: 20,
  betaPriorMean: 0.10,
  halfLifeDays: Infinity,
  provisionalMatchThreshold: 5,
  ratingScale: 120,
  maxIterations: 80,
  tolerance: 1e-9,
});

export function stableSigmoid(value) {
  if (value >= 0) { const z = Math.exp(-Math.min(value, 745)); return 1 / (1 + z); }
  const z = Math.exp(Math.max(value, -745)); return z / (1 + z);
}
export function logSigmoid(value) { return value >= 0 ? -Math.log1p(Math.exp(-value)) : value - Math.log1p(Math.exp(value)); }
export function displayRating(theta, config = DEFAULT_MODEL_CONFIG) { return Math.round(1000 + config.ratingScale * theta); }
export function predictMatch(meanA, meanB, teamASize, teamBSize, beta = 0) { return stableSigmoid(meanA - meanB + beta * (teamASize - teamBSize)); }

function timestampMillis(value) {
  if (value?.toDate instanceof Function) value = value.toDate();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" || typeof value === "number") return new Date(value).getTime();
  return NaN;
}
function teamIds(team) {
  const members = Array.isArray(team) ? team : team?.playerIds ?? team?.players;
  return Array.isArray(members) ? members.map((member) => typeof member === "string" ? member : member?.id) : null;
}
export function validateMatch(match, knownPlayerIds, { requireTimestamp = false } = {}) {
  if (!match || typeof match !== "object") throw new Error("Match must be an object.");
  const teamA = teamIds(match.teamA); const teamB = teamIds(match.teamB);
  if (!teamA?.length || !teamB?.length) throw new Error("Both teams need at least one player.");
  const each = [...teamA, ...teamB];
  if (each.some((id) => typeof id !== "string" || !id)) throw new Error("Match contains an invalid player ID.");
  if (new Set(teamA).size !== teamA.length || new Set(teamB).size !== teamB.length) throw new Error("A player cannot appear twice on one team.");
  if (new Set(each).size !== each.length) throw new Error("A player cannot be on both teams.");
  if (knownPlayerIds && each.some((id) => !knownPlayerIds.has(id))) throw new Error("Match references an unknown player.");
  if (!Number.isInteger(match.scoreA) || !Number.isInteger(match.scoreB) || match.scoreA < 0 || match.scoreB < 0) throw new Error("Scores must be non-negative whole numbers.");
  if (match.scoreA === match.scoreB) throw new Error("A match cannot end in a draw.");
  const time = timestampMillis(match.createdAt);
  if (requireTimestamp && !Number.isFinite(time)) throw new Error("Match has an invalid timestamp.");
  return { id: String(match.id ?? ""), teamA, teamB, scoreA: match.scoreA, scoreB: match.scoreB, createdAt: time };
}

export function canonicalMatches(matches, players, options) {
  const known = new Set((players || []).map((player) => typeof player === "string" ? player : player.id));
  return matches.map((match) => validateMatch(match, known, options)).sort((a, b) =>
    a.createdAt - b.createdAt || a.id.localeCompare(b.id) || `${a.teamA.join(",")}|${a.teamB.join(",")}`.localeCompare(`${b.teamA.join(",")}|${b.teamB.join(",")}`));
}

function solve(matrix, vector) {
  const n = vector.length; const a = matrix.map((row, index) => row.slice().concat(vector[index]));
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    if (!Number.isFinite(a[pivot][col]) || Math.abs(a[pivot][col]) < 1e-14) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;
    for (let row = 0; row < n; row += 1) if (row !== col) {
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row[n]);
}

function objective(rows, values, config, includeBeta) {
  let result = 0;
  for (const row of rows) {
    let d = 0; for (const [index, x] of row.x) d += values[index] * x;
    result += -row.scoreA * logSigmoid(d) - row.scoreB * logSigmoid(-d);
  }
  for (let index = 0; index < values.length - (includeBeta ? 1 : 0); index += 1) result += config.lambdaTheta * values[index] ** 2 / 2;
  if (includeBeta) result += config.lambdaBeta * (values.at(-1) - config.betaPriorMean) ** 2 / 2;
  return result;
}

/**
 * Design rows for the score-logistic model. Each row carries the sparse vector
 * x with x_i = +1/|A| for team A, -1/|B| for team B, and x_beta = |A| - |B|,
 * so that d = x · values reproduces mean(thetaA) - mean(thetaB) + beta * sizeDifference.
 */
function buildDesign(players, matches, { includeBeta, requireTimestamp }) {
  const orderedPlayers = players.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const index = new Map(orderedPlayers.map((player, i) => [player.id, i]));
  const canonical = canonicalMatches(matches, orderedPlayers, { requireTimestamp });
  const dimensions = orderedPlayers.length + (includeBeta ? 1 : 0);
  const betaIndex = dimensions - 1;
  const rows = canonical.map((match) => {
    const x = new Map();
    for (const id of match.teamA) x.set(index.get(id), (x.get(index.get(id)) || 0) + 1 / match.teamA.length);
    for (const id of match.teamB) x.set(index.get(id), (x.get(index.get(id)) || 0) - 1 / match.teamB.length);
    if (includeBeta) x.set(betaIndex, match.teamA.length - match.teamB.length);
    return { ...match, x: [...x.entries()].sort((a, b) => a[0] - b[0]) };
  });
  return { orderedPlayers, canonical, rows, dimensions, betaIndex };
}

/**
 * Exact gradient and Hessian of `objective`. For the canonical logistic link the
 * Newton system equals the IRLS system, so the same weights serve both.
 *   dNLL/dd  = (scoreA + scoreB) * p - scoreA
 *   d2NLL/dd2 = (scoreA + scoreB) * p * (1 - p)
 */
function derivatives(rows, values, config, includeBeta, dimensions, betaIndex) {
  const gradient = Array(dimensions).fill(0);
  const hessian = Array.from({ length: dimensions }, () => Array(dimensions).fill(0));
  for (const row of rows) {
    let d = 0; for (const [i, x] of row.x) d += values[i] * x;
    const p = stableSigmoid(d); const weight = (row.scoreA + row.scoreB) * p * (1 - p); const residual = (row.scoreA + row.scoreB) * p - row.scoreA;
    for (const [i, xi] of row.x) { gradient[i] += residual * xi; for (const [j, xj] of row.x) hessian[i][j] += weight * xi * xj; }
  }
  for (let i = 0; i < dimensions; i += 1) {
    const beta = includeBeta && i === betaIndex;
    const lambda = beta ? config.lambdaBeta : config.lambdaTheta;
    const prior = beta ? config.betaPriorMean : 0;
    gradient[i] += lambda * (values[i] - prior); hessian[i][i] += lambda + 1e-10;
  }
  return { gradient, hessian };
}

/** Test hook: the exact pieces the optimizer runs on, for finite-difference checks. */
export const modelInternals = Object.freeze({ buildDesign, derivatives, objective, solve });

/** Small deterministic damped Newton/IRLS fit of the binomial score likelihood. */
export function fitScoreLogistic(players, matches, options = {}) {
  const config = { ...DEFAULT_MODEL_CONFIG, ...options };
  // No time weighting is implemented; a finite half-life would be silently ignored.
  if (Number.isFinite(config.halfLifeDays)) throw new Error("halfLifeDays is not implemented; this model applies no time decay.");
  const includeBeta = options.includeBeta !== false;
  const { orderedPlayers, canonical, rows, dimensions, betaIndex } =
    buildDesign(players, matches, { includeBeta, requireTimestamp: options.requireTimestamp ?? true });
  let values = Array(dimensions).fill(0); if (includeBeta) values[betaIndex] = config.betaPriorMean;
  let current = objective(rows, values, config, includeBeta); let converged = false; let iterations = 0;
  for (; iterations < config.maxIterations; iterations += 1) {
    const { gradient, hessian } = derivatives(rows, values, config, includeBeta, dimensions, betaIndex);
    const step = solve(hessian, gradient.map((value) => -value));
    if (!step || step.some((value) => !Number.isFinite(value))) break;
    let alpha = 1; let next = values.map((value, i) => value + step[i] * alpha); let nextObjective = objective(rows, next, config, includeBeta);
    while ((!Number.isFinite(nextObjective) || nextObjective > current) && alpha > 1e-8) { alpha /= 2; next = values.map((value, i) => value + step[i] * alpha); nextObjective = objective(rows, next, config, includeBeta); }
    if (!Number.isFinite(nextObjective) || nextObjective > current) {
      // At a stationary point the full Newton step is already below tolerance and no
      // representable decrease is left, so a failed line search there is convergence.
      if (Math.max(...step.map(Math.abs)) < config.tolerance) converged = true;
      break;
    }
    const maximumChange = Math.max(...step.map((value) => Math.abs(value * alpha)));
    values = next; current = nextObjective;
    if (maximumChange < config.tolerance) { converged = true; iterations += 1; break; }
  }
  if (values.some((value) => !Number.isFinite(value))) throw new Error("Rating optimizer produced a non-finite value.");
  const theta = Object.fromEntries(orderedPlayers.map((player, i) => [player.id, values[i]]));
  return { modelVersion: MODEL_VERSION, theta, beta: includeBeta ? values[betaIndex] : 0, objective: current, converged, iterations, matches: canonical, config, includeBeta, meanTheta: values.slice(0, orderedPlayers.length).reduce((a, b) => a + b, 0) / Math.max(1, orderedPlayers.length) };
}

export function rebuildFromHistory(players, matches, options = {}) {
  const fit = fitScoreLogistic(players, matches, options);
  const records = Object.fromEntries(players.map((player) => [player.id, { games: 0, wins: 0, losses: 0 }]));
  for (const match of fit.matches) for (const id of [...match.teamA, ...match.teamB]) {
    const record = records[id]; record.games += 1;
    const won = match.teamA.includes(id) ? match.scoreA > match.scoreB : match.scoreB > match.scoreA;
    if (won) record.wins += 1; else record.losses += 1;
  }
  return { ...fit, players: players.map((player) => ({ ...player, theta: fit.theta[player.id] ?? 0, rating: displayRating(fit.theta[player.id] ?? 0, fit.config), ...records[player.id], provisional: records[player.id].games < fit.config.provisionalMatchThreshold })) };
}
