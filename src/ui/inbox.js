import { getState } from './core.js';
import * as notifications from '../db/notifications.js';
import * as users from '../db/users.js';
import { generateId } from '../utils/helpers.js';

export async function renderInbox() {
  const { userData, workspace } = getState();
  
  let inboxItems = userData.inbox || [];
  let broadcastItems = [];
  try {
    broadcastItems = await notifications.getBroadcastNotifications();
  } catch (e) { console.warn('Could not load broadcast notifications:', e); }
  
  // Filter out all broadcast notifications with quizUrl (exam-related)
  broadcastItems = broadcastItems.filter(n => !n.quiz_url);
  
  // Merge broadcast + personal inbox, limit to 50
  const allItems = [...broadcastItems.map(n => ({ ...n, isBroadcast: true })), ...inboxItems].slice(0, 50);

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Inbox</div>
    <div class="page-sub">Notifications & Updates</div>
  </div>
  ${allItems.length === 0
    ? '<div class="empty-state"><span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">inbox</span><div style="font-weight:700;color:var(--text-muted);">No notifications</div></div>'
    : '<div class="inbox-list">' + allItems.map(n => {
        const isResult = n.type === 'result' || !!n.result_id;
        const icon = isResult ? 'feed' : (n.brand_icon || 'notifications');
        return '<div class="card inbox-card" style="padding:14px 16px;margin-bottom:10px;cursor:pointer;" onclick="' + (isResult && n.result_id ? 'window.printResult(\'' + n.result_id + '\',\'' + (n.event_id || '') + '\')' : '') + '"><div style="display:flex;align-items:center;gap:12px;"><span class="material-icons-round" style="font-size:1.5rem;color:' + (n.brand_color || '#fe6961') + ';">' + icon + '</span><div style="flex:1;"><div style="font-weight:700;font-size:0.85rem;">' + (n.title || '') + '</div><div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">' + (n.message || '') + '</div><div style="font-size:0.65rem;color:var(--text-muted);margin-top:4px;">' + (n.created_at || n.timestamp || '') + '</div></div></div></div>';
      }).join('') + '</div>'
  }`;
}
