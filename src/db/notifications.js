import { execOne, exec, execute, trackRead } from './client.js';

export async function getBroadcastNotifications(limit = 50) {
  trackRead('broadcast_notifications');
  return exec('SELECT * FROM broadcast_notifications ORDER BY created_at DESC LIMIT ?', { 1: limit });
}

export async function addBroadcastNotification(notif) {
  const id = notif.id || 'bn_' + Date.now().toString(36);
  await execute(
    `INSERT INTO broadcast_notifications (id, type, title, message, quiz_url, brand_color, brand_icon)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    { 1: id, 2: notif.type || 'broadcast', 3: notif.title, 4: notif.message || '', 5: notif.quizUrl || null, 6: notif.brandColor || '#fe6961', 7: notif.brandIcon || 'notifications' }
  );
  return id;
}

export async function clearBroadcastNotifications() {
  return execute('DELETE FROM broadcast_notifications');
}
