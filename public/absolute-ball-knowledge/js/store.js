import { collection, db, onSnapshot } from "./firebase.js";
import { rebuildFromHistory } from "./rating-model.js";
import { computeRatingHistory } from "./rating-history.js";

/**
 * The shared snapshot both pages render from.
 *
 * Every collection is subscribed whole: there is no `limit()` and no pagination
 * anywhere in this file, because the rating model, the leaderboard, the team
 * generator and the rating history are only correct when they are fitted from the
 * complete recorded history. The main page's "latest 5" is a slice taken at render
 * time (`js/match-list.js`), never a narrower query.
 *
 * Rating history is derived lazily and memoised against `revision`, which changes
 * only when a players or matches snapshot arrives. Re-rendering -- a tab switch, a
 * resize, a button going busy -- reuses the cached fits instead of refitting.
 */
export function createStore() {
  const state = {
    rawPlayers: [], players: [], matches: [], fit: null, pending: new Set(), revision: 0,
  };
  const listeners = new Set();
  let cache = { revision: -1, value: null };
  let onError = () => {};

  const notify = () => { for (const listener of listeners) listener(); };

  /**
   * A match written moments ago carries a null `createdAt` until the server
   * timestamp resolves. It is still listed (as "Saving…"), but it cannot take part
   * in a fit that orders history by time, so it is excluded until it lands.
   */
  const validMatches = () => state.matches.filter((match) => match.createdAt?.toDate instanceof Function);

  function rebuild() {
    try {
      const rebuilt = rebuildFromHistory(state.rawPlayers, validMatches(), { requireTimestamp: true });
      state.players = rebuilt.players;
      state.fit = rebuilt;
    } catch (error) {
      console.error(error);
      onError(`History validation error: ${error.message}`);
    }
  }

  const store = {
    state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    playerById(id) { return state.rawPlayers.find((player) => player.id === id); },
    playerName(id) { return store.playerById(id)?.name || "Unknown player"; },
    matchById(id) { return state.matches.find((match) => match.id === id); },
    isPending(key) { return state.pending.has(key); },
    setPending(key, busy) {
      if (busy) state.pending.add(key); else state.pending.delete(key);
      notify();
    },
    /** Memoised per snapshot: recomputed when players or matches change, never per render. */
    ratingHistory() {
      if (cache.revision !== state.revision) {
        try {
          const value = computeRatingHistory(state.rawPlayers, validMatches(), { requireTimestamp: true });
          cache = { revision: state.revision, value: { ...value, revision: state.revision } };
        } catch (error) {
          console.error(error);
          cache = { revision: state.revision, value: null };
          onError(`Rating history error: ${error.message}`);
        }
      }
      return cache.value;
    },
    start(handlers = {}) {
      onError = handlers.onError ?? onError;
      const fail = (error) => {
        console.error(error);
        handlers.onConnectionError?.(error);
      };
      let playersReady = false;
      let matchesReady = false;
      const ready = () => { if (playersReady && matchesReady) handlers.onLive?.(); };

      onSnapshot(collection(db, "players"), (snapshot) => {
        state.rawPlayers = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
        state.players = state.rawPlayers;
        state.revision += 1;
        rebuild();
        playersReady = true;
        notify();
        ready();
        handlers.onPlayers?.(state.rawPlayers);
      }, fail);

      onSnapshot(collection(db, "matches"), (snapshot) => {
        // Newest first, the exact reverse of the canonical fitting order (createdAt,
        // then document ID). A match whose server timestamp has not resolved yet is
        // the newest thing there is, so it sorts to the top rather than the bottom,
        // where the main page's latest-5 slice would hide it until the write lands.
        const rank = (match) => match.createdAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;
        state.matches = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) => rank(b) - rank(a) || String(b.id).localeCompare(String(a.id)));
        state.revision += 1;
        rebuild();
        matchesReady = true;
        notify();
        ready();
      }, fail);
    },
  };
  return store;
}
