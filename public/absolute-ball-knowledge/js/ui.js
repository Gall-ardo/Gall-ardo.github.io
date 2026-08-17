/** DOM helpers shared by every page in the app. No page-specific state lives here. */
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

/** Binds the banner element of one page; every page owns exactly one #global-message. */
export function createMessage(element) {
  let timer;
  return function showMessage(text, type = "success") {
    element.textContent = text;
    element.className = `message ${type === "error" ? "is-error" : ""}`;
    element.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => { element.hidden = true; }, 6500);
  };
}

export function setBusy(button, busy, busyLabel) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.label;
}

/**
 * The local-testing switches, carried across in-app links.
 *
 * `js/firebase.js` chooses its data source from the URL, so a plain link from the
 * app to the history page would drop `?mock=1` or `?emulator=1` and quietly send
 * that page to real Firestore. Only these two keys travel; nothing else is copied.
 */
export function localModeQuery(search = window.location.search) {
  const params = new URLSearchParams(search);
  const carried = new URLSearchParams();
  for (const key of ["mock", "emulator"]) if (params.has(key)) carried.set(key, params.get(key));
  const text = carried.toString();
  return text ? `?${text}` : "";
}

/** Rewrites every in-app link so the switches above survive the navigation. */
export function linkLocalMode(root = document) {
  const query = localModeQuery();
  if (!query) return;
  for (const link of $$("[data-app-link]", root)) link.href = `${link.getAttribute("href").split("?")[0]}${query}`;
}

/**
 * A form submitted again before its first write settles would send the second
 * request with the version it read before the first one landed, and report the
 * user's own change back as somebody else's conflict. Re-entrant submits are
 * dropped rather than queued.
 */
const submitting = new Set();
export function onSubmit(formId, handler) {
  $(`#${formId}`).addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitting.has(formId)) return;
    submitting.add(formId);
    try { await handler(event); } finally { submitting.delete(formId); }
  });
}
