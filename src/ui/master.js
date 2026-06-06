// Admin Master Panel — entry point and tab routing

import { getState } from './core.js';
import { renderMasterCourses } from './master-courses.js';
import { renderMasterEvents } from './master-events.js';
import * as courses from '../db/courses.js';
import * as quizzes from '../db/quizzes.js';
import * as advices from '../db/advices.js';
import * as events from '../db/events.js';
import * as counters from '../db/counters.js';
import { showConfirm, showPrompt, showConfirmAsync, showAlert } from '../utils/helpers.js';
import { renderUsersTab } from './master-users.js';

let activeTab = 'courses';

export async function renderMaster() {
  const { workspace } = getState();

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Master Control</div>
    <div class="page-sub">Admin Panel</div>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
    <button class="btn btn-sm ${activeTab === 'courses' ? 'btn-primary' : 'btn-outline'}" data-tab="courses" onclick="window._switchMasterTab('courses')">Courses</button>
    <button class="btn btn-sm ${activeTab === 'dailyquiz' ? 'btn-primary' : 'btn-outline'}" data-tab="dailyquiz" onclick="window._switchMasterTab('dailyquiz')">Daily Quiz</button>
    <button class="btn btn-sm ${activeTab === 'dailyadvice' ? 'btn-primary' : 'btn-outline'}" data-tab="dailyadvice" onclick="window._switchMasterTab('dailyadvice')">Daily Advice</button>
    <button class="btn btn-sm ${activeTab === 'subevents' ? 'btn-primary' : 'btn-outline'}" data-tab="subevents" onclick="window._switchMasterTab('subevents')">Sub Events</button>
    <button class="btn btn-sm ${activeTab === 'users' ? 'btn-primary' : 'btn-outline'}" data-tab="users" onclick="window._switchMasterTab('users')">Users</button>
  </div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
    <button class="btn btn-outline btn-sm" onclick="window._startMigration()" style="font-size:0.65rem;padding:3px 8px;">
      <span class="material-icons-round" style="font-size:0.8rem;vertical-align:middle;">cloud_download</span> Migrate Data
    </button>
    <button class="btn btn-outline btn-sm" onclick="window._syncMyData()" style="font-size:0.65rem;padding:3px 8px;">
      <span class="material-icons-round" style="font-size:0.8rem;vertical-align:middle;">sync</span> Sync My Data
    </button>
  </div>
  <div id="master-tab-content"></div>`;

  await renderActiveTab();
}

window._syncMyData = async function() {
  try {
    const { doc, getDoc } = await import("https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js");
    const { db } = await import("../../firebase-config.js");
    const { getState } = await import('./core.js');
    const user = getState().currentUser;
    if (!user) { showAlert('Not logged in.'); return; }
    
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) { showAlert('No Firestore data found for your account.'); return; }
    
    const u = snap.data();
    const usersModule = await import('../db/users.js');
    
    // Update profile
    await usersModule.updateUserData(user.uid, {
      exaRating: u.exaRating ?? 800,
      displayName: u.displayName || '',
      username: u.username || '',
      streak: u.streak || 0,
      highestStreak: u.highestStreak || 0,
      lastExamDate: u.lastExamDate || null,
      role: u.role || 'student'
    });
    
    // Migrate results
    if (u.recentResults && Array.isArray(u.recentResults)) {
      for (const r of u.recentResults) {
        await usersModule.addResult(user.uid, r);
      }
    }
    
    // Migrate schedule
    if (u.schedule && Array.isArray(u.schedule)) {
      for (const s of u.schedule) {
        await usersModule.addScheduleItem(user.uid, s);
      }
    }
    
    // Migrate inbox
    if (u.inbox && Array.isArray(u.inbox)) {
      for (const item of u.inbox) {
        await usersModule.addInboxItem(user.uid, item);
      }
    }
    
    showAlert('Your data synced! Reload the page to see changes.');
  } catch (e) {
    showAlert('Sync failed: ' + e.message);
    console.error(e);
  }
};

window._switchMasterTab = async function(tab) {
  activeTab = tab;
  // Update all master tab buttons via data-tab attribute
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-outline');
    if (btn.dataset.tab === tab) {
      btn.classList.remove('btn-outline');
      btn.classList.add('btn-primary');
    }
  });
  await renderActiveTab();
};

async function renderActiveTab() {
  const content = document.getElementById('master-tab-content');
  if (!content) return;

  try {
    switch (activeTab) {
      case 'courses':
        await renderMasterCourses(content);
        break;
      case 'dailyquiz':
        await renderDailyQuizTab(content);
        break;
      case 'dailyadvice':
        await renderDailyAdviceTab(content);
        break;
      case 'subevents':
        await renderMasterEvents(content);
        break;
      case 'users':
        await renderUsersTab(content);
        break;
    }
  } catch (e) {
    content.innerHTML = '<div class="card" style="padding:20px;color:#dc2626;">Error loading tab: ' + e.message + '</div>';
    console.error('Master tab error:', e);
  }
}

// ─── Daily Quiz Tab ───

async function renderDailyQuizTab(container) {
  let quizList = [];
  try { quizList = await quizzes.getAllQuizzes(); } catch (e) { console.warn(e); }
  
  // Load question counts for each quiz
  const questionCounts = {};
  for (const q of quizList) {
    try {
      const qs = await quizzes.getQuizQuestions(q.id);
      questionCounts[q.id] = qs.length;
    } catch { questionCounts[q.id] = 0; }
  }

  container.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:800;font-size:1.1rem;">Daily Quizzes (${quizList.length})</div>
    <button class="btn btn-primary btn-sm" onclick="window._createDailyQuiz()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Quiz</button>
  </div>
  ${quizList.length === 0 ? '<div class="empty-state">No quizzes yet</div>'
    : quizList.map(q => {
      const qCount = questionCounts[q.id] || 0;
      return `<div class="card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:700;">${q.title || 'Untitled'}</div>
          <div style="font-size:0.7rem;color:var(--text-muted);display:flex;gap:12px;margin-top:2px;">
            <span>⏱ ${q.time_limit || 0} min</span>
            <span>📝 ${qCount} question${qCount !== 1 ? 's' : ''}</span>
            <span>🔄 ${q.max_attempts || 1} attempt${(q.max_attempts || 1) !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <div style="display:flex;gap:6px;">
          <button class="btn btn-outline btn-sm" onclick="window._viewDailyQuiz('${q.id}')">View</button>
          <button class="btn btn-outline btn-sm" onclick="window._deleteDailyQuiz('${q.id}')">Delete</button>
        </div>
      </div>`;
    }).join('')}
  `;
}

window._viewDailyQuiz = async function(id) {
  try {
    const quiz = await quizzes.getQuiz(id);
    const questions = await quizzes.getQuizQuestions(id);
    
    const overlay = document.createElement('div');
    overlay.id = 'ef-custom-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
    
    const questionsHtml = questions.map((q, i) => `
      <div style="background:var(--bg-inset);border-radius:8px;padding:14px;margin-bottom:8px;border:1px solid var(--border);">
        <div style="font-weight:700;font-size:0.85rem;margin-bottom:6px;">Q${i + 1}: ${q.question}</div>
        <div style="font-size:0.8rem;display:grid;grid-template-columns:1fr 1fr;gap:4px;">
          ${['A','B','C','D'].map((ltr, oi) => `
            <div style="padding:4px 8px;border-radius:4px;${q.correct_index === oi ? 'background:#166534;color:#bbf7d0;' : ''}">
              ${ltr}. ${q['option_' + ltr.toLowerCase()] || ''}
            </div>
          `).join('')}
        </div>
        ${q.explanation ? `<div style="font-size:0.75rem;color:var(--text-muted);margin-top:6px;padding-top:6px;border-top:1px solid var(--border);">💡 ${q.explanation}</div>` : ''}
      </div>
    `).join('');

    overlay.innerHTML = `<div class="card" style="max-width:700px;width:95%;padding:24px;border-radius:16px;max-height:90vh;overflow-y:auto;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
        <div>
          <div style="font-weight:800;font-size:1.2rem;">${quiz.title || 'Untitled'}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);display:flex;gap:16px;margin-top:4px;">
            <span>⏱ ${quiz.time_limit || 0} min</span>
            <span>📝 ${questions.length} question${questions.length !== 1 ? 's' : ''}</span>
            <span>🔄 Max ${quiz.max_attempts || 1} attempt${(quiz.max_attempts || 1) !== 1 ? 's' : ''}</span>
          </div>
        </div>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('ef-custom-modal').remove()" style="padding:4px;">
          <span class="material-icons-round">close</span>
        </button>
      </div>
      ${questions.length === 0 ? '<div class="empty-state">No questions in this quiz</div>' : questionsHtml}
      <div style="margin-top:16px;text-align:right;">
        <button class="btn btn-outline btn-sm" onclick="document.getElementById('ef-custom-modal').remove()">Close</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
  } catch (e) {
    showAlert('Error loading quiz: ' + e.message, 'Error');
  }
};

window._createDailyQuiz = async function() {
  // Open a modal with full quiz creation form
  const overlay = document.createElement('div');
  overlay.id = 'ef-custom-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  overlay.innerHTML = '<div class="card" style="max-width:700px;width:95%;padding:24px;border-radius:16px;max-height:90vh;overflow-y:auto;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><div style="font-weight:800;font-size:1.2rem;">Create Daily Quiz</div><button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'ef-custom-modal\').remove()" style="padding:4px;"><span class="material-icons-round">close</span></button></div>' +
    '<div style="margin-bottom:12px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Quiz Title</label><input id="dq-title" placeholder="Enter quiz title..." style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">' +
    '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Time Limit (minutes)</label><input id="dq-time" type="number" value="10" min="1" max="180" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Max Attempts</label><input id="dq-attempts" type="number" value="1" min="1" max="10" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '</div>' +
    '<div id="dq-questions-area"><div style="text-align:center;padding:20px;color:var(--text-muted);">No questions yet. Add your first question below.</div></div>' +
    '<button class="btn btn-outline btn-sm" onclick="window._addDQQuestion()" style="width:100%;margin-bottom:20px;"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> Add Question</button>' +
    '<div style="display:flex;gap:12px;">' +
    '<button class="btn btn-primary" onclick="window._saveDailyQuiz()" style="flex:1;">Save Quiz</button>' +
    '<button class="btn btn-ghost" onclick="document.getElementById(\'ef-custom-modal\').remove()" style="flex:1;">Cancel</button></div></div>';
  document.body.appendChild(overlay);
};

// Track questions being built
window._dqQuestions = [];

window._addDQQuestion = function() {
  const idx = window._dqQuestions.length;
  window._dqQuestions.push({ question: '', options: ['', '', '', ''], correctIndex: 0, explanation: '' });
  
  const area = document.getElementById('dq-questions-area');
  if (!area) return;
  
  // Remove empty state if present
  if (area.querySelector('[style*="text-align:center"]')) area.innerHTML = '';
  
  const qDiv = document.createElement('div');
  qDiv.id = 'dq-q-' + idx;
  qDiv.style.cssText = 'background:var(--bg-inset);border-radius:8px;padding:16px;margin-bottom:12px;border:1px solid var(--border);';
  qDiv.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;"><span style="font-weight:700;font-size:0.85rem;">Q' + (idx + 1) + '</span><button class="btn btn-ghost btn-sm" onclick="window._removeDQQuestion(' + idx + ')" style="padding:2px 6px;color:#dc2626;">✕</button></div>' +
    '<textarea id="dq-qtext-' + idx + '" placeholder="Enter question..." style="width:100%;padding:10px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;margin-bottom:10px;min-height:60px;resize:vertical;font-family:inherit;"></textarea>' +
    '<div style="margin-bottom:8px;"><label style="font-weight:600;font-size:0.75rem;">Options</label></div>' +
    '<div id="dq-opts-' + idx + '">' +
    [0,1,2,3].map(oi => '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><span style="font-weight:700;font-size:0.8rem;width:20px;">' + String.fromCharCode(65 + oi) + '.</span><input id="dq-opt-' + idx + '-' + oi + '" placeholder="Option ' + String.fromCharCode(65 + oi) + '" style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);font-size:0.8rem;"></div>').join('') +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:8px;margin-top:8px;"><label style="font-weight:600;font-size:0.75rem;">Correct Answer:</label><select id="dq-correct-' + idx + '" style="padding:6px 10px;border-radius:6px;border:1px solid var(--border);font-size:0.8rem;">' +
    [0,1,2,3].map(oi => '<option value="' + oi + '">' + String.fromCharCode(65 + oi) + '</option>').join('') +
    '</select></div>' +
    '<div style="margin-top:8px;"><label style="font-weight:600;font-size:0.75rem;">Explanation</label><input id="dq-expl-' + idx + '" placeholder="Explanation (optional)" style="width:100%;padding:8px 10px;border-radius:6px;border:1px solid var(--border);font-size:0.8rem;margin-top:4px;"></div>';
  
  area.appendChild(qDiv);
  area.scrollTop = area.scrollHeight;
};

window._removeDQQuestion = function(idx) {
  const qDiv = document.getElementById('dq-q-' + idx);
  if (qDiv) qDiv.remove();
  window._dqQuestions[idx] = null;
};

window._saveDailyQuiz = async function() {
  const title = document.getElementById('dq-title')?.value;
  if (!title) { showAlert('Please enter a quiz title.', 'Missing Field'); return; }
  const timeLimit = parseInt(document.getElementById('dq-time')?.value) || 10;
  const maxAttempts = parseInt(document.getElementById('dq-attempts')?.value) || 1;
  
  // Build questions array from DOM
  const questions = [];
  window._dqQuestions.forEach((q, idx) => {
    if (q === null) return;
    const question = document.getElementById('dq-qtext-' + idx)?.value;
    if (!question) return;
    const options = [0,1,2,3].map(oi => document.getElementById('dq-opt-' + idx + '-' + oi)?.value || '');
    const correctIndex = parseInt(document.getElementById('dq-correct-' + idx)?.value) || 0;
    const explanation = document.getElementById('dq-expl-' + idx)?.value || '';
    questions.push({ question, options, correctIndex, explanation });
  });
  
  if (questions.length === 0) { showAlert('Please add at least one question.', 'Missing Questions'); return; }
  
  try {
    const { default: quizzes } = await import('../db/quizzes.js');
    const id = await quizzes.createQuiz({ title, timeLimit, maxAttempts });
    await quizzes.setQuizQuestions(id, questions);
    
    document.getElementById('ef-custom-modal').remove();
    window._dqQuestions = [];
    showAlert('Quiz created with ' + questions.length + ' questions!', 'Success');
    const content = document.getElementById('master-tab-content');
    if (content) await renderDailyQuizTab(content);
  } catch (e) {
    showAlert('Error: ' + e.message, 'Error');
  }
};

window._deleteDailyQuiz = async function(id) {
  if (!await showConfirmAsync('Delete this quiz?')) return;
  try {
    await quizzes.deleteQuiz(id);
    await renderDailyQuizTab(document.getElementById('master-tab-content'));
  } catch (e) {
    showAlert('Error: ' + e.message);
  }
};

// ─── Daily Advice Tab ───

async function renderDailyAdviceTab(container) {
  let adviceList = [];
  try { adviceList = await advices.getAllAdvices(); } catch (e) { console.warn(e); }

  container.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:800;font-size:1.1rem;">Daily Advice (${adviceList.length})</div>
    <button class="btn btn-primary btn-sm" onclick="window._createDailyAdvice()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Advice</button>
  </div>
  ${adviceList.length === 0 ? '<div class="empty-state">No advice yet</div>'
    : adviceList.map(a => `<div class="card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;"><div><div style="font-weight:700;">${a.title || 'Untitled'}</div><div style="font-size:0.7rem;color:var(--text-muted);">${a.category || 'General'}</div></div><button class="btn btn-outline btn-sm" onclick="window._deleteDailyAdvice('${a.id}')">Delete</button></div>`).join('')}
  `;
}

window._createDailyAdvice = async function() {
  const title = await showPrompt('Advice title:');
  if (!title) return;
  const category = await showPrompt('Category:', 'General') || 'General';
  const content = await showPrompt('Content:');
  try {
    await advices.createAdvice({ title, category, content });
    await renderDailyAdviceTab(document.getElementById('master-tab-content'));
  } catch (e) {
    showAlert('Error: ' + e.message);
  }
};

window._deleteDailyAdvice = async function(id) {
  if (!await showConfirmAsync('Delete this advice?')) return;
  try {
    await advices.deleteAdvice(id);
    await renderDailyAdviceTab(document.getElementById('master-tab-content'));
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

// ─── Broadcast / Utility functions ───

window._clearAllNotifications = async function() {
  if (!await showConfirmAsync('Clear all broadcast notifications?')) return;
  try {
    const { default: notifications } = await import('../db/notifications.js');
    await notifications.clearBroadcastNotifications();
    showAlert('Broadcast notifications cleared.');
  } catch (e) {
    showAlert('Failed: ' + e.message);
  }
};

window._clearAllSchedules = async function() {
  if (!await showConfirmAsync('Clear all broadcast schedules?')) return;
  try {
    const { default: schedules } = await import('../db/schedules.js');
    await schedules.clearBroadcastSchedules();
    showAlert('Broadcast schedules cleared.');
  } catch (e) {
    showAlert('Failed: ' + e.message);
  }
};

window._backfillUserCounter = async function() {
  if (!await showConfirmAsync('Count all users and update counter?')) return;
  try {
    const total = await counters.getUserCount();
    await counters.setCounter('totalUsers', total);
    showAlert('Counter backfilled: ' + total + ' users');
  } catch (e) {
    showAlert('Failed: ' + e.message);
  }
};

window.printResult = async function(resultId, eventId) {
  // Load result from DB and print
  try {
    const { default: results } = await import('../db/results.js');
    const { printResultSheet } = await import('../utils/pdf.js');
    // Result fetching will be implemented when results module is complete
    showAlert('Print result: ' + resultId);
  } catch (e) {
    console.error('Print failed:', e);
  }
};

window._startMigration = async function() {
  if (!await showConfirmAsync('This will import all data from Firestore into Turso. Continue?')) return;
  try {
    const { runMigration } = await import('../utils/migrate.js');
    const result = await runMigration((msg) => console.log('[Migration]', msg));
    showAlert('Migration complete!\nItems migrated: ' + result.migrated + '\nErrors: ' + result.errors);
  } catch (e) {
    showAlert('Migration failed: ' + e.message);
    console.error(e);
  }
};
