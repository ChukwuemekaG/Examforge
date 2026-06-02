import { auth, db } from './firebase-config.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { SyncManager } from './sync.js';
import { collection, addDoc, arrayUnion, doc, getDoc, setDoc, updateDoc, serverTimestamp, query, where, getDocs, limit } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";

// ── Safe DOM helpers - prevent null reference errors on mobile ──
const $id = (id) => document.getElementById(id);
const safeStyle = (id, prop, val) => { const e = $id(id); if (e) e.style[prop] = val; };
const safeText = (id, val) => { const e = $id(id); if (e) e.textContent = val; };
const safeDisplay = (id, val) => { const e = $id(id); if (e) e.style.display = val; };
const safeHTML = (id, val) => { const e = $id(id); if (e) e.innerHTML = val; };

document.addEventListener('DOMContentLoaded', () => {

    // --- FIREBASE AUTHENTICATION CHECK ---
    let currentUser = null;
    let sync = null;
    onAuthStateChanged(auth, (user) => {
        if (user) {
            currentUser = user;
        } else {
            window.location.href = '/';
        }
    });

    // --- 1. STATE ARCHITECTURE ---
    let examState = {
        subjects: [],
        currentSubjectIdx: 0,
        timeLimit: 0,
        isQuizActive: false,
        isReviewMode: false,
        isStrict: false,
        isMock: false,
        mode: 'exam',
        startTime: null,       
        timeTaken: 0,          
        quizId: null,          
        isRetake: false        
    };

    let timerInterval = null;
    let timeRemaining = 0;

    // --- 2. DOM ELEMENTS ---
    const views = {
        loading: document.getElementById('loading-view'),
        config: document.getElementById('config-view'),
        warning: document.getElementById('warning-view'),
        quiz: document.getElementById('quiz-view'),
        results: document.getElementById('results-view')
    };

    const btnMapToggle = document.getElementById('btn-map-toggle');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const cbtSidebar = document.querySelector('.cbt-sidebar');
    const cbtMain = document.querySelector('.cbt-main');
    const submitModal = document.getElementById('submit-modal');
    const btnSubmitConfirm = document.getElementById('btn-submit-confirm');
    const btnSubmitCancel = document.getElementById('btn-submit-cancel');
    const subjectTabsContainer = document.getElementById('subject-tabs');
    const questionMapContainer = document.getElementById('question-map');
    const mapSubjectTitle = document.getElementById('map-subject-title');

    const qText = document.getElementById('question-text');
    const optionsContainer = document.getElementById('options-container');
    const explBox = document.getElementById('explanation-box');
    const explText = document.getElementById('explanation-text');
    const timerDisplay = document.getElementById('timer-display');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('q-progress');

    const btnNext = document.getElementById('btn-next');
    const btnPrev = document.getElementById('btn-prev');
    const btnSubmitEarly = document.getElementById('btn-submit-early');
    const btnReview = document.getElementById('btn-review-corrections');

    const exitModal = document.getElementById('exit-modal');
    const btnExitGlobal = document.getElementById('btn-exit-global');
    const btnExitCancel = document.getElementById('btn-exit-cancel');

    // --- 3. INITIALIZATION & DATA FETCHING ---
    // --- 3. INITIALIZATION & DATA FETCHING (Firestore-powered) ---

    /**
     * URL SCHEME:
     *   Single topic:   quiz.html?course=mth101&topic=complex-numbers&title=Complex+Numbers
     *   Full course:    quiz.html?course=mth101&topic=__full__&title=MTH101+Full+Exam
     *   JAMB mode:      quiz.html?courses=mth101,phy101,chm101&mode=jamb&titles=Maths,Physics,Chemistry
     *   Legacy JSON:    quiz.html?files=path/to/file.json&title=Title  (still works)
     */
    async function init() {
        switchView('loading');
        // Initialize cache-first Firestore sync
        sync = new SyncManager(db);
        const p = new URLSearchParams(window.location.search);

        // ── DAILY QUIZ INTERCEPTOR ───────────────────────────────────────────
        const dqid = p.get('dqid');
        if (dqid) {
            examState.quizId = dqid;
            try {
                const d = await sync.doc('daily_quizzes/' + dqid);
                if (!d) throw new Error(`Daily Quiz not found.`);
                const maxAttempts = d.maxAttempts || 1;
                
                // Check for existing attempt (embedded completedBy array — 0 extra reads)
                const allQuestions = d.questions || [];
                let existingAttempt = null;
                const storageKey = 'examforge_dq_' + dqid;
                const cachedAttempt = localStorage.getItem(storageKey);
                
                // Check completedBy array in quiz doc (already loaded, 0 reads)
                const completedBy = d.completedBy || [];
                if (completedBy.includes(currentUser.uid)) {
                    // Load from lastAttempts map embedded in quiz doc
                    const lastData = (d.lastAttempts && d.lastAttempts[currentUser.uid]) || null;
                    if (lastData) {
                        existingAttempt = lastData;
                    }
                }
                
                // Fall back to localStorage if no embedded data found
                if (!existingAttempt && cachedAttempt) {
                    try {
                        existingAttempt = JSON.parse(cachedAttempt);
                    } catch(e) {}
                }
                
                if (existingAttempt) {
                    examState.isRetake = true;
                    // Show existing results - allow review
                    const scoreColor = existingAttempt.score >= 80 ? '#16a34a' : existingAttempt.score >= 50 ? '#2563eb' : 'var(--brand)';
                    const timeStr = existingAttempt.timeTaken ? `${Math.floor(existingAttempt.timeTaken/60)}m ${existingAttempt.timeTaken%60}s` : '—';
                    const wrong = (existingAttempt.totalQuestions || 0) - (existingAttempt.correct || 0);
                    const gradeChar = existingAttempt.score >= 80 ? 'A' : existingAttempt.score >= 65 ? 'B' : existingAttempt.score >= 50 ? 'C' : existingAttempt.score >= 40 ? 'D' : 'F';
                    const gradeColor = existingAttempt.score >= 80 ? '#16a34a' : existingAttempt.score >= 65 ? '#2563eb' : existingAttempt.score >= 50 ? '#ca8a04' : existingAttempt.score >= 40 ? '#d97706' : '#fe6961';
                    
                    // Insert quiz info bar for daily quiz retake
                    const dqContainer = $id('subject-scores-container');
                    const existingInfoBar = $id('quiz-info-bar');
                    if (dqContainer && !existingInfoBar) {
                        const infoDiv = document.createElement('div');
                        infoDiv.id = 'quiz-info-bar';
                        infoDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;padding:10px 14px;background:var(--bg-inset);border:2px solid var(--border);border-radius:10px;';
                        const dqTitle = d?.title || 'Daily Quiz';
                        const dqTime = d?.timeLimit ? d.timeLimit + ' min' : '—';
                        infoDiv.innerHTML = `
                            <div style="display:flex;align-items:center;gap:6px;font-size:0.75rem;font-weight:700;color:var(--text);">
                                <span class="material-icons-round" style="font-size:1rem;color:var(--brand);">book</span>
                                ${dqTitle}
                            </div>
                            <div style="flex:1;"></div>
                            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                                <span style="display:flex;align-items:center;gap:4px;font-size:0.7rem;font-weight:600;color:var(--text-muted);">
                                    <span class="material-icons-round" style="font-size:0.85rem;">timer</span>
                                    ${dqTime}
                                </span>
                                <span style="display:flex;align-items:center;gap:4px;font-size:0.7rem;font-weight:600;color:var(--text-muted);">
                                    <span class="material-icons-round" style="font-size:0.85rem;">gavel</span>
                                    Exam Mode
                                </span>
                            </div>
                        `;
                        dqContainer.parentNode.insertBefore(infoDiv, dqContainer);
                    }

                    safeHTML('subject-scores-container', `
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
                            <div style="background:rgba(22,163,74,0.08);border:2px solid #16a34a;border-radius:10px;padding:14px;text-align:center;">
                                <div style="font-size:1.3rem;font-weight:900;color:#16a34a;">${existingAttempt.correct || 0}</div>
                                <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Correct</div>
                            </div>
                            <div style="background:rgba(254,105,97,0.06);border:2px solid #fe6961;border-radius:10px;padding:14px;text-align:center;">
                                <div style="font-size:1.3rem;font-weight:900;color:#fe6961;">${wrong}</div>
                                <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Wrong</div>
                            </div>
                        </div>
                        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                            <div style="background:var(--bg-inset);border:2px solid var(--border);border-radius:10px;padding:12px;text-align:center;">
                                <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px;">Grade</div>
                                <div style="font-size:1.5rem;font-weight:900;color:${gradeColor};">${gradeChar}</div>
                            </div>
                            <div style="background:var(--bg-inset);border:2px solid var(--border);border-radius:10px;padding:12px;text-align:center;">
                                <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px;">Time</div>
                                <div style="font-size:1.1rem;font-weight:800;color:var(--text);">${timeStr}</div>
                            </div>
                        </div>
                        <div style="margin-top:12px;background:var(--bg-inset);border-radius:6px;padding:6px 10px;">
                            <div style="display:flex;justify-content:space-between;font-size:0.65rem;font-weight:700;color:var(--text-muted);margin-bottom:4px;">
                                <span>Score</span>
                                <span>${existingAttempt.score}%</span>
                            </div>
                            <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden;border:1px solid var(--border);">
                                <div style="height:100%;width:${existingAttempt.score}%;background:${gradeColor};border-radius:4px;"></div>
                            </div>
                        </div>
                    `);
                    
                    const ri = $id('result-icon'); if (ri) { ri.textContent = 'assignment'; ri.style.color = '#2563eb'; }
                    const rt = $id('result-title'); if (rt) rt.textContent = `${existingAttempt.score}% - Completed`;
                    
                    // Hide review button on retake - no corrections after closing
                    const rb = $id('btn-review-corrections');
                    if (rb) rb.style.display = 'none';
                    
                    safeDisplay('timer-display', 'none');
                    safeDisplay('btn-submit-early', 'none');
                    safeDisplay('quiz-header-actions', 'none');
                    switchView('results');
                    return;
                }
                if (allQuestions.length === 0) throw new Error('No questions available in this daily quiz.');
                
                examState.isStrict = true;
                examState.isMock = false;
                examState._isCorrection = true;
                
                examState.subjects = [{
                    id: 0,
                    title: d.title || 'Daily Quiz',
                    isCorrection: true,
                    questions: allQuestions, // Load all questions without slicing
                    userAnswers: new Array(allQuestions.length).fill(null),
                    currentQIdx: 0
                }];
                examState.timeLimit = (d.timeLimit && d.timeLimit > 0 ? d.timeLimit : 10) * 60;
                
                examState.mode = 'exam'; // Always strict exam mode for daily quizzes
                const timerEl = document.getElementById('rule-timer');
                if (timerEl) timerEl.style.display = 'block';
                switchView('warning');
            } catch (e) {
                showLoadError(e);
            }
            return;
        }

        // ── MOCK EXAM INTERCEPTOR ─────────────────────────────────────────────
        const mockid = p.get('mockid');
        if (mockid) {
            examState.quizId = mockid;
            examState.isMockExam = true;
            try {
                const d = await sync.doc('mock_exams/' + mockid);
                if (!d) throw new Error(`Mock Exam not found.`);
                
                const allQuestions = d.questions || [];
                if (allQuestions.length === 0) throw new Error('No questions available in this mock exam.');
                
                examState.isStrict = true;
                examState.isMock = false;
                examState._isCorrection = false; // Mock exams hide corrections initially
                
                examState.subjects = [{
                    id: 0,
                    title: d.title || 'Mock Exam',
                    isCorrection: false,
                    questions: allQuestions,
                    userAnswers: new Array(allQuestions.length).fill(null),
                    currentQIdx: 0
                }];
                examState.timeLimit = (d.timeLimit && d.timeLimit > 0 ? d.timeLimit : 10) * 60;
                
                examState.mode = 'exam'; // Always strict exam mode
                const timerEl2 = document.getElementById('rule-timer');
                if (timerEl2) timerEl2.style.display = 'block';
                switchView('warning');
            } catch (e) {
                showLoadError(e);
            }
            return;
        }

        // ── LEGACY: JSON file-based fallback ─────────────────────────────────
        if (p.get('files')) {
            const files  = p.get('files').split(',');
            const titles = (p.get('title') || p.get('titles') || '').split(',').map(t => decodeURIComponent(t.trim()));
            examState.quizId = files.map(f => f.trim()).sort().join(',');
            try {
                const responses = await Promise.all(files.map(f => fetch(f.trim())));
                const dataSets  = await Promise.all(responses.map(r => {
                    if (!r.ok) throw new Error(`Failed: ${r.url}`);
                    return r.json();
                }));
                buildExamStateFromJSON(dataSets, titles);
            } catch (e) { showLoadError(e); }
            return;
        }

        // ── JAMB MODE: multiple courses, one tab per course ───────────────────
        if (p.get('mode') === 'jamb' && p.get('courses')) {
            const courseIds = p.get('courses').split(',').map(c => c.trim()).filter(Boolean);
            const rawTitles = p.get('titles') ? p.get('titles').split(',').map(t => decodeURIComponent(t.trim())) : [];
            examState.quizId  = 'jamb:' + courseIds.sort().join(',');
            examState.isStrict = true;
            examState.isMock   = false;

            try {
                const subjects = await Promise.all(courseIds.map(async (courseId, i) => {
                    // Read course doc (1 read, has allQuestions field)
                    const courseData = await sync.doc('unicourses/' + courseId);
                    if (!courseData) {
                        return { id: i, title: courseId.toUpperCase(), questions: [], userAnswers: [], currentQIdx: 0, timeSeconds: 0 };
                    }
                    
                    let allQuestions = courseData.allQuestions || [];
                    let totalTimeLimit = courseData.totalTimeLimit || 0;
                    let anyNoCorrection = courseData.isCorrection === false;
                    let courseTitle = rawTitles[i] || courseData.title || courseId.toUpperCase();
                    
                    // Fallback for courses without allQuestions (legacy data, one-time cost)
                    if (!allQuestions.length) {
                        const topicsData = (await sync.collection('unicourses/' + courseId + '/topics')) || [];
                        topicsData.forEach(d => {
                            allQuestions.push(...(d.questions || []));
                            totalTimeLimit += (d.timeLimit || 0);
                            if (d.isCorrection === false) anyNoCorrection = true;
                        });
                        // Cache in course doc for future 1-read access
                        try {
                            await updateDoc(doc(db, 'unicourses', courseId), {
                                allQuestions, totalTimeLimit, isCorrection: !anyNoCorrection
                            });
                        } catch(e) { console.error('Failed to cache allQuestions:', e); }
                    }
                    
                    const selected = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, Math.min(40, allQuestions.length));
                    return {
                        id: i, title: courseTitle,
                        isCorrection: !anyNoCorrection,
                        questions: selected,
                        userAnswers: new Array(selected.length).fill(null),
                        currentQIdx: 0,
                        timeSeconds: totalTimeLimit > 0 ? totalTimeLimit * 60 : 40 * 60
                    };
                }));

                examState.subjects  = subjects;
                examState.timeLimit = subjects.reduce((sum, s) => sum + s.timeSeconds, 0);
                if (examState.subjects.every(s => s.questions.length === 0)) {
                    showLoadError(new Error('No questions found for selected courses.')); return;
                }
                safeDisplay('rule-timer', 'block');
                switchView('warning');
            } catch (e) { showLoadError(e); }
            return;
        }

        // ── SINGLE COURSE: one topic OR full course (all topics merged) ───────
        const courseId = p.get('course');
        const topicId  = p.get('topic');
        const rawTitle = p.get('title') ? decodeURIComponent(p.get('title')) : null;

        if (!courseId || !topicId) { showLoadError(new Error('Missing course or topic parameter.')); return; }

        examState.quizId = `${courseId}:${topicId}`;

        try {
            let allQuestions = [], totalTimeLimit = 0;
            let subjectTitle = rawTitle || courseId.toUpperCase();

            if (topicId === '__full__') {
                const courseData = await sync.doc('unicourses/' + courseId);
                if (!courseData) throw new Error('Course not found');
                
                // Try allQuestions field (1 read for everything)
                const cachedQuestions = courseData.allQuestions || [];
                let anyStrict = courseData.isStrict || false;
                let anyMock = courseData.isMock || false;
                let anyNoCorrection = courseData.isCorrection === false;
                totalTimeLimit = courseData.totalTimeLimit || 40;
                subjectTitle = (courseData.title || courseId.toUpperCase()) + ' — Full Exam';
                
                if (cachedQuestions.length) {
                    // allQuestions cached — 1 read done, use it directly
                    allQuestions = cachedQuestions;
                } else {
                    // Fallback for courses without allQuestions (legacy data, one-time cost)
                    const topicsData = (await sync.collection('unicourses/' + courseId + '/topics')) || [];
                    topicsData.forEach(d => {
                        allQuestions.push(...(d.questions || []));
                        totalTimeLimit += (d.timeLimit || 0);
                        if (d.isStrict)            anyStrict      = true;
                        if (d.isMock)              anyMock        = true;
                        if (d.isCorrection===false) anyNoCorrection = true;
                    });
                    // Cache in course doc for future 1-read access
                    try {
                        await updateDoc(doc(db, 'unicourses', courseId), {
                            allQuestions, totalTimeLimit, isStrict: anyStrict, isMock: anyMock, isCorrection: !anyNoCorrection
                        });
                    } catch(e) { console.error('Failed to cache allQuestions:', e); }
                }
                
                examState.isStrict      = anyStrict || anyMock;
                examState.isMock        = anyMock;
                examState._isCorrection = !anyNoCorrection;
            } else {
                const d = await sync.doc('unicourses/' + courseId + '/topics/' + topicId);
                if (!d) throw new Error(`Topic '${topicId}' not found.`);
                allQuestions            = d.questions || [];
                totalTimeLimit          = d.timeLimit || 40;
                examState.isStrict      = !!(d.isStrict || d.isMock);
                examState.isMock        = !!d.isMock;
                examState._isCorrection = d.isCorrection !== false;
                if (!rawTitle) subjectTitle = d.title || topicId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            }

            if (allQuestions.length === 0) throw new Error('No questions available for this topic yet.');

            const selected = [...allQuestions].sort(() => 0.5 - Math.random()).slice(0, Math.min(40, allQuestions.length));
            examState.subjects = [{
                id: 0, title: subjectTitle,
                isCorrection: examState._isCorrection,
                questions: selected,
                userAnswers: new Array(selected.length).fill(null),
                currentQIdx: 0
            }];
            examState.timeLimit = (totalTimeLimit > 0 ? totalTimeLimit : 40) * 60;

            if (examState.isStrict) {
                examState.mode = 'exam';
                const timerEl = document.getElementById('rule-timer');
                if (timerEl) timerEl.style.display = 'block';
                switchView('warning');
            } else {
                const timerEl = document.getElementById('rule-timer');
                if (timerEl) timerEl.style.display = 'none';
                switchView('config');
            }

        } catch (e) { showLoadError(e); }
    }

    function showLoadError(err) {
        console.error(err);
        switchView('loading');
        safeHTML('loading-view', `
            <div style="text-align:center;padding:60px 24px;">
                <span class="material-icons-round" style="font-size:3rem;color:var(--brand);margin-bottom:16px;display:block;">error_outline</span>
                <div style="font-weight:900;font-size:1.1rem;margin-bottom:8px;color:var(--text);">Failed to load quiz</div>
                <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:24px;">${err.message}</div>
                <button class="btn btn-primary" onclick="history.back()">Go Back</button>
            </div>`);
    }

    // Legacy JSON builder — kept for backward compatibility
    function buildExamStateFromJSON(dataSets, urlTitles) {
        let isAnyStrict = false, isAnyMock = false;
        let totalTime = 0;

        dataSets.forEach((data, index) => {
            if (data.isStrict) isAnyStrict = true;
            if (data.isMock)   isAnyMock   = true;

            const maxQ            = data.numberOfQuestions || 40;
            const allowCorrection = data.isCorrection !== false;
            const title           = urlTitles[index] || data.title || `Subject ${index + 1}`;
            totalTime += (data.timeLimit || 40) * 60;

            let shuffled   = [...data.questions].sort(() => 0.5 - Math.random());
            let selectedQs = shuffled.slice(0, Math.min(maxQ, data.questions.length));

            examState.subjects.push({
                id: index, title,
                isCorrection: allowCorrection,
                questions: selectedQs,
                userAnswers: new Array(selectedQs.length).fill(null),
                currentQIdx: 0
            });
        });

        examState.isStrict  = isAnyStrict || isAnyMock;
        examState.isMock    = isAnyMock;
        examState.timeLimit = totalTime;

        if (examState.isStrict) {
            examState.mode = 'exam';
            const timerEl = document.getElementById('rule-timer');
            if (timerEl) timerEl.style.display = 'block';
            switchView('warning');
        } else {
            const timerEl = document.getElementById('rule-timer');
            if (timerEl) timerEl.style.display = 'none';
            switchView('config');
        }
    }

    document.getElementById('btn-to-warning').addEventListener('click', () => {
        const mode = document.querySelector('input[name="quiz-mode"]:checked').value;
        examState.mode = mode;
        const timerEl = document.getElementById('rule-timer');
        if (timerEl) timerEl.style.display = mode === 'exam' ? 'block' : 'none';
        switchView('warning');
    });

    // --- 4. EXAM ENGINE BOOTSTRAP ---
    document.getElementById('btn-start-quiz').addEventListener('click', async () => {
        try {
            const docEl = document.documentElement;
            if (docEl.requestFullscreen) await docEl.requestFullscreen();
            else if (docEl.webkitRequestFullscreen) await docEl.webkitRequestFullscreen();
            setTimeout(beginActiveQuiz, 500);
        } catch (err) {
            console.warn("Fullscreen blocked.");
        }

        // ── Anti-cheat measures ──
        document.addEventListener('contextmenu', (e) => e.preventDefault());
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && ['c', 'v', 'u', 's', 'p', 'i'].includes(e.key.toLowerCase())) {
                e.preventDefault();
                return false;
            }
            if (e.key === 'F12') {
                e.preventDefault();
                return false;
            }
        });
        document.addEventListener('copy', (e) => e.preventDefault());
        document.addEventListener('cut', (e) => e.preventDefault());
        document.addEventListener('paste', (e) => e.preventDefault());
        document.addEventListener('selectstart', (e) => e.preventDefault());
    });

    function beginActiveQuiz() {
        examState.isQuizActive = true;

        // ── Periodic anti-cheat check ──
        const antiCheatInterval = setInterval(() => {
            if (!examState.isQuizActive || examState.isReviewMode) {
                clearInterval(antiCheatInterval);
                return;
            }
            // Re-apply prevention handlers in case they were overridden
            document.addEventListener('contextmenu', (e) => e.preventDefault(), { once: false });
            document.addEventListener('copy', (e) => e.preventDefault(), { once: false });
            document.addEventListener('paste', (e) => e.preventDefault(), { once: false });
        }, 5000);

        examState.startTime = Date.now();

        document.addEventListener('fullscreenchange', handleSecurityViolation);
        document.addEventListener('webkitfullscreenchange', handleSecurityViolation);
        document.addEventListener('visibilitychange', handleSecurityViolation);
        window.addEventListener('blur', handleSecurityViolation);

        if (examState.mode === 'exam') {
            timeRemaining = examState.timeLimit;
            updateTimerDisplay();
            timerInterval = setInterval(timerTick, 1000);
        } else {
            timerDisplay.style.display = 'none';
        }

        const modeBadge = document.getElementById('mode-badge');
        if (modeBadge) {
            modeBadge.textContent = examState.mode === 'exam' ? 'Exam Mode' : 'Practice Mode';
            if (examState.mode === 'practice') {
                modeBadge.style.background = 'rgba(22, 163, 74, 0.08)';
                modeBadge.style.color = '#16a34a';
                modeBadge.style.border = '1.5px solid #16a34a';
            } else {
                modeBadge.style.background = '';
                modeBadge.style.color = '';
                modeBadge.style.border = '';
            }
        }

        buildSubjectTabs();
        loadSubject(0);
        switchView('quiz');
    }

    // --- 5. UI RENDERING & NAVIGATION ---
    function buildSubjectTabs() {
        subjectTabsContainer.innerHTML = '';
        examState.subjects.forEach((subj, idx) => {
            const tab = document.createElement('div');
            tab.className = `subject-tab ${idx === examState.currentSubjectIdx ? 'active' : ''}`;
            tab.textContent = subj.title;
            tab.addEventListener('click', () => loadSubject(idx));
            subjectTabsContainer.appendChild(tab);
        });
    }
    window.buildSubjectTabs = buildSubjectTabs;

    function loadSubject(subjectIndex) {
        examState.currentSubjectIdx = subjectIndex;
        Array.from(subjectTabsContainer.children).forEach((tab, idx) => {
            tab.classList.toggle('active', idx === subjectIndex);
        });
        const subject = examState.subjects[subjectIndex];
        mapSubjectTitle.textContent = subject.title;
        buildQuestionMap();
        renderQuestion(subject.currentQIdx);
    }
    window.loadSubject = loadSubject;

    function buildQuestionMap() {
        questionMapContainer.innerHTML = '';
        const subject = examState.subjects[examState.currentSubjectIdx];

        subject.questions.forEach((_, idx) => {
            const btn = document.createElement('button');
            btn.className = 'map-btn';
            btn.textContent = idx + 1;

            if (subject.userAnswers[idx] !== null) btn.classList.add('answered');
            if (idx === subject.currentQIdx) btn.classList.add('current');

            if (examState.isReviewMode) {
                const isCorrect = subject.userAnswers[idx] === subject.questions[idx].correctIndex;
                if (isCorrect) {
                    btn.style.borderColor = 'var(--success)';
                    btn.style.color = 'var(--success)';
                } else {
                    btn.style.borderColor = 'var(--brand)';
                    btn.style.color = 'var(--brand)';
                }
            }

            btn.addEventListener('click', () => {
                renderQuestion(idx);
                if (window.innerWidth <= 900) closeMobileMap();
            });
            questionMapContainer.appendChild(btn);
        });
    }

    function updateMapHighlight() {
        const subject = examState.subjects[examState.currentSubjectIdx];
        Array.from(questionMapContainer.children).forEach((btn, idx) => {
            btn.classList.toggle('current', idx === subject.currentQIdx);
            if (!examState.isReviewMode) {
                btn.classList.toggle('answered', subject.userAnswers[idx] !== null);
            }
        });
    }

    function renderQuestion(qIndex) {
        const subject = examState.subjects[examState.currentSubjectIdx];
        subject.currentQIdx = qIndex;
        const q = subject.questions[qIndex];

        progressText.textContent = `Question ${qIndex + 1} of ${subject.questions.length}`;
        progressBar.style.width = `${((qIndex + 1) / subject.questions.length) * 100}%`;
        qText.innerHTML = q.question;
        optionsContainer.innerHTML = '';
        explBox.classList.add('hidden');
        updateMapHighlight();

        const letters = ['A', 'B', 'C', 'D', 'E', 'F'];

        q.options.forEach((optText, optIndex) => {
            const btn = document.createElement('button');
            btn.className = 'option-btn';
            const letter = letters[optIndex] || '';

            btn.innerHTML = `
                <div style="display:flex; align-items:flex-start;">
                    <strong style="margin-right:12px; color:var(--brand);">${letter}.</strong>
                    <span>${optText}</span>
                </div>
                <span class="material-icons-round indicator"></span>
            `;

            const hasAnswered = subject.userAnswers[qIndex] !== null;
            const isUserChoice = subject.userAnswers[qIndex] === optIndex;
            const isActuallyCorrect = q.correctIndex === optIndex;

            const indicator = btn.querySelector('.indicator');

            if (examState.isReviewMode) {
                btn.disabled = true;
                if (isActuallyCorrect) {
                    btn.classList.add('correct');
                    indicator.textContent = 'check_circle';
                } else if (isUserChoice) {
                    btn.classList.add('wrong');
                    indicator.textContent = 'cancel';
                } else {
                    indicator.textContent = 'radio_button_unchecked';
                }
            } else if (examState.mode === 'practice' && hasAnswered) {
                btn.disabled = true;
                if (isActuallyCorrect) {
                    btn.classList.add('correct');
                    indicator.textContent = 'check_circle';
                } else if (isUserChoice) {
                    btn.classList.add('wrong');
                    indicator.textContent = 'cancel';
                } else {
                    indicator.textContent = 'radio_button_unchecked';
                }
            } else {
                if (isUserChoice) {
                    btn.classList.add('selected');
                    indicator.textContent = 'radio_button_checked';
                } else {
                    indicator.textContent = 'radio_button_unchecked';
                }
                btn.addEventListener('click', () => selectOption(optIndex));
            }

            optionsContainer.appendChild(btn);
        });

        if (examState.isReviewMode || (examState.mode === 'practice' && subject.userAnswers[qIndex] !== null)) {
            explText.innerHTML = q.explanation || "No explanation provided.";
            explBox.classList.remove('hidden');
        }

        btnPrev.disabled = qIndex === 0 && examState.currentSubjectIdx === 0;

        const isLastSubject = examState.currentSubjectIdx === examState.subjects.length - 1;
        const isLastQuestion = qIndex === subject.questions.length - 1;

        if (examState.isReviewMode) {
            btnNext.textContent = (isLastSubject && isLastQuestion) ? 'Finish Review' : 'Next';
            btnNext.className = 'btn btn-primary';
        } else {
            if (isLastSubject && isLastQuestion) {
                btnNext.textContent = 'Submit Exam';
                btnNext.classList.replace('btn-primary', 'btn-danger');
            } else {
                btnNext.textContent = 'Next';
                btnNext.classList.replace('btn-danger', 'btn-primary');
            }
        }
    }

    btnSubmitConfirm.addEventListener('click', () => {
        submitModal.classList.remove('active');
        forceSubmit();
    });

    btnSubmitCancel.addEventListener('click', () => {
        submitModal.classList.remove('active');
    });

    submitModal.addEventListener('click', (e) => {
        if (e.target === submitModal) submitModal.classList.remove('active');
    });

    function selectOption(optIndex) {
        if (examState.isReviewMode) return;

        const subject = examState.subjects[examState.currentSubjectIdx];
        subject.userAnswers[subject.currentQIdx] = optIndex;

        if (examState.mode === 'practice') {
            renderQuestion(subject.currentQIdx);
        } else {
            Array.from(optionsContainer.children).forEach((btn, idx) => {
                btn.classList.toggle('selected', idx === optIndex);
                const indicator = btn.querySelector('.indicator');
                if (indicator) indicator.textContent = idx === optIndex ? 'radio_button_checked' : 'radio_button_unchecked';
            });
            updateMapHighlight();
        }
    }

    btnNext.addEventListener('click', () => {
        const subject = examState.subjects[examState.currentSubjectIdx];
        if (subject.currentQIdx < subject.questions.length - 1) {
            renderQuestion(subject.currentQIdx + 1);
        } else if (examState.currentSubjectIdx < examState.subjects.length - 1) {
            loadSubject(examState.currentSubjectIdx + 1);
        } else if (examState.isReviewMode) {
            switchView('results');
        } else {
            openSubmitModal();
        }
    });

    btnPrev.addEventListener('click', () => {
        const subject = examState.subjects[examState.currentSubjectIdx];
        if (subject.currentQIdx > 0) {
            renderQuestion(subject.currentQIdx - 1);
        } else if (examState.currentSubjectIdx > 0) {
            const prevSubj = examState.subjects[examState.currentSubjectIdx - 1];
            loadSubject(examState.currentSubjectIdx - 1);
            renderQuestion(prevSubj.questions.length - 1);
        }
    });

    function openSubmitModal() {
        if (examState.isReviewMode) return;
        submitModal.classList.add('active');
    }
    btnSubmitEarly.addEventListener('click', () => openSubmitModal());

    // --- 6. KEYBOARD NAVIGATION ---
    document.addEventListener('keydown', (e) => {
        if (document.activeElement.tagName === 'INPUT') return;
        const key = e.key.toLowerCase();
        if (examState.isQuizActive && !examState.isReviewMode) {
            const subject = examState.subjects[examState.currentSubjectIdx];
            const q = subject.questions[subject.currentQIdx];
            if (key === 'a' && q.options.length > 0) selectOption(0);
            if (key === 'b' && q.options.length > 1) selectOption(1);
            if (key === 'c' && q.options.length > 2) selectOption(2);
            if (key === 'd' && q.options.length > 3) selectOption(3);
            if (key === 's') openSubmitModal();
        }
        if (examState.isQuizActive || examState.isReviewMode) {
            if (key === 'p' && !btnPrev.disabled) btnPrev.click();
            if (key === 'n' && !btnNext.disabled) btnNext.click();
        }
    });

    // --- 7. MOBILE SWIPE GESTURES ---
    let touchStartX = 0; let touchStartY = 0;
    let touchEndX = 0; let touchEndY = 0;
    if (cbtMain) {
        cbtMain.addEventListener('touchstart', e => {
            touchStartX = e.changedTouches[0].screenX;
            touchStartY = e.changedTouches[0].screenY;
        }, { passive: true });
        cbtMain.addEventListener('touchend', e => {
            touchEndX = e.changedTouches[0].screenX;
            touchEndY = e.changedTouches[0].screenY;
            handleSwipe();
        }, { passive: true });
    }
    function handleSwipe() {
        const xDiff = touchEndX - touchStartX;
        const yDiff = touchEndY - touchStartY;
        if (Math.abs(xDiff) > 60 && Math.abs(xDiff) > Math.abs(yDiff)) {
            if (xDiff < 0 && !btnNext.disabled) btnNext.click();
            else if (xDiff > 0 && !btnPrev.disabled) btnPrev.click();
        }
    }

    // --- 8. EXIT MODAL LOGIC ---
    if (btnExitGlobal && exitModal && btnExitCancel) {
        btnExitGlobal.addEventListener('click', () => exitModal.classList.add('active'));
        btnExitCancel.addEventListener('click', () => exitModal.classList.remove('active'));
    }

    // --- 9. SECURITY & TIMERS ---
    function handleSecurityViolation() {
        if (!examState.isQuizActive || examState.isReviewMode) return;
        // Allow exiting fullscreen only on results/review screens
        if (examState.isReviewMode) return;
        const leftFullscreen = !document.fullscreenElement && !document.webkitFullscreenElement;
        if ((leftFullscreen || document.hidden) && !examState.isReviewMode) forceSubmit();
    }

    function timerTick() {
        if (!examState.isQuizActive || examState.isReviewMode) return;
        timeRemaining--;
        updateTimerDisplay();
        if (timeRemaining <= 60) timerDisplay.classList.add('danger');
        if (timeRemaining <= 0) forceSubmit();
    }

    function updateTimerDisplay() {
        const h = Math.floor(timeRemaining / 3600);
        const m = Math.floor((timeRemaining % 3600) / 60).toString().padStart(2, '0');
        const s = (timeRemaining % 60).toString().padStart(2, '0');
        timerDisplay.textContent = h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
    }

    // --- 10. SUBMISSION & RESULTS & FIREBASE SAVE ---
    function forceSubmit() {
        examState.isQuizActive = false;
        clearInterval(timerInterval);

        if (examState.startTime) {
            examState.timeTaken = Math.round((Date.now() - examState.startTime) / 1000);
        }

        document.removeEventListener('fullscreenchange', handleSecurityViolation);
        document.removeEventListener('webkitfullscreenchange', handleSecurityViolation);
        document.removeEventListener('visibilitychange', handleSecurityViolation);

        // Don't exit fullscreen - stay in exam mode for review

        calculateAndShowResults();
    }

    async function calculateAndShowResults() {
        let globalCorrect = 0;
        let globalTotal = 0;
        let breakdownHTML = '';
        let canReviewAny = false;

        examState.subjects.forEach(subj => {
            let subjCorrect = 0;
            subj.questions.forEach((q, idx) => {
                if (subj.userAnswers[idx] === q.correctIndex) subjCorrect++;
            });
            globalCorrect += subjCorrect;
            globalTotal += subj.questions.length;
            if (subj.isCorrection) canReviewAny = true;

            breakdownHTML += `
                <div class="score-row">
                    <span class="score-subj">${subj.title}</span>
                    <span class="score-num">${subjCorrect} / ${subj.questions.length}</span>
                </div>
            `;
        });

        const perc = Math.round((globalCorrect / globalTotal) * 100);

        if (examState.isMockExam) {
            const resultsCard = document.querySelector('.results-card');
            if (resultsCard) {
                resultsCard.innerHTML = `
                    <span class="material-icons-round result-icon" id="result-icon" style="color: var(--brand); font-size: 64px;">lock</span>
                    <h2 class="card-title" id="result-title" style="margin-top: 16px;">Submitting...</h2>
                    <div id="subject-scores-container" style="margin: 24px 0; text-align: center; border: 2px dashed var(--border); padding: 24px; border-radius: 12px; background: rgba(127, 86, 217, 0.04);">
                        <div style="font-size: 1.5rem; margin-bottom: 12px; color: var(--text);">🔒 Secure Submission</div>
                        <p style="color: var(--text-muted); font-size: 0.9rem; line-height: 1.5;">
                            Your exam responses are being encrypted and submitted securely. Please do not close this window.
                        </p>
                    </div>
                    <div style="display: flex; gap: 12px; flex-wrap: wrap; width: 100%;">
                        <button class="btn btn-primary btn-block" style="flex: 1;" id="btn-mock-done" disabled>Return to Dashboard</button>
                    </div>
                `;
            }
            switchView('results');

            if (currentUser && examState.mode === 'exam') {
                try {
                    await saveResultsToFirebase(perc, globalCorrect, globalTotal);
                    const titleEl = document.getElementById('result-title');
                    if (titleEl) titleEl.textContent = "Mock Exam Submitted!";
                    const containerEl = document.getElementById('subject-scores-container');
                    if (containerEl) {
                        containerEl.innerHTML = `
                            <div style="font-size: 1.5rem; margin-bottom: 12px; color: var(--text);">🔒 Submitted Successfully</div>
                            <p style="color: var(--text-muted); font-size: 0.9rem; line-height: 1.5;">
                                Your exam responses have been encrypted and submitted securely to the administrator.
                                Results and corrections are currently locked and will be released by your administrator.
                            </p>
                        `;
                    }
                    const btnMockDone = document.getElementById('btn-mock-done');
                    if (btnMockDone) {
                        btnMockDone.removeAttribute('disabled');
                        btnMockDone.onclick = () => {
                            window.location.href = '/app.html';
                        };
                    }
                } catch (e) {
                    console.error("Save failed:", e);
                    const titleEl = document.getElementById('result-title');
                    if (titleEl) titleEl.textContent = "Sync Error. Please contact admin.";
                }
            }
            return;
        }

        // Switch to result view immediately but show loading animation - NO score data visible during sync
        safeHTML('subject-scores-container', `
            <div style="text-align:center;padding:32px;color:var(--text-muted);">
                <div style="display:flex;justify-content:center;gap:8px;margin-bottom:16px;">
                    <div style="width:12px;height:12px;background:var(--brand);border-radius:50%;animation:ef-dot-bounce 0.5s infinite alternate;"></div>
                    <div style="width:12px;height:12px;background:var(--brand);border-radius:50%;animation:ef-dot-bounce 0.5s infinite alternate;animation-delay:0.15s;"></div>
                    <div style="width:12px;height:12px;background:var(--brand);border-radius:50%;animation:ef-dot-bounce 0.5s infinite alternate;animation-delay:0.3s;"></div>
                </div>
                <div style="font-size:0.85rem;font-weight:700;color:var(--text-muted);">Submitting your exam...</div>
                <div style="font-size:0.7rem;font-weight:500;color:var(--text-muted);margin-top:4px;">Please do not close this window.</div>
            </div>
        `);
        const rTitle = document.getElementById('result-title');
        if (rTitle) rTitle.textContent = 'Submitting Exam...';
        const ri = $id('result-icon'); if (ri) ri.textContent = 'sync';
        const ric = $id('result-icon'); if (ric) ric.style.color = 'var(--brand)';
        btnReview.disabled = true; // Disable until save is done
        if (!canReviewAny) btnReview.style.display = 'none';
        
        switchView('results');

        if (currentUser && examState.mode === 'exam') {
            try {
                await saveResultsToFirebase(perc, globalCorrect, globalTotal);
            } catch (e) {
                console.error("Save failed:", e);
                if (rTitle) rTitle.innerHTML = '<span style="color:var(--brand);">⚠️ Sync Error. Please contact admin.</span>';
            }
        }

        // Final UI reveal - elaborate results
        const wrong = globalTotal - globalCorrect;
        const grade = perc >= 80 ? 'A' : perc >= 65 ? 'B' : perc >= 50 ? 'C' : perc >= 40 ? 'D' : 'F';
        const gradeColor = perc >= 80 ? '#16a34a' : perc >= 65 ? '#2563eb' : perc >= 50 ? '#ca8a04' : perc >= 40 ? '#d97706' : '#fe6961';
        const timeSpent = examState.timeTaken ? `${Math.floor(examState.timeTaken/60)}m ${examState.timeTaken%60}s` : '—';
        const quizTitle = examState.subjects?.map(s => s.title).join(', ') || 'Quiz';
        const timeLimitMin = examState.timeLimit ? Math.floor(examState.timeLimit / 60) : '—';
        const modeLabel = examState.mode === 'practice' ? 'Practice' : 'Exam Mode';
        
        if (rTitle) rTitle.innerHTML = `<span style="font-size:2.5rem;font-weight:900;color:${gradeColor};">${perc}%</span>`;
        const ri2 = $id('result-icon'); if (ri2) ri2.textContent = perc >= 80 ? 'emoji_events' : perc >= 50 ? 'check_circle' : 'assignment';
        const ric2 = $id('result-icon'); if (ric2) ric2.style.color = gradeColor;
        // Insert quiz info bar BEFORE the subject-scores-container
        const existingContainer = $id('subject-scores-container');
        if (existingContainer) {
            const infoDiv = document.createElement('div');
            infoDiv.id = 'quiz-info-bar';
            infoDiv.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px;padding:10px 14px;background:var(--bg-inset);border:2px solid var(--border);border-radius:10px;';
            infoDiv.innerHTML = `
                <div style="display:flex;align-items:center;gap:6px;font-size:0.75rem;font-weight:700;color:var(--text);">
                    <span class="material-icons-round" style="font-size:1rem;color:var(--brand);">book</span>
                    ${quizTitle}
                </div>
                <div style="flex:1;"></div>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
                    <span style="display:flex;align-items:center;gap:4px;font-size:0.7rem;font-weight:600;color:var(--text-muted);">
                        <span class="material-icons-round" style="font-size:0.85rem;">timer</span>
                        ${timeLimitMin} min
                    </span>
                    <span style="display:flex;align-items:center;gap:4px;font-size:0.7rem;font-weight:600;color:var(--text-muted);">
                        <span class="material-icons-round" style="font-size:0.85rem;">${examState.mode === 'practice' ? 'edit_note' : 'gavel'}</span>
                        ${modeLabel}
                    </span>
                </div>
            `;
            existingContainer.parentNode.insertBefore(infoDiv, existingContainer);
        }
        
        safeHTML('subject-scores-container', `
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">
                <div style="background:rgba(22,163,74,0.08);border:2px solid #16a34a;border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:1.3rem;font-weight:900;color:#16a34a;">${globalCorrect}</div>
                    <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Correct</div>
                </div>
                <div style="background:rgba(220,38,38,0.06);border:2px solid #dc2626;border-radius:10px;padding:14px;text-align:center;">
                    <div style="font-size:1.3rem;font-weight:900;color:#dc2626;">${wrong}</div>
                    <div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Wrong</div>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
                <div style="background:var(--bg-inset);border:2px solid var(--border);border-radius:10px;padding:12px;text-align:center;">
                    <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px;">Grade</div>
                    <div style="font-size:1.5rem;font-weight:900;color:${gradeColor};">${grade}</div>
                </div>
                <div style="background:var(--bg-inset);border:2px solid var(--border);border-radius:10px;padding:12px;text-align:center;">
                    <div style="font-size:0.6rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:2px;">Time Spent</div>
                    <div style="font-size:1.1rem;font-weight:800;color:var(--text);">${timeSpent}</div>
                </div>
            </div>
            <div style="margin-top:12px;background:var(--bg-inset);border-radius:6px;padding:6px 10px;">
                <div style="display:flex;justify-content:space-between;font-size:0.65rem;font-weight:700;color:var(--text-muted);margin-bottom:4px;">
                    <span>Performance</span>
                    <span>${perc}%</span>
                </div>
                <div style="height:8px;background:var(--bg);border-radius:4px;overflow:hidden;border:1px solid var(--border);">
                    <div style="height:100%;width:${perc}%;background:${gradeColor};border-radius:4px;transition:width 1s ease;"></div>
                </div>
            </div>
        `);
        btnReview.disabled = false;
    }

    function computeExaChange(scorePercent, timeTaken, timeLimit) {
        const accuracyFactor = (scorePercent / 100) * 2 - 1; 
        let speedFactor = 0;
        if (timeLimit > 0 && timeTaken > 0) {
            const fraction = Math.max(0, Math.min(1, (timeLimit - timeTaken) / timeLimit));
            speedFactor = fraction * 0.5; 
        }
        const rawChange = (accuracyFactor * 30) + (speedFactor * 10);
        
        // Add +40 to all increments, -20 to all decrements, 0 stays 0
        let adjusted;
        if (rawChange > 0) {
            adjusted = rawChange + 40;
        } else if (rawChange < 0) {
            adjusted = rawChange - 20;
        } else {
            adjusted = 0;
        }
        
        return Math.round(adjusted);
    }

    function computeNewStreak(existingData) {
        const todayStr = new Date().toISOString().split('T')[0]; 
        const lastDate = existingData.lastExamDate || null;
        if (!lastDate) return { streak: 1, highestStreak: 1, lastExamDate: todayStr };
        if (lastDate === todayStr) return { streak: existingData.streak || 1, highestStreak: existingData.highestStreak || 1, lastExamDate: todayStr };

        const lastDateObj = new Date(lastDate);
        lastDateObj.setHours(12, 0, 0, 0); 
        const todayObj = new Date(todayStr);
        todayObj.setHours(12, 0, 0, 0);

        const diffMs = todayObj - lastDateObj;
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

        let newStreak = (diffDays === 1) ? (existingData.streak || 0) + 1 : 1;
        const newHighest = Math.max(newStreak, existingData.highestStreak || 0);
        return { streak: newStreak, highestStreak: newHighest, lastExamDate: todayStr };
    }

    async function saveResultsToFirebase(finalScore, correct, total) {
        // --- NAVIGATION GUARD START ---
        const handleNavWarning = (e) => {
            e.preventDefault();
            e.returnValue = ''; 
        };
        window.addEventListener('beforeunload', handleNavWarning);

        try {
            let grade = finalScore >= 80 ? 'A' : finalScore >= 65 ? 'B' : finalScore >= 50 ? 'C' : finalScore >= 40 ? 'D' : 'F';
            const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
            let courseTitle = examState.subjects.map(s => s.title).join(', ');
            if (courseTitle.length > 35) courseTitle = courseTitle.substring(0, 32) + '...';

            const corrections = [];
            examState.subjects.forEach(subj => {
                subj.questions.forEach((q, idx) => {
                    if (subj.userAnswers[idx] !== q.correctIndex) {
                        corrections.push({
                            question: q.question,
                            yourAnswer: subj.userAnswers[idx] !== null ? q.options[subj.userAnswers[idx]] : 'Not answered',
                            correctAnswer: q.options[q.correctIndex],
                            explanation: q.explanation || ''
                        });
                    }
                });
            });

            const userRef = doc(db, "users", currentUser.uid);
            const userData = await sync.doc('users/' + currentUser.uid);
            const existingData = userData || {};

            // Retake detection from completedBy array (already checked during load)
            const isRetake = examState.isRetake === true;

            let exaChange = computeExaChange(finalScore, examState.timeTaken, examState.timeLimit);
            if (isRetake && exaChange > 5) exaChange = 5;

            const oldExa = existingData.exaRating || 800;
            const newExa = Math.max(400, oldExa + exaChange); 
            const streakUpdate = computeNewStreak(existingData);

            if (examState.isMockExam) {
                const detailedAnswers = [];
                examState.subjects.forEach(subj => {
                    subj.questions.forEach((q, idx) => {
                        detailedAnswers.push({
                            question: q.question,
                            selectedAnswer: subj.userAnswers[idx] !== null ? q.options[subj.userAnswers[idx]] : 'Not answered',
                            selectedIndex: subj.userAnswers[idx] !== null ? subj.userAnswers[idx] : -1,
                            correctAnswer: q.options[q.correctIndex],
                            correctIndex: q.correctIndex,
                            isCorrect: subj.userAnswers[idx] === q.correctIndex
                        });
                    });
                });

                const devicePlatform = navigator.platform || 'Unknown';
                const browserAgent = navigator.userAgent || 'Unknown';
                const screenResolution = `${window.screen.width}x${window.screen.height}`;

                await setDoc(doc(db, "mock_exams", examState.quizId, "attempts", currentUser.uid), {
                    uid: currentUser.uid,
                    displayName: currentUser.displayName || existingData.displayName || currentUser.email || 'Anonymous',
                    email: currentUser.email || 'No email',
                    score: finalScore,
                    correct: correct,
                    totalQuestions: total,
                    timeTaken: examState.timeTaken,
                    browserAgent: browserAgent,
                    platform: devicePlatform,
                    screenResolution: screenResolution,
                    answers: detailedAnswers,
                    timestamp: serverTimestamp()
                });

                // ── Clean up notification & schedule after mock submission ──
                try {
                    const { deleteDoc, doc: fDoc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
                    
                    // Delete notifications for this mock
                    const notifications = (await sync.query('users/' + currentUser.uid + '/notifications', [where('actionPath', '==', `/quiz.html?mockid=${examState.quizId}`)])) || [];
                    const delPromises = notifications.map(d => deleteDoc(fDoc(db, 'users', currentUser.uid, 'notifications', d.id)));
                    
                    // Delete schedule items for this mock
                    const scheduleItems = (await sync.query('users/' + currentUser.uid + '/schedule', [where('mockId', '==', examState.quizId)])) || [];
                    scheduleItems.forEach(d => delPromises.push(deleteDoc(fDoc(db, 'users', currentUser.uid, 'schedule', d.id))));
                    
                    await Promise.all(delPromises);
                } catch (cleanupErr) {
                    console.error("Mock cleanup error:", cleanupErr);
                }
                // ── End cleanup ──

                // ── Save result + user update in ONE write (embedded in user doc) ──
                const mockResult = {
                    id: Date.now().toString(36),
                    quizId: examState.quizId,
                    course: examState.subjects?.map(s => s.title).join(', ') || 'Mock Exam',
                    date: new Date().toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }),
                    score: finalScore,
                    total: 100,
                    grade: finalScore >= 80 ? 'A' : finalScore >= 65 ? 'B' : finalScore >= 50 ? 'C' : finalScore >= 40 ? 'D' : 'F',
                    correct: correct,
                    totalQuestions: total,
                    timeTaken: examState.timeTaken,
                    isMock: true,
                };
                const existingRes = existingData.recentResults || [];
                const recentResults = [mockResult, ...existingRes].slice(0, 50);
                const updatePayload = {
                    streak: streakUpdate.streak,
                    highestStreak: streakUpdate.highestStreak,
                    lastExamDate: streakUpdate.lastExamDate,
                };
                await setDoc(userRef, { ...updatePayload, rank: "Unranked" }, { merge: true });

            } else {
                // Build new result object (embedded in user doc — no separate results collection write)
                const newResult = {
                    id: Date.now().toString(36),
                    quizId: examState.quizId,
                    course: courseTitle,
                    date: dateStr,
                    score: finalScore,
                    total: 100,
                    grade: grade,
                    correct: correct,
                    totalQuestions: total,
                    timeTaken: examState.timeTaken,
                    exaChange: exaChange,
                    isRetake: isRetake,
                    corrections: corrections,
                };

                if (examState.quizId && examState.quizId.startsWith('dq_')) {
                    // Embed attempt directly in quiz doc — no subcollection reads needed
                    try {
                        await updateDoc(doc(db, 'daily_quizzes', examState.quizId), {
                            completedBy: arrayUnion(currentUser.uid),
                            attempts: arrayUnion({
                                uid: currentUser.uid,
                                displayName: currentUser.displayName || existingData.displayName || currentUser.email || 'Anonymous',
                                email: currentUser.email || 'No email',
                                score: finalScore,
                                correct: correct,
                                totalQuestions: total,
                                timeTaken: examState.timeTaken,
                                timestamp: new Date().toISOString()
                            })
                        });
                    } catch(e) { console.error('DQ attempt save FAILED:', e); }
                    
                    // Save to localStorage for browser-based retake detection
                    try {
                        const storageKey = 'examforge_dq_' + examState.quizId;
                        localStorage.setItem(storageKey, JSON.stringify({
                            score: finalScore,
                            correct: correct,
                            totalQuestions: total,
                            timeTaken: examState.timeTaken,
                            title: 'Daily Quiz'
                        }));
                    } catch(e) {}
                }

                // Get existing recent results, prepend new one, keep max 50
                const existingRes = existingData.recentResults || [];
                const recentResults = [newResult, ...existingRes].slice(0, 50);
                const updatePayload = {
                    streak: streakUpdate.streak,
                    highestStreak: streakUpdate.highestStreak,
                    lastExamDate: streakUpdate.lastExamDate,
                    exaRating: newExa,
                    recentResults: recentResults,
                };
                await setDoc(userRef, { ...updatePayload, rank: "Unranked" }, { merge: true });

                // Store latest EXA for instant dashboard update on next app load
                try { localStorage.setItem('ef_last_exa', JSON.stringify({ exaRating: newExa, timestamp: Date.now() })); } catch(e) {}
            }

            if (!examState.isMockExam) {
                const rTitle = document.getElementById('result-title');
                if (rTitle) {
                    const exaLabel = document.createElement('div');
                    exaLabel.style.cssText = 'font-size:0.75rem; color:var(--text-muted); margin-top:8px; display:flex; align-items:center; justify-content:center; gap:6px;';
                    const arrow = exaChange >= 0 ? '▲' : '▼';
                    const color = exaChange >= 0 ? '#16a34a' : 'var(--brand)';
                    const retakeTag = isRetake ? '<span style="color:orange; font-weight:bold;">[RETAKE]</span>' : '';
                    exaLabel.innerHTML = `${retakeTag} <span style="font-size:0.72rem;">EXA Rating:</span><strong style="color:${color}; font-family:monospace;">${arrow} ${Math.abs(exaChange)} pts → ${newExa}</strong>`;
                    rTitle.parentNode.insertBefore(exaLabel, rTitle.nextSibling);
                }
            }

        } finally {
            // --- NAVIGATION GUARD END ---
            window.removeEventListener('beforeunload', handleNavWarning);
        }
    }

    // --- 11. REVIEW MODE ---
    btnReview.addEventListener('click', () => {
        examState.isReviewMode = true;
        examState.subjects = examState.subjects.filter(s => s.isCorrection);
        if (examState.subjects.length === 0) return;
        safeDisplay('timer-display', 'none');
        safeDisplay('btn-submit-early', 'none');
        safeText('q-progress', 'Review Mode');
        // Close the sidebar/map drawer if open
        const sidebar = document.querySelector('.cbt-sidebar');
        const overlay = document.querySelector('.sidebar-overlay');
        if (sidebar) sidebar.classList.remove('mobile-open');
        if (overlay) overlay.classList.remove('active');
        // Reset to first subject, first question
        examState.currentSubjectIdx = 0;
        buildSubjectTabs();
        loadSubject(0);
        switchView('quiz');
    });

    if (btnMapToggle && sidebarOverlay) {
        btnMapToggle.addEventListener('click', () => {
            cbtSidebar.classList.add('mobile-open');
            sidebarOverlay.classList.add('active');
        });
        sidebarOverlay.addEventListener('click', closeMobileMap);
    }

    function closeMobileMap() {
        cbtSidebar.classList.remove('mobile-open');
        sidebarOverlay.classList.remove('active');
    }

    // --- 12. SCIENTIFIC CALCULATOR LOGIC ---
    const calcModal = document.getElementById('calc-modal');
    const calcInput = document.getElementById('calc-input');
    const calcResult = document.getElementById('calc-result');
    const btnCalcToggle = document.getElementById('btn-calc-toggle');
    const btnCalcClose = document.getElementById('btn-calc-close');

    if (calcModal && calcInput && btnCalcToggle) {
        btnCalcToggle.addEventListener('click', () => {
            calcModal.classList.add('active');
            setTimeout(() => calcInput.focus(), 100);
        });
        btnCalcClose.addEventListener('click', () => calcModal.classList.remove('active'));
        calcInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') evaluateCalc(); });
        calcInput.addEventListener('input', () => tryEvaluate());
        document.querySelectorAll('.calc-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const val = e.target.getAttribute('data-val');
                if (val === 'C') { calcInput.value = ''; calcResult.textContent = '= 0'; }
                else if (val === 'DEL') { calcInput.value = calcInput.value.slice(0, -1); tryEvaluate(); }
                else if (val === '=') { evaluateCalc(); }
                else {
                    const start = calcInput.selectionStart, end = calcInput.selectionEnd;
                    calcInput.value = calcInput.value.slice(0, start) + val + calcInput.value.slice(end);
                    calcInput.selectionStart = calcInput.selectionEnd = start + val.length;
                    calcInput.focus(); tryEvaluate();
                }
            });
        });
        function tryEvaluate() {
            const expr = calcInput.value;
            if (!expr.trim()) { calcResult.textContent = '= 0'; return; }
            const parsed = parseMathExpression(expr);
            if (parsed !== null) calcResult.textContent = '= ' + parsed;
        }
        function evaluateCalc() {
            const expr = calcInput.value;
            if (!expr.trim()) return;
            const parsed = parseMathExpression(expr);
            if (parsed !== null) { calcInput.value = parsed; calcResult.textContent = ''; }
            else { calcResult.textContent = 'Syntax Error'; }
        }
        function parseMathExpression(expr) {
            try {
                if (/[^0-9\.\+\-\*\/\^\(\)\sEsinco\ta\gqrp]/.test(expr)) return null;
                let safeExpr = expr.replace(/sin\(/g, 'Math.sin(').replace(/cos\(/g, 'Math.cos(').replace(/tan\(/g, 'Math.tan(').replace(/log\(/g, 'Math.log10(').replace(/ln\(/g, 'Math.log(').replace(/sqrt\(/g, 'Math.sqrt(').replace(/pi/g, 'Math.PI').replace(/\^/g, '**');
                if (/[\+\-\*\/\^]$/.test(safeExpr.trim())) return null;
                const result = new Function('return ' + safeExpr)();
                return (typeof result === 'number' && !isNaN(result)) ? parseFloat(result.toFixed(5)).toString() : null;
            } catch { return null; }
        }
    }

    // --- 13. THEME TOGGLE LOGIC ---
    const themeCheckboxes = document.querySelectorAll('.theme-toggle-checkbox');
    function setTheme(themeName) {
        document.documentElement.setAttribute('data-theme', themeName);
        localStorage.setItem('examforge-theme', themeName);
        const isDark = themeName === 'dark';
        themeCheckboxes.forEach(cb => { if (cb.checked !== isDark) cb.checked = isDark; });
    }
    const initialTheme = document.documentElement.getAttribute('data-theme') || localStorage.getItem('examforge-theme') || 'light';
    setTheme(initialTheme);
    themeCheckboxes.forEach(cb => {
        cb.addEventListener('change', (e) => setTheme(e.target.checked ? 'dark' : 'light'));
    });

    function switchView(viewName) {
        Object.values(views).forEach(v => v.classList.remove('active'));
        views[viewName].classList.add('active');
    }
    window.switchView = switchView;

    init();
});