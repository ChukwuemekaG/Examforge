import { execOne, exec, execute, trackRead } from './client.js';

export async function getAllEvents() {
  trackRead('subscription_events/all');
  return exec('SELECT * FROM subscription_events ORDER BY created_at DESC');
}

export async function getEvent(id) {
  trackRead('subscription_events/' + id);
  return execOne('SELECT * FROM subscription_events WHERE id = ?', [id]);
}

export async function createEvent(event) {
  const id = event.id || 'ev_' + Date.now().toString(36);
  const subjects = JSON.stringify(event.availableSubjects || []);
  await execute(
    `INSERT INTO subscription_events (id, title, description, available_subjects, max_subjects, results_released)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, event.title, event.description || '', subjects, event.maxSubjects || 0, event.resultsReleased ? 1 : 0]
  );
  return id;
}

export async function updateEvent(id, fields) {
  const sets = []; const args = [];
  if (fields.title !== undefined) { sets.push('title = ?'); args.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); args.push(fields.description); }
  if (fields.availableSubjects !== undefined) { sets.push('available_subjects = ?'); args.push(JSON.stringify(fields.availableSubjects)); }
  if (fields.maxSubjects !== undefined) { sets.push('max_subjects = ?'); args.push(fields.maxSubjects); }
  if (fields.resultsReleased !== undefined) { sets.push('results_released = ?'); args.push(fields.resultsReleased ? 1 : 0); }
  if (sets.length === 0) return;
  args.push(id);
  return execute(`UPDATE subscription_events SET ${sets.join(', ')} WHERE id = ?`, args);
}

export async function deleteEvent(id) {
  await execute('DELETE FROM event_registrations WHERE event_id = ?', [id]);
  await execute('DELETE FROM event_keys WHERE event_id = ?', [id]);
  return execute('DELETE FROM subscription_events WHERE id = ?', [id]);
}

// Registrations
export async function getRegistrations(eventId) {
  trackRead('event_registrations/' + eventId);
  return exec('SELECT * FROM event_registrations WHERE event_id = ?', [eventId]);
}

export async function registerStudent(eventId, student) {
  await execute(
    `INSERT INTO event_registrations (event_id, user_id, display_name, email, subjects)
     VALUES (?, ?, ?, ?, ?)`,
    [eventId, student.uid, student.displayName || '', student.email || '', JSON.stringify(student.subjects || [])]
  );
}

export async function updateStudentScore(eventId, userId, scoreData) {
  return execute(
    `UPDATE event_registrations SET score = ?, correct = ?, total_questions = ?, time_taken = ?, submitted_at = datetime('now')
     WHERE event_id = ? AND user_id = ?`,
    [scoreData.score || 0, scoreData.correct || 0, scoreData.totalQuestions || 0, scoreData.timeTaken || 0, eventId, userId]
  );
}

export async function getStudentRegistration(eventId, userId) {
  return execOne('SELECT * FROM event_registrations WHERE event_id = ? AND user_id = ?', [eventId, userId]);
}

// Keys
export async function validateKey(eventId, key) {
  return execOne('SELECT * FROM event_keys WHERE id = ? AND event_id = ? AND used_by IS NULL', [key, eventId]);
}

export async function useKey(eventId, key, userId) {
  return execute("UPDATE event_keys SET used_by = ?, used_at = datetime('now') WHERE id = ? AND event_id = ?", [userId, key, eventId]);
}

export async function getEventKeys(eventId) {
  return exec('SELECT * FROM event_keys WHERE event_id = ?', [eventId]);
}

export async function createEventKey(eventId, key) {
  return execute('INSERT INTO event_keys (id, event_id) VALUES (?, ?)', [key, eventId]);
}
