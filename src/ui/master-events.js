// Admin: Subscription Events CRUD

import * as events from '../db/events.js';
import * as mocks from '../db/mocks.js';
import { generateId, showPrompt, showConfirmAsync, showAlert } from '../utils/helpers.js';

export async function renderMasterEvents(container) {
  let eventList = [];
  try { eventList = await events.getAllEvents(); } catch (e) { console.warn(e); }
  
  container.innerHTML = `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
    <div style="font-weight:800;font-size:1.1rem;">Subscription Events (${eventList.length})</div>
    <button class="btn btn-primary btn-sm" onclick="window._createEvent()"><span class="material-icons-round" style="font-size:1rem;vertical-align:middle;">add</span> New Event</button>
  </div>
  <div id="event-list">
    ${eventList.length === 0 ? '<div class="empty-state">No events yet</div>'
      : eventList.map(ev => {
          const subjects = JSON.parse(ev.available_subjects || '[]');
          return '<div class="card" style="padding:14px;margin-bottom:8px;"><div style="display:flex;justify-content:space-between;align-items:center;"><div style="cursor:pointer;flex:1;" onclick="window._openEventDetails(\'' + ev.id + '\')"><div style="font-weight:700;">' + (ev.title || 'Untitled') + '</div><div style="font-size:0.7rem;color:var(--text-muted);">' + subjects.length + ' subjects' + (ev.results_released ? ' • Results Released' : ' • Active') + '</div></div><button class="btn btn-outline btn-sm" onclick="event.stopPropagation();window._deleteEvent(\'' + ev.id + '\')">Delete</button></div></div>';
        }).join('')}
  </div>
  <div id="event-details-area"></div>`;
}

window._createEvent = async function() {
  const title = await showPrompt('Event title:');
  if (!title) return;
  const subjectsStr = await showPrompt('Subjects (comma-separated):', '') || '';
  const subjects = subjectsStr.split(',').map(s => s.trim()).filter(Boolean);
  
  try {
    const id = await events.createEvent({ title, availableSubjects: subjects });
    // Create registration keys
    const keyCount = parseInt(await showPrompt('Number of registration keys to generate:', '10')) || 10;
    for (let i = 0; i < keyCount; i++) {
      const key = 'KEY-' + id.slice(-4).toUpperCase() + '-' + String(i + 1).padStart(3, '0');
      await events.createEventKey(id, key);
    }
    showAlert('Event created! ID: ' + id);
    const container = document.getElementById('master-tab-content');
    if (container) await renderMasterEvents(container);
  } catch (e) { showAlert('Error: ' + e.message); }
};

window._deleteEvent = async function(id) {
  if (!await showConfirmAsync('Delete this event? This will remove all registrations and associated mocks.')) return;
  try {
    // Delete associated mocks
    const eventMocks = await mocks.getEventMocks(id);
    for (const mock of eventMocks) await mocks.deleteMock(mock.id);
    // Delete event
    await events.deleteEvent(id);
    const container = document.getElementById('master-tab-content');
    if (container) await renderMasterEvents(container);
  } catch (e) { showAlert('Error: ' + e.message); }
};

window._openEventDetails = async function(eventId) {
  const detailArea = document.getElementById('event-details-area');
  if (!detailArea) return;
  
  try {
    const ev = await events.getEvent(eventId);
    if (!ev) { detailArea.innerHTML = '<div style="color:#dc2626;">Event not found</div>'; return; }
    
    const subjects = JSON.parse(ev.available_subjects || '[]');
    const regs = await events.getRegistrations(eventId);
    const eventMocks = await mocks.getEventMocks(eventId);
    const keys = await events.getEventKeys(eventId);
    const usedKeys = keys.filter(k => k.used_by);
    
    detailArea.innerHTML = '<div style="margin-top:16px;padding:20px;background:var(--bg-inset);border-radius:12px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:16px;">' +
      '<div><div style="font-weight:800;font-size:1.1rem;">' + (ev.title || '') + '</div>' +
      '<div style="font-size:0.75rem;color:var(--text-muted);">ID: ' + eventId + '</div></div>' +
      '<div><span class="tag ' + (ev.results_released ? 'tag-green' : 'tag-muted') + '">' + (ev.results_released ? 'Results Released' : 'Active') + '</span></div></div>' +
      '<div class="info-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">' +
      '<div class="info-card" style="background:var(--bg-card);padding:12px;border-radius:8px;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Subjects</div><div style="font-weight:700;font-size:1.1rem;">' + subjects.length + '</div><div style="font-size:0.7rem;color:var(--text-muted);">' + subjects.join(', ') + '</div></div>' +
      '<div class="info-card" style="background:var(--bg-card);padding:12px;border-radius:8px;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Registrations</div><div style="font-weight:700;font-size:1.1rem;" id="mc-total-registrations">' + regs.length + '</div></div>' +
      '<div class="info-card" style="background:var(--bg-card);padding:12px;border-radius:8px;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Mocks Created</div><div style="font-weight:700;font-size:1.1rem;">' + eventMocks.length + '/' + subjects.length + '</div></div>' +
      '<div class="info-card" style="background:var(--bg-card);padding:12px;border-radius:8px;"><div style="font-size:0.65rem;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Keys Used</div><div style="font-weight:700;font-size:1.1rem;">' + usedKeys.length + '/' + keys.length + '</div></div></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">' +
      (subjects.map(s => '<button class="btn btn-sm ' + (eventMocks.find(m => m.subject === s) ? 'btn-primary' : 'btn-outline') + '" onclick="window._createMockForEvent(\'' + eventId + '\',\'' + s + '\')">' + s + '</button>').join('')) +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;">' +
      '<button class="btn btn-primary btn-sm" onclick="window._broadcastEventMocks(\'' + eventId + '\')">Broadcast Mocks</button>' +
      '<button class="btn btn-primary btn-sm" onclick="window._broadcastEventResults(\'' + eventId + '\')">Broadcast Results</button>' +
      '</div></div>';
  } catch (e) {
    detailArea.innerHTML = '<div style="color:#dc2626;padding:12px;">Error: ' + e.message + '</div>';
  }
};

window._createMockForEvent = async function(eventId, subject) {
  const timeLimit = parseInt(await showPrompt('Time limit (minutes):', '30')) || 30;
  const questionCount = parseInt(await showPrompt('Number of questions:', '10')) || 10;
  
  try {
    const mockId = await mocks.createMock({ eventId, subject, title: subject + ' Mock', timeLimit });
    // Create placeholder questions
    const questions = [];
    for (let i = 0; i < questionCount; i++) {
      questions.push({
        id: i + 1, question: 'Question ' + (i + 1) + ' for ' + subject + '?',
        options: ['Option A', 'Option B', 'Option C', 'Option D'],
        correctIndex: 0, explanation: ''
      });
    }
    await mocks.updateMockQuestions(mockId, questions);
    showAlert('Mock created: ' + subject);
    await window._openEventDetails(eventId);
  } catch (e) { showAlert('Error: ' + e.message); }
};

window._broadcastEventMocks = async function(eventId) {
  try {
    const eventMocks = await mocks.getEventMocks(eventId);
    if (eventMocks.length === 0) { showAlert('No mocks created for this event.'); return; }
    
    // Add to broadcast schedules
    const { default: schedules } = await import('../db/schedules.js');
    for (const mock of eventMocks) {
      await schedules.addBroadcastSchedule({
        type: 'mock_exam', title: mock.subject + ' Mock', course: mock.subject,
        mockId: mock.id, eventId, quizUrl: '/quiz?mockid=' + mock.id,
        timeLimit: mock.time_limit
      });
    }
    showAlert('Broadcasted ' + eventMocks.length + ' mock(s) to schedules.');
  } catch (e) { showAlert('Error: ' + e.message); }
};

window._broadcastEventResults = async function(eventId) {
  // Placeholder — will generate result sheets and add to inbox
  try {
    const regs = await events.getRegistrations(eventId);
    if (regs.length === 0) { showAlert('No registrations found.'); return; }
    // Mark event as results released
    await events.updateEvent(eventId, { resultsReleased: true });
    showAlert('Results broadcasted to ' + regs.length + ' students.');
    await window._openEventDetails(eventId);
  } catch (e) { showAlert('Error: ' + e.message); }
};
