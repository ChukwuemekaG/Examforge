// Turso HTTP Database Client

const TURSO_PROXY_URL = 'https://examforge-turso-proxy.godsonchukwuemeka595.workers.dev';

window.__efReads = 0;
window.__efReadBudget = 10;
window.__efWrites = 0;

export function trackRead(label) {
  if (window.__efReads >= window.__efReadBudget) return true;
  window.__efReads++;
  console.log(`[DB] Read ${window.__efReads}/${window.__efReadBudget}: ${label}`);
  return false;
}

export function trackWrite() { window.__efWrites++; }
export function getReadsUsed() { return window.__efReads; }
export function getWritesUsed() { return window.__efWrites; }
export function resetBudget() { window.__efReads = 0; }

async function request(sql, params = []) {
  const body = { sql, args: params };

  const res = await fetch(TURSO_PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Turso error (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Turso: ${data.error}`);
  if (!data.results) throw new Error('Turso: empty response');

  return data.results;
}

export async function exec(sql, params = []) {
  const result = await request(sql, params);
  if (!result || !result.columns) return [];
  const cols = result.columns;
  return (result.rows || []).map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export async function execOne(sql, params = []) {
  const rows = await exec(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function execute(sql, params = []) {
  trackWrite();
  const result = await request(sql, params);
  return {
    affectedRows: result.rows_written || result.affected_row_count || 0,
    lastInsertId: result.last_insert_rowid || null
  };
}

// Batch multiple SQL statements — executes one by one
export async function batch(statements) {
  const results = [];
  for (const stmt of statements) {
    try {
      const sql = stmt.sql || stmt;
      const params = stmt.params || [];
      const result = await request(sql, params);
      results.push({ results: result });
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  return results;
}
