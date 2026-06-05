import { execOne, exec, execute, trackRead } from './client.js';

export async function getAllAdvices() {
  trackRead('daily_advices/all');
  return exec('SELECT * FROM daily_advices ORDER BY created_at DESC');
}

export async function getAdvice(id) {
  return execOne('SELECT * FROM daily_advices WHERE id = ?', [id]);
}

export async function createAdvice(advice) {
  const id = advice.id || 'adv_' + Date.now().toString(36);
  await execute('INSERT INTO daily_advices (id, title, category, content) VALUES (?, ?, ?, ?)',
    [id, advice.title, advice.category || '', advice.content || '']);
  return id;
}

export async function deleteAdvice(id) {
  return execute('DELETE FROM daily_advices WHERE id = ?', [id]);
}
