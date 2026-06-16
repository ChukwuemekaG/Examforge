// Examforge Main App — Entry Point
import { auth } from '../firebase-config.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js';
import { initSchema } from './db/schema.js';
import { exec, execOne, execute, trackRead, batch } from './db/client.js';
import * as core from './ui/core.js';
import * as authModule from './ui/auth.js';
import { renderDashboard, updateDashboardUI } from './ui/dashboard.js';
import { renderSchedule } from './ui/schedule.js';
import { renderInbox } from './ui/inbox.js';
import { renderResults } from './ui/results.js';
import { renderLibrary } from './ui/library.js';
import { renderSettings } from './ui/settings.js';
import { renderMocks } from './ui/mocks.js';
import { renderMaster } from './ui/master.js';

// ─── Initialize ───

core.initTheme();

document.addEventListener('DOMContentLoaded', async () => {
  const workspace = document.getElementById('workspace');
  if (!workspace) return;
  core.setWorkspace(workspace);

  // Initialize Turso schema
  try {
    await initSchema({ execute, batch, exec });
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
  
  // Hide preloader regardless of auth state
  const preloader = document.getElementById('app-preloader');
  if (preloader) preloader.style.display = 'none';
  
  if (!user) {
    window.location.href = '/login.html';
    return;
  }

  // Add notification bell
  core.initNotificationBell();

  // Preload essential data (0 reads if cached in Turso)
  try {
    await Promise.all([
      import('./db/schedules.js').then(m => m.getBroadcastSchedules()).catch(() => {}),
      import('./db/notifications.js').then(m => m.getBroadcastNotifications()).catch(() => {}),
    ]);
  } catch (e) { /* preload best-effort */ }

  // Check admin role and show admin nav
  if (core.getState().userData?.role === 'admin') {
    const navMaster = document.getElementById('nav-master');
    if (navMaster) navMaster.style.display = '';
    const navMasterBottom = document.getElementById('nav-master-bottom');
    if (navMasterBottom) navMasterBottom.style.display = '';
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
        renderDashboard();
        break;
      case 'schedule':
        renderSchedule();
        break;
      case 'inbox':
        renderInbox();
        break;
      case 'results':
        await renderResults();
        break;
      case 'library':
        renderLibrary();
        break;
      case 'mocks':
        renderMocks();
        break;
      case 'settings':
        renderSettings();
        break;
      case 'master':
        if (core.getState().userData?.role === 'admin') renderMaster();
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
