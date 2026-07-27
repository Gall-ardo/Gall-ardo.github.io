import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  collection,
  doc,
  getFirestore,
  onSnapshot,
  runTransaction,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import {
  firebaseConfig,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
} from "./firebase-config.js";

let db = null;
if (isFirebaseConfigured) {
  db = getFirestore(initializeApp(firebaseConfig));
}

export {
  collection,
  db,
  doc,
  isFirebaseConfigured,
  missingFirebaseConfigKeys,
  onSnapshot,
  runTransaction,
  setDoc,
  serverTimestamp,
};
