// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDj63mPMog4eXIdNBcUalkipaxcA090Rik",
  authDomain: "examforge.com.ng",
  projectId: "examforgetest",
  storageBucket: "examforgetest.firebasestorage.app",
  messagingSenderId: "676042786985",
  appId: "1:676042786985:web:1d69719ed17cd03f9b41b8",
  measurementId: "G-G4FXC8KDT2"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
// Explicitly target the "default" database, just like Pormaro
export const db = getFirestore(app, "default");