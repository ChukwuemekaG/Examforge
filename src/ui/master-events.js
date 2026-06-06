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
  // Open a modal with full event creation form
  const overlay = document.createElement('div');
  overlay.id = 'ef-custom-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  overlay.innerHTML = '<div class="card" style="max-width:650px;width:95%;padding:24px;border-radius:16px;max-height:90vh;overflow-y:auto;">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;"><div style="font-weight:800;font-size:1.2rem;">Create Subscription Event</div><button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'ef-custom-modal\').remove()" style="padding:4px;"><span class="material-icons-round">close</span></button></div>' +
    '<div style="margin-bottom:12px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Event Title</label><input id="ev-title" placeholder="Enter event title..." style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '<div style="margin-bottom:12px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Description (optional)</label><textarea id="ev-desc" placeholder="Event description..." style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.85rem;min-height:60px;resize:vertical;font-family:inherit;"></textarea></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">' +
    '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Max Subjects Per Student</label><input id="ev-maxsubjects" type="number" value="4" min="1" max="20" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Registration Keys to Generate</label><input id="ev-keycount" type="number" value="10" min="0" max="500" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '</div>' +
    '<div style="margin-bottom:12px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:6px;">Available Subjects</label>' +
    '<div id="ev-subjects-area"><div style="text-align:center;padding:12px;color:var(--text-muted);font-size:0.85rem;">No subjects added yet.</div></div>' +
    '<div style="display:flex;gap:6px;margin-top:6px;"><input id="ev-new-subject" placeholder="Add a subject..." style="flex:1;padding:8px 10px;border-radius:6px;border:1px solid var(--border);font-size:0.85rem;"><button class="btn btn-primary btn-sm" onclick="window._addEventSubject()" style="white-space:nowrap;">Add</button></div></div>' +
    '<div style="margin-top:20px;display:flex;gap:12px;">' +
    '<button class="btn btn-primary" onclick="window._saveEvent()" style="flex:1;">Create Event</button>' +
    '<button class="btn btn-ghost" onclick="document.getElementById(\'ef-custom-modal\').remove()" style="flex:1;">Cancel</button></div></div>';
  document.body.appendChild(overlay);
  // Focus on title input
  setTimeout(() => document.getElementById('ev-title')?.focus(), 100);
};

// Track subjects being built
window._evSubjects = [];

window._addEventSubject = function() {
  const input = document.getElementById('ev-new-subject');
  const name = input?.value?.trim();
  if (!name) return;
  if (window._evSubjects.includes(name)) { showAlert('Subject already added.', 'Duplicate'); return; }
  
  window._evSubjects.push(name);
  input.value = '';
  input.focus();
  
  renderEventSubjects();
};

function renderEventSubjects() {
  const area = document.getElementById('ev-subjects-area');
  if (!area) return;
  
  if (window._evSubjects.length === 0) {
    area.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:0.85rem;">No subjects added yet.</div>';
    return;
  }
  
  area.innerHTML = window._evSubjects.map((s, idx) => 
    '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg-inset);border-radius:6px;margin-bottom:4px;border:1px solid var(--border);">' +
    '<span style="font-weight:600;font-size:0.85rem;">' + s + '</span>' +
    '<button class="btn btn-ghost btn-sm" onclick="window._removeEventSubject(' + idx + ')" style="padding:2px 6px;color:#dc2626;font-size:0.8rem;">✕</button></div>'
  ).join('');
}

window._removeEventSubject = function(idx) {
  window._evSubjects.splice(idx, 1);
  renderEventSubjects();
};

window._saveEvent = async function() {
  const title = document.getElementById('ev-title')?.value?.trim();
  if (!title) { showAlert('Please enter an event title.', 'Missing Field'); return; }
  const description = document.getElementById('ev-desc')?.value?.trim() || '';
  const maxSubjects = parseInt(document.getElementById('ev-maxsubjects')?.value) || 4;
  const keyCount = parseInt(document.getElementById('ev-keycount')?.value) || 0;
  
  if (window._evSubjects.length === 0) { showAlert('Please add at least one subject.', 'Missing Subjects'); return; }
  
  try {
    const id = await events.createEvent({ 
      title, 
      description, 
      availableSubjects: [...window._evSubjects], 
      maxSubjects 
    });
    
    // Generate registration keys
    for (let i = 0; i < keyCount; i++) {
      const key = 'KEY-' + id.slice(-4).toUpperCase() + '-' + String(i + 1).padStart(3, '0');
      await events.createEventKey(id, key);
    }
    
    const subjectCount = window._evSubjects.length;
    document.getElementById('ef-custom-modal').remove();
    window._evSubjects = [];
    showAlert('Event created with ' + subjectCount + ' subjects and ' + keyCount + ' keys!', 'Success');
    const container = document.getElementById('master-tab-content');
    if (container) await renderMasterEvents(container);
  } catch (e) { showAlert('Error: ' + e.message, 'Error'); }
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
  const overlay = document.createElement('div');
  overlay.id = 'ef-custom-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:9999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);';
  overlay.innerHTML = '<div class="card" style="max-width:500px;width:95%;padding:24px;border-radius:16px;">' +
    '<div style="font-weight:800;font-size:1.2rem;margin-bottom:16px;">Create Mock — <span style="color:var(--primary);">' + subject + '</span></div>' +
    '<div style="margin-bottom:12px;"><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Mock Title</label><input id="mk-title" value="' + subject + ' Mock" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;">' +
    '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Time Limit (minutes)</label><input id="mk-time" type="number" value="30" min="1" max="300" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '<div><label style="font-weight:700;font-size:0.8rem;display:block;margin-bottom:4px;">Number of Questions</label><input id="mk-questions" type="number" value="10" min="1" max="200" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border);font-size:0.9rem;"></div>' +
    '</div>' +
    '<div style="display:flex;gap:12px;">' +
    '<button class="btn btn-primary" onclick="window._saveEventMock(\'' + eventId + '\',\'' + subject + '\')" style="flex:1;">Create Mock</button>' +
    '<button class="btn btn-ghost" onclick="document.getElementById(\'ef-custom-modal\').remove()" style="flex:1;">Cancel</button></div></div>';
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById('mk-title')?.focus(), 100);
};

window._saveEventMock = async function(eventId, subject) {
  const title = document.getElementById('mk-title')?.value?.trim();
  if (!title) { showAlert('Please enter a mock title.', 'Missing Field'); return; }
  const timeLimit = parseInt(document.getElementById('mk-time')?.value) || 30;
  const questionCount = parseInt(document.getElementById('mk-questions')?.value) || 10;
  
  try {
    const mockId = await mocks.createMock({ eventId, subject, title, timeLimit });
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
    
    document.getElementById('ef-custom-modal').remove();
    showAlert('Mock created: ' + subject + ' (' + questionCount + ' questions)', 'Success');
    await window._openEventDetails(eventId);
  } catch (e) { showAlert('Error: ' + e.message, 'Error'); }
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
