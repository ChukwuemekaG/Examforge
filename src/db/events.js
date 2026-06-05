import { execOne, exec, execute, trackRead } from './client.js';

export async function getAllEvents() {
  trackRead('subscription_events/all');
  return exec('SELECT * FROM subscription_events ORDER BY created_at DESC');
}

export async function getEvent(id) {
  trackRead('subscription_events/' + id);
  return execOne('SELECT * FROM subscription_events WHERE id = ?', { 1: id });
}

export async function createEvent(event) {
  const id = event.id || 'ev_' + Date.now().toString(36);
  const subjects = JSON.stringify(event.availableSubjects || []);
  await execute(
    `INSERT INTO subscription_events (id, title, description, available_subjects, max_subjects, results_released)
     VALUES (?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: event.title, 3: event.description || '', 4: subjects, 5: event.maxSubjects || 0, 6: event.resultsReleased ? 1 : 0 }
  );
  return id;
}

export async function updateEvent(id, fields) {
  const sets = []; const args = {}; let idx = 1;
  if (fields.title !== undefined) { sets.push('title = ?'); args[idx++] = fields.title; }
  if (fields.description !== undefined) { sets.push('description = ?'); args[idx++] = fields.description; }
  if (fields.availableSubjects !== undefined) { sets.push('available_subjects = ?'); args[idx++] = JSON.stringify(fields.availableSubjects); }
  if (fields.maxSubjects !== undefined) { sets.push('max_subjects = ?'); args[idx++] = fields.maxSubjects; }
  if (fields.resultsReleased !== undefined) { sets.push('results_released = ?'); args[idx++] = fields.resultsReleased ? 1 : 0; }
  if (sets.length === 0) return;
  args[idx++] = id;
  return execute(`UPDATE subscription_events SET ${sets.join(', ')} WHERE id = ?`, args);
}

export async function deleteEvent(id) {
  await execute('DELETE FROM event_registrations WHERE event_id = ?', { 1: id });
  await execute('DELETE FROM event_keys WHERE event_id = ?', { 1: id });
  return execute('DELETE FROM subscription_events WHERE id = ?', { 1: id });
}

// Registrations
export async function getRegistrations(eventId) {
  trackRead('event_registrations/' + eventId);
  return exec('SELECT * FROM event_registrations WHERE event_id = ?', { 1: eventId });
}

export async function registerStudent(eventId, student) {
  await execute(
    `INSERT INTO event_registrations (event_id, user_id, display_name, email, subjects)
     VALUES (?, ?, ?, ?, ?)`,
    { 1: eventId, 2: student.uid, 3: student.displayName || '', 4: student.email || '', 5: JSON.stringify(student.subjects || []) }
  );
}

export async function updateStudentScore(eventId, userId, scoreData) {
  return execute(
    `UPDATE event_registrations SET score = ?, correct = ?, total_questions = ?, time_taken = ?, submitted_at = datetime('now')
     WHERE event_id = ? AND user_id = ?`,
    { 1: scoreData.score || 0, 2: scoreData.correct || 0, 3: scoreData.totalQuestions || 0, 4: scoreData.timeTaken || 0, 5: eventId, 6: userId }
  );
}

export async function getStudentRegistration(eventId, userId) {
  return execOne('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?', { 1: eventId, 2: userId });
}

// Keys
export async function validateKey(eventId, key) {
  return execOne('SELECT * FROM event_keys WHERE id = ? AND event_id = ? AND used_by IS NULL', { 1: key, 2: eventId });
}

export async function useKey(eventId, key, userId) {
  return execute('UPDATE event_keys SET used_by = ?, used_at = datetime(\'now\') WHERE id = ? AND event_id = ?', { 1: userId, 2: key, 3: eventId });
}

export async function getEventKeys(eventId) {
  return exec('SELECT * FROM event_keys WHERE event_id = ?', { 1: eventId });
}

export async function createEventKey(eventId, key) {
  return execute('INSERT INTO event_keys (id, event_id) VALUES (?, ?)', { 1: key, 2: eventId });
}
