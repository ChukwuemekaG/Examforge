import { getState } from './core.js';
import * as notifications from '../db/notifications.js';
import * as users from '../db/users.js';
import { generateId } from '../utils/helpers.js';

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDays = Math.floor(diffHour / 24);
  
  if (diffSec < 60) return 'just now';
  if (diffMin < 60) return diffMin + 'm ago';
  if (diffHour < 24) return diffHour + 'h ago';
  if (diffDays < 7) return diffDays + 'd ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export async function renderInbox() {
  const { userData, workspace } = getState();
  const inboxItems = userData.inbox || [];

  // Track read state
  window._inboxReadState = window._inboxReadState || {};

  // RENDER IMMEDIATELY with cached inbox
  renderInboxList(inboxItems, []);

  // FETCH broadcast notifications in background
  try {
    const broadcastItems = await notifications.getBroadcastNotifications();
    renderInboxList(inboxItems, broadcastItems.filter(n => !n.quiz_url));
  } catch (e) { /* use cached */ }
}

function renderInboxList(personal, broadcast) {
  const { workspace } = getState();
  const allItems = [...broadcast.map(n => ({ ...n, isBroadcast: true })), ...personal].slice(0, 50);
  
  const unreadCount = allItems.filter(n => {
    const key = n.id || n.timestamp || JSON.stringify(n);
    return !window._inboxReadState[key];
  }).length;

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Inbox</div>
    <div class="page-sub">${unreadCount > 0 ? unreadCount + ' unread' : 'All caught up!'}</div>
  </div>
  ${allItems.length === 0
    ? '<div class="empty-state"><span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">inbox</span><div style="font-weight:700;color:var(--text-muted);">No notifications</div></div>'
    : '<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">' +
      '<span style="font-size:0.75rem;color:var(--text-muted);">Showing latest ${allItems.length} items</span>' +
      (unreadCount > 0 ? '<button class="btn btn-ghost btn-sm" onclick="window._markAllRead()" style="font-size:0.75rem;">Mark all read</button>' : '') +
      '</div>' +
      '<div class="inbox-list">' + allItems.map(n => {
        const key = n.id || n.timestamp || JSON.stringify(n);
        const isUnread = !window._inboxReadState[key];
        const isResult = n.type === 'result' || !!n.result_id;
        const icon = isResult ? 'feed' : (n.brand_icon || 'notifications');
        return '<div class="card inbox-card" style="padding:14px 16px;margin-bottom:8px;cursor:pointer;border-left:3px solid ' + (isUnread ? 'var(--brand)' : 'transparent') + ';opacity:' + (isUnread ? '1' : '0.7') + ';" onclick="window._markInboxRead(\'' + key.replace(/\'/g, '\\\'') + '\');' + (isResult && n.result_id ? 'window.printResult(\'' + n.result_id + '\',\'' + (n.event_id || '') + '\')' : '') + '">' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
            (isUnread ? '<span style="width:8px;height:8px;border-radius:50%;background:var(--brand);flex-shrink:0;"></span>' : '') +
            '<span class="material-icons-round" style="font-size:1.5rem;color:' + (n.brand_color || '#fe6961') + ';">' + icon + '</span>' +
            '<div style="flex:1;min-width:0;">' +
              '<div style="font-weight:' + (isUnread ? '700' : '500') + ';font-size:0.85rem;">' + (n.title || '') + '</div>' +
              '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + (n.message || '') + '</div>' +
              '<div style="font-size:0.65rem;color:var(--text-muted);margin-top:4px;">' + formatRelativeTime(n.created_at || n.timestamp || '') + (n.isBroadcast ? ' <span class="tag tag-brand" style="font-size:0.55rem;">SYSTEM</span>' : '') + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + '</div>'
  }`;
  
  window._markInboxRead = function(key) {
    window._inboxReadState[key] = true;
    renderInbox();
  };
  
  window._markAllRead = function() {
    const allItems = [...broadcast.map(n => ({ ...n, isBroadcast: true })), ...personal].slice(0, 50);
    allItems.forEach(n => {
      const key = n.id || n.timestamp || JSON.stringify(n);
      window._inboxReadState[key] = true;
    });
    renderInbox();
  };
}

window._markInboxRead = function() {};
window._markAllRead = function() {};
