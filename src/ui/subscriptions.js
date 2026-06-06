import { getState } from './core.js';
import * as events from '../db/events.js';
import { showConfirmAsync, showAlert, showModal } from '../utils/helpers.js';

export async function renderSubscriptions() {
  const { workspace } = getState();
  let eventList = [];
  try {
    eventList = await events.getAllEvents();
  } catch (e) { console.warn('Could not load events:', e); }

  workspace.innerHTML = `
  <div class="page-header">
    <div class="page-title">Subscriptions</div>
    <div class="page-sub">Academic Events & Registrations</div>
  </div>
  ${eventList.length === 0
    ? '<div class="empty-state"><span class="material-icons-round" style="font-size:48px;color:var(--text-muted);margin-bottom:16px;">event</span><div style="font-weight:700;color:var(--text-muted);">No events available</div></div>'
    : '<div class="card-grid" style="grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:16px;">' + eventList.map(ev => {
        const subjects = JSON.parse(ev.available_subjects || '[]');
        return '<div class="card" style="padding:20px;cursor:pointer;" onclick="window._openEventRegistration(\'' + ev.id + '\')"><div style="font-weight:800;font-size:0.95rem;margin-bottom:4px;">' + (ev.title || '') + '</div><div style="font-size:0.7rem;color:var(--text-muted);margin-bottom:8px;">' + subjects.length + ' subject' + (subjects.length !== 1 ? 's' : '') + ' • ' + (ev.results_released ? 'Results Released' : 'Active') + '</div><div style="font-size:0.7rem;color:var(--text-muted);">' + (ev.description ? ev.description.slice(0, 60) + (ev.description.length > 60 ? '...' : '') : '') + '</div></div>';
      }).join('') + '</div>'
  }`;
}

window._openEventRegistration = async function(eventId) {
  // Simple event registration modal
  const { userData } = getState();
  try {
    const ev = await events.getEvent(eventId);
    if (!ev) { showAlert('Event not found.'); return; }
    const subjects = JSON.parse(ev.available_subjects || '[]');
    // Check if already registered
    const reg = await events.getStudentRegistration(eventId, userData.uid);
    if (reg) {
      showAlert('You are already registered for this event.\nSubjects: ' + JSON.parse(reg.subjects || '[]').join(', '));
      return;
    }
    // Show registration prompt
    const msg = 'Event: ' + ev.title + '\nSubjects: ' + subjects.join(', ') + '\n\nRegister for this event?';
    if (await showConfirmAsync(msg)) {
      await events.registerStudent(eventId, {
        uid: userData.uid,
        displayName: userData.displayName,
        email: userData.email,
        subjects: subjects
      });
      showAlert('Successfully registered!');
    }
  } catch (e) {
    console.error('Registration failed:', e);
    showAlert('Registration failed: ' + e.message);
  }
};
