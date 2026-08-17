import {
  collection,
  db,
  doc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
} from "./firebase.js";

/** The single Firestore surface `js/mutations.js` is called with, on every page. */
export const firestoreApi = { collection, doc, getDocs, query, runTransaction, serverTimestamp, where };
export { db };
