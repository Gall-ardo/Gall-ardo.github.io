import { db, firestoreApi } from "./firestore-api.js";
import { deleteMatch, documentVersion, editMatch } from "./mutations.js";
import { matchIds, matchSummary } from "./match-list.js";
import { $, $$, escapeHtml, onSubmit, setBusy } from "./ui.js";

/**
 * Editing and deleting a match, mounted by whichever page shows a match list.
 *
 * The dialogs are created here rather than written into both pages' HTML: the main
 * page and the history page must offer exactly the same editor, and a second copy
 * of this markup would be free to drift out of step with the fields the update path
 * and the security rules agree on.
 */
const DIALOGS = `
<dialog id="edit-match-dialog">
  <form id="edit-match-form">
    <div class="dialog-heading">
      <div>
        <p class="eyebrow">Correct a result</p>
        <h2>Edit match</h2>
      </div>
      <button id="close-edit-match-dialog" class="icon-button" type="button" aria-label="Close">×</button>
    </div>
    <div class="team-grid edit-team-grid">
      <fieldset class="team-card team-a">
        <legend>Team A</legend>
        <label class="score-label" for="edit-score-a">Score</label>
        <input id="edit-score-a" class="score-input" type="number" min="0" step="1" inputmode="numeric" required>
        <div id="edit-match-a-options" class="player-options" aria-label="Edit Team A players"></div>
      </fieldset>
      <fieldset class="team-card team-b">
        <legend>Team B</legend>
        <label class="score-label" for="edit-score-b">Score</label>
        <input id="edit-score-b" class="score-input" type="number" min="0" step="1" inputmode="numeric" required>
        <div id="edit-match-b-options" class="player-options" aria-label="Edit Team B players"></div>
      </fieldset>
    </div>
    <p class="field-help">Saving keeps this match’s ID and original recorded time, then rebuilds all ratings and statistics from complete match history.</p>
    <button id="save-match-edit" class="button button-primary button-wide" type="submit">Save match changes</button>
  </form>
</dialog>
<dialog id="delete-match-dialog">
  <form id="delete-match-form">
    <div class="dialog-heading"><div><p class="eyebrow">Permanent action</p><h2>Delete match?</h2></div></div>
    <p id="delete-match-copy"></p>
    <p class="field-help">All ratings and statistics will be recalculated from the remaining complete match history.</p>
    <div class="dialog-actions"><button id="cancel-delete-match" class="button button-secondary" type="button">Cancel</button><button id="confirm-delete-match" class="button button-danger" type="submit">Delete match</button></div>
  </form>
</dialog>`;

export function mountMatchAdmin({ store, showMessage }) {
  if (!$("#edit-match-dialog")) document.body.insertAdjacentHTML("beforeend", DIALOGS);
  let editing = null;
  let deleting = null;

  function renderEditor(match) {
    const a = new Set(matchIds(match, "teamA"));
    const b = new Set(matchIds(match, "teamB"));
    const options = store.state.players.slice().sort((left, right) => left.name.localeCompare(right.name));
    const option = (player, side) => `<label class="check-option"><input type="checkbox" data-edit-side="${side}" data-edit-player-id="${escapeHtml(player.id)}" ${(side === "a" ? a : b).has(player.id) ? "checked" : ""}><span>${escapeHtml(player.name)}</span><small>${player.rating}</small></label>`;
    $("#edit-match-a-options").innerHTML = options.map((player) => option(player, "a")).join("");
    $("#edit-match-b-options").innerHTML = options.map((player) => option(player, "b")).join("");
    $("#edit-score-a").value = match.scoreA;
    $("#edit-score-b").value = match.scoreB;
  }

  function openEditor(match) {
    editing = match;
    renderEditor(match);
    $("#edit-match-dialog").showModal();
  }

  function openDelete(match) {
    deleting = match;
    $("#delete-match-copy").textContent = `Delete ${matchSummary(match, (id) => store.playerName(id))}?`;
    $("#delete-match-dialog").showModal();
  }

  $("#close-edit-match-dialog").addEventListener("click", () => $("#edit-match-dialog").close());
  $("#edit-match-dialog").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-edit-player-id]");
    if (!checkbox || !checkbox.checked) return;
    const other = checkbox.dataset.editSide === "a" ? "b" : "a";
    $$(`[data-edit-side="${other}"][data-edit-player-id="${checkbox.dataset.editPlayerId}"]`).forEach((item) => { item.checked = false; });
  });
  onSubmit("edit-match-form", async () => {
    const match = editing;
    if (!match) return;
    const key = `match:${match.id}`;
    const button = $("#save-match-edit");
    setBusy(button, true, "Saving…"); store.setPending(key, true);
    try {
      const teamA = $$('[data-edit-side="a"]:checked').map((item) => item.dataset.editPlayerId);
      const teamB = $$('[data-edit-side="b"]:checked').map((item) => item.dataset.editPlayerId);
      await editMatch({ api: firestoreApi, db, matchId: match.id, expectedVersion: documentVersion(match), input: { teamA, teamB, scoreA: $("#edit-score-a").value, scoreB: $("#edit-score-b").value } });
      $("#edit-match-dialog").close();
      showMessage("Match updated. Ratings and statistics have been rebuilt from complete history.");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false); store.setPending(key, false);
    }
  });

  $("#cancel-delete-match").addEventListener("click", () => $("#delete-match-dialog").close());
  onSubmit("delete-match-form", async () => {
    const match = deleting;
    if (!match) return;
    const key = `match:${match.id}`;
    const button = $("#confirm-delete-match");
    setBusy(button, true, "Deleting…"); store.setPending(key, true);
    try {
      await deleteMatch({ api: firestoreApi, db, matchId: match.id, expectedVersion: documentVersion(match) });
      $("#delete-match-dialog").close();
      showMessage("Match deleted. All ratings and statistics have been rebuilt from remaining history.");
    } catch (error) {
      showMessage(error.message, "error");
    } finally {
      setBusy(button, false); store.setPending(key, false);
    }
  });

  /** Delegated handler for any container rendered by `renderMatchList`. */
  function handleListClick(event) {
    const edit = event.target.closest("[data-edit-match]");
    const remove = event.target.closest("[data-delete-match]");
    if (!edit && !remove) return;
    const match = store.matchById(edit ? edit.dataset.editMatch : remove.dataset.deleteMatch);
    if (!match) return showMessage("This match was already deleted by another browser.", "error");
    if (edit) openEditor(match); else openDelete(match);
  }

  return { openEditor, openDelete, handleListClick };
}
