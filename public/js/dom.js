const el = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function safeClass(value, fallback = '') {
  const cleaned = String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || fallback;
}

function cents(val) {
  if (val == null) return '--';
  return Math.round(val * 100) + '¢';
}

function shortTicker(ticker) {
  if (!ticker) return '';
  const parts = ticker.split('-');
  return parts.length > 2 ? parts.slice(-2).join('-') : ticker;
}

function formatTime(seconds) {
  if (seconds < 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}


export { el, escapeHtml, safeClass, cents, shortTicker, formatTime };
