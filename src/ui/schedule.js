import { getState } from './core.js';
import * as schedules from '../db/schedules.js';
import * as users from '../db/users.js';
import { generateId } from '../utils/helpers.js';

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

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Schedule</div>
    <div class="page-sub">Your Study Plan (${allItems.length} items)</div>
  </div>
  <div class="sched-list">
    ${allItems.map(s => {
      const isBroadcast = s.isBroadcast;
      const title = isBroadcast ? (s.title || 'Mock Exam') : (s.title || 'Study Session');
      const course = s.course || '';
      const date = s.due_date || s.created_at || '';
      const time = s.due_time || '';
      const timeLimit = s.time_limit ? (s.time_limit + ' min') : '';
      return '<div class="card sched-card" style="padding:16px;margin-bottom:12px;border-left:4px solid ' + (isBroadcast ? 'var(--brand)' : 'var(--text-muted)') + ';"><div style="display:flex;align-items:center;gap:12px;"><div style="flex:1;"><div style="font-weight:700;font-size:0.9rem;">' + title + '</div>' + (course ? '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">' + course + '</div>' : '') + '<div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">' + date + (time ? ' at ' + time : '') + (timeLimit ? ' • ' + timeLimit : '') + '</div></div>' + (s.quiz_url ? '<button onclick="window.location.href=\'' + s.quiz_url + '\'" class="btn btn-primary btn-sm" style="text-decoration:none;"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">play_arrow</span> Start</button>' : '') + (s.id && !isBroadcast ? '<button onclick="window._deleteScheduleItem(\'' + s.id + '\')" class="btn btn-ghost btn-sm" style="padding:4px;"><span class="material-icons-round" style="font-size:1.1rem;">close</span></button>' : '') + '</div></div>';
    }).join('')}
  </div>`;
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
