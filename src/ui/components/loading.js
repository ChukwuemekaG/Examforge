export function showLoadingOverlay(message = 'Processing...') {
  // Prevent multiple overlays
  if (document.getElementById('ef-loading-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'ef-loading-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);z-index:10000;display:flex;justify-content:center;align-items:center;backdrop-filter:blur(4px);';
  const container = document.createElement('div');
  container.style.cssText = 'background:var(--bg-card);border-radius:12px;padding:24px;max-width:320px;width:80%;text-align:center;box-shadow:0 4px 12px rgba(0,0,0,0.2);';
  const spinner = document.createElement('div');
  spinner.style.cssText = 'border:4px solid var(--border);border-top:4px solid var(--accent);border-radius:50%;width:40px;height:40px;margin:0 auto 16px;animation:ef-spin 1s linear infinite;';
  const style = document.createElement('style');
  style.textContent = '@keyframes ef-spin { to { transform: rotate(360deg); } }';
  const msg = document.createElement('div');
  msg.textContent = message;
  msg.style.color = 'var(--text)';
  msg.style.fontSize = '0.95rem';
  container.appendChild(spinner);
  container.appendChild(msg);
  overlay.appendChild(style);
  overlay.appendChild(container);
  document.body.appendChild(overlay);
}

export function hideLoadingOverlay() {
  const overlay = document.getElementById('ef-loading-overlay');
  if (overlay) overlay.remove();
}
