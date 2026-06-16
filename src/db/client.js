// Turso HTTP Database Client — v2/pipeline API (via proxy)

const TURSO_PROXY_URL = window.__TURSO_PROXY_URL || 'https://examforge-q88x.onrender.com/v2/pipeline';

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
