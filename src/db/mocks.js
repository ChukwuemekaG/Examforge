import { execOne, exec, execute, trackRead } from './client.js';

export async function getMock(id) {
  trackRead('mock_exams/' + id);
  return execOne('SELECT * FROM mock_exams WHERE id = ?', [id]);
}

export async function getEventMocks(eventId) {
  trackRead('mock_exams/event/' + eventId);
  return exec('SELECT * FROM mock_exams WHERE event_id = ?', [eventId]);
}

export async function createMock(mock) {
  const id = mock.id || 'mock_' + Date.now().toString(36);
  await execute(
    `INSERT INTO mock_exams (id, event_id, subject, title, time_limit)
     VALUES (?, ?, ?, ?, ?)`,
    [id, mock.eventId, mock.subject, mock.title || '', mock.timeLimit || 0]
  );
  return id;
}

export async function updateMockQuestions(id, questions) {
  return execute('UPDATE mock_exams SET questions = ? WHERE id = ?',
    [JSON.stringify(questions), id]);
}

export async function deleteMock(id) {
  await execute('DELETE FROM mock_exam_attempts WHERE mock_id = ?', [id]);
  return execute('DELETE FROM mock_exams WHERE id = ?', [id]);
}

// Attempts
export async function getMockAttempts(mockId) {
  trackRead('mock_exam_attempts/' + mockId);
  return exec('SELECT * FROM mock_exam_attempts WHERE mock_id = ?', [mockId]);
}

export async function saveMockAttempt(mockId, attempt) {
  return execute(
    `INSERT INTO mock_exam_attempts (mock_id, user_id, display_name, email, score, correct, total, time_taken, answers, browser_agent, platform, screen_resolution)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [mockId, attempt.uid, attempt.displayName || '', attempt.email || '', attempt.score || 0, attempt.correct || 0, attempt.total || 0, attempt.timeTaken || 0, JSON.stringify(attempt.answers || []), attempt.browserAgent || '', attempt.platform || '', attempt.screenResolution || '']
  );
}
