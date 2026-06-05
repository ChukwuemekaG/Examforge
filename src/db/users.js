import { execOne, exec, execute, trackRead } from './client.js';

// Get user by ID
export async function getUser(id) {
  trackRead('users/' + id);
  return execOne('SELECT * FROM users WHERE id = ?', { 1: id });
}

// Get user by email
export async function getUserByEmail(email) {
  return execOne('SELECT * FROM users WHERE email = ?', { 1: email });
}

// Create new user
export async function createUser(user) {
  return execute(
    `INSERT INTO users (id, email, display_name, username, provider, exa_rating, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    { 1: user.id, 2: user.email, 3: user.displayName || '', 4: user.username || '', 5: user.provider || 'password', 6: user.exaRating || 800, 7: user.role || 'student' }
  );
}

// Update user fields
export async function updateUser(id, fields) {
  const setClauses = [];
  const args = {};
  let idx = 1;
  for (const [key, val] of Object.entries(fields)) {
    const col = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    setClauses.push(`${col} = ?`);
    args[idx++] = val;
  }
  setClauses.push("updated_at = datetime('now')");
  args[idx++] = id;
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
    { 1: id, 2: userId, 3: item.type || 'info', 4: item.title, 5: item.message || '', 6: item.resultId || null, 7: item.eventId || null, 8: item.quizUrl || null, 9: item.actionPath || null }
  );
  return id;
}

// Get inbox items
export async function getInboxItems(userId, limit = 50) {
  trackRead('user_inbox/' + userId);
  return exec('SELECT * FROM user_inbox WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', { 1: userId, 2: limit });
}

// Delete inbox item
export async function deleteInboxItem(id) {
  return execute('DELETE FROM user_inbox WHERE id = ?', { 1: id });
}

// Clear all inbox items for user
export async function clearInbox(userId) {
  return execute('DELETE FROM user_inbox WHERE user_id = ?', { 1: userId });
}

// Add schedule item
export async function addScheduleItem(userId, item) {
  const id = item.id || 'sched_' + Date.now().toString(36);
  await execute(
    `INSERT INTO user_schedule (id, user_id, title, type, course, mock_id, event_id, quiz_url, time_limit, due_date, due_time, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: userId, 3: item.title, 4: item.type || 'study', 5: item.course || null, 6: item.mockId || null, 7: item.eventId || null, 8: item.quizUrl || null, 9: item.timeLimit || null, 10: item.dueDate || null, 11: item.dueTime || null, 12: item.message || '' }
  );
  return id;
}

// Get schedule items
export async function getScheduleItems(userId) {
  trackRead('user_schedule/' + userId);
  return exec('SELECT * FROM user_schedule WHERE user_id = ? AND dismissed = 0 ORDER BY created_at DESC LIMIT 50', { 1: userId });
}

// Delete schedule item
export async function deleteScheduleItem(id) {
  return execute('DELETE FROM user_schedule WHERE id = ?', { 1: id });
}

// Dismiss schedule item
export async function dismissScheduleItem(id) {
  return execute('UPDATE user_schedule SET dismissed = 1 WHERE id = ?', { 1: id });
}

// Add result
export async function addResult(userId, result) {
  const id = result.id || 'res_' + Date.now().toString(36);
  await execute(
    `INSERT INTO user_results (id, user_id, quiz_id, course, score, total, grade, correct, total_questions, time_taken, exa_change, is_retake, is_mock, corrections)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: userId, 3: result.quizId || '', 4: result.course || '', 5: result.score || 0, 6: result.total || 100, 7: result.grade || 'F', 8: result.correct || 0, 9: result.totalQuestions || 0, 10: result.timeTaken || 0, 11: result.exaChange || 0, 12: result.isRetake ? 1 : 0, 13: result.isMock ? 1 : 0, 14: JSON.stringify(result.corrections || []) }
  );
  return id;
}

// Get recent results
export async function getRecentResults(userId, limit = 50) {
  trackRead('user_results/' + userId);
  return exec('SELECT * FROM user_results WHERE user_id = ? ORDER BY created_at DESC LIMIT ?', { 1: userId, 2: limit });
}

// Get username mapping
export async function getUsername(username) {
  return execOne('SELECT * FROM usernames WHERE username = ?', { 1: username });
}

// Create username mapping
export async function createUsername(username, userId, email) {
  return execute('INSERT INTO usernames (username, user_id, email) VALUES (?, ?, ?)', { 1: username, 2: userId, 3: email });
}

// Get all students count
export async function getStudentCount() {
  trackRead('users/count');
  const row = await execOne('SELECT COUNT(*) as count FROM users WHERE role = ?', { 1: 'student' });
  return row?.count || 0;
}

// Get all users (admin)
export async function getAllUsers(limit = 200) {
  trackRead('users/all');
  return exec('SELECT * FROM users ORDER BY created_at DESC LIMIT ?', { 1: limit });
}

// Search users
export async function searchUsers(query, limit = 20) {
  const like = '%' + query + '%';
  return exec('SELECT * FROM users WHERE display_name LIKE ? OR email LIKE ? OR username LIKE ? LIMIT ?',
    { 1: like, 2: like, 3: like, 4: limit });
}
