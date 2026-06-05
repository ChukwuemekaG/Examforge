import { execOne, exec, execute, trackRead } from './client.js';

export async function getMock(id) {
  trackRead('mock_exams/' + id);
  return execOne('SELECT * FROM mock_exams WHERE id = ?', { 1: id });
}

export async function getEventMocks(eventId) {
  trackRead('mock_exams/event/' + eventId);
  return exec('SELECT * FROM mock_exams WHERE event_id = ?', { 1: eventId });
}

export async function createMock(mock) {
  const id = mock.id || 'mock_' + Date.now().toString(36);
  await execute(
    `INSERT INTO mock_exams (id, event_id, subject, title, time_limit)
     VALUES (?, ?, ?, ?, ?)`,
    { 1: id, 2: mock.eventId, 3: mock.subject, 4: mock.title || '', 5: mock.timeLimit || 0 }
  );
  return id;
}

export async function updateMockQuestions(id, questions) {
  return execute('UPDATE mock_exams SET questions = ? WHERE id = ?',
    { 1: JSON.stringify(questions), 2: id });
}

export async function deleteMock(id) {
  await execute('DELETE FROM mock_exam_attempts WHERE mock_id = ?', { 1: id });
  return execute('DELETE FROM mock_exams WHERE id = ?', { 1: id });
}

// Attempts
export async function getMockAttempts(mockId) {
  trackRead('mock_exam_attempts/' + mockId);
  return exec('SELECT * FROM mock_exam_attempts WHERE mock_id = ?', { 1: mockId });
}

export async function saveMockAttempt(mockId, attempt) {
  return execute(
    `INSERT INTO mock_exam_attempts (mock_id, user_id, display_name, email, score, correct, total, time_taken, answers, browser_agent, platform, screen_resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: mockId, 2: attempt.uid, 3: attempt.displayName || '', 4: attempt.email || '', 5: attempt.score || 0, 6: attempt.correct || 0, 7: attempt.total || 0, 8: attempt.timeTaken || 0, 9: JSON.stringify(attempt.answers || []), 10: attempt.browserAgent || '', 11: attempt.platform || '', 12: attempt.screenResolution || '' }
  );
}
