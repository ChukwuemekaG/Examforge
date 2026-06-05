import { getState } from './core.js';
import { toggleTheme } from './core.js';
import { logout } from './auth.js';

export function renderSettings() {
  const { userData, workspace } = getState();
  const isDark = document.body.classList.contains('dark-mode');

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Settings</div>
    <div class="page-sub">Account & Preferences</div>
  </div>
  <div class="card" style="padding:20px;margin-bottom:16px;">
    <div style="font-weight:800;font-size:0.9rem;margin-bottom:12px;">Profile</div>
    <div style="font-size:0.8rem;margin-bottom:4px;"><strong>Name:</strong> ${userData.displayName || 'N/A'}</div>
    <div style="font-size:0.8rem;margin-bottom:4px;"><strong>Email:</strong> ${userData.email || 'N/A'}</div>
    <div style="font-size:0.8rem;"><strong>Username:</strong> ${userData.username || 'N/A'}</div>
  </div>
  <div class="card" style="padding:20px;margin-bottom:16px;">
    <div style="font-weight:800;font-size:0.9rem;margin-bottom:12px;">Preferences</div>
    <div style="display:flex;align-items:center;justify-content:space-between;">
      <div><div style="font-weight:600;font-size:0.8rem;">Dark Mode</div><div style="font-size:0.7rem;color:var(--text-muted);">Toggle dark/light theme</div></div>
      <label class="switch"><input type="checkbox" ${isDark ? 'checked' : ''} onchange="window._toggleTheme()"><span class="slider round"></span></label>
    </div>
  </div>
  <div class="card" style="padding:20px;margin-bottom:16px;">
    <div style="font-weight:800;font-size:0.9rem;margin-bottom:12px;">Account</div>
    <button class="btn btn-outline btn-sm" onclick="window._logout()" style="width:100%;"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">logout</span> Sign Out</button>
  </div>`;
}

window._toggleTheme = toggleTheme;
window._logout = logout;
