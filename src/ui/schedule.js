import { getState } from './core.js';
import * as schedules from '../db/schedules.js';
import * as users from '../db/users.js';
import { generateId } from '../utils/helpers.js';

function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffDays = Math.floor((d - now) / (1000 * 60 * 60 * 24));
  
  const dateOpts = { month: 'short', day: 'numeric' };
  const formatted = d.toLocaleDateString('en-US', dateOpts);
  
  if (diffDays < 0) return '<span style="color:#dc2626;">🔴 Overdue</span>';
  if (diffDays === 0) return '<span style="color:#16a34a;">🟢 Today</span> — ' + formatted;
  if (diffDays === 1) return '<span style="color:#ca8a04;">🟡 Tomorrow</span> — ' + formatted;
  if (diffDays <= 7) return '<span style="color:#ca8a04;">🟡 ' + diffDays + ' days</span> — ' + formatted;
  return '⚪ ' + formatted;
}

function groupByDate(items) {
  const groups = { overdue: [], today: [], tomorrow: [], thisWeek: [], future: [] };
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  
  for (const item of items) {
    const dueDate = item.due_date || item.created_at;
    if (!dueDate) { groups.future.push(item); continue; }
    const d = new Date(dueDate);
    d.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((d - now) / (1000 * 60 * 60 * 24));
    
    if (diffDays < 0) groups.overdue.push(item);
    else if (diffDays === 0) groups.today.push(item);
    else if (diffDays === 1) groups.tomorrow.push(item);
    else if (diffDays <= 7) groups.thisWeek.push(item);
    else groups.future.push(item);
  }
  return groups;
}

export async function renderSchedule() {
  const { userData, workspace } = getState();
  const schedItems = userData.schedule || [];

  // RENDER IMMEDIATELY with cached schedule
  renderScheduleList(schedItems, []);

  // FETCH broadcast schedules in background
  try {
    const broadcastScheds = await schedules.getBroadcastSchedules();
    renderScheduleList(schedItems, broadcastScheds);
  } catch (e) { /* use cached */ }
}

function renderScheduleList(personal, broadcast) {
  const { workspace } = getState();
  const allItems = [...personal, ...broadcast.map(s => ({ ...s, isBroadcast: true }))];

  if (allItems.length === 0) {
    workspace.innerHTML = '<div class="page-header"><div class="page-title">Schedule</div><div class="page-sub">Your Study Plan</div></div><div class="empty-state"><span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">event_busy</span><div style="font-weight:700;color:var(--text-muted);">No scheduled items</div></div>';
    return;
  }

  const groups = groupByDate(allItems);
  const groupLabels = [
    { key: 'overdue', label: 'Overdue', icon: '🔴' },
    { key: 'today', label: 'Today', icon: '🟢' },
    { key: 'tomorrow', label: 'Tomorrow', icon: '🟡' },
    { key: 'thisWeek', label: 'This Week', icon: '📅' },
    { key: 'future', label: 'Upcoming', icon: '📆' },
  ];

  let html = `
  <div class="page-header">
    <div class="page-title">Schedule</div>
    <div class="page-sub">Your Study Plan (${allItems.length} items)</div>
  </div>`;

  for (const group of groupLabels) {
    const items = groups[group.key];
    if (items.length === 0) continue;
    
    html += `
    <div style="margin-bottom:16px;">
      <div style="font-weight:700;font-size:0.85rem;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
        <span>${group.icon}</span> ${group.label}
        <span style="font-size:0.75rem;color:var(--text-muted);font-weight:400;">(${items.length})</span>
      </div>
      ${items.map(s => {
        const isBroadcast = s.isBroadcast;
        const title = isBroadcast ? (s.title || 'Mock Exam') : (s.title || 'Study Session');
        const course = s.course || '';
        const date = s.due_date || s.created_at || '';
        const time = s.due_time || '';
        const timeLimit = s.time_limit ? (s.time_limit + ' min') : '';
        return '<div class="card sched-card" style="padding:14px 16px;margin-bottom:8px;border-left:4px solid ' + (isBroadcast ? 'var(--brand)' : (group.key === 'overdue' ? '#dc2626' : 'var(--text-muted)')) + ';">' +
          '<div style="display:flex;align-items:center;gap:12px;">' +
          '<div style="flex:1;">' +
            '<div style="font-weight:700;font-size:0.9rem;">' + title + '</div>' +
            (course ? '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">' + course + '</div>' : '') +
            '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;">' +
              (date ? '<span>' + formatRelativeDate(date) + '</span>' : '') +
              (time ? '<span>⏰ ' + time + '</span>' : '') +
              (timeLimit ? '<span>⏱ ' + timeLimit + '</span>' : '') +
              (isBroadcast ? '<span class="tag tag-brand" style="font-size:0.6rem;">SYSTEM</span>' : '') +
            '</div>' +
          '</div>' +
          (s.quiz_url ? '<button onclick="window.location.href=\'' + s.quiz_url + '\'" class="btn btn-primary btn-sm" style="text-decoration:none;"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Start</button>' : '') +
          (s.id && !isBroadcast ? '<button onclick="window._deleteScheduleItem(\'' + s.id + '\')" class="btn btn-ghost btn-sm" style="padding:4px;"><span class="material-icons-round" style="font-size:1.1rem;">close</span></button>' : '') +
          '</div>' +
        '</div>';
      }).join('')}
    </div>`;
  }

  workspace.innerHTML = html;
}

// Delete personal schedule item
window._deleteScheduleItem = async function(id) {
  try {
    await users.deleteScheduleItem(id);
    renderSchedule();
  } catch (e) {
    console.error('Failed to delete schedule item:', e);
  }
};
