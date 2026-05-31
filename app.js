/**
 * EXAMFORGE — SPA ENGINE (FIREBASE INTEGRATED)
 * Updated with: streak fix, weekly best, accuracy trend, EXA Rating, corrections, 50-result cap, subscriptions tab
 */

import { auth, db } from './firebase-config.js';
import {
    onAuthStateChanged, signOut, sendPasswordResetEmail, reauthenticateWithCredential,
    EmailAuthProvider,
    deleteUser
} from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { collection, collectionGroup, query, orderBy, onSnapshot, getDocs, arrayUnion, arrayRemove, doc, addDoc, getDoc, serverTimestamp, limit, getCountFromServer, updateDoc, where, deleteDoc, setDoc, writeBatch } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { LocalCache } from './cache.js';
import { SyncManager } from './sync.js';

// Global cache and sync instances
let sync = null;
let localCache = null;

// ─── Global Firestore error handler (quota detection) ───
window.addEventListener('unhandledrejection', (event) => {
    const msg = event.reason?.message || event.reason?.code || '';
    if (msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('exhausted') || msg.includes('unavailable')) {
        if (window._showMaintenanceScreen) window._showMaintenanceScreen();
    }
});

document.addEventListener('DOMContentLoaded', () => {

    // ─── DOM refs ────────────────────────────────────────────────
    const html = document.documentElement;
    const sidebar = document.getElementById('sidebar');
    const menuBtn = document.getElementById('menuBtn');
    const overlay = document.getElementById('overlay');
    const workspace = document.getElementById('workspace');
    const globalSearch = document.getElementById('globalSearch');
    const profileBtn = document.getElementById('profileBtn');
    const logoutBtn = document.getElementById('logoutBtn');
    const mobileSearchBtn = document.getElementById('mobileSearchBtn');
    const searchOverlay = document.getElementById('searchOverlay');
    const mobileSearchInput = document.getElementById('mobileSearchInput');
    const bottomNav = document.getElementById('bottomNav');

    // ─── Swipe navigation (mobile only) ──────────────────────────
    const SWIPE_TABS = ['dashboard', 'library', 'subscriptions', 'schedule', 'results', 'inbox'];

    let swipeStartX = 0;
    let swipeStartY = 0;
    let swipeStartTime = 0;

    // These are "consumed" elements that should NOT trigger navigation swipe
    function isSwipableTarget(el) {
        const tag = el.tagName;
        const type = el.type || '';
        // Don't swipe on inputs, textareas, selects, buttons, or interactive elements
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return false;
        if (el.closest('.btn') || el.closest('button') || el.closest('a') || el.closest('input')) return false;
        if (el.closest('.bottom-nav') || el.closest('.bottom-nav-item')) return false;
        // Don't swipe on horizontally scrollable containers (tables, etc.)
        if (el.closest('[style*="overflow-x: auto"]') || el.closest('.table-wrap') || el.closest('.reg-table') || el.closest('.bottom-nav')) return false;
        if (el.closest('.card') && el.closest('.card').querySelector('button, input, a')) return false;
        return true;
    }

    workspace.addEventListener('touchstart', (e) => {
        if (!isSwipableTarget(e.target)) { swipeStartX = 0; return; }
        swipeStartX = e.changedTouches[0].screenX;
        swipeStartY = e.changedTouches[0].screenY;
        swipeStartTime = Date.now();
    }, { passive: true });

    workspace.addEventListener('touchend', (e) => {
        if (!swipeStartX) return;
        const swipeEndX = e.changedTouches[0].screenX;
        const swipeEndY = e.changedTouches[0].screenY;
        const xDiff = swipeEndX - swipeStartX;
        const yDiff = swipeEndY - swipeStartY;
        const duration = Date.now() - swipeStartTime;

        // Must be a deliberate swipe: minimum duration, distance, and horizontal dominance
        if (duration < 150 || Math.abs(xDiff) < 60 || Math.abs(xDiff) < Math.abs(yDiff) * 1.5) {
            swipeStartX = 0;
            return;
        }

        const currentIdx = SWIPE_TABS.indexOf(currentView);
        if (currentIdx === -1) { swipeStartX = 0; return; }

        let targetIdx;
        if (xDiff < 0) targetIdx = currentIdx + 1; // swipe left → next tab
        else targetIdx = currentIdx - 1; // swipe right → previous tab

        if (targetIdx >= 0 && targetIdx < SWIPE_TABS.length) {
            efNavigate(SWIPE_TABS[targetIdx]);
        }

        swipeStartX = 0;
    }, { passive: true });

    // ─── Global Modal Scroll-Lock Helper ────────────────────────
    function setupGlobalModalScrollLock() {
        const hasActiveModal = () => {
            return !!(
                document.querySelector('.mc-modal-overlay') ||
                document.querySelector('[id*="-modal"]') ||
                document.querySelector('[id*="-overlay"]')
            );
        };
        const updateScrollLock = () => {
            if (hasActiveModal()) {
                if (document.body.style.overflow !== 'hidden') {
                    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
                    document.body.style.overflow = 'hidden';
                    document.documentElement.style.overflow = 'hidden';
                    if (scrollbarWidth > 0) {
                        document.body.style.paddingRight = `${scrollbarWidth}px`;
                    }
                }
            } else {
                if (document.body.style.overflow === 'hidden') {
                    document.body.style.overflow = '';
                    document.documentElement.style.overflow = '';
                    document.body.style.paddingRight = '';
                }
            }
        };
        const observer = new MutationObserver(() => {
            updateScrollLock();
        });
        observer.observe(document.body, { childList: true });
        updateScrollLock();
    }
    setupGlobalModalScrollLock();

    // ─── State ───────────────────────────────────────────────────
    let currentView = 'dashboard';
    let libTab = 'university';
    let libQuery = '';
    let uniCourses = [];
    let resultsTab = 'history'; // 'history' | 'subscriptions'

    // Firebase User Data State
    let currentUser = null;
    let userData = {
        results: [],
        schedule: [],
        stats: { streak: 0, highestStreak: 0, rank: 'N/A', lastExamDate: null, exaRating: 800 }
    };

// ─── Throttled cache refresh (prevents stale data without excessive reads) ───
window._lastRefresh = {};
window._throttledRefresh = async function(path, minIntervalMs = 15000) {
    const now = Date.now();
    const last = window._lastRefresh[path];
    if (last && (now - last < minIntervalMs)) return;
    window._lastRefresh[path] = now;
    try { await sync.refresh(path); } catch(e) {}
};

// Real-time dashboard UI update (called by subscriber when user data changes)
window.updateDashboardUI = function() {
    if (currentView !== 'dashboard') return;
    // Update EXA rating display
    const exaEl = document.querySelector('[data-ef-exa]');
    if (exaEl && userData
