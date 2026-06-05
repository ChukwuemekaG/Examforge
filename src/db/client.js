// Turso HTTP Database Client
// Uses the libsql HTTP pipeline API

const TURSO_URL = 'https://examforge-chukwuemekagodson.aws-us-east-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODA2NzY1NzEsImlkIjoiMDE5ZTk4OTYtYmQwMS03ZjM0LWExYTMtNzNkYzZiZjg2OWI0IiwicmlkIjoiNWM4M2NlN2QtYmMyOC00NzE5LWI1NjUtZTNhMzRlNzAxNzE5In0.xbL2U_ccoauF-kteJ3WvQMcVeGrl2vW9ND8XJ8ajMpopVIPAEVdbGdvpwNCqbtjIwFsYCfiJN_lcd1Mk9281Ag';

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
  
  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
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

// Execute a query and return rows as objects
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

// Execute a query and return first row or null
export async function execOne(sql, args = {}) {
  const rows = await exec(sql, args);
  return rows.length > 0 ? rows[0] : null;
}

// Execute a write query (INSERT/UPDATE/DELETE)
export async function execute(sql, args = {}) {
  trackWrite();
  const result = await request(sql, args);
  return {
    affectedRows: result.affected_row_count || 0,
    lastInsertId: result.last_insert_rowid
  };
}

// Batch multiple SQL statements in one request
export async function batch(statements) {
  const body = {
    requests: statements.map(s => ({
      type: 'execute',
      stmt: { sql: s.sql, args: s.args || {} }
    })).concat({ type: 'close' })
  };

  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Turso batch error: ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, -1).map(r => r.response?.result);
}
