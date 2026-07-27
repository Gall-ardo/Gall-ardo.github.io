// Firebase Web configuration is public by design. Do not put service-account
// keys, Admin SDK credentials, or other secrets in this browser-side file.
// Copy the values from:
// Firebase console → Project settings → Your apps → Web app → SDK setup.

// Your web app's Firebase configuration
export const firebaseConfig = {
  apiKey: "AIzaSyBqUDF1bxKtHGnoIzgtMJP7EZO_-4ORYnE",
  authDomain: "absolute-ball-knowledge.firebaseapp.com",
  projectId: "absolute-ball-knowledge",
  storageBucket: "absolute-ball-knowledge.firebasestorage.app",
  messagingSenderId: "851114090633",
  appId: "1:851114090633:web:df9db578faaaa98d60e658"
};

const requiredFirebaseConfigKeys = [
  "apiKey",
  "authDomain",
  "projectId",
  "messagingSenderId",
  "appId",
];

const placeholderPattern = /^(?:PASTE_|YOUR_|REPLACE_|<)|placeholder/i;

export const missingFirebaseConfigKeys = requiredFirebaseConfigKeys.filter((key) => {
  const value = firebaseConfig[key];
  return typeof value !== "string" || value.trim() === "" || placeholderPattern.test(value.trim());
});

export const isFirebaseConfigured = missingFirebaseConfigKeys.length === 0;
