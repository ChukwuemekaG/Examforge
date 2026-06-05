import { execOne, exec, execute, trackRead } from './client.js';

// Get user by ID
export async function getUser(id) {
  trackRead('users/' + id);
  return execOne('SELECT * FROM users WHERE id = ?', [id]);
}

// Get user by email
export async function getUserByEmail(email) {
  return execOne('SELECT * FROM users WHERE email = ?', [email]);
}

// Create new user
export async function createUser(user) {
  return execute(
    `INSERT INTO users (id, email, display_name, username, provider, exa_rating, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    [user.id, user.email, user.displayName || '', user.username || '', user.provider || 'password', user.exaRating || 800, user.role || 'student']
  );
}

// Update user fields
export async function updateUser(id, fields) {
  const setClauses = [];
  const args = [];
  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    setClauses.push(`${col} = ?`);
    args.push(val);
  }
  setClauses.push("updated_at = datetime('now')");
  args.push(id);
  return execute(`UPDATE users SET ${setClauses.join(', ')} WHERE id = ?`, args);
}

// Update specific fields with JSON serialization for arrays
export async function updateUserData(id, data) {
  const fields = {};
  if (data.exaRating !== undefined) fields.exa_rating = data.exaRating;
  if (data.streak !== undefined) fields.streak = data.streak;
  if (data.highestStreak !== undefined) fields.highest_streak = data.highestStreak;
  if (data.lastExamDate !== undefined) fields.last_exam_date = data.lastExamDate;
  if (data.displayName !== undefined) fields.display_name = data.displayName;
  if (data.fcmToken !== undefined) fields.fcm_token = data.fcmToken;
  if (data.totalUsers !== undefined) fields.total_users = data.totalUsers;
  return updateUser(id, fields);
}

// Add inbox item
export async function addInboxItem(userId, item) {
  const id = item.id || 'inbox_' + Date.now().toString(36);
  await execute(
    `INSERT INTO user_inbox (id, user_id, type, title, message, result_id, event_id, quiz_url, action_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, item.type || 'info', item.title, item.message || '', item.resultId || null, item.eventId || null, item.quizUrl || null, item.actionPath || null]
  );
  return id;
}

// Get inbox items
export async function getInboxItems(userId, limit = 50) {
  trackRead('user_inbox/' + userId);
  return exec('SELECT * FROM user_inbox WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

// Delete inbox item
export async function deleteInboxItem(id) {
  return execute('DELETE FROM user_inbox WHERE id = ?', [id]);
}

// Clear all inbox items for user
export async function clearInbox(userId) {
  return execute('DELETE FROM user_inbox WHERE user_id = ?', [userId]);
}

// Add schedule item
export async function addScheduleItem(userId, item) {
  const id = item.id || 'sched_' + Date.now().toString(36);
  await execute(
    `INSERT INTO user_schedule (id, user_id, title, type, course, mock_id, event_id, quiz_url, time_limit, due_date, due_time, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, item.title, item.type || 'study', item.course || null, item.mockId || null, item.eventId || null, item.quizUrl || null, item.timeLimit || null, item.dueDate || null, item.dueTime || null, item.message || '']
  );
  return id;
}

// Get schedule items
export async function getScheduleItems(userId) {
  trackRead('user_schedule/' + userId);
  return exec('SELECT * FROM user_schedule WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT 50', [userId]);
}

// Delete schedule item
export async function deleteScheduleItem(id) {
  return execute('DELETE FROM user_schedule WHERE id = ?', [id]);
}

// Dismiss schedule item
export async function dismissScheduleItem(id) {
  return execute('UPDATE user_schedule SET dismissed = 1 WHERE id = ?', [id]);
}

// Add result
export async function addResult(userId, result) {
  const id = result.id || 'res_' + Date.now().toString(36);
  await execute(
    `INSERT INTO user_results (id, user_id, quiz_id, course, score, total, grade, correct, total_questions, time_taken, exa_change, is_retake, is_mock, corrections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, result.quizId || '', result.course || '', result.score || 0, result.total || 100, result.grade || 'F', result.correct || 0, result.totalQuestions || 0, result.timeTaken || 0, result.exaChange || 0, result.isRetake ? 1 : 0, result.isMock ? 1 : 0, JSON.stringify(result.corrections || [])]
  );
  return id;
}

// Get recent results
export async function getRecentResults(userId, limit = 50) {
  trackRead('user_results/' + userId);
  return exec('SELECT * FROM user_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', [userId, limit]);
}

// Get username mapping
export async function getUsername(username) {
  return execOne('SELECT * FROM usernames WHERE username = ?', [username]);
}

// Create username mapping
export async function createUsername(username, userId, email) {
  return execute('INSERT INTO usernames (username, user_id, email) VALUES (?, ?, ?)', [username, userId, email]);
}

// Get all students count
export async function getStudentCount() {
  trackRead('users/count');
  const row = await execOne('SELECT COUNT(*) as count FROM users WHERE role = ?', ['student']);
  return row?.count || 0;
}

// Get all users (admin)
export async function getAllUsers(limit = 200) {
  trackRead('users/all');
  return exec('SELECT * FROM users ORDER BY created_at DESC LIMIT ?', [limit]);
}

// Search users
export async function searchUsers(query, limit = 20) {
  const like = '%' + query + '%';
  return exec('SELECT * FROM users WHERE display_name LIKE ? OR email LIKE ? OR username LIKE ? LIMIT ?',
    [like, like, like, limit]);
}
