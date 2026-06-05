import { execOne, exec, execute, trackRead } from './client.js';

export async function getBroadcastSchedules(limit = 50) {
  trackRead('broadcast_schedules');
  return exec('SELECT * FROM broadcast_schedules ORDER BY created_at DESC LIMIT ?', { 1: limit });
}

export async function addBroadcastSchedule(item) {
  const id = item.id || 'bs_' + Date.now().toString(36);
  await execute(
    `INSERT INTO broadcast_schedules (id, type, title, course, mock_id, event_id, quiz_url, time_limit, due_date, due_time, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: item.type || 'mock_exam', 3: item.title, 4: item.course || '', 5: item.mockId || null, 6: item.eventId || null, 7: item.quizUrl || null, 8: item.timeLimit || null, 9: item.dueDate || null, 10: item.dueTime || null, 11: item.message || '' }
  );
  return id;
}

export async function clearBroadcastSchedules() {
  return execute('DELETE FROM broadcast_schedules');
}
