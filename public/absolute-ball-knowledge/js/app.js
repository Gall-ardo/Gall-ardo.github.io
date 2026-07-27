import {
  collection,
  db,
  doc,
  getDocs,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "./firebase.js";
import {
  balanceTeams,
} from "./logic.js";
import { MODEL_VERSION, predictMatch, rebuildFromHistory } from "./rating-model.js";
import {
  cleanPlayerName,
  conflictExists,
  deleteMatch,
  deleteUnusedPlayer,
  documentVersion,
  editMatch,
  findMatchReferences,
  findNameConflicts,
  renamePlayer,
  validateEditableMatch,
} from "./mutations.js";

const firestoreApi = { collection, doc, getDocs, query, runTransaction, serverTimestamp, where };
const state = {
  rawPlayers: [], players: [], matches: [], fit: null, teamA: new Set(), teamB: new Set(),
  pending: new Set(), editingPlayer: null, editingMatch: null, deletingPlayer: null, deletingMatch: null,
};
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const globalMessage = $("#global-message");
const connectionStatus = $("#connection-status");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function showMessage(text, type = "success") {
  globalMessage.textContent = text;
  globalMessage.className = `message ${type === "error" ? "is-error" : ""}`;
  globalMessage.hidden = false;
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => { globalMessage.hidden = true; }, 6500);
}

function setBusy(button, busy, busyLabel) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.label;
}

/**
 * A form submitted again before its first write settles would send the second
 * request with the version it read before the first one landed, and report the
 * user's own change back as somebody else's conflict. Re-entrant submits are
 * dropped rather than queued.
 */
const submitting = new Set();
function onSubmit(formId, handler) {
  $(`#${formId}`).addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting.has(formId)) return;
    submitting.add(formId);
    try { await handler(event); } finally { submitting.delete(formId); }
  });
}

function actionBusy(key) { return state.pending.has(key); }
function setActionBusy(key, busy) {
  if (busy) state.pending.add(key); else state.pending.delete(key);
  renderLeaderboard(); renderMatches();
}

function matchIds(match, side) {
  const team = match[side];
  return Array.isArray(team) ? team : team?.playerIds || team?.players?.map((player) => player.id) || [];
}

function playerOption(player, side, checked, disabled) {
  return `
    <label class="check-option">
      <input type="checkbox" data-player-id="${escapeHtml(player.id)}" data-side="${side}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""}>
      <span>${escapeHtml(player.name)}</span>
      <small>${player.rating}</small>
    </label>`;
}

function renderPlayerSelectors() {
  const sorted = state.players.slice().sort((a, b) => a.name.localeCompare(b.name));
  const empty = '<div class="empty-state">Add players to get started.</div>';
  $("#team-a-options").innerHTML = sorted.length
    ? sorted.map((p) => playerOption(p, "a", state.teamA.has(p.id), state.teamB.has(p.id))).join("")
    : empty;
  $("#team-b-options").innerHTML = sorted.length
    ? sorted.map((p) => playerOption(p, "b", state.teamB.has(p.id), state.teamA.has(p.id))).join("")
    : empty;
  $("#participant-options").innerHTML = sorted.length
    ? sorted.map((p) => `
      <label class="check-option">
        <input type="checkbox" data-participant-id="${escapeHtml(p.id)}">
        <span>${escapeHtml(p.name)}</span><small>${p.rating}</small>
      </label>`).join("")
    : empty;
  updateMatchPreview();
}

function renderLeaderboard() {
  const players = state.players.slice().sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  $("#leaderboard-empty").hidden = players.length > 0;
  $("#leaderboard-body").innerHTML = players.map((player, index) => {
    const winRate = player.games ? `${Math.round((player.wins / player.games) * 100)}%` : "—";
    return `<tr>
      <td class="rank">${index + 1}</td>
      <td><span class="player-cell"><span>${escapeHtml(player.name)}${player.provisional ? " <span class=\"muted\">(provisional)</span>" : ""}</span>
        <span class="row-actions"><button class="text-action" type="button" data-edit-player="${escapeHtml(player.id)}" ${actionBusy(`player:${player.id}`) ? "disabled" : ""}>Edit</button><button class="text-action is-danger" type="button" data-delete-player="${escapeHtml(player.id)}" ${actionBusy(`player:${player.id}`) ? "disabled" : ""}>Delete</button></span>
      </span></td>
      <td><strong>${player.rating}</strong></td>
      <td>${player.games}</td><td>${player.wins}</td><td>${player.losses}</td><td>${winRate}</td>
    </tr>`;
  }).join("");
}

function renderMatches() {
  const container = $("#recent-matches");
  if (!state.matches.length) {
    container.innerHTML = '<div class="empty-state">No matches recorded yet.</div>';
    return;
  }
  container.innerHTML = state.matches.map((match) => {
    const date = match.createdAt?.toDate?.();
    const dateText = date ? new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date) : "Saving…";
    const names = (ids) => ids.map((id) => state.rawPlayers.find((player) => player.id === id)?.name || "Unknown player").join(", ");
    const aNames = names(matchIds(match, "teamA"));
    const bNames = names(matchIds(match, "teamB"));
    return `<article class="match-row">
      <div class="match-side"><strong>${escapeHtml(aNames)}</strong><span class="match-meta">${dateText}</span></div>
      <div class="match-score">${match.scoreA}–${match.scoreB}</div>
      <div class="match-side"><strong>${escapeHtml(bNames)}</strong><span class="match-meta">${escapeHtml(match.modelVersion || "legacy match")}</span></div>
      <div class="match-actions row-actions"><button class="text-action" type="button" data-edit-match="${escapeHtml(match.id)}" ${actionBusy(`match:${match.id}`) ? "disabled" : ""}>Edit</button><button class="text-action is-danger" type="button" data-delete-match="${escapeHtml(match.id)}" ${actionBusy(`match:${match.id}`) ? "disabled" : ""}>Delete</button></div>
    </article>`;
  }).join("");
}

function selectedPlayers(ids) {
  return [...ids].map((id) => state.players.find((player) => player.id === id)).filter(Boolean);
}

function updateMatchPreview() {
  const teamA = selectedPlayers(state.teamA);
  const teamB = selectedPlayers(state.teamB);
  const scoreA = Number($("#score-a").value);
  const scoreB = Number($("#score-b").value);
  const preview = $("#match-preview");
  if (!teamA.length || !teamB.length || !Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0 || scoreA === scoreB) {
    preview.textContent = "Select both teams and enter a decisive score to preview the rebuilt rating probability.";
    return;
  }
  const mean = (players) => players.reduce((sum, player) => sum + (state.fit?.theta[player.id] ?? 0), 0) / players.length;
  const probability = predictMatch(mean(teamA), mean(teamB), teamA.length, teamB.length, state.fit?.beta ?? 0);
  preview.textContent = `Current-model Team A win chance: ${(probability * 100).toFixed(1)}%. Scores are incorporated when the complete history is recalculated.`;
}

async function playerDocumentId(normalizedName) {
  const bytes = new TextEncoder().encode(normalizedName);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `name_${[...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function addPlayer(name) {
  const { name: cleanName, normalizedName } = cleanPlayerName(name);

  const id = await playerDocumentId(normalizedName);
  const playerRef = doc(db, "players", id);
  // A renamed player retains their old, name-derived ID. Use an automatic ID if
  // that old ID is occupied by somebody with a different current name.
  const fallbackRef = doc(collection(db, "players"));
  // Scanned before the transaction opens: a transaction can only read document
  // references, not queries. See findNameConflicts.
  const conflicts = await findNameConflicts(firestoreApi, db, normalizedName);
  await runTransaction(db, async (transaction) => {
    const [existing, ...conflictSnapshots] = await Promise.all([
      transaction.get(playerRef),
      ...conflicts.map((reference) => transaction.get(reference)),
    ]);
    if (conflictExists(conflictSnapshots, normalizedName)) throw new Error("That player already exists.");
    if (existing.exists() && existing.data()?.normalizedName === normalizedName) throw new Error("That player already exists.");
    const target = existing.exists() ? fallbackRef : playerRef;
    if (existing.exists() && (await transaction.get(fallbackRef)).exists()) throw new Error("Could not allocate a player ID. Please try again.");
    transaction.set(target, {
      name: cleanName,
      normalizedName,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  });
}

async function saveMatch(scoreA, scoreB) {
  const teamAIds = [...state.teamA];
  const teamBIds = [...state.teamB];
  if (!teamAIds.length || !teamBIds.length) throw new Error("Both teams need at least one player.");
  if (teamAIds.some((id) => state.teamB.has(id))) throw new Error("A player cannot be on both teams.");
  if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB) || scoreA < 0 || scoreB < 0) {
    throw new Error("Enter non-negative whole-number scores.");
  }
  if (scoreA === scoreB) throw new Error("A match cannot end in a draw.");

  const matchRef = doc(collection(db, "matches"));
  const byId = new Map(state.players.map((player) => [player.id, player]));
  // Shares the edit path's validation so a new match and an edited one are held to the
  // same bounds, including the per-team ceiling the security rules enforce.
  const match = validateEditableMatch({ scoreA, scoreB, teamA: teamAIds, teamB: teamBIds }, new Set(byId.keys()));
  await runTransaction(db, async (transaction) => {
    const snapshots = await Promise.all([...teamAIds, ...teamBIds].map((id) => transaction.get(doc(db, "players", id))));
    if (snapshots.some((snapshot) => !snapshot.exists())) throw new Error("One or more selected players no longer exist. Refresh and choose again.");
    transaction.set(matchRef, { ...match, winner: scoreA > scoreB ? "A" : "B", modelVersion: MODEL_VERSION,
      teamA: { playerIds: teamAIds }, teamB: { playerIds: teamBIds }, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
  });
}

function rebuildState() {
  try {
    const valid = state.matches.filter((match) => match.createdAt?.toDate instanceof Function);
    const rebuilt = rebuildFromHistory(state.rawPlayers, valid, { requireTimestamp: true });
    state.players = rebuilt.players; state.fit = rebuilt; renderPlayerSelectors(); renderLeaderboard(); renderMatches();
  } catch (error) { console.error(error); showMessage(`History validation error: ${error.message}`, "error"); }
}

function subscribeToData() {
  let playersReady = false;
  let matchesReady = false;
  const connected = () => {
    if (playersReady && matchesReady) {
      connectionStatus.textContent = "Live";
      connectionStatus.className = "connection-status is-online";
    }
  };
  const fail = (error) => {
    console.error(error);
    connectionStatus.textContent = "Connection error";
    connectionStatus.className = "connection-status is-error";
    showMessage(`Firebase error: ${error.message}`, "error");
  };

  onSnapshot(collection(db, "players"), (snapshot) => {
    state.rawPlayers = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    state.players = state.rawPlayers;
    const ids = new Set(state.players.map((p) => p.id));
    state.teamA = new Set([...state.teamA].filter((id) => ids.has(id)));
    state.teamB = new Set([...state.teamB].filter((id) => ids.has(id)));
    rebuildState();
    playersReady = true;
    connected();
  }, fail);

  onSnapshot(collection(db, "matches"), (snapshot) => {
    state.matches = snapshot.docs.map((item) => ({ id: item.id, ...item.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    rebuildState();
    matchesReady = true;
    connected();
  }, fail);
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => {
  $$(".tab").forEach((item) => {
    const active = item === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  });
  $$(".tab-panel").forEach((panel) => {
    const active = panel.id === tab.dataset.tab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}));

$$("[data-open-player]").forEach((button) => button.addEventListener("click", () => {
  if (!isFirebaseConfigured) return showMessage("Add your Firebase Web config before creating players.", "error");
  $("#player-dialog").showModal();
  setTimeout(() => $("#player-name").focus(), 0);
}));
$("#close-player-dialog").addEventListener("click", () => $("#player-dialog").close());

onSubmit("player-form", async () => {
  const button = $("#add-player");
  setBusy(button, true, "Adding…");
  try {
    await addPlayer($("#player-name").value);
    $("#player-form").reset();
    $("#player-dialog").close();
    showMessage("Player added. Ratings begin at 1000 and are rebuilt from match history.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

$("#record").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-player-id]");
  if (!checkbox) return;
  const own = checkbox.dataset.side === "a" ? state.teamA : state.teamB;
  if (checkbox.checked) own.add(checkbox.dataset.playerId);
  else own.delete(checkbox.dataset.playerId);
  renderPlayerSelectors();
});
$("#score-a").addEventListener("input", updateMatchPreview);
$("#score-b").addEventListener("input", updateMatchPreview);

onSubmit("match-form", async (event) => {
  if (!isFirebaseConfigured) return showMessage("Add your Firebase Web config before saving matches.", "error");
  const button = $("#save-match");
  setBusy(button, true, "Saving atomically…");
  try {
    await saveMatch(Number($("#score-a").value), Number($("#score-b").value));
    event.target.reset();
    state.teamA.clear();
    state.teamB.clear();
    renderPlayerSelectors();
    showMessage("Match saved. Ratings and records have been rebuilt from complete history.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

$("#team-generator-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const ids = $$("[data-participant-id]:checked").map((checkbox) => checkbox.dataset.participantId);
    const result = balanceTeams(ids.map((id) => state.players.find((player) => player.id === id)), { beta: state.fit?.beta ?? 0, session: new Date().toISOString().slice(0, 10) });
    $("#generated-result").hidden = false;
    $("#generated-result").innerHTML = `
      <div class="balance-summary">${result.teamA.length} vs ${result.teamB.length} · Team A ${(result.probabilityA * 100).toFixed(1)}% · Team B ${((1 - result.probabilityA) * 100).toFixed(1)}%${Math.abs(result.sizeEffect) > 1e-9 ? ` · size effect ${(result.sizeEffect * 100).toFixed(1)} points` : " · no team-size effect"}</div>
      <div class="generated-grid">
        ${generatedTeamHtml("Team A", result.teamA, result.averageA)}
        ${generatedTeamHtml("Team B", result.teamB, result.averageB)}
      </div>`;
  } catch (error) {
    showMessage(error.message, "error");
  }
});

function generatedTeamHtml(name, players, average) {
  return `<article class="generated-team">
    <h2>${name}<span>${Math.round(average)} avg · ${players.length} players</span></h2>
    <ol>${players.map((player) => `<li>${escapeHtml(player.name)} <span class="muted">(${player.rating})</span></li>`).join("")}</ol>
  </article>`;
}

function playerById(id) { return state.rawPlayers.find((player) => player.id === id); }

function playerNames(ids) {
  return ids.map((id) => playerById(id)?.name || "Unknown player").join(", ");
}

function openPlayerEditor(player) {
  state.editingPlayer = player;
  $("#edit-player-name").value = player.name;
  $("#edit-player-dialog").showModal();
  setTimeout(() => $("#edit-player-name").focus(), 0);
}

function renderMatchEditor(match) {
  const a = new Set(matchIds(match, "teamA"));
  const b = new Set(matchIds(match, "teamB"));
  const options = state.players.slice().sort((left, right) => left.name.localeCompare(right.name));
  const option = (player, side) => `<label class="check-option"><input type="checkbox" data-edit-side="${side}" data-edit-player-id="${escapeHtml(player.id)}" ${side === "a" ? (a.has(player.id) ? "checked" : "") : (b.has(player.id) ? "checked" : "")}><span>${escapeHtml(player.name)}</span><small>${player.rating}</small></label>`;
  $("#edit-match-a-options").innerHTML = options.map((player) => option(player, "a")).join("");
  $("#edit-match-b-options").innerHTML = options.map((player) => option(player, "b")).join("");
  $("#edit-score-a").value = match.scoreA;
  $("#edit-score-b").value = match.scoreB;
}

function openMatchEditor(match) {
  state.editingMatch = match;
  renderMatchEditor(match);
  $("#edit-match-dialog").showModal();
}

async function confirmPlayerDeletion(player) {
  const key = `player:${player.id}`;
  setActionBusy(key, true);
  try {
    const references = await findMatchReferences(firestoreApi, db, player.id);
    if (references.length) return showMessage("This player cannot be deleted because they appear in recorded matches.", "error");
    state.deletingPlayer = player;
    $("#delete-player-copy").textContent = `Delete ${player.name}? This only removes the player profile.`;
    $("#delete-player-dialog").showModal();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setActionBusy(key, false);
  }
}

function openMatchDelete(match) {
  state.deletingMatch = match;
  $("#delete-match-copy").textContent = `Delete ${playerNames(matchIds(match, "teamA"))} ${match.scoreA}–${match.scoreB} ${playerNames(matchIds(match, "teamB"))}?`;
  $("#delete-match-dialog").showModal();
}

$("#leaderboard-body").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-player]");
  const remove = event.target.closest("[data-delete-player]");
  if (edit) {
    const player = playerById(edit.dataset.editPlayer);
    if (player) openPlayerEditor(player); else showMessage("This player was already deleted by another browser.", "error");
  }
  if (remove) {
    const player = playerById(remove.dataset.deletePlayer);
    if (player) confirmPlayerDeletion(player); else showMessage("This player was already deleted by another browser.", "error");
  }
});

$("#recent-matches").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-match]");
  const remove = event.target.closest("[data-delete-match]");
  if (edit) {
    const match = state.matches.find((item) => item.id === edit.dataset.editMatch);
    if (match) openMatchEditor(match); else showMessage("This match was already deleted by another browser.", "error");
  }
  if (remove) {
    const match = state.matches.find((item) => item.id === remove.dataset.deleteMatch);
    if (match) openMatchDelete(match); else showMessage("This match was already deleted by another browser.", "error");
  }
});

$("#close-edit-player-dialog").addEventListener("click", () => $("#edit-player-dialog").close());
onSubmit("edit-player-form", async () => {
  const player = state.editingPlayer;
  if (!player) return;
  const button = $("#save-player-edit");
  setBusy(button, true, "Saving…");
  try {
    await renamePlayer({ api: firestoreApi, db, playerId: player.id, nextName: $("#edit-player-name").value, expectedVersion: documentVersion(player) });
    $("#edit-player-dialog").close();
    showMessage("Player renamed. Existing matches keep their player IDs; historical name snapshots, if any, remain unchanged.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false);
  }
});

$("#close-edit-match-dialog").addEventListener("click", () => $("#edit-match-dialog").close());
$("#edit-match-dialog").addEventListener("change", (event) => {
  const checkbox = event.target.closest("[data-edit-player-id]");
  if (!checkbox || !checkbox.checked) return;
  const other = checkbox.dataset.editSide === "a" ? "b" : "a";
  $$(`[data-edit-side="${other}"][data-edit-player-id="${checkbox.dataset.editPlayerId}"]`).forEach((item) => { item.checked = false; });
});
onSubmit("edit-match-form", async () => {
  const match = state.editingMatch;
  if (!match) return;
  const key = `match:${match.id}`;
  const button = $("#save-match-edit");
  setBusy(button, true, "Saving…"); setActionBusy(key, true);
  try {
    const teamA = $$('[data-edit-side="a"]:checked').map((item) => item.dataset.editPlayerId);
    const teamB = $$('[data-edit-side="b"]:checked').map((item) => item.dataset.editPlayerId);
    await editMatch({ api: firestoreApi, db, matchId: match.id, expectedVersion: documentVersion(match), input: { teamA, teamB, scoreA: $("#edit-score-a").value, scoreB: $("#edit-score-b").value } });
    $("#edit-match-dialog").close();
    showMessage("Match updated. Ratings and statistics have been rebuilt from complete history.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false); setActionBusy(key, false);
  }
});

$("#cancel-delete-player").addEventListener("click", () => $("#delete-player-dialog").close());
onSubmit("delete-player-form", async () => {
  const player = state.deletingPlayer;
  if (!player) return;
  const key = `player:${player.id}`; const button = $("#confirm-delete-player");
  setBusy(button, true, "Deleting…"); setActionBusy(key, true);
  try {
    await deleteUnusedPlayer({ api: firestoreApi, db, playerId: player.id, expectedVersion: documentVersion(player) });
    $("#delete-player-dialog").close();
    showMessage("Player deleted.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false); setActionBusy(key, false);
  }
});

$("#cancel-delete-match").addEventListener("click", () => $("#delete-match-dialog").close());
onSubmit("delete-match-form", async () => {
  const match = state.deletingMatch;
  if (!match) return;
  const key = `match:${match.id}`; const button = $("#confirm-delete-match");
  setBusy(button, true, "Deleting…"); setActionBusy(key, true);
  try {
    await deleteMatch({ api: firestoreApi, db, matchId: match.id, expectedVersion: documentVersion(match) });
    $("#delete-match-dialog").close();
    showMessage("Match deleted. All ratings and statistics have been rebuilt from remaining history.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false); setActionBusy(key, false);
  }
});

if (!isFirebaseConfigured) {
  connectionStatus.textContent = "Setup required";
  connectionStatus.className = "connection-status is-error";
  showMessage(
    `Firebase configuration is incomplete. Add ${missingFirebaseConfigKeys.join(", ")} to js/firebase-config.js; setup details are in README.md.`,
    "error",
  );
  renderPlayerSelectors();
  renderLeaderboard();
} else {
  subscribeToData();
}
