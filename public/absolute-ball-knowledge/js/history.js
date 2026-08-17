import { isFirebaseConfigured, missingFirebaseConfigKeys } from "./firebase.js";
import { createStore } from "./store.js";
import { renderMatchList } from "./match-list.js";
import { mountMatchAdmin } from "./match-admin.js";
import { $, createMessage, linkLocalMode } from "./ui.js";

/**
 * The complete match history page. It subscribes to the same store as the main app
 * and renders every match newest-first, with the same rows, the same editor and the
 * same delete confirmation. Nothing here slices or pages the list.
 */
const store = createStore();
const connectionStatus = $("#connection-status");
const showMessage = createMessage($("#global-message"));
const matchAdmin = mountMatchAdmin({ store, showMessage });
const list = $("#full-history");
linkLocalMode();

function render() {
  renderMatchList(list, store.state.matches, {
    nameFor: (id) => store.playerName(id),
    isPending: (key) => store.isPending(key),
  });
  const total = store.state.matches.length;
  $("#history-count").textContent = total === 1 ? "1 match recorded" : `${total} matches recorded`;
}

list.addEventListener("click", matchAdmin.handleListClick);
store.subscribe(render);

if (!isFirebaseConfigured) {
  connectionStatus.textContent = "Setup required";
  connectionStatus.className = "connection-status is-error";
  showMessage(
    `Firebase configuration is incomplete. Add ${missingFirebaseConfigKeys.join(", ")} to js/firebase-config.js; setup details are in README.md.`,
    "error",
  );
  render();
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
