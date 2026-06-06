// Core navigation, routing, theme, and shared state

let currentUser = null;
let currentView = 'dashboard';
let userData = {
  results: [], schedule: [], inbox: [], stats: { streak: 0, highestStreak: 0, exaRating: 800 },
  displayName: '', email: '', username: '', role: 'student', totalUsers: 0
};
let workspace = null;
let sync = null;

export function getState() {
  return { currentUser, currentView, userData, workspace, sync };
}

export function setUser(user) { currentUser = user; }
export function setView(view) { currentView = view; }
export function setUserData(data) { Object.assign(userData, data); }
export function setWorkspace(el) { workspace = el; }
export function setSync(s) { sync = s; }

// Navigation
export function navigate(view) {
  currentView = view;
  
  // Update sidebar active state
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.view === view));
  
  // Update bottom nav active state
  document.querySelectorAll('.bottom-nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.view === view);
  });
  
  // Trigger render
  const evt = new CustomEvent('viewchange', { detail: { view } });
  document.dispatchEvent(evt);
}

// Theme toggle
export function toggleTheme() {
  document.body.classList.toggle('dark-mode');
  document.body.classList.toggle('light-mode');
  const isDark = document.body.classList.contains('dark-mode');
  localStorage.setItem('ef-theme', isDark ? 'dark' : 'light');
  return isDark;
}

export function initTheme() {
  const saved = localStorage.getItem('ef-theme') || 'light';
  document.body.classList.add(saved + '-mode');
  document.body.classList.remove(saved === 'dark' ? 'light-mode' : 'dark-mode');
}

// Sidebar setup
export function initNavigation(navItems) {
  // Sidebar nav
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => navigate(item.dataset.view));
  });
  // Bottom nav
  document.querySelectorAll('.bottom-nav-item').forEach(item => {
    item.addEventListener('click', () => navigate(item.dataset.view));
  });
  
  // Swipe navigation for mobile — DISABLED on admin/master page
  let startX = 0, startY = 0;
  document.addEventListener('touchstart', e => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
  document.addEventListener('touchend', e => {
    if (currentView === 'master') return; // No swipe on admin page
    
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dy) < 100) {
      const views = ['dashboard', 'library', 'subscriptions', 'schedule', 'results', 'inbox', 'settings'];
      const idx = views.indexOf(currentView);
      if (dx < 0 && idx < views.length - 1) navigate(views[idx + 1]);
      else if (dx > 0 && idx > 0) navigate(views[idx - 1]);
    }
  }, { passive: true });
}

// Generic render helper
export function renderView(html) {
  if (!workspace) return;
  workspace.innerHTML = html;
}

// Toast notification
export function showToast(message, duration = 3000) {
  const existing = document.querySelector('.ef-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'ef-toast';
  toast.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#18160F;color:#fff;padding:12px 24px;border-radius:12px;font-family:Poppins,sans-serif;font-weight:600;font-size:14px;z-index:99999;box-shadow:0 4px 24px rgba(0,0,0,0.2);transition:opacity 0.3s;';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, duration);
}

// Fixed notification bell — top-right on all pages
export function initNotificationBell() {
  // Remove existing if any
  const existing = document.getElementById('ef-notif-bell');
  if (existing) existing.remove();
  
  const bell = document.createElement('div');
  bell.id = 'ef-notif-bell';
  bell.style.cssText = 'position:fixed;top:12px;right:16px;z-index:100;cursor:pointer;width:40px;height:40px;border-radius:50%;background:var(--bg-card);border:2px solid var(--border);display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px rgba(0,0,0,0.1);';
  bell.innerHTML = '<span class="material-icons-round" style="font-size:1.3rem;color:var(--text);">notifications</span>';
  bell.onclick = () => navigate('inbox');
  document.body.appendChild(bell);
}
