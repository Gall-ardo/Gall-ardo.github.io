import {
  collection,
  db,
  doc,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
  onSnapshot,
  runTransaction,
  setDoc,
  serverTimestamp,
} from "./firebase.js";
import {
  balanceTeams,
  normalizePlayerName,
} from "./logic.js";
import { MODEL_VERSION, predictMatch, rebuildFromHistory, validateMatch } from "./rating-model.js";

const state = { rawPlayers: [], players: [], matches: [], fit: null, teamA: new Set(), teamB: new Set() };
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
      <td>${escapeHtml(player.name)}${player.provisional ? " <span class=\"muted\">(provisional)</span>" : ""}</td>
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
    const aNames = names(match.teamA.playerIds || match.teamA.players?.map((p) => p.id) || []);
    const bNames = names(match.teamB.playerIds || match.teamB.players?.map((p) => p.id) || []);
    return `<article class="match-row">
      <div class="match-side"><strong>${escapeHtml(aNames)}</strong><span class="match-meta">${dateText}</span></div>
      <div class="match-score">${match.scoreA}–${match.scoreB}</div>
      <div class="match-side"><strong>${escapeHtml(bNames)}</strong><span class="match-meta">${escapeHtml(match.modelVersion || "legacy match")}</span></div>
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
  const cleanName = String(name).trim().replace(/\s+/g, " ");
  const normalizedName = normalizePlayerName(cleanName);
  if (cleanName.length < 2 || cleanName.length > 40) throw new Error("Use a name between 2 and 40 characters.");
  if (!/[\p{L}\p{N}]/u.test(cleanName)) throw new Error("The name must contain a letter or number.");

  const id = await playerDocumentId(normalizedName);
  const playerRef = doc(db, "players", id);
  await runTransaction(db, async (transaction) => {
    const existing = await transaction.get(playerRef);
    if (existing.exists()) throw new Error("That player already exists.");
    transaction.set(playerRef, {
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
  const match = { scoreA, scoreB, teamA: teamAIds, teamB: teamBIds };
  validateMatch(match, new Set(byId.keys()));
  await setDoc(matchRef, { ...match, winner: scoreA > scoreB ? "A" : "B", modelVersion: MODEL_VERSION,
    teamA: { playerIds: teamAIds }, teamB: { playerIds: teamBIds }, createdAt: serverTimestamp() });
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

$("#player-form").addEventListener("submit", async (event) => {
  event.preventDefault();
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

$("#match-form").addEventListener("submit", async (event) => {
  event.preventDefault();
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
