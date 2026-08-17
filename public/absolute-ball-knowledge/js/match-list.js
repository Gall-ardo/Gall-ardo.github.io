import { escapeHtml } from "./ui.js";

/**
 * How many matches the main page renders. It is a render-time slice of the complete
 * history the store already holds -- never a query limit -- so the leaderboard, the
 * team generator and the rating history keep fitting from every recorded match.
 */
export const MAIN_PAGE_MATCH_LIMIT = 5;

export function matchIds(match, side) {
  const team = match[side];
  return Array.isArray(team) ? team : team?.playerIds || team?.players?.map((player) => player.id) || [];
}

const dateTimeFormat = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });
export function matchDate(match) {
  return match.createdAt?.toDate instanceof Function ? match.createdAt.toDate() : null;
}
export function matchDateText(match) {
  const date = matchDate(match);
  return date ? dateTimeFormat.format(date) : "Saving…";
}

/** "Alex, Casey 10–5 Blair" — used for the delete confirmation copy. */
export function matchSummary(match, nameFor) {
  const names = (ids) => ids.map(nameFor).join(", ");
  return `${names(matchIds(match, "teamA"))} ${match.scoreA}–${match.scoreB} ${names(matchIds(match, "teamB"))}`;
}

/**
 * The one match-row renderer. The main page passes the latest five, the history page
 * passes all of them, and both get identical markup, actions and mobile layout.
 */
export function renderMatchList(container, matches, { nameFor, isPending = () => false, emptyText = "No matches recorded yet." } = {}) {
  if (!matches.length) {
    container.innerHTML = `<div class="empty-state">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const names = (ids) => ids.map(nameFor).join(", ");
  container.innerHTML = matches.map((match) => {
    const busy = isPending(`match:${match.id}`) ? "disabled" : "";
    return `<article class="match-row" data-match-id="${escapeHtml(match.id)}">
      <div class="match-side"><strong>${escapeHtml(names(matchIds(match, "teamA")))}</strong><span class="match-meta">${escapeHtml(matchDateText(match))}</span></div>
      <div class="match-score">${match.scoreA}–${match.scoreB}</div>
      <div class="match-side"><strong>${escapeHtml(names(matchIds(match, "teamB")))}</strong><span class="match-meta">${escapeHtml(match.modelVersion || "legacy match")}</span></div>
      <div class="match-actions row-actions"><button class="text-action" type="button" data-edit-match="${escapeHtml(match.id)}" ${busy}>Edit</button><button class="text-action is-danger" type="button" data-delete-match="${escapeHtml(match.id)}" ${busy}>Delete</button></div>
    </article>`;
  }).join("");
}
