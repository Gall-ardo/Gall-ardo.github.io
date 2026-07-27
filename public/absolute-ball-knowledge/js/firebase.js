import {
  firebaseConfig,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
} from "./firebase-config.js";

const params = new URLSearchParams(window.location.search);
// Opt-in only, and only for an affirmative value: ?mock=0 and ?mock=false must keep
// using real Firestore so a stray parameter can never swap the data source out.
const enabled = (key) => {
  const value = params.get(key);
  return value !== null && ["", "1", "true", "yes", "on"].includes(value.trim().toLowerCase());
};
const useMock = enabled("mock");
const useEmulator = enabled("emulator");
const firestore = useMock
  ? await import("./firebase-mock.js")
  : await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js");

let db = null;
if (isFirebaseConfigured) {
  if (useMock) db = firestore.createMockDb();
  else {
    const app = (await import("https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js")).initializeApp(firebaseConfig);
    db = firestore.getFirestore(app);
    // Explicit local-only switch for Firebase Emulator Suite browser checks. It is
    // never enabled by default, so normal deployed visitors still use Firestore.
    if (useEmulator) firestore.connectFirestoreEmulator(db, "127.0.0.1", 8080);
  }
}

const { collection, doc, getDocs, onSnapshot, query, runTransaction, serverTimestamp, where } = firestore;

export {
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
};
