// SROAD core: API, shared state, small UI helpers
// made by. Nevertheless_D

export const T = new URLSearchParams(location.search).get('t') || '';
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// SROAD.app(Dock 앱) 창 안에서 열렸는지 (앱 창은 UA 에 SROADShell 을 붙여요)
export const IS_SHELL = navigator.userAgent.includes('SROADShell');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export const MODES = {
  vocal: { name: 'ROAD Vocal', ko: '보컬 추출', color: 'var(--vocal)', hex: '#ff5c8a' },
  track: { name: 'ROAD Track', ko: '악기 분리', color: 'var(--track)', hex: '#8a6cff' },
  pitch: { name: 'ROAD Pitch', ko: '키 변경', color: 'var(--pitch)', hex: '#2bc5e8' },
  tempo: { name: 'ROAD Tempo', ko: '템포 변경', color: 'var(--tempo)', hex: '#ffb020' },
  edit: { name: 'ROAD Edit', ko: '편집', color: 'var(--edit)', hex: '#2fd39a' },
};

export const S = {
  settings: null,
  items: [],
  byId: new Map(),
  rev: 0,
  jobs: [],
  setup: null,
  update: null,
  build: '',
  mode: 'vocal',
  focusId: null,
  checked: new Set(),
  uploads: [],
  export: { format: 'mp3', quality: '320', folder: '' },
  params: {
    vocal: { instrumental: true, vocals: true, model: 'htdemucs' },
    track: { model: 'htdemucs', stems: ['vocals', 'drums', 'bass', 'other'], mixOn: false, mix: ['drums', 'bass', 'other'] },
    pitch: { semitones: 0, formants: true },
    tempo: { rate: 1, keepPitch: true, bpm: '' },
  },
};

// tiny event bus
const listeners = {};
export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
export function emit(ev, ...a) { (listeners[ev] || []).forEach((fn) => fn(...a)); }

// ── API ──
export async function api(path, body, opts = {}) {
  const isBin = body instanceof Blob || body instanceof ArrayBuffer || ArrayBuffer.isView(body);
  const init = { method: body === undefined ? 'GET' : 'POST', headers: { 'x-token': T } };
  if (body !== undefined) {
    init.body = isBin ? body : JSON.stringify(body);
    if (!isBin) init.headers['content-type'] = 'application/json';
  }
  let r;
  try { r = await fetch(path, init); } catch { throw new Error('SROAD 엔진과 연결이 끊겼어요. 앱을 다시 실행해 주세요.'); }
  if (opts.raw) return r;
  let j = {};
  try { j = await r.json(); } catch { /* ignore */ }
  if (!r.ok || j.ok === false) throw new Error(j.error || `요청에 실패했어요 (${r.status})`);
  return j;
}
export const q = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
export const streamURL = (id, wav) => `/api/stream?id=${id}&t=${T}${wav ? '&wav=1' : ''}`;

let uiTimer;
export function saveUI(extra = {}) {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => {
    api('/api/settings', { ui: { mode: S.mode, export: { format: S.export.format, quality: S.export.quality }, params: S.params, ...extra } }).catch(() => {});
  }, 400);
}

// ── formatting ──
export function fmtTime(sec, ms = false) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = sec - m * 60;
  if (ms) return `${m}:${s.toFixed(2).padStart(5, '0')}`;
  return `${m}:${String(Math.floor(s)).padStart(2, '0')}`;
}
export function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1e6) return `${(n / 1e3).toFixed(0)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
export function fmtFormat(it) {
  const ext = (it.ext || '').toUpperCase();
  if (it.kind === 'result' && !it.savedPath) return '저장 전';
  if (it.kind === 'result') return (it.savedPath.split('.').pop() || '').toUpperCase();
  if (['MP3', 'M4A', 'AAC', 'OGG', 'OPUS'].includes(ext) && it.bitrate) return `${ext} ${Math.round(it.bitrate / 1000)}k`;
  if (it.bits) return `${ext} ${it.bits}bit`;
  return ext;
}
export function shortPath(p) {
  const home = S.settings?.home;
  if (home && (p === home || p.startsWith(home + '/'))) return '~' + p.slice(home.length);
  return p;
}
export const itemTitle = (it) => (it.kind === 'result' ? it.base : it.name);
export const laneClass = (it) => 'lane-' + (it.kind === 'result' ? it.mode : 'source');

// ── toast · context menu · modal ──
let toastTimer;
export function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

export function showCtx(x, y, items) {
  const m = $('#ctx');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.textContent = it.label;
    b.onclick = () => { m.hidden = true; it.onClick(); };
    m.append(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
}
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#ctx')) $('#ctx').hidden = true; });

let modalClose = null;
export function openModal(title, body, { onClose, wide } = {}) {
  closeModal();
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-back"><div class="modal"${wide ? ' style="width:680px"' : ''}><div class="modal-head"><b>${esc(title)}</b><span class="spacer"></span><button class="btn" data-close>닫기</button></div><div class="modal-body"></div></div></div>`;
  $('.modal-body', root).append(body);
  $('[data-close]', root).onclick = closeModal;
  $('.modal-back', root).addEventListener('mousedown', (e) => { if (e.target.classList.contains('modal-back')) closeModal(); });
  modalClose = onClose || null;
}
export function closeModal() {
  const root = $('#modalRoot');
  if (!root.innerHTML) return;
  root.innerHTML = '';
  const cb = modalClose;
  modalClose = null;
  cb && cb();
}
export const modalOpen = () => !!$('#modalRoot').innerHTML;

export function confirmBox(title, text, okLabel = '확인') {
  return new Promise((resolve) => {
    const body = document.createElement('div');
    body.innerHTML = `<div style="line-height:1.6">${text}</div><div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn" data-no>취소</button><button class="btn go" data-yes>${esc(okLabel)}</button></div>`;
    let done = false;
    openModal(title, body, { onClose: () => { if (!done) resolve(false); } });
    $('[data-no]', body).onclick = () => { done = true; closeModal(); resolve(false); };
    $('[data-yes]', body).onclick = () => { done = true; closeModal(); resolve(true); };
  });
}

// ── waveform helpers ──
export function cssVar(name, el = document.body) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function drawPeaks(canvas, peaks, { color, progress = -1, played, bg, mirror = true } = {}) {
  const dpr = devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, w, h);
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h); }
  if (!peaks || !peaks.length) return;
  const bw = Math.max(2, Math.round(3 * dpr)), gap = Math.max(1, Math.round(1.5 * dpr));
  const n = Math.floor(w / (bw + gap));
  const base = cssVar('--wave');
  for (let i = 0; i < n; i++) {
    const v = peaks[Math.floor((i / n) * peaks.length)] || 0;
    const bh = Math.max(dpr * 2, v * (mirror ? h : h));
    const x = i * (bw + gap);
    g.fillStyle = progress >= 0 && i / n <= progress ? (played || color) : (progress >= 0 ? base : color);
    const y = mirror ? (h - bh) / 2 : h - bh;
    roundRect(g, x, y, bw, bh, bw / 2);
  }
}
function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  r = Math.min(r, h / 2, w / 2);
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.fill();
}

export function miniWave(peaks, color = 'currentColor', n = 60) {
  if (!peaks || !peaks.length) return '';
  let d = '';
  for (let i = 0; i < n; i++) {
    const v = peaks[Math.floor((i / n) * peaks.length)] || 0;
    const h = Math.max(1, v * 14);
    d += `M${i * 2 + 0.5} ${7 - h / 2}v${h}`;
  }
  return `<svg class="mini" viewBox="0 0 ${n * 2} 14" preserveAspectRatio="none"><path d="${d}" stroke="${color}" stroke-width="1.1" stroke-linecap="round" opacity=".8"/></svg>`;
}

export const ICON = {
  play: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3.5 2.2v9.6a.7.7 0 0 0 1.06.6l7.9-4.8a.7.7 0 0 0 0-1.2l-7.9-4.8a.7.7 0 0 0-1.06.6z" fill="currentColor"/></svg>',
  pause: '<svg width="14" height="14" viewBox="0 0 14 14"><rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor"/><rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor"/></svg>',
  stop: '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor"/></svg>',
  folder: '<svg width="18" height="18" viewBox="0 0 20 20"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" fill="var(--tempo)"/></svg>',
  note: '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M6 12.5a2 2 0 1 1-2-2c.4 0 .7.1 1 .2V3.4l8-1.6v8.7a2 2 0 1 1-2-2c.4 0 .7.1 1 .2V5.1L6 6.3z" fill="currentColor"/></svg>',
  compare: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 4.5h8.5M8 2l2.5 2.5L8 7M12 9.5H3.5M6 7l-2.5 2.5L6 12" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  scissors: '<svg width="14" height="14" viewBox="0 0 14 14"><circle cx="3.5" cy="3.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="3.5" cy="10.5" r="2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.2 4.6L12.5 11M5.2 9.4L12.5 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  save: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 2v7M4 6.5L7 9.5l3-3M2.5 11.5h9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  finder: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 3.5A1 1 0 0 1 3 2.5h2.5l1 1.2H11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  next: '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M3 7h7.5M7.5 3.5L11 7l-3.5 3.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
