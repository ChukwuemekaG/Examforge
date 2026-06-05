import { execOne, exec, execute, trackRead } from './client.js';

export async function getAdminPanel() {
  trackRead('admin_panel');
  let data = await execOne('SELECT * FROM admin_panel WHERE id = ?', ['data']);
  if (!data) {
    await execute('INSERT INTO admin_panel (id) VALUES (?)', ['data']);
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
    [JSON.stringify(data)]);
}

export async function updateAdminPanel(panel) {
  return execute(
    `UPDATE admin_panel SET courses = ?, daily_quizzes = ?, daily_advices = ?, subscription_events = ?, total_student_count = ?, updated_at = datetime('now')
     WHERE id = 'data'`,
    [JSON.stringify(panel.courses || []), JSON.stringify(panel.dailyQuizzes || []), JSON.stringify(panel.dailyAdvices || []), JSON.stringify(panel.subscriptionEvents || []), panel.totalStudentCount || 0]
  );
}
