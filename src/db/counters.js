import { execOne, exec, execute, trackRead } from './client.js';

export async function getCounter(name) {
  trackRead('counters/' + name);
  const row = await execOne('SELECT value FROM counters WHERE id = ?', [name]);
  return row?.value || 0;
}

export async function incrementCounter(name) {
  await execute(
    `INSERT INTO counters (id, value) VALUES (?, 1)
     ON CONFLICT(id) DO UPDATE SET value = value + 1`,
    [name]
  );
}

export async function setCounter(name, value) {
  await execute(
    `INSERT INTO counters (id, value) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET value = ?`,
    [name, value, value]
  );
}

export async function getUserCount() {
  const row = await execOne('SELECT COUNT(*) as count FROM users');
  return row?.count || 0;
}
