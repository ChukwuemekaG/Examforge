// Generate unique ID
export function generateId(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Format date
export function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

// Format time
export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// Shuffle array
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Clamp value
export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// Debounce
export function debounce(fn, ms = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Parse JSON safely
export function parseJSON(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

// Convert camelCase to snake_case
export function camelToSnake(str) {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

// Deep clone
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Pluralize
export function pluralize(count, singular, plural) {
  return count === 1 ? singular : (plural || singular + 's');
}

// Truncate text
export function truncate(text, max = 100) {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '...';
}

// Get URL parameter
export function getURLParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

// Escape HTML
export function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
}

// Show modal (simple alert replacement)
export function showModal(title, message, cb) {
  const existing = document.getElementById('ef-custom-modal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ef-custom-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px);';
  overlay.innerHTML = `<div class="card" style="padding:32px;text-align:center;max-width:400px;width:90%;border:4px solid var(--text);background:var(--bg-card);border-radius:16px;animation:popIn 0.3s ease;">
    <div style="font-weight:900;font-size:1.4rem;color:var(--text);margin-bottom:12px;">${title}</div>
    <p style="font-size:0.9rem;color:var(--text-sub);line-height:1.5;margin-bottom:24px;font-weight:600;">${message}</p>
    <button class="btn btn-primary" id="btnConfirmModal" style="font-weight:900;border:3px solid var(--text);">OK</button>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('btnConfirmModal').onclick = () => { overlay.remove(); if (cb) cb(); };
}

// Show confirmation modal
export function showConfirm(title, message, onConfirm, onCancel) {
  const existing = document.getElementById('ef-custom-modal');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ef-custom-modal';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px);';
  overlay.innerHTML = `<div class="card" style="padding:32px;text-align:center;max-width:400px;width:90%;border:4px solid var(--text);background:var(--bg-card);border-radius:16px;animation:popIn 0.3s ease;">
    <div style="font-weight:900;font-size:1.4rem;color:var(--text);margin-bottom:12px;">${title}</div>
    <p style="font-size:0.9rem;color:var(--text-sub);line-height:1.5;margin-bottom:24px;font-weight:600;">${message}</p>
    <div style="display:flex;gap:12px;justify-content:center;">
      <button class="btn btn-ghost" id="btnCancelModal" style="flex:1;border:3px solid var(--border);font-weight:900;">CANCEL</button>
      <button class="btn btn-primary" id="btnConfirmModal" style="flex:1;font-weight:900;border:3px solid var(--text);">OK</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  document.getElementById('btnCancelModal').onclick = () => { overlay.remove(); if (onCancel) onCancel(); };
  document.getElementById('btnConfirmModal').onclick = () => { overlay.remove(); if (onConfirm) onConfirm(); };
}

// Show prompt modal (returns Promise resolving to value or null)
export function showPrompt(title, defaultValue = '') {
  return new Promise((resolve) => {
    const existing = document.getElementById('ef-custom-modal');
    if (existing) existing.remove();
    const overlay = document.createElement('div');
    overlay.id = 'ef-custom-modal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;z-index:9999;backdrop-filter:blur(4px);';
    overlay.innerHTML = '<div class="card" style="padding:32px;text-align:center;max-width:400px;width:90%;border:4px solid var(--text);background:var(--bg-card);border-radius:16px;animation:popIn 0.3s ease;"><div style="font-weight:900;font-size:1.1rem;color:var(--text);margin-bottom:16px;">' + title + '</div><input id="ef-prompt-input" value="' + (defaultValue || '').replace(/"/g, '"') + '" style="width:100%;padding:12px 16px;border-radius:8px;border:2px solid var(--border);font-size:1rem;margin-bottom:20px;box-sizing:border-box;background:var(--bg-inset);color:var(--text);"><div style="display:flex;gap:12px;justify-content:center;"><button class="btn btn-ghost" id="btnCancelModal" style="flex:1;border:3px solid var(--border);font-weight:900;">CANCEL</button><button class="btn btn-primary" id="btnConfirmModal" style="flex:1;font-weight:900;border:3px solid var(--text);">OK</button></div></div>';
    document.body.appendChild(overlay);
    document.getElementById('btnCancelModal').onclick = () => { overlay.remove(); resolve(null); };
    document.getElementById('btnConfirmModal').onclick = () => { const val = document.getElementById('ef-prompt-input').value; overlay.remove(); resolve(val); };
    document.getElementById('ef-prompt-input').focus();
    document.getElementById('ef-prompt-input').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('btnConfirmModal').click(); };
  });
}

// Promisified alert (non-blocking, uses showModal)
export function showAlert(message, title = 'Notice') {
  showModal(title, message);
}

// Promisified confirm (returns Promise<boolean>)
export function showConfirmAsync(message, title = 'Confirm') {
  return new Promise((resolve) => {
    showConfirm(title, message, () => resolve(true), () => resolve(false));
  });
}
