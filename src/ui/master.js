// Admin Master Panel — entry point and tab routing

import { getState } from './core.js';
import { renderMasterCourses } from './master-courses.js';
import { renderMasterEvents } from './master-events.js';
import * as courses from '../db/courses.js';
import * as quizzes from '../db/quizzes.js';
import * as advices from '../db/advices.js';
import * as events from '../db/events.js';
import * as counters from '../db/counters.js';
import { showConfirm } from '../utils/helpers.js';
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
    if (!user) { alert('Not logged in.'); return; }
    
    const snap = await getDoc(doc(db, 'users', user.uid));
    if (!snap.exists()) { alert('No Firestore data found for your account.'); return; }
    
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
    
    alert('Your data synced! Reload the page to see changes.');
  } catch (e) {
    alert('Sync failed: ' + e.message);
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

  container.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:800;font-size:1.1rem;">Daily Quizzes (${quizList.length})</div>
    <button class="btn btn-primary btn-sm" onclick="window._createDailyQuiz()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Quiz</button>
  </div>
  ${quizList.length === 0 ? '<div class="empty-state">No quizzes yet</div>'
    : quizList.map(q => `<div class="card" style="padding:14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;"><div><div style="font-weight:700;">${q.title || 'Untitled'}</div><div style="font-size:0.7rem;color:var(--text-muted);">${q.time_limit || 0} min</div></div><button class="btn btn-outline btn-sm" onclick="window._deleteDailyQuiz('${q.id}')">Delete</button></div>`).join('')}
  `;
}

window._createDailyQuiz = async function() {
  const title = prompt('Quiz title:');
  if (!title) return;
  const timeLimit = parseInt(prompt('Time limit (minutes):', '10')) || 10;
  try {
    const id = await quizzes.createQuiz({ title, timeLimit });
    alert('Quiz created: ' + id);
    await renderDailyQuizTab(document.getElementById('master-tab-content'));
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

window._deleteDailyQuiz = async function(id) {
  if (!confirm('Delete this quiz?')) return;
  try {
    await quizzes.deleteQuiz(id);
    await renderDailyQuizTab(document.getElementById('master-tab-content'));
  } catch (e) {
    alert('Error: ' + e.message);
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
  const title = prompt('Advice title:');
  if (!title) return;
  const category = prompt('Category:', 'General') || 'General';
  const content = prompt('Content:');
  try {
    await advices.createAdvice({ title, category, content });
    await renderDailyAdviceTab(document.getElementById('master-tab-content'));
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

window._deleteDailyAdvice = async function(id) {
  if (!confirm('Delete this advice?')) return;
  try {
    await advices.deleteAdvice(id);
    await renderDailyAdviceTab(document.getElementById('master-tab-content'));
  } catch (e) {
    alert('Error: ' + e.message);
  }
};

// ─── Broadcast / Utility functions ───

window._clearAllNotifications = async function() {
  if (!confirm('Clear all broadcast notifications?')) return;
  try {
    const { default: notifications } = await import('../db/notifications.js');
    await notifications.clearBroadcastNotifications();
    alert('Broadcast notifications cleared.');
  } catch (e) {
    alert('Failed: ' + e.message);
  }
};

window._clearAllSchedules = async function() {
  if (!confirm('Clear all broadcast schedules?')) return;
  try {
    const { default: schedules } = await import('../db/schedules.js');
    await schedules.clearBroadcastSchedules();
    alert('Broadcast schedules cleared.');
  } catch (e) {
    alert('Failed: ' + e.message);
  }
};

window._backfillUserCounter = async function() {
  if (!confirm('Count all users and update counter?')) return;
  try {
    const total = await counters.getUserCount();
    await counters.setCounter('totalUsers', total);
    alert('Counter backfilled: ' + total + ' users');
  } catch (e) {
    alert('Failed: ' + e.message);
  }
};

window.printResult = async function(resultId, eventId) {
  // Load result from DB and print
  try {
    const { default: results } = await import('../db/results.js');
    const { printResultSheet } = await import('../utils/pdf.js');
    // Result fetching will be implemented when results module is complete
    alert('Print result: ' + resultId);
  } catch (e) {
    console.error('Print failed:', e);
  }
};

window._startMigration = async function() {
  if (!confirm('This will import all data from Firestore into Turso. Continue?')) return;
  try {
    const { runMigration } = await import('../utils/migrate.js');
    const result = await runMigration((msg) => console.log('[Migration]', msg));
    alert('Migration complete!\nItems migrated: ' + result.migrated + '\nErrors: ' + result.errors);
  } catch (e) {
    alert('Migration failed: ' + e.message);
    console.error(e);
  }
};
