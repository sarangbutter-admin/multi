// Shared helpers for the storefront and the back office. No framework, no build step.
// In the Android app shell, set window.SO_API = 'https://yourplatform.com' before this file loads.
const SO = (() => {
  const API = (window.SO_API || '').replace(/\/+$/, '');
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem('so.' + k)); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem('so.' + k) : localStorage.setItem('so.' + k, JSON.stringify(v)); } catch {} }
  };
  async function api(method, path, body, { tenant, token } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (tenant) headers['x-tenant'] = tenant;
    if (token) headers.authorization = 'Bearer ' + token;
    let r;
    try { r = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: API ? 'omit' : 'same-origin' }); }
    catch { throw Object.assign(new Error("Can't reach the server. Check your connection and try again."), { code: 'offline' }); }
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(d.message || d.error || 'Request failed'), { code: d.error, status: r.status });
    return d;
  }
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const money = n => 'IDR ' + Math.round(Number(n) || 0).toLocaleString('en-US');
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  let toastTimer;
  function toast(msg, kind = '') {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
    t.textContent = msg; t.className = 'show ' + kind;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3200);
  }
  const loadedFonts = new Set();
  function loadFont(name) {
    if (!name || loadedFonts.has(name)) return; loadedFonts.add(name);
    const l = document.createElement('link'); l.rel = 'stylesheet';
    l.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name)}:wght@400;500;600;700;800&display=swap`;
    document.head.append(l);
  }
  // readable text on a coloured background
  function onColor(hex) {
    const n = parseInt(String(hex).slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#13241B' : '#FFFFFF';
  }
  function mix(hex, other, amt) {
    const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)), a = p(hex), b = p(other);
    return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * amt).toString(16).padStart(2, '0')).join('');
  }
  function applyTheme(th, root = document.documentElement) {
    const dark = th.mode === 'dark';
    const bg = dark ? mix(th.text, '#000000', 0.35) : th.background, surface = dark ? mix(th.text, '#000000', 0.15) : th.surface, ink = dark ? th.background : th.text;
    const vars = { '--primary': th.primary, '--on-primary': onColor(th.primary), '--accent': th.accent, '--on-accent': onColor(th.accent), '--bg': bg, '--surface': surface,
      '--ink': ink, '--muted': mix(ink, bg, 0.42), '--line': mix(ink, bg, 0.84), '--soft': mix(th.primary, bg, 0.88), '--radius': th.radius + 'px', '--font': `'${th.font}', system-ui, sans-serif` };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    loadFont(th.font);
    const meta = $('meta[name=theme-color]'); if (meta) meta.content = th.primary;
  }
  return { api, esc, money, $, $$, toast, store, applyTheme, loadFont, onColor };
})();
