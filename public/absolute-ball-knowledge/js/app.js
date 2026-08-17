import { collection, db, doc, isFirebaseConfigured, missingFirebaseConfigKeys, runTransaction, serverTimestamp } from "./firebase.js";
import { firestoreApi } from "./firestore-api.js";
import { TEAM_OPTION_LIMIT, teamOptions } from "./logic.js";
import { MODEL_VERSION, predictMatch } from "./rating-model.js";
import { createStore } from "./store.js";
import { createRatingChart } from "./rating-chart.js";
import { MAIN_PAGE_MATCH_LIMIT, renderMatchList } from "./match-list.js";
import { mountMatchAdmin } from "./match-admin.js";
import {
  cleanPlayerName,
  conflictExists,
  deleteUnusedPlayer,
  documentVersion,
  findMatchReferences,
  findNameConflicts,
  renamePlayer,
  validateEditableMatch,
} from "./mutations.js";
import { $, $$, createMessage, escapeHtml, linkLocalMode, onSubmit, setBusy } from "./ui.js";

const store = createStore();
// UI-only selections live alongside the shared snapshot the store owns, so every
// render reads one object. Only the store ever writes rawPlayers/players/matches/fit.
const state = Object.assign(store.state, {
  teamA: new Set(),
  teamB: new Set(),
  editingPlayer: null,
  deletingPlayer: null,
  // The generated splits currently on screen. Local UI state only: generating teams
  // never touches Firestore, and choosing one only preselects the Record Match form.
  generatedOptions: [],
});

const connectionStatus = $("#connection-status");
const showMessage = createMessage($("#global-message"));
const matchAdmin = mountMatchAdmin({ store, showMessage });
const ratingChart = createRatingChart($("#rating-history"));
linkLocalMode();

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
    const busy = store.isPending(`player:${player.id}`) ? "disabled" : "";
    return `<tr>
      <td class="rank">${index + 1}</td>
      <td><span class="player-cell"><span>${escapeHtml(player.name)}${player.provisional ? " <span class=\"muted\">(provisional)</span>" : ""}</span>
        <span class="row-actions"><button class="text-action" type="button" data-edit-player="${escapeHtml(player.id)}" ${busy}>Edit</button><button class="text-action is-danger" type="button" data-delete-player="${escapeHtml(player.id)}" ${busy}>Delete</button></span>
      </span></td>
      <td><strong>${player.rating}</strong></td>
      <td>${player.games}</td><td>${player.wins}</td><td>${player.losses}</td><td>${winRate}</td>
    </tr>`;
  }).join("");
}

/**
 * The main page renders the newest five only. `state.matches` still holds every
 * recorded match, and every rating figure on the page is fitted from all of them;
 * this is a slice for the eye, and "Show all" links to the full history page.
 */
function renderMatches() {
  renderMatchList($("#recent-matches"), state.matches.slice(0, MAIN_PAGE_MATCH_LIMIT), {
    nameFor: (id) => store.playerName(id),
    isPending: (key) => store.isPending(key),
  });
  const total = state.matches.length;
  $("#match-count").textContent = total > MAIN_PAGE_MATCH_LIMIT
    ? `Latest ${MAIN_PAGE_MATCH_LIMIT} of ${total}`
    : `${total} recorded`;
  $("#show-all-matches").hidden = total === 0;
}

function renderRatingHistory() {
  ratingChart.update(store.ratingHistory(), (id) => store.playerName(id));
}

/**
 * The Leaderboard panel holds two views of the same fit -- the numeric table and the
 * Rating History chart -- and shows exactly one of them. This is local UI state only:
 * nothing about the choice is stored, and neither view changes what is computed. The
 * hidden view stays in the DOM, so switching back is a visibility flip, not a render.
 *
 * The chart cannot measure itself while hidden; its ResizeObserver redraws it the
 * moment it gains a width, which is the same path the main tab switch already uses.
 */
function setLeaderboardView(view) {
  $$(".segment").forEach((segment) => {
    const active = segment.dataset.view === view;
    segment.classList.toggle("is-active", active);
    segment.setAttribute("aria-selected", String(active));
    segment.tabIndex = active ? 0 : -1;
    $(`#${segment.getAttribute("aria-controls")}`).hidden = !active;
  });
}

function renderAll() {
  renderPlayerSelectors();
  renderLeaderboard();
  renderMatches();
  renderRatingHistory();
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

function activateTab(id) {
  $$(".tab").forEach((item) => {
    const active = item.dataset.tab === id;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  });
  $$(".tab-panel").forEach((panel) => {
    const active = panel.id === id;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
}

$$(".tab").forEach((tab) => tab.addEventListener("click", () => activateTab(tab.dataset.tab)));

$$(".segment").forEach((segment) => segment.addEventListener("click", () => setLeaderboardView(segment.dataset.view)));
// Left/right arrows move between the two views, as a tablist is expected to.
$(".segmented").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  const segments = $$(".segment");
  const next = segments[(segments.findIndex((item) => item === event.target) + (event.key === "ArrowRight" ? 1 : segments.length - 1)) % segments.length];
  setLeaderboardView(next.dataset.view);
  next.focus();
});

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
    // Replaces the options on screen outright; nothing generated is ever persisted.
    state.generatedOptions = teamOptions(
      ids.map((id) => state.players.find((player) => player.id === id)),
      { beta: state.fit?.beta ?? 0, limit: TEAM_OPTION_LIMIT },
    );
    renderGeneratedOptions();
  } catch (error) {
    state.generatedOptions = [];
    $("#generated-result").hidden = true;
    showMessage(error.message, "error");
  }
});

const OPTION_LABELS = ["Best balance", "Alternative 2", "Alternative 3"];

function renderGeneratedOptions() {
  const options = state.generatedOptions;
  const container = $("#generated-result");
  container.hidden = options.length === 0;
  if (!options.length) return (container.innerHTML = "");
  const first = options[0];
  const note = options.length === 1
    ? "One balanced split is possible for this group."
    : `${options.length} near-optimal splits, best balance first.`;
  container.innerHTML = `
    <div class="balance-summary">${first.teamA.length} vs ${first.teamB.length} · ${note}${
      Math.abs(first.sizeEffect) > 1e-9 ? ` · size effect ${(first.sizeEffect * 100).toFixed(1)} points` : " · no team-size effect"
    }</div>
    <div class="team-options">${options.map(generatedOptionHtml).join("")}</div>`;
}

function generatedOptionHtml(option, index) {
  const percent = (value) => `${(value * 100).toFixed(1)}%`;
  return `<article class="team-option${index === 0 ? " is-best" : ""}">
    <header>
      <span class="option-label">${OPTION_LABELS[index] ?? `Alternative ${index + 1}`}</span>
      <span class="option-odds">${percent(option.probabilityA)} / ${percent(1 - option.probabilityA)}</span>
    </header>
    <div class="option-teams">
      ${optionSideHtml("Team A", option.teamA, option.averageA)}
      ${optionSideHtml("Team B", option.teamB, option.averageB)}
    </div>
    <button class="button ${index === 0 ? "button-primary" : "button-secondary"} button-wide" type="button" data-use-option="${index}">Use these teams</button>
  </article>`;
}

function optionSideHtml(name, players, average) {
  return `<div class="option-side">
    <h3>${name}<span>${Math.round(average)} avg</span></h3>
    <p>${players.map((player) => `${escapeHtml(player.name)} <span class="muted">${player.rating}</span>`).join(", ")}</p>
  </div>`;
}

/**
 * Sends a generated split into Record Match as a plain preselection: the checkboxes
 * the user would have ticked themselves, nothing locked and nothing written. Scores
 * stay empty, so the match is only created when the real result is entered and saved.
 */
$("#generated-result").addEventListener("click", (event) => {
  const button = event.target.closest("[data-use-option]");
  if (!button) return;
  const option = state.generatedOptions[Number(button.dataset.useOption)];
  if (!option) return;
  state.teamA = new Set(option.teamA.map((player) => player.id));
  state.teamB = new Set(option.teamB.map((player) => player.id));
  $("#score-a").value = "";
  $("#score-b").value = "";
  renderPlayerSelectors();
  activateTab("record");
  $("#record").scrollIntoView({ block: "start" });
  showMessage("Teams preselected. Adjust anyone you like, then enter the score to save the match.");
});

function openPlayerEditor(player) {
  state.editingPlayer = player;
  $("#edit-player-name").value = player.name;
  $("#edit-player-dialog").showModal();
  setTimeout(() => $("#edit-player-name").focus(), 0);
}

async function confirmPlayerDeletion(player) {
  const key = `player:${player.id}`;
  store.setPending(key, true);
  try {
    const references = await findMatchReferences(firestoreApi, db, player.id);
    if (references.length) return showMessage("This player cannot be deleted because they appear in recorded matches.", "error");
    state.deletingPlayer = player;
    $("#delete-player-copy").textContent = `Delete ${player.name}? This only removes the player profile.`;
    $("#delete-player-dialog").showModal();
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    store.setPending(key, false);
  }
}

$("#leaderboard-body").addEventListener("click", (event) => {
  const edit = event.target.closest("[data-edit-player]");
  const remove = event.target.closest("[data-delete-player]");
  if (edit) {
    const player = store.playerById(edit.dataset.editPlayer);
    if (player) openPlayerEditor(player); else showMessage("This player was already deleted by another browser.", "error");
  }
  if (remove) {
    const player = store.playerById(remove.dataset.deletePlayer);
    if (player) confirmPlayerDeletion(player); else showMessage("This player was already deleted by another browser.", "error");
  }
});

$("#recent-matches").addEventListener("click", matchAdmin.handleListClick);

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

$("#cancel-delete-player").addEventListener("click", () => $("#delete-player-dialog").close());
onSubmit("delete-player-form", async () => {
  const player = state.deletingPlayer;
  if (!player) return;
  const key = `player:${player.id}`; const button = $("#confirm-delete-player");
  setBusy(button, true, "Deleting…"); store.setPending(key, true);
  try {
    await deleteUnusedPlayer({ api: firestoreApi, db, playerId: player.id, expectedVersion: documentVersion(player) });
    $("#delete-player-dialog").close();
    showMessage("Player deleted.");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    setBusy(button, false); store.setPending(key, false);
  }
});

store.subscribe(renderAll);

if (!isFirebaseConfigured) {
  connectionStatus.textContent = "Setup required";
  connectionStatus.className = "connection-status is-error";
  showMessage(
    `Firebase configuration is incomplete. Add ${missingFirebaseConfigKeys.join(", ")} to js/firebase-config.js; setup details are in README.md.`,
    "error",
  );
  renderAll();
} else {
  store.start({
    onError: (message) => showMessage(message, "error"),
    onLive: () => {
      connectionStatus.textContent = "Live";
      connectionStatus.className = "connection-status is-online";
    },
    onConnectionError: (error) => {
      connectionStatus.textContent = "Connection error";
      connectionStatus.className = "connection-status is-error";
      showMessage(`Firebase error: ${error.message}`, "error");
    },
  });
}
