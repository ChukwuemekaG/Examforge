// Examforge Quiz Engine — Entry Point

import { auth } from '../firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { initSchema } from './db/schema.js';
import { execute } from './db/client.js';
import * as users from './db/users.js';
import * as mocks from './db/mocks.js';
import * as events from './db/events.js';
import * as quizzes from './db/quizzes.js';
import { initQuiz, examState } from './quiz/init.js';
import { startTimer, stopTimer, formatTime, goToQuestion, answerQuestion, calculateResults, shuffleQuestions } from './quiz/engine.js';
import { showResults, calculateExaChange } from './quiz/results.js';
import { gradeFromScore } from './utils/constants.js';

let currentUser = null;

// ─── Auth ───

onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.href = '/login.html'; return; }
  currentUser = user;

  // Init schema
  try { await initSchema({ execute }); } catch (e) { /* ignore */ }

  // Initialize quiz
  try {
    await initQuiz();
    renderQuizUI();
  } catch (e) {
    document.getElementById('quiz-container').innerHTML = '<div style="text-align:center;padding:80px 20px;color:#dc2626;"><div style="font-size:2rem;margin-bottom:16px;">⚠️</div><div style="font-size:1.2rem;font-weight:700;margin-bottom:8px;">Failed to load quiz</div><div style="color:var(--text-muted);margin-bottom:24px;">' + e.message + '</div><button class="btn btn-primary" onclick="window.location.href=\'/app.html\'">Return to Dashboard</button></div>';
  }
});

// ─── UI Rendering ───

function renderQuizUI() {
  const container = document.getElementById('quiz-container');
  if (!container) return;

  const total = examState.questions.length;
  if (total === 0) {
    container.innerHTML = '<div style="text-align:center;padding:80px 20px;"><div style="font-size:1.2rem;font-weight:700;">No questions available</div></div>';
    return;
  }

  // Build subject tabs if multi-topic
  let tabsHtml = '';
  if (examState.subjectTabs.length > 1) {
    tabsHtml = '<div style="display:flex;gap:6px;overflow-x:auto;padding:8px 16px;">' +
      examState.subjectTabs.map(t => '<button class="btn btn-sm ' + (t.active ? 'btn-primary' : 'btn-outline') + '">' + t.label + ' (' + t.count + ')</button>').join('') +
      '</div>';
  }

  container.innerHTML = `
  <div style="max-width:800px;margin:0 auto;padding:16px;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
      <div style="font-weight:800;font-size:1.1rem;">${examState.title || 'Quiz'}</div>
      <div style="font-family:monospace;font-size:1.3rem;font-weight:700;" id="quiz-timer">${formatTime(examState.timeRemaining)}</div>
    </div>
    ${tabsHtml}
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:16px;" id="question-palette">
      ${examState.questions.map((_, i) => '<div id="qp-' + i + '" style="width:32px;height:32px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:0.7rem;font-weight:700;cursor:pointer;background:var(--bg-inset);border:1px solid var(--border);" onclick="window._goToQuestion(' + i + ')">' + (i + 1) + '</div>').join('')}
    </div>
    <div id="question-area" style="min-height:300px;"></div>
    <div style="display:flex;justify-content:space-between;margin-top:20px;">
      <button class="btn btn-outline" id="btn-prev" onclick="window._prevQuestion()">Previous</button>
      <button class="btn btn-primary" id="btn-next" onclick="window._nextQuestion()">Next</button>
    </div>
    <button class="btn btn-primary" style="width:100%;margin-top:16px;" onclick="window._submitQuiz()">Submit Exam</button>
  </div>`;

  renderQuestion(0);

  // Start timer
  if (examState.timeRemaining > 0) {
    startTimer(
      (remaining) => { document.getElementById('quiz-timer').textContent = formatTime(remaining); },
      () => { alert('Time is up!'); window._submitQuiz(); }
    );
  }
}

function renderQuestion(index) {
  const q = examState.questions[index];
  if (!q) return;

  const area = document.getElementById('question-area');
  if (!area) return;

  examState.currentIndex = index;

  // Update palette highlighting
  examState.questions.forEach((_, i) => {
    const el = document.getElementById('qp-' + i);
    if (!el) return;
    const isAnswered = examState.answers[i] !== null;
    const isCurrent = i === index;
    el.style.background = isCurrent ? 'var(--brand)' : (isAnswered ? '#16a34a' : 'var(--bg-inset)');
    el.style.color = (isCurrent || isAnswered) ? '#fff' : 'inherit';
  });

  const selected = examState.answers[index];

  area.innerHTML = `
  <div class="card" style="padding:20px;">
    <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:8px;">Question ${index + 1} of ${examState.questions.length}</div>
    <div style="font-weight:600;font-size:1rem;margin-bottom:20px;line-height:1.5;">${q.question}</div>
    ${q.options.map((opt, oi) => '<div style="padding:12px 16px;margin-bottom:8px;border-radius:10px;cursor:pointer;font-weight:600;font-size:0.9rem;background:' + (selected === oi ? 'var(--brand)' : 'var(--bg-inset)') + ';color:' + (selected === oi ? '#fff' : 'inherit') + ';border:2px solid ' + (selected === oi ? 'var(--brand)' : 'var(--border)') + ';" onclick="window._answer(' + oi + ')">' + String.fromCharCode(65 + oi) + '. ' + opt + '</div>').join('')}
  </div>`;
}

// ─── Navigation ───

window._goToQuestion = function(idx) { renderQuestion(idx); };
window._prevQuestion = function() { if (examState.currentIndex > 0) renderQuestion(examState.currentIndex - 1); };
window._nextQuestion = function() { if (examState.currentIndex < examState.questions.length - 1) renderQuestion(examState.currentIndex + 1); };
window._answer = function(optionIndex) {
  answerQuestion(examState.currentIndex, optionIndex);
  renderQuestion(examState.currentIndex);
};

// ─── Submission ───

window._submitQuiz = async function() {
  const unanswered = examState.answers.filter(a => a === null).length;
  if (unanswered > 0 && !confirm(unanswered + ' question(s) unanswered. Submit anyway?')) return;

  stopTimer();
  const results = calculateResults();
  const grade = gradeFromScore(results.score);

  // Calculate EXA change
  const oldRating = 800; // will come from user profile
  const exaChange = calculateExaChange(oldRating, results.score);
  const newRating = Math.max(0, oldRating + exaChange);

  // Save result
  if (currentUser) {
    try {
      await users.addResult(currentUser.uid, {
        quizId: examState.quizId,
        course: examState.title,
        score: results.score,
        grade: grade.grade,
        correct: results.correct,
        totalQuestions: results.total,
        timeTaken: results.timeTaken,
        exaChange,
        isMock: examState.isMockExam,
        corrections: results.details
      });

      // Update user EXA rating and streak
      const streak = results.score >= 40 ? 1 : 0; // pass threshold
      await users.updateUserData(currentUser.uid, {
        exaRating: newRating,
        streak,
        lastExamDate: new Date().toISOString()
      });

      // If mock exam, save attempt
      if (examState.isMockExam && examState.quizId) {
        await mocks.saveMockAttempt(examState.quizId, {
          uid: currentUser.uid,
          displayName: currentUser.displayName || '',
          email: currentUser.email || '',
          score: results.score,
          correct: results.correct,
          total: results.total,
          timeTaken: results.timeTaken,
          answers: results.details
        });

        // Update event registration score
        try {
          const mockData = await mocks.getMock(examState.quizId);
          if (mockData) {
            const reg = await events.getStudentRegistration(mockData.event_id, currentUser.uid);
            if (reg) {
              await events.updateStudentScore(mockData.event_id, currentUser.uid, {
                score: results.score,
                correct: results.correct,
                totalQuestions: results.total,
                timeTaken: results.timeTaken
              });
            }
          }
        } catch (e) { console.warn('Could not update event score:', e); }
      }

      // If daily quiz, save attempt
      if (examState.isDailyQuiz && examState.quizId) {
        await quizzes.saveQuizAttempt(examState.quizId, currentUser.uid, {
          score: results.score,
          correct: results.correct,
          total: results.total,
          timeTaken: results.timeTaken,
          answers: results.details
        });
      }

    } catch (e) { console.error('Failed to save results:', e); }
  }

  // Show results
  showResults();
};
