import { execOne, exec, execute, trackRead } from './client.js';

export async function getBroadcastSchedules(limit = 50) {
  trackRead('broadcast_schedules');
  return exec('SELECT * FROM broadcast_schedules ORDER BY created_at DESC LIMIT ?', [limit]);
}

export async function addBroadcastSchedule(item) {
  const id = item.id || 'bs_' + Date.now().toString(36);
  await execute(
    `INSERT INTO broadcast_schedules (id, type, title, course, mock_id, event_id, quiz_url, time_limit, due_date, due_time, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, item.type || 'mock_exam', item.title, item.course || '', item.mockId || null, item.eventId || null, item.quizUrl || null, item.timeLimit || null, item.dueDate || null, item.dueTime || null, item.message || '']
  );
  return id;
}

export async function clearBroadcastSchedules() {
  return execute('DELETE FROM broadcast_schedules');
}
