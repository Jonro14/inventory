// Firebase web configuration.
//
// Paste here the block Firebase shows you in:
//   Firebase console -> Project settings -> General -> Your apps -> Web app -> "SDK setup and configuration" -> Config
//
// While apiKey is left as "PASTE_HERE" the app runs in DEMO mode:
// everything works, but the data stays only in this browser (no sync).
//
// This config is not a secret (it is visible to anyone who opens the app).
// Your data is protected by the Firestore security rules (firestore.rules) and the login.

export const firebaseConfig = {
  apiKey: "AIzaSyCxHandYuaK93E9vhbEat98bNrefwBhvZU",
  authDomain: "home-inventory-xsj.firebaseapp.com",
  projectId: "home-inventory-xsj",
  storageBucket: "home-inventory-xsj.firebasestorage.app",
  messagingSenderId: "347391623184",
  appId: "1:347391623184:web:e2e9670f611f61b3184a95"
};

// All data lives under /homes/<HOME_ID>/... in Firestore. Leave as is.
export const HOME_ID = "main";
