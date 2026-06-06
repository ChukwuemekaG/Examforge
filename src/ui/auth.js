import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { auth } from '../../firebase-config.js';
import * as users from '../db/users.js';
import * as counters from '../db/counters.js';
import { getState, setUser, setUserData } from './core.js';

let authInitialized = false;
let authCallbacks = [];

export function onAuthChange(cb) {
  if (authInitialized) cb(getState().currentUser);
  else authCallbacks.push(cb);
}

export async function initAuth() {
  return new Promise((resolve) => {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        setUser(user);
        // Load user data from Turso
        try {
          const userDoc = await users.getUser(user.uid);
          if (userDoc) {
            setUserData({
              displayName: userDoc.display_name || user.displayName,
              email: userDoc.email || user.email,
              username: userDoc.username || '',
              role: userDoc.role || 'student',
              stats: {
                exaRating: userDoc.exa_rating || 800,
                streak: userDoc.streak || 0,
                highestStreak: userDoc.highest_streak || 0,
                lastExamDate: userDoc.last_exam_date || null
              },
              totalUsers: userDoc.total_users || 0
            });
          } else {
            // First time user in Turso — auto-create from Firebase Auth
            try {
              await users.createUser({
                id: user.uid,
                email: user.email || '',
                displayName: user.displayName || '',
                provider: 'firebase',
                exaRating: 800,
                role: 'student'
              });
              console.log('[Auth] Created Turso user for:', user.uid);
              // Set default data
              setUserData({
                displayName: user.displayName || '',
                email: user.email || '',
                role: 'student',
                stats: { exaRating: 800, streak: 0, highestStreak: 0, lastExamDate: null },
                totalUsers: 0
              });
            } catch (createErr) {
              console.warn('[Auth] Could not create Turso user:', createErr);
              setUserData({
                displayName: user.displayName || '',
                email: user.email || '',
                role: 'student',
                stats: { exaRating: 800, streak: 0, highestStreak: 0, lastExamDate: null },
                totalUsers: 0
              });
            }
          }
          // Load recent results, inbox, schedule
          const results = await users.getRecentResults(user.uid);
          const inbox = await users.getInboxItems(user.uid);
          const schedule = await users.getScheduleItems(user.uid);
          const state = getState();
          state.userData.results = results.map(r => ({
            id: r.id, quizId: r.quiz_id, course: r.course, date: r.created_at,
            score: r.score, total: r.total, grade: r.grade, correct: r.correct,
            totalQuestions: r.total_questions, timeTaken: r.time_taken,
            exaChange: r.exa_change, isRetake: r.is_retake === 1, isMock: r.is_mock === 1,
            corrections: JSON.parse(r.corrections || '[]')
          }));
          state.userData.inbox = inbox;
          state.userData.schedule = schedule;
        } catch (e) {
          console.error('Failed to load user data:', e);
        }
      } else {
        setUser(null);
      }
      
      authInitialized = true;
      authCallbacks.forEach(cb => cb(user));
      authCallbacks = [];
      resolve(user);
    });
  });
}

export async function logout() {
  await signOut(auth);
  window.location.href = '/login.html';
}

export function isAdmin() {
  return getState().userData?.role === 'admin';
}
