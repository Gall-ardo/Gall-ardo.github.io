import { validateMatch } from "./rating-model.js";
import { normalizePlayerName } from "./logic.js";

export function cleanPlayerName(value) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Player name cannot be blank.");
  if (name.length < 2 || name.length > 40) throw new Error("Use a name between 2 and 40 characters.");
  if (!/[\p{L}\p{N}]/u.test(name)) throw new Error("The name must contain a letter or number.");
  const normalizedName = normalizePlayerName(name);
  // Lowercasing can lengthen a name ("İ" becomes "i" plus a combining dot), and the
  // security rules bound the stored normalizedName as well, so check it here to fail
  // with a readable message instead of a permission error.
  if (normalizedName.length < 2 || normalizedName.length > 40) throw new Error("Use a name between 2 and 40 characters.");
  return { name, normalizedName };
}

/**
 * Optimistic-concurrency token. The Firestore Web SDK's DocumentSnapshot exposes no
 * document version (unlike the Admin SDK, it has no `updateTime`), so the token is
 * the `updatedAt` the client itself writes on every mutation. Documents written
 * before `updatedAt` existed fall back to `createdAt`; a document with neither is
 * unguarded, and the mutation proceeds.
 */
export function documentVersion(data) {
  return data?.updatedAt ?? data?.createdAt ?? null;
}

function versionOf(snapshot) {
  return documentVersion(snapshot && snapshot.exists() ? snapshotData(snapshot) : null);
}

export function versionsMatch(expected, actual) {
  if (expected == null || actual == null) return expected === actual;
  if (typeof expected.isEqual === "function") return expected.isEqual(actual);
  if (typeof actual.isEqual === "function") return actual.isEqual(expected);
  if (typeof expected.toMillis === "function" && typeof actual.toMillis === "function") return expected.toMillis() === actual.toMillis();
  return String(expected) === String(actual);
}

function stale(message) {
  throw new Error(message || "This record changed in another browser. Refresh and try again.");
}

function assertCurrent(snapshot, expectedVersion, missingMessage) {
  if (!snapshot.exists()) throw new Error(missingMessage || "This record was already deleted by another browser.");
  if (expectedVersion != null && !versionsMatch(expectedVersion, versionOf(snapshot))) stale();
}

function snapshotData(snapshot) {
  return typeof snapshot.data === "function" ? snapshot.data() : snapshot.data;
}

function idsFromMatchInput(input) {
  return {
    scoreA: Number(input.scoreA),
    scoreB: Number(input.scoreB),
    teamA: Array.isArray(input.teamA) ? input.teamA.slice() : [],
    teamB: Array.isArray(input.teamB) ? input.teamB.slice() : [],
  };
}

/**
 * Mirrors the per-team ceiling in firestore.rules `validTeam`. It is checked only on
 * the write paths, never in `validateMatch`, because that one also parses recorded
 * history: a stored match must stay readable and rebuildable whatever its size.
 */
export const MAX_TEAM_SIZE = 20;

export function validateEditableMatch(input, knownPlayerIds) {
  const match = idsFromMatchInput(input);
  validateMatch(match, knownPlayerIds);
  if (match.teamA.length > MAX_TEAM_SIZE || match.teamB.length > MAX_TEAM_SIZE) {
    throw new Error(`A team cannot have more than ${MAX_TEAM_SIZE} players.`);
  }
  return match;
}

function matchWrite(match, timestamp) {
  return {
    scoreA: match.scoreA,
    scoreB: match.scoreB,
    winner: match.scoreA > match.scoreB ? "A" : "B",
    teamA: { playerIds: match.teamA },
    teamB: { playerIds: match.teamB },
    updatedAt: timestamp(),
  };
}

export async function findMatchReferences(api, db, playerId) {
  const matches = api.collection(db, "matches");
  const [a, b] = await Promise.all([
    api.getDocs(api.query(matches, api.where("teamA.playerIds", "array-contains", playerId))),
    api.getDocs(api.query(matches, api.where("teamB.playerIds", "array-contains", playerId))),
  ]);
  return [...a.docs, ...b.docs];
}

/**
 * Firestore cannot express a collection-wide "not referenced by any match" rule.
 * This re-query is deliberately immediately before the delete, but a backend or a
 * different data model would be required to make that guarantee race-proof.
 */
export async function deleteUnusedPlayer({ api, db, playerId, expectedVersion }) {
  const references = await findMatchReferences(api, db, playerId);
  if (references.length) throw new Error("This player cannot be deleted because they appear in recorded matches.");
  const playerRef = api.doc(db, "players", playerId);
  await api.runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(playerRef);
    assertCurrent(snapshot, expectedVersion, "This player was already deleted by another browser.");
    transaction.delete(playerRef);
  });
}

/**
 * Documents that already hold `normalizedName`, as document references.
 *
 * A Firestore transaction can only read document references, never queries, so the
 * name scan has to run before the transaction opens. Every candidate it returns is
 * re-read by reference inside the transaction, which both drops candidates that were
 * renamed away in the meantime and puts them in the transaction's read set. A player
 * that takes this name in another browser after the scan is still not covered; see
 * README.md.
 */
export async function findNameConflicts(api, db, normalizedName, exceptPlayerId) {
  const players = api.collection(db, "players");
  const found = await api.getDocs(api.query(players, api.where("normalizedName", "==", normalizedName)));
  return found.docs.filter((item) => item.id !== exceptPlayerId).map((item) => api.doc(db, "players", item.id));
}

export function conflictExists(snapshots, normalizedName) {
  return snapshots.some((item) => item.exists() && snapshotData(item)?.normalizedName === normalizedName);
}

export async function renamePlayer({ api, db, playerId, nextName, expectedVersion }) {
  const { name, normalizedName } = cleanPlayerName(nextName);
  const playerRef = api.doc(db, "players", playerId);
  const conflicts = await findNameConflicts(api, db, normalizedName, playerId);
  await api.runTransaction(db, async (transaction) => {
    const [snapshot, ...conflictSnapshots] = await Promise.all([
      transaction.get(playerRef),
      ...conflicts.map((reference) => transaction.get(reference)),
    ]);
    assertCurrent(snapshot, expectedVersion, "This player was already deleted by another browser.");
    if (conflictExists(conflictSnapshots, normalizedName)) throw new Error("That player already exists.");
    transaction.update(playerRef, { name, normalizedName, updatedAt: api.serverTimestamp() });
  });
}

async function assertPlayersExist(transaction, api, db, match) {
  const ids = [...match.teamA, ...match.teamB];
  const snapshots = await Promise.all(ids.map((id) => transaction.get(api.doc(db, "players", id))));
  if (snapshots.some((snapshot) => !snapshot.exists())) throw new Error("One or more selected players no longer exist. Refresh and choose again.");
  return new Set(ids);
}

export async function editMatch({ api, db, matchId, input, expectedVersion }) {
  const preliminary = validateEditableMatch(input);
  const matchRef = api.doc(db, "matches", matchId);
  await api.runTransaction(db, async (transaction) => {
    const current = await transaction.get(matchRef);
    assertCurrent(current, expectedVersion, "This match was already deleted by another browser.");
    const existingPlayers = await assertPlayersExist(transaction, api, db, preliminary);
    const match = validateEditableMatch(preliminary, existingPlayers);
    // modelVersion is deliberately absent from the update. transaction.update leaves
    // unlisted keys alone, and re-sending it would add the key to documents that
    // predate it, which the security rules reject as an unexpected field change.
    transaction.update(matchRef, matchWrite(match, api.serverTimestamp));
  });
}

export async function deleteMatch({ api, db, matchId, expectedVersion }) {
  const matchRef = api.doc(db, "matches", matchId);
  await api.runTransaction(db, async (transaction) => {
    const snapshot = await transaction.get(matchRef);
    assertCurrent(snapshot, expectedVersion, "This match was already deleted by another browser.");
    transaction.delete(matchRef);
  });
}
