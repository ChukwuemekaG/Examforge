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

// ─── Quota-exceeded maintenance screen ───
window._showMaintenanceScreen = function() {
    if (document.getElementById('ef-maintenance-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'ef-maintenance-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999999;padding:24px;gap:16px;';
    overlay.innerHTML = `
        <div style="width:80px;height:80px;border-radius:50%;background:rgba(254,105,97,0.1);display:flex;align-items:center;justify-content:center;">
            <span class="material-icons-round" style="font-size:2.4rem;color:#fe6961;">construction</span>
        </div>
        <div style="font-size:1.4rem;font-weight:900;color:var(--text);text-align:center;">Under Maintenance</div>
        <div style="font-size:0.85rem;color:var(--text-muted);text-align:center;max-width:360px;line-height:1.5;">ExamForge is currently under maintenance. We'll be back shortly. Thank you for your patience.</div>
    `;
    document.body.appendChild(overlay);
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
    if (exaEl && userData.stats) {
        exaEl.textContent = userData.stats.exaRating ?? 800;
    }
    // Update streak display
    const streakEl = document.querySelector('[data-ef-streak]');
    if (streakEl && userData.stats) {
        streakEl.textContent = userData.stats.streak ?? 0;
    }
    // Update highest streak
    const highStreakEl = document.querySelector('[data-ef-high-streak]');
    if (highStreakEl && userData.stats) {
        highStreakEl.textContent = userData.stats.highestStreak ?? 0;
    }
};

    // ─── Mock course data (Fallback for Library) ─────────
    const MOCK_COURSES = [
        { codes: ['MTH101'], title: 'Elementary Mathematics I', level: '100L', description: 'Foundations of algebra, sets, number theory, and introductory calculus for science students.', link: '?json=mth101.json' },
        { codes: ['PHY101'], title: 'General Physics I', level: '100L', description: 'Mechanics, motion, forces, energy, waves, and thermodynamics with problem solving focus.', link: '?json=phy101.json' },
        { codes: ['CHM101'], title: 'General Chemistry I', level: '100L', description: 'Atomic structure, bonding, stoichiometry, and states of matter for first-year students.', link: '?json=chm101.json' },
        { codes: ['CSC201'], title: 'Data Structures & Algorithms', level: '200L', description: 'Arrays, linked lists, stacks, queues, trees, graphs, sorting, and algorithm complexity.', link: '?json=csc201.json' },
        { codes: ['MTH201'], title: 'Mathematical Methods', level: '200L', description: 'Differential equations, vector calculus, linear algebra, and complex analysis techniques.', link: '?json=mth201.json' },
        { codes: ['ENG301'], title: 'Engineering Thermodynamics', level: '300L', description: 'Laws of thermodynamics, entropy, cycles, refrigeration, and combustion processes.', link: '?json=eng301.json' },
        { codes: ['BIO201'], title: 'Cell Biology & Genetics', level: '200L', description: 'Cell structure, DNA replication, gene expression, heredity, and biotechnology applications.', link: '?json=bio201.json' },
        { codes: ['ACC301'], title: 'Financial Accounting II', level: '300L', description: 'Advanced financial statements, partnership accounts, company accounts, and auditing basics.', link: '?json=acc301.json' },
        { codes: ['LAW201'], title: 'Law of Contract', level: '200L', description: 'Offer, acceptance, consideration, capacity, legality, and remedies in contract law.', link: '?json=law201.json' },
        { codes: ['ECO101'], title: 'Principles of Economics', level: '100L', description: 'Microeconomics and macroeconomics fundamentals, supply and demand, national income.', link: '?json=eco101.json' },
        { codes: ['CSC301'], title: 'Database Management Systems', level: '300L', description: 'Relational model, SQL, normalization, transactions, indexing, and database design.', link: '?json=csc301.json' },
        { codes: ['STA301'], title: 'Probability & Statistics', level: '300L', description: 'Probability distributions, hypothesis testing, regression analysis, and statistical inference.', link: '?json=sta301.json' },
    ];
    function renderLoading(message = " ") {
        workspace.innerHTML = `
    <div class="loader-container">
        <div class="dot-loader">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
        </div>
        <div class="loader-text">${message}</div>
    </div>
    `;
    }
    async function loadCourseBrowser() {
    const coursesListDiv = document.getElementById("courses-list");
    coursesListDiv.innerHTML = "<p>Loading courses...</p>";

    try {
        const courses = (await sync.collection('unicourses')) || [];
        coursesListDiv.innerHTML = ""; // Clear loading text

        // Loop through each course
        for (const courseData of courses) {
            const courseId = courseData.id;

            // Create Course Element
            const courseDiv = document.createElement("div");
            courseDiv.className = "course-card";
            courseDiv.innerHTML = `<h3>${courseData.title} (${courseId.toUpperCase()})</h3><ul id="topics-${courseId}">Loading topics...</ul>`;
            coursesListDiv.appendChild(courseDiv);

            // Fetch Topics for this specific course
            const topics = (await sync.collection('unicourses/' + courseId + '/topics')) || [];
            const topicsList = document.getElementById(`topics-${courseId}`);
            topicsList.innerHTML = ""; // Clear loading text

            if (!topics.length) {
                topicsList.innerHTML = "<li>No topics added yet.</li>";
            } else {
                topics.forEach((topicData) => {
                    const li = document.createElement("li");
                    li.innerHTML = `
                        <strong>${topicData.id.replace('-', ' ').toUpperCase()}</strong> 
                        - ${topicData.questions ? topicData.questions.length : 0} Questions 
                        <button onclick="startQuiz('${courseId}', '${topicData.id}')">Start Quiz</button>
                    `;
                    topicsList.appendChild(li);
                });
            }
        }
    } catch (error) {
        console.error("Error loading courses: ", error);
        coursesListDiv.innerHTML = "<p>Failed to load courses.</p>";
    }
}

// Call this when the user navigates to the "Browse" section
// Add this function somewhere in your app.js
function setupAdminListeners() {
    const btnAddCourse = document.getElementById("btn-add-course");
    const btnAddTopic = document.getElementById("btn-add-topic");
    const btnAddQuestion = document.getElementById("btn-add-question");

    // Safety check: If these buttons aren't on the screen right now, do nothing.
    if (!btnAddCourse || !btnAddTopic || !btnAddQuestion) return;

    // --- 1. ADD COURSE ---
    btnAddCourse.addEventListener("click", async () => {
        const courseId = document.getElementById("new-course-id").value.toLowerCase().trim();
        const courseTitle = document.getElementById("new-course-title").value;

        if (!courseId || !courseTitle) return alert("Please fill all fields.");

        try {
            await setDoc(doc(db, "unicourses", courseId), {
                title: courseTitle,
                createdAt: new Date()
            });
            alert(`Course ${courseId} added!`);
            loadCourseBrowser(); 
        } catch (e) {
            console.error(e);
            alert("Error adding course.");
        }
    });

    // --- 2. ADD TOPIC ---
    btnAddTopic.addEventListener("click", async () => {
        const courseId = document.getElementById("select-course-for-topic").value; 
        const topicId = document.getElementById("new-topic-id").value.toLowerCase().trim();
        const timeLimit = parseInt(document.getElementById("new-topic-time").value);

        if (!courseId || !topicId || !timeLimit) return alert("Please fill all fields.");

        try {
            await setDoc(doc(db, "unicourses", courseId, "topics", topicId), {
                timeLimit: timeLimit,
                questions: [] 
            });
            alert(`Topic ${topicId} added to ${courseId}!`);
            loadCourseBrowser();
        } catch (e) {
            console.error(e);
        }
    });

    // --- 3. ADD QUESTION TO TOPIC ---
    btnAddQuestion.addEventListener("click", async () => {
        const courseId = document.getElementById("select-topic-for-question").value; // Needs to be dynamic later
        const topicId = "complex-numbers"; // Needs to be dynamic later
        
        const questionText = document.getElementById("new-question-text").value;
        const options = [
            document.getElementById("opt-0").value,
            document.getElementById("opt-1").value,
            document.getElementById("opt-2").value,
            document.getElementById("opt-3").value
        ];
        const correctIndex = parseInt(document.getElementById("correct-index").value);
        const explanation = document.getElementById("explanation").value;

        const newQuestion = {
            id: Date.now(), 
            question: questionText,
            options: options,
            correctIndex: correctIndex,
            explanation: explanation
        };

        try {
            const topicRef = doc(db, "unicourses", courseId, "topics", topicId);
            await updateDoc(topicRef, { questions: arrayUnion(newQuestion) });
            alert("Question added successfully!");
        } catch (e) {
            console.error(e);
            alert("Error adding question.");
        }
    });
}
    async function getNationalRanking(userRating) {
        try {
            const { collection, query, where, getCountFromServer } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
            const [higherSnap, totalSnap] = await Promise.all([
                getCountFromServer(query(collection(db, 'users'), where('exaRating', '>', userRating))),
                getCountFromServer(collection(db, 'users'))
            ]);
            const higherCount = higherSnap.data().count;
            const totalUsers = totalSnap.data().count;
            const exactRank = higherCount + 1;
            const displayTotal = Math.max(totalUsers, exactRank);
            let percentile = exactRank === 1 ? 1 : Math.floor((exactRank / displayTotal) * 100);
            return { rank: exactRank, total: displayTotal, percentile };
        } catch (error) {
            console.error("Ranking Error:", error);
            return { rank: '-', total: '-', percentile: 100 };
        }
    }

    const MOCK_TOPICS = {
        default: [
            { title: 'Introduction & Fundamentals', description: 'Core definitions, scope, and foundational principles of the course.' },
            { title: 'Core Theory', description: 'Theoretical framework, major concepts, and analytical methods.' },
            { title: 'Applied Practice', description: 'Problem-solving techniques, worked examples, and case studies.' },
            { title: 'Advanced Topics', description: 'Extended concepts, edge cases, and examination-level challenges.' },
        ]
    };

    const EXA_TITLES = [
        { min: 0, max: 899, roman: 'I', name: 'New Recruit', icon: 'person' },
        { min: 900, max: 1099, roman: 'II', name: 'Apprentice', icon: 'person_outline' },
        { min: 1100, max: 1249, roman: 'III', name: 'Good Student', icon: 'school' },
        { min: 1250, max: 1399, roman: 'IV', name: 'Scholar', icon: 'auto_stories' },
        { min: 1400, max: 1549, roman: 'V', name: 'Scholar Elite', icon: 'military_tech' },
        { min: 1550, max: 1699, roman: 'VI', name: 'Prodigy', icon: 'star' },
        { min: 1700, max: 1849, roman: 'VII', name: 'Prodigy Supreme', icon: 'stars' },
        { min: 1850, max: 1999, roman: 'VIII', name: 'Genius', icon: 'workspace_premium' },
        { min: 2000, max: 2199, roman: 'IX', name: 'Apex Scholar', icon: 'diamond' },
        { min: 2200, max: 9999, roman: 'X', name: 'Examforge Legend', icon: 'emoji_events' },
    ];

    function getExaTitle(rating) {
        return EXA_TITLES.find(t => rating >= t.min && rating <= t.max) || EXA_TITLES[0];
    }

    // ─── Streak Logic ─────────────────────────────────────────────
    /**
     * Validates whether the streak stored in Firebase is still valid.
     * A streak is valid if the lastExamDate was today OR yesterday.
     * If it's older than yesterday, the streak has been broken.
     */
    function computeStreakDisplay(stats) {
        const lastDateStr = stats.lastExamDate; // expected format: 'YYYY-MM-DD'
        if (!lastDateStr) return { streak: 0, broken: true };

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        const lastDate = new Date(lastDateStr);
        lastDate.setHours(0, 0, 0, 0);

        const isAlive = lastDate >= yesterday;
        return {
            streak: isAlive ? (stats.streak || 0) : 0,
            broken: !isAlive
        };
    }

    // ─── Weekly Best ──────────────────────────────────────────────
    function getWeeklyBest(results) {
        const now = new Date();
        const startOfWeek = new Date(now);
        // Sunday as start of week
        startOfWeek.setDate(now.getDate() - now.getDay());
        startOfWeek.setHours(0, 0, 0, 0);

        const thisWeek = results.filter(r => {
            if (!r.timestamp) return false;
            const d = r.timestamp.toDate ? r.timestamp.toDate() : new Date(r.timestamp);
            return d >= startOfWeek;
        });

        if (thisWeek.length === 0) return { score: null, course: null };
        const best = thisWeek.reduce((max, r) => r.score > max.score ? r : max, thisWeek[0]);
        return { score: best.score, course: best.course ? best.course.split('—')[0].trim() : 'N/A' };
    }

    // ─── Accuracy Trend ──────────────────────────────────────────
    /**
     * Compares last exam accuracy to the previous exam.
     * Returns: { direction: 'up'|'down'|'flat', delta: number, lastScore: number }
     */
    function getAccuracyTrend(results) {
        if (results.length === 0) return { direction: 'flat', delta: 0, lastScore: 0 };
        if (results.length === 1) return { direction: 'flat', delta: 0, lastScore: results[0].score };
        const last = results[0].score;
        const prev = results[1].score;
        const delta = last - prev;
        return {
            direction: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
            delta: Math.abs(delta),
            lastScore: last
        };
    }

    // Variable to store the unsubscribe function so we can clean up if needed
    let userListenerUnsubscribe = null;

    // --- UPDATED AUTH STATE LISTENER ---
    // --- UPDATED AUTH LISTENER in app.js ---
    // ── Auth guard ─────────────────────────────────────────────────
    // authStateReady() resolves AFTER Firebase has finished reading the
    // persisted session from IndexedDB. This means we never redirect while
    // Firebase is still restoring — which is exactly what breaks Google popup.
    // onAuthStateChanged still handles all the app initialisation below.
    const isLoginPage = ['/', '/index.html', '/login.html'].includes(window.location.pathname);
    if (!isLoginPage) {
        auth.authStateReady().then(() => {
            if (!auth.currentUser) window.location.replace('/');
        });
    }

    onAuthStateChanged(auth, async (user) => {
        if (user) {
            currentUser = user;
            localStorage.setItem('ef_logged_in', 'true');
            updateUIWithUserProfile(user);
            renderLoading(" ");

            const userDocRef = doc(db, "users", user.uid);
            try {
                // Initialize sync manager for cache-first access
                sync = new SyncManager(db);

                const provider = user.providerData[0]?.providerId || 'password';

                // Cache-first user document access
                const userDataFromSync = await sync.doc('users/' + user.uid);

                // Immediately populate userData if user doc exists
                if (userDataFromSync) {
                    userData.stats = {
                        exaRating: userDataFromSync.exaRating ?? 800,
                        streak: userDataFromSync.streak ?? 0,
                        highestStreak: userDataFromSync.highestStreak ?? 0,
                        lastExamDate: userDataFromSync.lastExamDate || null,
                        role: userDataFromSync.role || 'student'
                    };
                    userData.recentResults = userDataFromSync.recentResults || [];
                    // Show admin nav if user is admin
                    const masterNav = document.getElementById('nav-master');
                    if (masterNav) {
                        masterNav.style.display = (userDataFromSync.role === 'admin') ? '' : 'none';
                    }
                    const masterNavBottom = document.getElementById('nav-master-bottom');
                    if (masterNavBottom) {
                        masterNavBottom.style.display = (userDataFromSync.role === 'admin') ? 'flex' : 'none';
                    }
                }

                if (!userDataFromSync) {
                    const uniqueUsername = await generateUniqueUsername(user.email, user.displayName);
                    await setDoc(userDocRef, {
                        email: user.email.toLowerCase(),
                        displayName: user.displayName || uniqueUsername,
                        username: uniqueUsername,
                        provider: provider,
                        exaRating: 800,
                        streak: 0,
                        highestStreak: 0,
                        createdAt: serverTimestamp(),
                        role: 'student'
                    });
                }

                // Subscribe to user data changes (read from cache, periodic refresh)
                const refreshUserData = (data) => {
                    if (!data) return;
                    userData.stats = {
                        ...userData.stats,
                        exaRating: data.exaRating ?? 800,
                        streak: data.streak ?? 0,
                        highestStreak: data.highestStreak ?? 0,
                        lastExamDate: data.lastExamDate || null,
                        role: data.role || 'student'
                    };
                    userData.recentResults = data.recentResults || [];
                    // Show admin nav if user is admin
                    const masterNav = document.getElementById('nav-master');
                    if (masterNav) {
                        masterNav.style.display = (data.role === 'admin') ? '' : 'none';
                    }
                    const masterNavBottom = document.getElementById('nav-master-bottom');
                    if (masterNavBottom) {
                        masterNavBottom.style.display = (data.role === 'admin') ? 'flex' : 'none';
                    }
                    // Override with latest quiz result from localStorage if available
                    try {
                        const lastExa = JSON.parse(localStorage.getItem('ef_last_exa'));
                        if (lastExa && lastExa.exaRating && Date.now() - lastExa.timestamp < 120000) {
                            if (lastExa.exaRating > (data.exaRating || 0)) {
                                userData.stats.exaRating = lastExa.exaRating;
                            }
                            localStorage.removeItem('ef_last_exa');
                        }
                    } catch(e) {}
                    // Refresh UI if on dashboard
                    if (typeof updateDashboardUI === 'function') updateDashboardUI();
                };

                // Initial load from cache
                sync.subscribe('users/' + user.uid, refreshUserData);

                // ─── One-time migration: copy old subcollection results to recentResults ───
                if (userData.recentResults && userData.recentResults.length === 0) {
                    (async () => {
                        try {
                            const oldResults = await sync.query('users/' + user.uid + '/results', [
                                orderBy('timestamp', 'desc'),
                                limit(50)
                            ]);
                            if (oldResults && oldResults.length > 0) {
                                const migrated = oldResults.map(r => ({
                                    id: r.id || Date.now().toString(36),
                                    quizId: r.quizId || '',
                                    course: r.course || 'Exam',
                                    date: r.date || new Date(r.timestamp?.toMillis?.() || Date.now()).toLocaleDateString(),
                                    score: r.score || 0,
                                    total: r.total || 100,
                                    grade: r.grade || 'F',
                                    correct: r.correct || 0,
                                    totalQuestions: r.totalQuestions || 0,
                                    timeTaken: r.timeTaken || 0,
                                    exaChange: r.exaChange || 0,
                                    isRetake: r.isRetake || false,
                                    corrections: r.corrections || [],
                                    isMock: r.isMock || false
                                }));
                                // Write migrated results to user doc (1 write, one-time cost)
                                await setDoc(doc(db, 'users', user.uid), { recentResults: migrated }, { merge: true });
                                // Update local state
                                userData.recentResults = migrated;
                                // Refresh UI
                                if (typeof updateDashboardUI === 'function') updateDashboardUI();
                            }
                        } catch(e) { console.error('Migration check error:', e); }
                    })();
                }

                // ─── Offline banner (non-intrusive, no scroll interference) ───
                if (!document.getElementById('ef-offline-banner')) {
                    const banner = document.createElement('div');
                    banner.id = 'ef-offline-banner';
                    banner.style.cssText = 'position:fixed;bottom:0;left:0;right:0;background:#dc2626;color:#fff;display:none;align-items:center;justify-content:center;gap:8px;padding:8px 16px;font-size:0.75rem;font-weight:700;z-index:9999;text-align:center;';
                    banner.innerHTML = '<span class="material-icons-round" style="font-size:1rem;">wifi_off</span> You are offline — some features may be limited';
                    document.body.appendChild(banner);

                    const showBanner = (show) => { banner.style.display = show ? 'flex' : 'none'; };

                    setTimeout(() => { if (!navigator.onLine) showBanner(true); }, 3000);

                    window.addEventListener('offline', () => showBanner(true));
                    window.addEventListener('online', () => showBanner(false));
                }

                init();
                // ─── Floating notification bell (mobile) ───
                if (!document.getElementById('ef-notif-floating')) {
                    const notifFloat = document.createElement('div');
                    notifFloat.id = 'ef-notif-floating';
                    notifFloat.innerHTML = '<span class="material-icons-round">notifications</span><span class="floating-notif-badge"></span>';
                    notifFloat.addEventListener('click', () => efNavigate('inbox'));
                    document.body.appendChild(notifFloat);
                }
                // Hide bottom nav and notification bell until first view renders
                const initialBottomNav = document.getElementById('bottomNav');
                if (initialBottomNav) initialBottomNav.style.display = 'none';
                const initialNotifFloat = document.getElementById('ef-notif-floating');
                if (initialNotifFloat) initialNotifFloat.style.display = 'none';
                // ─── Warm caches in background for instant view loads ───
                sync.collection('users/' + user.uid + '/schedule').catch(() => {});
                // Admin collections are loaded on demand when the admin tab is opened
                // ─── Push Notification Setup ─────────────────────────
                if ('Notification' in window) {
                    if (Notification.permission === 'default') {
                        Notification.requestPermission().catch(() => {});
                    }
                    // FCM removed - notifications work via Firestore
                }
            } catch (error) { console.error(error); init(); }
        } else {
            localStorage.removeItem('ef_logged_in');
            if (userListenerUnsubscribe) { userListenerUnsubscribe(); userListenerUnsubscribe = null; }
            // authStateReady() guard above handles the redirect — no need to act here
        }
    });

    function updateUIWithUserProfile(user) {
        let initials = "EF";
        if (user.displayName) {
            const parts = user.displayName.trim().split(' ');
            initials = parts.length > 1
                ? (parts[0][0] + parts[1][0]).toUpperCase()
                : parts[0].substring(0, 2).toUpperCase();
        }
        if (profileBtn) profileBtn.textContent = initials;
    }

    // ─── Analytics Engine ─────────────────────────────────────────
    function getAnalytics() {
        const results = userData.recentResults || [];
        if (results.length === 0) {
            return { avg: '—', count: 0, bestScore: '—', bestCourse: 'N/A' };
        }
        const totalScore = results.reduce((sum, r) => sum + r.score, 0);
        const bestResult = results.reduce((max, r) => r.score > max.score ? r : max, results[0]);
        return {
            avg: Math.round(totalScore / results.length),
            count: results.length,
            bestScore: bestResult.score,
            bestCourse: bestResult.course ? bestResult.course.split('—')[0].trim() : 'N/A'
        };
    }

    // ─── Init ─────────────────────────────────────────────────────
    async function init() {
        const saved = localStorage.getItem('examforge-theme');
        if (saved === 'dark') html.setAttribute('data-theme', 'dark');

        try {
            const r = await fetch('/json/uni-courses.json');
            if (r.ok) uniCourses = await r.json();
            else uniCourses = MOCK_COURSES;
        } catch {
            uniCourses = MOCK_COURSES;
        }

        const hash = location.hash.slice(1);
        const [view, courseSlug] = hash.split('/');
        const params = courseSlug ? { course: decodeURIComponent(courseSlug) } : {};
        const validViews = ['dashboard', 'library', 'topics', 'schedule', 'results', 'inbox', 'settings', 'subscriptions', 'master'];
        navigate(validViews.includes(view) ? view : 'dashboard', params, { replace: true });
    }

    // ─── Theme ───────────────────────────────────────────────────
    const themeCheckboxes = document.querySelectorAll('.theme-toggle-checkbox');

    function setTheme(themeName) {
        document.documentElement.setAttribute('data-theme', themeName);
        localStorage.setItem('examforge-theme', themeName);
        const isDark = themeName === 'dark';
        themeCheckboxes.forEach(cb => { if (cb.checked !== isDark) cb.checked = isDark; });
        // Preserve body padding for bottom nav on mobile
        if (window.innerWidth <= 768) {
            document.body.style.paddingBottom = 'calc(var(--bottom-nav-h) + 16px)';
        }
    }

    const initialTheme = document.documentElement.getAttribute('data-theme') || 'light';
    setTheme(initialTheme);

    themeCheckboxes.forEach(cb => {
        cb.addEventListener('change', (e) => setTheme(e.target.checked ? 'dark' : 'light'));
    });

    // ─── Sidebar ──────────────────────────────────────────────────
    menuBtn.addEventListener('click', toggleSidebar);
    overlay.addEventListener('click', closeMobile);

    function toggleSidebar() {
        if (window.innerWidth > 768) {
            sidebar.classList.toggle('collapsed');
            // Persist collapsed state
            localStorage.setItem('examforge-sidebar-collapsed', sidebar.classList.contains('collapsed'));
        } else {
            sidebar.classList.toggle('mobile-open');
            overlay.classList.toggle('active');
        }
    }

    function closeMobile() {
        sidebar.classList.remove('mobile-open');
        overlay.classList.remove('active');
        // Also close search overlay if open
        if (searchOverlay) searchOverlay.classList.remove('active');
    }

    window.addEventListener('resize', () => {
        if (window.innerWidth <= 768) {
            sidebar.classList.remove('collapsed');
        } else {
            sidebar.classList.remove('mobile-open');
            overlay.classList.remove('active');
            // Restore sidebar state on returning to desktop
            const savedState = localStorage.getItem('examforge-sidebar-collapsed');
            if (savedState === 'true') {
                sidebar.classList.add('collapsed');
            } else {
                sidebar.classList.remove('collapsed');
            }
        }
        // Show/hide bottom nav and notification bell on resize
        const bottomNav = document.getElementById('bottomNav');
        if (bottomNav) bottomNav.style.display = window.innerWidth <= 768 ? 'flex' : 'none';
        const notifFloat = document.getElementById('ef-notif-floating');
        if (notifFloat) notifFloat.style.display = window.innerWidth <= 768 ? 'flex' : 'none';
    });

    // ─── Sidebar State Persistence ──────────────────────────────
    // Restore sidebar collapsed state from localStorage on desktop
    if (window.innerWidth > 768) {
        const savedSidebarState = localStorage.getItem('examforge-sidebar-collapsed');
        if (savedSidebarState === 'true') {
            sidebar.classList.add('collapsed');
        }
    }

    // ─── Mobile Search Overlay ────────────────────────────────────
    if (mobileSearchBtn) {
        mobileSearchBtn.addEventListener('click', () => {
            searchOverlay.classList.add('active');
            setTimeout(() => mobileSearchInput.focus(), 100);
        });
    }

    if (searchOverlay) {
        // Close on backdrop click
        searchOverlay.addEventListener('click', (e) => {
            if (e.target === searchOverlay) {
                searchOverlay.classList.remove('active');
            }
        });

        // Close on Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && searchOverlay.classList.contains('active')) {
                searchOverlay.classList.remove('active');
            }
        });

        // Search on Enter
        mobileSearchInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && e.target.value.trim()) {
                e.preventDefault();
                libQuery = e.target.value.trim();
                searchOverlay.classList.remove('active');
                navigate('library');
            }
        });
    }

    // ─── Bottom Navigation ────────────────────────────────────────
    document.querySelectorAll('.bottom-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const view = btn.getAttribute('data-view');
            navigate(view);
            // Close mobile sidebar if open
            if (window.innerWidth <= 768) closeMobile();
        });
    });

    // ─── Nav items ────────────────────────────────────────────────
    document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            navigate(btn.getAttribute('data-view'));
            if (window.innerWidth <= 768) closeMobile();
        });
    });

    document.querySelectorAll('[data-view]').forEach(el => {
        if (!el.classList.contains('nav-item')) {
            el.addEventListener('click', () => {
                navigate(el.getAttribute('data-view'));
                if (window.innerWidth <= 768) closeMobile();
            });
        }
    });

    logoutBtn.addEventListener('click', async () => {
        try { await signOut(auth); window.location.href = '/'; }
        catch (error) { console.error("Error signing out: ", error); }
    });

    globalSearch.addEventListener('keypress', e => {
        if (e.key === 'Enter' && e.target.value.trim()) {
            libQuery = e.target.value.trim(); navigate('library');
        }
    });

    // ─── Router ────────────────────────────────────────────────────
    function navigate(view, params = {}, { replace = false } = {}) {
        // Clean up inbox listener when leaving inbox view
        if (currentView === 'inbox' && window._inboxListener) {
            try { window._inboxListener(); } catch(e) {}
            window._inboxListener = null;
        }
        currentView = view;
        updateActiveNav(view);
        workspace.scrollTop = 0;
        document.documentElement.scrollTop = 0;

        // Reveal bottom nav and notification bell after every page render
        setTimeout(() => {
            // Hide preloader instantly — syncs with nav/bell reveal
            const preloader = document.getElementById('app-preloader');
            if (preloader) {
                preloader.style.display = 'none';
            }
            // Show bottom nav and notification bell on mobile
            if (window.innerWidth <= 768) {
                const navEl = document.getElementById('bottomNav');
                if (navEl) navEl.style.display = 'flex';
                const notifEl = document.getElementById('ef-notif-floating');
                if (notifEl) notifEl.style.display = 'flex';
            }
        }, 2000);

        const state = { view, params };
        const url = '#' + view + (params.course ? '/' + encodeURIComponent(params.course) : '');
        if (replace) history.replaceState(state, '', url);
        else history.pushState(state, '', url);

        switch (view) {
            case 'dashboard': renderDashboard(); break;
            case 'master': renderMaster(); break;
            case 'subscriptions': renderSubscriptions(); break;
            case 'library': renderLibrary(); break; // async, intentionally not awaited at router level
            case 'topics': renderTopics(params); break;
            case 'schedule': renderSchedule(); break; // async, intentionally not awaited
            case 'results': renderResults(); break;
            case 'inbox': renderInbox(); break;
            case 'settings': renderSettings(); break;
            default: renderDashboard();
        }
    }
    window.efNavigate = navigate;

    window.addEventListener('popstate', e => {
        if (e.state && e.state.view) navigate(e.state.view, e.state.params || {}, { replace: true });
        else navigate('dashboard', {}, { replace: true });
    });

    function updateActiveNav(view) {
        const map = { library: 'library', topics: 'library' };
        const active = map[view] || view;
        
        // Update sidebar nav
        document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-view') === active);
        });
        
        // Update bottom nav
        document.querySelectorAll('.bottom-nav-item').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-view') === active);
        });
    }
    // ─── MASTER CONTROL ──────────────────────────────────────────

// ─── MASTER CONTROL: Admin Panel ─────────────────────────────

window.masterAllUsers = [];
let masterTab = 'users'; // 'users' | 'courses'

async function renderMaster() {
    if (userData.stats?.role !== 'admin') {
        efNavigate('dashboard');
        return;
    }
    workspace.innerHTML = `
        <style>
            /* ── Tab Bar (scrollable on mobile) ── */
            .mc-tab-bar {
                display:flex; gap:4px; margin-bottom:16px; background:var(--bg-inset);
                padding:4px; border-radius:12px; border:1px solid var(--border);
                width:100%; overflow-x:auto; -webkit-overflow-scrolling:touch;
            }
            .mc-tab {
                padding:8px 20px; border-radius:8px; border:none;
                background:transparent; color:var(--text-muted);
                font-weight:800; font-size:clamp(0.65rem,1.8vw,0.78rem);
                text-transform:uppercase; letter-spacing:0.05em;
                cursor:pointer; transition:all 0.15s;
                white-space:nowrap; flex-shrink:0;
            }
            .mc-tab.active {
                background:var(--bg-card); color:var(--text);
                border:1px solid var(--border);
            }
            @media(max-width:600px){
                .mc-tab { padding:6px 12px; font-size:0.6rem; }
                .mc-tab-bar { margin-bottom:16px; }
            }
            
            /* ── Card Grid & Cards ── */
            .mc-card-grid {
                display:grid;
                grid-template-columns:repeat(auto-fill, minmax(200px, 1fr));
                gap:8px;
            }
            @media(max-width:600px){ .mc-card-grid { gap:8px; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); } }
            @media(max-width:400px){ .mc-card-grid { grid-template-columns:1fr; } }
            
            .mc-card {
                background:var(--bg-card); border:2px solid var(--border);
                border-radius:12px; padding:10px; cursor:pointer;
                display:flex; flex-direction:column;
                min-height:120px; box-sizing:border-box;
                transition:transform 0.12s, border-color 0.12s;
                position:relative; overflow:hidden;
            }
            .mc-card:hover { transform:translate(-2px,-2px); border-color:var(--text); }
            @media(max-width:600px){ .mc-card { padding:8px; min-height:100px; } }
            
            .mc-card-icon {
                width:36px; height:36px; border-radius:8px;
                display:flex; align-items:center; justify-content:center;
                margin-bottom:10px; flex-shrink:0; border:2px solid;
            }
            .mc-card-title {
                font-weight:900; font-size:clamp(0.75rem,2vw,0.85rem);
                color:var(--text); line-height:1.2; flex:1;
            }
            .mc-card-meta {
                font-size:clamp(0.6rem,1.5vw,0.65rem); font-weight:700;
                color:var(--text-muted); margin-top:auto; padding-top:8px;
                border-top:1px solid var(--border);
                display:flex; align-items:center; gap:4px; flex-wrap:wrap;
            }
            
            /* ── Stat Bar ── */
            .mc-stat-bar {
                display:grid;
                grid-template-columns:repeat(auto-fit,minmax(100px,1fr));
                gap:8px; margin-bottom:16px;
            }
            @media(max-width:400px){ .mc-stat-bar { grid-template-columns:repeat(2,1fr); gap:8px; margin-bottom:16px; } }
            .mc-stat { background:var(--bg-card); border:2px solid var(--border); border-radius:10px; padding:10px 12px; }
            @media(max-width:600px){ .mc-stat { padding:8px 10px; } }
            .mc-stat-val { font-size:clamp(1.2rem,5vw,1.6rem); font-weight:900; color:var(--text); line-height:1; }
            .mc-stat-lbl { font-size:clamp(0.55rem,1.5vw,0.65rem); font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.05em; margin-top:4px; }
            
            /* ── User Grid ── */
            @media(max-width:600px){ #mc-user-grid { grid-template-columns:1fr !important; gap:8px; } }
            .mc-user-card .mc-avatar + div { min-width:0; overflow:hidden; }
            
            /* ── User Card ── */
            .mc-user-card {
                background:var(--bg-card); border:2px solid var(--border);
                border-radius:10px; padding:10px 14px; cursor:pointer;
                display:flex; align-items:center; gap:12px;
                transition:transform 0.1s;
                overflow:hidden; max-width:100%;
            }
            .mc-user-card:hover { transform:translate(-2px,-2px); border-color:var(--text); }
            @media(max-width:400px){ .mc-user-card { padding:8px 10px; gap:8px; } }
            .mc-avatar { width:38px; height:38px; border-radius:8px; background:var(--brand); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:0.8rem; flex-shrink:0; border:2px solid var(--text); text-transform:uppercase; }
            
            /* ── Search Input ── */
            .mc-search { width:100%; padding:10px 14px; border:2px solid var(--border); border-radius:8px; background:var(--bg-inset); color:var(--text); font-size:clamp(0.75rem,2vw,0.85rem); box-sizing:border-box; outline:none; transition:border-color 0.15s; }
            .mc-search:focus { border-color:var(--brand); }
            
            /* ── Section Header ── */
            .mc-section-hdr { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; flex-wrap:wrap; gap:10px; }
            .mc-section-title { font-weight:800; font-size:clamp(0.7rem,2vw,0.8rem); text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); word-break:break-word; max-width:100%; }
            
            /* ── Breadcrumbs ── */
            .mc-breadcrumb { display:flex; align-items:center; gap:6px; margin-bottom:20px; flex-wrap:wrap; }
            .mc-crumb { font-size:clamp(0.65rem,1.8vw,0.75rem); font-weight:800; color:var(--text-muted); cursor:pointer; padding:4px 8px; border-radius:6px; transition:background 0.12s; }
            .mc-crumb:hover { background:var(--bg-inset); color:var(--text); }
            .mc-crumb.active { color:var(--text); cursor:default; }
            .mc-crumb:hover.active { background:transparent; }
            .mc-sep { color:var(--text-muted); font-size:0.7rem; }
            
            /* ── Question Rows ── */
            .mc-q-row { background:var(--bg-card); border:1px solid var(--border); border-radius:8px; padding:14px 16px; margin-bottom:8px; }
            @media(max-width:600px){ .mc-q-row { padding:10px 12px; } }
            .mc-q-row:hover { border-color:var(--brand); background:var(--brand-dim); }
            .mc-q-text { font-weight:700; font-size:clamp(0.78rem,2vw,0.85rem); color:var(--text); margin-bottom:8px; word-break:break-word; }
            .mc-q-opts { display:grid; grid-template-columns:1fr 1fr; gap:6px; }
            @media(max-width:500px){ .mc-q-opts { grid-template-columns:1fr; } }
            .mc-q-opt { font-size:clamp(0.65rem,1.5vw,0.72rem); padding:5px 10px; border-radius:6px; background:var(--bg-inset); color:var(--text-sub); font-weight:600; word-break:break-word; }
            .mc-q-opt.correct { background:rgba(22,163,74,0.12); color:#16a34a; border:1px solid #16a34a; font-weight:800; }
            
            /* ── FAB - Adjusted for bottom nav ── */
            .mc-fab {
                position:fixed; bottom:28px; right:28px;
                width:52px; height:52px; border-radius:50%;
                background:var(--brand); color:#fff; border:3px solid var(--text);
                display:flex; align-items:center; justify-content:center;
                cursor:pointer; z-index:50;
                transition:transform 0.1s; font-size:1.5rem;
            }
            .mc-fab:hover { transform:translate(-2px,-2px); }
            @media(max-width:600px){ .mc-fab { bottom:calc(var(--bottom-nav-h,56px) + 16px); right:16px; width:48px; height:48px; } }
            @media(max-width:400px){ .mc-fab { bottom:calc(var(--bottom-nav-h,56px) + 12px); right:12px; } }
            
            /* ── Modal ── */
            .mc-modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.55); backdrop-filter:blur(4px); display:flex; align-items:center; justify-content:center; z-index:1000; padding:12px; }
            .mc-modal { background:var(--bg-card); border:3px solid var(--text); border-radius:16px; padding:20px; width:100%; max-width:520px; max-height:90vh; overflow-y:auto; animation:popIn 0.2s ease; box-sizing:border-box; }
            @media(min-width:480px){ .mc-modal { padding:28px; } }
            @media(max-width:400px){ .mc-modal { padding:14px; border-width:2px; border-radius:10px; } }
            .mc-modal h3 { font-size:clamp(0.85rem,3vw,1rem); font-weight:900; text-transform:uppercase; margin:0 0 16px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
            .mc-field { margin-bottom:12px; }
            .mc-field label { display:block; font-size:0.72rem; font-weight:800; color:var(--text-muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:6px; }
            .mc-field input, .mc-field select, .mc-field textarea { width:100%; padding:10px 12px; border:2px solid var(--border); border-radius:8px; background:var(--bg-inset); color:var(--text); font-size:clamp(0.78rem,2vw,0.85rem); box-sizing:border-box; font-family:inherit; outline:none; transition:border-color 0.15s; }
            .mc-field input:focus, .mc-field select:focus, .mc-field textarea:focus { border-color:var(--brand); }
            .mc-opts-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            @media(max-width:400px){ .mc-opts-grid { grid-template-columns:1fr; } }
            .mc-modal-actions { display:flex; gap:8px; margin-top:16px; flex-wrap:wrap; }
            .mc-modal-actions .btn { min-width:0; flex-shrink:1; }
            .badge-admin { background:rgba(220,38,38,0.1); color:#dc2626; border:1px solid #dc2626; border-radius:4px; font-size:0.6rem; font-weight:900; padding:2px 6px; text-transform:uppercase; }
            .mc-2col { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
            @media(max-width:460px){ .mc-2col { grid-template-columns:1fr; } }
            
            /* ── Daily Quiz grid ── */
            @media(max-width:600px){ #mc-dq-list { grid-template-columns:1fr !important; gap:8px !important; } }
            @media(max-width:600px){ #mc-advice-list { grid-template-columns:1fr !important; gap:8px !important; } }
            @media(max-width:600px){ #mc-subevents-list { grid-template-columns:1fr !important; gap:8px !important; } }
            
            /* ── DQ History ── */
            @media(max-width:500px){ #mc-dq-history > div { flex-direction:column !important; align-items:flex-start !important; gap:8px !important; } }

            /* ── Tab dual labels ── */
            .mc-tab-label-short { display:none; }
            @media(max-width:600px){
                .mc-tab-label { display:none; }
                .mc-tab-label-short { display:inline; }
            }
            @media(max-width:400px){
                .mc-tab-label-short { display:none; }
                .mc-tab .material-icons-round { margin-right:0 !important; }
                .mc-tab { padding:6px 10px; }
            }

            /* ── Overflow safety ── */
            #mc-tab-content,
            #mc-tab-content > div,
            .mc-stat-bar,
            .mc-card-grid,
            #mc-user-grid,
            #mc-question-list,
            #mc-dq-list,
            #mc-advice-list,
            #mc-subevents-list,
            #mc-course-grid,
            #mc-topic-grid {
                max-width: 100% !important;
                box-sizing: border-box !important;
                overflow-wrap: break-word !important;
                word-wrap: break-word !important;
            }
            * { box-sizing: border-box; }
        </style>

        <div class="page-header">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:12px;">
                <div>
                    <div class="page-title">Master Control</div>
                    <div class="page-sub">Platform administration — users, courses, topics &amp; questions</div>
                </div>
            </div>
        </div>

        <div class="mc-stat-bar" id="mc-stats">
            <div class="mc-stat"><div class="mc-stat-val" id="mc-s-users">—</div><div class="mc-stat-lbl">Students</div></div>
            <div class="mc-stat"><div class="mc-stat-val" id="mc-s-courses">—</div><div class="mc-stat-lbl">Courses</div></div>
        </div>

        <div class="mc-tab-bar">
            <button class="mc-tab ${masterTab==='users'?'active':''}" onclick="window.mcSwitchTab('users')">
                <span class="material-icons-round" style="font-size:0.9rem;vertical-align:middle;margin-right:4px;">group</span>
                <span class="mc-tab-label">Users</span>
                <span class="mc-tab-label-short">Users</span>
            </button>
            <button class="mc-tab ${masterTab==='courses'?'active':''}" onclick="window.mcSwitchTab('courses')">
                <span class="material-icons-round" style="font-size:0.9rem;vertical-align:middle;margin-right:4px;">library_books</span>
                <span class="mc-tab-label">Courses</span>
                <span class="mc-tab-label-short">Courses</span>
            </button>
            <button class="mc-tab ${masterTab==='dailyquiz'?'active':''}" onclick="window.mcSwitchTab('dailyquiz')">
                <span class="material-icons-round" style="font-size:0.9rem;vertical-align:middle;margin-right:4px;">today</span>
                <span class="mc-tab-label">Daily Quiz</span>
                <span class="mc-tab-label-short">Quiz</span>
            </button>
            <button class="mc-tab ${masterTab==='dailyadvice'?'active':''}" onclick="window.mcSwitchTab('dailyadvice')">
                <span class="material-icons-round" style="font-size:0.9rem;vertical-align:middle;margin-right:4px;">tips_and_updates</span>
                <span class="mc-tab-label">Daily Advice</span>
                <span class="mc-tab-label-short">Advice</span>
            </button>
            <button class="mc-tab ${masterTab==='subevents'?'active':''}" onclick="window.mcSwitchTab('subevents')">
                <span class="material-icons-round" style="font-size:0.9rem;vertical-align:middle;margin-right:4px;">event_available</span>
                <span class="mc-tab-label">Subscription Events</span>
                <span class="mc-tab-label-short">Events</span>
            </button>
        </div>
 
        <div id="mc-tab-content"></div>
    `;
 
    mcLoadStats();
    mcRenderTabContent();
}
 
window.mcSwitchTab = function(tab) {
    masterTab = tab;
    document.querySelectorAll('.mc-tab').forEach(t => {
        const fullLabel = t.querySelector('.mc-tab-label') || t.querySelector('.mc-tab-label-short');
        const labelText = (fullLabel ? fullLabel.textContent : t.textContent).trim().toLowerCase().replace(/\s+/g,'');
        t.classList.toggle('active', labelText.includes(tab) || tab.includes(labelText));
    });
    mcRenderTabContent();
};
 
function mcRenderTabContent() {
    if (masterTab === 'users')      mcRenderUsersTab();
    else if (masterTab === 'courses') mcRenderCoursesTab();
    else if (masterTab === 'dailyquiz') mcRenderDailyQuizTab();
    else if (masterTab === 'dailyadvice') mcRenderDailyAdviceTab();
    else if (masterTab === 'subevents') mcRenderSubEventsTab();
}

async function mcLoadStats() {
    try {
        const { collection, getCountFromServer } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        const [userCountSnap, courses] = await Promise.all([
            getCountFromServer(collection(db, 'users')),
            sync.collection('unicourses')
        ]);
        const el = id => document.getElementById(id);
        if (el('mc-s-users')) el('mc-s-users').textContent = userCountSnap.data().count;
        if (el('mc-s-courses')) el('mc-s-courses').textContent = (courses || []).length;
    } catch (e) { console.error(e); }
}

// ── USERS TAB ─────────────────────────────────────────────────
function mcRenderUsersTab() {
    const panel = document.getElementById('mc-tab-content');
    if (!panel) return;

    // Reset display limit to 50 on tab open
    window.masterDisplayLimit = 50;

    panel.innerHTML = `
        <div class="mc-section-hdr">
            <span class="mc-section-title">Student Registry</span>
            <input class="mc-search" id="mc-user-search" placeholder="Search name, handle or email…" style="max-width:320px;width:100%;">
        </div>
        <div id="mc-user-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;">
            <div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);">
                <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.5rem;vertical-align:middle;margin-right:6px;">autorenew</span> Loading users…
            </div>
        </div>
        <div id="mc-user-load-more-container" style="text-align:center;margin-top:20px;margin-bottom:20px;"></div>
    `;

    // Function to load users from Firestore
    async function loadUsers(forceRefresh = false) {
        const grid = document.getElementById('mc-user-grid');
        if (!grid) return;

        // If we already have users and aren't forcing a refresh, just render them!
        if (window.masterAllUsers && window.masterAllUsers.length > 0 && !forceRefresh) {
            renderFilteredUsers();
            return;
        }

        try {
            window.masterAllUsers = (await sync.collection('users')) || [];
            renderFilteredUsers();
        } catch (err) {
            console.error("Error loading users:", err);
            grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--brand);">Failed to load users.</div>';
        }
    }

    // Function to filter and render users based on display limit
    function renderFilteredUsers() {
        const searchInput = document.getElementById('mc-user-search');
        const q = searchInput ? searchInput.value.toLowerCase().trim() : '';

        // Filter users
        const filtered = q ? window.masterAllUsers.filter(u =>
            (u.displayName||'').toLowerCase().includes(q) ||
            (u.username||'').toLowerCase().includes(q) ||
            (u.email||'').toLowerCase().includes(q)
        ) : window.masterAllUsers;

        // Slice to display limit
        const sliced = filtered.slice(0, window.masterDisplayLimit);

        // Render grid
        mcRenderUserGrid(sliced);

        // Render Load More button if there are more remaining
        const loadMoreContainer = document.getElementById('mc-user-load-more-container');
        if (loadMoreContainer) {
            if (filtered.length > window.masterDisplayLimit) {
                const remaining = filtered.length - window.masterDisplayLimit;
                loadMoreContainer.innerHTML = `
                    <button class="btn btn-outline" id="mc-btn-load-more-users" style="padding:8px 24px;font-weight:800;margin-top:10px;">
                        Load More (${remaining} remaining)
                    </button>
                `;
                document.getElementById('mc-btn-load-more-users').onclick = () => {
                    window.masterDisplayLimit += 50;
                    renderFilteredUsers();
                };
            } else {
                loadMoreContainer.innerHTML = '';
            }
        }
    }

    // Hook search input
    const searchInput = document.getElementById('mc-user-search');
    if (searchInput) {
        searchInput.oninput = () => {
            // Reset display limit when searching to start fresh
            window.masterDisplayLimit = 50;
            renderFilteredUsers();
        };
    }

    // Hook reload button
    const reloadBtn = document.getElementById('mc-load-users-btn');
    if (reloadBtn) {
        reloadBtn.onclick = async () => {
            reloadBtn.disabled = true;
            reloadBtn.innerHTML = '<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;animation:spin 1s linear infinite;display:inline-block;">autorenew</span> Loading…';
            await loadUsers(true);
            reloadBtn.disabled = false;
            reloadBtn.innerHTML = '<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">refresh</span> Reload';
        };
    }

    // Trigger initial load automatically!
    loadUsers();
}

function mcRenderUserGrid(users) {
    const grid = document.getElementById('mc-user-grid');
    if (!grid) return;
    if (!users.length) {
        grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);">No users found.</div>';
        return;
    }
    grid.innerHTML = users.map(u => {
        const name = u.displayName || u.username || u.email?.split('@')[0] || 'Unknown';
        const handle = u.username || '—';
        const parts = name.trim().split(' ');
        const initials = parts.length > 1 ? (parts[0][0]+parts[parts.length-1][0]).toUpperCase() : name.substring(0,2).toUpperCase();
        const isAdmin = u.role === 'admin';
        const isGoogle = (u.provider || '') === 'google.com';
        return `
        <div class="mc-user-card" onclick="window.openAdminUserModal('${u.id}')">
            <div class="mc-avatar">${initials}</div>
            <div style="flex:1;min-width:0;">
                <div style="font-weight:800;font-size:0.82rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:flex;align-items:center;gap:6px;">
                    ${name} ${isAdmin ? '<span class="badge-admin">Admin</span>' : ''}
                </div>
                <div style="font-size:0.68rem;color:var(--text-muted);margin-top:2px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${isGoogle ? '🌐' : '✉️'} @${handle}
                </div>
                <div style="font-size:0.65rem;color:var(--text-muted);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${u.email||''}</div>
            </div>
            <span class="material-icons-round" style="font-size:1rem;color:var(--text-muted);flex-shrink:0;">chevron_right</span>
        </div>`;
    }).join('');
}

// ── COURSES TAB ───────────────────────────────────────────────
let mcCrumbs = []; // [{label, fn}]

async function mcRenderCoursesTab(courseId = null, topicId = null) {
    const panel = document.getElementById('mc-tab-content');
    if (!panel) return;

    if (!courseId && !topicId) {
        // ── Level 0: Course list ──────────────────────────
        mcCrumbs = [{ label: 'Courses' }];
        panel.innerHTML = `
            <div class="mc-section-hdr">
                <span class="mc-section-title">University Courses</span>
                <button class="btn btn-primary btn-sm" onclick="window.mcOpenCreateCourseModal()">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Course
                </button>
            </div>
            <div style="max-width:1100px;width:100%;">
                <div id="mc-course-grid" class="mc-card-grid">
                    <div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);">
                        <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.5rem;">autorenew</span>
                    </div>
                </div>
            </div>
        `;
        try {
            const courses = (await sync.collection('unicourses')) || [];
            courses.sort((a,b)=>a.id.localeCompare(b.id));
            const grid = document.getElementById('mc-course-grid');
            if (!grid) return;
            if (!courses.length) {
                grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);">No courses yet. Create one!</div>';
                return;
            }
            // fetch topic counts
            const topicsLists = await Promise.all(courses.map(c => sync.collection('unicourses/' + c.id + '/topics').catch(() => [])));
            grid.innerHTML = courses.map((c,i) => `
                <div class="mc-card" style="position:relative;" onclick="window.mcDrillCourse('${c.id}')">
                    <button onclick="event.stopPropagation();window.mcDeleteCourse('${c.id}', '${(c.title || c.id).replace(/'/g, "\\'")}')"
                        style="position:absolute;top:8px;right:8px;background:var(--bg-inset);border:1px solid var(--border);border-radius:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:2;" title="Delete Course">
                        <span class="material-icons-round" style="font-size:0.85rem;color:#dc2626;">delete</span>
                    </button>
                    <div class="mc-card-icon" style="background:var(--brand-dim);border-color:var(--brand);color:var(--brand);">
                        <span class="material-icons-round" style="font-size:1.1rem;">menu_book</span>
                    </div>
                    <div class="mc-card-title" style="padding-right:24px;">${c.title || c.id.toUpperCase()}</div>
                    <div class="mc-card-meta">
                        <span class="material-icons-round" style="font-size:0.75rem;">layers</span>
                        ${topicsLists[i].length} topic${topicsLists[i].length!==1?'s':''}
                        <span style="margin-left:auto;font-family:var(--font-mono);font-size:0.6rem;background:var(--bg-inset);padding:2px 6px;border-radius:4px;">${c.id.toUpperCase()}</span>
                    </div>
                </div>
            `).join('');
        } catch (e) {
            console.error(e);
            const g = document.getElementById('mc-course-grid');
            if(g) g.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--brand);">Failed to load courses.</div>';
        }

    } else if (courseId && !topicId) {
        // ── Level 1: Topics in a course ───────────────────
        mcCrumbs = [
            { label: 'Courses' },
            { label: courseId.toUpperCase(), courseId }
        ];
        panel.innerHTML = `
            ${mcBreadcrumb()}
            <div class="mc-section-hdr">
                <span class="mc-section-title">Topics — ${courseId.toUpperCase()}</span>
                <button class="btn btn-primary btn-sm" onclick="window.mcOpenCreateTopicModal('${courseId}')">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Topic
                </button>
            </div>
            <div id="mc-topic-grid" class="mc-card-grid">
                <div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.5rem;">autorenew</span>
                </div>
            </div>
        `;
        try {
            const topics = (await sync.collection('unicourses/' + courseId + '/topics')) || [];
            topics.sort((a,b)=>a.id.localeCompare(b.id));
            const grid = document.getElementById('mc-topic-grid');
            if (!grid) return;
            if (!topics.length) {
                grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:48px;color:var(--text-muted);">No topics yet. Create one!</div>';
                return;
            }
            grid.innerHTML = topics.map(t => {
                const qCount = (t.questions||[]).length;
                const mins = t.timeLimit || 0;
                const badges = [
                    t.isStrict ? `<span style="background:rgba(220,38,38,0.1);color:#dc2626;border:1px solid #dc2626;border-radius:3px;font-size:0.55rem;font-weight:900;padding:1px 5px;text-transform:uppercase;">Strict</span>` : '',
                    t.isMock   ? `<span style="background:rgba(124,58,237,0.1);color:#7c3aed;border:1px solid #7c3aed;border-radius:3px;font-size:0.55rem;font-weight:900;padding:1px 5px;text-transform:uppercase;">Mock</span>` : '',
                    t.isCorrection===false ? `<span style="background:rgba(245,158,11,0.1);color:#d97706;border:1px solid #d97706;border-radius:3px;font-size:0.55rem;font-weight:900;padding:1px 5px;text-transform:uppercase;">No Review</span>` : '',
                    t.isPrivate ? `<span style="background:rgba(15,118,110,0.1);color:#0f766e;border:1px solid #0f766e;border-radius:3px;font-size:0.55rem;font-weight:900;padding:1px 5px;text-transform:uppercase;">🔐 Private</span>` : '',
                ].filter(Boolean).join('');
                return `
                <div class="mc-card" style="position:relative;" onclick="window.mcDrillTopic('${courseId}','${t.id}')">
                    <div style="position:absolute;top:8px;right:8px;display:flex;gap:6px;z-index:2;">
                        <button onclick="event.stopPropagation();window.mcOpenEditTopicModal('${courseId}','${t.id}')"
                            style="background:var(--bg-inset);border:1px solid var(--border);border-radius:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;" title="Edit Topic">
                            <span class="material-icons-round" style="font-size:0.8rem;color:var(--text-muted);">edit</span>
                        </button>
                        <button onclick="event.stopPropagation();window.mcDeleteTopic('${courseId}','${t.id}', '${(t.title || t.id).replace(/'/g, "\\'")}')"
                            style="background:var(--bg-inset);border:1px solid var(--border);border-radius:6px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;" title="Delete Topic">
                            <span class="material-icons-round" style="font-size:0.8rem;color:#dc2626;">delete</span>
                        </button>
                    </div>
                    <div class="mc-card-icon" style="background:${t.isPrivate?'rgba(15,118,110,0.08)':'rgba(37,99,235,0.08)'};border-color:${t.isPrivate?'#0f766e':'#2563eb'};color:${t.isPrivate?'#0f766e':'#2563eb'};">
                        <span class="material-icons-round" style="font-size:1.1rem;">${t.isPrivate?'lock':'topic'}</span>
                    </div>
                    <div class="mc-card-title" style="padding-right:62px;">${t.title || t.id.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</div>
                    <div class="mc-card-meta" style="flex-wrap:wrap;gap:4px;">
                        <span class="material-icons-round" style="font-size:0.75rem;">quiz</span> ${qCount}q
                        ${mins ? `<span style="font-family:var(--font-mono);font-size:0.6rem;background:var(--bg-inset);padding:1px 5px;border-radius:3px;">${mins}m</span>` : ''}
                        ${badges}
                    </div>
                </div>`;
            }).join('');
        } catch (e) {
            console.error(e);
        }

    } else if (courseId && topicId) {
        // ── Level 2: Questions in a topic ─────────────────
        mcCrumbs = [
            { label: 'Courses' },
            { label: courseId.toUpperCase(), courseId },
            { label: topicId.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()), courseId, topicId }
        ];
        panel.innerHTML = `
            ${mcBreadcrumb()}
            <div class="mc-section-hdr">
                <span class="mc-section-title">Questions — ${topicId.replace(/-/g,' ').toUpperCase()}</span>
                <div style="display:flex;gap:8px;flex-wrap:wrap;">
                    <button class="btn btn-outline btn-sm" onclick="window.mcViewTopicResults('${courseId}','${topicId}')"
                        style="border-color:#16a34a;color:#16a34a;">
                        <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">bar_chart</span> Results
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="window.mcOpenBulkImportModal('${courseId}','${topicId}')"
                        style="border-color:#7c3aed;color:#7c3aed;">
                        <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">upload_file</span> Bulk Import
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="window.mcDeleteAllQuestions('${courseId}','${topicId}')"
                        style="border-color:#dc2626;color:#dc2626;">
                        <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">delete_sweep</span> Delete All
                    </button>
                    <button class="btn btn-primary btn-sm" onclick="window.mcOpenCreateQuestionModal('${courseId}','${topicId}')">
                        <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> Add Question
                    </button>
                </div>
            </div>
            <div id="mc-question-list">
                <div style="text-align:center;padding:48px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.5rem;">autorenew</span>
                </div>
            </div>
        `;
        try {
            const tData = await sync.doc('unicourses/' + courseId + '/topics/' + topicId) || {};
            const questions = tData.questions || [];
            const list = document.getElementById('mc-question-list');
            if (!list) return;

            // ── Topic properties banner ───────────────────────────────
            const propBanner = `
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 14px;background:var(--bg-inset);border:1px solid var(--border);border-radius:10px;margin-bottom:16px;width:100%;box-sizing:border-box;">
                    <span style="font-size:0.7rem;font-weight:900;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;margin-right:4px;flex-shrink:0;">Settings</span>
                    <span style="font-size:clamp(0.65rem,1.8vw,0.72rem);font-weight:700;color:var(--text);background:var(--bg-card);border:1px solid var(--border);border-radius:5px;padding:3px 8px;white-space:nowrap;">
                        ⏱ ${tData.timeLimit || 40} min
                    </span>
                    <span style="font-size:clamp(0.65rem,1.8vw,0.72rem);font-weight:700;border-radius:5px;padding:3px 8px;word-break:break-word;
                        background:${tData.isStrict ? 'rgba(220,38,38,0.08)' : 'var(--bg-card)'};
                        color:${tData.isStrict ? '#dc2626' : 'var(--text-muted)'};
                        border:1px solid ${tData.isStrict ? '#dc2626' : 'var(--border)'};">
                        ${tData.isStrict ? '🔒 Strict' : '🔓 Relaxed'}
                    </span>
                    <span style="font-size:clamp(0.65rem,1.8vw,0.72rem);font-weight:700;border-radius:5px;padding:3px 8px;word-break:break-word;
                        background:${tData.isMock ? 'rgba(124,58,237,0.08)' : 'var(--bg-card)'};
                        color:${tData.isMock ? '#7c3aed' : 'var(--text-muted)'};
                        border:1px solid ${tData.isMock ? '#7c3aed' : 'var(--border)'};">
                        ${tData.isMock ? '🎭 Mock' : '📊 Visible'}
                    </span>
                    <span style="font-size:clamp(0.65rem,1.8vw,0.72rem);font-weight:700;border-radius:5px;padding:3px 8px;word-break:break-word;
                        background:${tData.isCorrection===false ? 'rgba(245,158,11,0.08)' : 'var(--bg-card)'};
                        color:${tData.isCorrection===false ? '#d97706' : 'var(--text-muted)'};
                        border:1px solid ${tData.isCorrection===false ? '#d97706' : 'var(--border)'};">
                        ${tData.isCorrection===false ? '🚫 No review' : '✅ Review'}
                    </span>
                    <button onclick="window.mcOpenEditTopicModal('${courseId}','${topicId}')"
                        style="background:var(--bg-card);border:1px solid var(--border);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:clamp(0.65rem,1.8vw,0.7rem);font-weight:800;color:var(--text);display:flex;align-items:center;gap:4px;flex-shrink:0;">
                        <span class="material-icons-round" style="font-size:0.85rem;">tune</span> Edit
                    </button>
                </div>`;

            if (!questions.length) {
                list.innerHTML = propBanner + '<div style="text-align:center;padding:48px;color:var(--text-muted);">No questions yet. Add one!</div>';
                return;
            }
            list.innerHTML = propBanner + questions.map((q, qi) => `
                <div class="mc-q-row">
                    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;">
                        <div style="font-size:0.65rem;font-weight:900;color:var(--text-muted);text-transform:uppercase;background:var(--bg-inset);padding:2px 8px;border-radius:4px;flex-shrink:0;">Q${qi+1}</div>
                        <div style="display:flex;gap:6px;align-items:center;">
                            <button onclick="window.mcOpenEditQuestionModal('${courseId}','${topicId}',${qi})"
                                style="background:transparent;border:1px solid var(--border);border-radius:5px;cursor:pointer;color:var(--text-muted);padding:2px 6px;display:flex;align-items:center;gap:3px;font-size:0.65rem;font-weight:800;" title="Edit question">
                                <span class="material-icons-round" style="font-size:0.85rem;">edit</span> Edit
                            </button>
                            <button onclick="window.mcDeleteQuestion('${courseId}','${topicId}',${qi})"
                                style="background:transparent;border:none;cursor:pointer;color:var(--text-muted);padding:0;display:flex;align-items:center;" title="Delete question">
                                <span class="material-icons-round" style="font-size:1rem;">delete_outline</span>
                            </button>
                        </div>
                    </div>
                    <div class="mc-q-text">${q.question}</div>
                    <div class="mc-q-opts">
                        ${(q.options||[]).map((opt,oi) => `
                            <div class="mc-q-opt ${oi===q.correctIndex?'correct':''}">
                                ${oi===q.correctIndex?'✓':String.fromCharCode(65+oi)+'.'}  ${opt}
                            </div>
                        `).join('')}
                    </div>
                    ${q.explanation ? `<div style="margin-top:8px;font-size:0.7rem;color:var(--text-muted);padding:6px 10px;background:var(--bg-inset);border-radius:6px;border-left:3px solid var(--brand);">${q.explanation}</div>` : ''}
                </div>
            `).join('');
        } catch (e) { console.error(e); }
    }
}

// ── DAILY QUIZ TAB ────────────────────────────────────────────

window.currentBuilderQuestions = [];

async function mcRenderDailyQuizTab() {
    const panel = document.getElementById('mc-tab-content');
    if (!panel) return;

    panel.innerHTML = `
        <div style="max-width:1100px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;">
            <!-- Header section -->
            <div class="mc-section-hdr" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:3px solid var(--text);padding-bottom:10px;margin-bottom:8px;">
                <div>
                        <span class="mc-section-title" style="font-size:clamp(0.85rem,4vw,1.1rem);font-weight:700;text-transform:uppercase;color:var(--text);display:block;word-break:break-word;">Daily Quizzes Hub</span>
                    <div id="mc-dq-sub-count" style="font-size:0.7rem;font-weight:700;color:var(--text-muted);margin-top:4px;">Loading subscriber count…</div>
                </div>
                <button class="btn btn-primary" onclick="window.mcOpenCreateDailyQuizModal()" style="font-weight:800;border:2px solid var(--text);padding:8px 16px;display:flex;align-items:center;gap:6px;font-size:0.8rem;">
                    <span class="material-icons-round" style="font-size:1.1rem;vertical-align:middle;">add_circle</span> CREATE DAILY QUIZ
                </button>
            </div>

            <!-- Quiz Grid -->
            <div>
                <h2 style="font-weight:700;font-size:0.85rem;text-transform:uppercase;color:var(--text);margin:0 0 8px 0;">Active Daily Challenges</h2>
                <div id="mc-dq-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
                    <div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-muted);">
                        <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;margin-bottom:8px;">autorenew</span>
                        <div style="font-size:0.8rem;font-weight:700;">Loading quizzes…</div>
                    </div>
                </div>
            </div>

        </div>
    `;

    // Load subscriber count
    mcLoadDailyQuizSubCount();

    // Load quizzes into grid
    mcLoadDailyQuizzes();
}

async function mcLoadDailyQuizzes() {
    const grid = document.getElementById('mc-dq-list');
    if (!grid) return;

        try {
            await _throttledRefresh('daily_quizzes');
            const quizzes = (await sync.collection('daily_quizzes')) || [];
            quizzes.sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

        if (quizzes.length === 0) {
            grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:48px 24px;border:3px dashed var(--border);border-radius:12px;color:var(--text-muted);">
                <span class="material-icons-round" style="font-size:3rem;margin-bottom:12px;opacity:0.35;">event_note</span>
                <div style="font-weight:800;font-size:1.1rem;color:var(--text);margin-bottom:6px;">No daily quizzes yet</div>
                <p style="font-size:0.8rem;max-width:340px;margin:0 auto 16px;">Create custom daily quizzes with your own questions, which run in strict timed mode, and track detailed attempts!</p>
                <button class="btn btn-primary" onclick="window.mcOpenCreateDailyQuizModal()" style="font-size:0.75rem;padding:8px 16px;">Create a Quiz</button>
            </div>`;
            return;
        }

        grid.innerHTML = quizzes.map(q => {
            const dateStr = q.createdAt?.toDate ? q.createdAt.toDate().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : 'Recently';
            return `
            <div class="card" style="padding:12px;border:2px solid var(--text);display:flex;flex-direction:column;justify-content:space-between;gap:10px;background:var(--bg-card);transition:transform 0.2s;">
                <div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <span style="font-size:0.65rem;font-weight:800;text-transform:uppercase;color:var(--brand);background:rgba(37,99,235,0.06);padding:3px 8px;border:1.5px solid var(--brand);border-radius:6px;letter-spacing:0.05em;">Exam Mode</span>
                        <span style="font-size:0.68rem;color:var(--text-muted);font-weight:600;">${dateStr}</span>
                    </div>
                    <h3 style="font-weight:800;font-size:0.95rem;color:var(--text);line-height:1.3;margin:0 0 10px 0;word-break:break-word;">${q.title}</h3>
                    <div style="display:flex;gap:12px;font-size:0.75rem;color:var(--text-muted);font-weight:600;margin-bottom:4px;">
                        <div style="display:flex;align-items:center;gap:4px;">
                            <span class="material-icons-round" style="font-size:0.95rem;">help_outline</span>
                            <span>${q.questions?.length || 0} questions</span>
                        </div>
                        <div style="display:flex;align-items:center;gap:4px;">
                            <span class="material-icons-round" style="font-size:0.95rem;">schedule</span>
                            <span>${q.timeLimit || 10} mins</span>
                        </div>
                    </div>
                </div>
                
                <div style="display:flex;gap:6px;margin-top:auto;">
                    <button class="btn btn-outline" onclick="window.mcViewDailyQuizDetails('${q.id}')" style="flex:1;font-size:0.6rem;padding:4px;border:2px solid var(--text);font-weight:800;">
                        DETAILS
                    </button>
                    <button class="btn btn-outline" onclick="window.mcOpenEditDailyQuizModal('${q.id}')" style="font-size:0.6rem;padding:4px 8px;border:2px solid var(--text);font-weight:800;display:flex;align-items:center;gap:3px;">
                        <span class="material-icons-round" style="font-size:0.8rem;">edit</span> EDIT
                    </button>
                    <button class="btn btn-danger" onclick="window.mcDeleteDailyQuiz('${q.id}', '${q.title.replace(/'/g, "\\'")}')" style="font-size:0.6rem;padding:4px 8px;border:2px solid var(--text);display:flex;align-items:center;gap:3px;">
                        <span class="material-icons-round" style="font-size:0.8rem;">delete</span>
                    </button>
                </div>
            </div>
            `;
        }).join('');

    } catch (e) {
        console.error(e);
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--brand);font-size:0.8rem;">Could not load Daily Quizzes: ${e.message}</div>`;
    }
}

async function mcLoadDailyQuizSubCount() {
    const el = document.getElementById('mc-dq-sub-count');
    if (!el) return;
    try {
        const { collection, getCountFromServer } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        const snap = await getCountFromServer(collection(db, 'users'));
        el.textContent = `${snap.data().count} total registered students`;
        el.style.color = '#16a34a';
    } catch (e) {
        el.textContent = 'Could not count users';
    }
}

// ── DAILY ADVICE HUB ─────────────────────────────────────────

async function mcRenderDailyAdviceTab() {
    const panel = document.getElementById('mc-tab-content');
    if (!panel) return;

    panel.innerHTML = `
        <div style="max-width:1100px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;">
            <!-- Header section -->
            <div class="mc-section-hdr" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:3px solid var(--text);padding-bottom:10px;margin-bottom:8px;">
                <div>
                    <span class="mc-section-title" style="font-size:clamp(1rem,5vw,1.3rem);font-weight:900;text-transform:uppercase;color:var(--text);display:block;word-break:break-word;">Daily Advice Hub</span>
                    <div id="mc-advice-sub-count" style="font-size:0.78rem;font-weight:800;color:var(--text-muted);margin-top:4px;">Draft and broadcast cleanly formatted study advices directly to student feeds.</div>
                </div>
                <button class="btn btn-primary" onclick="window.mcOpenCreateDailyAdviceModal()" style="font-weight:900;border:3px solid var(--text);padding:8px 16px;display:flex;align-items:center;gap:6px;font-size:0.8rem;">
                    <span class="material-icons-round" style="font-size:1.1rem;vertical-align:middle;">add_circle</span> CREATE DAILY ADVICE
                </button>
            </div>

            <!-- Advice Grid -->
            <div>
                <h2 style="font-weight:900;font-size:1rem;text-transform:uppercase;color:var(--text);margin:0 0 10px 0;">Sent Advices History</h2>
                <div id="mc-advice-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
                    <div style="grid-column:1/-1;text-align:center;padding:56px;color:var(--text-muted);">
                        <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;margin-bottom:8px;">autorenew</span>
                        <div style="font-size:0.8rem;font-weight:700;">Loading advices…</div>
                    </div>
                </div>
            </div>
        </div>
    `;

    mcLoadDailyAdvices();
}

async function mcLoadDailyAdvices() {
    const grid = document.getElementById('mc-advice-list');
    if (!grid) return;

        try {
            await _throttledRefresh('daily_advices');
            const advices = (await sync.query('daily_advices', [orderBy('createdAt', 'desc')])) || [];
            if (!advices.length) {
            grid.innerHTML = `
                <div style="grid-column:1/-1;text-align:center;padding:48px;border:3px dashed var(--border);border-radius:16px;color:var(--text-muted);">
                    <span class="material-icons-round" style="font-size:3rem;display:block;margin-bottom:12px;opacity:0.35;">tips_and_updates</span>
                    <div style="font-size:0.85rem;font-weight:800;">No daily advices sent yet.</div>
                    <div style="font-size:0.72rem;margin-top:4px;">Click "+ CREATE DAILY ADVICE" to draft and broadcast advice to students.</div>
                </div>
            `;
            return;
        }

        const catMap = {
            motivation: { label: 'Motivation & Mindset', bg: '#fef3c7', color: '#b45309' },
            exam_tips: { label: 'Exam Strategy', bg: '#fee2e2', color: '#b91c1c' },
            study_hacks: { label: 'Study Hacks', bg: '#e0f2fe', color: '#0369a1' },
            general: { label: 'General Advice', bg: '#f3f4f6', color: '#374151' }
        };

        grid.innerHTML = advices.map(adv => {
            const id = adv.id;
            const dateStr = adv.createdAt?.toDate ? adv.createdAt.toDate().toLocaleDateString('en-NG', { day:'numeric', month:'short', year:'numeric' }) : 'Recently';
            const cat = catMap[adv.category] || { label: 'General Advice', bg: '#f3f4f6', color: '#374151' };
            const snippet = adv.content.length > 120 ? adv.content.substring(0, 120) + '…' : adv.content;

            return `
            <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;border:3px solid var(--text);border-radius:12px;padding:16px;background:var(--bg-card);transition:transform 0.1s, border 0.1s;position:relative;">
                <div>
                    <!-- Category Badge -->
                    <div style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:0.6rem;font-weight:900;text-transform:uppercase;border:1.5px solid var(--text);background:${cat.bg};color:${cat.color};margin-bottom:12px;">
                        ${cat.label}
                    </div>
                    <!-- Title -->
                    <h3 style="font-weight:900;font-size:0.95rem;color:var(--text);margin:0 0 8px 0;line-height:1.3;text-transform:uppercase;font-family:'Poppins',sans-serif;">
                        ${adv.title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
                    </h3>
                    <!-- Snippet -->
                    <p style="font-size:0.75rem;color:var(--text-muted);margin:0 0 16px 0;line-height:1.5;white-space:pre-wrap;word-break:break-word;">
                        ${snippet.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
                    </p>
                </div>
                <!-- Card Footer & Actions -->
                <div style="display:flex;align-items:center;justify-content:space-between;border-top:2px solid var(--border);padding-top:12px;margin-top:auto;">
                    <div style="font-size:0.65rem;color:var(--text-muted);font-weight:700;display:flex;flex-direction:column;gap:2px;">
                        <span>Sent ${dateStr}</span>
                        <span>Audience: ${adv.targetAudience === 'all' ? 'All Users' : 'Subscribers'} (${adv.recipientCount || 0})</span>
                    </div>
                    <div style="display:flex;gap:6px;">
                        <button class="btn btn-outline" onclick="window.mcViewDailyAdviceDetails('${id}')" style="font-size:0.65rem;padding:4px 8px;font-weight:800;border:2px solid var(--text);">VIEW</button>
                        <button class="btn btn-danger" onclick="window.mcDeleteDailyAdvice('${id}', '${adv.title.replace(/'/g, "\\'")}')" style="font-size:0.65rem;padding:4px 8px;font-weight:800;border:2px solid var(--text);"><span class="material-icons-round" style="font-size:0.8rem;">delete</span></button>
                    </div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        console.error(e);
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--text-muted);font-size:0.8rem;">Could not load daily advices.</div>`;
    }
}

window.mcViewDailyAdviceDetails = async function(id) {
    const overlay = document.createElement('div');
    overlay.id = 'ef-advice-details-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);display:flex;align-items:stretch;justify-content:flex-end;z-index:2000;';
    overlay.innerHTML = `
        <div style="width:min(820px,100vw);height:100vh;background:var(--bg-card);display:flex;flex-direction:column;overflow:hidden;border-left:3px solid var(--text);animation:slideInRight .25s cubic-bezier(.16,1,.3,1);">
            <div style="display:flex;align-items:center;gap:14px;padding:20px 24px;border-bottom:2px solid var(--border);flex-shrink:0;">
                <div style="width:44px;height:44px;border-radius:10px;background:rgba(124,58,237,0.08);border:1.5px solid #7c3aed;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span class="material-icons-round" style="color:#7c3aed;">tips_and_updates</span>
                </div>
                <div style="flex:1;min-width:0;">
                    <div id="ef-adv-det-title" style="font-weight:900;font-size:1.05rem;color:var(--text);text-transform:uppercase;">Loading advice details…</div>
                    <div id="ef-adv-det-meta" style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Advice ID: <code style="font-family:var(--font-mono);font-size:0.65rem;">${id}</code></div>
                </div>
                <button onclick="this.closest('#ef-advice-details-overlay').remove()"
                    style="background:var(--bg-inset);border:1.5px solid var(--border);border-radius:8px;cursor:pointer;padding:7px;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            
            <div id="ef-adv-det-body" style="flex:1;overflow-y:auto;padding:24px;display:flex;flex-direction:column;gap:16px;">
                <!-- Full advice body loads here -->
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    try {
        const adv = await sync.doc('daily_advices/' + id);
        if (!adv) throw new Error("Advice document not found.");

        const catMap = {
            motivation: { label: 'Motivation & Mindset', bg: '#fef3c7', color: '#b45309' },
            exam_tips: { label: 'Exam Strategy', bg: '#fee2e2', color: '#b91c1c' },
            study_hacks: { label: 'Study Hacks', bg: '#e0f2fe', color: '#0369a1' },
            general: { label: 'General Advice', bg: '#f3f4f6', color: '#374151' }
        };
        const cat = catMap[adv.category] || { label: 'General Advice', bg: '#f3f4f6', color: '#374151' };
        
        document.getElementById('ef-adv-det-title').textContent = adv.title;

        document.getElementById('ef-adv-det-body').innerHTML = `
            <div style="display:flex;align-items:center;gap:10px;">
                <div style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:6px;font-size:0.65rem;font-weight:900;text-transform:uppercase;border:1.5px solid var(--text);background:${cat.bg};color:${cat.color};">
                    ${cat.label}
                </div>
                <span style="font-size:0.7rem;color:var(--text-muted);font-weight:700;">Audience: ${adv.targetAudience === 'all' ? 'All Users' : 'Subscribers Only'} (${adv.recipientCount || 0} sent)</span>
            </div>
            
            <div style="background:var(--bg-inset);border:3px solid var(--text);border-radius:12px;padding:20px;margin-top:8px;">
                <div style="white-space:pre-wrap;word-break:break-word;font-size:0.85rem;line-height:1.6;font-weight:500;color:var(--text);">
                    ${adv.content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}
                </div>
            </div>
        `;
    } catch (e) {
        console.error(e);
        document.getElementById('ef-adv-det-body').innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.8rem;">Could not load details: ${e.message}</div>`;
    }
};

window.mcDeleteDailyAdvice = function(id, title) {
    window.showEFModal(
        "Delete Daily Advice?",
        `Are you absolutely sure you want to delete the daily advice "${title}"? This will permanently delete it from the dashboard database AND remove it from ALL students' inboxes.`,
        "YES, PURGE IT",
        async () => {
            try {
                // Step 1: Delete the advice document
                await deleteDoc(doc(db, 'daily_advices', id));
                
                // Step 2: Delete all user notification copies using collection group query
                try {
                    const { collectionGroup, getDocs, writeBatch, query, where } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                    const q = query(collectionGroup(db, 'notifications'), where('adviceId', '==', id));
                    const snap = await getDocs(q);
                    
                    if (snap.size > 0) {
                        const docs = snap.docs;
                        const CHUNK = 250;
                        for (let i = 0; i < docs.length; i += CHUNK) {
                            const batch = writeBatch(db);
                            docs.slice(i, i + CHUNK).forEach(d => batch.delete(d.ref));
                            await batch.commit();
                        }
                    }
                } catch (cleanupErr) {
                    // Log but don't block success — the advice doc is already deleted
                    console.warn("Notification cleanup incomplete:", cleanupErr);
                }
                
                window.showEFModal("Purged Successfully", `The advice "${title}" has been deleted and removed from all students' inboxes.`, "OKAY", null, true);
                mcLoadDailyAdvices();
            } catch(e) {
                window.showEFModal("Delete Failed", e.message, "OK", null, true);
            }
        },
        true,
        "CANCEL",
        null
    );
};

window.mcOpenCreateDailyAdviceModal = function() {
    const modal = document.createElement('div');
    modal.id = 'ef-adv-builder-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:3000;animation:fadeIn 0.2s ease;';
    modal.innerHTML = `
        <style>
            .adv-modal-card {
                width: min(720px, 95vw); 
                height: 82vh;
            }
            .adv-meta-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 16px;
            }
            @media (max-width: 600px) {
                .adv-modal-card {
                    width: 100vw !important;
                    height: 100vh !important;
                    max-height: 100vh !important;
                    border: none !important;
                    border-radius: 0 !important;
                    }
                .adv-meta-grid {
                    grid-template-columns: 1fr !important;
                    gap: 12px !important;
                }
                .adv-footer-actions {
                    flex-direction: column !important;
                    gap: 10px !important;
                    width: 100%;
                }
                .adv-footer-actions button {
                    width: 100% !important;
                }
            }
        </style>
        <div class="card adv-modal-card" style="display:flex; flex-direction:column; overflow:hidden; border:4px solid var(--text);background:var(--bg-card); border-radius:16px;">
            <!-- Modal Header -->
            <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:3px solid var(--text); background:var(--bg-card); flex-shrink:0;">
                <div style="font-weight:900; font-size:1.2rem; color:var(--text); text-transform:uppercase; letter-spacing:0.05em; display:flex; align-items:center; gap:8px;">
                    <span class="material-icons-round" style="color:#7c3aed;">tips_and_updates</span> Compose Daily Advice
                </div>
                <button onclick="document.getElementById('ef-adv-builder-modal').remove()" style="background:var(--bg-inset); border:2px solid var(--text);border-radius:8px; cursor:pointer; padding:6px; display:flex; align-items:center;">
                    <span class="material-icons-round" style="font-size:1.1rem; color:var(--text);">close</span>
                </button>
            </div>
            
            <!-- Modal Body -->
            <div style="flex:1; overflow-y:auto; padding:20px; background:var(--bg-card); display:flex; flex-direction:column; gap:16px;">
                <!-- Title -->
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Advice Title</label>
                    <input type="text" id="adv-builder-title" placeholder="e.g. Master Spaced Repetition" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                </div>

                <!-- Grid -->
                <div class="adv-meta-grid">
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Category</label>
                        <select id="adv-builder-category" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                            <option value="motivation">Motivation & Mindset</option>
                            <option value="exam_tips">Exam Strategy</option>
                            <option value="study_hacks">Study Hacks & Tactics</option>
                            <option value="general">General Advice</option>
                        </select>
                    </div>
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Target Audience</label>
                        <select id="adv-builder-audience" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                            <option value="all">All Registered Students</option>
                            <option value="subscribers">Daily Quiz Subscribers Only</option>
                        </select>
                    </div>
                </div>

                <!-- Textarea -->
                <div class="mc-field" style="flex:1; display:flex; flex-direction:column; margin-bottom:0; min-height:180px;">
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Advice Content</label>
                    <textarea id="adv-builder-content" placeholder="Write your cleanly formatted daily advice here. Line breaks and paragraphs are preserved beautifully..." style="flex:1; border:3px solid var(--text); border-radius:8px; padding:12px; font-weight:700; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text); resize:none; font-family:inherit;"></textarea>
                </div>
            </div>
            
            <!-- Modal Footer -->
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:12px; padding:16px 20px; border-top:3px solid var(--text); background:var(--bg-card); flex-shrink:0;">
                <div class="adv-footer-actions" style="display:flex; align-items:center; gap:12px; width:auto;">
                    <button class="btn btn-ghost" onclick="document.getElementById('ef-adv-builder-modal').remove()" style="border:3px solid var(--border); font-weight:900;padding:10px 20px;">CANCEL</button>
                    <button class="btn btn-primary" onclick="window.mcPublishDailyAdvice()" style="font-weight:900; border:3px solid var(--text);padding:10px 24px; background:#7c3aed; border-color:var(--text);">PUBLISH & BROADCAST</button>
                </div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
};

window.mcPublishDailyAdvice = async function() {
    const title = document.getElementById('adv-builder-title')?.value.trim();
    const category = document.getElementById('adv-builder-category')?.value;
    const audience = document.getElementById('adv-builder-audience')?.value;
    const content = document.getElementById('adv-builder-content')?.value.trim();

    if (!title) {
        window.showEFModal("Invalid Title", "Please enter a valid title for the advice.", "OKAY", null, true);
        return;
    }
    if (!content) {
        window.showEFModal("Invalid Content", "Please write some daily advice content.", "OKAY", null, true);
        return;
    }

    const btn = document.querySelector('#ef-adv-builder-modal .btn-primary');
    btn.disabled = true;
    btn.textContent = 'PUBLISHING…';

    try {
        const targetUsersData = (await sync.collection('users')) || [];
        let targetUsers = [];
        if (audience === 'all') {
            targetUsers = targetUsersData;
        } else {
            targetUsers = targetUsersData.filter(d => {
                const subs = d.subscriptions;
                return !subs || subs.dailyQuiz !== false;
            });
        }

        if (!targetUsers.length) {
            window.showEFModal("No Recipients", "There are no students matching your target audience.", "OKAY", null, true);
            btn.disabled = false;
            btn.textContent = 'PUBLISH & BROADCAST';
            return;
        }

        const baseId = doc(collection(db, 'daily_advices')).id;
        const advId = 'adv_' + baseId;

        // Write to daily_advices collection
        await setDoc(doc(db, 'daily_advices', advId), {
            id: advId,
            title,
            category,
            content,
            targetAudience: audience,
            recipientCount: targetUsers.length,
            createdAt: serverTimestamp()
        });

        // Broadcast to student notifications subcollections
        const CHUNK = 250;
        const notifPayload = {
            type: 'advice',
            adviceId: advId,
            title,
            message: content,
            timestamp: new Date()
        };

        for (let i = 0; i < targetUsers.length; i += CHUNK) {
            const chunk = targetUsers.slice(i, i + CHUNK);
            const batch = writeBatch(db);
            chunk.forEach(userDoc => {
                const uid = userDoc.id;
                batch.set(doc(collection(db, `users/${uid}/notifications`)), notifPayload);
            });
            await batch.commit();
        }

        const modal = document.getElementById('ef-adv-builder-modal');
        if (modal) modal.remove();

        await sync.refresh('daily_advices');
        window.showEFModal("Advice Broadcasted", `Daily Advice published and successfully broadcasted to ${targetUsers.length} students!`, "EXCELLENT", null, true);
        mcLoadDailyAdvices();

    } catch (e) {
        console.error(e);
        window.showEFModal("Broadcast Failed", "Could not send advice: " + e.message, "OK", null, true);
        btn.disabled = false;
        btn.textContent = 'PUBLISH & BROADCAST';
    }
};

window.mcRenderDailyAdviceTab = mcRenderDailyAdviceTab;
window.mcLoadDailyAdvices = mcLoadDailyAdvices;

window.mcOpenCreateDailyQuizModal = function(prefill) {
    window.currentBuilderQuestions = (prefill && prefill.questions && prefill.questions.length > 0) 
        ? prefill.questions 
        : [{ question: '', options: ['', '', '', ''], correctIndex: 0, explanation: '', expanded: true }];
    
    const modal = document.createElement('div');
    modal.id = 'ef-dq-builder-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:3000;animation:fadeIn 0.2s ease;';
    modal.innerHTML = `
        <style>
            .dq-modal-card { flex:1; display:flex; flex-direction:column; overflow:hidden; }
            .dq-meta-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; }
            .dq-question-grid-split { display: grid; grid-template-columns: 1fr 2fr; gap: 12px; align-items: start; }
            .dq-toggle-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
            .dq-opt-row { display:flex; align-items:center; gap:6px; }
            .dq-opt-row input { flex:1; min-width:0; }
            .dq-opt-del-btn { flex-shrink:0; padding:3px 6px; font-size:0.6rem; height:28px; }
            @media (max-width: 600px) {
                .dq-meta-grid, .dq-question-grid-split, .dq-toggle-grid { grid-template-columns: 1fr !important; gap: 6px !important; }
                .dq-header-actions-btn { padding: 3px 6px !important; font-size: 0.6rem !important; }
            }
            @media (max-width: 400px) {
                .dq-opt-row { flex-wrap:wrap; gap:4px; }
                .dq-opt-row input { flex:1 1 100%; order:2; }
                .dq-opt-row label { order:1; }
                .dq-opt-row .dq-opt-del-btn { order:3; }
            }
        </style>
        <div class="card dq-modal-card" style="display:flex; flex-direction:column; overflow:hidden; border:none; background:transparent;">
            <!-- Modal Header -->
            <div style="display:flex; align-items:center; gap:10px; padding:8px 14px; border-bottom:2px solid var(--border); background:var(--bg-card); flex-shrink:0;">
                <button onclick="document.getElementById('ef-dq-builder-modal').remove()"
                    style="width:30px;height:30px;border-radius:5px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round" style="font-size:0.9rem;">arrow_back</span>
                </button>
                <div style="width:30px;height:30px;border-radius:5px;background:var(--brand-dim);border:2px solid var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span class="material-icons-round" style="color:var(--brand);font-size:0.9rem;">today</span>
                </div>
                <div style="font-weight:700; font-size:0.85rem; color:var(--text); text-transform:uppercase; flex:1;">Create Daily Quiz</div>
                <button onclick="document.getElementById('ef-dq-builder-modal').remove()"
                    style="width:30px;height:30px;border-radius:5px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round" style="font-size:0.9rem;">close</span>
                </button>
            </div>
            
            <!-- Modal Body -->
            <div style="flex:1; overflow-y:auto; padding:12px; background:var(--bg); display:flex; flex-direction:column; gap:12px;">
                <!-- Quiz Meta Row -->
                <div class="dq-meta-grid">
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Quiz Title</label>
                        <input type="text" id="dq-builder-title" placeholder="e.g. Daily Challenge: Matrices & Vectors" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                    </div>
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Time Limit (Minutes)</label>
                        <input type="number" id="dq-builder-time" value="10" min="1" max="180" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                    </div>
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Max Attempts</label>
                        <input type="number" id="dq-builder-attempts" value="1" min="1" max="10" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                    </div>
                </div>
                
                <hr style="border:0; border-top:3px solid var(--text); margin:4px 0;">
                
                <!-- Smart Bulk Parser Panel -->
                <div id="dq-bulk-import-panel" style="display:none; background:var(--bg-inset); border:3px solid var(--text);border-radius:12px; padding:16px; margin-bottom:12px; animation:popIn 0.25s ease;">
                    <div style="font-weight:900; font-size:0.9rem; text-transform:uppercase; color:#7c3aed; margin-bottom:8px; display:flex; align-items:center; gap:6px;">
                        <span class="material-icons-round">auto_fix_high</span> Smart Bulk Questions Parser
                    </div>
                    <div style="background:var(--bg-card); border:1.5px solid var(--border); border-radius:8px; padding:10px 12px; margin-bottom:12px; font-size:0.7rem; color:var(--text-muted); line-height:1.6;">
                        <strong style="color:var(--text); display:block; margin-bottom:4px;">✅ marks the correct option. Any format works:</strong>
                        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(220px, 1fr)); gap:10px; font-family:var(--font-mono); font-size:0.65rem; margin-top:6px;">
                            <div>1. What is 2+2?<br>A. 3<br>B. ✅4<br>C. 5</div>
                            <div>1. Capital of Nigeria?<br>A. Lagos &nbsp;B. ✅Abuja<br>C. Kano &nbsp;D. Ibadan</div>
                            <div>1. Which gas is absorbed?<br>A. Oxygen B. ✅CO2<br>Explanation: CO2 for photosynthesis</div>
                        </div>
                    </div>
                    <textarea id="dq-bulk-import-textarea" rows="8" placeholder="1. What is the powerhouse of the cell?&#10;A. Nucleus&#10;B. ✅Mitochondria&#10;C. Ribosome&#10;D. Golgi Apparatus&#10;&#10;2. What is 2 + 2?&#10;A. 3  B. ✅4  C. 5  D. 6" style="font-family:var(--font-mono); font-size:0.75rem; width:100%; border:2px solid var(--text); border-radius:8px; padding:10px;box-sizing:border-box; resize:vertical; background:var(--bg-card); color:var(--text);"></textarea>
                    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px;">
                        <button class="btn btn-ghost" onclick="window.mcToggleDQBulkImport()" style="font-size:0.7rem; padding:6px 12px; border:2px solid var(--border);">Cancel</button>
                        <button class="btn btn-primary" onclick="window.mcProcessDQBulkImport()" style="font-size:0.7rem; padding:6px 16px; border:2px solid var(--text);background:#7c3aed; border-color:var(--text);">Analyze & Import</button>
                    </div>
                </div>

                <!-- Questions Header -->
                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
                    <div>
                        <div style="font-weight:900; font-size:1.05rem; text-transform:uppercase; color:var(--text);">Questions Builder</div>
                        <!-- Collapse/Expand Helpers -->
                        <div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
                            <button class="btn btn-ghost" onclick="window.mcCollapseAllBuilderQuestions()" style="font-size:0.62rem; padding:2px 6px; border:1px solid var(--border);font-weight:800; text-transform:uppercase;">Collapse All</button>
                            <button class="btn btn-ghost" onclick="window.mcExpandAllBuilderQuestions()" style="font-size:0.62rem; padding:2px 6px; border:1px solid var(--border);font-weight:800; text-transform:uppercase;">Expand All</button>
                        </div>
                    </div>
                    
                    <div style="display:flex; align-items:center; gap:8px;">
                        <button class="btn btn-outline dq-header-actions-btn" onclick="window.mcToggleDQBulkImport()" style="font-size:0.72rem; padding:6px 12px; border:2px solid #7c3aed; color:#7c3aed;font-weight:800; display:flex; align-items:center; gap:4px;">
                            <span class="material-icons-round" style="font-size:0.95rem;">auto_fix_high</span> Bulk Import
                        </button>
                        <button class="btn btn-primary dq-header-actions-btn" onclick="window.mcAddBuilderQuestion()" style="font-size:0.72rem; padding:6px 12px; border:2px solid var(--text);font-weight:800; display:flex; align-items:center; gap:4px;">
                            <span class="material-icons-round" style="font-size:0.95rem;">add</span> Add Question
                        </button>
                    </div>
                </div>
                
                <!-- Dynamic Questions Container -->
                <div id="dq-builder-questions-list" style="display:flex; flex-direction:column; gap:16px;">
                    <!-- Question blocks go here -->
                </div>
            </div>
            
            <!-- Modal Footer -->
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:10px 16px; border-top:2px solid var(--border); background:var(--bg-card); flex-shrink:0;">
                <button class="btn btn-ghost" onclick="document.getElementById('ef-dq-builder-modal').remove()" style="border:2px solid var(--border); font-weight:700; padding:6px 14px; font-size:0.75rem;">CANCEL</button>
                <button class="btn btn-primary" onclick="window.mcSaveCreatedDailyQuiz()" style="font-weight:700; border:2px solid var(--text); padding:6px 16px; font-size:0.75rem;">SAVE & PUBLISH</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    
    // Pre-fill fields if editing
    if (prefill) {
        const titleInput = document.getElementById('dq-builder-title');
        const timeInput = document.getElementById('dq-builder-time');
        if (titleInput && prefill.title) titleInput.value = prefill.title;
        if (timeInput && prefill.timeLimit) timeInput.value = prefill.timeLimit;
        
        // Update save button for edit mode
        const saveBtn = document.querySelector('#ef-dq-builder-modal .btn-primary');
        if (saveBtn && prefill.saveHandler) {
            saveBtn.onclick = prefill.saveHandler;
            saveBtn.textContent = 'SAVE CHANGES';
        }
    }
    
    window.mcRenderBuilderQuestions();
};

window.mcToggleDQBulkImport = function() {
    const panel = document.getElementById('dq-bulk-import-panel');
    if (panel) {
        const isHidden = panel.style.display === 'none';
        panel.style.display = isHidden ? 'block' : 'none';
        if (isHidden) {
            setTimeout(() => document.getElementById('dq-bulk-import-textarea')?.focus(), 100);
        }
    }
};

window.mcProcessDQBulkImport = function() {
    const textarea = document.getElementById('dq-bulk-import-textarea');
    if (!textarea) return;
    const rawText = textarea.value;
    if (!rawText.trim()) {
        window.showEFModal("Empty Input", "Please paste some multiple choice questions to parse.", "OK", null, true);
        return;
    }
    
    window.mcSyncBuilderStateFromDOM();
    
    const { parsed, errors } = parseMCQBulk(rawText);
    
    if (parsed.length === 0) {
        let errorMsg = "Could not parse any valid multiple choice questions.";
        if (errors.length > 0) {
            errorMsg += "\n\nReason: " + errors[0].reason;
        }
        window.showEFModal("Parsing Failed", errorMsg, "OK", null, true);
        return;
    }
    
    const newQuestions = parsed.map(q => ({
        question: q.question,
        options: q.options,
        correctIndex: q.correctIndex,
        explanation: q.explanation || '',
        expanded: false
    }));
    
    if (window.currentBuilderQuestions.length > 0 && (window.currentBuilderQuestions.length > 1 || window.currentBuilderQuestions[0].question.trim())) {
        window.showEFModal(
            "Import Mode",
            `Successfully parsed ${parsed.length} questions. Choose whether to APPEND these to your current list or REPLACE the entire list.`,
            "APPEND",
            () => {
                window.currentBuilderQuestions.push(...newQuestions);
                // Collapse previous ones, expand newly imported
                window.currentBuilderQuestions.forEach((q, idx) => {
                    q.expanded = idx >= window.currentBuilderQuestions.length - newQuestions.length;
                });
                textarea.value = '';
                document.getElementById('dq-bulk-import-panel').style.display = 'none';
                window.mcRenderBuilderQuestions();
                window.showEFModal("Import Complete", `Appended ${parsed.length} questions successfully!`, "AWESOME", null, true);
            },
            true,
            "REPLACE ALL",
            () => {
                window.currentBuilderQuestions = newQuestions;
                window.currentBuilderQuestions.forEach((q, idx) => {
                    q.expanded = idx === 0;
                });
                textarea.value = '';
                document.getElementById('dq-bulk-import-panel').style.display = 'none';
                window.mcRenderBuilderQuestions();
                window.showEFModal("Import Complete", `Loaded ${parsed.length} questions and replaced the list!`, "AWESOME", null, true);
            }
        );
    } else {
            window.currentBuilderQuestions = newQuestions;
            window.currentBuilderQuestions.forEach((q, idx) => {
            q.expanded = idx === 0;
        });
        textarea.value = '';
        document.getElementById('dq-bulk-import-panel').style.display = 'none';
        window.mcRenderBuilderQuestions();
        window.showEFModal("Import Complete", `Loaded ${parsed.length} parsed questions successfully!`, "AWESOME", null, true);
    }
};

window.mcCollapseAllBuilderQuestions = function() {
    window.mcSyncBuilderStateFromDOM();
    window.currentBuilderQuestions.forEach(q => q.expanded = false);
    window.mcRenderBuilderQuestions();
};

window.mcExpandAllBuilderQuestions = function() {
    window.mcSyncBuilderStateFromDOM();
    window.currentBuilderQuestions.forEach(q => q.expanded = true);
    window.mcRenderBuilderQuestions();
};

window.mcToggleBuilderAccordion = function(qIdx) {
    const body = document.querySelector(`.dq-accordion-body-${qIdx}`);
    const icon = document.querySelector(`.dq-accordion-icon-${qIdx}`);
    if (body && icon) {
        const isCollapsed = body.style.display === 'none';
        body.style.display = isCollapsed ? 'flex' : 'none';
        icon.style.transform = isCollapsed ? 'rotate(0deg)' : 'rotate(-90deg)';
        if (window.currentBuilderQuestions[qIdx]) {
            window.currentBuilderQuestions[qIdx].expanded = isCollapsed;
        }
    }
};

window.mcSyncBuilderStateFromDOM = function() {
    const container = document.getElementById('dq-builder-questions-list');
    if (!container) return;
    
    window.currentBuilderQuestions.forEach((q, qIdx) => {
        // Scoped queries within container are much faster than document-wide
        const qTextEl = container.querySelector(`.dq-question-text-${qIdx}`);
        if (!qTextEl) return; // question not rendered yet
        
        const explTextEl = container.querySelector(`.dq-explanation-text-${qIdx}`);
        const correctSelectEl = container.querySelector(`.dq-correct-select-${qIdx}`);
        const bodyEl = container.querySelector(`.dq-accordion-body-${qIdx}`);
        const iconEl = container.querySelector(`.dq-accordion-icon-${qIdx}`);
        
        q.question = qTextEl.value;
        if (explTextEl) q.explanation = explTextEl.value;
        if (correctSelectEl) q.correctIndex = parseInt(correctSelectEl.value) || 0;
        if (bodyEl) q.expanded = bodyEl.style.display !== 'none';
        if (iconEl && q.expanded !== undefined) {
            iconEl.style.transform = q.expanded ? 'rotate(0deg)' : 'rotate(-90deg)';
        }
        
        // Batch options: 1 querySelectorAll per question instead of N per option
        const optInputs = container.querySelectorAll(`.dq-opt-input-${qIdx}`);
        optInputs.forEach(el => {
            const optIdx = parseInt(el.dataset.optIdx);
            if (!isNaN(optIdx) && optIdx < q.options.length) {
                q.options[optIdx] = el.value;
            }
        });
    });
};

window.mcRenderBuilderQuestions = function() {
    const container = document.getElementById('dq-builder-questions-list');
    if (!container) return;
    
    window.mcSyncBuilderStateFromDOM();
    
    if (window.currentBuilderQuestions.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:32px; border:3px dashed var(--border); border-radius:12px; color:var(--text-muted); font-size:0.75rem;">
                No questions added yet. Click "+ Add Question" or "Bulk Import" to start building your quiz.
            </div>
        `;
        return;
    }
    
    container.innerHTML = window.currentBuilderQuestions.map((q, qIdx) => {
        const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
        const isExpanded = q.expanded !== false;
        
        const optionsHTML = q.options.map((opt, optIdx) => {
            const letter = letters[optIdx] || '';
            const delBtn = q.options.length > 2 
                ? `<button onclick="window.mcRemoveBuilderOption(${qIdx}, ${optIdx})" class="dq-opt-del-btn" style="background:var(--bg-inset); border:2px solid var(--text); border-radius:6px; cursor:pointer; font-weight:800;">DEL</button>` 
                : '';
            return `
            <div class="dq-opt-row">
                <label style="font-weight:900; font-size:0.8rem; color:var(--text); width:20px;">${letter}.</label>
                <input type="text" class="dq-opt-input-${qIdx}" data-opt-idx="${optIdx}" value="${opt.replace(/"/g, '&quot;')}" placeholder="Option ${letter}" style="flex:1; min-width:0; border:2px solid var(--text); border-radius:6px; padding:6px 10px; font-size:0.78rem; font-weight:600; background:var(--bg-card); color:var(--text); box-sizing:border-box;">
                ${delBtn}
            </div>
            `;
        }).join('');
        
        const correctDropdownHTML = `
        <select class="dq-correct-select-${qIdx}" style="border:2px solid var(--text); border-radius:6px; padding:6px 10px; font-size:0.78rem; font-weight:800; width:100%; margin-bottom:0;background:var(--bg-card); color:var(--text);">
            ${q.options.map((_, optIdx) => {
                const letter = letters[optIdx] || '';
                return `<option value="${optIdx}" ${q.correctIndex === optIdx ? 'selected' : ''}>Option ${letter}</option>`;
            }).join('')}
        </select>
        `;
        
        return `
        <div class="card" style="padding:16px; border:3px solid var(--text);background:var(--bg-inset); position:relative; display:flex; flex-direction:column; gap:0;">
            <!-- Accordion Header -->
            <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%;">
                <div style="display:flex; align-items:center; gap:6px; flex:1; min-width:0; cursor:pointer; user-select:none;" onclick="window.mcToggleBuilderAccordion(${qIdx})">
                    <span class="material-icons-round dq-accordion-icon-${qIdx}" style="font-size:1.3rem; color:var(--text); transition:transform 0.2s; ${isExpanded ? '' : 'transform:rotate(-90deg);'}">expand_more</span>
                    <div style="font-weight:900; font-size:0.8rem; text-transform:uppercase; color:var(--brand); flex-shrink:0;">Q #${qIdx + 1}</div>
                    <span class="dq-accordion-preview-${qIdx}" style="font-size:0.72rem; font-weight:700; color:var(--text-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; margin-left:4px;">
                        ${q.question ? q.question.replace(/</g,'&lt;').replace(/>/g,'&gt;') : 'Empty question statement…'}
                    </span>
                </div>
                <button onclick="window.mcRemoveBuilderQuestion(${qIdx})" style="background:rgba(220,38,38,0.06); border:2px solid var(--brand); border-radius:6px; cursor:pointer; padding:4px 8px; color:var(--brand); font-weight:800; font-size:0.65rem; display:flex; align-items:center; gap:2px;flex-shrink:0;">
                    <span class="material-icons-round" style="font-size:0.8rem;">delete</span> REMOVE
                </button>
            </div>
            
            <!-- Accordion Body -->
            <div class="dq-accordion-body-${qIdx}" style="display:${isExpanded ? 'flex' : 'none'}; flex-direction:column; gap:12px; margin-top:14px; border-top:2px solid var(--text); padding-top:14px;">
                <!-- Question text -->
                <div>
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.65rem; color:var(--text-muted); margin-bottom:4px; display:block;">Question Statement</label>
                    <textarea class="dq-question-text-${qIdx}" rows="2" placeholder="Write the question here..." oninput="document.querySelector('.dq-accordion-preview-${qIdx}').textContent = this.value || 'Empty question statement…'" style="border:2px solid var(--text); border-radius:6px; padding:8px 10px; font-size:0.8rem; font-weight:700; width:100%; box-sizing:border-box;background:var(--bg-card); color:var(--text);">${q.question}</textarea>
                </div>
                
                <!-- Options section -->
                <div>
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.65rem; color:var(--text-muted);">Answer Options</label>
                        ${q.options.length < 6 ? `
                        <button onclick="window.mcAddBuilderOption(${qIdx})" style="background:var(--bg-card); border:2px solid var(--text); border-radius:6px; cursor:pointer; padding:3px 8px; font-weight:800; font-size:0.65rem; color:var(--text); display:flex; align-items:center; gap:2px;">
                            <span class="material-icons-round" style="font-size:0.8rem;">add</span> Add Option
                        </button>
                        ` : ''}
                    </div>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        ${optionsHTML}
                    </div>
                </div>
                
                <!-- Correct Index & Explanation -->
                <div class="dq-question-grid-split">
                    <div>
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.65rem; color:var(--text-muted); margin-bottom:4px; display:block;">Correct Answer</label>
                        ${correctDropdownHTML}
                    </div>
                    <div>
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.65rem; color:var(--text-muted); margin-bottom:4px; display:block;">Explanation (Detailed Solution)</label>
                        <input type="text" class="dq-explanation-text-${qIdx}" value="${q.explanation.replace(/"/g, '&quot;')}" placeholder="e.g. Using the formula x = -b/2a, we get..." style="border:2px solid var(--text); border-radius:6px; padding:6px 10px; font-size:0.8rem; font-weight:600; width:100%; box-sizing:border-box;background:var(--bg-card); color:var(--text);">
                    </div>
                </div>
            </div>
        </div>
        `;
    }).join('');
};

window.mcAddBuilderQuestion = function() {
    window.mcSyncBuilderStateFromDOM();
    window.currentBuilderQuestions.push({ question: '', options: ['', '', '', ''], correctIndex: 0, explanation: '', expanded: true });
    window.mcRenderBuilderQuestions();
    
    // Smooth scroll new question into view
    setTimeout(() => {
        const cards = document.querySelectorAll('#dq-builder-questions-list > .card');
        if (cards.length > 0) {
            cards[cards.length - 1].scrollIntoView({ behavior: 'smooth' });
        }
    }, 100);
};

window.mcRemoveBuilderQuestion = function(qIdx) {
    window.mcSyncBuilderStateFromDOM();
    window.currentBuilderQuestions.splice(qIdx, 1);
    window.mcRenderBuilderQuestions();
};

window.mcAddBuilderOption = function(qIdx) {
    window.mcSyncBuilderStateFromDOM();
    if (window.currentBuilderQuestions[qIdx].options.length < 6) {
        window.currentBuilderQuestions[qIdx].options.push('');
    }
    window.mcRenderBuilderQuestions();
};

window.mcRemoveBuilderOption = function(qIdx, optIdx) {
    window.mcSyncBuilderStateFromDOM();
    const q = window.currentBuilderQuestions[qIdx];
    if (q.options.length > 2) {
        q.options.splice(optIdx, 1);
        if (q.correctIndex >= q.options.length) {
            q.correctIndex = q.options.length - 1;
        }
    }
    window.mcRenderBuilderQuestions();
};

window.mcSaveCreatedDailyQuiz = async function() {
    const title = document.getElementById('dq-builder-title')?.value.trim();
    const time = parseInt(document.getElementById('dq-builder-time')?.value) || 10;
    
    window.mcSyncBuilderStateFromDOM();
    
    if (!title) {
        window.showEFModal("Invalid Title", "Please enter a valid title for the daily quiz.", "OKAY", null, true);
        return;
    }
    if (time <= 0 || time > 180) {
        window.showEFModal("Invalid Time", "Please enter a valid time limit (between 1 and 180 minutes).", "OKAY", null, true);
        return;
    }
    if (window.currentBuilderQuestions.length === 0) {
        window.showEFModal("Empty Quiz", "Please add at least one question to the quiz.", "OKAY", null, true);
        return;
    }
    
    for (let i = 0; i < window.currentBuilderQuestions.length; i++) {
        const q = window.currentBuilderQuestions[i];
        if (!q.question.trim()) {
            window.showEFModal("Missing Content", `Question #${i + 1} has no statement text.`, "OKAY", null, true);
            return;
        }
        for (let j = 0; j < q.options.length; j++) {
            if (!q.options[j].trim()) {
                window.showEFModal("Missing Option", `Option #${j + 1} in Question #${i + 1} is empty.`, "OKAY", null, true);
                return;
            }
        }
    }
    
    const saveBtn = document.querySelector('#ef-dq-builder-modal .btn-primary');
    saveBtn.disabled = true;
    saveBtn.textContent = 'SAVING…';
    
    try {
        const baseId = doc(collection(db, 'daily_quizzes')).id;
        const dqid = 'dq_' + baseId;
        const qDocRef = doc(db, 'daily_quizzes', dqid);
        
        const maxAttempts = parseInt(document.getElementById('dq-builder-attempts')?.value) || 1;
        
        await setDoc(qDocRef, {
            id: dqid,
            title,
            questions: window.currentBuilderQuestions,
            timeLimit: time,
            maxAttempts: maxAttempts,
            createdAt: serverTimestamp()
        });
        
        const modal = document.getElementById('ef-dq-builder-modal');
        if (modal) modal.remove();
        
        window.showEFModal("Quiz Published", "Your new daily quiz has been saved and published successfully!", "AWESOME", null, true);
        await sync.refresh('daily_quizzes');
        mcLoadDailyQuizzes();
        mcLoadDailyQuizSubCount();
        
    } catch (e) {
        console.error(e);
        window.showEFModal("Save Failed", "Could not publish quiz: " + e.message, "OK", null, true);
        saveBtn.disabled = false;
        saveBtn.textContent = 'SAVE & PUBLISH';
    }
};

window.mcViewDailyQuizDetails = async function(dqid) {
    const overlay = document.createElement('div');
    overlay.id = 'ef-dq-details-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:2000;animation:fadeIn 0.2s ease;';
    overlay.innerHTML = `
        <div style="display:flex;flex-direction:column;overflow:hidden;flex:1;">
            <div style="display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:2px solid var(--border);background:var(--bg-card);flex-shrink:0;">
                <button onclick="this.closest('#ef-dq-details-overlay').remove()"
                    style="width:30px;height:30px;border-radius:5px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round" style="font-size:0.9rem;">arrow_back</span>
                </button>
                <div style="width:30px;height:30px;border-radius:5px;background:rgba(22,163,74,0.08);border:2px solid #16a34a;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span class="material-icons-round" style="color:#16a34a;font-size:0.9rem;">today</span>
                </div>
                <div style="flex:1;min-width:0;">
                    <div id="ef-dq-det-title" style="font-weight:700;font-size:0.85rem;color:var(--text);">Loading Quiz details…</div>
                    <div id="ef-dq-det-meta" style="font-size:0.6rem;color:var(--text-muted);margin-top:1px;"></div>
                </div>
                <button onclick="this.closest('#ef-dq-details-overlay').remove()"
                    style="width:30px;height:30px;border-radius:5px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round" style="font-size:0.9rem;">close</span>
                </button>
            </div>
            
            <div id="ef-dq-det-body" style="flex:1;overflow-y:auto;padding:14px;background:var(--bg);display:flex;flex-direction:column;gap:14px;">
                <div style="text-align:center;padding:32px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;">autorenew</span>
                    <div style="margin-top:12px;font-size:0.8rem;">Fetching quiz metadata and student attempts…</div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    
    try {
        const q = await sync.doc('daily_quizzes/' + dqid);
        if (!q) {
            document.getElementById('ef-dq-det-body').innerHTML = `<div style="text-align:center;padding:32px;color:var(--brand);font-weight:900;">Quiz not found.</div>`;
            return;
        }
        document.getElementById('ef-dq-det-title').textContent = q.title;
        document.getElementById('ef-dq-det-title').style.fontSize = '0.75rem';
        document.getElementById('ef-dq-det-meta').innerHTML = `${q.questions?.length || 0} questions · ${q.timeLimit || 10} min`;
        
        const quizShareUrl = window.location.origin + '/quiz?dqid=' + dqid;
        
        const attempts = (await sync.query('daily_quizzes/' + dqid + '/attempts', [orderBy('timestamp', 'desc')])) || [];

        const attemptCount = attempts.length;
        let avgScore = 0;
        if (attemptCount > 0) {
            avgScore = Math.round(attempts.reduce((sum, a) => sum + (a.score || 0), 0) / attemptCount);
        }
        
        let attemptsHTML = '';
        if (attemptCount === 0) {
            attemptsHTML = `
            <div style="text-align:center;padding:48px 24px;border:2px dashed var(--border);border-radius:10px;color:var(--text-muted);font-size:0.8rem;">
                <span class="material-icons-round" style="font-size:2.4rem;opacity:0.25;display:block;margin-bottom:8px;">people_outline</span>
                <strong style="color:var(--text);">No attempts recorded yet</strong>
                <div style="margin-top:4px;">Students will show up here as soon as they complete the quiz using the shareable link.</div>
            </div>`;
        } else {
            const tableRows = attempts.map(a => {
                const date = a.timestamp?.toDate ? a.timestamp.toDate().toLocaleString() : 'Recently';
                const timeStr = a.timeTaken ? `${Math.floor(a.timeTaken / 60)}m ${a.timeTaken % 60}s` : 'Unknown';
                const scoreColor = a.score >= 80 ? '#16a34a' : a.score >= 50 ? '#2563eb' : 'var(--brand)';
                return `
                <tr style="border-bottom:1.5px solid var(--border);">
                    <td style="padding:12px;font-size:0.8rem;font-weight:800;color:var(--text);">
                        ${a.displayName}
                        <div style="font-size:0.68rem;font-weight:600;color:var(--text-muted);">${a.email}</div>
                    </td>
                    <td style="padding:12px;font-size:0.82rem;font-weight:900;color:${scoreColor};">
                        ${a.score}%
                        <div style="font-size:0.65rem;color:var(--text-muted);font-weight:600;">${a.correct || 0} / ${a.totalQuestions || 0}</div>
                    </td>
                    <td style="padding:12px;font-size:0.75rem;font-weight:700;color:var(--text-muted);">${timeStr}</td>
                    <td style="padding:12px;font-size:0.7rem;font-weight:600;color:var(--text-muted);">${date}</td>
                </tr>`;
            }).join('');
            
            attemptsHTML = `
            <div style="border:2px solid var(--text);border-radius:10px;overflow-x:auto;background:var(--bg-card);">
                <table style="width:100%;min-width:500px;border-collapse:collapse;text-align:left;">
                    <thead>
                        <tr style="background:var(--bg-inset);border-bottom:3px solid var(--text);">
                            <th style="padding:12px;font-size:0.7rem;font-weight:900;text-transform:uppercase;color:var(--text);">Student</th>
                            <th style="padding:12px;font-size:0.7rem;font-weight:900;text-transform:uppercase;color:var(--text);">Score</th>
                            <th style="padding:12px;font-size:0.7rem;font-weight:900;text-transform:uppercase;color:var(--text);">Duration</th>
                            <th style="padding:12px;font-size:0.7rem;font-weight:900;text-transform:uppercase;color:var(--text);">Submitted</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${tableRows}
                    </tbody>
                </table>
            </div>`;
        }
        
        let subscriberCount = 0;
        try {
            const usersArr = (await sync.collection('users')) || [];
            subscriberCount = usersArr.filter(d => {
                return !d.subscriptions || d.subscriptions.dailyQuiz !== false;
            }).length;
        } catch (_) {}
        
        document.getElementById('ef-dq-det-body').innerHTML = `
            <!-- Share URL Banner -->
            <div style="background:var(--bg-inset);border:2px solid var(--text);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;">
                <div style="font-weight:900;font-size:0.8rem;text-transform:uppercase;color:var(--text);display:flex;align-items:center;gap:6px;">
                    <span class="material-icons-round" style="color:var(--brand);">link</span> Unique Quiz URL (Cryptic)
                </div>
                <div style="display:flex;align-items:center;gap:8px;background:var(--bg-card);border:2px solid var(--text);border-radius:8px;padding:8px 12px;overflow:hidden;">
                    <span style="font-size:0.72rem;font-family:var(--font-mono);color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${quizShareUrl}</span>
                    <button onclick="window.copyShareLink('${quizShareUrl.replace(/'/g,"\\'")}', this)"
                        style="flex-shrink:0;background:var(--bg-inset);border:2px solid var(--text);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:0.68rem;font-weight:800;color:var(--text);display:flex;align-items:center;gap:4px;">
                        <span class="material-icons-round" style="font-size:0.85rem;">content_copy</span> Copy Link
                    </button>
                </div>
            </div>
            
            <!-- Summary Stats -->
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div style="background:var(--bg-card);border:2px solid var(--text);border-radius:12px;padding:10px;text-align:center;">
                    <div data-ac style="font-size:1.5rem;font-weight:900;color:var(--text);">${attemptCount}</div>
                    <div style="font-size:0.65rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Total Attempts</div>
                </div>
                <div style="background:var(--bg-card);border:2px solid var(--text);border-radius:12px;padding:10px;text-align:center;">
                    <div data-aa style="font-size:1.5rem;font-weight:900;color:#16a34a;">${avgScore}%</div>
                    <div style="font-size:0.65rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Average Accuracy</div>
                </div>
            </div>
            
            <!-- Broadcast Section -->
            <div style="background:rgba(37,99,235,0.04);border:2px solid var(--text);border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:10px;">
                <div style="font-weight:900;font-size:0.9rem;text-transform:uppercase;color:var(--text);display:flex;align-items:center;gap:6px;">
                    <span class="material-icons-round" style="color:#2563eb;">send</span> Broadcast to Subscribers
                </div>
                <p style="font-size:0.75rem;color:var(--text-muted);line-height:1.5;margin:0;">
                    Push this quiz immediately to all <strong>${subscriberCount} subscribed students'</strong> dashboards, notification feeds, and study schedules.
                </p>
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800;text-transform:uppercase;font-size:0.65rem;color:var(--text-muted);margin-bottom:4px;display:block;">Optional Broadcast Invitation Message</label>
                    <textarea id="dq-broadcast-msg" rows="2" placeholder="Good morning! Today's quiz is ready. You have ${q.timeLimit || 10} minutes. Good luck!" style="border:2px solid var(--text);border-radius:8px;padding:8px 12px;font-size:0.78rem;font-weight:600;width:100%;box-sizing:border-box;"></textarea>
                </div>
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800;text-transform:uppercase;font-size:0.65rem;color:var(--text-muted);margin-bottom:4px;display:block;">Valid For</label>
                    <select id="dq-broadcast-duration" style="border:2px solid var(--text);border-radius:8px;padding:8px 12px;font-size:0.78rem;font-weight:700;width:100%;box-sizing:border-box;background:var(--bg-card);color:var(--text);">
                        <option value="1">1 Day</option>
                        <option value="3" selected>3 Days</option>
                        <option value="7">1 Week</option>
                        <option value="14">2 Weeks</option>
                        <option value="30">1 Month</option>
                        <option value="90">3 Months</option>
                    </select>
                </div>
                <button class="btn btn-primary" id="btn-dq-broadcast" onclick="window.mcBroadcastDailyQuiz('${dqid}', '${subscriberCount}')" style="font-weight:800;border:2px solid var(--text);padding:8px 16px;display:flex;align-items:center;justify-content:center;gap:4px;font-size:0.75rem;">
                    <span class="material-icons-round" style="font-size:0.95rem;">send</span> BROADCAST
                </button>
            </div>
            
            <!-- Student Attempts Table -->
            <div>
                <div style="font-weight:900;font-size:0.8rem;text-transform:uppercase;color:var(--text);margin-bottom:8px;">
                    <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span class="material-icons-round" style="color:var(--text-muted);">analytics</span> Student Attempts History
                    </div>
                </div>
                ${attemptCount > 0 ? `
                <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">
                    <button id="btn-export-csv" class="btn btn-outline btn-sm" style="padding:4px 10px;font-size:0.65rem;font-weight:800;display:flex;align-items:center;gap:3px;cursor:pointer;background:var(--bg-card);border:2px solid var(--text);border-radius:6px;">
                        <span class="material-icons-round" style="font-size:0.85rem;">download</span> CSV
                    </button>
                    <button id="btn-export-pdf" class="btn btn-outline btn-sm" style="padding:4px 10px;font-size:0.65rem;font-weight:800;display:flex;align-items:center;gap:3px;cursor:pointer;background:var(--bg-card);border:2px solid var(--text);border-radius:6px;">
                        <span class="material-icons-round" style="font-size:0.85rem;">picture_as_pdf</span> PDF
                    </button>
                </div>
                ` : ''}
                <div data-at style="overflow-x:auto;border:2px solid var(--text);border-radius:8px;">
                ${attemptsHTML}
                </div>
            </div>
        `;

        // ── Real-time attempts listener ──
        const attemptsQuery = query(collection(db, 'daily_quizzes', dqid, 'attempts'), orderBy('timestamp', 'desc'));
        let attemptsListener = onSnapshot(attemptsQuery, (snap) => {
            const newAttempts = snap.docs.map(d => d.data());
            const newCount = newAttempts.length;
            let newAvg = 0;
            if (newCount > 0) {
                newAvg = Math.round(newAttempts.reduce((s, a) => s + (a.score || 0), 0) / newCount);
            }
            
            // Update summary stats
            const countEl = document.getElementById('ef-dq-det-body')?.querySelector('[data-ac]');
            const avgEl = document.getElementById('ef-dq-det-body')?.querySelector('[data-aa]');
            if (countEl) countEl.textContent = newCount;
            if (avgEl) avgEl.textContent = newAvg + '%';
            
            // Rebuild table rows
            const tbody = document.getElementById('ef-dq-det-body')?.querySelector('table tbody');
            if (!tbody) return;
            
            if (newCount === 0) {
                tbody.innerHTML = '';
                const container = tbody.closest('[data-at]');
                if (container) {
                    container.innerHTML = `<div style="text-align:center;padding:48px 24px;border:2px dashed var(--border);border-radius:10px;color:var(--text-muted);font-size:0.8rem;">
                        <span class="material-icons-round" style="font-size:2.4rem;opacity:0.25;display:block;margin-bottom:8px;">people_outline</span>
                        <strong style="color:var(--text);">No attempts recorded yet</strong>
                        <div style="margin-top:4px;">Students will show up here as soon as they complete the quiz.</div>
                    </div>`;
                }
                return;
            }
            
            tbody.innerHTML = newAttempts.map(a => {
                const date = a.timestamp?.toDate ? a.timestamp.toDate().toLocaleString() : 'Recently';
                const timeStr = a.timeTaken ? `${Math.floor(a.timeTaken / 60)}m ${a.timeTaken % 60}s` : 'Unknown';
                const scoreColor = a.score >= 80 ? '#16a34a' : a.score >= 50 ? '#2563eb' : 'var(--brand)';
                return `
                <tr style="border-bottom:1.5px solid var(--border);">
                    <td style="padding:12px;font-size:0.8rem;font-weight:800;color:var(--text);">
                        ${a.displayName}
                        <div style="font-size:0.68rem;font-weight:600;color:var(--text-muted);">${a.email}</div>
                    </td>
                    <td style="padding:12px;font-size:0.82rem;font-weight:900;color:${scoreColor};">${a.score}%
                        <div style="font-size:0.65rem;color:var(--text-muted);font-weight:600;">${a.correct || 0} / ${a.totalQuestions || 0}</div>
                    </td>
                    <td style="padding:12px;font-size:0.75rem;font-weight:700;color:var(--text-muted);">${timeStr}</td>
                    <td style="padding:12px;font-size:0.7rem;font-weight:600;color:var(--text-muted);">${date}</td>
                </tr>`;
            }).join('');
        });
        
        // Clean up listener when overlay is removed
        const detOverlay = document.getElementById('ef-dq-details-overlay');
        if (detOverlay) {
            const origClose = detOverlay.remove.bind(detOverlay);
            detOverlay.remove = function() {
                if (attemptsListener) attemptsListener();
                origClose();
            };
        }

        if (attemptCount > 0) {
            document.getElementById('btn-export-csv')?.addEventListener('click', () => {
                const headers = ['Student Name', 'Email', 'Score (%)', 'Correct Answers', 'Total Questions', 'Duration', 'Submitted At'];
                const rows = attempts.map(a => {
                    const date = a.timestamp?.toDate ? a.timestamp.toDate().toLocaleString() : 'Recently';
                    const timeStr = a.timeTaken ? `${Math.floor(a.timeTaken / 60)}m ${a.timeTaken % 60}s` : 'Unknown';
                    return [
                        `"${(a.displayName || 'Anonymous').replace(/"/g, '""')}"`,
                        `"${(a.email || 'N/A').replace(/"/g, '""')}"`,
                        a.score,
                        a.correct || 0,
                        a.totalQuestions || 0,
                        `"${timeStr}"`,
                        `"${date}"`
                    ];
                });
                
                const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.setAttribute('href', url);
                link.setAttribute('download', `Daily_Quiz_${dqid}_Attempts.csv`);
                link.style.visibility = 'hidden';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            });

            document.getElementById('btn-export-pdf')?.addEventListener('click', async () => {
                const btn = document.getElementById('btn-export-pdf');
                const origHTML = btn.innerHTML;
                btn.disabled = true;
                btn.innerHTML = '<span class="material-icons-round" style="animation:spin 1s linear infinite;font-size:0.95rem;vertical-align:middle;">autorenew</span> Exporting…';
                
                try {
                    await new Promise((resolve, reject) => {
                        if (window.jspdf) return resolve();
                        const s = document.createElement('script');
                        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });
                    await new Promise((resolve, reject) => {
                        if (window.jspdf_plugin_autotable || (window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API.autoTable)) return resolve();
                        const s = document.createElement('script');
                        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.29/jspdf.plugin.autotable.min.js';
                        s.onload = resolve;
                        s.onerror = reject;
                        document.head.appendChild(s);
                    });

                    const { jsPDF } = window.jspdf;
                    const doc = new jsPDF();

                    // Beautiful Modern Scoreboard Styling
                    doc.setFont("helvetica", "bold");
                    doc.setFontSize(18);
                    doc.setTextColor(33, 33, 33);
                    doc.text("ExamForge Daily Quiz Scoreboard", 14, 20);
                    
                    doc.setFont("helvetica", "normal");
                    doc.setFontSize(10);
                    doc.setTextColor(100, 100, 100);
                    doc.text(`Daily Quiz: ${q.title || 'Details'}`, 14, 27);
                    doc.text(`Quiz ID: ${dqid}  |  Exported: ${new Date().toLocaleString()}`, 14, 32);
                    
                    doc.setDrawColor(220, 220, 220);
                    doc.line(14, 36, 196, 36);
                    
                    doc.setFont("helvetica", "bold");
                    doc.setFontSize(11);
                    doc.setTextColor(33, 33, 33);
                    doc.text("Performance Summary:", 14, 44);
                    doc.setFont("helvetica", "normal");
                    doc.setFontSize(10);
                    doc.text(`Total Student Attempts: ${attemptCount}`, 14, 50);
                    doc.text(`Average Accuracy Rate: ${avgScore}%`, 14, 56);
                    
                    doc.line(14, 62, 196, 62);

                    const tableBody = attempts.map(a => {
                        const date = a.timestamp?.toDate ? a.timestamp.toDate().toLocaleString() : 'Recently';
                        const timeStr = a.timeTaken ? `${Math.floor(a.timeTaken / 60)}m ${a.timeTaken % 60}s` : 'Unknown';
                        return [
                            a.displayName || 'Anonymous',
                            a.email || 'N/A',
                            `${a.score}%`,
                            `${a.correct || 0} / ${a.totalQuestions || 0}`,
                            timeStr,
                            date
                        ];
                    });

                    doc.autoTable({
                        head: [['Student Name', 'Email Address', 'Score', 'Accuracy', 'Duration', 'Submission Date']],
                        body: tableBody,
                        startY: 68,
                        styles: { fontSize: 8, font: 'helvetica', cellPadding: 4 },
                        headStyles: { fillColor: [124, 58, 237], textColor: [255, 255, 255], fontStyle: 'bold' },
                        alternateRowStyles: { fillColor: [249, 250, 251] },
                        margin: { left: 14, right: 14 }
                    });

                    doc.save(`Daily_Quiz_${dqid}_Attempts.pdf`);
                } catch (err) {
                    console.error(err);
                    alert("Failed to export PDF: " + err.message);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = origHTML;
                }
            });
        }

        
    } catch (e) {
        console.error(e);
        document.getElementById('ef-dq-det-body').innerHTML = `<div style="text-align:center;padding:32px;color:var(--brand);font-weight:900;">Failed to load attempts: ${e.message}</div>`;
    }
};

window.mcBroadcastDailyQuiz = async function(dqid, subCount) {
    const btn = document.getElementById('btn-dq-broadcast');
    if (!btn) return;
    
    btn.disabled = true;
    const originalHTML = btn.innerHTML;
    btn.innerHTML = `<span class="material-icons-round" style="font-size:1.1rem;animation:spin 1s linear infinite;display:inline-block;vertical-align:middle;">autorenew</span> BROADCASTING…`;
    
    try {
        const q = await sync.doc('daily_quizzes/' + dqid);
        if (!q) throw new Error("Quiz not found.");
        
        const messageInput = document.getElementById('dq-broadcast-msg')?.value.trim();
        const customMessage = messageInput || `Your Daily Quiz '${q.title}' is ready. You have ${q.timeLimit} minutes. Good luck!`;
        
        const durationDays = parseInt(document.getElementById('dq-broadcast-duration')?.value) || 3;
        const today = new Date();
        const expiryDate = new Date(today);
        expiryDate.setDate(expiryDate.getDate() + durationDays);
        const year = expiryDate.getFullYear();
        const month = String(expiryDate.getMonth() + 1).padStart(2, '0');
        const day = String(expiryDate.getDate()).padStart(2, '0');
        const dueTs = new Date(`${year}-${month}-${day}T23:59:00`);
        
        const quizUrl = `quiz.html?dqid=${dqid}`;
        
        const usersArr = await sync.collection('users');
        const subscribers = usersArr.filter(d => {
            return !d.subscriptions || d.subscriptions.dailyQuiz !== false;
        });
        
        if (!subscribers.length) {
            window.showEFModal("No Subscribers", "There are no students subscribed to daily quizzes at this time.", "OKAY", null, true);
            btn.disabled = false;
            btn.innerHTML = originalHTML;
            return;
        }
        
        const CHUNK = 250;
        const broadcastId = `dq_${Date.now()}`;
        const notifPayload = {
            type:      'daily_quiz',
            title:     q.title,
            message:   customMessage,
            quizUrl:   quizUrl,
            dueDate:   `${year}-${month}-${day}`,
            dueTime:   '23:59',
            timestamp: new Date()
        };
        const schedPayload = {
            type:         'daily_quiz',
            course:       q.title,
            quizUrl:      quizUrl,
            dueDate:      `${year}-${month}-${day}`,
            dueTime:      '23:59',
            dueTimestamp: dueTs,
            timeLimit:    q.timeLimit || 10,
            message:      customMessage,
            broadcastId,
            timestamp:    new Date()
        };
        
        for (let i = 0; i < subscribers.length; i += CHUNK) {
            const chunk = subscribers.slice(i, i + CHUNK);
            const batch = writeBatch(db);
            chunk.forEach(userDoc => {
                const uid = userDoc.id;
                batch.set(doc(collection(db, `users/${uid}/schedule`)), schedPayload);
                batch.set(doc(collection(db, `users/${uid}/notifications`)), notifPayload);
            });
            await batch.commit();
        }
        
        await addDoc(collection(db, 'daily_quiz_broadcasts'), {
            broadcastId,
            title:        q.title,
            quizUrl:      quizUrl,
            message:      customMessage,
            dueDate:      `${year}-${month}-${day}`,
            dueTime:      '23:59',
            recipientCount: subscribers.length,
            sentBy:       auth.currentUser?.uid || 'admin',
            timestamp:    new Date()
        });
        
        btn.innerHTML = `<span class="material-icons-round" style="font-size:1.1rem;vertical-align:middle;">check_circle</span> BROADCAST SUCCESSFUL!`;
        btn.style.background = '#16a34a';
        
        window.showEFModal("Broadcast Successful", `Successfully scheduled & sent notifications to all ${subscribers.length} subscribed students.`, "EXCELLENT", null, true);
        mcRenderDailyQuizTab();
        
    } catch (e) {
        console.error(e);
        window.showEFModal("Broadcast Failed", e.message, "OK", null, true);
        btn.disabled = false;
        btn.innerHTML = originalHTML;
    }
};

window.mcDeleteDailyQuiz = function(dqid, title) {
    window.showEFModal(
        "Purge Daily Quiz?",
        `Are you absolutely sure you want to delete the daily quiz "${title}"? This will permanently wipe it out and clear all student attempts logged for this quiz.`,
        "DELETE",
        async () => {
            try {
                await deleteDoc(doc(db, 'daily_quizzes', dqid));
                mcLoadDailyQuizzes();
                window.showEFModal("Quiz Purged", "The daily quiz was successfully deleted.", "OK", null, true);
            } catch (e) {
                console.error(e);
                window.showEFModal("Delete Failed", e.message, "OK", null, true);
            }
        }
    );
};

// ── Edit an existing daily quiz ──
window.mcOpenEditDailyQuizModal = async function(dqid) {
    try {
        const data = await sync.doc('daily_quizzes/' + dqid);
        if (!data) {
            return window.showEFModal("Not Found", "Daily quiz not found.", "OK", null, true);
        }
        
        // Prepare questions with proper expanded state
        const questions = (data.questions || []).map(q => ({ ...q, expanded: false }));
        if (questions.length > 0) questions[0].expanded = true;
        
        // Build save handler for edit mode
        const saveHandler = async () => {
            const title = document.getElementById('dq-builder-title')?.value.trim();
            const time = parseInt(document.getElementById('dq-builder-time')?.value) || 10;
            window.mcSyncBuilderStateFromDOM();
            
            if (!title || window.currentBuilderQuestions.length === 0) {
                return window.showEFModal("Validation", "Please enter a title and add questions.", "OK", null, true);
            }
            
            const saveBtn = document.querySelector('#ef-dq-builder-modal .btn-primary');
            if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'SAVING…'; }
            
            try {
                const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                await updateDoc(doc(db, 'daily_quizzes', dqid), {
                    title,
                    questions: window.currentBuilderQuestions,
                    timeLimit: time
                });
                
                document.getElementById('ef-dq-builder-modal')?.remove();
                window.showEFModal("Updated", "Daily quiz updated successfully!", "OK", null, true);
                mcLoadDailyQuizzes();
            } catch (e) {
                console.error(e);
                window.showEFModal("Error", e.message, "OK", null, true);
                if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'SAVE CHANGES'; }
            }
        };
        
        // Open builder with pre-filled data — no setTimeout needed, no wasted render
        window.mcOpenCreateDailyQuizModal({
            title: data.title,
            timeLimit: data.timeLimit,
            questions: questions,
            saveHandler: saveHandler
        });
        
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcRenderDailyQuizTab = mcRenderDailyQuizTab;
window.mcLoadDailyQuizzes = mcLoadDailyQuizzes;
window.mcDeleteDailyQuiz = mcDeleteDailyQuiz;
window.mcViewDailyQuizDetails = mcViewDailyQuizDetails;
window.mcBroadcastDailyQuiz = mcBroadcastDailyQuiz;
window.mcOpenCreateDailyQuizModal = mcOpenCreateDailyQuizModal;
window.mcOpenEditDailyQuizModal = mcOpenEditDailyQuizModal;
window.mcAddBuilderQuestion = mcAddBuilderQuestion;
window.mcRemoveBuilderQuestion = mcRemoveBuilderQuestion;
window.mcAddBuilderOption = mcAddBuilderOption;
window.mcRemoveBuilderOption = mcRemoveBuilderOption;
window.mcSyncBuilderStateFromDOM = mcSyncBuilderStateFromDOM;
window.mcRenderBuilderQuestions = mcRenderBuilderQuestions;
window.mcSaveCreatedDailyQuiz = mcSaveCreatedDailyQuiz;

function mcBreadcrumb() {
    return `<div class="mc-breadcrumb">
        ${mcCrumbs.map((c,i) => {
            const isActive = i === mcCrumbs.length - 1;
            const clickHandler = isActive ? '' : `onclick="window.mcRenderCoursesTab(${c.courseId ? `'${c.courseId}'` : ''}${c.topicId ? `, '${c.topicId}'` : ''})"`;
            return `
                <span class="mc-crumb ${isActive ? 'active' : ''}" ${clickHandler}>${c.label}</span>
                ${i < mcCrumbs.length-1 ? '<span class="mc-sep">›</span>' : ''}
            `;
        }).join('')}
    </div>`;
}

window.mcRenderCoursesTab = mcRenderCoursesTab;
window.mcDrillCourse = (courseId) => { masterTab = 'courses'; mcRenderCoursesTab(courseId); };
window.mcDrillTopic  = (courseId, topicId) => { masterTab = 'courses'; mcRenderCoursesTab(courseId, topicId); };

// ── Topic Results Viewer ───────────────────────────────────────
window.mcViewTopicResults = async function(courseId, topicId) {
    const quizId = `${courseId}:${topicId}`;
    const topicLabel = topicId.replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());

    const overlay = document.createElement('div');
    overlay.id = 'ef-results-details-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);display:flex;align-items:stretch;justify-content:flex-end;z-index:2000;';
    overlay.innerHTML = `
        <div style="width:min(820px,100vw);height:100vh;background:var(--bg-card);display:flex;flex-direction:column;overflow:hidden;border-left:3px solid var(--text);animation:slideInRight .25s cubic-bezier(.16,1,.3,1);">
            <div style="display:flex;align-items:center;gap:14px;padding:20px 24px;border-bottom:2px solid var(--border);flex-shrink:0;">
                <div style="width:44px;height:44px;border-radius:10px;background:rgba(22,163,74,0.08);border:1.5px solid #16a34a;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span class="material-icons-round" style="color:#16a34a;">bar_chart</span>
                </div>
                <div style="flex:1;min-width:0;">
                    <div style="font-weight:900;font-size:1.05rem;color:var(--text);">Results — ${topicLabel}</div>
                    <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">${courseId.toUpperCase()} · Quiz ID: <code style="font-family:var(--font-mono);font-size:0.65rem;">${quizId}</code></div>
                </div>
                <button onclick="this.closest('#ef-results-details-overlay').remove()"
                    style="background:var(--bg-inset);border:1.5px solid var(--border);border-radius:8px;cursor:pointer;padding:7px;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            <div id="mctr-body" style="flex:1;overflow-y:auto;padding:24px;">
                <div style="text-align:center;padding:56px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;">autorenew</span>
                    <div style="margin-top:12px;font-size:0.8rem;">Scanning all user results…</div>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    try {
        // collectionGroup query across all users' results subcollections
        const data = await sync.collectionGroup('results', [where('quizId','==',quizId)]);

        const body = document.getElementById('mctr-body');
        if (!body) return;

        if (data.length === 0) {
            body.innerHTML = `
                <div style="text-align:center;padding:72px 24px;color:var(--text-muted);">
                    <span class="material-icons-round" style="font-size:3rem;display:block;margin-bottom:12px;opacity:0.25;">people_outline</span>
                    <div style="font-weight:800;font-size:0.9rem;margin-bottom:4px;">No results yet</div>
                    <div style="font-size:0.75rem;">Nobody has submitted this quiz yet.</div>
                </div>`;
            return;
        }

        // Each result doc path is users/{uid}/results/{resultId}
        const rows = data.map(d => ({
            ...d,
            uid: d._refPath.split('/')[1] // users/{uid}/results/{id}
        })).sort((a,b) => (b.score||0) - (a.score||0));

        // Fetch user display names in parallel (deduplicated)
        const uids = [...new Set(rows.map(r=>r.uid))];
        const userNames = {};
        await Promise.all(uids.map(async uid => {
            try {
                const d = await sync.doc('users/' + uid);
                if (d) {
                    userNames[uid] = d.displayName || d.username || d.email?.split('@')[0] || uid.slice(0,8);
                } else { userNames[uid] = uid.slice(0,8); }
            } catch { userNames[uid] = uid.slice(0,8); }
        }));

        // Summary stats
        const scores = rows.map(r=>r.score||0);
        const avg    = Math.round(scores.reduce((a,b)=>a+b,0)/scores.length);
        const top    = Math.max(...scores);
        const pass   = scores.filter(s=>s>=50).length;

        const gradeColor = g => g==='A'?'#16a34a':g==='B'?'#2563eb':g==='C'?'#d97706':g==='D'?'#ea580c':'#dc2626';

        body.innerHTML = `
            <!-- Summary chips -->
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:10px;margin-bottom:24px;">
                <div style="background:var(--bg-inset);border:1.5px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:1.4rem;font-weight:900;color:var(--text);">${rows.length}</div>
                    <div style="font-size:0.6rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Submissions</div>
                </div>
                <div style="background:var(--bg-inset);border:1.5px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:1.4rem;font-weight:900;color:var(--text);">${avg}%</div>
                    <div style="font-size:0.6rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Avg Score</div>
                </div>
                <div style="background:var(--bg-inset);border:1.5px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:1.4rem;font-weight:900;color:#16a34a;">${top}%</div>
                    <div style="font-size:0.6rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Top Score</div>
                </div>
                <div style="background:var(--bg-inset);border:1.5px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:1.4rem;font-weight:900;color:#2563eb;">${Math.round(pass/rows.length*100)}%</div>
                    <div style="font-size:0.6rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Pass Rate</div>
                </div>
            </div>

            <!-- Table -->
            <div style="overflow-x:auto;border:1.5px solid var(--border);border-radius:12px;">
                <table style="width:100%;border-collapse:collapse;font-size:0.8rem;">
                    <thead>
                        <tr style="background:var(--bg-inset);border-bottom:2px solid var(--border);">
                            <th style="padding:10px 14px;text-align:left;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);white-space:nowrap;">#</th>
                            <th style="padding:10px 14px;text-align:left;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Student</th>
                            <th style="padding:10px 14px;text-align:center;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Score</th>
                            <th style="padding:10px 14px;text-align:center;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Grade</th>
                            <th style="padding:10px 14px;text-align:center;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Correct</th>
                            <th style="padding:10px 14px;text-align:center;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Time</th>
                            <th style="padding:10px 14px;text-align:left;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Date</th>
                            <th style="padding:10px 14px;text-align:center;font-size:0.65rem;font-weight:900;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);">Retake</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((r,i) => {
                            const timeFmt = r.timeTaken ? `${Math.floor(r.timeTaken/60)}m ${r.timeTaken%60}s` : '—';
                            const gc = gradeColor(r.grade||'F');
                            const rowBg = i%2===0?'background:var(--bg-card)':'background:var(--bg-inset)';
                            return `
                            <tr style="${rowBg};border-bottom:1px solid var(--border);">
                                <td style="padding:10px 14px;color:var(--text-muted);font-weight:700;">${i+1}</td>
                                <td style="padding:10px 14px;">
                                    <div style="font-weight:800;color:var(--text);">${userNames[r.uid]||'Unknown'}</div>
                                    <div style="font-size:0.62rem;color:var(--text-muted);font-family:var(--font-mono);">${r.uid.slice(0,10)}…</div>
                                </td>
                                <td style="padding:10px 14px;text-align:center;">
                                    <div style="font-weight:900;font-size:0.95rem;color:${r.score>=50?'#16a34a':'#dc2626'};">${r.score||0}%</div>
                                </td>
                                <td style="padding:10px 14px;text-align:center;">
                                    <span style="font-weight:900;font-size:0.85rem;color:${gc};background:${gc}15;padding:2px 8px;border-radius:5px;border:1px solid ${gc};">${r.grade||'F'}</span>
                                </td>
                                <td style="padding:10px 14px;text-align:center;font-weight:700;color:var(--text);">
                                    ${r.correct??'—'}/${r.totalQuestions??'—'}
                                </td>
                                <td style="padding:10px 14px;text-align:center;font-size:0.75rem;color:var(--text-muted);font-family:var(--font-mono);">${timeFmt}</td>
                                <td style="padding:10px 14px;font-size:0.72rem;color:var(--text-muted);white-space:nowrap;">${r.date||'—'}</td>
                                <td style="padding:10px 14px;text-align:center;">
                                    ${r.isRetake?'<span style="font-size:0.6rem;font-weight:900;padding:1px 6px;border-radius:3px;background:rgba(245,158,11,0.1);color:#d97706;border:1px solid #d97706;">Retake</span>':'<span style="color:var(--text-muted);font-size:0.7rem;">—</span>'}
                                </td>
                            </tr>`;
                        }).join('')}
                    </tbody>
                </table>
            </div>
            <div style="text-align:center;padding:12px;font-size:0.65rem;color:var(--text-muted);">
                Sorted by score (highest first) · ${rows.length} submission${rows.length!==1?'s':''}
            </div>`;

    } catch(e) {
        console.error(e);
        const body = document.getElementById('mctr-body');
        if (body) body.innerHTML = `<div style="text-align:center;padding:48px;color:var(--brand);font-size:0.85rem;">
            Failed to load results: ${e.message}<br><small style="color:var(--text-muted);">Make sure collectionGroup index is enabled in Firebase Console.</small></div>`;
    }
};

// ── CREATE MODALS ─────────────────────────────────────────────

window.mcOpenCreateCourseModal = function() {
    const overlay = document.createElement('div');
    overlay.className = 'mc-modal-overlay';
    overlay.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:var(--brand);">add_circle</span> New Course</h3>
            <div class="mc-field">
                <label>Course ID <span style="font-weight:600;text-transform:none;color:var(--text-muted);">(e.g. mth101)</span></label>
                <input type="text" id="mc-new-course-id" placeholder="mth101" autocomplete="off">
            </div>
            <div class="mc-field">
                <label>Course Title</label>
                <input type="text" id="mc-new-course-title" placeholder="Elementary Mathematics I">
            </div>
            <div class="mc-field">
                <label>Level</label>
                <select id="mc-new-course-level">
                    <option value="100L">100L</option><option value="200L">200L</option>
                    <option value="300L">300L</option><option value="400L">400L</option>
                    <option value="500L">500L</option>
                </select>
            </div>
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:2px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="mc-save-course-btn">Create Course</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    document.getElementById('mc-save-course-btn').onclick = async () => {
        const id = document.getElementById('mc-new-course-id').value.toLowerCase().trim().replace(/\s+/g,'-');
        const title = document.getElementById('mc-new-course-title').value.trim();
        const level = document.getElementById('mc-new-course-level').value;
        if (!id || !title) return alert('Please fill all fields.');
        try {
            await setDoc(doc(db,'unicourses',id), { title, level, createdAt: new Date() });
            overlay.remove();
            mcRenderCoursesTab();
            mcLoadStats();
        } catch (e) { alert('Error: ' + e.message); }
    };
};

window.mcOpenCreateTopicModal = function(courseId) {
    const overlay = document.createElement('div');
    overlay.className = 'mc-modal-overlay';
    overlay.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#2563eb;">add_circle</span> New Topic — ${courseId.toUpperCase()}</h3>
            <div class="mc-field">
                <label>Topic ID <span style="font-weight:600;text-transform:none;color:var(--text-muted);">(e.g. complex-numbers)</span></label>
                <input type="text" id="mc-new-topic-id" placeholder="complex-numbers" autocomplete="off">
            </div>
            <div class="mc-field">
                <label>Display Title</label>
                <input type="text" id="mc-new-topic-title" placeholder="Complex Numbers">
            </div>
            <div class="mc-field">
                <label>Time Limit (minutes)</label>
                <input type="number" id="mc-new-topic-time" placeholder="40" min="1" value="40">
            </div>
            ${mcTopicToggleFields()}
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:2px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="mc-save-topic-btn">Create Topic</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    mcBindTopicToggles();
    document.getElementById('mc-save-topic-btn').onclick = async () => {
        const id = document.getElementById('mc-new-topic-id').value.toLowerCase().trim().replace(/\s+/g,'-');
        const title = document.getElementById('mc-new-topic-title').value.trim();
        const timeLimit = parseInt(document.getElementById('mc-new-topic-time').value) || 40;
        if (!id) return alert('Topic ID is required.');
        try {
            await setDoc(doc(db,'unicourses',courseId,'topics',id), {
                title: title || id,
                timeLimit,
                isStrict:     document.getElementById('mc-tog-strict').checked,
                isMock:       document.getElementById('mc-tog-mock').checked,
                isCorrection: !document.getElementById('mc-tog-nocorrection').checked,
                isPrivate:    document.getElementById('mc-tog-private').checked,
                questions: []
            });
            overlay.remove();
            mcRenderCoursesTab(courseId);
            mcLoadStats();
        } catch (e) { alert('Error: ' + e.message); }
    };
};

window.mcOpenCreateQuestionModal = function(courseId, topicId) {
    const overlay = document.createElement('div');
    overlay.className = 'mc-modal-overlay';
    overlay.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#16a34a;">add_circle</span> Add Question</h3>
            <div class="mc-field">
                <label>Question</label>
                <textarea id="mc-q-text" rows="3" placeholder="Type the question here…"></textarea>
            </div>
            <div class="mc-field">
                <label>Options</label>
                <div class="mc-opts-grid">
                    <input type="text" id="mc-opt-0" placeholder="A — Option 1">
                    <input type="text" id="mc-opt-1" placeholder="B — Option 2">
                    <input type="text" id="mc-opt-2" placeholder="C — Option 3">
                    <input type="text" id="mc-opt-3" placeholder="D — Option 4">
                </div>
            </div>
            <div class="mc-field">
                <label>Correct Answer</label>
                <select id="mc-correct-idx">
                    <option value="0">A — Option 1</option>
                    <option value="1">B — Option 2</option>
                    <option value="2">C — Option 3</option>
                    <option value="3">D — Option 4</option>
                </select>
            </div>
            <div class="mc-field">
                <label>Explanation <span style="font-weight:600;text-transform:none;color:var(--text-muted);">(optional)</span></label>
                <textarea id="mc-q-explanation" rows="2" placeholder="Brief explanation of the correct answer…"></textarea>
            </div>
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:2px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="mc-save-q-btn">Save Question</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    // Live-update select labels as user types options
    [0,1,2,3].forEach(i => {
        const letters = ['A','B','C','D'];
        document.getElementById(`mc-opt-${i}`).oninput = () => {
            const sel = document.getElementById('mc-correct-idx');
            sel.options[i].text = `${letters[i]} — ${document.getElementById(`mc-opt-${i}`).value || 'Option '+(i+1)}`;
        };
    });

    document.getElementById('mc-save-q-btn').onclick = async () => {
        const question = document.getElementById('mc-q-text').value.trim();
        const options = [0,1,2,3].map(i => document.getElementById(`mc-opt-${i}`).value.trim());
        const correctIndex = parseInt(document.getElementById('mc-correct-idx').value);
        const explanation = document.getElementById('mc-q-explanation').value.trim();
        if (!question || options.some(o=>!o)) return alert('Please fill in the question and all 4 options.');
        const newQ = { id: Date.now(), question, options, correctIndex, explanation };
        try {
            // Read current questions from sync cache (0 reads if cached), append, write back
            const topicData = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
            const updatedQuestions = [...(topicData?.questions || []), newQ];
            await setDoc(doc(db, 'unicourses', courseId, 'topics', topicId),
                { questions: updatedQuestions },
                { merge: true });
            overlay.remove();
            mcRenderCoursesTab(courseId, topicId);
            mcLoadStats();
        } catch (e) { alert('Error: ' + e.message); }
    };
};

// ── TOPIC TOGGLE HELPERS ──────────────────────────────────────

function mcTopicToggleFields(data = {}) {
    const tog = (id, label, desc, color, checked) => `
        <label style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:2px solid ${checked ? color : 'var(--border)'};border-radius:8px;cursor:pointer;transition:border-color 0.15s;margin-bottom:8px;background:${checked ? `${color}10` : 'transparent'};" id="mc-tog-wrap-${id}">
            <input type="checkbox" id="mc-tog-${id}" ${checked ? 'checked' : ''} style="width:16px;height:16px;margin-top:1px;accent-color:${color};flex-shrink:0;">
            <div>
                <div style="font-weight:800;font-size:0.8rem;color:var(--text);">${label}</div>
                <div style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">${desc}</div>
            </div>
        </label>`;
    return `
        <div class="mc-field" style="margin-top:4px;">
            <label>Behaviour Flags</label>
            ${tog('strict',      '🔒 Strict Mode',          'Forces exam mode only — practice option is hidden.',                           '#dc2626', !!data.isStrict)}
            ${tog('mock',        '🎭 Mock Exam',             'Must be taken as exam. Student score and answers are hidden after submission.', '#7c3aed', !!data.isMock)}
            ${tog('nocorrection','🚫 Disable Corrections',   'Hides the correction/review screen after the exam.',                           '#d97706', data.isCorrection === false)}
            ${tog('private',     '🔐 Private / Restricted',  'Hidden from the Exam Library. Only accessible via direct link or Schedule.',   '#0f766e', !!data.isPrivate)}
        </div>`;
}

function mcBindTopicToggles() {
    const colorMap = { strict: '#dc2626', mock: '#7c3aed', nocorrection: '#d97706', private: '#0f766e' };
    ['strict','mock','nocorrection','private'].forEach(id => {
        const cb = document.getElementById(`mc-tog-${id}`);
        const wrap = document.getElementById(`mc-tog-wrap-${id}`);
        if (!cb || !wrap) return;
        const update = () => {
            wrap.style.borderColor = cb.checked ? colorMap[id] : 'var(--border)';
            wrap.style.background  = cb.checked ? `${colorMap[id]}10` : 'transparent';
        };
        cb.addEventListener('change', update);
    });
}

window.mcOpenEditTopicModal = async function(courseId, topicId) {
    // Fetch current values first
    let data = {};
    try {
        data = await sync.doc('unicourses/' + courseId + '/topics/' + topicId) || {};
    } catch(e) { alert('Could not load topic: ' + e.message); return; }

    const overlay = document.createElement('div');
    overlay.className = 'mc-modal-overlay';
    overlay.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#2563eb;">tune</span> Edit Topic Settings</h3>
            <div class="mc-field">
                <label>Display Title</label>
                <input type="text" id="mc-edit-topic-title" value="${(data.title||'').replace(/"/g,'&quot;')}">
            </div>
            <div class="mc-field">
                <label>Time Limit (minutes)</label>
                <input type="number" id="mc-edit-topic-time" value="${data.timeLimit || 40}" min="1">
            </div>
            ${mcTopicToggleFields(data)}
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:2px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="mc-update-topic-btn">Save Changes</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    mcBindTopicToggles();

    document.getElementById('mc-update-topic-btn').onclick = async () => {
        const title     = document.getElementById('mc-edit-topic-title').value.trim();
        const timeLimit = parseInt(document.getElementById('mc-edit-topic-time').value) || 40;
        const btn = document.getElementById('mc-update-topic-btn');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            await updateDoc(doc(db,'unicourses',courseId,'topics',topicId), {
                title,
                timeLimit,
                isStrict:     document.getElementById('mc-tog-strict').checked,
                isMock:       document.getElementById('mc-tog-mock').checked,
                isCorrection: !document.getElementById('mc-tog-nocorrection').checked,
                isPrivate:    document.getElementById('mc-tog-private').checked,
            });
            overlay.remove();
            // Refresh whichever level is currently visible
            mcRenderCoursesTab(courseId, topicId || null);
        } catch (e) { btn.disabled = false; btn.textContent = 'Save Changes'; alert('Error: ' + e.message); }
    };
};

window.mcOpenEditQuestionModal = async function(courseId, topicId, questionIndex) {
    let questions = [];
    try {
        const subData = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
        if (subData) questions = subData.questions || [];
    } catch(e) { alert('Could not load questions: ' + e.message); return; }

    const q = questions[questionIndex];
    if (!q) return;
    const letters = ['A','B','C','D'];

    const overlay = document.createElement('div');
    overlay.className = 'mc-modal-overlay';
    overlay.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#16a34a;">edit</span> Edit Question ${questionIndex + 1}</h3>
            <div class="mc-field">
                <label>Question</label>
                <textarea id="mc-eq-text" rows="3">${q.question || ''}</textarea>
            </div>
            <div class="mc-field">
                <label>Options</label>
                <div class="mc-opts-grid">
                    ${[0,1,2,3].map(i => `<input type="text" id="mc-eq-opt-${i}" value="${(q.options||[])[i]||''}" placeholder="${letters[i]} — Option ${i+1}">`).join('')}
                </div>
            </div>
            <div class="mc-field">
                <label>Correct Answer</label>
                <select id="mc-eq-correct">
                    ${[0,1,2,3].map(i => `<option value="${i}" ${q.correctIndex===i?'selected':''}>${letters[i]} — ${(q.options||[])[i]||'Option '+(i+1)}</option>`).join('')}
                </select>
            </div>
            <div class="mc-field">
                <label>Explanation <span style="font-weight:600;text-transform:none;color:var(--text-muted);">(optional)</span></label>
                <textarea id="mc-eq-explanation" rows="2">${q.explanation || ''}</textarea>
            </div>
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:2px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="mc-update-q-btn">Save Changes</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    // Live-update correct answer select labels
    [0,1,2,3].forEach(i => {
        document.getElementById(`mc-eq-opt-${i}`).oninput = () => {
            const sel = document.getElementById('mc-eq-correct');
            sel.options[i].text = `${letters[i]} — ${document.getElementById(`mc-eq-opt-${i}`).value || 'Option '+(i+1)}`;
        };
    });

    document.getElementById('mc-update-q-btn').onclick = async () => {
        const question    = document.getElementById('mc-eq-text').value.trim();
        const options     = [0,1,2,3].map(i => document.getElementById(`mc-eq-opt-${i}`).value.trim());
        const correctIndex = parseInt(document.getElementById('mc-eq-correct').value);
        const explanation = document.getElementById('mc-eq-explanation').value.trim();
        if (!question || options.some(o=>!o)) return alert('Please fill in the question and all 4 options.');

        const btn = document.getElementById('mc-update-q-btn');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            // Read latest questions array, splice the edited one in, write back
            const tRef = doc(db,'unicourses',courseId,'topics',topicId);
            const latest = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
            const qs = [...((latest && latest.questions) || [])];
            qs[questionIndex] = { ...qs[questionIndex], question, options, correctIndex, explanation };
            await updateDoc(tRef, { questions: qs });
            await sync.refresh('unicourses/' + courseId + '/topics/' + topicId);
            overlay.remove();
            mcRenderCoursesTab(courseId, topicId);
        } catch (e) { btn.disabled = false; btn.textContent = 'Save Changes'; alert('Error: ' + e.message); }
    };
};

// ── BULK IMPORT ───────────────────────────────────────────────

/**
 * Smart MCQ Parser
 * Handles every real-world format:
 *
 * FORMAT 1 — Numbered, lettered options, ✅ marks correct
 *   1. What is 2+2?
 *   A. 3   B. ✅4   C. 5   D. 6
 *
 * FORMAT 2 — Options on separate lines
 *   1) What is the capital of Nigeria?
 *   A) Lagos
 *   B) ✅Abuja
 *   C) Kano
 *   D) Ibadan
 *
 * FORMAT 3 — Inline answer key at the end
 *   1. What is H2O?
 *   A. Hydrogen  B. Carbon  C. ✅Water  D. Oxygen
 *   Answer: C
 *
 * FORMAT 4 — "Ans:" / "Answer:" / "Key:" separate line
 *   Q1. What is NaCl?
 *   (a) Sugar  (b) ✅Salt  (c) Sand  (d) Soap
 *   Ans: b
 *
 * FORMAT 5 — No letters at all, just bullet/dash/star lines, ✅ marks correct
 *   What is the powerhouse of the cell?
 *   - Nucleus
 *   - ✅Mitochondria
 *   - Ribosome
 *   - Golgi apparatus
 *
 * FORMAT 6 — Mixed separators (dot, paren, colon, dash, slash)
 *   1/ What force keeps planets in orbit?
 *   A/ Magnetism   B/ ✅Gravity   C/ Friction   D/ Tension
 *
 * FORMAT 7 — Explanation after question block (Explanation: / Note: / Hint:)
 *   1. Which gas do plants absorb?
 *   A. Oxygen  B. Nitrogen  C. ✅Carbon Dioxide  D. Hydrogen
 *   Explanation: Plants use CO2 for photosynthesis.
 */
function parseMCQBulk(rawText) {
    const parsed = [];
    const errors = [];

    // Normalise line endings, collapse 3+ blank lines to 2
    const text = rawText.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');

    // Split into question blocks — separated by blank lines OR by a new question number
    // A new question starts with: number followed by . ) / : or "Q" prefix
    const blocks = splitIntoBlocks(text);

    blocks.forEach((block, bi) => {
        try {
            const q = parseBlock(block.trim());
            if (q) parsed.push(q);
            else errors.push({ num: bi + 1, block: block.trim().substring(0, 60), reason: 'Could not identify question or options' });
        } catch (e) {
            errors.push({ num: bi + 1, block: block.trim().substring(0, 60), reason: e.message });
        }
    });

    return { parsed, errors };
}

function splitIntoBlocks(text) {
    // Split on blank lines first
    const byBlank = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

    // Further split any block that contains multiple question starters
    const qStartRe = /^(?:Q\s*\d+[\.\)\/:\-]?|\d+[\.\)\/:\-])\s+\S/im;
    const multiQRe  = /\n(?=(?:Q\s*)?\d+[\.\)\/:\-]\s)/;

    const blocks = [];
    byBlank.forEach(block => {
        const lines = block.split('\n');
        // Count how many lines look like question starters
        const qLines = lines.filter(l => /^(?:Q\s*)?\d+[\.\)\/:\-]\s/i.test(l.trim()));
        if (qLines.length > 1) {
            // Multiple questions merged — split on question-number pattern
            const sub = block.split(multiQRe).map(b => b.trim()).filter(Boolean);
            blocks.push(...sub);
        } else {
            blocks.push(block);
        }
    });

    return blocks.filter(b => b.length > 0);
}

function parseBlock(block) {
    if (!block) return null;
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return null;

    // ── Step 1: Strip question number from first line ─────────────
    let questionText = lines[0];
    questionText = questionText.replace(/^(?:Q(?:uestion)?\s*)?\d+[\.\)\/:\-\s]+/i, '').trim();
    if (!questionText) {
        // Question text might be on next line (number on its own line)
        questionText = lines[1].replace(/^(?:Q(?:uestion)?\s*)?\d+[\.\)\/:\-\s]+/i, '').trim();
        lines.splice(0, 1); // remove the number-only line
    }

    // ── Step 2: Separate option lines, answer lines, explanation ──
    // Option line patterns: A. / A) / A/ / (A) / a. / a) etc. OR bullet/dash/star lines
    const optionLineRe = /^(?:\(?[A-Da-d][\.\)\/:\-]\)?|[-•*➤▶→])\s*/;
    const answerLineRe = /^(?:ans(?:wer)?|key|correct)[\s:\-]+([A-Da-d\d])/i;
    const explLineRe   = /^(?:expl(?:anation)?|note|hint|solution|reason)[\s:\-]+/i;

    const optionLines = [];
    let answerKey = null; // 0-indexed
    let explanation = '';
    const remainingLines = lines.slice(1); // skip question line

    remainingLines.forEach(line => {
        if (answerLineRe.test(line)) {
            const m = line.match(answerLineRe);
            if (m) {
                const raw = m[1].trim().toUpperCase();
                if (/[A-D]/.test(raw)) answerKey = raw.charCodeAt(0) - 65; // A=0,B=1...
                else answerKey = parseInt(raw) - 1; // "1","2"...
            }
        } else if (explLineRe.test(line)) {
            explanation = line.replace(explLineRe, '').trim();
        } else if (optionLineRe.test(line)) {
            optionLines.push(line);
        } else if (optionLines.length === 0 && line.length > 3) {
            // Could be options crammed onto one line: "A. x  B. y  C. z  D. w"
            // Try to split it
            const inlineOpts = splitInlineOptions(line);
            if (inlineOpts.length >= 2) {
                optionLines.push(...inlineOpts);
            }
        }
        // else: continuation of explanation or noise — ignore
    });

    // ── Step 3: Handle options jammed on one line after question line ──
    // e.g. "What is 2+2?  A. 3  B. ✅4  C. 5  D. 6"
    if (optionLines.length === 0) {
        const inlineInQuestion = splitInlineOptions(questionText);
        if (inlineInQuestion.length >= 2) {
            // Question text is everything before the first option marker
            const firstOptMatch = questionText.match(/\(?[A-Da-d][\.\)\/:\-]/);
            if (firstOptMatch) {
                const splitIdx = questionText.indexOf(firstOptMatch[0]);
                const optsPart = questionText.slice(splitIdx);
                questionText = questionText.slice(0, splitIdx).trim();
                optionLines.push(...splitInlineOptions(optsPart));
            }
        }
    }

    if (optionLines.length < 2) return null; // not a valid MCQ

    // ── Step 4: Parse each option — strip label, detect ✅ ───────
    const checkEmojis = /✅|☑|✔|✓/;
    const options = [];
    let correctIndex = answerKey; // may already be set from answer line

    optionLines.forEach((line, i) => {
        // Strip option label: A. / A) / (A) / A/ / - / • etc.
        let text = line.replace(/^\(?[A-Da-d][\.\)\/:\-]\)?\s*/i, '')
                       .replace(/^[-•*➤▶→]\s*/, '')
                       .trim();

        // Check for ✅ anywhere in the text
        if (checkEmojis.test(text)) {
            correctIndex = i;
            text = text.replace(checkEmojis, '').trim();
        }

        // Also handle trailing "(correct)" or "*" marker
        if (/\*$|\(correct\)$/i.test(text)) {
            correctIndex = i;
            text = text.replace(/\*$|\(correct\)$/i, '').trim();
        }

        options.push(text);
    });

    // ── Step 5: Validate ─────────────────────────────────────────
    if (!questionText || options.length < 2) return null;
    if (options.some(o => !o)) return null; // empty option
    if (correctIndex === null || correctIndex < 0 || correctIndex >= options.length) {
        // Last resort: if exactly one option is suspiciously different (e.g. bold, ALL CAPS),
        // we can't determine — default to 0 but flag it
        correctIndex = 0;
    }

    return {
        id: Date.now() + Math.random(),
        question: questionText,
        options: options.slice(0, 4), // cap at 4
        correctIndex,
        explanation
    };
}

function splitInlineOptions(line) {
    // Split "A. foo  B. bar  C. baz  D. qux" or "(a) foo (b) bar ..."
    // Strategy: split on option label pattern that appears mid-string
    const parts = line.split(/(?=\(?[A-Da-d][\.\)\/:\-]\)?)/i).filter(Boolean);
    if (parts.length >= 2) return parts.map(p => p.trim()).filter(Boolean);
    return [];
}

window.mcOpenBulkImportModal = function(courseId, topicId) {
    const existing = document.getElementById('mc-bulk-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'mc-bulk-overlay';
    overlay.className = 'mc-modal-overlay';
    overlay.style.zIndex = '1100';
    overlay.innerHTML = `
        <div class="mc-modal" style="max-width:680px;">
            <h3>
                <span class="material-icons-round" style="color:#7c3aed;">upload_file</span>
                Bulk Import Questions
            </h3>

            <div style="background:var(--bg-inset);border:1px dashed var(--border);border-radius:10px;padding:14px 16px;margin-bottom:16px;font-size:0.75rem;color:var(--text-muted);line-height:1.7;">
                <strong style="color:var(--text);display:block;margin-bottom:6px;">✅ marks the correct option. Any format works:</strong>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px 16px;font-family:var(--font-mono);font-size:0.68rem;">
                    <div><em>Separate lines:</em><br>1. What is 2+2?<br>A. 3<br>B. ✅4<br>C. 5<br>D. 6</div>
                    <div><em>Inline options:</em><br>1. Capital of Nigeria?<br>A. Lagos &nbsp;B. ✅Abuja<br>C. Kano &nbsp;D. Ibadan</div>
                    <div style="margin-top:8px;"><em>With explanation:</em><br>1. H2O is?<br>A. Acid &nbsp;B. ✅Water<br>Explanation: Water is H2O</div>
                    <div style="margin-top:8px;"><em>Answer key line:</em><br>1. NaCl is?<br>A. Sugar B. Salt<br>C. Sand D. Soap<br>Answer: B</div>
                </div>
            </div>

            <div class="mc-field">
                <label>Paste your questions below</label>
                <textarea id="mc-bulk-input" rows="14"
                    style="font-family:var(--font-mono);font-size:0.8rem;resize:vertical;"
                    placeholder="1. What is the powerhouse of the cell?&#10;A. Nucleus&#10;B. ✅Mitochondria&#10;C. Ribosome&#10;D. Golgi Apparatus&#10;&#10;2. What is 2 + 2?&#10;A. 3  B. ✅4  C. 5  D. 6"></textarea>
            </div>

            <div id="mc-bulk-preview" style="display:none;"></div>

            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:2px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-outline" style="flex:1;border:2px solid #7c3aed;color:#7c3aed;" id="mc-bulk-parse-btn">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">auto_fix_high</span> Preview
                </button>
                <button class="btn btn-primary" style="flex:2;display:none;" id="mc-bulk-save-btn">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">save</span> Save All
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    let parsedQuestions = [];

    document.getElementById('mc-bulk-parse-btn').onclick = () => {
        const raw = document.getElementById('mc-bulk-input').value;
        if (!raw.trim()) return;

        const { parsed, errors } = parseMCQBulk(raw);
        parsedQuestions = parsed;

        const preview = document.getElementById('mc-bulk-preview');
        const saveBtn = document.getElementById('mc-bulk-save-btn');

        let html = `<div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <span style="font-weight:900;font-size:0.8rem;color:#16a34a;">
                <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">check_circle</span>
                ${parsed.length} question${parsed.length !== 1 ? 's' : ''} parsed
            </span>
            ${errors.length ? `<span style="font-weight:900;font-size:0.8rem;color:var(--brand);">
                <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">warning</span>
                ${errors.length} block${errors.length !== 1 ? 's' : ''} skipped
            </span>` : ''}
        </div>`;

        if (errors.length) {
            html += `<div style="background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.2);border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:0.72rem;">
                <strong style="color:var(--brand);">Skipped blocks:</strong>
                ${errors.map(e => `<div style="margin-top:4px;color:var(--text-muted);">Block ${e.num}: "${e.block}…" — ${e.reason}</div>`).join('')}
            </div>`;
        }

        if (parsed.length) {
            html += `<div style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;padding-right:4px;">`;
            parsed.forEach((q, i) => {
                const letters = ['A','B','C','D'];
                html += `
                <div style="background:var(--bg-inset);border:1px solid var(--border);border-radius:8px;padding:12px 14px;">
                    <div style="font-weight:800;font-size:0.8rem;color:var(--text);margin-bottom:8px;">
                        <span style="color:var(--text-muted);font-size:0.65rem;margin-right:6px;background:var(--bg-card);padding:1px 6px;border-radius:4px;border:1px solid var(--border);">Q${i+1}</span>
                        ${q.question}
                    </div>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;">
                        ${q.options.map((opt, oi) => `
                            <div style="font-size:0.72rem;padding:4px 8px;border-radius:6px;
                                background:${oi === q.correctIndex ? 'rgba(22,163,74,0.1)' : 'var(--bg-card)'};
                                border:1px solid ${oi === q.correctIndex ? '#16a34a' : 'var(--border)'};
                                color:${oi === q.correctIndex ? '#16a34a' : 'var(--text-sub)'};
                                font-weight:${oi === q.correctIndex ? '800' : '500'};">
                                ${oi === q.correctIndex ? '✓' : letters[oi] + '.'} ${opt}
                            </div>`).join('')}
                    </div>
                    ${q.explanation ? `<div style="margin-top:6px;font-size:0.68rem;color:var(--text-muted);padding:4px 8px;background:var(--bg-card);border-radius:4px;border-left:3px solid var(--brand);">${q.explanation}</div>` : ''}
                </div>`;
            });
            html += `</div>`;
        }

        preview.innerHTML = html;
        preview.style.display = 'block';
        saveBtn.style.display = parsed.length ? 'flex' : 'none';
        saveBtn.textContent = '';
        saveBtn.innerHTML = `<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">save</span> Save ${parsed.length} Question${parsed.length !== 1 ? 's' : ''}`;
    };

    document.getElementById('mc-bulk-save-btn').onclick = async () => {
        if (!parsedQuestions.length) return;
        const btn = document.getElementById('mc-bulk-save-btn');
        btn.disabled = true;
        btn.innerHTML = `<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;animation:spin 1s linear infinite;display:inline-block;">autorenew</span> Saving…`;

        try {
            // Fetch existing questions, append new ones (avoid arrayUnion limit issues)
            const tData = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
            const existing = tData ? (tData.questions || []) : [];

            // Give each question a stable unique id
            const stamped = parsedQuestions.map(q => ({
                ...q,
                id: Date.now() + Math.floor(Math.random() * 1e6)
            }));

            const tRef = doc(db, 'unicourses', courseId, 'topics', topicId);
            await updateDoc(tRef, { questions: [...existing, ...stamped] });
            await sync.refresh('unicourses/' + courseId + '/topics/' + topicId);
            overlay.remove();
            mcRenderCoursesTab(courseId, topicId);
            mcLoadStats();
        } catch (e) {
            btn.disabled = false;
            btn.innerHTML = `<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">save</span> Save All`;
            alert('Save failed: ' + e.message);
        }
    };
};

// ── ADMIN USER DETAIL MODAL ───────────────────────────────────

const ADM = {
    // colour helpers
    typeConfig: {
        daily_quiz:    { icon:'today',          bg:'rgba(37,99,235,0.08)', border:'#2563eb', color:'#2563eb'  },
        broadcast:     { icon:'campaign',        bg:'rgba(37,99,235,0.08)', border:'#2563eb', color:'#2563eb'  },
        advice:        { icon:'tips_and_updates',bg:'rgba(124,58,237,0.08)', border:'#7c3aed', color:'#7c3aed'  },
        warning:       { icon:'report_problem',  bg:'rgba(220,38,38,0.08)',  border:'#dc2626', color:'#dc2626'  },
        congratulatory:{ icon:'emoji_events',    bg:'rgba(22,163,74,0.08)',  border:'#16a34a', color:'#16a34a'  },
        gift:          { icon:'redeem',          bg:'rgba(124,58,237,0.08)', border:'#7c3aed', color:'#7c3aed'  },
        default:       { icon:'notifications',   bg:'var(--bg-inset)',       border:'var(--border)', color:'var(--text-muted)' },
    },
    getDueMs(item) {
        if (item.dueTimestamp?.toMillis) return item.dueTimestamp.toMillis();
        if (item.dueDate) return new Date(item.dueDate + 'T' + (item.dueTime || '23:59')).getTime();
        return null;
    },
    state: { uid:'', schedItems:[], notifItems:[], tab:'sched' }
};

window.openAdminUserModal = async function(uid) {
    // Full-screen overlay — not a small modal
    const overlay = document.createElement('div');
    overlay.id = 'admin-user-panel';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:2000;animation:fadeIn 0.2s ease;';
    overlay.innerHTML = `
        <div id="aup-panel" style="display:flex;flex-direction:column;overflow:hidden;flex:1;">
            <style>
                @keyframes slideInRight{from{transform:translateX(100%)}to{transform:translateX(0)}}
                .aup-tab-bar{display:flex;border-bottom:2px solid var(--border);background:var(--bg-inset);}
                .aup-tab{flex:1;padding:14px 8px;border:none;background:transparent;color:var(--text-muted);
                    font-size:0.72rem;font-weight:800;cursor:pointer;text-transform:uppercase;
                    letter-spacing:.05em;border-bottom:3px solid transparent;margin-bottom:-2px;transition:all .15s;}
                .aup-tab.active{color:var(--brand);border-bottom-color:var(--brand);background:var(--bg-card);}
                .aup-body{flex:1;overflow-y:auto;padding:24px;}
                .aup-section{margin-bottom:28px;}
                .aup-section-title{font-size:0.65rem;font-weight:900;text-transform:uppercase;
                    letter-spacing:.06em;color:var(--text-muted);margin-bottom:12px;
                    padding-bottom:6px;border-bottom:1px solid var(--border);}
                .aup-field{margin-bottom:14px;}
                .aup-field label{display:block;font-size:0.68rem;font-weight:800;color:var(--text-muted);
                    text-transform:uppercase;letter-spacing:.04em;margin-bottom:5px;}
                .aup-field input,.aup-field select{width:100%;padding:10px 12px;
                    border:2px solid var(--border);border-radius:8px;background:var(--bg-inset);
                    color:var(--text);font-size:0.85rem;box-sizing:border-box;font-family:inherit;
                    outline:none;transition:border-color .15s;}
                .aup-field input:focus,.aup-field select:focus{border-color:var(--brand);}
                .aup-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
                @media(max-width:480px){.aup-2col{grid-template-columns:1fr;}}
                .stat-chip{background:var(--bg-inset);border:1.5px solid var(--border);border-radius:10px;
                    padding:14px;text-align:center;}
                .stat-chip-val{font-size:1.3rem;font-weight:900;color:var(--text);line-height:1;}
                .stat-chip-lbl{font-size:0.6rem;font-weight:800;color:var(--text-muted);
                    text-transform:uppercase;letter-spacing:.05em;margin-top:4px;}
                .udt-row{display:grid;grid-template-columns:40px 1fr auto;align-items:start;
                    gap:12px;padding:12px 0;border-bottom:1px solid var(--border);}
                .udt-row:last-child{border-bottom:none;}
                .udt-icon{width:40px;height:40px;border-radius:9px;display:flex;align-items:center;
                    justify-content:center;flex-shrink:0;border:1.5px solid;}
                .udt-row-title{font-weight:800;font-size:0.82rem;color:var(--text);margin-bottom:3px;line-height:1.3;}
                .udt-row-meta{font-size:0.68rem;color:var(--text-muted);display:flex;flex-wrap:wrap;gap:8px;margin-top:3px;}
                .udt-row-msg{font-size:0.68rem;color:var(--text-muted);font-style:italic;margin-top:4px;}
                .udt-btns{display:flex;gap:6px;align-items:center;flex-shrink:0;}
                .udt-btn{background:var(--bg-inset);border:1.5px solid var(--border);border-radius:6px;
                    cursor:pointer;padding:4px 8px;display:flex;align-items:center;gap:3px;
                    font-size:0.65rem;font-weight:800;color:var(--text);transition:border-color .15s,color .15s;}
                .udt-btn:hover{border-color:var(--brand);color:var(--brand);}
                .udt-btn.red:hover{border-color:#dc2626;color:#dc2626;}
                .udt-expired{font-size:0.58rem;font-weight:900;padding:1px 5px;border-radius:3px;
                    background:rgba(220,38,38,0.08);color:#dc2626;border:1px solid #dc2626;}
                @media(max-width:400px){
                    .udt-row{grid-template-columns:36px 1fr;}
                    .udt-btns{grid-column:1/-1;justify-content:flex-end;}}
            </style>
            <!-- Header -->
            <div style="display:flex;align-items:center;gap:14px;padding:16px 24px;border-bottom:2px solid var(--border);background:var(--bg-card);flex-shrink:0;">
                <button onclick="document.getElementById('admin-user-panel').remove()"
                    style="width:40px;height:40px;border-radius:8px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round">arrow_back</span>
                </button>
                <div id="aup-avatar" class="mc-avatar" style="width:52px;height:52px;font-size:1.1rem;flex-shrink:0;">?</div>
                <div style="flex:1;min-width:0;">
                    <div id="aup-name" style="font-weight:900;font-size:1.1rem;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">Loading…</div>
                    <div id="aup-sub" style="font-size:0.72rem;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>
                </div>
                <button onclick="document.getElementById('admin-user-panel').remove()"
                    style="width:40px;height:40px;border-radius:8px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            <!-- Tab bar -->
            <div class="aup-tab-bar">
                <button class="aup-tab active" id="aup-tab-profile" onclick="window.aupSwitch('profile')">👤 Profile</button>
                <button class="aup-tab" id="aup-tab-results" onclick="window.aupSwitch('results')">📊 Results</button>
                <button class="aup-tab" id="aup-tab-sched"   onclick="window.aupSwitch('sched')">📅 Schedule</button>
                <button class="aup-tab" id="aup-tab-notif"   onclick="window.aupSwitch('notif')">🔔 Inbox</button>
            </div>
            <!-- Body -->
            <div class="aup-body" id="aup-body">
                <div style="text-align:center;padding:48px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.6rem;">autorenew</span>
                </div>
            </div>
        </div>`;

    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

    try {
        const [userData, resultsData, schedData, notifData] = await Promise.all([
            sync.doc('users/' + uid),
            sync.collection('users/' + uid + '/results'),
            sync.collection('users/' + uid + '/schedule'),
            sync.collection('users/' + uid + '/notifications')
        ]);

        if (!userData) { overlay.remove(); alert('User not found.'); return; }

        // Sort schedule and notifications by timestamp descending
        const results  = resultsData || [];
        const schedItems = (schedData || []).sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));
        const notifItems = (notifData || []).sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0));

        const u       = userData;
        const name    = u.displayName || u.username || u.email?.split('@')[0] || 'Unknown';
        const initials= name.trim().split(' ').filter(Boolean).map(w=>w[0]).slice(0,2).join('').toUpperCase()||'??';

        // Compute analytics
        const totalExams = results.length;
        let avgScore = 0, avgGrade = 'N/A', weeklyBest = '—';
        if (totalExams > 0) {
            avgScore = Math.round(results.reduce((s,r) => s + (r.score||0), 0) / totalExams);
            avgGrade = avgScore>=70?'A':avgScore>=60?'B':avgScore>=50?'C':avgScore>=45?'D':'F';
            const weekStart = new Date(); weekStart.setDate(weekStart.getDate()-weekStart.getDay()); weekStart.setHours(0,0,0,0);
            const thisWeek  = results.filter(r => { const d=r.timestamp?.toDate?r.timestamp.toDate():new Date(r.timestamp||0); return d>=weekStart; });
            if (thisWeek.length) weeklyBest = Math.max(...thisWeek.map(r=>r.score||0)) + '%';
        }

        ADM.state = {
            uid, u,
            results,
            schedItems,
            notifItems,
            tab: 'profile'
        };

        // Populate header
        document.getElementById('aup-avatar').textContent = initials;
        document.getElementById('aup-name').textContent   = name;
        document.getElementById('aup-sub').innerHTML      = `${u.email||''}&nbsp;&nbsp;${u.role==='admin'?'<span class="badge-admin">Admin</span>':''}`;

        // Update tab counts
        document.getElementById('aup-tab-sched').textContent = `📅 Schedule (${ADM.state.schedItems.length})`;
        document.getElementById('aup-tab-notif').textContent  = `🔔 Inbox (${ADM.state.notifItems.length})`;
        document.getElementById('aup-tab-results').textContent = `📊 Results (${ADM.state.results.length})`;

        // Store stats for profile tab
        ADM.state.stats = { totalExams, avgScore, avgGrade, weeklyBest };

        window.aupSwitch('profile');

    } catch(e) {
        console.error(e);
        overlay.remove();
        alert('Failed to load user: ' + e.message);
    }
};

window.aupSwitch = function(tab) {
    ['profile','results','sched','notif'].forEach(t => {
        document.getElementById(`aup-tab-${t}`)?.classList.toggle('active', t===tab);
    });
    ADM.state.tab = tab;
    const body = document.getElementById('aup-body');
    if (!body) return;
    const { uid, u, schedItems, notifItems, stats } = ADM.state;
    const now = Date.now();

    if (tab === 'profile') {
        body.innerHTML = `
            <!-- Stats row -->
            <div class="aup-section">
                <div class="aup-section-title">Performance Overview</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:10px;margin-bottom:4px;">
                    <div class="stat-chip"><div class="stat-chip-val">${stats.avgScore}%</div><div class="stat-chip-lbl">Avg Score</div></div>
                    <div class="stat-chip"><div class="stat-chip-val">${stats.avgGrade}</div><div class="stat-chip-lbl">Grade</div></div>
                    <div class="stat-chip"><div class="stat-chip-val" style="color:#d97706;">${stats.weeklyBest}</div><div class="stat-chip-lbl">Wk Best</div></div>
                    <div class="stat-chip"><div class="stat-chip-val">${stats.totalExams}</div><div class="stat-chip-lbl">Sessions</div></div>
                </div>
            </div>

            <!-- Profile fields -->
            <div class="aup-section">
                <div class="aup-section-title">Identity</div>
                <div class="aup-2col">
                    <div class="aup-field"><label>Display Name</label>
                        <input id="aup-displayName" type="text" value="${(u.displayName||'').replace(/"/g,'&quot;')}"></div>
                    <div class="aup-field"><label>Username / Handle</label>
                        <input id="aup-username" type="text" value="${(u.username||'').replace(/"/g,'&quot;')}"></div>
                </div>
                <div class="aup-field"><label>Registered Email (read-only)</label>
                    <input type="text" value="${u.email||''}" readonly style="opacity:.6;cursor:not-allowed;"></div>
            </div>

            <!-- System fields -->
            <div class="aup-section">
                <div class="aup-section-title">System</div>
                <div class="aup-2col">
                    <div class="aup-field"><label>EXA Rating</label>
                        <input id="aup-rating" type="number" value="${u.exaRating||800}" min="0" max="9999"></div>
                    <div class="aup-field"><label>Role</label>
                        <select id="aup-role">
                            <option value="student" ${u.role==='student'||!u.role?'selected':''}>Student</option>
                            <option value="admin"   ${u.role==='admin'?'selected':''}>Admin</option>
                        </select></div>
                </div>
                <div class="aup-2col">
                    <div class="aup-field"><label>Streak (days)</label>
                        <input id="aup-streak" type="number" value="${u.streak||0}" min="0"></div>
                    <div class="aup-field"><label>Highest Streak</label>
                        <input id="aup-hstreak" type="number" value="${u.highestStreak||0}" min="0"></div>
                </div>
            </div>

            <!-- Subscription flags -->
            <div class="aup-section">
                <div class="aup-section-title">Subscriptions</div>
                <div style="display:flex;flex-direction:column;gap:10px;">
                    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.82rem;font-weight:700;">
                        <input type="checkbox" id="aup-sub-daily" ${u.subscriptions?.dailyQuiz!==false?'checked':''} style="width:16px;height:16px;accent-color:var(--brand);">
                        Daily Quiz subscription
                    </label>
                    <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-size:0.82rem;font-weight:700;">
                        <input type="checkbox" id="aup-sub-advice" ${u.subscriptions?.advice!==false?'checked':''} style="width:16px;height:16px;accent-color:var(--brand);">
                        ExamForge Advice subscription
                    </label>
                </div>
            </div>

            <!-- Actions -->
            <div class="aup-section" style="display:flex;flex-direction:column;gap:10px;">
                <button class="btn btn-primary" id="aup-save-btn" onclick="window.aupSaveProfile()">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">save</span> Save Profile Changes
                </button>
                <button class="btn btn-outline" style="border-color:#f59e0b;color:#f59e0b;" onclick="window.aupPasswordReset()">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">lock_reset</span> Send Password Reset Email
                </button>
                <button class="btn btn-outline" style="border-color:#dc2626;color:#dc2626;" onclick="window.udtDeleteUser('${uid}')">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">delete_forever</span> Delete User Account
                </button>
            </div>`;

    } else if (tab === 'sched') {
        const addBtn = `
            <div style="margin-bottom:16px;">
                <button class="btn btn-primary btn-sm" onclick="window.udtAddSchedule()">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> Add Schedule Item
                </button>
            </div>`;

        if (!schedItems.length) {
            body.innerHTML = addBtn + `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.8rem;">No schedule items for this user.</div>`;
            return;
        }
        body.innerHTML = addBtn + schedItems.map(s => {
            const tc    = ADM.typeConfig[s.type] || ADM.typeConfig.default;
            const dueMs = ADM.getDueMs(s);
            const expired = dueMs !== null && dueMs < now;
            return `
            <div class="udt-row">
                <div class="udt-icon" style="background:${tc.bg};border-color:${tc.border};">
                    <span class="material-icons-round" style="color:${tc.color};font-size:1.1rem;">${tc.icon}</span>
                </div>
                <div style="min-width:0;">
                    <div class="udt-row-title">
                        ${s.course||s.title||'Quiz'}
                        ${expired?'<span class="udt-expired">Expired</span>':''}
                    </div>
                    <div class="udt-row-meta">
                        ${s.dueDate?`<span>📅 ${s.dueDate}${s.dueTime?' at '+s.dueTime:''}</span>`:''}
                        ${s.timeLimit?`<span>⏱ ${s.timeLimit}min</span>`:''}
                        ${s.quizUrl?`<a href="${s.quizUrl}" target="_blank" style="color:var(--brand);font-weight:700;font-size:0.65rem;">Open ↗</a>`:''}
                    </div>
                    ${s.message?`<div class="udt-row-msg">"${s.message}"</div>`:''}
                </div>
                <div class="udt-btns">
                    <button class="udt-btn" onclick="window.udtEditSched('${s._id}')">
                        <span class="material-icons-round" style="font-size:0.9rem;">edit</span>
                    </button>
                    <button class="udt-btn red" onclick="window.udtDelSched('${s._id}')">
                        <span class="material-icons-round" style="font-size:0.9rem;">delete_outline</span>
                    </button>
                </div>
            </div>`;
        }).join('');

    } else if (tab === 'results') {
        const res = ADM.state.results || [];
        if (res.length === 0) {
            body.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.8rem;">No exam results for this user.</div>`;
            return;
        }
        
        const scoreColor = (s) => s >= 80 ? '#16a34a' : s >= 65 ? '#2563eb' : s >= 50 ? '#ca8a04' : s >= 40 ? '#d97706' : '#dc2626';
        const gradeLetter = (s) => s >= 80 ? 'A' : s >= 65 ? 'B' : s >= 50 ? 'C' : s >= 40 ? 'D' : 'F';
        
        const totalAvg = Math.round(res.reduce((sum, r) => sum + (r.score || 0), 0) / res.length);
        const bestRes = res.reduce((max, r) => r.score > max.score ? r : max, res[0]);
        
        body.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
                <div class="stat-chip"><div class="stat-chip-val">${totalAvg}%</div><div class="stat-chip-lbl">Avg Score</div></div>
                <div class="stat-chip"><div class="stat-chip-val" style="color:${scoreColor(totalAvg)};">${gradeLetter(totalAvg)}</div><div class="stat-chip-lbl">Grade</div></div>
                <div class="stat-chip"><div class="stat-chip-val">${res.length}</div><div class="stat-chip-lbl">Exams</div></div>
                <div class="stat-chip"><div class="stat-chip-val" style="color:#16a34a;">${bestRes.score}%</div><div class="stat-chip-lbl">Best</div></div>
            </div>
            <div style="overflow-x:auto;border:2px solid var(--text);border-radius:8px;">
                <table style="width:100%;min-width:400px;border-collapse:collapse;font-size:0.72rem;">
                    <thead>
                        <tr style="background:var(--bg-inset);">
                            <th style="padding:8px 10px;text-align:left;font-size:0.6rem;font-weight:800;text-transform:uppercase;border-bottom:2px solid var(--text);">Course</th>
                            <th style="padding:8px 10px;text-align:center;font-size:0.6rem;font-weight:800;text-transform:uppercase;border-bottom:2px solid var(--text);">Score</th>
                            <th style="padding:8px 10px;text-align:center;font-size:0.6rem;font-weight:800;text-transform:uppercase;border-bottom:2px solid var(--text);">Grade</th>
                            <th style="padding:8px 10px;text-align:center;font-size:0.6rem;font-weight:800;text-transform:uppercase;border-bottom:2px solid var(--text);">Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${res.slice(0, 50).map(r => `
                            <tr style="border-bottom:1px solid var(--border);">
                                <td style="padding:8px 10px;font-weight:700;color:var(--text);">${r.course || '—'}</td>
                                <td style="padding:8px 10px;text-align:center;font-weight:900;color:${scoreColor(r.score)};">${r.score}%</td>
                                <td style="padding:8px 10px;text-align:center;"><span style="font-weight:900;color:${scoreColor(r.score)};">${r.grade || gradeLetter(r.score)}</span></td>
                                <td style="padding:8px 10px;text-align:center;font-size:0.65rem;color:var(--text-muted);">${r.date || '—'}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            </div>
            ${res.length > 50 ? `<div style="font-size:0.6rem;color:var(--text-muted);text-align:center;padding:8px;font-weight:600;">Showing last 50 of ${res.length} results</div>` : ''}`;

    } else {
        const addBtn = `
            <div style="margin-bottom:16px;">
                <button class="btn btn-primary btn-sm" onclick="window.udtAddNotification()">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">send</span> Send Notification
                </button>
            </div>`;

        if (!notifItems.length) {
            body.innerHTML = addBtn + `<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:0.8rem;">No notifications for this user.</div>`;
            return;
        }
        body.innerHTML = addBtn + notifItems.map(n => {
            const tc   = ADM.typeConfig[n.type] || ADM.typeConfig.default;
            const time = n.timestamp?.toDate?n.timestamp.toDate().toLocaleDateString('en-NG',{day:'numeric',month:'short',year:'numeric'}):'—';
            return `
            <div class="udt-row">
                <div class="udt-icon" style="background:${tc.bg};border-color:${tc.border};">
                    <span class="material-icons-round" style="color:${tc.color};font-size:1.1rem;">${tc.icon}</span>
                </div>
                <div style="min-width:0;">
                    <div class="udt-row-title">${n.title||n.type.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</div>
                    ${n.message?`<div class="udt-row-msg" style="font-style:normal;margin-top:3px;">${n.message}</div>`:''}
                    <div class="udt-row-meta" style="margin-top:4px;">
                        <span>🕐 ${time}</span>
                        ${n.dueDate?`<span>Due ${n.dueDate}</span>`:''}
                    </div>
                </div>
                <div class="udt-btns">
                    <button class="udt-btn red" onclick="window.udtDelNotif('${n._id}')">
                        <span class="material-icons-round" style="font-size:0.9rem;">delete_outline</span>
                    </button>
                </div>
            </div>`;
        }).join('');
    }
};

// ── Profile save ──────────────────────────────────────────────
window.aupSaveProfile = async function() {
    const { uid } = ADM.state;
    const btn = document.getElementById('aup-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await updateDoc(doc(db,'users',uid), {
            displayName:   document.getElementById('aup-displayName').value.trim(),
            username:      document.getElementById('aup-username').value.toLowerCase().trim(),
            exaRating:     parseInt(document.getElementById('aup-rating').value)||800,
            role:          document.getElementById('aup-role').value,
            streak:        parseInt(document.getElementById('aup-streak').value)||0,
            highestStreak: parseInt(document.getElementById('aup-hstreak').value)||0,
            subscriptions: {
                dailyQuiz: document.getElementById('aup-sub-daily').checked,
                advice:    document.getElementById('aup-sub-advice').checked,
            }
        });
        btn.innerHTML = '<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">check_circle</span> Saved!';
        btn.style.background = '#16a34a';
        setTimeout(()=>{ btn.disabled=false; btn.innerHTML='<span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">save</span> Save Profile Changes'; btn.style.background=''; }, 2500);
    } catch(e) { btn.disabled=false; btn.textContent='Save Profile Changes'; alert('Save failed: '+e.message); }
};

// ── Password reset ────────────────────────────────────────────
window.aupPasswordReset = function() {
    const email = ADM.state.u?.email;
    if (!email) return alert('No email on file for this user.');
    if (!confirm(`Send a password reset email to ${email}?`)) return;
    import("https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js").then(({ sendPasswordResetEmail }) => {
        sendPasswordResetEmail(auth, email)
            .then(()=>alert(`Reset email sent to ${email}.`))
            .catch(e=>alert('Failed: '+e.message));
    });
};

// ── udtSwitch kept for backward compat (schedule/notif tab helpers) ───
window.udtSwitch = function(tab) { window.aupSwitch(tab); };
window.udtDelSched = async function(itemId) {
    if (!confirm('Delete this schedule item?')) return;
    const { uid } = ADM.state;
    try {
        await deleteDoc(doc(db, `users/${uid}/schedule`, itemId));
        ADM.state.schedItems = ADM.state.schedItems.filter(s => s._id !== itemId);
        const ct = document.getElementById('aup-tab-sched');
        if (ct) ct.textContent = `(${ADM.state.schedItems.length})`;
        window.udtSwitch('sched');
    } catch(e) { alert('Delete failed: ' + e.message); }
};

window.udtDelNotif = async function(notifId) {
    const { uid } = ADM.state;
    try {
        await deleteDoc(doc(db, `users/${uid}/notifications`, notifId));
        ADM.state.notifItems = ADM.state.notifItems.filter(n => n._id !== notifId);
        const ct = document.getElementById('aup-tab-notif');
        if (ct) ct.textContent = `(${ADM.state.notifItems.length})`;
        window.udtSwitch('notif');
    } catch(e) { alert('Delete failed: ' + e.message); }
};

// ── Edit schedule item ────────────────────────────────────────
window.udtEditSched = function(itemId) {
    const item = ADM.state.schedItems.find(s => s._id === itemId);
    if (!item) return;
    const { uid } = ADM.state;

    const ov = document.createElement('div');
    ov.className = 'mc-modal-overlay';
    ov.style.zIndex = '1100';
    ov.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#2563eb;">edit_calendar</span> Edit Schedule Item</h3>
            <div class="mc-field"><label>Title</label>
                <input id="uesc-title" type="text" value="${(item.course||item.title||'').replace(/"/g,'&quot;')}"></div>
            <div class="mc-field"><label>Quiz URL</label>
                <input id="uesc-url" type="text" value="${(item.quizUrl||'').replace(/"/g,'&quot;')}" placeholder="quiz.html?course=…"></div>
            <div class="mc-field"><label>Message</label>
                <textarea id="uesc-msg" rows="2">${item.message||''}</textarea></div>
            <div class="mc-2col">
                <div class="mc-field"><label>Due Date</label><input id="uesc-date" type="date" value="${item.dueDate||''}"></div>
                <div class="mc-field"><label>Due Time</label><input id="uesc-time" type="time" value="${item.dueTime||'23:59'}"></div>
            </div>
            <div class="mc-field"><label>Time Limit (min)</label>
                <input id="uesc-limit" type="number" value="${item.timeLimit||''}" placeholder="40" min="1"></div>
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:1.5px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="uesc-save">Save Changes</button>
            </div>
        </div>`;
    document.body.appendChild(ov);
    ov.onclick = e => { if (e.target === ov) ov.remove(); };

    document.getElementById('uesc-save').onclick = async () => {
        const updates = {
            course:    document.getElementById('uesc-title').value.trim(),
            quizUrl:   document.getElementById('uesc-url').value.trim(),
            message:   document.getElementById('uesc-msg').value.trim(),
            dueDate:   document.getElementById('uesc-date').value,
            dueTime:   document.getElementById('uesc-time').value,
            timeLimit: parseInt(document.getElementById('uesc-limit').value) || null,
        };
        if (updates.dueDate) updates.dueTimestamp = new Date(`${updates.dueDate}T${updates.dueTime||'23:59'}`);
        const btn = document.getElementById('uesc-save');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            await updateDoc(doc(db, `users/${uid}/schedule`, itemId), updates);
            const idx = ADM.state.schedItems.findIndex(s => s._id === itemId);
            if (idx !== -1) ADM.state.schedItems[idx] = { ...ADM.state.schedItems[idx], ...updates };
            ov.remove();
            window.udtSwitch('sched');
        } catch(e) { btn.disabled = false; btn.textContent = 'Save Changes'; alert('Error: ' + e.message); }
    };
};

// ── Create new schedule item ──────────────────────────────────
window.udtAddSchedule = function() {
    const { uid } = ADM.state;
    const ov = document.createElement('div');
    ov.className = 'mc-modal-overlay';
    ov.style.zIndex = '1100';
    ov.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#2563eb;">add_circle</span> Add Schedule Item</h3>
            <div class="mc-field"><label>Title</label><input id="uas-title" type="text" placeholder="e.g. Daily Quiz — Calculus"></div>
            <div class="mc-field"><label>Quiz URL</label><input id="uas-url" type="text" placeholder="quiz.html?course=mth101&topic=calculus"></div>
            <div class="mc-field"><label>Message (optional)</label><textarea id="uas-msg" rows="2" placeholder="Good luck!"></textarea></div>
            <div class="mc-2col">
                <div class="mc-field"><label>Due Date</label><input id="uas-date" type="date" value="${new Date().toISOString().split('T')[0]}"></div>
                <div class="mc-field"><label>Due Time</label><input id="uas-time" type="time" value="23:59"></div>
            </div>
            <div class="mc-field"><label>Time Limit (min)</label><input id="uas-limit" type="number" placeholder="40" min="1"></div>
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:1.5px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="uas-save">Add to Schedule</button>
            </div>
        </div>`;
    document.body.appendChild(ov);
    ov.onclick = e => { if (e.target === ov) ov.remove(); };

    document.getElementById('uas-save').onclick = async () => {
        const title = document.getElementById('uas-title').value.trim();
        const dueDate = document.getElementById('uas-date').value;
        if (!title) return alert('Title is required.');
        const item = {
            type:      'daily_quiz',
            course:    title,
            quizUrl:   document.getElementById('uas-url').value.trim(),
            message:   document.getElementById('uas-msg').value.trim(),
            dueDate,
            dueTime:   document.getElementById('uas-time').value,
            timeLimit: parseInt(document.getElementById('uas-limit').value) || null,
            timestamp: new Date(),
        };
        if (dueDate) item.dueTimestamp = new Date(`${dueDate}T${item.dueTime||'23:59'}`);
        const btn = document.getElementById('uas-save');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            const ref = await addDoc(collection(db, `users/${uid}/schedule`), item);
            ADM.state.schedItems.unshift({ _id: ref.id, ...item });
            const ct = document.getElementById('aup-tab-sched');
            if (ct) ct.textContent = `(${ADM.state.schedItems.length})`;
            ov.remove();
            window.udtSwitch('sched');
        } catch(e) { btn.disabled = false; btn.textContent = 'Add to Schedule'; alert('Error: ' + e.message); }
    };
};

// ── Send new notification ────────────────────────────────────
window.udtAddNotification = function() {
    const { uid } = ADM.state;
    const ov = document.createElement('div');
    ov.className = 'mc-modal-overlay';
    ov.style.zIndex = '1100';
    ov.innerHTML = `
        <div class="mc-modal">
            <h3><span class="material-icons-round" style="color:#7c3aed;">send</span> Send Notification</h3>
            <div class="mc-field"><label>Type</label>
                <select id="uan-type">
                    <option value="broadcast">Broadcast</option>
                    <option value="congratulatory">Congratulatory</option>
                    <option value="warning">Warning</option>
                    <option value="gift">Gift / Reward</option>
                    <option value="daily_quiz">Daily Quiz</option>
                </select></div>
            <div class="mc-field"><label>Title</label><input id="uan-title" type="text" placeholder="Notification title"></div>
            <div class="mc-field"><label>Message</label><textarea id="uan-msg" rows="3" placeholder="Your message…"></textarea></div>
            <div class="mc-field" id="uan-url-wrap" style="display:none;"><label>Quiz URL (for daily_quiz)</label>
                <input id="uan-url" type="text" placeholder="quiz.html?course=…"></div>
            <div class="mc-modal-actions">
                <button class="btn btn-ghost" style="flex:1;border:1.5px solid var(--border);" onclick="this.closest('.mc-modal-overlay').remove()">Cancel</button>
                <button class="btn btn-primary" style="flex:2;" id="uan-save">Send</button>
            </div>
        </div>`;
    document.body.appendChild(ov);
    ov.onclick = e => { if (e.target === ov) ov.remove(); };

    document.getElementById('uan-type').onchange = e => {
        document.getElementById('uan-url-wrap').style.display = e.target.value === 'daily_quiz' ? 'block' : 'none';
    };

    document.getElementById('uan-save').onclick = async () => {
        const type    = document.getElementById('uan-type').value;
        const title   = document.getElementById('uan-title').value.trim();
        const message = document.getElementById('uan-msg').value.trim();
        const quizUrl = document.getElementById('uan-url')?.value.trim() || '';
        if (!title || !message) return alert('Title and message are required.');
        const notif = { type, title, message, timestamp: new Date(), ...(quizUrl ? { quizUrl } : {}) };
        const btn = document.getElementById('uan-save');
        btn.disabled = true; btn.textContent = 'Sending…';
        try {
            const ref = await addDoc(collection(db, `users/${uid}/notifications`), notif);
            ADM.state.notifItems.unshift({ _id: ref.id, ...notif });
            const ct = document.getElementById('aup-tab-notif');
            if (ct) ct.textContent = `(${ADM.state.notifItems.length})`;
            ov.remove();
            window.udtSwitch('notif');
        } catch(e) { btn.disabled = false; btn.textContent = 'Send'; alert('Error: ' + e.message); }
    };
};

// ── Delete user account ───────────────────────────────────────
window.udtDeleteUser = async function(uid) {
    if (!confirm('⚠️ Permanently delete this user\'s Firestore record? This cannot be undone.')) return;
    if (!confirm('Final confirmation — delete this user?')) return;
    try {
        await deleteDoc(doc(db, 'users', uid));
        window.masterAllUsers = (window.masterAllUsers || []).filter(u => u.id !== uid);
        document.querySelector('.mc-modal-overlay')?.remove();
        mcRenderUsersTab();
    } catch(e) { alert('Delete failed: ' + e.message); }
};

window.mcDeleteQuestion = async function(courseId, topicId, questionIndex) {
    try {
        const tData = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
        if (!tData) return;
        const questions = [...(tData.questions || [])];
        questions.splice(questionIndex, 1);
        await updateDoc(doc(db,'unicourses',courseId,'topics',topicId), { questions });
        mcRenderCoursesTab(courseId, topicId);
        mcLoadStats();
    } catch (e) { alert('Error: ' + e.message); }
};

window.mcDeleteAllQuestions = async function(courseId, topicId) {
    try {
        const tData = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
        if (!tData) return;
        const questions = tData.questions || [];
        if (!questions.length) {
            window.showEFModal("Delete Questions", "There are no questions in this quiz to delete.", "OKAY", null, true);
            return;
        }
        
        window.showEFModal(
            "Delete All Questions",
            `⚠️ Are you absolutely sure you want to delete ALL ${questions.length} questions in this quiz? This action is permanent and cannot be undone.`,
            "YES, DELETE ALL",
            () => {
                // Secondary final confirmation
                window.showEFModal(
                    "Final Confirmation",
                    `🔥 PROCEED WITH PURGE? This will permanently wipe out ALL ${questions.length} questions from the topic "${topicId.replace(/-/g,' ').toUpperCase()}".`,
                    "ERASE ALL QUESTIONS",
                    async () => {
                        try {
                            const tRef = doc(db, 'unicourses', courseId, 'topics', topicId);
                            await updateDoc(tRef, { questions: [] });
                            await sync.refresh('unicourses/' + courseId + '/topics/' + topicId);
                            window.mcRenderCoursesTab(courseId, topicId);
                            await mcLoadStats();
                            window.showEFModal("Success", `Wiped out all ${questions.length} questions successfully!`, "OKAY", null, true);
                        } catch (err) {
                            window.showEFModal("Error", "Failed to delete questions: " + err.message, "OKAY", null, true);
                        }
                    }
                );
            }
        );
    } catch (e) {
        window.showEFModal("Error", "Error fetching quiz details: " + e.message, "OKAY", null, true);
    }
};

window.mcDeleteCourse = function(courseId, courseTitle) {
    window.showEFModal(
        "Delete Course?",
        `Are you absolutely sure you want to delete the course "${courseTitle}" (${courseId.toUpperCase()})? This will permanently delete all topics, quizzes, and questions inside this course!`,
        "YES, DELETE IT",
        async () => {
            try {
                // Delete all topics under this course first
                const topics = await sync.collection('unicourses/' + courseId + '/topics');
                const batch = writeBatch(db);
                topics.forEach(t => {
                    batch.delete(doc(db, 'unicourses', courseId, 'topics', t.id));
                });
                // Delete the main course doc
                batch.delete(doc(db, 'unicourses', courseId));
                await batch.commit();

                window.showEFModal("Course Deleted", `The course "${courseTitle}" has been deleted successfully.`, "OKAY", null, true);
                mcRenderCoursesTab();
                mcLoadStats();
            } catch (e) {
                window.showEFModal("Delete Failed", e.message, "OK", null, true);
            }
        },
        true,
        "CANCEL",
        null
    );
};

window.mcDeleteTopic = function(courseId, topicId, topicTitle) {
    window.showEFModal(
        "Delete Topic?",
        `Are you absolutely sure you want to delete the topic "${topicTitle}"? This will permanently delete the topic and all questions inside it!`,
        "YES, DELETE IT",
        async () => {
            try {
                await deleteDoc(doc(db, 'unicourses', courseId, 'topics', topicId));
                window.showEFModal("Topic Deleted", `The topic "${topicTitle}" has been deleted successfully.`, "OKAY", null, true);
                mcRenderCoursesTab(courseId);
                mcLoadStats();
            } catch (e) {
                window.showEFModal("Delete Failed", e.message, "OK", null, true);
            }
        },
        true,
        "CANCEL",
        null
    );
};

function renderUserList(users) {
    const grid = document.getElementById('admin-user-grid');
    if (!grid) return;

    if (users.length === 0) {
        grid.innerHTML = `<div style="grid-column: 1/-1; text-align: center; padding: 40px;">No students found.</div>`;
        return;
    }

    grid.innerHTML = users.map(user => {
        const name = user.displayName || user.username || user.email?.split('@')[0] || "Unknown Student";
        const handle = user.username || "no_handle";
        const parts = name.trim().split(' ');
        const initials = parts.length > 1 
            ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase() 
            : name.substring(0, 2).toUpperCase();

        const provider = user.provider || 'password';
        const isGoogle = provider === 'google.com';
        const isAdmin = user.role === 'admin';

        const googleIconSVG = `<svg viewBox="0 0 24 24" width="12" height="12" style="fill: currentColor; flex-shrink: 0;"><path d="M12.545,10.239v3.821h5.445c-0.712,2.315-2.647,3.972-5.445,3.972c-3.332,0-6.033-2.701-6.033-6.032s2.701-6.032,6.033-6.032c1.498,0,2.866,0.549,3.921,1.453l2.814-2.814C17.503,2.988,15.139,2,12.545,2C7.021,2,2.543,6.477,2.543,12s4.478,10,10.002,10c8.396,0,10.249-7.85,9.426-11.748L12.545,10.239z"/></svg>`;
        const providerIcon = isGoogle 
            ? `<span style="display:flex; align-items:center; justify-content:center; width:12px; height:12px;" title="Google Login">${googleIconSVG}</span>`
            : `<span class="material-icons-round" style="font-size: 0.8rem;" title="Email Login">mail</span>`;

        // Compact, horizontal Neo-brutalist card with built-in hover lift
        return `
        <div class="card" 
             onclick="window.openAdminUserModal('${user.id}')" 
             onmouseenter="this.style.transform='translate(-2px, -2px)'; this.style.boxShadow='4px 4px 0px var(--text)'"
             onmouseleave="this.style.transform='translate(0, 0)'; this.style.boxShadow='2px 2px 0px var(--text)'"
             style="cursor: pointer; padding: 3px 12px; border: 3px solid var(--text);display: flex; align-items: center; gap: 10px; background: var(--bg-card); transition: transform 0.1s ease; border-radius: 8px;">
            
            <div style="width: 36px; height: 36px; border-radius: 8px; background: var(--brand); color: #ffffff; display: flex; align-items: center; justify-content: center; font-weight: 900; border: 2px solid var(--text); flex-shrink: 0; font-size: 0.75rem; text-transform: uppercase;">
                ${initials}
            </div>
            
            <div style="min-width: 0; flex: 1;">
                <div style="font-weight: 900; font-size: 0.8rem; white-space: wrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); line-height: 1.2;width: 90%;">
                    ${name}
                </div>
                <div style="font-family: var(--font-mono); font-size: 0.6rem; color: var(--text-muted); display: flex; align-items: center; gap: 4px; margin-top: 2px;width: 90%;">
                    ${providerIcon}
                    <span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">@${handle}</span>
                </div>
            </div>
            ${isAdmin ? `<span class="material-icons-round" style="font-size: 1rem; color: var(--brand); flex-shrink: 0;" title="Administrator">verified</span>` : ''}
        </div>
        `;
    }).join('');
}

async function fetchAdminStats() {
    try {
        const { collection, getCountFromServer } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        const [userCountSnap, examCountSnap] = await Promise.all([
            getCountFromServer(collection(db, 'users')),
            getCountFromServer(collection(db, 'exams'))
        ]);
        document.getElementById('admin-total-students').innerText = userCountSnap.data().count;
        document.getElementById('admin-total-exams').innerText = examCountSnap.data().count;
    } catch (err) { console.error(err); }
}


// ─── GOD MODE: User Editor Modal & Analytics ──────────────────────────────────


window.adminSendPasswordReset = function(email) {
    if(!email || email === 'undefined') {
        window.showEFModal("Error", "This user does not have a valid email on file.", "OKAY", null, true);
        return;
    }
    
    window.showEFModal(
        "Reset Password", 
        `Send a password reset email directly to ${email}?`, 
        "SEND EMAIL", 
        async () => {
            try {
                await sendPasswordResetEmail(auth, email);
                window.showEFModal("Success", `Password reset link sent to ${email}`, "OKAY", null, true);
            } catch(err) {
                console.error(err);
                window.showEFModal("Error", `Failed: ${err.message}`, "OKAY", null, true);
            }
        }
    );
};

// Custom UI Prompt to avoid native window.prompt()
window.adminPromptNotification = function(userId) {
    const existing = document.getElementById('admin-notif-modal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'admin-notif-modal';
    overlay.style = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 10000; backdrop-filter: blur(4px);";

    overlay.innerHTML = `
        <div class="card" style="padding: 32px; max-width: 450px; width: 90%; border: 4px solid var(--text);background: var(--bg-card); border-radius: 16px; animation: popIn 0.3s ease;">
            
            <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 24px;">
                <div style="background: rgba(37,99,235,0.1); border: 2px solid #2563eb; color: #2563eb; border-radius: 8px; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;">
                    <span class="material-icons-round">campaign</span>
                </div>
                <div>
                    <div style="font-weight: 900; font-size: 1.2rem; color: var(--text); text-transform: uppercase; line-height: 1.1;">Push Alert</div>
                    <div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">Send a direct notification to this user</div>
                </div>
            </div>
            
            <div style="margin-bottom: 16px;">
                <label style="font-size: 0.75rem; font-weight: 800; color: var(--text); display: block; margin-bottom: 6px;">Alert Title</label>
                <input type="text" id="notif-title-input" placeholder="e.g. Account Update" style="width: 100%; padding: 14px; border: 2px solid var(--text); border-radius: 8px; font-weight: bold; background: var(--bg-inset); box-sizing: border-box; font-size: 0.9rem;">
            </div>

            <div style="margin-bottom: 24px;">
                <label style="font-size: 0.75rem; font-weight: 800; color: var(--text); display: block; margin-bottom: 6px;">Message Body</label>
                <textarea id="notif-msg-input" placeholder="Type your message here..." rows="4" style="width: 100%; padding: 14px; border: 2px solid var(--text); border-radius: 8px; font-weight: bold; background: var(--bg-inset); box-sizing: border-box; resize: none; font-size: 0.9rem; font-family: inherit;"></textarea>
            </div>
            
            <div style="display: flex; gap: 12px;">
                <button class="btn btn-ghost" onclick="this.closest('#admin-notif-modal').remove()" style="flex: 1; border: 2px solid var(--border); font-weight: 900; border-radius: 8px; padding: 12px; background: var(--bg-card);">CANCEL</button>
                <button class="btn btn-primary" id="btnSendCustomNotif" style="flex: 1.5; font-weight: 900; border: 3px solid var(--text);border-radius: 8px; padding: 12px; background: #2563eb; border-color: #1e40af; color: white; transition: transform 0.1s;" onmousedown="this.style.transform='translate(2px, 2px)';" onmouseup="this.style.transform='none';">SEND ALERT</button>
            </div>
        </div>
    `;
    
    document.body.appendChild(overlay);

    document.getElementById('btnSendCustomNotif').onclick = async () => {
        const title = document.getElementById('notif-title-input').value.trim();
        const message = document.getElementById('notif-msg-input').value.trim();
        
        if (!title || !message) {
            alert("Both fields are required."); 
            return;
        }

        try {
            await addDoc(collection(db, `users/${userId}/notifications`), {
                title: title,
                message: message,
                type: "broadcast", 
                timestamp: serverTimestamp()
            });
            overlay.remove();
            window.showEFModal("Delivered", "The alert has been successfully pushed to the user's inbox.", "OKAY", null, true);
        } catch(err) {
            console.error(err);
            window.showEFModal("Error", "Failed to send notification.", "OKAY", null, true);
        }
    };
};

    async function renderDashboard() {
        renderLoading(" ");
        
        // ─── Fetch fresh user data for accurate stats and schedule ───
        try {
            const freshData = await sync.doc('users/' + auth.currentUser.uid);
            if (freshData) {
                // Map flat Firestore doc to userData structure
                userData.stats = {
                    ...userData.stats,
                    exaRating: freshData.exaRating ?? 800,
                    streak: freshData.streak ?? 0,
                    highestStreak: freshData.highestStreak ?? 0,
                    lastExamDate: freshData.lastExamDate || null,
                    role: freshData.role || 'student'
                };
                userData.recentResults = freshData.recentResults || [];
            }
            // Override with latest exam result from localStorage (covers quiz → dashboard flow)
            try {
                const lastExa = JSON.parse(localStorage.getItem('ef_last_exa'));
                if (lastExa && lastExa.exaRating && Date.now() - lastExa.timestamp < 120000) {
                    userData.stats.exaRating = lastExa.exaRating;
                    localStorage.removeItem('ef_last_exa');
                }
            } catch(e) {}
            // Fetch schedule items
            const schedItems = await sync.collection('users/' + auth.currentUser.uid + '/schedule');
            if (schedItems && schedItems.length) {
                const now = Date.now();
                const getDueMs = s => {
                    if (s.dueTimestamp?.toMillis) return s.dueTimestamp.toMillis();
                    if (s.dueDate) return new Date(s.dueDate + 'T' + (s.dueTime || '23:59')).getTime();
                    return null;
                };
                const active = schedItems.filter(s => {
                    const ms = getDueMs(s);
                    return ms === null || ms >= now;
                });
                // Auto-delete expired items in background
                const expired = schedItems.filter(s => {
                    const ms = getDueMs(s);
                    return ms !== null && ms < now;
                });
                if (expired.length) {
                    const { writeBatch, doc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                    const batch = writeBatch(db);
                    expired.forEach(s => {
                        if (s.id) batch.delete(doc(db, `users/${auth.currentUser.uid}/schedule`, s.id));
                    });
                    batch.commit().catch(() => {});
                }
                userData.schedule = active.sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
            }
        } catch (e) { console.error("Failed to fetch user data:", e); }
        
        // ─── Data & Analytics ───
        const analytics = getAnalytics();
        const firstName = currentUser.displayName ? currentUser.displayName.split(' ')[0] : 'Student';
        const streakData = computeStreakDisplay(userData.stats);
        const streak = streakData.streak;
        const weeklyBest = getWeeklyBest(userData.recentResults || []);
        const trend = getAccuracyTrend(userData.recentResults || []);
        const exaRating = userData.stats.exaRating || 800;
        const exaTitle = getExaTitle(exaRating);

        // Fetch National Positioning
        const nationalStats = await getNationalRanking(exaRating);

        // Create the percentile tag only if it's 60% or better
        const percentileTag = nationalStats.percentile <= 60
            ? `<div class="tag tag-green" style="font-size: 0.7rem; font-weight: 900; padding: 2px 8px;">TOP ${nationalStats.percentile}%</div>`
            : '';

        // UI Helpers for Trends
        const trendIcon = trend.direction === 'up' ? 'trending_up' : trend.direction === 'down' ? 'trending_down' : 'trending_flat';
        const trendColor = trend.direction === 'up' ? '#16a34a' : trend.direction === 'down' ? 'var(--brand)' : 'var(--text-muted)';
        const trendLabel = trend.direction === 'up' ? `+${trend.delta}%` : trend.direction === 'down' ? `-${trend.delta}%` : '0%';

        workspace.innerHTML = `
<style>
@media (max-width: 600px) {
    .dashboard-title { display: none; }
}
</style>
        <div class="page-header">
            <div class="page-header-row" style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
                <div>
                    <div class="page-title dashboard-title" style="font-size: 1.75rem; font-weight: 800;">Dashboard</div>
                    <div class="page-sub" style="color: var(--text-muted);font-weight:800;font-size:0.85rem;">Welcome back, ${firstName}</div>
                </div>
                <button class="btn btn-primary" onclick="efNavigate('library')" style="display: flex; align-items: center; gap: 8px;">
                    <span class="material-icons-round">add</span> Start Exam
                </button>
            </div>
        </div>

        <div class="card" style="padding: 0; margin-bottom: 24px; border: 1px solid var(--border); border-left: 6px solid var(--brand); background: var(--bg-card); overflow: hidden;">
            <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 24px; gap: 24px;">
                
                <div style="flex: 1; min-width: 280px;">
                    <div style="font-weight: 800; font-size: 0.65rem; text-transform: uppercase; color: var(--text-muted); letter-spacing: 0.12em; margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
                        <span class="material-icons-round" style="font-size: 0.9rem; color: var(--brand);">analytics</span> EXA RATING
                    </div>
                    <div style="font-family: poppins; font-size: clamp(3.5rem, 8vw, 4.8rem); font-weight: 900; color: var(--text); line-height: 0.9; margin-bottom: 8px;" data-ef-exa>
                        ${exaRating}
                    </div>
                    <div style="display: flex; align-items: center; gap: 10px;">
                        <span style="font-size: 0.75rem; font-weight: 700; color: var(--text-sub);">National Standing</span>
                        ${percentileTag}
                    </div>
                </div>

                <div style="padding: 20px 24px; background: var(--bg-inset); border-radius: 16px; border: 1px solid var(--border); display: flex; align-items: center; gap: 16px; min-width: 260px; flex-shrink: 0;">
                    <div style="width: 56px; height: 56px; display: flex; align-items: center; justify-content: center; background: var(--bg-card); border: 2px solid var(--brand); border-radius: 14px;">
                         <span class="material-icons-round" style="font-size: 2.2rem; color: var(--brand);">${exaTitle.icon}</span>
                    </div>
                    <div>
                        <div style="font-weight: 900; font-size: 1.1rem; text-transform: uppercase; color: var(--text); line-height: 1.1;">
                            ${exaTitle.name}
                        </div>
                        <div style="font-size: 0.65rem; font-weight: 800; color: var(--text-muted); font-family: var(--font-mono); margin-top: 4px; letter-spacing: 0.05em;">
                            RANK ${exaTitle.roman}
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <div style="margin-bottom: 32px;">
            <div style="font-weight: 800; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
                <span class="material-icons-round" style="font-size: 1rem;">map</span> Progress Roadmap
            </div>
<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 12px;">
    ${EXA_TITLES.map(t => {
            const isAchieved = exaRating >= t.min;
            const isCurrent = exaRating >= t.min && exaRating <= t.max;
            const isPassed = isAchieved && !isCurrent;

            // Visual Logic
            let cardBg = 'var(--bg-inset)';
            let border = '1px solid var(--border)';
            let opacity = '0.5';
            let icon = t.icon;
            let iconColor = 'var(--text-muted)';

            if (isCurrent) {
                cardBg = 'var(--brand)';
                border = '2px solid var(--brand)';
                opacity = '1';
                iconColor = '#ffffff';
            } else if (isPassed) {
                cardBg = 'var(--bg-card)';
                border = '1px solid var(--brand-glow)';
                opacity = '1';
                icon = 'check_circle'; // Show checkmark for passed ranks
                iconColor = 'var(--brand)';
            }

            return `
            <div class="card" style="padding: 14px; border-radius: 12px; border: ${border}; background: ${cardBg}; opacity: ${opacity}; transition: all 0.3s ease; position: relative; overflow: hidden;">
                ${isCurrent ? `<div style="position:absolute; top:0; left:0; width:100%; height:4px; background:rgba(255,255,255,0.4); animation: pulse 2s infinite;"></div>` : ''}
                <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <span class="material-icons-round" style="font-size: 1.1rem; color: ${iconColor}">${icon}</span>
                    <span style="font-size: 0.6rem; font-weight: 800; font-family: var(--font-mono); color: ${isCurrent ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)'};">${t.roman}</span>
                </div>
                <div style="font-size: 0.7rem; font-weight: 800; line-height: 1.2; color: ${isCurrent ? '#fff' : 'var(--text)'}">${t.name}</div>
                <div style="font-size: 0.6rem; font-weight: 600; color: ${isCurrent ? 'rgba(255,255,255,0.8)' : 'var(--text-muted)'}; margin-top: 4px;">${isPassed ? 'Achieved' : t.min + '+'}</div>
            </div>
        `;
        }).join('')}
</div>
        </div>

        <div class="card-grid card-grid-strict" style="margin-bottom: 24px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
            <div class="card stat-card card-accent" style="background: var(--brand); border-color: var(--brand);margin: 0; min-width: 0;">
                <div class="stat-label" style="color: #ffffff !important;"><span class="material-icons-round" style="color: #ffffff !important;">public</span> National Rank</div>
                <div class="stat-value" style="color: #ffffff !important; word-wrap: break-word;">#${nationalStats.rank}</div>
                <div style="font-size: 0.62rem; color: rgba(255,255,255,0.85) !important; margin-top: 4px; font-weight: 600;">Out of ${nationalStats.total} Examforgites</div>
            </div>

            <div class="card stat-card" style="margin: 0; min-width: 0;">
                <div class="stat-label"><span class="material-icons-round">gps_fixed</span> Accuracy</div>
                <div class="stat-value" style="word-wrap: break-word;">${analytics.avg}%</div>
                <div class="stat-delta" style="color:${trendColor}; display:flex; align-items:center; gap:3px; font-size:0.62rem; margin-top:4px; font-weight:700;">
                    <span class="material-icons-round" style="font-size:0.9rem;">${trendIcon}</span>
                    ${trendLabel} vs last
                </div>
            </div>

            <div class="card stat-card" style="margin: 0; min-width: 0;">
                <div class="stat-label"><span class="material-icons-round">local_fire_department</span> Streak</div>
                <div class="stat-value" style="word-wrap: break-word;" data-ef-streak>${streak}d</div>
                <div class="stat-delta" style="font-size:0.62rem; font-weight:600;" data-ef-high-streak>Best: ${userData.stats.highestStreak || 0}d</div>
            </div>

            <div class="card stat-card" style="margin: 0; min-width: 0;">
                <div class="stat-label"><span class="material-icons-round">stars</span> Weekly Best</div>
                <div class="stat-value" style="word-wrap: break-word;">${weeklyBest.score !== null ? weeklyBest.score + '%' : '—'}</div>
                <div style="font-size: 0.6rem; color: var(--text-muted); margin-top: 4px; font-weight:600; word-wrap: break-word;">${weeklyBest.course || 'None yet'}</div>
            </div>
        </div>

        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; align-items: start;" id="dashboard-lower-grid">
            <div class="card" style="padding: 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <span style="font-weight:800; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.04em;">Recent History</span>
                    <button class="btn btn-ghost btn-sm" onclick="efNavigate('results')">View All</button>
                </div>
                <div class="feed">
                    ${(userData.recentResults || []).length === 0 ? `
                        <div style="text-align:center; padding: 24px 8px; color: var(--text-muted); background: var(--bg-inset); border-radius: 8px; border: 1px dashed var(--border);">
                            <span class="material-icons-round" style="font-size: 1.5rem; margin-bottom: 8px;opacity:0.6;">assignment</span>
                            <div style="font-size: 0.72rem; font-weight: 600;">No exams taken yet</div>
                            <div style="font-size: 0.65rem; margin-top: 2px;">Your recent results will appear here.</div>
                        </div>
                    ` : (userData.recentResults || []).slice(0, 4).map(r => `
                    <div class="feed-item" onclick="efNavigate('results')" style="cursor:pointer; border-radius:8px; padding:8px; margin:0 -8px; transition: background 0.2s;">
                        <div class="feed-icon ${r.score >= 80 ? 'green' : r.score >= 65 ? '' : 'red'}">
                            <span class="material-icons-round">${r.score >= 80 ? 'check_circle' : 'radio_button_checked'}</span>
                        </div>
                        <div class="feed-body">
                            <div class="feed-title" style="font-weight:700; font-size:0.85rem;">${r.course}</div>
                            <div class="feed-meta">${r.date}</div>
                        </div>
                        <div class="feed-score" style="color: var(--text); font-weight:800;">${r.score}%</div>
                    </div>
                    `).join('')}
                </div>
            </div>

            <div class="card" style="padding: 20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <span style="font-weight:800; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.04em;">Coming Up</span>
                    <button class="btn btn-ghost btn-sm" onclick="efNavigate('schedule')">Full Schedule</button>
                </div>
                <div class="feed">
                    ${userData.schedule.length === 0 ? `
                        <div style="text-align:center; padding: 24px 8px; color: var(--text-muted); background: var(--bg-inset); border-radius: 8px; border: 1px dashed var(--border);">
                            <span class="material-icons-round" style="font-size: 1.5rem; margin-bottom: 8px;opacity:0.6;">event_busy</span>
                            <div style="font-size: 0.72rem; font-weight: 600;">Clear schedule</div>
                            <div style="font-size: 0.65rem; margin-top: 2px;">No upcoming exams or study sessions.</div>
                        </div>
                    ` : userData.schedule.slice(0, 4).map(s => `
                    <div class="feed-item">
                        <div class="feed-icon"><span class="material-icons-round">calendar_today</span></div>
                        <div class="feed-body">
                            <div class="feed-title" style="font-weight:700; font-size:0.85rem;">${s.course || s.title || 'Mock Exam'}</div>
                            <div class="feed-meta">${s.date ? s.date + (s.time ? ' · ' + s.time : '') : (s.time ? s.time : 'Available now')}</div>
                        </div>
                    </div>
                    `).join('')}
                </div>
            </div>
        </div>
            <!-- Profile & Settings (mobile) -->
            <div class="dashboard-profile-card" style="margin-top:16px;">
                <button onclick="efNavigate('settings')" style="width:100%;display:flex;align-items:center;gap:12px;padding:14px 16px;background:var(--bg-card);border:3px solid var(--text);border-radius:12px;cursor:pointer;font-weight:700;font-size:0.85rem;color:var(--text);">
                    <div style="width:40px;height:40px;border-radius:8px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;">
                        <span class="material-icons-round" style="font-size:1.1rem;">person</span>
                    </div>
                    <div style="flex:1;text-align:left;">
                        <div style="font-weight:800;font-size:0.85rem;">Profile & Settings</div>
                        <div style="font-size:0.7rem;color:var(--text-muted);">Theme, notifications, account</div>
                    </div>
                    <span class="material-icons-round" style="color:var(--text-muted);">chevron_right</span>
                </button>
            </div>
    `;
        fixTwoCol();
    }

    function fixTwoCol() {
        const twoCol = workspace.querySelector('[style*="grid-template-columns: 1fr 1fr"]');
        if (!twoCol) return;
        const observer = new ResizeObserver(() => {
            twoCol.style.gridTemplateColumns = workspace.offsetWidth < 640 ? '1fr' : '1fr 1fr';
        });
        observer.observe(workspace);
    }

    async function renderSubscriptions() {
        workspace.innerHTML = `
        <div class="page-header">
            <div class="page-title">Subscriptions</div>
            <div class="page-sub">Manage your learning plans and premium access</div>
        </div>
        <div id="subs-container" style="display:flex; flex-direction:column; gap:16px; max-width:640px;">
            <div style="text-align:center; padding:48px; color:var(--text-muted);">
                <span class="material-icons-round" style="animation:spin 1s linear infinite; font-size:2rem;">autorenew</span>
                <div style="margin-top:8px; font-weight:700; font-size:0.8rem;">Loading Subscriptions...</div>
            </div>
        </div>
        `;

        try {
            const isDailyOn = userData.stats?.subscriptions?.dailyQuiz !== false;
            const isAdviceOn = userData.stats?.subscriptions?.advice !== false;

            // Fetch dynamic events
            await _throttledRefresh('subscription_events');
            const events = await sync.collection('subscription_events');
            events.sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

            // Check registrations for the current user
            const uid = auth.currentUser?.uid;
            let dynamicHTML = '';

            if (events.length > 0 && uid) {
                for (const ev of events) {
                    const regData = await sync.doc('subscription_events/' + ev.id + '/registrations/' + uid);
                    const isRegistered = !!regData;
                    const subjects = isRegistered ? regData.subjects : [];

                    let actionBtn = isRegistered ? 
                        `<button class="btn btn-outline btn-sm" style="border-color:#f59e0b; color:#f59e0b; pointer-events:none;" disabled>Registered</button>` : 
                        `<button class="btn btn-primary btn-sm btn-register-dynamic" data-event-id="${ev.id}" data-event-title="${ev.title.replace(/"/g, '&quot;')}" data-subjects="${encodeURIComponent(JSON.stringify(ev.availableSubjects||[]))}" data-max="${ev.maxSubjects||10}" style="background:#f59e0b; border-color:var(--border);">Register</button>`;
                    
                    let subjectsLabel = isRegistered ? 
                        `<div style="font-size:0.65rem; color:#f59e0b; margin-top:4px; font-weight:700;">Subjects: ${subjects.map(s => typeof s === 'string' ? s : (s.name || s)).join(', ')}</div>` : '';

                    dynamicHTML += `
                    <div class="card" style="padding:20px; border-color: #f59e0b;">
                        <div style="display:flex; align-items:center; gap:16px;">
                            <div style="width:44px; height:44px; border-radius:var(--r-md); background:rgba(251,191,36,0.1); border:2px solid #f59e0b; display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                                <span class="material-icons-round" style="color:#f59e0b;">workspace_premium</span>
                            </div>
                            <div style="flex:1;">
                                <div style="font-weight:700;">${ev.title}</div>
                                <div style="font-size:0.7rem; color:var(--text-muted);">${ev.description}</div>
                                ${subjectsLabel}
                            </div>
                            ${actionBtn}
                        </div>
                    </div>
                    `;
                }
            } else if (events.length === 0) {
                dynamicHTML = `<div style="text-align:center; padding:16px; font-size:0.7rem; color:var(--text-muted); border:2px dashed var(--border); border-radius:12px;">No premium subscriptions available at the moment.</div>`;
            }

            const container = document.getElementById('subs-container');
            if (!container) return;

            container.innerHTML = `
                <div style="font-weight:700; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); padding:0 4px; margin-bottom: 4px;">Free</div>
                <div class="card" style="padding:20px;">
                    <div style="display:flex; align-items:center; gap:16px;">
                        <div style="width:44px; height:44px; border-radius:var(--r-md); background:var(--brand-dim); border:2px solid var(--brand-glow); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <span class="material-icons-round" style="color:var(--brand);">today</span>
                        </div>
                        <div style="flex:1;">
                            <div style="font-weight:700;">Daily Quizzes</div>
                            <div style="font-size:0.7rem; color:var(--text-muted);">Curated daily practice delivered straight to your schedule.</div>
                        </div>
                        <label class="ef-toggle">
                            <input type="checkbox" id="sub-daily-toggle" ${isDailyOn ? 'checked' : ''}>
                            <span class="ef-toggle-track"></span>
                        </label>
                    </div>
                </div>

                <div class="card" style="padding:20px;">
                    <div style="display:flex; align-items:center; gap:16px;">
                        <div style="width:44px; height:44px; border-radius:var(--r-md); background:var(--brand-dim); border:2px solid var(--brand-glow); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                            <span class="material-icons-round" style="color:var(--brand);">tips_and_updates</span>
                        </div>
                        <div style="flex:1;">
                            <div style="font-weight:700;">ExamForge Advice</div>
                            <div style="font-size:0.7rem; color:var(--text-muted);">Educational tips and study strategies delivered to you.</div>
                        </div>
                        <label class="ef-toggle">
                            <input type="checkbox" id="sub-advice-toggle" ${isAdviceOn ? 'checked' : ''}>
                            <span class="ef-toggle-track"></span>
                        </label>
                    </div>
                </div>

                <div style="font-weight:700; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); padding:0 4px; margin: 12px 0 4px 0;">Premium Events</div>
                ${dynamicHTML}
                <div style="text-align:center; padding:8px; font-size:0.65rem; color:var(--text-muted); margin-top: 8px;">
                    Premium subscriptions are managed by your institution admin.
                </div>
            `;

            // Attach toggle listeners
            const saveSubToFirestore = async (key, value) => {
                if (!auth.currentUser) return;
                try {
                    const { updateDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                    await updateDoc(doc(db, 'users', auth.currentUser.uid), { [`subscriptions.${key}`]: value });
                    if (!userData.stats.subscriptions) userData.stats.subscriptions = {};
                    userData.stats.subscriptions[key] = value;
                } catch (e) { console.error('Sub save failed:', e); }
            };

            document.getElementById('sub-daily-toggle')?.addEventListener('change', e => saveSubToFirestore('dailyQuiz', e.target.checked));
            document.getElementById('sub-advice-toggle')?.addEventListener('change', e => saveSubToFirestore('advice', e.target.checked));

            // Attach dynamic register listeners
            document.querySelectorAll('.btn-register-dynamic').forEach(btn => {
                btn.addEventListener('click', () => {
                    const eventId = btn.getAttribute('data-event-id');
                    const title = btn.getAttribute('data-event-title');
                    const rawSubjects = btn.getAttribute('data-subjects');
                    let subjects = [];
                    try {
                        const parsed = JSON.parse(decodeURIComponent(rawSubjects));
                        subjects = (parsed || []).map(s => typeof s === 'string' ? s : (s.name || String(s)));
                    } catch(e) {
                        subjects = (rawSubjects || '').split('|').filter(Boolean);
                    }
                    const max = parseInt(btn.getAttribute('data-max'), 10) || 10;
                    window.openDynamicRegistrationModal(eventId, title, subjects, max);
                });
            });

        } catch (e) {
            console.error(e);
            workspace.innerHTML = `<div style="padding:24px; color:var(--brand); text-align:center;">Failed to load subscriptions: ${e.message}</div>`;
        }
    }

    window.openDynamicRegistrationModal = function(eventId, title, availableSubjects, maxSubjects) {
        const modal = document.createElement('div');
        modal.id = 'ef-reg-modal';
        modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:3000;animation:popIn 0.3s ease;';
        
        const checksHTML = availableSubjects.map(s => {
            const name = typeof s === 'string' ? s : (s.name || String(s));
            return `
            <label style="display:flex; align-items:center; gap:8px; padding:10px 14px; background:var(--bg-inset); border:2px solid var(--border); border-radius:8px; cursor:pointer;">
                <input type="checkbox" class="reg-subject-cb" value="${name.replace(/\"/g, '"')}" style="width:18px;height:18px;accent-color:var(--brand);">
                <span>${name}</span>
            </label>
        `;
        }).join('');

        // Step 1: Key entry UI (shown first)
        modal.innerHTML = `
            <div class="card" id="ef-reg-step1" style="width:min(440px, 90vw); display:flex; flex-direction:column; overflow:hidden; border:4px solid var(--text);background:var(--bg-card); border-radius:16px;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:3px solid var(--text); background:var(--bg-card);">
                    <div style="font-weight:900; font-size:1.1rem; color:var(--text); text-transform:uppercase; letter-spacing:0.05em;">Enter Registration Key</div>
                    <button onclick="document.getElementById('ef-reg-modal').remove()" style="background:var(--bg-inset); border:2px solid var(--text);border-radius:8px; cursor:pointer; padding:6px; display:flex; align-items:center;">
                        <span class="material-icons-round" style="font-size:1.1rem; color:var(--text);">close</span>
                    </button>
                </div>
                <div style="padding:20px; display:flex; flex-direction:column; gap:16px;">
                    <div>
                        <div style="font-weight:800; font-size:0.95rem; color:var(--text);">${title}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">Please enter your unique 10-digit registration key to continue.</div>
                    </div>
                    <div>
                        <label style="font-weight:700;font-size:0.75rem;color:var(--text-muted);display:block;margin-bottom:6px;">10-Digit Key</label>
                        <input type="text" id="ef-reg-key-input" maxlength="10" placeholder="e.g. 1234567890"
                            style="width:100%;padding:12px 14px;border:3px solid var(--text);border-radius:8px;background:var(--bg-inset);color:var(--text);font-size:1.2rem;font-weight:900;font-family:var(--font-mono);text-align:center;letter-spacing:0.15em;outline:none;box-sizing:border-box;"
                            oninput="this.value=this.value.replace(/\D/g,'').slice(0,10)">
                        <div id="ef-reg-key-error" style="font-size:0.7rem;color:#dc2626;font-weight:700;margin-top:6px;display:none;"></div>
                    </div>
                </div>
                <div style="display:flex; align-items:center; justify-content:flex-end; gap:12px; padding:16px 20px; border-top:3px solid var(--text); background:var(--bg-card);">
                    <button class="btn btn-primary" id="btn-validate-key" style="font-weight:900; border:3px solid var(--text);padding:10px 24px; width:100%;">VALIDATE KEY</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Step 2: Subject selection (shown after key validation)
        // This is generated dynamically but stored for later use
        const step2HTML = `
            <div class="card" id="ef-reg-step2" style="width:min(440px, 90vw); display:none; flex-direction:column; overflow:hidden; border:4px solid var(--text);background:var(--bg-card); border-radius:16px;">
                <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:3px solid var(--text); background:var(--bg-card);">
                    <div style="font-weight:900; font-size:1.1rem; color:var(--text); text-transform:uppercase; letter-spacing:0.05em;">Register</div>
                    <button onclick="document.getElementById('ef-reg-modal').remove()" style="background:var(--bg-inset); border:2px solid var(--text);border-radius:8px; cursor:pointer; padding:6px; display:flex; align-items:center;">
                        <span class="material-icons-round" style="font-size:1.1rem; color:var(--text);">close</span>
                    </button>
                </div>
                <div style="padding:20px; display:flex; flex-direction:column; gap:16px;">
                    <div>
                        <div style="font-weight:800; font-size:0.95rem; color:var(--text);">${title}</div>
                        <div style="font-size:0.75rem; color:var(--text-muted); margin-top:4px;">Select up to ${maxSubjects} subject(s) you wish to enroll in for this event.</div>
                    </div>
                    <div style="display:flex; flex-direction:column; gap:8px;">
                        ${checksHTML}
                    </div>
                </div>
                <div style="display:flex; align-items:center; justify-content:flex-end; gap:12px; padding:16px 20px; border-top:3px solid var(--text); background:var(--bg-card);">
                    <button class="btn btn-primary" id="btn-submit-reg" style="font-weight:900; border:3px solid var(--text);padding:10px 24px; width:100%;">CONFIRM REGISTRATION</button>
                </div>
            </div>
        `;

        // Append step 2 HTML (hidden)
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = step2HTML;
        modal.appendChild(tempDiv.firstElementChild);

        // Variable to store the validated key
        let validatedKey = null;

        // Step 1: Validate Key
        document.getElementById('btn-validate-key').onclick = async () => {
            const input = document.getElementById('ef-reg-key-input');
            const errorEl = document.getElementById('ef-reg-key-error');
            const key = input.value.trim();

            if (key.length !== 10) {
                errorEl.textContent = 'Please enter a valid 10-digit key.';
                errorEl.style.display = 'block';
                return;
            }

            const btn = document.getElementById('btn-validate-key');
            btn.disabled = true; btn.textContent = 'VALIDATING...';
            errorEl.style.display = 'none';

            try {
                const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                const keyDoc = await getDoc(doc(db, 'subscription_events', eventId, 'keys', key));

                if (!keyDoc.exists()) {
                    errorEl.textContent = 'Invalid key. This key was not found.';
                    errorEl.style.display = 'block';
                    btn.disabled = false; btn.textContent = 'VALIDATE KEY';
                    return;
                }

                const keyData = keyDoc.data();
                if (keyData.used === true) {
                    errorEl.textContent = 'This key has already been used. Please use a different key.';
                    errorEl.style.display = 'block';
                    btn.disabled = false; btn.textContent = 'VALIDATE KEY';
                    return;
                }

                // Key is valid and unused!
                validatedKey = key;

                // Hide step 1, show step 2
                document.getElementById('ef-reg-step1').style.display = 'none';
                document.getElementById('ef-reg-step2').style.display = 'flex';

            } catch (e) {
                console.error(e);
                errorEl.textContent = 'Error validating key: ' + e.message;
                errorEl.style.display = 'block';
                btn.disabled = false; btn.textContent = 'VALIDATE KEY';
            }
        };

        // Enforce max selections
        const cbs = modal.querySelectorAll('.reg-subject-cb');
        cbs.forEach(cb => {
            cb.addEventListener('change', () => {
                const checkedCount = Array.from(cbs).filter(c => c.checked).length;
                if (checkedCount > maxSubjects) {
                    cb.checked = false;
                    window.showEFModal("Limit Reached", `You can only select up to ${maxSubjects} subjects.`, "OK", null, true);
                }
            });
        });

        // Submit registration with key claim
        document.getElementById('btn-submit-reg').onclick = async () => {
            const selected = Array.from(cbs).filter(c => c.checked).map(c => c.value);
            if (selected.length === 0) {
                return window.showEFModal("Validation", "Please select at least one subject.", "OK", null, true);
            }

            if (!validatedKey) {
                return window.showEFModal("Error", "Session expired. Please start again.", "OK", null, true);
            }

            const btn = document.getElementById('btn-submit-reg');
            btn.disabled = true; btn.textContent = 'SAVING...';

            try {
                const { runTransaction, doc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                const uid = auth.currentUser.uid;

                // Use a transaction to atomically claim the key AND create registration
                await runTransaction(db, async (transaction) => {
                    const keyRef = doc(db, 'subscription_events', eventId, 'keys', validatedKey);
                    const keySnap = await transaction.get(keyRef);

                    if (!keySnap.exists()) {
                        throw new Error("Key no longer exists.");
                    }

                    const keyData = keySnap.data();
                    if (keyData.used === true) {
                        throw new Error("This key has already been used by someone else.");
                    }

                    // Claim the key
                    transaction.update(keyRef, {
                        used: true,
                        usedBy: uid,
                        usedAt: serverTimestamp()
                    });

                    // Create registration
                    const regRef = doc(db, 'subscription_events', eventId, 'registrations', uid);
                    transaction.set(regRef, {
                        uid,
                        subjects: selected,
                        registeredAt: serverTimestamp()
                    });
                });

                modal.remove();
                window.showEFModal("Success", "Registration successful! You will be notified when your exams are ready.", "AWESOME", null, true);

                // Re-render subscriptions page if it exists
                if (typeof renderSubscriptions === 'function') {
                    renderSubscriptions();
                }

            } catch (e) {
                console.error(e);
                btn.disabled = false; btn.textContent = 'CONFIRM REGISTRATION';

                let errorMsg = e.message;
                if (errorMsg.includes("already been used")) {
                    // Key was taken between validation and submission - go back to step 1
                    validatedKey = null;
                    document.getElementById('ef-reg-step2').style.display = 'none';
                    document.getElementById('ef-reg-step1').style.display = 'flex';
                    document.getElementById('ef-reg-key-input').value = '';
                    const errorEl = document.getElementById('ef-reg-key-error');
                    errorEl.textContent = errorMsg + ' Please try a different key.';
                    errorEl.style.display = 'block';
                    const validateBtn = document.getElementById('btn-validate-key');
                    validateBtn.disabled = false; validateBtn.textContent = 'VALIDATE KEY';
                } else {
                    window.showEFModal("Error", errorMsg, "OK", null, true);
                }
            }
        };
    };

    // ─── LIBRARY ──────────────────────────────────────────────────
    // uniCourses is now populated from Firestore — shape: { id, title, level, description, topicCount }
    // libCourseCache avoids re-fetching on every search keystroke
    let libCourseCache = [];

    async function renderLibrary() {
        workspace.innerHTML = `
            <div class="page-header">
                <div class="page-title">Exam Library</div>
                <div class="page-sub">Browse by course code or subject — select a course to begin</div>
            </div>

            <div class="lib-search-wrap">
                <div class="search-box">
                    <span class="material-icons-round">search</span>
                    <input type="text" id="libSearch" placeholder="Course code or title..." autocomplete="off" value="${libQuery}">
                </div>
                <div class="suggestion-panel" id="suggPanel"></div>
            </div>

            <div class="tab-bar">
                <button class="tab-btn ${libTab === 'ssce' ? 'active' : ''}" id="tabSSCE">SSCE / UTME</button>
                <button class="tab-btn ${libTab === 'university' ? 'active' : ''}" id="tabUni">University</button>
            </div>

            <div class="card-grid" id="libGrid">
                <div class="empty-state">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;">autorenew</span>
                    <div class="empty-desc">Loading courses…</div>
                </div>
            </div>
        `;
        attachLibEvents();

        if (libTab === 'ssce') {
            document.getElementById('libGrid').innerHTML = `
                <div class="empty-state">
                    <span class="material-icons-round">construction</span>
                    <div class="empty-title">Archive Offline</div>
                    <div class="empty-desc">SSCE and UTME question banks are currently being prepared. Check back soon.</div>
                </div>`;
            return;
        }

        // Use cache if already loaded, otherwise fetch from Firestore
        if (!libCourseCache.length) {
            try {
                await _throttledRefresh('unicourses');
                const allCourses = await sync.collection('unicourses');
                // Fetch topic counts in parallel
                const courses = await Promise.all(allCourses.map(async c => {
                    let topicCount = 0;
                    try {
                        const topics = await sync.collection('unicourses/' + c.id + '/topics');
                        topicCount = topics.length;
                    } catch (_) {}
                    return {
                        id: c.id,
                        title: c.title || c.id.toUpperCase(),
                        level: c.level || '',
                        description: c.description || '',
                        topicCount
                    };
                }));
                // Sort: by level first, then alphabetically by id
                libCourseCache = courses.sort((a, b) => {
                    const lvA = parseInt(a.level) || 0;
                    const lvB = parseInt(b.level) || 0;
                    return lvA !== lvB ? lvA - lvB : a.id.localeCompare(b.id);
                });
                uniCourses = libCourseCache; // keep outer var in sync for legacy compat
            } catch (e) {
                console.error(e);
                document.getElementById('libGrid').innerHTML = `
                    <div class="empty-state">
                        <span class="material-icons-round">error_outline</span>
                        <div class="empty-title">Failed to load library</div>
                        <div class="empty-desc">${e.message}</div>
                    </div>`;
                return;
            }
        }

        renderLibGrid();
    }

    function renderLibGrid() {
        const grid = document.getElementById('libGrid');
        if (!grid) return;

        const q = libQuery.toLowerCase().trim();
        const filtered = libCourseCache.filter(c =>
            !q ||
            c.id.toLowerCase().includes(q) ||
            c.title.toLowerCase().includes(q) ||
            (c.level || '').toLowerCase().includes(q)
        );

        if (!filtered.length) {
            grid.innerHTML = `
                <div class="empty-state">
                    <span class="material-icons-round">search_off</span>
                    <div class="empty-title">No results for "${libQuery}"</div>
                    <div class="empty-desc">Try a different course code or keyword.</div>
                </div>`;
            return;
        }

        grid.innerHTML = filtered.map(c => `
            <div class="card course-card">
                <div class="card-eyebrow">
                    <span class="course-code">${c.id.toUpperCase()}</span>
                    ${c.level ? `<span class="level-tag">${c.level}</span>` : ''}
                </div>
                <div class="card-title">${c.title}</div>
                <div class="card-desc">
                    ${c.description || `${c.topicCount} topic${c.topicCount !== 1 ? 's' : ''} available`}
                </div>
                <button class="btn btn-primary btn-block"
                    onclick="window.openCourse('${encodeURIComponent(c.id)}', '${encodeURIComponent(c.title)}')">
                    <span class="material-icons-round">play_arrow</span> Enter Course
                </button>
            </div>
        `).join('');
    }

    function attachLibEvents() {
        const libSearch = document.getElementById('libSearch');
        const suggPanel = document.getElementById('suggPanel');

        document.getElementById('tabSSCE').addEventListener('click', () => {
            libTab = 'ssce';
            libCourseCache = []; // clear cache when switching tabs
            renderLibrary();
        });
        document.getElementById('tabUni').addEventListener('click', () => {
            libTab = 'university';
            renderLibrary();
        });

        libSearch.addEventListener('input', e => {
            libQuery = e.target.value;
            // Suggestions from cache
            if (libQuery.length > 1 && libCourseCache.length) {
                const q = libQuery.toLowerCase();
                const matches = libCourseCache.filter(c =>
                    c.id.toLowerCase().includes(q) || c.title.toLowerCase().includes(q)
                ).slice(0, 6);

                if (matches.length) {
                    suggPanel.innerHTML = matches.map(m => `
                        <div class="suggestion-row" onclick="window.setLibQuery('${m.title.replace(/'/g, "\\'")}')">
                            <span class="code">${m.id.toUpperCase()}</span>
                            <span>${m.title}</span>
                        </div>
                    `).join('');
                    suggPanel.style.display = 'block';
                } else {
                    suggPanel.style.display = 'none';
                }
            } else {
                suggPanel.style.display = 'none';
            }
            renderLibGrid();
        });

        libSearch.addEventListener('keydown', e => {
            if (e.key === 'Escape' || e.key === 'Enter') suggPanel.style.display = 'none';
        });

        document.addEventListener('click', e => {
            if (!e.target.closest('.lib-search-wrap')) suggPanel.style.display = 'none';
        }, { once: true });
    }

    // ── Share URL builder ──────────────────────────────────────────
    window.buildShareUrl = function(params = {}) {
        const base = new URL('share.html', location.origin + location.pathname.replace(/[^/]*$/, ''));
        Object.entries(params).forEach(([k, v]) => { if (v !== null && v !== undefined && v !== '') base.searchParams.set(k, v); });
        return base.toString();
    };

    window.copyShareLink = function(url, btnEl) {
        navigator.clipboard.writeText(url).then(() => {
            const orig = btnEl.innerHTML;
            btnEl.innerHTML = '<span class="material-icons-round" style="font-size:0.9rem;vertical-align:middle;">check</span> Copied!';
            btnEl.style.color = '#16a34a';
            setTimeout(() => { btnEl.innerHTML = orig; btnEl.style.color = ''; }, 2000);
        }).catch(() => {
            prompt('Copy this link:', url);
        });
    };

    window.setLibQuery = val => { libQuery = val; renderLibGrid(); };

    // openCourse now accepts either old JSON link format OR new courseId format
    window.openCourse = (encodedLink, encodedTitle) => {
        const link = decodeURIComponent(encodedLink);
        const title = decodeURIComponent(encodedTitle);
        // New format: courseId is passed directly (no '?' or 'json=' in it)
        if (!link.includes('?') && !link.includes('/')) {
            navigate('topics', { courseId: link, title });
        } else {
            // Legacy: ?json=mth101.json
            const urlPart = link.includes('?') ? link.split('?')[1] : '';
            const jsonFile = new URLSearchParams(urlPart).get('json');
            if (jsonFile) navigate('topics', { courseId: jsonFile.replace('.json',''), title });
        }
    };

    // ─── TOPICS ───────────────────────────────────────────────────
    function renderTopics({ courseId, title, jsonFile }) {
        // legacy fallback: if only jsonFile was passed, derive courseId from it
        const cId = courseId || (jsonFile ? jsonFile.replace('.json','') : null);
        if (!cId) { navigate('library'); return; }

        workspace.innerHTML = `
            <div class="page-header">
                <button class="btn btn-ghost" onclick="efNavigate('library')" style="margin-bottom:14px;">
                    <span class="material-icons-round">arrow_back</span> Back to Library
                </button>
                <div class="page-title">${title || cId.toUpperCase()}</div>
                <div class="page-sub">Select a topic to practice, or launch the full course exam</div>
            </div>
            <div class="card-grid" id="topicsGrid">
                <div class="empty-state">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;">autorenew</span>
                    <div class="empty-desc">Loading topics…</div>
                </div>
            </div>
        `;
        loadTopics(cId, title || cId.toUpperCase());
    }

    async function loadTopics(courseId, courseTitle) {
        const grid = document.getElementById('topicsGrid');
        if (!grid) return;

        try {
            const topics = await sync.collection('unicourses/' + courseId + '/topics');
            
            if (!topics.length) {
                grid.innerHTML = `
                    <div class="empty-state">
                        <span class="material-icons-round">construction</span>
                        <div class="empty-title">No Topics Yet</div>
                        <div class="empty-desc">This course has no topics configured yet. Check back soon.</div>
                    </div>`;
                return;
            }

            // Sort topics alphabetically by id, hide private ones from students
            const isAdminUser = userData.stats?.role === 'admin';
            const filteredTopics = topics
                .filter(t => isAdminUser || !t.isPrivate)
                .sort((a, b) => a.id.localeCompare(b.id));

            let htmlStr = filteredTopics.map((t, i) => {
                const qCount = (t.questions || []).length;
                const label = t.title || t.id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
                const timeLabel = t.timeLimit ? `${t.timeLimit} min` : '';
                const quizUrl = `quiz.html?course=${encodeURIComponent(courseId)}&topic=${encodeURIComponent(t.id)}&title=${encodeURIComponent(label)}`;
                const shareUrl = window.buildShareUrl({
                    course: courseId, topic: t.id, title: label,
                    timeLimit: t.timeLimit || '',
                    strict: t.isStrict ? '1' : '',
                    mock:   t.isMock   ? '1' : '',
                });
                return `
                <div class="card course-card">
                    <div class="card-eyebrow">
                        <span class="course-code">Topic ${String(i + 1).padStart(2, '0')}</span>
                        ${timeLabel ? `<span class="level-tag">${timeLabel}</span>` : ''}
                    </div>
                    <div class="card-title">${label}</div>
                    <div class="card-desc" style="font-size:0.75rem; color:var(--text-muted);">
                        ${qCount} question${qCount !== 1 ? 's' : ''} available
                        ${qCount > 40 ? ' · capped at 40 per session' : ''}
                    </div>
                    <div class="card-action-row">
                        <button class="btn btn-outline btn-block" onclick="window.location.href='${quizUrl}'">
                            <span class="material-icons-round">edit</span> Practice
                        </button>
                    </div>
                </div>`;
            }).join('');

            // Full exam card — merges all topics
            const fullUrl = `quiz.html?course=${encodeURIComponent(courseId)}&topic=__full__&title=${encodeURIComponent(courseTitle + ' — Full Exam')}`;
            const fullShareUrl = window.buildShareUrl({ course: courseId, topic: '__full__', title: courseTitle + ' — Full Exam' });
            htmlStr += `
                <div class="card course-card card-accent">
                    <div class="card-eyebrow">
                        <span class="course-code" style="color:var(--brand)">Full Exam</span>
                        <span class="level-tag" style="color:var(--brand); border-color:var(--brand-glow)">All Topics</span>
                    </div>
                    <div class="card-title">Complete Course Evaluation</div>
                    <div class="card-desc">Draws up to 40 questions across all topics. Timed and scored against the leaderboard.</div>
                    <div class="card-action-row">
                        <button class="btn btn-primary btn-block" onclick="window.location.href='${fullUrl}'">
                            <span class="material-icons-round">rocket_launch</span> Start Full Exam
                        </button>
                    </div>
                </div>`;

            grid.innerHTML = htmlStr;

        } catch (e) {
            console.error(e);
            grid.innerHTML = `
                <div class="empty-state">
                    <span class="material-icons-round">error_outline</span>
                    <div class="empty-title">Load Failed</div>
                    <div class="empty-desc">${e.message}</div>
                </div>`;
        }
    }

    // ─── SCHEDULE ─────────────────────────────────────────────────
    async function renderSchedule() {
        workspace.innerHTML = `
            <div class="page-header">
                <div class="page-title">Schedule</div>
                <div class="page-sub">Your upcoming quizzes and exam bookings</div>
            </div>
            <div id="schedule-content">
                <div style="text-align:center;padding:56px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;">autorenew</span>
                </div>
            </div>`;

        try {
            await _throttledRefresh('users/' + auth.currentUser.uid + '/schedule');
            const schedItems = await sync.collection('users/' + auth.currentUser.uid + '/schedule');
            userData.schedule = (schedItems || []).sort((a, b) => (a.timestamp?.seconds || 0) - (b.timestamp?.seconds || 0));
        } catch(e) { console.error(e); }

        const container = document.getElementById('schedule-content');
        if (!container) return;

        const now = Date.now();
        const getDueMs = s => {
            if (s.dueTimestamp?.toMillis) return s.dueTimestamp.toMillis();
            if (s.dueDate) return new Date(s.dueDate + 'T' + (s.dueTime || '23:59')).getTime();
            return null;
        };

        // Auto-delete expired and hide from view
        const expired = userData.schedule.filter(s => { const ms = getDueMs(s); return ms !== null && ms < now; });
        if (expired.length) {
            const b = writeBatch(db);
            expired.forEach(s => b.delete(doc(db, `users/${auth.currentUser.uid}/schedule`, s.id)));
            b.commit().catch(console.error);
        }
        const active = userData.schedule.filter(s => { const ms = getDueMs(s); return ms === null || ms >= now; });

        if (!active.length) {
            container.innerHTML = `
                <div style="text-align:center;padding:72px 24px;color:var(--text-muted);">
                    <span class="material-icons-round" style="font-size:3rem;display:block;margin-bottom:12px;opacity:0.25;">event_busy</span>
                    <div style="font-weight:800;font-size:0.9rem;margin-bottom:4px;">Nothing scheduled</div>
                    <div style="font-size:0.75rem;">Daily quizzes and exam bookings will appear here.</div>
                </div>`;
            return;
        }

        const typeConfig = {
            daily_quiz: { icon:'today',  bg:'rgba(37,99,235,0.08)',  border:'#2563eb', color:'#2563eb',  label:'DAILY QUIZ' },
            default:    { icon:'event',  bg:'var(--brand-dim)',       border:'var(--brand-glow)', color:'var(--brand)', label:'EXAM' }
        };

        container.innerHTML = `
            <style>
                .sched-card {
                    display:grid;
                    grid-template-columns: 44px 1fr auto;
                    align-items:start;
                    gap:14px;
                    background:var(--bg-card);
                    border:1.5px solid var(--border);
                    border-radius:12px;
                    padding:16px;
                    margin-bottom:10px;
                    max-width:680px;
                    transition:border-color .15s;
                }
                .sched-card:hover { border-color:var(--brand-glow); }
                .sched-icon {
                    width:44px; height:44px; border-radius:10px;
                    display:flex; align-items:center; justify-content:center; flex-shrink:0;
                    border:1.5px solid;
                }
                .sched-title {
                    font-weight:800; font-size:0.9rem; color:var(--text);
                    line-height:1.3; margin-bottom:6px;
                }
                .sched-badge {
                    display:inline-flex; align-items:center;
                    font-size:0.58rem; font-weight:900; letter-spacing:0.05em;
                    padding:2px 7px; border-radius:4px; border:1px solid;
                    text-transform:uppercase; margin-left:6px; vertical-align:middle;
                }
                .sched-meta {
                    display:flex; align-items:center; flex-wrap:wrap; gap:12px;
                    font-size:0.72rem; color:var(--text-muted); font-weight:600;
                }
                .sched-meta span { display:flex; align-items:center; gap:3px; }
                .sched-meta .material-icons-round { font-size:0.85rem; }
                .sched-msg {
                    margin-top:8px; font-size:0.72rem; color:var(--text-muted);
                    font-style:italic; line-height:1.5;
                    padding:6px 10px; background:var(--bg-inset);
                    border-radius:6px; border-left:3px solid var(--brand-glow);
                }
                .sched-actions { display:flex; align-items:center; gap:6px; }
                @media(max-width:420px){
                    .sched-card { grid-template-columns:36px 1fr; }
                    .sched-actions { grid-column:1/-1; justify-content:flex-end; }
                }
            </style>
            ${active.map(s => {
                const tc    = typeConfig[s.type] || typeConfig.default;
                const due   = s.dueDate || s.date || '';
                const time  = s.dueTime || s.time || '';
                const dueMs = getDueMs(s);
                const hoursLeft = dueMs ? Math.round((dueMs - now) / 36e5) : null;
                const urgency   = hoursLeft !== null && hoursLeft < 3
                    ? `<span class="sched-badge" style="color:#dc2626;border-color:#dc2626;background:rgba(220,38,38,0.08);">⚡ ${hoursLeft < 1 ? '< 1hr' : hoursLeft + 'h'} left</span>`
                    : hoursLeft !== null && hoursLeft < 24
                    ? `<span class="sched-badge" style="color:#d97706;border-color:#d97706;background:rgba(217,119,6,0.08);">Today</span>`
                    : '';

                return `
                <div class="sched-card">
                    <div class="sched-icon" style="background:${tc.bg};border-color:${tc.border};">
                        <span class="material-icons-round" style="color:${tc.color};font-size:1.2rem;">${tc.icon}</span>
                    </div>
                    <div style="min-width:0;">
                        <div class="sched-title">
                            ${s.course || s.title || 'Quiz'}
                            <span class="sched-badge" style="color:${tc.color};border-color:${tc.border};background:${tc.bg};">${tc.label}</span>
                            ${urgency}
                        </div>
                        <div class="sched-meta">
                            ${due   ? `<span><span class="material-icons-round">calendar_today</span>${due}</span>` : ''}
                            ${time  ? `<span><span class="material-icons-round">schedule</span>${time}</span>` : ''}
                            ${s.timeLimit ? `<span><span class="material-icons-round">timer</span>${s.timeLimit} min</span>` : ''}
                        </div>
                        ${s.message ? `<div class="sched-msg">${s.message}</div>` : ''}
                    </div>
                    <div class="sched-actions">
                        ${s.quizUrl ? `
                        <a href="${s.quizUrl}" class="btn btn-primary btn-sm" style="text-decoration:none;">
                            <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Start
                        </a>` : ''}
                        <button onclick="window.deleteScheduleItem('${s._id}')" title="Remove"
                            style="background:transparent;border:1.5px solid var(--border);border-radius:7px;cursor:pointer;padding:5px;color:var(--text-muted);display:flex;align-items:center;transition:border-color .15s;"
                            onmouseenter="this.style.borderColor='#dc2626';this.style.color='#dc2626';"
                            onmouseleave="this.style.borderColor='var(--border)';this.style.color='var(--text-muted)';">
                            <span class="material-icons-round" style="font-size:1rem;">delete_outline</span>
                        </button>
                    </div>
                </div>`;
            }).join('')}`;
    }

    window.deleteScheduleItem = async function(itemId) {
        try {
            await deleteDoc(doc(db, `users/${auth.currentUser.uid}/schedule`, itemId));
            renderSchedule();
        } catch(e) { console.error(e); }
    };


    function renderResults() {
        const analytics = getAnalytics();
        const displayResults = (userData.recentResults || []).slice(0, 50);

        // Internal helper to derive average letter grade
        const getAvgGrade = (avg) => {
            if (avg >= 70) return 'A';
            if (avg >= 60) return 'B';
            if (avg >= 50) return 'C';
            if (avg >= 45) return 'D';
            return 'E';
        };

        workspace.innerHTML = `
        <div class="page-header">
            <div class="page-title">Results</div>
            <div class="page-sub">Performance History & Analytics</div>
        </div>

        <div class="card-grid" style="grid-template-columns:repeat(2,1fr);margin-bottom:24px;">
            <div class="card stat-card">
                <div class="stat-label"><span class="material-icons-round">analytics</span>Accuracy</div>
                <div class="stat-value">${analytics.avg}%</div>
                <div style="font-size: 0.62rem; color: var(--text-muted); margin-top: 4px; font-weight: 600;">Cumulative</div>
            </div>

            <div class="card stat-card">
                <div class="stat-label"><span class="material-icons-round">assignment</span> Total Exams</div>
                <div class="stat-value">${analytics.count}</div>
                <div style="font-size: 0.62rem; color: var(--text-muted); margin-top: 4px; font-weight: 600;">Completed Sessions</div>
            </div>

            <div class="card stat-card">
                <div class="stat-label"><span class="material-icons-round">grade</span> Avg. Grade</div>
                <div class="stat-value">${displayResults.length > 0 ? getAvgGrade(analytics.avg) : '—'}</div>
                <div style="font-size: 0.62rem; color: var(--text-muted); margin-top: 4px; font-weight: 600;">Letter Standing</div>
            </div>

            <div class="card stat-card">
                <div class="stat-label"><span class="material-icons-round">workspace_premium</span> High Score</div>
                <div class="stat-value">${analytics.bestScore}%</div>
                <div style="font-size: 0.6rem; color: var(--text-muted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight:600;">${analytics.bestCourse}</div>
            </div>
        </div>

        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Course</th>
                        <th>Date</th>
                        <th>Score</th>
                        <th>Grade</th>
                        <th>Performance</th>
                    </tr>
                </thead>
                <tbody>
                    ${displayResults.length === 0 ? '<tr><td colspan="5" style="text-align:center; padding: 40px 0; color: var(--text-muted);">No results recorded yet.</td></tr>' :
                displayResults.map(r => `
                    <tr>
                        <td>${r.course}</td>
                        <td style="font-family:var(--font-mono); font-size:0.72rem;">${r.date}</td>
                        <td style="font-weight:700;">${r.score}%</td>
                        <td><span class="tag ${r.score >= 70 ? 'tag-green' : 'tag-muted'}">${r.grade}</span></td>
                        <td>
                            <div class="progress-track">
                                <div class="progress-fill" style="width:${r.score}%;"></div>
                            </div>
                        </td>
                    </tr>`).join('')}
                </tbody>
            </table>
            ${displayResults.length > 0 ? `
                <div style="text-align:center; padding:16px 0; font-size:0.68rem; color:var(--text-muted);">
                    Showing last ${displayResults.length} sessions (Max 50)
                </div>
            ` : ''}
        </div>
    `;
    }

    function buildResultsHistoryHTML(results) {
        if (results.length === 0) {
            return `<div class="empty-state"><span class="material-icons-round">assignment</span><div class="empty-title">No Results Yet</div><div class="empty-desc">Take an exam to see results here.</div></div>`;
        }
        return `
        <div class="table-wrap">
            <table>
                <thead>
                    <tr>
                        <th>Course</th>
                        <th>Date</th>
                        <th>Score</th>
                        <th>Grade</th>
                        <th>Performance</th>
                        <th style="text-align:center;">Corrections</th>
                    </tr>
                </thead>
                <tbody>
                    ${results.map(r => `
                    <tr>
                        <td>${r.course}</td>
                        <td style="font-family:var(--font-mono); font-size:0.72rem; color:var(--text-muted);">${r.date}</td>
                        <td style="font-family:var(--font-mono); font-weight:700; color:${r.score >= 80 ? '#16a34a' : r.score >= 65 ? 'var(--text)' : 'var(--brand)'};">${r.score} / ${r.total || 100}</td>
                        <td><span class="tag ${r.score >= 80 ? 'tag-green' : r.score >= 65 ? 'tag-muted' : 'tag-red'}">${r.grade}</span></td>
                        <td style="width:120px;">
                            <div class="progress-track">
                                <div class="progress-fill" style="width:${r.score}%; background:${r.score >= 80 ? '#16a34a' : r.score >= 65 ? 'var(--text-sub)' : 'var(--brand)'};"></div>
                            </div>
                        </td>
                        <td style="text-align:center;">
                            <span class="material-icons-round" style="font-size:0.9rem; color:var(--brand);">rate_review</span>
                        </td>
                    </tr>
                    `).join('')}
                </tbody>
            </table>
            <div style="text-align:center; padding:12px 0; font-size:0.68rem; color:var(--text-muted);">
                Showing last ${results.length} result${results.length !== 1 ? 's' : ''} (max 50) · Click any row for corrections
            </div>
        </div>`;
    }

    function buildSubscriptionsHTML() {
        const isDailyOn = localStorage.getItem('ef-sub-daily') !== 'false';

        return `
        <div style="display:flex; flex-direction:column; gap:16px; max-width:640px;">

            <!-- Free Subscriptions -->
            <div style="font-weight:700; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); padding:0 4px;">Free</div>

            <div class="card" style="padding:20px;">
                <div style="display:flex; align-items:center; gap:16px;">
                    <div style="width:44px; height:44px; border-radius:var(--r-md); background:var(--brand-dim); border:2px solid var(--brand-glow); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                        <span class="material-icons-round" style="color:var(--brand); font-size:1.3rem;">today</span>
                    </div>
                    <div style="flex:1;">
                        <div style="font-weight:700; font-size:0.88rem;">Daily Quizzes</div>
                        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">A curated set of practice questions delivered daily to keep your streak alive.</div>
                        <span class="tag tag-green" style="margin-top:6px; font-size:0.6rem;">FREE</span>
                    </div>
                    <label class="ef-toggle" title="Toggle Daily Quizzes">
                        <input type="checkbox" id="sub-daily-toggle" ${isDailyOn ? 'checked' : ''}>
                        <span class="ef-toggle-track"></span>
                    </label>
                </div>
            </div>

            <!-- Paid Subscriptions -->
            <div style="font-weight:700; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-muted); padding:0 4px; margin-top:8px;">Premium</div>

            <div class="card" style="padding:20px; opacity:0.9;">
                <div style="display:flex; align-items:center; gap:16px;">
                    <div style="width:44px; height:44px; border-radius:var(--r-md); background:rgba(251,191,36,0.12); border:2px solid rgba(251,191,36,0.3); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                        <span class="material-icons-round" style="color:#f59e0b; font-size:1.3rem;">event_repeat</span>
                    </div>
                    <div style="flex:1;">
                        <div style="font-weight:700; font-size:0.88rem;">Bi-Weekly Mock Exam</div>
                        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">Full-length timed mock exams every two weeks, graded and benchmarked nationally.</div>
                        <span class="tag" style="margin-top:6px; font-size:0.6rem; background:rgba(251,191,36,0.15); color:#b45309; border-color:rgba(251,191,36,0.4);">PREMIUM</span>
                    </div>
                    <button class="btn btn-primary btn-sm" style="flex-shrink:0; font-size:0.65rem;" onclick="alert('Subscription management coming soon.')">
                        Subscribe
                    </button>
                </div>
            </div>

            <div class="card" style="padding:20px; opacity:0.9;">
                <div style="display:flex; align-items:center; gap:16px;">
                    <div style="width:44px; height:44px; border-radius:var(--r-md); background:rgba(139,92,246,0.12); border:2px solid rgba(139,92,246,0.3); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                        <span class="material-icons-round" style="color:#7c3aed; font-size:1.3rem;">school</span>
                    </div>
                    <div style="flex:1;">
                        <div style="font-weight:700; font-size:0.88rem;">2026 100L Second Semester Tutorial</div>
                        <div style="font-size:0.7rem; color:var(--text-muted); margin-top:2px;">Structured tutorial sessions and question banks for all 100 Level second semester courses.</div>
                        <span class="tag" style="margin-top:6px; font-size:0.6rem; background:rgba(139,92,246,0.12); color:#5b21b6; border-color:rgba(139,92,246,0.35);">PREMIUM</span>
                    </div>
                    <button class="btn btn-primary btn-sm" style="flex-shrink:0; font-size:0.65rem;" onclick="alert('Subscription management coming soon.')">
                        Subscribe
                    </button>
                </div>
            </div>

            <div style="text-align:center; padding:8px; font-size:0.65rem; color:var(--text-muted);">
                Premium subscriptions are managed by your institution admin.
            </div>
        </div>
        `;
    }

    // ─── Result Detail / Corrections Modal ──────────────────────
    function openResultDetail(result) {
        // Create modal overlay
        const modal = document.createElement('div');
        modal.className = 'calc-overlay active';
        modal.id = 'result-detail-modal';
        modal.innerHTML = `
            <div class="card" style="margin:auto; max-width:540px; width:90vw; max-height:80vh; overflow-y:auto; padding:24px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                    <div>
                        <div style="font-weight:700; font-size:0.95rem;">${result.course}</div>
                        <div style="font-size:0.68rem; color:var(--text-muted); font-family:var(--font-mono);">${result.date}</div>
                    </div>
                    <button class="icon-btn" id="close-result-detail"><span class="material-icons-round">close</span></button>
                </div>

                <div style="display:flex; gap:12px; margin-bottom:20px; flex-wrap:wrap;">
                    <div class="card" style="flex:1; padding:14px; text-align:center; min-width:100px;">
                        <div style="font-size:1.6rem; font-weight:800; font-family:var(--font-display); color:${result.score >= 80 ? '#16a34a' : result.score >= 65 ? 'var(--text)' : 'var(--brand)'};">${result.score}%</div>
                        <div style="font-size:0.65rem; color:var(--text-muted);">Score</div>
                    </div>
                    <div class="card" style="flex:1; padding:14px; text-align:center; min-width:100px;">
                        <div style="font-size:1.6rem; font-weight:800; font-family:var(--font-display);">${result.grade || 'N/A'}</div>
                        <div style="font-size:0.65rem; color:var(--text-muted);">Grade</div>
                    </div>
                    ${result.exaChange !== undefined ? `
                    <div class="card" style="flex:1; padding:14px; text-align:center; min-width:100px;">
                        <div style="font-size:1.4rem; font-weight:800; font-family:var(--font-display); color:${result.exaChange >= 0 ? '#16a34a' : 'var(--brand)'};">${result.exaChange >= 0 ? '+' : ''}${result.exaChange}</div>
                        <div style="font-size:0.65rem; color:var(--text-muted);">EXA Δ</div>
                    </div>` : ''}
                </div>

                ${result.corrections && result.corrections.length > 0 ? `
                <div style="font-weight:700; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:12px; color:var(--text-muted);">Corrections (${result.corrections.length} wrong)</div>
                <div style="display:flex; flex-direction:column; gap:12px;">
                    ${result.corrections.map((c, i) => `
                    <div style="padding:14px; border:1px solid var(--border); border-radius:var(--r-md); background:var(--bg-inset);">
                        <div style="font-weight:600; font-size:0.78rem; margin-bottom:8px;">Q${i + 1}. ${c.question}</div>
                        <div style="display:flex; flex-direction:column; gap:4px; font-size:0.72rem;">
                            <div style="color:var(--brand); display:flex; gap:6px; align-items:center;">
                                <span class="material-icons-round" style="font-size:0.85rem;">cancel</span>
                                Your answer: ${c.yourAnswer !== undefined ? c.yourAnswer : 'Not answered'}
                            </div>
                            <div style="color:#16a34a; display:flex; gap:6px; align-items:center;">
                                <span class="material-icons-round" style="font-size:0.85rem;">check_circle</span>
                                Correct: ${c.correctAnswer}
                            </div>
                            ${c.explanation ? `<div style="margin-top:6px; padding:8px; background:var(--bg-card); border-radius:var(--r-sm); border-left:2px solid var(--brand); color:var(--text-sub); font-size:0.68rem;">${c.explanation}</div>` : ''}
                        </div>
                    </div>
                    `).join('')}
                </div>
                ` : `
                <div style="text-align:center; padding:32px 0; color:var(--text-muted);">
                    <span class="material-icons-round" style="font-size:2rem; display:block; margin-bottom:8px;">info</span>
                    <div style="font-size:0.78rem;">Detailed corrections are saved during exam sessions.<br>Start an exam to record correction data.</div>
                </div>
                `}
            </div>
        `;

        document.body.appendChild(modal);

        document.getElementById('close-result-detail').addEventListener('click', () => {
            modal.remove();
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.remove();
        });
    }

    // ─── LIVE INBOX ENGINE WITH BATCH CLEARING ─────────────────────

    // ─── LIVE INBOX ENGINE WITH GLOBAL HANDLERS ─────────────────────

    async function renderInbox() {
        workspace.innerHTML = `
            <style>
                .notif-card {
                    display:grid;
                    grid-template-columns: 44px 1fr auto;
                    align-items:start;
                    gap:14px;
                    background:var(--bg-card);
                    border:1.5px solid var(--border);
                    border-radius:12px;
                    padding:16px;
                    margin-bottom:10px;
                    max-width:680px;
                    transition:border-color .15s;
                }
                .notif-card:hover { border-color:var(--brand-glow); }
                .notif-icon-wrap {
                    width:44px; height:44px; border-radius:10px;
                    display:flex; align-items:center; justify-content:center;
                    flex-shrink:0; border:1.5px solid;
                }
                .notif-title  { font-weight:800; font-size:0.88rem; color:var(--text); line-height:1.3; margin-bottom:4px; }
                .notif-body   { font-size:0.78rem; color:var(--text-muted); line-height:1.6; }
                .notif-footer { margin-top:10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
                .notif-time   { font-size:0.62rem; font-weight:700; color:var(--text-muted); }
                .notif-dismiss {
                    background:transparent; border:1.5px solid var(--border);
                    border-radius:7px; cursor:pointer; padding:5px;
                    color:var(--text-muted); display:flex; align-items:center;
                    transition:border-color .15s, color .15s; flex-shrink:0;
                }
                .notif-dismiss:hover { border-color:#dc2626; color:#dc2626; }
                @media(max-width:420px){
                    .notif-card { grid-template-columns:36px 1fr; }
                    .notif-dismiss { grid-column:1/-1; justify-self:end; }
                }
            </style>
            <div class="page-header">
                <div style="display:flex; justify-content:space-between; align-items:flex-end; width:100%; flex-wrap:wrap; gap:12px;">
                    <div>
                        <div class="page-title">Notifications</div>
                        <div class="page-sub">Broadcasts, daily quizzes, and system alerts</div>
                    </div>
                    <button class="btn btn-ghost btn-sm" id="btnMarkAllRead" style="display:none; font-weight:800; color:var(--brand);">
                        <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">done_all</span> Clear All
                    </button>
                </div>
            </div>
            <div id="notification-feed" style="min-height:200px;">
                <div style="text-align:center;padding:48px;color:var(--text-muted);">
                    <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;">autorenew</span>
                </div>
            </div>`;

        const feed    = document.getElementById('notification-feed');
        const clearBtn = document.getElementById('btnMarkAllRead');
        if (!auth.currentUser) return;

        const typeMap = {
            warning:       { icon:'report_problem', bg:'rgba(220,38,38,0.08)',  border:'#dc2626', color:'#dc2626'  },
            broadcast:     { icon:'campaign',        bg:'rgba(37,99,235,0.08)', border:'#2563eb', color:'#2563eb'  },
            congratulatory:{ icon:'emoji_events',    bg:'rgba(22,163,74,0.08)', border:'#16a34a', color:'#16a34a'  },
            gift:          { icon:'redeem',          bg:'rgba(124,58,237,0.08)',border:'#7c3aed', color:'#7c3aed'  },
            daily_quiz:    { icon:'today',           bg:'rgba(37,99,235,0.08)', border:'#2563eb', color:'#2563eb'  },
            advice:        { icon:'tips_and_updates',bg:'rgba(124,58,237,0.08)',border:'#7c3aed', color:'#7c3aed'  },
        };

        window._inboxListener = onSnapshot(
            query(collection(db, `users/${auth.currentUser.uid}/notifications`), orderBy('timestamp','desc'), limit(30)),
            snapshot => {
                const now = Date.now();

                // Trigger Web Notification for newly added docs in real-time
                snapshot.docChanges().forEach(change => {
                    if (change.type === 'added') {
                        const n = change.doc.data();
                        const ts = n.timestamp?.toMillis ? n.timestamp.toMillis() : Date.now();
                        // Only trigger push notification if the document is less than 30s old to avoid spamming historical alerts
                        if (Date.now() - ts < 30000 && 'Notification' in window && Notification.permission === 'granted') {
                            try {
                                const notifUrl = n.actionPath || (n.resultData ? '/app.html#inbox' : '/app.html');
                                const notif = new Notification(n.title || "ExamForge", {
                                    body: n.message || "",
                                    icon: "/examforge.jpeg",
                                    badge: "/512.png",
                                    image: "/examforge.jpeg",
                                    data: { url: notifUrl },
                                    requireInteraction: true,
                                    vibrate: [200, 100, 200]
                                });
                                notif.onclick = function(e) {
                                    e.preventDefault();
                                    window.focus();
                                    if (notifUrl.includes('#')) window.location.href = '/app.html' + notifUrl;
                                    else if (notifUrl) window.location.href = notifUrl;
                                };
                            } catch (e) { console.error("Notification failed:", e); }
                        }
                    }
                });

                // Auto-delete expired notifications (all types)
                const expired = snapshot.docs.filter(d => {
                    const n = d.data();
                    const ms = n.dueTimestamp?.toMillis ? n.dueTimestamp.toMillis()
                             : n.dueDate ? new Date(n.dueDate + 'T' + (n.dueTime||'23:59')).getTime() : null;
                    return ms !== null && ms < now;
                });
                if (expired.length) {
                    const b = writeBatch(db);
                    expired.forEach(d => b.delete(d.ref));
                    b.commit().catch(console.error);
                }

                const active = snapshot.docs.filter(d => {
                    const n = d.data();
                    const ms = n.dueTimestamp?.toMillis ? n.dueTimestamp.toMillis()
                             : n.dueDate ? new Date(n.dueDate + 'T' + (n.dueTime||'23:59')).getTime() : null;
                    return ms === null || ms >= now;
                });

                clearBtn.style.display = active.length ? 'inline-flex' : 'none';
                clearBtn.onclick = () => {
                    if (!confirm('Clear all notifications?')) return;
                    const b = writeBatch(db);
                    active.forEach(d => b.delete(d.ref));
                    b.commit().catch(console.error);
                };

                if (!active.length) {
                    feed.innerHTML = `
                        <div style="text-align:center;padding:72px 24px;color:var(--text-muted);">
                            <span class="material-icons-round" style="font-size:3rem;display:block;margin-bottom:12px;opacity:0.25;">notifications_off</span>
                            <div style="font-weight:800;font-size:0.9rem;margin-bottom:4px;">Inbox is empty</div>
                            <div style="font-size:0.75rem;">Broadcasts and quiz alerts will appear here.</div>
                        </div>`;
                    return;
                }

                feed.innerHTML = active.map(docSnap => {
                    const n  = docSnap.data();
                    const id = docSnap.id;
                    const tc = typeMap[n.type] || { icon:'notifications', bg:'var(--bg-inset)', border:'var(--border)', color:'var(--text-muted)' };
                    const time = n.timestamp?.toDate ? n.timestamp.toDate().toLocaleDateString('en-NG', { day:'numeric', month:'short', year:'numeric' }) : 'Just now';

                    const actionRow = n.type === 'daily_quiz' && n.quizUrl ? `
                        <div class="notif-footer">
                            <a href="${n.quizUrl}" class="btn btn-primary btn-sm" style="text-decoration:none;" onclick="event.stopPropagation();">
                                <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Start Quiz
                            </a>
                            ${n.dueDate ? `<span class="notif-time">Due ${n.dueDate}${n.dueTime ? ' at ' + n.dueTime : ''}</span>` : ''}
                        </div>` : `<div class="notif-footer"><span class="notif-time">${time}</span></div>`;

                    return `
                    <div class="notif-card" id="notif-${id}" style="cursor:pointer;" onclick="window.viewNotificationDetails('${id}')" title="Click to view details">
                        <div class="notif-icon-wrap" style="background:${tc.bg};border-color:${tc.border};">
                            <span class="material-icons-round" style="color:${tc.color};font-size:1.2rem;">${tc.icon}</span>
                        </div>
                        <div style="min-width:0;flex:1;">
                            <div class="notif-title">${n.title || n.type.replace(/_/g,' ').replace(/\b\w/g,c=>c.toUpperCase())}</div>
                            <div class="notif-body" style="white-space: pre-wrap; word-break: break-word;">${n.message || ''}</div>
                            ${actionRow}
                        </div>
                        <button class="notif-dismiss" onclick="event.stopPropagation();window.deleteNotification('${id}')" title="Dismiss">
                            <span class="material-icons-round" style="font-size:1rem;">close</span>
                        </button>
                    </div>`;
                }).join('');
            }
        );
    }

    window.deleteNotification = async function(notifId) {
        try {
            await deleteDoc(doc(db, `users/${auth.currentUser.uid}/notifications`, notifId));
        } catch(e) { console.error(e); }
    };

    window.viewNotificationDetails = async function(notifId) {
        try {
            const n = await sync.doc('users/' + auth.currentUser.uid + '/notifications/' + notifId);
            if (!n) return;
            
            // If notification has result data, open the PDF result sheet directly
            if (n.resultData) {
                const rd = n.resultData;
                // Open the result sheet in a new tab (same as PDF generation)
                window.printResultSheet(rd.resultHTML || '');
                return; // Skip normal notification rendering
            }
            
            // If notification is a Daily Advice, render a beautiful full-page reader
            if (n.type === 'advice') {
                const overlay = document.createElement('div');
                overlay.id = 'ef-student-notif-overlay';
                overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:2500;animation:fadeIn 0.2s ease;';
                
                const time = n.timestamp?.toDate ? n.timestamp.toDate().toLocaleString('en-NG', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : 'Just now';
                const categoryColors = {
                    motivation: { bg: '#fef3c7', color: '#b45309', label: 'Motivation & Mindset' },
                    exam_tips:  { bg: '#fee2e2', color: '#b91c1c', label: 'Exam Strategy' },
                    study_hacks:{ bg: '#e0f2fe', color: '#0369a1', label: 'Study Hacks' },
                    general:    { bg: '#f3f4f6', color: '#374151', label: 'General Advice' }
                };
                const cat = categoryColors[n.category] || categoryColors.general;
                
                overlay.innerHTML = `
                    <div style="display:flex;align-items:center;gap:14px;padding:16px 24px;border-bottom:2px solid var(--border);background:var(--bg-card);flex-shrink:0;">
                        <button onclick="document.getElementById('ef-student-notif-overlay').remove()"
                            style="width:40px;height:40px;border-radius:8px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                            <span class="material-icons-round">arrow_back</span>
                        </button>
                        <div style="font-weight:900;font-size:1rem;color:var(--text);text-transform:uppercase;flex:1;display:flex;align-items:center;gap:10px;">
                            <span style="width:36px;height:36px;border-radius:8px;background:${cat.bg};border:2px solid ${cat.color};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                <span class="material-icons-round" style="color:${cat.color};font-size:1rem;">tips_and_updates</span>
                            </span>
                            Daily Advice
                        </div>
                        <button onclick="document.getElementById('ef-student-notif-overlay').remove()"
                            style="width:40px;height:40px;border-radius:8px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                            <span class="material-icons-round">close</span>
                        </button>
                    </div>
                    <div id="advice-reader-content" style="flex:1;overflow-y:auto;background:var(--bg);">
                        <div style="max-width:680px;margin:0 auto;padding:40px 24px 80px;">
                            <!-- Category Badge -->
                            <div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;font-size:0.7rem;font-weight:800;text-transform:uppercase;letter-spacing:0.06em;border:2px solid ${cat.color};background:${cat.bg};color:${cat.color};margin-bottom:20px;">
                                <span class="material-icons-round" style="font-size:0.9rem;">tips_and_updates</span>
                                ${cat.label}
                            </div>
                            
                            <!-- Title -->
                            <h1 style="font-family:'Poppins',sans-serif;font-size:1.8rem;font-weight:800;color:var(--text);line-height:1.2;margin:0 0 12px 0;letter-spacing:-0.02em;">
                                ${(n.title || 'Daily Advice').replace(/</g,'<').replace(/>/g,'>')}
                            </h1>
                            
                            <!-- Date -->
                            <div style="font-size:0.72rem;font-weight:600;color:var(--text-muted);margin-bottom:32px;display:flex;align-items:center;gap:6px;">
                                <span class="material-icons-round" style="font-size:0.85rem;">schedule</span>
                                ${time}
                            </div>
                            
                            <!-- Divider -->
                            <div style="height:3px;background:var(--border);border-radius:2px;margin-bottom:32px;"></div>
                            
                            <!-- Content -->
                            <div style="font-size:1.1rem;line-height:2;color:var(--text);font-weight:500;white-space:pre-wrap;word-break:break-word;font-family:'Poppins',sans-serif;">
                                ${(n.message || '').replace(/</g,'<').replace(/>/g,'>')}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex;align-items:center;justify-content:flex-end;gap:10px;padding:14px 24px;border-top:2px solid var(--border);background:var(--bg-card);flex-shrink:0;flex-wrap:wrap;">
                        <button class="btn btn-outline" id="btn-download-advice-png" style="font-weight:900;border:2px solid var(--text);padding:10px 20px;display:flex;align-items:center;gap:6px;flex:1;min-width:140px;justify-content:center;">
                            <span class="material-icons-round" style="font-size:1rem;">image</span> SAVE AS IMAGE
                        </button>
                        <button class="btn btn-primary" id="btn-download-advice-pdf" style="font-weight:900;border:2px solid var(--text);padding:10px 20px;display:flex;align-items:center;gap:6px;flex:1;min-width:140px;justify-content:center;">
                            <span class="material-icons-round" style="font-size:1rem;">picture_as_pdf</span> SAVE AS PDF
                        </button>
                    </div>`;
                document.body.appendChild(overlay);
                overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
                
            // Helper to dynamically load a script
            function loadScript(src) {
                return new Promise((resolve, reject) => {
                    const s = document.createElement('script');
                    s.src = src;
                    s.onload = resolve;
                    s.onerror = () => reject(new Error('Failed to load ' + src));
                    document.head.appendChild(s);
                });
            }
            
            // Attach download handlers
            setTimeout(() => {
                const contentEl = document.getElementById('advice-reader-content');
                
                document.getElementById('btn-download-advice-png')?.addEventListener('click', async () => {
                    try {
                        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');
                        const canvas = await window.html2canvas(contentEl, { 
                            scale: 2, 
                            backgroundColor: getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#fbfcff', 
                            useCORS: true,
                            logging: false
                        });
                        const link = document.createElement('a');
                        link.download = 'ExamForge_Advice.png';
                        link.href = canvas.toDataURL('image/png');
                        link.click();
                    } catch(e) {
                        console.error(e);
                        alert('Could not generate image. Error: ' + e.message);
                    }
                });
                
                document.getElementById('btn-download-advice-pdf')?.addEventListener('click', async () => {
                    try {
                        await loadScript('https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js');
                        window.html2pdf().set({
                            margin: [10, 10, 10, 10],
                            filename: 'ExamForge_Advice.pdf',
                            image: { type: 'jpeg', quality: 0.98 },
                            html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: getComputedStyle(document.body).getPropertyValue('--bg').trim() || '#fbfcff' },
                            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
                        }).from(contentEl).save();
                    } catch(e) {
                        console.error(e);
                        alert('Could not generate PDF. Error: ' + e.message);
                    }
                });
            }, 100);
                
                return;
            }
            
            const typeMap = {
                warning:       { icon:'report_problem', bg:'rgba(220,38,38,0.08)',  border:'#dc2626', color:'#dc2626', label:'Alert' },
                broadcast:     { icon:'campaign',        bg:'rgba(37,99,235,0.08)', border:'#2563eb', color:'#2563eb', label:'Broadcast' },
                congratulatory:{ icon:'emoji_events',    bg:'rgba(22,163,74,0.08)', border:'#16a34a', color:'#16a34a', label:'Achievement' },
                gift:          { icon:'redeem',          bg:'rgba(124,58,237,0.08)',border:'#7c3aed', color:'#7c3aed', label:'Gift' },
                daily_quiz:    { icon:'today',           bg:'rgba(37,99,235,0.08)', border:'#2563eb', color:'#2563eb', label:'Daily Quiz' },
                advice:        { icon:'tips_and_updates',bg:'rgba(124,58,237,0.08)',border:'#7c3aed', color:'#7c3aed', label:'Daily Advice' },
            };
            const tc = typeMap[n.type] || { icon:'notifications', bg:'var(--bg-inset)', border:'var(--border)', color:'var(--text-muted)', label:'Notification' };
            const time = n.timestamp?.toDate ? n.timestamp.toDate().toLocaleString('en-NG', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }) : 'Just now';

            const overlay = document.createElement('div');
            overlay.id = 'ef-student-notif-overlay';
            overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;z-index:2500;animation:popIn 0.3s ease;';
            overlay.innerHTML = `
                <div class="card" style="width:min(640px,92vw); max-height:80vh; display:flex; flex-direction:column; overflow:hidden; border:4px solid var(--text);background:var(--bg-card); border-radius:16px;">
                    <!-- Header -->
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:16px 20px; border-bottom:3px solid var(--text); background:var(--bg-card); flex-shrink:0;">
                         <div style="font-weight:900; font-size:1.15rem; color:var(--text); text-transform:uppercase; display:flex; align-items:center; gap:8px;">
                             <span class="material-icons-round" style="color:${tc.color};">${tc.icon}</span> ${tc.label}
                         </div>
                         <button onclick="document.getElementById('ef-student-notif-overlay').remove()" style="background:var(--bg-inset); border:2px solid var(--text);border-radius:8px; cursor:pointer; padding:6px; display:flex; align-items:center;">
                             <span class="material-icons-round" style="font-size:1.1rem; color:var(--text);">close</span>
                         </button>
                    </div>
                    <!-- Content -->
                    <div style="flex:1; overflow-y:auto; padding:20px; display:flex; flex-direction:column; gap:16px; background:var(--bg-card);">
                         <div>
                             <span style="font-size:0.65rem; font-weight:800; color:var(--text-muted); text-transform:uppercase;">Received ${time}</span>
                             <h2 style="font-weight:900; font-size:1.3rem; margin:6px 0 0 0; color:var(--text); line-height:1.3; text-transform:uppercase;">
                                 ${n.title || tc.label}
                             </h2>
                         </div>
                         
                         <div style="background:var(--bg-inset); border:3px solid var(--text);border-radius:12px; padding:20px; margin-top:4px;">
                             <div style="white-space:pre-wrap; word-break:break-word; font-size:0.88rem; line-height:1.6; font-weight:600; color:var(--text);">
                                 ${(n.message || '').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
                             </div>
                         </div>
                    </div>
                    <!-- Footer -->
                    <div style="display:flex; align-items:center; justify-content:flex-end; padding:16px 20px; border-top:3px solid var(--text); background:var(--bg-card); flex-shrink:0;">
                         <button class="btn btn-ghost" onclick="document.getElementById('ef-student-notif-overlay').remove()" style="border:3px solid var(--text);font-weight:900; font-size:0.8rem; padding:8px 16px;">CLOSE</button>
                    </div>
                </div>`;
            document.body.appendChild(overlay);
            overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
        } catch (e) {
            console.error(e);
        }
    };


    async function renderSettings() {
        const initials = document.querySelector('#profileBtn')?.textContent || 'EF';
        let currentHandle = (userData.stats.username || 'student').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '');

        // Reset workspace and force mobile-friendly constraints
        workspace.style.padding = 'clamp(10px, 3vw, 20px)';
        workspace.style.overflowX = 'hidden';
        workspace.style.fontSize = '16px';

        workspace.innerHTML = `
    <div id="ef-settings-page" style="width: 100%; max-width: 800px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; box-sizing: border-box; padding-bottom: 40px;">
        
        <div style="width: 100%; margin-bottom: 8px;">
            <div style="font-size: 1.6rem; font-weight: 900; line-height: 1.1; color: var(--text);">Settings</div>
            <div style="font-size: 0.8rem; margin-top: 4px; color: var(--text-muted); font-weight: 600;">Manage your identity and account</div>
        </div>

        <div class="card" style="width: calc(100% - 6px); padding: 16px !important; margin: 0 !important; border-bottom: 6px solid var(--brand); border-radius: 12px; box-sizing: border-box;">
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 12px; align-items: center; width: 100%;">
                <div style="width: 48px; height: 48px; border-radius: 10px; background: var(--brand); color: white; display: flex; align-items: center; justify-content: center; font-weight: 900; font-size: 1.1rem; border: 3px solid var(--text);flex-shrink: 0;">
                    ${initials}
                </div>
                <div style="min-width: 0;">
                    <div style="font-weight: 900; font-size: 1rem; color: var(--text); line-height: 1.2; word-break: break-word;">${currentUser.displayName || 'Student'}</div>
                    <div style="font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-muted); word-break: break-all;">${currentUser.email}</div>
                </div>
            </div>

            <div style="margin: 16px 0; height: 2px; background: var(--border); width: 100%; opacity: 0.2;"></div>

            <div style="width: 100%;">
                <label style="font-size: 0.65rem; font-weight: 900; text-transform: uppercase; color: var(--brand); letter-spacing: 0.05em; display: block; margin-bottom: 8px;">Handle (@username)</label>
                <div style="display: flex; flex-direction: column; gap: 12px; width: 100%;">
                    <div style="width: 100%; position: relative; padding-right: 4px; padding-bottom: 4px; box-sizing: border-box;">
                        <span style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); font-weight: 900; color: var(--text-muted); z-index: 1;">@</span>
                        <input type="text" id="edit-username-input" value="${currentHandle}" 
                            style="width: 100%; padding: 12px 12px 12px 30px; font-weight: 800; font-size: 0.95rem; color: var(--text); background: var(--bg-inset); border: 3px solid var(--text); border-radius: 8px; outline: none; box-sizing: border-box;margin: 0;">
                    </div>
                    <button class="btn btn-primary" id="btnSaveUsername" style="width: calc(100% - 4px); padding: 12px; font-weight: 900; border: 3px solid var(--text);font-size: 0.85rem; margin: 0; display: block;">SAVE CHANGES</button>
                </div>
                <div id="username-status-msg" style="font-size: 0.7rem; margin-top: 6px; font-weight: 800; min-height: 1em;"></div>
            </div>

        <div style="margin: 16px 0; height: 2px; background: var(--border); width: 100%; opacity: 0.2;"></div>

        <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 0;">
            <div style="display:flex;align-items:center;gap:10px;">
                <span class="material-icons-round" style="color:var(--text-muted);font-size:1.2rem;">${document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark_mode' : 'light_mode'}</span>
                <div>
                    <div style="font-weight:700;font-size:0.8rem;color:var(--text);">Theme</div>
                    <div style="font-size:0.65rem;color:var(--text-muted);">${document.documentElement.getAttribute('data-theme') === 'dark' ? 'Dark mode' : 'Light mode'}</div>
                </div>
            </div>
            <label class="theme-switch" style="margin:0;transform:scale(0.85);">
                <input type="checkbox" class="theme-toggle-checkbox" ${document.documentElement.getAttribute('data-theme') === 'dark' ? 'checked' : ''}>
                <span class="slider">
                    <span class="material-icons-round icon-light">light_mode</span>
                    <span class="material-icons-round icon-dark">dark_mode</span>
                </span>
            </label>
        </div>
        </div>

        <div class="card" style="width: calc(100% - 6px); padding: 16px !important; margin: 0 !important; border-radius: 12px; box-sizing: border-box;">
            <div style="font-weight: 900; font-size: 0.8rem; text-transform: uppercase; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; color: var(--text);">
                <span class="material-icons-round" style="color: var(--brand); font-size: 1rem;">security</span> Security
            </div>
            
            <div style="display: flex; flex-direction: column; gap: 12px;">
                <div style="padding: 12px; background: var(--bg-inset); border-radius: 10px; border: 2px solid var(--text); box-sizing: border-box;">
                    <div style="font-weight: 900; font-size: 0.8rem;">Password</div>
                    <p style="font-size: 0.7rem; color: var(--text-muted); margin: 4px 0 10px 0; font-weight: 600;">Request a reset link via email.</p>
                    <button class="btn btn-outline" id="btnResetPassword" style="width: 100%; border: 3px solid var(--text); font-weight: 900; font-size: 0.75rem; padding: 10px; background: white; margin: 0; display: block;">SEND RESET EMAIL</button>
                </div>
                
                <button class="btn btn-danger" id="btnLogoutFromSettings" style="width: 100%; font-weight: 900; border: 3px solid var(--text); font-size: 0.75rem; padding: 10px; margin: 0 0 12px 0; display: block;">
                    <span class="material-icons-round" style="font-size:1rem;vertical-align:middle;margin-right:6px;">logout</span> SIGN OUT
                </button>
                
                <button class="btn btn-ghost" id="btnDeleteAccountTrigger" style="width: 100%; color: var(--brand); font-weight: 900; border: 3px solid var(--brand); font-size: 0.75rem; padding: 10px; margin: 0; display: block;">
                    DELETE ACCOUNT
                </button>
            </div>
        </div>
    </div>
    `;

        // Internal Logic
        const usernameInput = document.getElementById('edit-username-input');
        const statusMsg = document.getElementById('username-status-msg');

        usernameInput.oninput = (e) => {
            const start = e.target.selectionStart;
            e.target.value = e.target.value.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '');
            e.target.setSelectionRange(start, start);
        };

        document.getElementById('btnSaveUsername').onclick = async (e) => {
            const btn = e.target;
            let newName = usernameInput.value.trim();
            if (!newName || newName === (userData.stats.username || '')) return;
            btn.disabled = true; btn.innerText = "CHECKING...";
            if (!(await isUsernameUnique(newName))) {
                statusMsg.innerText = "Handle taken."; statusMsg.style.color = "var(--brand)";
                btn.disabled = false; btn.innerText = "SAVE CHANGES"; return;
            }
            try {
                await updateDoc(doc(db, "users", currentUser.uid), { username: newName });
                statusMsg.innerText = "Updated!"; statusMsg.style.color = "#16a34a";
                userData.stats.username = newName;
            } catch (err) { statusMsg.innerText = "Error: " + err.message; }
            btn.disabled = false; btn.innerText = "SAVE CHANGES";
        };

        // Theme toggle in settings
        const settingsThemeToggle = document.querySelector('#ef-settings-page .theme-toggle-checkbox');
        if (settingsThemeToggle) {
            settingsThemeToggle.addEventListener('change', (e) => {
                const isDark = e.target.checked;
                document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
                localStorage.setItem('examforge-theme', isDark ? 'dark' : 'light');
                // Update the icon
                const icon = settingsThemeToggle.closest('div').querySelector('.material-icons-round');
                if (icon) icon.textContent = isDark ? 'dark_mode' : 'light_mode';
            });
        }

        // Re-bind other buttons
        document.getElementById('btnResetPassword').onclick = async (e) => {
            try { await sendPasswordResetEmail(auth, currentUser.email); e.target.innerText = "SENT!"; e.target.style.background = "#16a34a"; e.target.style.color = "#fff"; }
            catch (err) { window.showEFModal("Error", "Failed to send reset email.", "OKAY", null, true); }
        };

        document.getElementById('btnLogoutFromSettings')?.addEventListener('click', async () => {
            try { await signOut(auth); window.location.href = '/'; }
            catch (error) { console.error("Error signing out: ", error); }
        });

        document.getElementById('btnDeleteAccountTrigger').onclick = () => {
            window.showEFModal("Final Farewell?", "Delete your account permanently? This cannot be undone.", "DELETE", async () => {
                try { renderLoading("Purging..."); await deleteDoc(doc(db, "users", currentUser.uid)); await deleteUser(currentUser); window.location.href = '/'; }
                catch (e) { if (e.code === 'auth/requires-recent-login') signOut(auth); else renderSettings(); }
            });
        };
    }

    // ─── Spin animation for loading ───────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
        @keyframes spin { to { transform: rotate(360deg); } }

        /* EF Toggle Switch */
        .ef-toggle { position:relative; display:inline-flex; cursor:pointer; }
        .ef-toggle input { opacity:0; width:0; height:0; position:absolute; }
        .ef-toggle-track {
            width: 44px; height: 24px;
            background: var(--bg-inset);
            border: 2px solid var(--border);
            border-radius: 12px;
            position: relative;
            transition: background 0.2s, border-color 0.2s;
        }
        .ef-toggle-track::after {
            content: '';
            position: absolute;
            top: 2px; left: 2px;
            width: 16px; height: 16px;
            background: var(--text-muted);
            border-radius: 50%;
            transition: transform 0.2s, background 0.2s;
        }
        .ef-toggle input:checked + .ef-toggle-track {
            background: var(--brand-dim);
            border-color: var(--brand);
        }
        .ef-toggle input:checked + .ef-toggle-track::after {
            transform: translateX(20px);
            background: var(--brand);
        }

        /* Result row hover */
        .result-row-clickable:hover td { background: var(--brand-dim); }
    `;
    document.head.appendChild(style);

    /**
 * Checks if a username already exists in Firestore.
 */
    async function isUsernameUnique(username) {
        // Direct doc lookup — 1 read guaranteed, no collection query
        const { getDoc, doc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        const snap = await getDoc(doc(db, 'usernames', username));
        return !snap.exists();
    }


    /**
     * Generates a unique username that obeys all rules: 
     * No spaces, No capitals, No special characters except underscores.
     */
    async function generateUniqueUsername(email, displayName) {
        // 1. Force lowercase and remove ALL spaces/special chars immediately
        let base = (displayName || email.split('@')[0])
            .toLowerCase()
            .replace(/\s+/g, '') // Remove all spaces
            .replace(/[^a-z0-9_]/g, '') // Keep only lowercase, numbers, and underscores
            .substring(0, 15);

        // Fallback if the name was all emojis or symbols
        if (!base) base = "student_" + Math.floor(100 + Math.random() * 899);

        let candidate = base;
        let unique = false;
        let attempts = 0;

        while (!unique && attempts < 15) {
            const isAvailable = await isUsernameUnique(candidate);
            if (isAvailable) {
                unique = true;
            } else {
                // Append 3-4 random digits if the base is taken
                candidate = base + Math.floor(10 + Math.random() * 999);
                attempts++;
            }
        }
        return candidate;
    }
    window.showEFModal = function (title, message, confirmLabel, onConfirm, isAlert = false) {
        // Prevent stacking modals
        const existing = document.getElementById('ef-custom-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'ef-custom-modal';
        overlay.style = "position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 9999; backdrop-filter: blur(4px);";

        overlay.innerHTML = `
        <div class="card" style="padding: 32px; text-align: center; max-width: 400px; width: 90%; border: 4px solid var(--text);background: var(--bg-card); border-radius: 16px; animation: popIn 0.3s ease;">
            <div style="font-weight: 900; font-size: 1.4rem; color: var(--text); margin-bottom: 12px; text-transform: uppercase; letter-spacing: 0.05em;">${title}</div>
            <p style="font-size: 0.9rem; color: var(--text-sub); line-height: 1.5; margin-bottom: 24px; font-weight: 600;">${message}</p>
            <div style="display: flex; gap: 12px; justify-content: center;">
                ${!isAlert ? `<button class="btn btn-ghost" id="btnCancelEFModal" style="flex: 1; border: 3px solid var(--border); font-weight: 900;">CANCEL</button>` : ''}
                <button class="btn btn-primary" id="btnConfirmEFModal" style="flex: 1; font-weight: 900; border: 3px solid var(--text);">${confirmLabel}</button>
            </div>
        </div>
    `;
        document.body.appendChild(overlay);

        if (!isAlert) {
            document.getElementById('btnCancelEFModal').onclick = () => overlay.remove();
        }
        document.getElementById('btnConfirmEFModal').onclick = () => {
            overlay.remove();
            if (onConfirm) onConfirm();
        };
    };
});
function hidePreloader() {
    const preloader = document.getElementById('app-preloader');
    if (preloader) {
        preloader.classList.add('fade-out');
        // Optional: Remove from DOM after transition
        setTimeout(() => preloader.remove(), 500);
    }
}// ─── SUBSCRIPTION EVENTS HUB ──────────────────────────────────────────────

// ── Subject helper: normalize string or object to {name, creditUnit} ──
function mcNormalizeSubject(sub) {
    if (typeof sub === 'string') {
        // Parse "Math (3)" format
        const match = sub.match(/^(.+?)\s*\((\d+)\)\s*$/);
        if (match) return { name: match[1].trim(), creditUnit: parseInt(match[2]) || 1 };
        return { name: sub.trim(), creditUnit: 1 };
    }
    if (typeof sub === 'object' && sub !== null) {
        return { name: sub.name || sub, creditUnit: sub.creditUnit || 1 };
    }
    return { name: String(sub), creditUnit: 1 };
}
function mcGetSubjectName(sub) {
    return mcNormalizeSubject(sub).name;
}
function mcGetSubjectCU(sub) {
    return mcNormalizeSubject(sub).creditUnit;
}
function mcDisplaySubject(sub) {
    const n = mcNormalizeSubject(sub);
    return `${n.name} (${n.creditUnit} CU)`;
}
function mcGradeFromScore(score) {
    if (score >= 70) return { grade: 'A', points: 5.0, remark: 'Excellent' };
    if (score >= 60) return { grade: 'B', points: 4.0, remark: 'Very Good' };
    if (score >= 50) return { grade: 'C', points: 3.0, remark: 'Good' };
    if (score >= 45) return { grade: 'D', points: 2.0, remark: 'Fair' };
    if (score >= 40) return { grade: 'E', points: 1.0, remark: 'Pass' };
    return { grade: 'F', points: 0.0, remark: 'Fail' };
}
function mcGPAComment(gpa) {
    if (gpa >= 4.5) return 'Excellent! First Class Honours';
    if (gpa >= 3.5) return 'Very Good! Second Class Upper (2:1)';
    if (gpa >= 2.5) return 'Good! Second Class Lower (2:2)';
    if (gpa >= 1.5) return 'Fair! Third Class';
    if (gpa >= 1.0) return 'Pass';
    return 'You need to put in a lot of work for improvement.';
}

// ── Generate and download PDF ──
window.printResultSheet = async function(html) {
    const fullDoc = `
        <!DOCTYPE html>
        <html>
        <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>ExamForge - Official Result Sheet</title>
        <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            @page { margin: 10mm; size: A4 portrait; }
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
                font-family: 'Poppins', sans-serif;
                color: #18160F;
                font-size: 15px;
                line-height: 1.6;
                -webkit-print-color-adjust: exact;
                print-color-adjust: exact;
                position: relative;
                background: #fbfcff;
                padding: 20px;
            }
            body::before {
                content: '';
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 600px;
                height: 600px;
                background-image: url('/examforge.jpeg');
                background-size: contain;
                background-repeat: no-repeat;
                background-position: center;
                opacity: 0.04;
                pointer-events: none;
                z-index: -1;
            }
            .result-container {
                max-width: 210mm;
                margin: 0 auto;
                position: relative;
                z-index: 1;
            }
            .top-bar {
                display: flex;
                align-items: center;
                gap: 16px;
                padding: 20px 24px;
                background: #FFFFFF;
                border: 2px solid #6d6d6d;
                margin-bottom: 28px;
            }
            .top-bar img { max-width:120px; max-height:60px; width:auto; height:auto; object-fit:contain; }
            .top-bar .title-area { flex: 1; }
            .top-bar .title-area h1 {
                font-family: 'Poppins', sans-serif;
                font-size: 24px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: -0.03em;
                color: #18160F;
                line-height: 1;
            }
            .top-bar .title-area h1 span { color: #fe6961; }
            .top-bar .title-area .sub {
                font-size: 12px;
                font-weight: 600;
                color: #3a3b3d;
                text-transform: uppercase;
                letter-spacing: 0.07em;
                margin-top: 4px;
            }
            .event-banner {
                background: #fe6961;
                color: #FFFFFF;
                padding: 14px 20px;
                font-size: 20px;
                font-weight: 800;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                border: 2px solid #6d6d6d;
                margin-bottom: 20px;
            }
            .info-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 10px;
                margin-bottom: 24px;
            }
            .info-card {
                background: #FFFFFF;
                border: 1px solid #6d6d6d;
                padding: 12px 16px;
            }
            .info-card .label {
                font-size: 10px;
                font-weight: 700;
                color: #3a3b3d;
                text-transform: uppercase;
                letter-spacing: 0.08em;
            }
            .info-card .value {
                font-size: 16px;
                font-weight: 900;
                color: #18160F;
                margin-top: 2px;
            }
            table {
                width: 100%;
                border-collapse: collapse;
                margin-bottom: 24px;
                background: #FFFFFF;
                border: 2px solid #6d6d6d;
            }
            table th {
                background: #18160F;
                color: #FFFFFF;
                padding: 10px 8px;
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                border: 1px solid #333;
                text-align: center;
            }
            table th:first-child { text-align: left; }
            table td {
                padding: 10px 8px;
                border: 1px solid #666;
                text-align: center;
                font-size: 14px;
                font-weight: 600;
                color: #353637;
            }
            table td:first-child { text-align: left; font-weight: 700; color: #18160F; }
            table tr:nth-child(even) td { background: #f4f4f0; }
            .grade-A { color: #16a34a; font-weight: 800; }
            .grade-B { color: #2563eb; font-weight: 800; }
            .grade-C { color: #ca8a04; font-weight: 800; }
            .grade-D { color: #d97706; font-weight: 800; }
            .grade-E { color: #b06030; font-weight: 800; }
            .grade-F { color: #dc2626; font-weight: 800; }
            .na-subject { color: #999; font-style: italic; font-weight: 500; }
            .summary-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 12px;
                margin-bottom: 24px;
            }
            .summary-card {
                background: #FFFFFF;
                border: 2px solid #6d6d6d;
                padding: 16px;
                text-align: center;
            }
            .summary-card.gpa-card {
                background: #fe6961;
                color: #FFFFFF;
                border-color: #18160F;
            }
            .summary-card .s-label {
                font-size: 9px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #3a3b3d;
            }
            .summary-card.gpa-card .s-label { color: rgba(255,255,255,0.85); }
            .summary-card .s-value {
                font-size: 32px;
                font-weight: 900;
                color: #18160F;
                line-height: 1.1;
                margin-top: 4px;
                letter-spacing: -0.03em;
            }
            .summary-card.gpa-card .s-value { color: #FFFFFF; }
            .comment-box {
                background: #FFFFFF;
                border: 2px solid #18160F;
                padding: 16px 20px;
                margin-bottom: 24px;
            }
            .comment-box .c-label {
                font-size: 10px;
                font-weight: 700;
                color: #3a3b3d;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                margin-bottom: 4px;
            }
            .comment-box .c-text {
                font-size: 18px;
                font-weight: 700;
                color: #18160F;
            }
            .grade-ref {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin-bottom: 24px;
                padding: 12px 16px;
                background: #FFFFFF;
                border: 1px solid #666;
            }
            .grade-ref-item {
                font-size: 10px;
                font-weight: 700;
                padding: 2px 8px;
                border: 1px solid #666;
            }
            .signature-row {
                display: flex;
                justify-content: space-between;
                margin-top: 32px;
                padding: 0 10px;
            }
            .signature-box {
                text-align: center;
                font-size: 11px;
                font-weight: 600;
                color: #3a3b3d;
            }
            .signature-box .line {
                width: 180px;
                border-top: 2px solid #18160F;
                margin: 32px auto 6px;
            }
            .footer {
                margin-top: 32px;
                padding-top: 16px;
                border-top: 2px solid #666;
                font-size: 9px;
                color: #3a3b3d;
                font-weight: 600;
                text-align: center;
                text-transform: uppercase;
                letter-spacing: 0.05em;
            }
            .footer p { margin: 2px 0; }
            @media print {
                body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            }
            @media (max-width: 600px) {
                .info-grid, .summary-grid { grid-template-columns: 1fr; }
                .signature-row { flex-direction: column; gap: 16px; }
            }
        </style>
        </head>
        <body>
            <div class="result-container">
                ${html}
            </div>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"><\/script>
            <script>
                setTimeout(() => {
                    const element = document.querySelector('.result-container');
                    html2pdf().set({
                        margin: [10, 10, 10, 10],
                        filename: 'ExamForge_Result_Sheet.pdf',
                        image: { type: 'jpeg', quality: 0.98 },
                        html2canvas: { 
                            scale: 2, 
                            useCORS: true,
                            letterRendering: true,
                            backgroundColor: '#fbfcff'
                        },
                        jsPDF: { 
                            unit: 'mm', 
                            format: 'a4', 
                            orientation: 'portrait' 
                        }
                    }).from(element).save().then(() => {
                        document.querySelector('.result-container').innerHTML = '<div style="text-align:center;padding:80px 20px;font-family:Poppins,sans-serif;"><div style="font-size:48px;margin-bottom:16px;">✅</div><div style="font-size:20px;font-weight:800;margin-bottom:8px;">PDF Downloaded Successfully!</div><div style="font-size:13px;color:#666;">Check your downloads folder for ExamForge_Result_Sheet.pdf</div><div style="margin-top:24px;font-size:11px;color:#999;">You can close this window.</div></div>';
                    }).catch(() => {
                        window.print();
                    });
                }, 1500);
            <\/script>
        </body>
        </html>
    `;
    
    try {
        const blob = new Blob([fullDoc], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, '_blank');
        if (!win) {
            alert('Please allow popups to download the PDF.');
        }
        setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) {
        const win = window.open('', '_blank');
        if (win) {
            win.document.write(fullDoc);
            win.document.close();
        } else {
            alert('Please allow popups to download the PDF.');
        }
    }
};

window.mcRenderSubEventsTab = async function() {
    const panel = document.getElementById('mc-tab-content');
    if (!panel) return;

    panel.innerHTML = `
        <div style="max-width:1100px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:14px;">
            <div class="mc-section-hdr" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;border-bottom:3px solid var(--text);padding-bottom:10px;margin-bottom:8px;">
                <div>
                    <span class="mc-section-title" style="font-size:clamp(1rem,5vw,1.3rem);font-weight:900;text-transform:uppercase;color:var(--text);display:block;word-break:break-word;">Subscription Events</span>
                    <div style="font-size:0.78rem;font-weight:800;color:var(--text-muted);margin-top:4px;">Manage dynamic registrations, subjects, and event-based mock exams.</div>
                </div>
                <button class="btn btn-primary" onclick="window.mcOpenCreateSubEventModal()" style="font-weight:900;border:3px solid var(--text);padding:8px 16px;display:flex;align-items:center;gap:6px;font-size:0.8rem;">
                    <span class="material-icons-round" style="font-size:1.1rem;vertical-align:middle;">add_circle</span> CREATE EVENT
                </button>
            </div>

            <div>
                <h2 style="font-weight:900;font-size:1rem;text-transform:uppercase;color:var(--text);margin:0 0 10px 0;">Active Subscription Events</h2>
                <div id="mc-subevents-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
                    <div style="grid-column:1/-1;text-align:center;padding:56px;color:var(--text-muted);">
                        <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;margin-bottom:8px;">autorenew</span>
                        <div style="font-size:0.8rem;font-weight:700;">Loading events...</div>
                    </div>
                </div>
            </div>
        </div>
    `;
    window.mcLoadSubEvents();
};

window.mcLoadSubEvents = async function() {
    const grid = document.getElementById('mc-subevents-list');
    if (!grid) return;

    try {
        await _throttledRefresh('subscription_events');
        const events = (await sync.collection('subscription_events')) || [];
        events.sort((a,b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));

        if (events.length === 0) {
            grid.innerHTML = `
            <div style="grid-column:1/-1;text-align:center;padding:48px 24px;border:3px dashed var(--border);border-radius:12px;color:var(--text-muted);">
                <span class="material-icons-round" style="font-size:3rem;margin-bottom:12px;opacity:0.35;">event_available</span>
                <div style="font-weight:800;font-size:1.1rem;color:var(--text);margin-bottom:6px;">No Events Created</div>
                <button class="btn btn-primary" onclick="window.mcOpenCreateSubEventModal()" style="font-size:0.75rem;padding:8px 16px;">Create Event</button>
            </div>`;
            return;
        }

        grid.innerHTML = events.map(ev => {
            const dateStr = ev.createdAt?.toDate ? ev.createdAt.toDate().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : 'Recently';
            const subsList = Array.isArray(ev.availableSubjects) ? ev.availableSubjects.map(s => mcDisplaySubject(s)).join(', ') : '';
            return `
            <div class="card" style="padding:20px;border:3px solid var(--text);display:flex;flex-direction:column;justify-content:space-between;gap:14px;background:var(--bg-card);transition:transform 0.2s;">
                <div>
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
                        <span style="font-size:0.65rem;font-weight:900;text-transform:uppercase;color:#7c3aed;background:rgba(124,58,237,0.06);padding:3px 8px;border:1.5px solid #7c3aed;border-radius:6px;letter-spacing:0.05em;">${ev.resultsReleased ? 'Results Broadcasted' : 'Active'}</span>
                        <span style="font-size:0.68rem;color:var(--text-muted);font-weight:600;">${dateStr}</span>
                    </div>
                    <h3 style="font-weight:900;font-size:1.05rem;color:var(--text);line-height:1.3;margin:0 0 10px 0;word-break:break-word;">${ev.title}</h3>
                    <p style="font-size:0.75rem;color:var(--text-muted);margin:0 0 8px 0;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">${ev.description}</p>
                    <div style="font-size:0.7rem;color:var(--text-muted);font-weight:600;margin-bottom:4px;display:flex;flex-wrap:wrap;gap:4px;">
                        <strong>Subjects:</strong> ${subsList}
                    </div>
                </div>
                
                <div style="display:flex;gap:8px;margin-top:auto;">
                    <button class="btn btn-outline" onclick="window.mcViewSubEventDetails('${ev.id}')" style="flex:1;font-size:0.7rem;padding:6px;border:2px solid var(--text);font-weight:800;">
                        MANAGE EVENT
                    </button>
                    <button class="btn btn-primary" onclick="window.mcBroadcastEventMocks('${ev.id}','${ev.title.replace(/'/g, "\\'")}')" style="font-size:0.7rem;padding:6px;border:2px solid var(--text);font-weight:800;background:#10b981;display:flex;align-items:center;gap:4px;">
                        <span class="material-icons-round" style="font-size:0.85rem;">campaign</span>
                    </button>
                    <button class="btn btn-danger" onclick="window.mcDeleteSubEvent('${ev.id}', '${ev.title.replace(/'/g, "\\'")}')" style="font-size:0.7rem;padding:6px;border:2px solid var(--text);display:flex;align-items:center;justify-content:center;aspect-ratio:1;">
                        <span class="material-icons-round" style="font-size:0.95rem;">delete</span>
                    </button>
                </div>
            </div>
            `;
        }).join('');

    } catch (e) {
        console.error(e);
        grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:24px;color:var(--brand);font-size:0.8rem;">Could not load events: ${e.message}</div>`;
    }
};

window.mcOpenCreateSubEventModal = function() {
    const modal = document.createElement('div');
    modal.id = 'ef-subevent-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:3000;animation:fadeIn 0.2s ease;';
    modal.innerHTML = `
        <div style="flex:1; display:flex; flex-direction:column; overflow:hidden;">
            <div style="display:flex; align-items:center; gap:14px; padding:12px 16px; border-bottom:2px solid var(--border); background:var(--bg-card); flex-shrink:0;">
                <button onclick="document.getElementById('ef-subevent-modal').remove()"
                    style="width:36px;height:36px;border-radius:8px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round">arrow_back</span>
                </button>
                <div style="width:36px;height:36px;border-radius:8px;background:var(--brand-dim);border:2px solid var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span class="material-icons-round" style="color:var(--brand);font-size:1rem;">event_available</span>
                </div>
                <div style="font-weight:800; font-size:1rem; color:var(--text); text-transform:uppercase; flex:1;">Create Event</div>
                <button onclick="document.getElementById('ef-subevent-modal').remove()"
                    style="width:36px;height:36px;border-radius:8px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            
            <div style="flex:1; overflow-y:auto; padding:16px; background:var(--bg); display:flex; flex-direction:column; gap:12px;">
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Event Title</label>
                    <input type="text" id="se-title" placeholder="e.g. JAMB Bi-Weekly Mock 1" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box;">
                </div>
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Description</label>
                    <textarea id="se-desc" rows="3" placeholder="Brief description for the students..." style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:700; font-size:0.8rem; width:100%; box-sizing:border-box; resize:none;"></textarea>
                </div>
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Available Subjects (comma separated)</label>
                    <input type="text" id="se-subjects" placeholder="Math (3), English (2), Physics (4), Chemistry (3), Biology (3)" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box;">
                </div>
                <div class="mc-field" style="margin-bottom:0;">
                    <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Max Subjects Allowed</label>
                    <input type="number" id="se-max" value="4" min="1" max="10" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box;">
                </div>
            </div>
            
            <div style="display:flex; align-items:center; justify-content:flex-end; gap:10px; padding:12px 16px; border-top:2px solid var(--border); background:var(--bg-card); flex-shrink:0;">
                <button class="btn btn-ghost" onclick="document.getElementById('ef-subevent-modal').remove()" style="border:2px solid var(--border); font-weight:800; padding:8px 16px;">CANCEL</button>
                <button class="btn btn-primary" onclick="window.mcSaveSubEvent()" style="font-weight:800; border:2px solid var(--text); padding:8px 20px;">SAVE EVENT</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
};

window.mcSaveSubEvent = async function() {
    const title = document.getElementById('se-title').value.trim();
    const desc = document.getElementById('se-desc').value.trim();
    const subjectsStr = document.getElementById('se-subjects').value.trim();
    const maxSubs = parseInt(document.getElementById('se-max').value, 10);

    if (!title || !subjectsStr || isNaN(maxSubs)) {
        window.showEFModal("Validation Error", "Please fill all fields correctly.", "OK", null, true);
        return;
    }

    const rawSubjects = subjectsStr.split(',').map(s => s.trim()).filter(Boolean);
    if (rawSubjects.length === 0) {
        window.showEFModal("Validation Error", "Please provide at least one subject.", "OK", null, true);
        return;
    }
    const availableSubjects = rawSubjects.map(s => {
        const n = mcNormalizeSubject(s);
        return { name: n.name, creditUnit: n.creditUnit };
    });

    try {
        const { collection, addDoc, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        await addDoc(collection(db, 'subscription_events'), {
            title,
            description: desc,
            availableSubjects,
            maxSubjects: maxSubs,
            resultsReleased: false,
            durationDays: 30, // default 30 days for mocks to be valid
            createdAt: serverTimestamp()
        });
        await sync.refresh('subscription_events');
        document.getElementById('ef-subevent-modal')?.remove();
        window.showEFModal("Event Created", "Subscription event created successfully.", "OK", null, true);
        window.mcLoadSubEvents();
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcDeleteSubEvent = function(eventId, title) {
    window.showEFModal(
        "Delete Event?",
        `Are you sure you want to delete "${title}"? This will not delete sub-collections immediately but hides the event.`,
        "DELETE",
        async () => {
            try {
                const { doc, deleteDoc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                await deleteDoc(doc(db, 'subscription_events', eventId));
                await sync.refresh('subscription_events');
                window.mcLoadSubEvents();
            } catch (e) {
                console.error(e);
                window.showEFModal("Delete Failed", e.message, "OK", null, true);
            }
        }
    );
};

window.mcGenerateSubEventKeys = async function(eventId) {
    const count = prompt('How many keys would you like to generate?', '10');
    if (!count) return;
    const numKeys = parseInt(count, 10);
    if (isNaN(numKeys) || numKeys < 1 || numKeys > 1000) {
        return window.showEFModal("Invalid Input", "Please enter a number between 1 and 1000.", "OK", null, true);
    }
    
    if (!window.confirm(`Generate ${numKeys} unique 10-digit key(s) for this event?`)) return;
    
    try {
        const { collection, doc, setDoc, writeBatch, serverTimestamp } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        
        // Check existing keys count to estimate if we need many more
        const existingSnapshot = await sync.collection('subscription_events/' + eventId + '/keys');
        const existingCount = existingSnapshot.length;
        
        // Generate unique keys
        const keysRef = collection(db, 'subscription_events', eventId, 'keys');
        const batch = writeBatch(db);
        let generated = 0;
        let attempts = 0;
        const maxAttempts = numKeys * 10; // Avoid infinite loops
        
        // Collect existing keys for uniqueness check
        const existingKeys = new Set(existingSnapshot.map(d => d.id));
        
        while (generated < numKeys && attempts < maxAttempts) {
            attempts++;
            // Generate random 10-digit string, padded with leading zeros
            const key = String(Math.floor(Math.random() * 10000000000)).padStart(10, '0');
            
            if (!existingKeys.has(key)) {
                existingKeys.add(key);
                const keyRef = doc(keysRef, key);
                batch.set(keyRef, {
                    key: key,
                    used: false,
                    usedBy: null,
                    usedAt: null,
                    createdAt: serverTimestamp()
                });
                generated++;
            }
        }
        
        await batch.commit();
        await sync.refresh('subscription_events/' + eventId + '/keys');
        
        window.showEFModal("Keys Generated", `Successfully generated ${generated} key(s) for this event.`, "AWESOME", null, true);
        
        // Refresh the event details view
        const overlay = document.getElementById('ef-se-details-overlay');
        if (overlay) {
            overlay.remove();
            window.mcViewSubEventDetails(eventId);
        }
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcCopyKeysToClipboard = async function(eventId) {
    try {
        const keys = await sync.collection('subscription_events/' + eventId + '/keys');
        const keyList = keys.map(k => k.id).join('\n');
        await navigator.clipboard.writeText(keyList);
        window.showEFModal("Copied", `${keys.length} key(s) copied to clipboard.`, "OK", null, true);
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", "Failed to copy keys: " + e.message, "OK", null, true);
    }
};

window.mcExportKeysCSV = async function(eventId) {
    try {
        const keys = await sync.collection('subscription_events/' + eventId + '/keys');
        const rows = [['Key', 'Status', 'Used By', 'Used At']];
        keys.forEach(k => {
            const status = k.used ? 'Used' : 'Available';
            const usedBy = k.usedBy || '';
            const usedAt = k.usedAt?.toDate ? k.usedAt.toDate().toISOString() : '';
            rows.push([k.id, status, usedBy, usedAt]);
        });
        const csv = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `subscription-keys-${eventId}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", "Failed to export keys: " + e.message, "OK", null, true);
    }
};


window.mcBroadcastEventMocks = function(eventId, title) {
    window.showEFModal(
        "Broadcast Mocks",
        `Release all subject mock exams for "${title}" to registered students?`,
        "BROADCAST ALL",
        async () => {
            try {
                // 1. Find all mocks for this event
                const mocks = (await sync.query('mock_exams', [where('eventId', '==', eventId)])) || [];
                
                if (mocks.length === 0) {
                    return window.showEFModal("No Mocks", "No mock exams found for this event. Create them first via MANAGE EVENT.", "OK", null, true);
                }
                
                // 2. Find all registrations for this event
                const regDocs = await sync.collection('subscription_events/' + eventId + '/registrations');
                const regData = {};
                regDocs.forEach(r => {
                    regData[r.id] = r.subjects || [];
                });
                
                const ev = await sync.doc('subscription_events/' + eventId);
                const evTitle = ev ? ev.title : title;
                
                let totalNotifs = 0;
                const subjectsBroadcasted = new Set();
                
                // 3. For each mock, notify + schedule the relevant students
                for (const mock of mocks) {
                    const subject = mock.subject;
                    subjectsBroadcasted.add(subject);
                    
                    const uids = Object.entries(regData)
                        .filter(([uid, subs]) => subs.includes(subject))
                        .map(([uid]) => uid);
                    
                    if (uids.length === 0) continue;
                    
                    for (const uid of uids) {
                        // Notification
                        const notifRef = doc(collection(db, 'users', uid, 'notifications'));
                        await setDoc(notifRef, {
                            id: notifRef.id,
                            type: 'broadcast',
                            title: 'Mock Exam Ready!',
                            message: `Your ${subject} mock exam for "${evTitle}" is now available. Tap to take it.`,
                            actionLabel: 'TAKE EXAM',
                            actionPath: `/quiz.html?mockid=${mock.id}`,
                            createdAt: serverTimestamp(),
                            read: false,
                            brandColor: '#10b981',
                            brandIcon: 'library_books'
                        });
                        
                        // Schedule item
                        const schedRef = doc(collection(db, 'users', uid, 'schedule'));
                        const now = new Date();
                        const durDays = ev.durationDays || 30;
                        const expDate = new Date(now);
                        expDate.setDate(expDate.getDate() + durDays);
                        const expYear = expDate.getFullYear();
                        const expMonth = String(expDate.getMonth() + 1).padStart(2, '0');
                        const expDay = String(expDate.getDate()).padStart(2, '0');
                        await setDoc(schedRef, {
                            id: schedRef.id,
                            type: 'mock_exam',
                            title: `${subject} Mock - ${evTitle}`,
                            course: subject,
                            mockId: mock.id,
                            eventId: eventId,
                            timeLimit: mock.timeLimit || 45,
                            quizUrl: `/quiz.html?mockid=${mock.id}`,
                            message: `Complete your ${subject} mock exam for "${evTitle}".`,
                            date: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
                            time: 'All day',
                            dueDate: `${expYear}-${expMonth}-${expDay}`,
                            dueTime: '23:59',
                            dueTimestamp: new Date(`${expYear}-${expMonth}-${expDay}T23:59:00`),
                            timestamp: serverTimestamp(),
                            read: false
                        });
                        
                        totalNotifs++;
                    }
                }
                
                window.showEFModal(
                    "Broadcast Complete",
                    `Mocks broadcasted for ${subjectsBroadcasted.size} subject(s). ${totalNotifs} notification(s) and schedule items sent.`,
                    "OK",
                    null,
                    true
                );
                
            } catch (e) {
                console.error(e);
                window.showEFModal("Error", e.message, "OK", null, true);
            }
        }
    );
};

window.mcViewSubEventDetails = async function(eventId) {
    // Basic Details overlay
    const overlay = document.createElement('div');
    overlay.id = 'ef-se-details-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:2000;animation:fadeIn 0.2s ease;';
    overlay.innerHTML = `
            <div style="display:flex;align-items:center;gap:14px;padding:10px 14px;border-bottom:2px solid var(--border);background:var(--bg-card);flex-shrink:0;">
            <button onclick="this.closest('#ef-se-details-overlay').remove()"
                style="width:32px;height:32px;border-radius:8px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                <span class="material-icons-round">arrow_back</span>
            </button>
            <div style="width:32px;height:32px;border-radius:6px;background:rgba(124,58,237,0.08);border:1.5px solid #7c3aed;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                <span class="material-icons-round" style="color:#7c3aed;">event_note</span>
            </div>
            <div style="flex:1;min-width:0;">
                <div id="ef-se-det-title" style="font-weight:900;font-size:0.85rem;color:var(--text);">Loading Event details...</div>
                <div id="ef-se-det-meta" style="font-size:0.7rem;color:var(--text-muted);margin-top:2px;">Event ID: <code style="font-family:var(--font-mono);font-size:0.65rem;">${eventId}</code></div>
            </div>
            <button onclick="this.closest('#ef-se-details-overlay').remove()"
                style="width:32px;height:32px;border-radius:8px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                <span class="material-icons-round">close</span>
            </button>
        </div>
        
        <div id="ef-se-det-body" style="flex:1;overflow-y:auto;padding:14px;background:var(--bg);display:flex;flex-direction:column;gap:14px;">
            <div style="text-align:center;padding:56px;color:var(--text-muted);">
                <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.8rem;">autorenew</span>
                <div style="margin-top:12px;font-size:0.8rem;">Fetching data...</div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    
    // Force refresh event doc before loading
    try {
        await sync.refresh('subscription_events/' + eventId);
    } catch(e) {}
    
    try {
        const ev = await sync.doc('subscription_events/' + eventId);
        if (!ev) throw new Error("Event not found");
        
        document.getElementById('ef-se-det-title').textContent = ev.title;
        
        // Fetch Registrations
        const regData = await sync.collection('subscription_events/' + eventId + '/registrations');
        const totalRegistrations = regData.length;
        
        // Subject breakdown
        const normalizedSubjects = (ev.availableSubjects || []).map(s => mcNormalizeSubject(s));
        const subjectCounts = {};
        normalizedSubjects.forEach(s => subjectCounts[s.name] = 0);
        regData.forEach(r => {
            if (r.subjects) r.subjects.forEach(s => {
                const sn = typeof s === 'string' ? s : (s.name || s);
                if (subjectCounts[sn] !== undefined) subjectCounts[sn]++;
            });
        });
        
        // Render UI
        let subjectHTML = normalizedSubjects.map(s => {
            const safeName = s.name.replace(/'/g, "\\'");
            return `
            <div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px;background:var(--bg-inset);border:2px solid var(--text);border-radius:8px;margin-bottom:8px;">
                <div>
                    <div style="font-weight:800;font-size:0.85rem;display:flex;align-items:center;gap:8px;">
                        ${s.name}
                        <button onclick="window.mcEditSubjectCU('${eventId}', '${safeName}', ${s.creditUnit})" 
                            style="background:transparent;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:2px 6px;font-size:0.6rem;color:var(--text-muted);display:flex;align-items:center;gap:3px;"
                            title="Edit credit unit">
                            <span class="material-icons-round" style="font-size:0.8rem;">edit</span>
                        </button>
                    </div>
                    <div style="font-size:0.65rem;color:var(--text-muted);font-weight:600;">
                        <span id="cu-display-${safeName.replace(/\s+/g,'-')}">${s.creditUnit}</span> Credit Unit${s.creditUnit !== 1 ? 's' : ''}
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:10px;margin-left:auto;flex-wrap:wrap;">
                    <div style="font-size:0.8rem;color:var(--text-muted);white-space:nowrap;"><strong>${subjectCounts[s.name]}</strong> students</div>
                    <button class="btn btn-outline btn-sm" onclick="window.mcOpenCreateEventMockModal('${eventId}', '${safeName}')" style="padding:6px 12px;font-size:0.7rem;font-weight:800;background:var(--bg-card);border:2px solid var(--text);white-space:nowrap;">CREATE/EDIT MOCK</button>
                </div>
            </div>`;
        }).join('');

        const broadcastBtn = `
            <div style="display:flex;gap:8px;width:100%;flex-wrap:wrap;">
                <button class="btn btn-primary" onclick="window.mcBroadcastEventResults('${eventId}')" style="flex:1;font-weight:900;border:3px solid var(--text);padding:8px 10px;text-align:center;background:#7c3aed;font-size:0.7rem;white-space:normal;word-break:break-word;">
                    <span class="material-icons-round" style="font-size:0.85rem;vertical-align:middle;">campaign</span> ${ev.resultsReleased ? 'RE-BROADCAST' : 'BROADCAST ALL'}
                </button>
                <button class="btn btn-outline" onclick="window.mcPrintAllEventResults('${eventId}')" style="flex:1;font-weight:900;border:3px solid var(--text);padding:8px 10px;text-align:center;font-size:0.7rem;white-space:normal;word-break:break-word;display:flex;align-items:center;justify-content:center;gap:4px;">
                    <span class="material-icons-round" style="font-size:0.85rem;">print</span> PRINT ALL
                </button>
                ${ev.resultsReleased ? `<span style="font-size:0.6rem;color:var(--text-muted);font-weight:700;width:100%;text-align:center;margin-top:2px;"><span class="material-icons-round" style="font-size:0.75rem;vertical-align:middle;">info</span> Already broadcasted</span>` : ''}
            </div>`;

        document.getElementById('ef-se-det-body').innerHTML = `
            <div style="display:grid;grid-template-columns:1fr;gap:16px;">
                <div style="background:var(--bg-card);border:3px solid var(--text);border-radius:12px;padding:16px;text-align:center;">
                    <div style="font-size:2rem;font-weight:900;color:var(--text);">${totalRegistrations}</div>
                    <div style="font-size:0.65rem;font-weight:800;color:var(--text-muted);text-transform:uppercase;margin-top:4px;">Total Registered Students</div>
                </div>
            </div>
            
            <div>
                <h3 style="font-weight:900;font-size:1.05rem;text-transform:uppercase;color:var(--text);margin-bottom:12px;">Subjects & Exams</h3>
                ${subjectHTML}
            </div>

            <!-- Registration Keys -->
            <div>
                <h3 style="font-weight:900;font-size:1.05rem;text-transform:uppercase;color:var(--text);margin-bottom:12px;margin-top:24px;border-top:3px solid var(--text);padding-top:20px;">
                    Registration Keys
                    <span id="keys-status-badge" style="font-size:0.65rem;font-weight:700;color:var(--text-muted);margin-left:8px;"></span>
                </h3>
                <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;">
                    <button class="btn btn-primary btn-sm" onclick="window.mcGenerateSubEventKeys('${eventId}')" style="font-size:0.7rem;font-weight:800;padding:6px 14px;background:#7c3aed;border:2px solid var(--text);display:flex;align-items:center;gap:4px;">
                        <span class="material-icons-round" style="font-size:0.85rem;">vpn_key</span> GENERATE KEYS
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="window.mcCopyKeysToClipboard('${eventId}')" style="font-size:0.7rem;font-weight:800;padding:6px 14px;border:2px solid var(--text);">
                        COPY ALL
                    </button>
                    <button class="btn btn-outline btn-sm" onclick="window.mcExportKeysCSV('${eventId}')" style="font-size:0.7rem;font-weight:800;padding:6px 14px;border:2px solid var(--text);">
                        EXPORT CSV
                    </button>
                </div>
                <div id="mc-keys-list" style="display:flex;flex-direction:column;gap:4px;">
                    <div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.8rem;">
                        <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.2rem;vertical-align:middle;margin-right:6px;">autorenew</span>
                        Loading keys...
                    </div>
                </div>
            </div>

            <!-- Mock Duration Setting -->
            <div>
                <h3 style="font-weight:900;font-size:1.05rem;text-transform:uppercase;color:var(--text);margin-bottom:12px;margin-top:24px;border-top:3px solid var(--text);padding-top:20px;">
                    Mock Duration
                    <span style="font-size:0.7rem;color:var(--text-muted);font-weight:700;"></span>
                </h3>
                <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center;">
                    <label style="font-weight:700;font-size:0.75rem;color:var(--text-muted);">Mocks are valid for</label>
                    <select id="ev-duration-select" style="border:2px solid var(--text);border-radius:8px;padding:8px 12px;font-size:0.78rem;font-weight:700;background:var(--bg-card);color:var(--text);">
                        <option value="7">1 Week</option>
                        <option value="14">2 Weeks</option>
                        <option value="30" selected>1 Month</option>
                        <option value="60">2 Months</option>
                        <option value="90">3 Months</option>
                        <option value="180">6 Months</option>
                        <option value="365">1 Year</option>
                    </select>
                    <button class="btn btn-primary btn-sm" onclick="window.mcSaveEventDuration('${eventId}')" style="font-size:0.7rem;font-weight:800;padding:6px 14px;background:#7c3aed;border:2px solid var(--text);">SAVE DURATION</button>
                </div>
            </div>

            <div>
                <h3 style="font-weight:900;font-size:1.05rem;text-transform:uppercase;color:var(--text);margin-bottom:12px;margin-top:24px;border-top:3px solid var(--text);padding-top:20px;">
                    Registered Students
                    <span style="font-size:0.7rem;color:var(--text-muted);font-weight:700;">(${totalRegistrations} total)</span>
                </h3>
                <div id="mc-reg-students-table" style="overflow-x:auto;border:2px solid var(--text);border-radius:10px;">
                    <div style="text-align:center;padding:32px;color:var(--text-muted);font-size:0.8rem;">
                        <span class="material-icons-round" style="animation:spin 1s linear infinite;display:inline-block;font-size:1.2rem;vertical-align:middle;margin-right:6px;">autorenew</span>
                        Loading student data...
                    </div>
                </div>
            </div>

            <div style="margin-top:24px;">
                ${broadcastBtn}
            </div>
        `;
        
        // Fetch and render student details table
        window.mcRenderRegStudentsTable(eventId, ev.availableSubjects || [], normalizedSubjects);
        window.mcRenderEventKeysTable(eventId);
        
        // Pre-select event duration
        const durationSelect = document.getElementById('ev-duration-select');
        if (durationSelect && ev.durationDays) {
            durationSelect.value = String(ev.durationDays);
        }
        
    } catch (e) {
        console.error(e);
        document.getElementById('ef-se-det-body').innerHTML = `<div style="text-align:center;padding:32px;color:var(--brand);font-weight:900;">Error: ${e.message}</div>`;
    }
};

window.mcSaveEventDuration = async function(eventId) {
    const durationDays = parseInt(document.getElementById('ev-duration-select')?.value) || 30;
    try {
        const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        await updateDoc(doc(db, 'subscription_events', eventId), { durationDays });
        window.showEFModal("Duration Saved", `Mock exams will be valid for ${durationDays} day(s).`, "OK", null, true);
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcRenderEventKeysTable = async function(eventId) {
    const container = document.getElementById('mc-keys-list');
    const badge = document.getElementById('keys-status-badge');
    if (!container) return;
    
    try {
        const keys = await sync.collection('subscription_events/' + eventId + '/keys');
        const total = keys.length;
        const used = keys.filter(k => k.used).length;
        const available = total - used;
        
        if (badge) {
            badge.textContent = `${available} available / ${used} used / ${total} total`;
        }
        
        if (total === 0) {
            container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:0.8rem;border:2px dashed var(--border);border-radius:8px;">
                <div style="font-weight:700;margin-bottom:4px;">No keys generated yet</div>
                <div style="font-size:0.7rem;">Click "Generate Keys" to create 10-digit registration keys.</div>
            </div>`;
            return;
        }
        
        // Sort: available first, then used
        const sorted = [...keys].sort((a, b) => {
            if (a.used && !b.used) return 1;
            if (!a.used && b.used) return -1;
            return 0;
        });
        
        container.innerHTML = `
            <div style="display:grid;grid-template-columns:1fr;gap:4px;max-height:400px;overflow-y:auto;border:2px solid var(--text);border-radius:8px;">
                <div style="display:grid;grid-template-columns:2fr 1fr 1.5fr 1.5fr;gap:0;background:var(--bg-inset);padding:8px 12px;font-size:0.6rem;font-weight:900;text-transform:uppercase;color:var(--text-muted);border-bottom:2px solid var(--text);position:sticky;top:0;background:var(--bg-card);">
                    <span>Key</span>
                    <span style="text-align:center;">Status</span>
                    <span style="text-align:center;">Used By</span>
                    <span style="text-align:center;">Used At</span>
                </div>
                ${sorted.map(k => {
                    const statusColor = k.used ? '#dc2626' : '#16a34a';
                    const statusText = k.used ? 'USED' : 'AVAILABLE';
                    const usedBy = k.usedBy ? k.usedBy.substring(0, 8) + '...' : '\u2014';
                    const usedAt = k.usedAt?.toDate ? k.usedAt.toDate().toLocaleDateString('en-US', { month: 'short', day: '2-digit' }) : '\u2014';
                    return `
                        <div style="display:grid;grid-template-columns:2fr 1fr 1.5fr 1.5fr;gap:0;padding:6px 12px;font-size:0.7rem;font-weight:600;border-bottom:1px solid var(--border);align-items:center;font-family:var(--font-mono);">
                            <span style="font-weight:800;color:var(--text);letter-spacing:0.1em;">${k.id}</span>
                            <span style="text-align:center;color:${statusColor};font-weight:800;font-size:0.6rem;">${statusText}</span>
                            <span style="text-align:center;color:var(--text-muted);font-size:0.65rem;overflow:hidden;text-overflow:ellipsis;">${usedBy}</span>
                            <span style="text-align:center;color:var(--text-muted);font-size:0.65rem;">${usedAt}</span>
                        </div>
                    `;
                }).join('')}
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px 12px;background:var(--bg-inset);border:2px solid var(--text);border-top:0;border-radius:0 0 8px 8px;font-size:0.6rem;font-weight:700;color:var(--text-muted);">
                <span><span style="color:#16a34a;">\u25cf</span> ${available} available</span>
                <span><span style="color:#dc2626;">\u25cf</span> ${used} used</span>
                <span>${total} total</span>
            </div>
        `;
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div style="text-align:center;padding:16px;color:var(--brand);font-size:0.8rem;">Error loading keys: ${e.message}</div>`;
    }
};

window.mcRenderRegStudentsTable = async function(eventId, subjects, normalizedSubjects) {
    if (!normalizedSubjects) normalizedSubjects = (subjects || []).map(s => mcNormalizeSubject(s));
    const container = document.getElementById('mc-reg-students-table');
    if (!container) return;
    
    try {
        // 1. Fetch all registrations
        const registrationDocs = await sync.collection('subscription_events/' + eventId + '/registrations');
        const registrations = registrationDocs.map(r => ({ uid: r.id, ...r }));
        
        if (registrations.length === 0) {
            container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted);font-size:0.8rem;">No students registered yet.</div>';
            return;
        }
        
        // 2. Fetch user profiles and mock attempts in parallel
        const studentData = await Promise.all(registrations.map(async (reg) => {
            let user = { displayName: 'Unknown', email: '', username: '' };
            try {
                const uData = await sync.doc('users/' + reg.uid);
                if (uData) user = uData;
            } catch(e) {}
            
            // Check mock attempts for each subject
            const subjectScores = {};
            for (const sub of (reg.subjects || [])) {
                const mockResults = (await sync.query('mock_exams', [where('eventId', '==', eventId), where('subject', '==', sub)])) || [];
                
                if (mockResults.length > 0) {
                    const mockId = mockResults[0].id;
                    const attempt = await sync.doc('mock_exams/' + mockId + '/attempts/' + reg.uid);
                    if (attempt) {
                        subjectScores[sub] = {
                            correct: attempt.correct || 0,
                            total: attempt.totalQuestions || 0,
                            percentage: attempt.score || 0
                        };
                    } else {
                        subjectScores[sub] = null;
                    }
                } else {
                    subjectScores[sub] = null;
                }
            }
            
            return { uid: reg.uid, user, subjects: reg.subjects || [], scores: subjectScores };
        }));
        
        // Sort by average score (highest first)
        studentData.sort((a, b) => {
            const aScores = Object.values(a.scores).filter(s => s !== null);
            const bScores = Object.values(b.scores).filter(s => s !== null);
            const aAvg = aScores.length > 0 ? aScores.reduce((sum, s) => sum + s.percentage, 0) / aScores.length : -1;
            const bAvg = bScores.length > 0 ? bScores.reduce((sum, s) => sum + s.percentage, 0) / bScores.length : -1;
            return bAvg - aAvg; // descending
        });
        
        // 3. Render table
        const name = u => u.displayName || u.email?.split('@')[0] || 'Unknown';
        const initials = u => {
            const n = name(u);
            const p = n.trim().split(' ');
            return p.length > 1 ? (p[0][0]+p[p.length-1][0]).toUpperCase() : n.substring(0,2).toUpperCase();
        };
        
        const subjectCols = (subjects || []).map(s => typeof s === 'string' ? s : (s.name || String(s)));
        
        container.innerHTML = `
            <style>
                .reg-table { width:100%; border-collapse:collapse; min-width:700px; font-size:0.75rem; }
                .reg-table th { background:var(--bg-inset); font-size:0.6rem; font-weight:900; text-transform:uppercase; letter-spacing:0.05em; color:var(--text-muted); padding:10px 12px; border:1px solid var(--border); text-align:left; white-space:nowrap; }
                .reg-table td { padding:8px 12px; border:1px solid var(--border); color:var(--text-sub); font-weight:500; }
                .reg-table tr:hover td { background:var(--bg-inset); }
                .reg-table td:first-child { font-weight:700; color:var(--text); }
                .score-taken { color:#16a34a; font-weight:800; }
                .score-empty { color:var(--text-muted); font-weight:400; }
                .reg-table th.score-col { text-align:center; background:#16a34a10; }
                .reg-table th.pct-col { text-align:center; background:#16a34a05; }
                @media(max-width:600px){
                    .reg-table { font-size:0.65rem; min-width:0; }
                    .reg-table th, .reg-table td { padding:5px 6px; }
                }
            </style>
            <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;">
                <button onclick="window.mcExportRegTableCSV('${eventId}')" style="font-size:0.65rem;font-weight:800;padding:6px 12px;border:2px solid var(--text);border-radius:6px;background:var(--bg-card);cursor:pointer;display:flex;align-items:center;gap:4px;">
                    <span class="material-icons-round" style="font-size:0.85rem;">file_download</span> EXPORT CSV
                </button>
                <button onclick="window.mcExportRegTablePDF('${eventId}')" style="font-size:0.65rem;font-weight:800;padding:6px 12px;border:2px solid var(--text);border-radius:6px;background:var(--bg-card);cursor:pointer;display:flex;align-items:center;gap:4px;">
                    <span class="material-icons-round" style="font-size:0.85rem;">picture_as_pdf</span> EXPORT PDF
                </button>
            </div>
            <table class="reg-table">
                <thead>
                    <tr>
                        <th style="width:32px;text-align:center;">#</th>
                        <th>Student</th>
                        <th>Username</th>
                        <th>Email</th>
                        <th>Subjects</th>
                        ${subjectCols.map(s => {
                            const ns = normalizedSubjects.find(n => n.name === s);
                            const cu = ns ? ns.creditUnit : 1;
                            return `
                            <th class="score-col" style="text-align:center;border-left:2px solid var(--text);">${s}<br><span style="font-weight:600;font-size:0.5rem;">${cu} CU</span></th>
                            <th class="pct-col" style="text-align:center;min-width:50px;">${s}<br><span style="font-weight:600;font-size:0.5rem;">%</span></th>
                            <th class="pct-col" style="text-align:center;min-width:40px;">${s}<br><span style="font-weight:600;font-size:0.5rem;">Grade</span></th>`;
                        }).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${studentData.map((sd, idx) => `
                        <tr>
                            <td style="text-align:center;font-weight:700;color:var(--text-muted);font-size:0.65rem;">${idx + 1}</td>
                            <td>
                                <div style="display:flex;align-items:center;gap:8px;">
                                    <div style="width:28px;height:28px;border-radius:6px;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:0.6rem;border:1.5px solid var(--text);flex-shrink:0;">${initials(sd.user)}</div>
                                    ${name(sd.user)}
                                </div>
                            </td>
                            <td style="color:var(--text-muted);font-family:var(--font-mono);font-size:0.65rem;">${sd.user.username || '—'}</td>
                            <td style="color:var(--text-muted);font-size:0.65rem;">${sd.user.email || '—'}</td>
                            <td style="font-weight:600;font-size:0.68rem;">${sd.subjects.join(', ')}</td>
                            ${subjectCols.map(s => {
                                const sc = sd.scores[s];
                                if (sc) {
                                    const g = mcGradeFromScore(sc.percentage);
                                    return `
                                        <td style="text-align:center;font-weight:800;color:#16a34a;border-left:2px solid var(--text);">${sc.correct}/${sc.total}</td>
                                        <td style="text-align:center;font-weight:800;color:#16a34a;">${sc.percentage}%</td>
                                        <td style="text-align:center;font-weight:800;color:${g.grade === 'F' ? '#dc2626' : '#16a34a'};">${g.grade}</td>
                                    `;
                                } else {
                                    return `
                                        <td style="text-align:center;color:var(--text-muted);border-left:2px solid var(--text);">—</td>
                                        <td style="text-align:center;color:var(--text-muted);">—</td>
                                        <td style="text-align:center;color:var(--text-muted);">—</td>
                                    `;
                                }
                            }).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            <div style="padding:8px 12px;background:var(--bg-inset);border-top:2px solid var(--text);font-size:0.6rem;color:var(--text-muted);font-weight:700;display:flex;justify-content:space-between;align-items:center;">
                <span>${studentData.length} student${studentData.length !== 1 ? 's' : ''}</span>
                <span style="display:flex;align-items:center;gap:12px;">
                    <span><span style="display:inline-block;width:10px;height:10px;background:#16a34a;border-radius:2px;vertical-align:middle;margin-right:4px;"></span> Score taken</span>
                    <span><span style="display:inline-block;width:10px;height:10px;background:var(--border);border-radius:2px;vertical-align:middle;margin-right:4px;"></span> Not taken</span>
                </span>
            </div>
        `;
        
    } catch (e) {
        console.error(e);
        container.innerHTML = `<div style="text-align:center;padding:24px;color:var(--brand);font-size:0.8rem;">Error loading students: ${e.message}</div>`;
    }
};

window.mcExportRegTableCSV = async function(eventId) {
    try {
        const registrationDocs = await sync.collection('subscription_events/' + eventId + '/registrations');
        const registrations = registrationDocs.map(r => ({ uid: r.id, ...r }));
        if (registrations.length === 0) return window.showEFModal("No Data", "No registered students.", "OK", null, true);
        
        const ev = await sync.doc('subscription_events/' + eventId);
        const subjects = (ev.availableSubjects || []).map(s => typeof s === 'string' ? s : (s.name || String(s)));
        
        // Build header row
        const header = ['#', 'Student', 'Username', 'Email', 'Subjects'];
        subjects.forEach(s => {
            header.push(s + ' Score', s + ' %', s + ' Grade');
        });
        
        // Build data rows - reuse the same logic as the table
        let rows = [];
        for (const reg of registrations) {
            let user = { displayName: 'Unknown', email: '', username: '' };
            try { const u = await sync.doc('users/' + reg.uid); if (u) user = u; } catch(e) {}
            
            const subjectScores = {};
            for (const sub of (reg.subjects || [])) {
                const mockResults = (await sync.query('mock_exams', [where('eventId', '==', eventId), where('subject', '==', sub)])) || [];
                if (mockResults.length > 0) {
                    const attempt = await sync.doc('mock_exams/' + mockResults[0].id + '/attempts/' + reg.uid);
                    if (attempt) {
                        subjectScores[sub] = { correct: attempt.correct || 0, total: attempt.totalQuestions || 0, percentage: attempt.score || 0 };
                    }
                }
            }
            
            const name = user.displayName || user.email?.split('@')[0] || 'Unknown';
            const row = ['', name, user.username || '', user.email || '', (reg.subjects || []).join('; ')];
            
            subjects.forEach(s => {
                const sc = subjectScores[s];
                if (sc) {
                    const g = mcGradeFromScore(sc.percentage);
                    row.push(sc.correct + '/' + sc.total, '' + sc.percentage, g.grade);
                } else {
                    row.push('\u2014', '\u2014', '\u2014');
                }
            });
            
            rows.push(row);
        }
        
        // Sort by average score descending
        rows.sort((a, b) => {
            const subjectCount = subjects.length;
            let aSum = 0, aCount = 0, bSum = 0, bCount = 0;
            subjects.forEach((_, idx) => {
                const aVal = parseFloat(a[5 + idx * 3 + 1]);
                const bVal = parseFloat(b[5 + idx * 3 + 1]);
                if (!isNaN(aVal)) { aSum += aVal; aCount++; }
                if (!isNaN(bVal)) { bSum += bVal; bCount++; }
            });
            const aAvg = aCount > 0 ? aSum / aCount : -1;
            const bAvg = bCount > 0 ? bSum / bCount : -1;
            return bAvg - aAvg;
        });
        
        // Add row numbers after sorting
        rows.forEach((r, idx) => r[0] = String(idx + 1));
        
        // Generate CSV
        const csvContent = [header, ...rows].map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'registration-results-' + eventId + '.csv';
        a.click();
        URL.revokeObjectURL(url);
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcExportRegTablePDF = async function(eventId) {
    try {
        const registrationDocs = await sync.collection('subscription_events/' + eventId + '/registrations');
        const registrations = registrationDocs.map(r => ({ uid: r.id, ...r }));
        if (registrations.length === 0) return window.showEFModal("No Data", "No registered students.", "OK", null, true);
        
        const ev = await sync.doc('subscription_events/' + eventId);
        const subjects = (ev.availableSubjects || []).map(s => typeof s === 'string' ? s : (s.name || String(s)));
        const normalizedSubjects = (ev.availableSubjects || []).map(s => {
            if (typeof s === 'string') return { name: s, creditUnit: 1 };
            return { name: s.name || s, creditUnit: s.creditUnit || 1 };
        });
        
        // Build data (same logic as mcRenderRegStudentsTable)
        let allData = [];
        for (const reg of registrations) {
            let user = { displayName: 'Unknown', email: '', username: '' };
            try { const u = await sync.doc('users/' + reg.uid); if (u) user = u; } catch(e) {}
            
            const subjectScores = {};
            for (const sub of (reg.subjects || [])) {
                const mockResults = (await sync.query('mock_exams', [where('eventId', '==', eventId), where('subject', '==', sub)])) || [];
                if (mockResults.length > 0) {
                    const attempt = await sync.doc('mock_exams/' + mockResults[0].id + '/attempts/' + reg.uid);
                    if (attempt) {
                        subjectScores[sub] = { correct: attempt.correct || 0, total: attempt.totalQuestions || 0, percentage: attempt.score || 0 };
                    }
                }
            }
            allData.push({ uid: reg.uid, user, subjects: reg.subjects || [], scores: subjectScores });
        }
        
        // Sort by average score
        allData.sort((a, b) => {
            const aSc = Object.values(a.scores).filter(s => s !== null);
            const bSc = Object.values(b.scores).filter(s => s !== null);
            const aAvg = aSc.length > 0 ? aSc.reduce((s, x) => s + x.percentage, 0) / aSc.length : -1;
            const bAvg = bSc.length > 0 ? bSc.reduce((s, x) => s + x.percentage, 0) / bSc.length : -1;
            return bAvg - aAvg;
        });
        
        const name = u => u.displayName || u.email?.split('@')[0] || 'Unknown';
        
        // Build HTML table for print
        let tableRows = allData.map((d, idx) => {
            let cols = '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;">' + (idx + 1) + '</td>' +
                        '<td style="padding:6px 8px;border:1px solid #333;font-size:11px;">' + name(d.user) + '</td>' +
                        '<td style="padding:6px 8px;border:1px solid #333;font-size:11px;">' + (d.user.username || '\u2014') + '</td>' +
                        '<td style="padding:6px 8px;border:1px solid #333;font-size:11px;">' + (d.user.email || '\u2014') + '</td>' +
                        '<td style="padding:6px 8px;border:1px solid #333;font-size:11px;">' + d.subjects.join(', ') + '</td>';
            
            subjects.forEach(s => {
                const sc = d.scores[s];
                if (sc) {
                    const g = mcGradeFromScore(sc.percentage);
                    cols += '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;font-weight:700;">' + sc.correct + '/' + sc.total + '</td>' +
                             '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;font-weight:700;">' + sc.percentage + '%</td>' +
                             '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;font-weight:700;">' + g.grade + '</td>';
                } else {
                    cols += '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;color:#999;">\u2014</td>' +
                             '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;color:#999;">\u2014</td>' +
                             '<td style="text-align:center;padding:6px 8px;border:1px solid #333;font-size:11px;color:#999;">\u2014</td>';
                }
            });
            return '<tr>' + cols + '</tr>';
        }).join('');
        
        let headerCols = '<th style="text-align:center;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:11px;">#</th>' +
                          '<th style="text-align:left;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:11px;">Student</th>' +
                          '<th style="text-align:left;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:11px;">Username</th>' +
                          '<th style="text-align:left;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:11px;">Email</th>' +
                          '<th style="text-align:left;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:11px;">Subjects</th>';
        
        subjects.forEach(s => {
            const ns = normalizedSubjects.find(n => n.name === s);
            const cu = ns ? ns.creditUnit : 1;
            headerCols += '<th style="text-align:center;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:10px;">' + s + '<br>' + cu + ' CU</th>' +
                           '<th style="text-align:center;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:10px;">%</th>' +
                           '<th style="text-align:center;padding:8px;border:1px solid #333;background:#1a1a2e;color:#fff;font-size:10px;">Grade</th>';
        });
        
        const eventTitle = ev.title || 'Subscription Event Results';
        const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const printHTML = '<!DOCTYPE html>\n' +
'<html>\n' +
'<head><title>' + eventTitle + ' - Results</title>\n' +
'<style>\n' +
'    body { font-family: Arial, sans-serif; margin: 30px; color: #222; }\n' +
'    h2 { text-align: center; margin-bottom: 20px; font-size: 18px; text-transform: uppercase; }\n' +
'    table { width: 100%; border-collapse: collapse; }\n' +
'    th { background: #1a1a2e; color: #fff; font-size: 11px; padding: 8px; border: 1px solid #333; }\n' +
'    td { padding: 6px 8px; border: 1px solid #333; font-size: 11px; }\n' +
'    tr:nth-child(even) { background: #f5f5f5; }\n' +
'    .footer { text-align: center; margin-top: 20px; font-size: 10px; color: #666; }\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +
'    <h2>' + eventTitle + '</h2>\n' +
'    <table>\n' +
'        <thead><tr>' + headerCols + '</tr></thead>\n' +
'        <tbody>' + tableRows + '</tbody>\n' +
'    </table>\n' +
'    <div class="footer">Generated by ExamForge &middot; ' + dateStr + '</div>\n' +
'    <script>window.print();<\/script>\n' +
'</body>\n' +
'</html>';
        
        const printWindow = window.open('', '_blank', 'width=1200,height=800');
        printWindow.document.write(printHTML);
        printWindow.document.close();
        
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcPrintAllEventResults = async function(eventId) {
    try {
        const evData = await sync.doc('subscription_events/' + eventId) || {};
        const evTitle = evData.title || 'Mock Exam';
        
        // Normalize subjects with CUs
        const subjects = (evData.availableSubjects || []).map(s => mcNormalizeSubject(s));
        
        // Find all mocks linked to this event
        const mocks = (await sync.query('mock_exams', [where('eventId', '==', eventId)])) || [];
        
        // Group students by UID across all mocks
        const studentResults = {};
        
        for (const mock of mocks) {
            const subject = mock.subject;
            const subjNorm = subjects.find(s => s.name === subject);
            const creditUnit = subjNorm ? subjNorm.creditUnit : 1;
            
            const attempts = await sync.collection('mock_exams/' + mock.id + '/attempts');
            
            attempts.forEach(attempt => {
                const uid = attempt.uid;
                if (!studentResults[uid]) {
                    studentResults[uid] = {
                        uid,
                        displayName: attempt.displayName || 'Unknown',
                        email: attempt.email || '',
                        subjects: []
                    };
                }
                studentResults[uid].subjects.push({
                    name: subject,
                    creditUnit,
                    score: attempt.score || 0,
                    correct: attempt.correct || 0,
                    total: attempt.totalQuestions || 0,
                    grade: mcGradeFromScore(attempt.score || 0)
                });
            });
        }
        
        // Fill in unattempted subjects
        for (const [uid, data] of Object.entries(studentResults)) {
            const attemptedSubjects = new Set(data.subjects.map(s => s.name));
            for (const subj of subjects) {
                if (!attemptedSubjects.has(subj.name)) {
                    data.subjects.push({
                        name: subj.name,
                        creditUnit: subj.creditUnit,
                        score: null,
                        correct: 0,
                        total: 0,
                        grade: null
                    });
                }
            }
        }
        
        if (Object.keys(studentResults).length === 0) {
            return window.showEFModal("No Data", "No student attempts found.", "OK", null, true);
        }
        
        // Build all result sheets HTML
        const allSheets = Object.entries(studentResults).map(([uid, data], idx) => {
            let totalPoints = 0, totalCU = 0;
            data.subjects.forEach(s => {
                totalPoints += (s.grade && s.grade.points ? s.grade.points : 0) * s.creditUnit;
                totalCU += s.creditUnit;
            });
            const gpa = totalCU > 0 ? Math.round((totalPoints / totalCU) * 100) / 100 : 0;
            const gpaComment = mcGPAComment(gpa);
            const resultHTML = buildResultSheetHTML(evTitle, data, gpa, gpaComment);
            return resultHTML;
        }).join('<div style="page-break-after:always;margin:0;padding:0;height:0;"></div>');
        
        // Build complete printable document
        const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        const printHTML = `<!DOCTYPE html>
<html>
<head><title>${evTitle} - All Results</title>
<style>
    @page { margin: 15mm 10mm; size: A4 portrait; }
    body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 20px; color: #222; background: #fff; }
    * { box-sizing: border-box; }
    
    .top-bar { display: flex; align-items: center; gap: 20px; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 3px solid #1a1a2e; }
    .top-bar img { max-width: 120px; max-height: 60px; object-fit: contain; }
    .top-bar h1 { font-size: 28px; font-weight: 900; margin: 0; color: #1a1a2e; text-transform: uppercase; letter-spacing: -0.5px; }
    .top-bar h1 span { color: #7c3aed; }
    .top-bar .sub { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: 2px; margin-top: 2px; }
    
    .event-banner { background: #1a1a2e; color: #fff; padding: 14px 20px; font-size: 18px; font-weight: 800; text-align: center; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 20px; border-radius: 4px; }
    
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
    .info-card { background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 6px; padding: 12px 16px; }
    .info-card .label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #666; letter-spacing: 0.5px; margin-bottom: 4px; }
    .info-card .value { font-size: 14px; font-weight: 700; color: #1a1a2e; }
    
    table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    th { background: #1a1a2e; color: #fff; font-size: 10px; font-weight: 700; padding: 8px 10px; border: 1px solid #333; text-align: center; text-transform: uppercase; letter-spacing: 0.3px; }
    th:first-child { text-align: left; }
    td { padding: 7px 10px; border: 1px solid #dee2e6; font-size: 11px; text-align: center; }
    td:first-child { text-align: left; font-weight: 600; }
    tr:nth-child(even) { background: #f8f9fa; }
    
    .grade-A { color: #16a34a; font-weight: 800; }
    .grade-B { color: #2563eb; font-weight: 800; }
    .grade-C { color: #ca8a04; font-weight: 800; }
    .grade-D { color: #d97706; font-weight: 800; }
    .grade-E, .grade-F { color: #dc2626; font-weight: 800; }
    .na-subject { color: #999; font-style: italic; }
    
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    .summary-card { background: #f8f9fa; border: 2px solid #dee2e6; border-radius: 6px; padding: 14px; text-align: center; }
    .summary-card .s-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #666; letter-spacing: 0.5px; }
    .summary-card .s-value { font-size: 24px; font-weight: 900; color: #1a1a2e; margin-top: 4px; }
    .gpa-card .s-value { color: #7c3aed; }
    
    .comment-box { background: #fef3c7; border: 2px solid #f59e0b; border-radius: 6px; padding: 12px 16px; margin-bottom: 16px; }
    .comment-box .c-label { font-size: 10px; font-weight: 700; text-transform: uppercase; color: #92400e; letter-spacing: 0.5px; margin-bottom: 4px; }
    .comment-box .c-text { font-size: 13px; font-weight: 600; color: #78350f; }
    
    .grade-ref { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; font-size: 10px; font-weight: 600; color: #666; }
    .grade-ref-item { background: #f3f4f6; padding: 4px 10px; border-radius: 4px; }
    
    .signature-row { display: flex; justify-content: space-between; margin-bottom: 16px; }
    .signature-box { text-align: center; font-size: 10px; font-weight: 600; color: #666; }
    .signature-box .line { width: 180px; height: 1px; border-top: 2px solid #333; margin-bottom: 6px; }
    
    .footer { text-align: center; font-size: 10px; color: #999; border-top: 2px solid #dee2e6; padding-top: 12px; margin-top: 16px; }
    
    .master-header { text-align: center; font-size: 14px; font-weight: 700; color: #666; margin-bottom: 24px; text-transform: uppercase; letter-spacing: 1px; padding: 8px; border-bottom: 2px solid #dee2e6; }
</style>
</head>
<body>
    <div class="master-header">${evTitle} — Complete Results for All Students</div>
    ${allSheets}
    <div class="footer">Generated by ExamForge on ${dateStr} &middot; Official Academic Record</div>
    <script>window.print();<\/script>
</body>
</html>`;
        
        const printWindow = window.open('', '_blank', 'width=1200,height=800');
        if (printWindow) {
            printWindow.document.write(printHTML);
            printWindow.document.close();
        } else {
            window.showEFModal("Pop-up Blocked", "Please allow pop-ups to print results.", "OK", null, true);
        }
        
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

window.mcRenderSubEventsTab = window.mcRenderSubEventsTab;
window.mcLoadSubEvents = window.mcLoadSubEvents;
window.mcOpenCreateSubEventModal = window.mcOpenCreateSubEventModal;
window.mcSaveSubEvent = window.mcSaveSubEvent;
window.mcDeleteSubEvent = window.mcDeleteSubEvent;
window.mcViewSubEventDetails = window.mcViewSubEventDetails;
// ─── SUBEVENT MOCK EXAMS ────────────────────────────────────────────────

window.mcOpenCreateEventMockModal = async function(eventId, subject) {
    window.currentBuilderQuestions = [
        { question: '', options: ['', '', '', ''], correctIndex: 0, explanation: '', expanded: true }
    ];
    
    const modal = document.createElement('div');
    modal.id = 'ef-dq-builder-modal'; // Reuse CSS selectors
    modal.style.cssText = 'position:fixed;inset:0;background:var(--bg);display:flex;flex-direction:column;z-index:3000;animation:fadeIn 0.2s ease;';
    modal.innerHTML = `
        <style>
            .dq-modal-card { flex:1; display:flex; flex-direction:column; overflow:hidden; }
            .dq-meta-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
            .dq-question-grid-split { display: grid; grid-template-columns: 1fr 2fr; gap: 14px; align-items: start; }
            .dq-opt-row { display:flex; align-items:center; gap:6px; }
            .dq-opt-row input { flex:1; min-width:0; }
            .dq-opt-del-btn { flex-shrink:0; padding:3px 6px; font-size:0.6rem; height:28px; min-width:32px; text-align:center; }
            @media (max-width: 600px) {
                .dq-meta-grid, .dq-question-grid-split { grid-template-columns: 1fr !important; gap: 10px !important; }
                .dq-toggle-grid { grid-template-columns: 1fr !important; }
                .dq-footer-actions { flex-direction: column !important; gap: 8px !important; width: 100%; }
                .dq-footer-actions button { width: 100% !important; }
                .dq-modal-card [style*="padding:20px"] { padding: 12px !important; }
                .dq-modal-card [style*="padding:14px 20px"] { padding: 10px 12px !important; }
            }
        </style>
        <div class="dq-modal-card">
            <div style="display:flex; align-items:center; gap:14px; padding:14px 20px; border-bottom:2px solid var(--border); background:var(--bg-card); flex-shrink:0;">
                <button onclick="document.getElementById('ef-dq-builder-modal').remove()"
                    style="width:40px;height:40px;border-radius:8px;background:var(--bg-inset);border:2px solid var(--border);cursor:pointer;color:var(--text);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round">arrow_back</span>
                </button>
                <div style="width:40px;height:40px;border-radius:8px;background:var(--brand-dim);border:2px solid var(--brand);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                    <span class="material-icons-round" style="color:var(--brand);font-size:1.1rem;">library_books</span>
                </div>
                <div style="font-weight:900;font-size:1.05rem;color:var(--text);text-transform:uppercase;flex:1;">Create Mock: ${subject}</div>
                <button onclick="document.getElementById('ef-dq-builder-modal').remove()"
                    style="width:40px;height:40px;border-radius:8px;background:transparent;border:2px solid var(--border);cursor:pointer;color:var(--text-muted);flex-shrink:0;display:flex;align-items:center;justify-content:center;">
                    <span class="material-icons-round">close</span>
                </button>
            </div>
            
            <div style="flex:1; overflow-y:auto; padding:20px; background:var(--bg); display:flex; flex-direction:column; gap:20px;">
                <div class="dq-meta-grid">
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Mock Title</label>
                        <input type="text" id="dq-builder-title" value="${subject} Mock" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                    </div>
                    <div class="mc-field" style="margin-bottom:0;">
                        <label style="font-weight:800; text-transform:uppercase; font-size:0.7rem; color:var(--text); margin-bottom:6px; display:block;">Time Limit (Minutes)</label>
                        <input type="number" id="dq-builder-time" value="45" min="1" max="180" style="border:3px solid var(--text); border-radius:8px; padding:10px 14px; font-weight:800; font-size:0.85rem; width:100%; box-sizing:border-box; background:var(--bg-card); color:var(--text);">
                    </div>
                </div>
                
                <hr style="border:0; border-top:3px solid var(--text); margin:4px 0;">
                
                <!-- Mock Behaviour Flags -->
                <div class="dq-toggle-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                    <label style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:2px solid #dc2626;border-radius:8px;cursor:pointer;transition:border-color 0.15s;background:#dc262610;" id="mc-tog-wrap-strict">
                        <input type="checkbox" id="mc-tog-strict" checked style="width:16px;height:16px;margin-top:1px;accent-color:#dc2626;flex-shrink:0;">
                        <div>
                            <div style="font-weight:800;font-size:0.78rem;color:var(--text);">🔒 Exam Mode</div>
                            <div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Strict — no practice option</div>
                        </div>
                    </label>
                    <label style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:2px solid #7c3aed;border-radius:8px;cursor:pointer;transition:border-color 0.15s;background:#7c3aed10;" id="mc-tog-wrap-mock">
                        <input type="checkbox" id="mc-tog-mock" checked style="width:16px;height:16px;margin-top:1px;accent-color:#7c3aed;flex-shrink:0;">
                        <div>
                            <div style="font-weight:800;font-size:0.78rem;color:var(--text);">🎭 Hide Results</div>
                            <div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Students won't see score/answers after submission</div>
                        </div>
                    </label>
                    <label style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:2px solid #d97706;border-radius:8px;cursor:pointer;transition:border-color 0.15s;background:#d9770610;" id="mc-tog-wrap-nocorrection">
                        <input type="checkbox" id="mc-tog-nocorrection" checked style="width:16px;height:16px;margin-top:1px;accent-color:#d97706;flex-shrink:0;">
                        <div>
                            <div style="font-weight:800;font-size:0.78rem;color:var(--text);">🚫 No Review</div>
                            <div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Hides correction/review screen after exam</div>
                        </div>
                    </label>
                    <label style="display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:2px solid var(--border);border-radius:8px;cursor:pointer;transition:border-color 0.15s;background:transparent;" id="mc-tog-wrap-private">
                        <input type="checkbox" id="mc-tog-private" style="width:16px;height:16px;margin-top:1px;accent-color:#0f766e;flex-shrink:0;">
                        <div>
                            <div style="font-weight:800;font-size:0.78rem;color:var(--text);">🔐 Restricted</div>
                            <div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;">Only accessible via direct link / schedule</div>
                        </div>
                    </label>
                </div>
                
                <hr style="border:0; border-top:3px solid var(--text); margin:4px 0;">
                
                <div id="dq-bulk-import-panel" style="display:none; background:var(--bg-inset); border:3px solid var(--text);border-radius:12px; padding:16px; margin-bottom:12px; animation:popIn 0.25s ease;">
                    <textarea id="dq-bulk-import-textarea" rows="8" placeholder="Paste questions here..." style="font-family:var(--font-mono); font-size:0.75rem; width:100%; border:2px solid var(--text); border-radius:8px; padding:10px;box-sizing:border-box; resize:vertical; background:var(--bg-card); color:var(--text);"></textarea>
                    <div style="display:flex; justify-content:flex-end; gap:10px; margin-top:12px;">
                        <button class="btn btn-ghost" onclick="window.mcToggleDQBulkImport()" style="font-size:0.7rem; padding:6px 12px; border:2px solid var(--border);">Cancel</button>
                        <button class="btn btn-primary" onclick="window.mcProcessDQBulkImport()" style="font-size:0.7rem; padding:6px 16px; border:2px solid var(--text);background:#7c3aed; border-color:var(--text);">Analyze & Import</button>
                    </div>
                </div>

                <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px;">
                    <div>
                        <div style="font-weight:900; font-size:1.05rem; text-transform:uppercase; color:var(--text);">Questions Builder</div>
                        <div style="display:flex; align-items:center; gap:6px; margin-top:4px;">
                            <button class="btn btn-ghost" onclick="window.mcCollapseAllBuilderQuestions()" style="font-size:0.62rem; padding:2px 6px; border:1px solid var(--border);font-weight:800; text-transform:uppercase;">Collapse All</button>
                            <button class="btn btn-ghost" onclick="window.mcExpandAllBuilderQuestions()" style="font-size:0.62rem; padding:2px 6px; border:1px solid var(--border);font-weight:800; text-transform:uppercase;">Expand All</button>
                        </div>
                    </div>
                    
                    <div style="display:flex; align-items:center; gap:8px;">
                        <button class="btn btn-outline dq-header-actions-btn" onclick="window.mcToggleDQBulkImport()" style="font-size:0.72rem; padding:6px 12px; border:2px solid #7c3aed; color:#7c3aed;font-weight:800; display:flex; align-items:center; gap:4px;">
                            <span class="material-icons-round" style="font-size:0.95rem;">auto_fix_high</span> Bulk Import
                        </button>
                        <button class="btn btn-primary dq-header-actions-btn" onclick="window.mcAddBuilderQuestion()" style="font-size:0.72rem; padding:6px 12px; border:2px solid var(--text);font-weight:800; display:flex; align-items:center; gap:4px;">
                            <span class="material-icons-round" style="font-size:0.95rem;">add</span> Add Question
                        </button>
                    </div>
                </div>
                
                <div id="dq-builder-questions-list" style="display:flex; flex-direction:column; gap:16px;"></div>
            </div>
            
            <div class="dq-footer-actions" style="display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:12px 16px; border-top:3px solid var(--text); background:var(--bg-card); flex-shrink:0; flex-wrap:wrap;">
                <button class="btn btn-ghost" onclick="document.getElementById('ef-dq-builder-modal').remove()" style="border:3px solid var(--border); font-weight:900;padding:8px 16px;font-size:0.72rem;">CANCEL</button>
                <button class="btn btn-primary" onclick="window.mcSaveCreatedEventMock('${eventId}', '${subject}')" style="font-weight:900; border:3px solid var(--text);padding:8px 16px;font-size:0.72rem;">SAVE MOCK EXAM</button>
                <button class="btn btn-primary" onclick="window.mcReleaseSubjectMock('${eventId}', '${subject}')" style="background:#10b981; border:3px solid var(--text);font-weight:900; padding:8px 16px;font-size:0.72rem; color:#fff;">SAVE & RELEASE</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    // Attempt to preload existing mock if any (await it so questions render with loaded data)
    await window.mcPreloadEventMock(eventId, subject);

    // Bind toggle color updates
    const colorMap = { strict: '#dc2626', mock: '#7c3aed', nocorrection: '#d97706', private: '#0f766e' };
    ['strict','mock','nocorrection','private'].forEach(id => {
        const cb = document.getElementById(`mc-tog-${id}`);
        const wrap = document.getElementById(`mc-tog-wrap-${id}`);
        if (!cb || !wrap) return;
        const update = () => {
            wrap.style.borderColor = cb.checked ? colorMap[id] : 'var(--border)';
            wrap.style.background  = cb.checked ? `${colorMap[id]}10` : 'transparent';
        };
        cb.addEventListener('change', update);
    });
};

window.mcPreloadEventMock = async function(eventId, subject) {
    try {
        await sync.refresh('mock_exams', [where('eventId', '==', eventId), where('subject', '==', subject)]);
        const mockResults = (await sync.query('mock_exams', [where('eventId', '==', eventId), where('subject', '==', subject)])) || [];
        if (mockResults.length > 0) {
            const m = mockResults[0];
            document.getElementById('dq-builder-title').value = m.title;
            document.getElementById('dq-builder-time').value = m.timeLimit;
            window.currentBuilderQuestions = m.questions || [];
            if(window.currentBuilderQuestions.length === 0) window.currentBuilderQuestions = [{ question: '', options: ['', '', '', ''], correctIndex: 0, explanation: '', expanded: true }];
            window.currentBuilderQuestions.forEach(q => q.expanded = false);
            if(window.currentBuilderQuestions[0]) window.currentBuilderQuestions[0].expanded = true;
            // Restore toggle states from loaded mock
            const toggleIds = ['mc-tog-strict', 'mc-tog-mock', 'mc-tog-nocorrection', 'mc-tog-private'];
            const toggleStates = {
                'mc-tog-strict': m.isStrict,
                'mc-tog-mock': m.isMock,
                'mc-tog-nocorrection': m.isCorrection === false,
                'mc-tog-private': m.isPrivate
            };
            const colorMap2 = { strict: '#dc2626', mock: '#7c3aed', nocorrection: '#d97706', private: '#0f766e' };
            toggleIds.forEach(id => {
                const cb = document.getElementById(id);
                if (cb && toggleStates[id] !== undefined) {
                    cb.checked = toggleStates[id];
                    // Update the wrap style
                    const suffix = id.replace('mc-tog-', '');
                    const wrap = document.getElementById(`mc-tog-wrap-${suffix}`);
                    if (wrap) {
                        wrap.style.borderColor = cb.checked ? colorMap2[suffix] : 'var(--border)';
                        wrap.style.background  = cb.checked ? `${colorMap2[suffix]}10` : 'transparent';
                    }
                }
            });
        }
    } catch(e) {
        console.error("Error preloading mock", e);
    }
    // ALWAYS render after preload, whether data was found or not
    window.mcRenderBuilderQuestions();
};

window.mcSaveCreatedEventMock = async function(eventId, subject, autoRelease=false) {
    const title = document.getElementById('dq-builder-title')?.value.trim();
    const time = parseInt(document.getElementById('dq-builder-time')?.value) || 45;
    
    window.mcSyncBuilderStateFromDOM();
    if (!title || window.currentBuilderQuestions.length === 0) return window.showEFModal("Error", "Invalid title or empty questions", "OK", null, true);
    
    const saveBtn = document.querySelector('#ef-dq-builder-modal .btn-primary');
    saveBtn.textContent = 'SAVING...';
    saveBtn.disabled = true;
    
    try {
        const existingMocks = (await sync.query('mock_exams', [where('eventId', '==', eventId), where('subject', '==', subject)])) || [];
        
        let mockId;
        if (existingMocks.length > 0) {
            mockId = existingMocks[0].id;
        } else {
            mockId = 'mock_' + doc(collection(db, 'mock_exams')).id;
        }
        
        await setDoc(doc(db, 'mock_exams', mockId), {
            id: mockId,
            eventId,
            subject,
            title,
            questions: window.currentBuilderQuestions,
            timeLimit: time,
            isStrict:     document.getElementById('mc-tog-strict')?.checked ?? true,
            isMock:       document.getElementById('mc-tog-mock')?.checked ?? true,
            isCorrection: !(document.getElementById('mc-tog-nocorrection')?.checked ?? true),
            isPrivate:    document.getElementById('mc-tog-private')?.checked ?? false,
            isStrictMock: true,
            createdAt: serverTimestamp()
        });
        
        sync.refresh('mock_exams').catch(() => {});
        if (!autoRelease) {
            document.getElementById('ef-dq-builder-modal')?.remove();
            window.showEFModal("Saved", "Mock exam saved successfully.", "OK", null, true);
        }
        return mockId;
    } catch (e) {
        console.error(e);
        saveBtn.disabled = false;
        saveBtn.textContent = 'SAVE MOCK EXAM';
        window.showEFModal("Error", e.message, "OK", null, true);
        return null;
    }
};

window.mcReleaseSubjectMock = async function(eventId, subject) {
    const mockId = await window.mcSaveCreatedEventMock(eventId, subject, true);
    if (!mockId) return;

    window.showEFModal("Release Mock", `Are you sure you want to release the ${subject} mock to all registered students?`, "RELEASE", async () => {
        try {
            // 1. Find all students who registered for this subject
            const regDocs = await sync.collection('subscription_events/' + eventId + '/registrations');
            const uids = [];
            regDocs.forEach(r => {
                if (r.subjects && r.subjects.includes(subject)) uids.push(r.id);
            });
            
            if (uids.length === 0) {
                return window.showEFModal("Notice", "No students registered for this subject.", "OK", null, true);
            }

            // 2. Get event and mock details
            const ev = await sync.doc('subscription_events/' + eventId);
            const evTitle = ev ? ev.title : 'Mock Exam';
            
            const mockData = await sync.doc('mock_exams/' + mockId);
            const timeLimit = (mockData && mockData.timeLimit) || 45;

            // 3. Send notification + schedule item to each student
            for (const uid of uids) {
                // Notification
                const notifRef = doc(collection(db, 'users', uid, 'notifications'));
                await setDoc(notifRef, {
                    id: notifRef.id,
                    type: 'broadcast',
                    title: 'Mock Exam Released!',
                    message: `Your ${subject} mock exam for "${evTitle}" is ready. Tap to start.`,
                    actionLabel: 'TAKE EXAM',
                    actionPath: `/quiz.html?mockid=${mockId}`,
                    createdAt: serverTimestamp(),
                    read: false,
                    brandColor: '#10b981',
                    brandIcon: 'library_books'
                });

                // Schedule item
                const schedRef = doc(collection(db, 'users', uid, 'schedule'));
                const durDays = ev.durationDays || 30;
                const now = new Date();
                const expDate = new Date(now);
                expDate.setDate(expDate.getDate() + durDays);
                const expYear = expDate.getFullYear();
                const expMonth = String(expDate.getMonth() + 1).padStart(2, '0');
                const expDay = String(expDate.getDate()).padStart(2, '0');
                await setDoc(schedRef, {
                    id: schedRef.id,
                    type: 'mock_exam',
                    title: `${subject} Mock - ${evTitle}`,
                    course: subject,
                    mockId: mockId,
                    eventId: eventId,
                    timeLimit: timeLimit,
                    quizUrl: `/quiz.html?mockid=${mockId}`,
                    message: `Complete your ${subject} mock exam for "${evTitle}".`,
                    date: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
                    time: 'All day',
                    dueDate: `${expYear}-${expMonth}-${expDay}`,
                    dueTime: '23:59',
                    dueTimestamp: new Date(`${expYear}-${expMonth}-${expDay}T23:59:00`),
                    timestamp: serverTimestamp(),
                    read: false
                });
            }
            
            document.getElementById('ef-dq-builder-modal')?.remove();
            window.showEFModal("Success", `Mock released. ${uids.length} students notified and scheduled.`, "AWESOME", null, true);

        } catch (e) {
            console.error(e);
            window.showEFModal("Error", e.message, "OK", null, true);
        }
    });
};

window.mcBroadcastEventResults = async function(eventId) {
    window.showEFModal("Broadcast Results", "This will calculate GPA, generate result sheets, and send them to all students who took the exams.", "BROADCAST NOW", async () => {
        try {
            // Mark event as broadcasted
            const { doc, updateDoc, setDoc, deleteDoc, serverTimestamp, collection } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
            await updateDoc(doc(db, 'subscription_events', eventId), { resultsReleased: true });
            await sync.refresh('subscription_events');
            const evData = await sync.doc('subscription_events/' + eventId) || {};
            const evTitle = evData.title || 'Mock Exam';
            
            // Normalize subjects with CUs
            const subjects = (evData.availableSubjects || []).map(s => mcNormalizeSubject(s));
            
            // Find all mocks linked to this event
            const mocks = await sync.query('mock_exams', [where('eventId', '==', eventId)]);
            
            // Group students by UID across all mocks
            const studentResults = {};
            
            for (const mock of mocks) {
                const subject = mock.subject;
                const subjNorm = subjects.find(s => s.name === subject);
                const creditUnit = subjNorm ? subjNorm.creditUnit : 1;
                
                const attempts = await sync.collection('mock_exams/' + mock.id + '/attempts');
                
                attempts.forEach(attempt => {
                    const uid = attempt.uid;
                    
                    if (!studentResults[uid]) {
                        studentResults[uid] = {
                            uid,
                            displayName: attempt.displayName || 'Unknown',
                            email: attempt.email || '',
                            subjects: []
                        };
                    }
                    
                    studentResults[uid].subjects.push({
                        name: subject,
                        creditUnit,
                        score: attempt.score || 0,
                        correct: attempt.correct || 0,
                        total: attempt.totalQuestions || 0,
                        grade: mcGradeFromScore(attempt.score || 0)
                    });
                });
            }
            
            if (Object.keys(studentResults).length === 0) {
                return window.showEFModal("No Data", "No student attempts found. Students need to take the exams first.", "OK", null, true);
            }
            
            let totalSent = 0;
            
            // Process each student
            for (const [uid, data] of Object.entries(studentResults)) {
                // Calculate GPA
                let totalPoints = 0, totalCU = 0;
                data.subjects.forEach(s => {
                    totalPoints += (s.grade && s.grade.points ? s.grade.points : 0) * s.creditUnit;
                    totalCU += s.creditUnit;
                });
                const gpa = totalCU > 0 ? Math.round((totalPoints / totalCU) * 100) / 100 : 0;
                const gpaComment = mcGPAComment(gpa);
                
                // Build result sheet HTML
                const resultHTML = buildResultSheetHTML(evTitle, data, gpa, gpaComment);
                
                // Save to user's results
                const resultId = `event_${eventId}_${Date.now()}`;
                const resRef = doc(db, 'users', uid, 'results', resultId);
                await setDoc(resRef, {
                    id: resultId,
                    eventId,
                    eventTitle: evTitle,
                    subjects: data.subjects,
                    gpa,
                    gpaComment,
                    totalCU,
                    totalPoints,
                    resultSheet: resultHTML,
                    timestamp: serverTimestamp(),
                    isMock: true,
                    releasedAt: serverTimestamp()
                });
                
                // Send new notification with result sheet (no spoilers)
                const notifRef = doc(collection(db, 'users', uid, 'notifications'));
                await setDoc(notifRef, {
                    id: notifRef.id,
                    type: 'broadcast',
                    title: `📊 ${evTitle} - Results Released`,
                    message: `Your results for ${evTitle} are ready.\n\nTap to view your full result sheet.`,
                    actionLabel: 'VIEW RESULT',
                    actionPath: `/quiz.html?resultId=${resultId}&eventId=${eventId}`,
                    timestamp: serverTimestamp(),
                    read: false,
                    brandColor: '#7c3aed',
                    brandIcon: 'gavel',
                    resultData: {
                        eventId,
                        eventTitle: evTitle,
                        gpa,
                        gpaComment,
                        totalCU,
                        subjects: data.subjects,
                        resultHTML: resultHTML
                    }
                });
                
                totalSent++;
            }
            
            document.getElementById('ef-se-details-overlay')?.remove();
            window.showEFModal("Broadcast Complete", `Result sheets sent to ${totalSent} student(s). GPA calculated and comments generated.`, "OK", null, true);
            window.mcLoadSubEvents();
            
        } catch (e) {
            console.error(e);
            window.showEFModal("Error", e.message, "OK", null, true);
        }
    });
};

// ── Build neo-brutalist result sheet HTML ──
function buildResultSheetHTML(eventTitle, studentData, gpa, gpaComment) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const studentName = studentData.displayName || 'N/A';
    const studentEmail = studentData.email || '';
    
    const rows = studentData.subjects.map(s => {
        if (s.score === null || s.score === undefined || s.grade === null) {
            return `
            <tr>
                <td style="text-align:left;">${s.name}</td>
                <td>${s.creditUnit}</td>
                <td class="na-subject" colspan="3">Not attempted</td>
                <td class="na-subject">—</td>
                <td class="na-subject">—</td>
            </tr>`;
        }
        const g = s.grade;
        return `
        <tr>
            <td style="text-align:left;">${s.name}</td>
            <td>${s.creditUnit}</td>
            <td>${s.correct}/${s.total}</td>
            <td>${s.score}%</td>
            <td class="grade-${g.grade}">${g.grade}</td>
            <td>${g.points.toFixed(1)}</td>
            <td style="font-size:11px;">${g.remark}</td>
        </tr>`;
    }).join('');
    
    const totalCU = studentData.subjects.reduce((sum, s) => sum + s.creditUnit, 0);
    
    return `
        <div class="top-bar">
            <img src="/examforge.jpeg" alt="ExamForge" onerror="this.style.display='none'" style="max-width:120px;max-height:60px;width:auto;height:auto;object-fit:contain;">
            <div class="title-area">
                <h1>Exam<span>Forge</span></h1>
                <div class="sub">Official Result Sheet</div>
                <div style="font-size:9px;font-weight:600;color:#888;letter-spacing:0.12em;text-transform:uppercase;margin-top:4px;">Discipline. Direction. Distinction.</div>
            </div>
        </div>
        
        <div class="event-banner">${eventTitle}</div>
        
        <div class="info-grid">
            <div class="info-card">
                <div class="label">Student</div>
                <div class="value">${studentName}</div>
            </div>
            <div class="info-card">
                <div class="label">Email</div>
                <div class="value">${studentEmail}</div>
            </div>
            <div class="info-card">
                <div class="label">Date Issued</div>
                <div class="value">${dateStr}</div>
            </div>
            <div class="info-card">
                <div class="label">Transcript ID</div>
                <div class="value" style="font-family:'JetBrains Mono',monospace;font-size:12px;">EF-${Date.now().toString(36).toUpperCase()}</div>
            </div>
        </div>
        
        <table>
            <thead>
                <tr>
                    <th style="text-align:left;min-width:110px;">Course</th>
                    <th style="width:40px;">CU</th>
                    <th style="width:65px;">Score</th>
                    <th style="width:50px;">%</th>
                    <th style="width:45px;">Grade</th>
                    <th style="width:45px;">GP</th>
                    <th style="text-align:left;">Remark</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
        
        <div class="summary-grid" style="grid-template-columns:1fr 1fr;">
            <div class="summary-card">
                <div class="s-label">Total Credit Units</div>
                <div class="s-value">${totalCU}</div>
            </div>
            <div class="summary-card gpa-card">
                <div class="s-label">GPA</div>
                <div class="s-value">${gpa.toFixed(2)}</div>
            </div>
        </div>
        
        <div class="comment-box">
            <div class="c-label">Academic Comment</div>
            <div class="c-text">${gpaComment}</div>
        </div>
        
        <div class="grade-ref">
            <span class="grade-ref-item">A = 5.0</span>
            <span class="grade-ref-item">B = 4.0</span>
            <span class="grade-ref-item">C = 3.0</span>
            <span class="grade-ref-item">D = 2.0</span>
            <span class="grade-ref-item">E = 1.0</span>
            <span class="grade-ref-item">F = 0.0</span>
        </div>
        
        <div class="signature-row">
            <div class="signature-box">
                <div class="line"></div>
                ExamForge Administrator
            </div>
            <div class="signature-box">
                <div class="line"></div>
                Date Issued
            </div>
        </div>
        
        <div class="footer">
            <p>This is a computer-generated transcript. All results are final.</p>
            <p>ExamForge &copy; ${now.getFullYear()} &middot; Official Academic Record</p>
        </div>`;
}

// ── Edit credit unit for a subject in an event ──
window.mcEditSubjectCU = async function(eventId, subjectName, currentCU) {
    const newCU = prompt(`Edit credit unit for "${subjectName}":`, currentCU);
    if (newCU === null) return; // cancelled
    const cu = parseInt(newCU);
    if (isNaN(cu) || cu < 1 || cu > 20) {
        window.showEFModal("Invalid Input", "Please enter a number between 1 and 20.", "OK", null, true);
        return;
    }
    try {
        const ev = await sync.doc('subscription_events/' + eventId);
        if (!ev) throw new Error("Event not found");
        const subjects = (ev.availableSubjects || []).map(s => {
            const n = mcNormalizeSubject(s);
            if (n.name === subjectName) n.creditUnit = cu;
            return n;
        });
        const { doc, updateDoc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
        await updateDoc(doc(db, 'subscription_events', eventId), { availableSubjects: subjects });
        await sync.refresh('subscription_events');
        
        // Update the display in real-time
        const displayEl = document.getElementById(`cu-display-${subjectName.replace(/\s+/g,'-')}`);
        if (displayEl) {
            displayEl.textContent = cu;
            // Also update the parent text
            const parent = displayEl.closest('div');
            if (parent) {
                parent.innerHTML = `<span id="cu-display-${subjectName.replace(/\s+/g,'-')}">${cu}</span> Credit Unit${cu !== 1 ? 's' : ''}`;
            }
        }
        
        window.showEFModal("Updated", `"${subjectName}" credit unit changed to ${cu}.`, "OK", null, true);
    } catch (e) {
        console.error(e);
        window.showEFModal("Error", e.message, "OK", null, true);
    }
};

// Global Modal Scroll Preventer
const _modalObserver = new MutationObserver(() => {
  const hasModal = Array.from(document.body.children).some(el => 
    (el.id && (el.id.includes('modal') || el.id.includes('overlay'))) ||
    (el.className && typeof el.className === 'string' && (el.className.includes('modal') || el.className.includes('overlay')))
  );
  document.body.style.overflow = hasModal ? 'hidden' : '';
});
_modalObserver.observe(document.body, { childList: true });
