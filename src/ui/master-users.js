// Admin: Users management

import * as users from '../db/users.js';
import * as counters from '../db/counters.js';

export async function renderUsersTab(container) {
  let userList = [];
  let totalCount = 0;
  try { 
    userList = await users.getAllUsers(100);
    totalCount = await counters.getUserCount();
  } catch (e) { console.warn(e); }

  container.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:800;font-size:1.1rem;">Users (${totalCount})</div>
    <div><input type="text" id="user-search-input" placeholder="Search users..." style="padding:8px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.8rem;width:200px;" oninput="window._searchUsers()"></div>
  </div>
  <div id="users-list-content">
    ${renderUserTable(userList)}
  </div>`;
}

function renderUserTable(list) {
  if (list.length === 0) return '<div class="empty-state">No users found</div>';
  return '<div style="max-height:400px;overflow-y:auto;overflow-x:auto;border:1px solid var(--border);border-radius:8px;"><table style="width:100%;border-collapse:collapse;min-width:600px;"><thead><tr style="position:sticky;top:0;background:var(--bg-card);z-index:1;">' +
    '<th style="padding:10px 8px;text-align:left;font-size:0.75rem;white-space:nowrap;border-bottom:2px solid var(--border);">Name</th>' +
    '<th style="padding:10px 8px;text-align:left;font-size:0.75rem;white-space:nowrap;border-bottom:2px solid var(--border);">Email</th>' +
    '<th style="padding:10px 8px;text-align:center;font-size:0.75rem;white-space:nowrap;border-bottom:2px solid var(--border);">Rating</th>' +
    '<th style="padding:10px 8px;text-align:center;font-size:0.75rem;white-space:nowrap;border-bottom:2px solid var(--border);">Role</th>' +
    '<th style="padding:10px 8px;text-align:center;font-size:0.75rem;white-space:nowrap;border-bottom:2px solid var(--border);">Streak</th>' +
    '<th style="padding:10px 8px;text-align:left;font-size:0.75rem;white-space:nowrap;border-bottom:2px solid var(--border);">Joined</th></tr></thead><tbody>' +
    list.map(u => '<tr style="cursor:pointer;border-bottom:1px solid var(--border);" onclick="window._openUserDetail(\'' + u.id + '\')">' +
      '<td style="padding:8px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.8rem;">' + truncate(u.display_name || '', 50) + '</td>' +
      '<td style="padding:8px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.75rem;">' + truncate(u.email || '', 50) + '</td>' +
      '<td style="padding:8px;text-align:center;font-weight:700;font-size:0.8rem;">' + (u.exa_rating || 800) + '</td>' +
      '<td style="padding:8px;text-align:center;"><span class="tag ' + (u.role === 'admin' ? 'tag-green' : 'tag-muted') + '" style="font-size:0.65rem;">' + truncate(u.role || 'student', 50) + '</span></td>' +
      '<td style="padding:8px;text-align:center;font-size:0.8rem;">' + (u.streak || 0) + '</td>' +
      '<td style="padding:8px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.7rem;">' + truncate(u.created_at || '', 50) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '...' : str;
}

window._searchUsers = async function() {
  const query = document.getElementById('user-search-input')?.value || '';
  const container = document.getElementById('users-list-content');
  if (!container) return;
  try {
    const results = query ? await users.searchUsers(query) : await users.getAllUsers(100);
    container.innerHTML = renderUserTable(results);
  } catch (e) {
    container.innerHTML = '<div style="color:#dc2626;">Search failed: ' + e.message + '</div>';
  }
};

window._openUserDetail = async function(userId) {
  try {
    const userData = await users.getUser(userId);
    if (!userData) { alert('User not found'); return; }
    
    // Build detail overlay
    const overlay = document.createElement('div');
    overlay.id = 'user-detail-overlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:2000;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);overflow-y:auto;padding:20px;';
    
    overlay.innerHTML = '<div class="card" style="max-width:600px;width:100%;padding:24px;border-radius:16px;max-height:90vh;overflow-y:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">' +
      '<div style="display:flex;align-items:center;gap:12px;">' +
      '<div style="width:48px;height:48px;border-radius:50%;background:var(--brand);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.2rem;">' + (userData.display_name || '?')[0].toUpperCase() + '</div>' +
      '<div><div style="font-weight:800;font-size:1.1rem;">' + (userData.display_name || 'Unknown') + '</div>' +
      '<div style="font-size:0.75rem;color:var(--text-muted);">' + (userData.email || '') + ' · ' + (userData.role || 'student') + '</div></div></div>' +
      '<button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'user-detail-overlay\').remove()" style="padding:4px;"><span class="material-icons-round">close</span></button></div>' +
      
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;">' +
      '<div class="card" style="padding:12px;text-align:center;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">EXA Rating</div><div style="font-size:1.5rem;font-weight:900;">' + (userData.exa_rating || 800) + '</div></div>' +
      '<div class="card" style="padding:12px;text-align:center;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Streak</div><div style="font-size:1.5rem;font-weight:900;">' + (userData.streak || 0) + 'd</div><div style="font-size:0.65rem;color:var(--text-muted);">Best: ' + (userData.highest_streak || 0) + 'd</div></div>' +
      '</div>' +
      
      '<div style="margin-bottom:16px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Display Name</label><input id="edit-display-name" value="' + (userData.display_name || '') + '" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;"></div>' +
      '<div style="margin-bottom:16px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Username</label><input id="edit-username" value="' + (userData.username || '') + '" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;"></div>' +
      '<div style="margin-bottom:16px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Email</label><input value="' + (userData.email || '') + '" disabled style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;background:var(--bg-inset);"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">' +
      '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">EXA Rating</label><input id="edit-exa" type="number" value="' + (userData.exa_rating || 800) + '" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;"></div>' +
      '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Role</label><select id="edit-role" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;"><option value="student"' + (userData.role === 'student' ? ' selected' : '') + '>Student</option><option value="admin"' + (userData.role === 'admin' ? ' selected' : '') + '>Admin</option></select></div>' +
      '</div>' +
      
      '<div style="display:flex;gap:8px;">' +
      '<button class="btn btn-primary" onclick="window._saveUserDetail(\'' + userId + '\')" style="flex:1;">Save Changes</button>' +
      '<button class="btn btn-outline" onclick="document.getElementById(\'user-detail-overlay\').remove()" style="flex:1;">Cancel</button></div>' +
      '</div>';
    
    document.body.appendChild(overlay);
  } catch (e) {
    alert('Error loading user: ' + e.message);
  }
};

window._saveUserDetail = async function(userId) {
  const displayName = document.getElementById('edit-display-name')?.value || '';
  const username = document.getElementById('edit-username')?.value || '';
  const exaRating = parseInt(document.getElementById('edit-exa')?.value) || 800;
  const role = document.getElementById('edit-role')?.value || 'student';
  
  try {
    await users.updateUserData(userId, { displayName, exaRating, role });
    // Update username separately
    await users.updateUser(userId, { username });
    alert('User updated successfully!');
    document.getElementById('user-detail-overlay')?.remove();
    // Refresh user list
    const container = document.getElementById('users-list-content');
    if (container) {
      const userList = await users.getAllUsers(100);
      container.innerHTML = renderUserTable(userList);
    }
  } catch (e) {
    alert('Error saving: ' + e.message);
  }
};
