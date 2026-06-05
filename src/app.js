// Examforge Main App — Entry Point
import { auth } from '../firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { initSchema } from './db/schema.js';
import { exec, execOne, execute, trackRead } from './db/client.js';
import * as core from './ui/core.js';
import * as authModule from './ui/auth.js';
import { renderDashboard, updateDashboardUI } from './ui/dashboard.js';
import { renderSchedule } from './ui/schedule.js';
import { renderInbox } from './ui/inbox.js';
import { renderResults } from './ui/results.js';
import { renderLibrary } from './ui/library.js';
import { renderSettings } from './ui/settings.js';
import { renderSubscriptions } from './ui/subscriptions.js';
import { renderMaster } from './ui/master.js';

// ─── Initialize ───

core.initTheme();

document.addEventListener('DOMContentLoaded', async () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  core.setWorkspace(workspace);

  // Initialize Turso schema
  try {
    await initSchema({ execute });
  } catch (e) {
    console.warn('[App] Schema init skipped:', e.message);
  }

  // Set up navigation
  core.initNavigation();
  
  // Listen for view changes
  document.addEventListener('viewchange', async (e) => {
    await handleViewChange(e.detail.view);
  });

  // Initialize auth
  const user = await authModule.initAuth();
  
  if (!user) {
    window.location.href = '/login.html';
    return;
  }

  // Preload essential data (0 reads if cached in Turso)
  try {
    await Promise.all([
      import('./db/schedules.js').then(m => m.getBroadcastSchedules()).catch(() => {}),
      import('./db/notifications.js').then(m => m.getBroadcastNotifications()).catch(() => {}),
    ]);
  } catch (e) { /* preload best-effort */ }

  // Check admin role and show admin nav
  if (core.getState().userData?.role === 'admin') {
    const adminNav = document.getElementById('admin-nav');
    if (adminNav) adminNav.style.display = 'flex';
  }

  // Initial view
  await handleViewChange('dashboard');
});

// ─── View Router ───

async function handleViewChange(view) {
  const { workspace } = core.getState();
  if (!workspace) return;

  // Scroll to top
  window.scrollTo(0, 0);

  try {
    switch (view) {
      case 'dashboard':
        await renderDashboard();
        break;
      case 'schedule':
        await renderSchedule();
        break;
      case 'inbox':
        await renderInbox();
        break;
      case 'results':
        renderResults();
        break;
      case 'library':
        await renderLibrary();
        break;
      case 'subscriptions':
        await renderSubscriptions();
        break;
      case 'settings':
        renderSettings();
        break;
      case 'master':
        if (core.getState().userData?.role === 'admin') await renderMaster();
        else workspace.innerHTML = '<div class="empty-state">Access denied</div>';
        break;
      default:
        workspace.innerHTML = '<div class="empty-state">View not found</div>';
    }
  } catch (e) {
    workspace.innerHTML = '<div class="card" style="padding:24px;color:#dc2626;"><strong>Error:</strong> ' + e.message + '</div>';
    console.error('[Router] Error rendering', view, e);
  }
}

// ─── Global window functions ───

window.updateDashboardUI = updateDashboardUI;
window.navigate = core.navigate;
window.toggleTheme = core.toggleTheme;
