// Turso HTTP Database Client via Cloudflare Worker proxy

// ⚠️ IMPORTANT: Replace this with your Cloudflare Worker URL after deploying
const TURSO_PROXY_URL = 'https://examforge-turso-proxy.your-subdomain.workers.dev/v2/pipeline';

// Internal read tracking
window.__efReads = 0;
window.__efReadBudget = 10;
window.__efWrites = 0;

export function trackRead(label) {
  if (window.__efReads >= window.__efReadBudget) {
    console.warn(`[DB] Budget exhausted (${window.__efReads}/${window.__efReadBudget})`);
    return true;
  }
  window.__efReads++;
  console.log(`[DB] Read ${window.__efReads}/${window.__efReadBudget}: ${label}`);
  return false;
}

export function trackWrite() {
  window.__efWrites++;
}

export function getReadsUsed() { return window.__efReads; }
export function getWritesUsed() { return window.__efWrites; }
export function resetBudget() { window.__efReads = 0; }

async function request(sql, args = {}) {
  const body = {
    requests: [
      { type: 'execute', stmt: { sql, args } },
      { type: 'close' }
    ]
  };

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
  const result = data.results?.[0]?.response?.result;
  if (!result) throw new Error('Turso: empty response');
  if (data.results?.[0]?.type === 'error') {
    throw new Error(`Turso: ${data.results[0].response?.error?.message || 'query error'}`);
  }

  return result;
}

export async function exec(sql, args = {}) {
  const result = await request(sql, args);
  if (!result || !result.columns) return [];
  const cols = result.columns;
  return (result.rows || []).map(row => {
    const obj = {};
    cols.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

export async function execOne(sql, args = {}) {
  const rows = await exec(sql, args);
  return rows.length > 0 ? rows[0] : null;
}

export async function execute(sql, args = {}) {
  trackWrite();
  const result = await request(sql, args);
  return {
    affectedRows: result.affected_row_count || 0,
    lastInsertId: result.last_insert_rowid
  };
}
