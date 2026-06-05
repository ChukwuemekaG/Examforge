import { execOne, exec, execute, trackRead } from './client.js';

export async function getAdminPanel() {
  trackRead('admin_panel');
  let data = await execOne('SELECT * FROM admin_panel WHERE id = ?', { 1: 'data' });
  if (!data) {
    await execute('INSERT INTO admin_panel (id) VALUES (?)', { 1: 'data' });
    data = { courses: '[]', daily_quizzes: '[]', daily_advices: '[]', subscription_events: '[]', total_student_count: 0 };
  }
  // Parse JSON fields
  return {
    courses: JSON.parse(data.courses || '[]'),
    dailyQuizzes: JSON.parse(data.daily_quizzes || '[]'),
    dailyAdvices: JSON.parse(data.daily_advices || '[]'),
    subscriptionEvents: JSON.parse(data.subscription_events || '[]'),
    totalStudentCount: data.total_student_count || 0
  };
}

export async function updateAdminSection(section, data) {
  const field = section.replace(/([A-Z])/g, '_$1').toLowerCase();
  return execute(`UPDATE admin_panel SET ${field} = ?, updated_at = datetime('now') WHERE id = 'data'`,
    { 1: JSON.stringify(data) });
}

export async function updateAdminPanel(panel) {
  return execute(
    `UPDATE admin_panel SET courses = ?, daily_quizzes = ?, daily_advices = ?, subscription_events = ?, total_student_count = ?, updated_at = datetime('now')
     WHERE id = 'data'`,
    { 1: JSON.stringify(panel.courses || []), 2: JSON.stringify(panel.dailyQuizzes || []), 3: JSON.stringify(panel.dailyAdvices || []), 4: JSON.stringify(panel.subscriptionEvents || []), 5: panel.totalStudentCount || 0 }
  );
}
