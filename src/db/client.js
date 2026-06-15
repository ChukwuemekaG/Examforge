// Turso HTTP Database Client — v2/pipeline API (direct connection)

const TURSO_URL = 'https://examforge-chukwuemekagodson.aws-us-east-2.turso.io';
const TURSO_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicm93IiwiaWF0IjoxNzI1MTM1Njk1LCJpZCI6Ijg4YmM5NTQwLWU5NjktMTFlYy04YjJhLTAzNzFhZGNlOTU4YiJ9.wRgSw8ZzRGHK-WQ9uZ55HMclMSWZgQ8gz7_4ISjePA60Zk6qW6Y7RE-4Zx4EzQB3XbFFEDQYOsy6qo9VfPYzDg';

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

// Convert typed row values to raw values
function untype(row) {
  if (!row || !Array.isArray(row)) return row;
  return row.map(cell => {
    if (cell && typeof cell === 'object' && 'type' in cell && 'value' in cell) {
      return cell.value;
    }
    return cell;
  });
}

async function request(sql, params = []) {
  const body = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql,
          args: params.length > 0
            ? params.map(v => ({ type: typeof v === 'number' ? 'integer' : 'text', value: String(v) }))
            : []
        }
      },
      { type: 'close' }
    ]
  };

  const res = await fetch(`${TURSO_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TURSO_TOKEN}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Turso error (${res.status}): ${text}`);
  }

  const data = await res.json();
  const execResult = data?.results?.[0];
  
  if (execResult?.type === 'error') {
    throw new Error(`Turso: ${execResult?.error?.message || JSON.stringify(execResult).slice(0, 200)}`);
  }
  
  const result = execResult?.response?.result;
  if (!result) throw new Error('Turso: empty response');
  
  return result;
}

export async function exec(sql, params = []) {
  const result = await request(sql, params);
  if (!result || !result.cols) return [];
  
  const cols = result.cols.map(c => c.name);
  const rows = result.rows || [];
  
  return rows.map(row => {
    const rawRow = untype(row);
    const obj = {};
    cols.forEach((col, i) => { obj[col] = rawRow[i]; });
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
    affectedRows: result.affected_row_count || 0,
    lastInsertId: result.last_insert_rowid
  };
}

export async function batch(statements) {
  const results = [];
  for (const stmt of statements) {
    try {
      const sql = stmt.sql || stmt;
      const params = stmt.params || [];
      const result = await request(sql, params);
      results.push({ results: { cols: result.cols || [], rows: result.rows || [] } });
    } catch (e) {
      results.push({ error: e.message });
    }
  }
  return results;
}
