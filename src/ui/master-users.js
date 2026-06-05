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
  return '<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Rating</th><th>Role</th><th>Streak</th><th>Joined</th></tr></thead><tbody>' +
    list.map(u => '<tr><td>' + (u.display_name || '') + '</td><td style="font-size:0.75rem;">' + (u.email || '') + '</td><td style="font-weight:700;">' + (u.exa_rating || 800) + '</td><td><span class="tag ' + (u.role === 'admin' ? 'tag-green' : 'tag-muted') + '">' + (u.role || 'student') + '</span></td><td>' + (u.streak || 0) + '</td><td style="font-size:0.7rem;">' + (u.created_at || '') + '</td></tr>').join('') +
    '</tbody></table></div>';
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
