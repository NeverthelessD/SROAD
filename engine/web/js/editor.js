// SROAD ROAD Edit — non-destructive waveform editor
// Edits are kept as a list of segments that point into source buffers, so cut / move / insert / undo stay cheap.
import { S, $, $$, esc, T, api, q, toast, emit, on, openModal, closeModal, confirmBox, fmtTime, fmtBytes, clamp, cssVar, MODES, ICON, itemTitle, laneClass } from './core.js';
import { focused } from './library.js';

const E = {
  item: null, sr: 44100, ch: 2, ctx: null,
  sources: new Map(), segs: [], undo: [], redo: [], clip: null,
  buf: null, mip: null, origBuf: null,
  view: { start: 0, spp: 0.01 }, sel: null, cursor: 0,
  node: null, playStart: 0, playOffset: 0, which: 'edit', loop: false,
  moveMode: false, dirty: false, loading: false, patchN: 0, fadeLen: 3,
};

const SVG = {
  loop: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M3 6.5A3.5 3.5 0 0 1 6.5 3h6M10.5 1l2 2-2 2M13 9.5A3.5 3.5 0 0 1 9.5 13h-6M5.5 15l-2-2 2-2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trim: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M4 1v11h11M1 4h11v11" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  cut: ICON.scissors,
  copy: '<svg width="15" height="15" viewBox="0 0 16 16"><rect x="5" y="5" width="9" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M11 3V2.5A1.5 1.5 0 0 0 9.5 1h-7A1.5 1.5 0 0 0 1 2.5v7A1.5 1.5 0 0 0 2.5 11H3" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>',
  paste: '<svg width="15" height="15" viewBox="0 0 16 16"><rect x="3" y="2.5" width="10" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 2.5V1.5h4v1M8 6v5M5.8 8.8L8 11l2.2-2.2" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  del: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.8 9.5a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9L12 4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  move: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 8h13M4 5.5L1.5 8 4 10.5M12 5.5L14.5 8 12 10.5M8 1.5v4M8 10.5v4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5zM9 1.5v4h4M8 8v4M6 10h4" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  silence: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M1.5 8h3M11.5 8h3M5.5 5.5v5M10.5 5.5v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  fin: '<svg width="17" height="15" viewBox="0 0 18 16"><path d="M1 14 L17 2 V14 Z" fill="currentColor" opacity=".25"/><path d="M1 14 L17 2" stroke="currentColor" stroke-width="1.6"/></svg>',
  fout: '<svg width="17" height="15" viewBox="0 0 18 16"><path d="M1 2 L17 14 H1 Z" fill="currentColor" opacity=".25"/><path d="M1 2 L17 14" stroke="currentColor" stroke-width="1.6"/></svg>',
  undo: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M5 2.5L2 5.5l3 3M2.5 5.5H10a4 4 0 0 1 0 8H6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  redo: '<svg width="15" height="15" viewBox="0 0 16 16"><path d="M11 2.5l3 3-3 3M13.5 5.5H6a4 4 0 0 0 0 8h4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

// ── segments ──
const segLen = (s) => s.b - s.a;
const totalLen = () => E.segs.reduce((n, s) => n + segLen(s), 0);
const toS = (t) => Math.round(t * E.sr);
const toT = (n) => n / E.sr;

function cutAt(segs, pos) { // split so that a segment boundary falls on pos
  const out = [];
  let acc = 0;
  for (const s of segs) {
    const L = segLen(s);
    if (pos > acc && pos < acc + L) {
      const k = pos - acc;
      out.push({ ...s, b: s.a + k }, { ...s, a: s.a + k });
    } else out.push({ ...s });
    acc += L;
  }
  return out;
}
function rangeSegs(segs, a, b) {
  const sp = cutAt(cutAt(segs, a), b);
  const out = [];
  let acc = 0;
  for (const s of sp) {
    const L = segLen(s);
    if (acc >= a && acc + L <= b && L > 0) out.push(s);
    acc += L;
  }
  return out;
}
function withoutRange(segs, a, b) {
  const sp = cutAt(cutAt(segs, a), b);
  const out = [];
  let acc = 0;
  for (const s of sp) {
    const L = segLen(s);
    if (!(acc >= a && acc + L <= b) && L > 0) out.push(s);
    acc += L;
  }
  return out;
}
function insertSegs(segs, pos, ins) {
  const sp = cutAt(segs, pos);
  const out = [];
  let acc = 0, done = false;
  for (const s of sp) {
    if (!done && acc >= pos) { out.push(...ins.map((x) => ({ ...x }))); done = true; }
    out.push(s);
    acc += segLen(s);
  }
  if (!done) out.push(...ins.map((x) => ({ ...x })));
  return out;
}

function commit(newSegs, msg) {
  E.undo.push(E.segs);
  if (E.undo.length > 60) E.undo.shift();
  E.redo = [];
  E.segs = newSegs;
  E.dirty = true;
  afterChange();
  if (msg) toast(msg, 2000);
}
function afterChange() {
  stop();
  E.buf = renderSegs(E.segs);
  E.mip = buildMip(E.buf);
  const dur = toT(E.buf.length);
  E.cursor = clamp(E.cursor, 0, dur);
  if (E.sel) { E.sel.a = clamp(E.sel.a, 0, dur); E.sel.b = clamp(E.sel.b, 0, dur); if (E.sel.b - E.sel.a < 0.005) E.sel = null; }
  E.view.start = clamp(E.view.start, 0, Math.max(0, dur - viewDur()));
  renderTools();
  draw();
}

function renderSegs(segs) {
  const len = Math.max(1, segs.reduce((n, s) => n + segLen(s), 0));
  const out = new AudioBuffer({ length: len, numberOfChannels: E.ch, sampleRate: E.sr });
  for (let c = 0; c < E.ch; c++) {
    const dst = out.getChannelData(c);
    let o = 0;
    for (const s of segs) {
      const L = segLen(s);
      if (s.s !== '~') {
        const src = E.sources.get(s.s);
        const sc = Math.min(c, src.numberOfChannels - 1);
        dst.set(src.getChannelData(sc).subarray(s.a, s.b), o);
      }
      o += L;
    }
  }
  return out;
}

// peaks pyramid: level 0 = 128 samples per bin, then ×8
function buildMip(buf) {
  const levels = [];
  const n = buf.length, B = 128;
  const bins = Math.ceil(n / B);
  const mn = new Float32Array(bins), mx = new Float32Array(bins);
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  for (let i = 0; i < bins; i++) {
    let lo = 0, hi = 0;
    const end = Math.min(n, (i + 1) * B);
    for (const d of chs) for (let k = i * B; k < end; k++) { const v = d[k]; if (v < lo) lo = v; else if (v > hi) hi = v; }
    mn[i] = lo; mx[i] = hi;
  }
  levels.push({ size: B, mn, mx });
  let prev = levels[0];
  while (prev.mn.length > 64) {
    const cnt = Math.ceil(prev.mn.length / 8);
    const a = new Float32Array(cnt), b = new Float32Array(cnt);
    for (let i = 0; i < cnt; i++) {
      let lo = 0, hi = 0;
      for (let k = i * 8; k < Math.min(prev.mn.length, i * 8 + 8); k++) { if (prev.mn[k] < lo) lo = prev.mn[k]; if (prev.mx[k] > hi) hi = prev.mx[k]; }
      a[i] = lo; b[i] = hi;
    }
    prev = { size: prev.size * 8, mn: a, mx: b };
    levels.push(prev);
  }
  return levels;
}

// ── loading ──
async function fetchPCM(it, sr, ch) {
  const r = await api(`/api/pcm?${q({ id: it.id, sr, ch, t: T })}`, undefined, { raw: true });
  if (!r.ok) throw new Error('음원을 불러오지 못했어요');
  return E.ctx.decodeAudioData(await r.arrayBuffer());
}

export async function openItem(it) {
  if (!it) return;
  if (E.dirty && E.item && E.item.id !== it.id) {
    if (!(await confirmBox('편집 중인 내용', `‘${esc(itemTitle(E.item))}’의 편집 내용을 아직 내보내지 않았어요.<br>다른 곡을 열면 지금 편집한 내용은 사라져요.`, '다른 곡 열기'))) return;
  }
  if (it.duration > 40 * 60) return toast('40분이 넘는 음원은 편집기에서 열 수 없어요');
  stop();
  E.loading = true;
  E.item = it;
  render();
  try {
    E.sr = it.sampleRate || 44100;
    E.ch = clamp(it.channels || 2, 1, 2);
    if (E.ctx) E.ctx.close().catch(() => {});
    E.ctx = new AudioContext({ sampleRate: E.sr });
    const buf = await fetchPCM(it, E.sr, E.ch);
    if (E.item !== it) return;
    E.sources = new Map([['orig', buf]]);
    E.origBuf = buf;
    E.segs = [{ s: 'orig', a: 0, b: buf.length }];
    E.undo = []; E.redo = []; E.sel = null; E.cursor = 0; E.dirty = false; E.moveMode = false; E.which = 'edit';
    E.buf = renderSegs(E.segs);
    E.mip = buildMip(E.buf);
    E.loading = false;
    render();
    fitAll();
  } catch (err) {
    E.loading = false;
    E.item = null;
    render();
    toast('⚠️ ' + err.message, 5000);
  }
}

// ── view ──
const mainCv = () => $('#edMain');
const width = () => mainCv()?.clientWidth || 800;
const viewDur = () => width() * E.view.spp;
function fitAll() {
  if (!E.buf) return;
  E.view.spp = Math.max(1e-4, toT(E.buf.length) / width());
  E.view.start = 0;
  syncZoom();
  draw();
}
const maxSpp = () => (E.buf ? Math.max(1e-4, toT(E.buf.length) / width()) : 1);
const minSpp = () => 1 / 4000;
function zoomTo(spp, anchorT) {
  const a = anchorT ?? E.view.start + viewDur() / 2;
  const rel = (a - E.view.start) / viewDur();
  E.view.spp = clamp(spp, minSpp(), maxSpp());
  E.view.start = clamp(a - rel * viewDur(), 0, Math.max(0, toT(E.buf.length) - viewDur()));
  syncZoom();
  draw();
}
function syncZoom() {
  const z = $('#edZoom');
  if (!z) return;
  const lo = Math.log(minSpp()), hi = Math.log(maxSpp());
  z.value = hi === lo ? 0 : Math.round(((hi - Math.log(E.view.spp)) / (hi - lo)) * 100);
}

// ── drawing ──
function draw() {
  const cv = mainCv();
  if (!cv || !E.buf) return;
  const dpr = devicePixelRatio || 1;
  const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  const accent = cssVar('--edit'), text = cssVar('--muted'), line = cssVar('--line2'), wave = cssVar('--wave');
  g.clearRect(0, 0, W, H);
  const RH = 24 * dpr, top = RH, h = H - RH, mid = top + h / 2;
  const spp = E.view.spp / dpr; // seconds per device pixel
  const dur = toT(E.buf.length);

  // selection
  if (E.sel) {
    const x1 = ((E.sel.a - E.view.start) / spp), x2 = ((E.sel.b - E.view.start) / spp);
    g.fillStyle = accent + '2e';
    g.fillRect(x1, top, x2 - x1, h);
  }
  // waveform
  const sppSamples = spp * E.sr;
  let lvl = E.mip[0];
  for (const L of E.mip) if (L.size <= sppSamples) lvl = L;
  for (let x = 0; x < W; x++) {
    const t0 = E.view.start + x * spp;
    if (t0 > dur) break;
    let lo = 0, hi = 0;
    if (sppSamples < lvl.size || sppSamples < 128) {
      // zoomed in: read samples directly
      const a = Math.floor(t0 * E.sr), b = Math.max(a + 1, Math.floor((t0 + spp) * E.sr));
      for (let c = 0; c < E.buf.numberOfChannels; c++) {
        const d = E.buf.getChannelData(c);
        for (let k = a; k < Math.min(b, d.length); k++) { const v = d[k]; if (v < lo) lo = v; if (v > hi) hi = v; }
      }
    } else {
      const a = Math.floor((t0 * E.sr) / lvl.size), b = Math.max(a + 1, Math.floor(((t0 + spp) * E.sr) / lvl.size));
      for (let k = a; k < Math.min(b, lvl.mn.length); k++) { if (lvl.mn[k] < lo) lo = lvl.mn[k]; if (lvl.mx[k] > hi) hi = lvl.mx[k]; }
    }
    const inSel = E.sel && t0 >= E.sel.a && t0 <= E.sel.b;
    g.fillStyle = inSel ? accent : (E.sel ? wave : accent);
    const y1 = mid - hi * (h / 2) * 0.95, y2 = mid - lo * (h / 2) * 0.95;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  // centre line
  g.fillStyle = line;
  g.fillRect(0, mid, W, 1);
  // ruler
  g.fillStyle = cssVar('--raised');
  g.fillRect(0, 0, W, RH);
  g.fillStyle = line;
  g.fillRect(0, RH - 1, W, 1);
  const steps = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s / spp > 90 * dpr) || 600;
  g.font = `${11 * dpr}px Pretendard, sans-serif`;
  g.fillStyle = text;
  for (let t = Math.ceil(E.view.start / step) * step; t < E.view.start + W * spp; t += step) {
    const x = (t - E.view.start) / spp;
    g.fillRect(x, RH - 7 * dpr, 1, 7 * dpr);
    const lab = step < 1 ? fmtTime(t, true) : fmtTime(t);
    g.fillText(lab, x + 4 * dpr, 15 * dpr);
  }
  // cursor / playhead
  const ph = playheadT();
  const px = (ph - E.view.start) / spp;
  g.fillStyle = E.node ? cssVar('--text') : accent;
  g.fillRect(px - dpr, 0, 2 * dpr, H);
  g.beginPath();
  g.moveTo(px - 6 * dpr, 0); g.lineTo(px + 6 * dpr, 0); g.lineTo(px, 8 * dpr); g.fill();
  // move target
  if (E.moveMode && E.hoverT != null) {
    const hx = (E.hoverT - E.view.start) / spp;
    g.fillStyle = cssVar('--tempo');
    g.fillRect(hx - dpr, top, 2 * dpr, h);
  }
  drawOverview();
  updateStatus();
}

function drawOverview() {
  const cv = $('#edOverview');
  if (!cv || !E.mip) return;
  const dpr = devicePixelRatio || 1;
  const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d');
  g.clearRect(0, 0, W, H);
  const L = E.mip[Math.min(E.mip.length - 1, 2)] || E.mip[0];
  const n = L.mn.length;
  g.fillStyle = cssVar('--wave');
  for (let x = 0; x < W; x++) {
    const a = Math.floor((x / W) * n), b = Math.max(a + 1, Math.floor(((x + 1) / W) * n));
    let lo = 0, hi = 0;
    for (let k = a; k < Math.min(b, n); k++) { if (L.mn[k] < lo) lo = L.mn[k]; if (L.mx[k] > hi) hi = L.mx[k]; }
    g.fillRect(x, H / 2 - hi * H * 0.45, 1, Math.max(1, (hi - lo) * H * 0.45));
  }
  const dur = toT(E.buf.length);
  const x1 = (E.view.start / dur) * W, x2 = ((E.view.start + viewDur()) / dur) * W;
  g.fillStyle = cssVar('--edit') + '30';
  g.fillRect(x1, 0, Math.max(3, x2 - x1), H);
  g.strokeStyle = cssVar('--edit');
  g.lineWidth = dpr;
  g.strokeRect(x1 + 0.5, 0.5, Math.max(3, x2 - x1) - 1, H - 1);
}

function updateStatus() {
  const st = $('#edStatus');
  if (!st || !E.buf) return;
  const dur = toT(E.buf.length);
  $('[data-k=len]', st).textContent = fmtTime(dur, true);
  $('[data-k=orig]', st).textContent = fmtTime(toT(E.origBuf.length), true);
  $('[data-k=pos]', st).textContent = fmtTime(playheadT(), true);
  const a = $('[data-k=sa]', st), b = $('[data-k=sb]', st);
  if (document.activeElement !== a) a.value = E.sel ? fmtTime(E.sel.a, true) : '';
  if (document.activeElement !== b) b.value = E.sel ? fmtTime(E.sel.b, true) : '';
  $('[data-k=sl]', st).textContent = E.sel ? `${(E.sel.b - E.sel.a).toFixed(2)}초` : '없음';
}

// ── playback ──
function playheadT() {
  if (!E.node) return E.cursor;
  let t = E.playOffset + (E.ctx.currentTime - E.playStart);
  if (E.loop && E.sel) {
    const L = E.sel.b - E.sel.a;
    if (t > E.sel.b) t = E.sel.a + ((t - E.sel.a) % L);
  }
  return t;
}
function play(from) {
  if (!E.buf) return;
  emit('pause-all');
  stop(true);
  const buf = E.which === 'orig' ? E.origBuf : E.buf;
  let off = from ?? E.cursor;
  if (E.loop && E.sel && (off < E.sel.a || off >= E.sel.b)) off = E.sel.a;
  if (off >= toT(buf.length) - 0.01) off = 0;
  const node = E.ctx.createBufferSource();
  node.buffer = buf;
  node.connect(E.ctx.destination);
  if (E.loop && E.sel) { node.loop = true; node.loopStart = E.sel.a; node.loopEnd = E.sel.b; }
  node.onended = () => { if (E.node === node) { E.cursor = Math.min(playheadT(), toT(buf.length)); E.node = null; renderTools(); draw(); } };
  E.ctx.resume();
  node.start(0, off);
  E.node = node; E.playStart = E.ctx.currentTime; E.playOffset = off;
  renderTools();
  tick();
}
function stop(keep) {
  if (E.node) {
    if (keep !== true) E.cursor = playheadT();
    const n = E.node;
    E.node = null;
    try { n.stop(); } catch { /* ignore */ }
  }
}
function toggle() { if (E.node) { stop(); renderTools(); draw(); } else play(); }
function tick() {
  if (!E.node) return;
  const t = playheadT();
  if (t > E.view.start + viewDur() * 0.97 || t < E.view.start) E.view.start = clamp(t - viewDur() * 0.05, 0, Math.max(0, toT(E.buf.length) - viewDur()));
  draw();
  requestAnimationFrame(tick);
}
function setWhich(w) {
  if (E.which === w) return;
  const t = playheadT();
  E.which = w;
  if (E.node) play(t);
  renderTools();
}

// ── edit operations ──
const needSel = () => { if (!E.sel) { toast('먼저 파형을 드래그해서 구간을 골라 주세요'); return false; } return true; };
const S_ = () => [toS(E.sel.a), toS(E.sel.b)];

const ops = {
  trim() { if (!needSel()) return; const [a, b] = S_(); commit(rangeSegs(E.segs, a, b), '✂︎ 고른 구간만 남겼어요'); E.cursor = 0; E.sel = null; afterChange(); fitAll(); },
  cut() { if (!needSel()) return; const [a, b] = S_(); E.clip = rangeSegs(E.segs, a, b); E.cursor = E.sel.a; commit(withoutRange(E.segs, a, b), '잘라냈어요. 원하는 위치를 누르고 붙여넣기 하세요'); E.sel = null; draw(); },
  copy() { if (!needSel()) return; const [a, b] = S_(); E.clip = rangeSegs(E.segs, a, b); toast('복사했어요. 원하는 위치를 누르고 붙여넣기 하세요', 2200); renderTools(); },
  paste() {
    if (!E.clip) return toast('먼저 잘라내기나 복사를 해 주세요');
    const at = toS(E.cursor);
    const L = E.clip.reduce((n, s) => n + segLen(s), 0);
    commit(insertSegs(E.segs, at, E.clip), '붙여넣었어요');
    E.sel = { a: E.cursor, b: E.cursor + toT(L) };
    draw();
  },
  del() { if (!needSel()) return; const [a, b] = S_(); E.cursor = E.sel.a; commit(withoutRange(E.segs, a, b), '🗑 구간을 지웠어요'); E.sel = null; draw(); },
  move() {
    if (!needSel()) return;
    E.moveMode = !E.moveMode;
    renderTools();
    draw();
  },
  undo() { if (!E.undo.length) return; E.redo.push(E.segs); E.segs = E.undo.pop(); E.dirty = true; afterChange(); toast('실행 취소', 1200); },
  redo() { if (!E.redo.length) return; E.undo.push(E.segs); E.segs = E.redo.pop(); E.dirty = true; afterChange(); toast('다시 실행', 1200); },
  fadeIn() { fade('in'); },
  fadeOut() { fade('out'); },
  silence() { askSilence(); },
  file() { askInsertFile(); },
};

function doMove(destT) {
  E.moveMode = false;
  const [a, b] = S_();
  let d = toS(destT);
  if (d >= a && d <= b) { renderTools(); draw(); return toast('고른 구간 바깥을 눌러 주세요'); }
  const piece = rangeSegs(E.segs, a, b);
  let rest = withoutRange(E.segs, a, b);
  if (d > b) d -= (b - a);
  const L = b - a;
  commit(insertSegs(rest, d, piece), '↔︎ 구간을 옮겼어요');
  E.sel = { a: toT(d), b: toT(d + L) };
  E.cursor = E.sel.a;
  draw();
}

function fade(kind) {
  if (!E.buf) return;
  const dur = toT(E.buf.length);
  let a, b;
  if (E.sel) { a = E.sel.a; b = E.sel.b; }
  else {
    const L = Math.min(dur, Math.max(0.1, E.fadeLen));
    if (kind === 'in') { a = 0; b = L; } else { a = dur - L; b = dur; }
  }
  const A = toS(a), B = toS(b), N = B - A;
  if (N < 2) return;
  const patch = new AudioBuffer({ length: N, numberOfChannels: E.ch, sampleRate: E.sr });
  for (let c = 0; c < E.ch; c++) {
    const src = E.buf.getChannelData(c), dst = patch.getChannelData(c);
    for (let i = 0; i < N; i++) {
      const x = i / (N - 1);
      const g = kind === 'in' ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
      dst[i] = src[A + i] * g * g;
    }
  }
  const id = 'p' + ++E.patchN;
  E.sources.set(id, patch);
  commit(insertSegs(withoutRange(E.segs, A, B), A, [{ s: id, a: 0, b: N }]), kind === 'in' ? '페이드 인을 넣었어요' : '페이드 아웃을 넣었어요');
  E.sel = { a, b };
  draw();
}

function askSilence() {
  const body = document.createElement('div');
  body.innerHTML = `<div>재생 위치(<b>${fmtTime(E.cursor, true)}</b>)에 소리 없는 구간을 넣어요.</div>
    <div style="display:flex;align-items:center;gap:8px"><input type="number" id="silSec" value="2" min="0.1" max="600" step="0.1" style="width:100px;height:32px;border-radius:9px;border:1px solid var(--line2);background:var(--panel);padding:0 10px"> 초</div>
    <div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn" data-no>취소</button><button class="btn go" data-yes>넣기</button></div>`;
  openModal('무음 넣기', body);
  $('[data-no]', body).onclick = closeModal;
  $('[data-yes]', body).onclick = () => {
    const sec = clamp(Number($('#silSec', body).value) || 0, 0.01, 600);
    closeModal();
    const L = toS(sec);
    commit(insertSegs(E.segs, toS(E.cursor), [{ s: '~', a: 0, b: L }]), '무음을 넣었어요');
    E.sel = { a: E.cursor, b: E.cursor + sec };
    draw();
  };
}

function askInsertFile() {
  const body = document.createElement('div');
  const others = S.items.filter((x) => x.id !== E.item.id);
  body.innerHTML = `<div>재생 위치(<b>${fmtTime(E.cursor, true)}</b>)에 다른 음원을 끼워 넣어요.</div>
    <div style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow:auto">${others.map((it) => `<button class="btn ${laneClass(it)}" data-id="${it.id}" style="justify-content:flex-start;height:auto;padding:8px 12px;text-align:left"><span class="chip" style="background:var(--lane);color:#fff;border-radius:5px;padding:0 6px;font-size:10px">${esc(it.kind === 'result' ? it.label : '원곡')}</span> ${esc(itemTitle(it))} <span class="muted">${fmtTime(it.duration)}</span></button>`).join('') || '<div class="muted">라이브러리에 다른 곡이 없어요.</div>'}</div>
    <div style="display:flex;justify-content:space-between;gap:8px"><button class="btn" data-pick>컴퓨터에서 파일 고르기</button><button class="btn" data-no>취소</button></div>
    <input type="file" accept="audio/*,.mp3,.m4a,.wav,.flac" hidden data-file>`;
  openModal('파일 삽입', body);
  $('[data-no]', body).onclick = closeModal;
  $('[data-pick]', body).onclick = () => $('[data-file]', body).click();
  $('[data-file]', body).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    closeModal();
    try { insertBuffer(await E.ctx.decodeAudioData(await f.arrayBuffer()), f.name); }
    catch { toast('⚠️ 이 파일은 바로 넣을 수 없어요. 라이브러리에 먼저 추가한 뒤 골라 주세요', 5000); }
  };
  body.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-id]');
    if (!b) return;
    const it = S.byId.get(b.dataset.id);
    closeModal();
    toast('불러오는 중…', 1500);
    try { insertBuffer(await fetchPCM(it, E.sr, E.ch), itemTitle(it)); } catch (err) { toast('⚠️ ' + err.message); }
  });
}
function insertBuffer(buf, name) {
  const id = 'f' + ++E.patchN;
  E.sources.set(id, buf);
  const at = E.cursor;
  commit(insertSegs(E.segs, toS(at), [{ s: id, a: 0, b: buf.length }]), `‘${name}’을(를) 넣었어요`);
  E.sel = { a: at, b: at + toT(buf.length) };
  draw();
}

// ── export ──
function encodeWav(buf) {
  const ch = buf.numberOfChannels, n = buf.length, bytes = n * ch * 4;
  const ab = new ArrayBuffer(44 + bytes);
  const v = new DataView(ab);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * ch * 4, true);
  v.setUint16(32, ch * 4, true); v.setUint16(34, 32, true); w(36, 'data'); v.setUint32(40, bytes, true);
  const out = new Float32Array(ab, 44);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < ch; c++) out[k++] = data[c][i];
  return new Blob([ab], { type: 'audio/wav' });
}
async function exportEdit() {
  if (!E.buf) return;
  const btn = $('#edExport');
  btn.disabled = true;
  try {
    const blob = encodeWav(E.buf);
    await api(`/api/export?${q({ id: E.item.id, label: '편집본', format: S.export.format, quality: S.export.quality, folder: S.export.folder })}`, blob);
    E.dirty = false;
    toast(`💾 편집본을 저장하는 중이에요 (${fmtBytes(blob.size)})`);
    emit('refresh');
  } catch (err) { toast('⚠️ ' + err.message, 5000); }
  btn.disabled = false;
}

// ── UI ──
function tool(key, icon, label, title, extra = '') {
  return `<button class="tool" data-op="${key}" title="${esc(title)}" ${extra}>${icon}<span>${label}</span></button>`;
}
function renderTools() {
  const el = $('#edTools');
  if (!el) return;
  const hasSel = !!E.sel;
  el.innerHTML = `
    <div class="grp">
      <button class="tool" data-op="toggle" title="재생 / 일시정지 (스페이스)">${E.node ? ICON.pause : ICON.play}<span>${E.node ? '일시정지' : '재생'}</span></button>
      <button class="tool ${E.loop ? 'on' : ''}" data-op="loop" title="고른 구간 반복 재생">${SVG.loop}<span>구간 반복</span></button>
    </div>
    <div class="grp"><div class="seg" style="width:150px"><button data-w="orig" class="${E.which === 'orig' ? 'on' : ''}" title="원곡 듣기">원곡</button><button data-w="edit" class="${E.which === 'edit' ? 'on' : ''}" title="편집본 듣기">편집본</button></div></div>
    <div class="grp">
      ${tool('trim', SVG.trim, '자르기', '고른 구간만 남기고 나머지를 지워요', hasSel ? '' : 'disabled')}
      ${tool('cut', SVG.cut, '잘라내기', '고른 구간을 잘라 클립보드에 담아요 (⌘X)', hasSel ? '' : 'disabled')}
      ${tool('copy', SVG.copy, '복사', '고른 구간을 복사해요 (⌘C)', hasSel ? '' : 'disabled')}
      ${tool('paste', SVG.paste, '붙여넣기', '재생 위치에 끼워 넣어요 (⌘V)', E.clip ? '' : 'disabled')}
      ${tool('del', SVG.del, '삭제', '고른 구간을 지워요 (⌫)', hasSel ? '' : 'disabled')}
      <button class="tool ${E.moveMode ? 'on' : ''}" data-op="move" title="고른 구간을 다른 위치로 옮겨요" ${hasSel ? '' : 'disabled'}>${SVG.move}<span>이동</span></button>
      ${tool('file', SVG.file, '파일 삽입', '재생 위치에 다른 음원을 넣어요')}
      ${tool('silence', SVG.silence, '무음', '재생 위치에 소리 없는 구간을 넣어요')}
    </div>
    <div class="grp">
      ${tool('fadeIn', SVG.fin, 'Fade In', '고른 구간(없으면 맨 앞)에서 소리가 점점 커져요')}
      ${tool('fadeOut', SVG.fout, 'Fade Out', '고른 구간(없으면 맨 끝)에서 소리가 점점 작아져요')}
      <input class="fade-len" type="number" min="0.1" max="60" step="0.5" value="${E.fadeLen}" data-fadelen title="구간을 고르지 않았을 때 페이드 길이(초)"><span class="muted" style="font-size:11px">초</span>
    </div>
    <div class="grp">
      <button class="tool" data-op="undo" title="실행 취소 (⌘Z)" ${E.undo.length ? '' : 'disabled'}>${SVG.undo}</button>
      <button class="tool" data-op="redo" title="다시 실행 (⇧⌘Z)" ${E.redo.length ? '' : 'disabled'}>${SVG.redo}</button>
    </div>`;
  const hint = $('#edHint');
  if (hint) {
    hint.hidden = !E.moveMode;
    hint.textContent = '옮길 위치를 파형에서 누르세요 (취소: esc)';
  }
}

export function render() {
  if (S.mode !== 'edit') return;
  const it = E.item;
  const cand = focused();
  const head = `<div class="hero" style="min-height:120px"><div><h1>ROAD <span>Edit</span></h1><div class="ko">편집</div>
    <p>파형을 보고 들으면서 자르고, 옮기고, 끼워 넣고, 페이드를 넣어요. 원곡은 그대로 두고 새 파일로 내보내요.</p></div>
    <svg width="260" height="110" viewBox="0 0 260 110" aria-hidden="true"><rect x="70" y="18" width="92" height="74" rx="8" fill="#2fd39a" opacity=".2"/>
    <g stroke="currentColor" stroke-width="3.2" stroke-linecap="round" opacity=".5">${Array.from({ length: 30 }, (_, k) => { const hgt = 6 + Math.abs(Math.sin(k * 0.8)) * 44 * (0.4 + 0.6 * Math.abs(Math.sin(k * 0.21))); return `<path d="M${12 + k * 8} ${55 - hgt / 2}v${hgt}"/>`; }).join('')}</g>
    <g stroke="#2fd39a" stroke-width="3.2" stroke-linecap="round">${Array.from({ length: 12 }, (_, k) => { const hgt = 6 + Math.abs(Math.sin((k + 8) * 0.8)) * 44 * (0.4 + 0.6 * Math.abs(Math.sin((k + 8) * 0.21))); return `<path d="M${76 + k * 8} ${55 - hgt / 2}v${hgt}"/>`; }).join('')}</g>
    <path d="M70 6v98M162 6v98" stroke="#2fd39a" stroke-width="2.5"/></svg></div>`;
  let body;
  if (E.loading) {
    body = `<div class="ed-empty"><span class="spin"></span><b>‘${esc(itemTitle(it))}’을(를) 여는 중이에요</b>파형을 그리고 있어요</div>`;
  } else if (!it) {
    body = `<div class="ed-empty">${ICON.scissors}<b>편집할 곡을 골라 주세요</b>${cand ? `라이브러리에서 고른 곡: ${esc(itemTitle(cand))}` : '라이브러리에 음원을 먼저 넣어 주세요'}
      ${cand ? `<div style="margin-top:14px"><button class="btn go big" data-open="${cand.id}">이 곡 편집하기</button></div>` : ''}</div>`;
  } else {
    body = `
      <div class="ed-top">
        <div class="target" style="margin:0;flex:1"><div class="tw ${laneClass(it)}">${ICON.note}</div><div style="min-width:0;flex:1"><div class="tn">${esc(itemTitle(it))}</div>
          <div class="ts">${E.sr / 1000}kHz · ${E.ch === 1 ? '모노' : '스테레오'}${E.dirty ? ' · 편집됨' : ''}</div></div>
          ${cand && cand.id !== it.id ? `<button class="mini" data-open="${cand.id}">‘${esc(itemTitle(cand).slice(0, 18))}’ 열기</button>` : ''}
        </div>
        <button class="btn go big" id="edExport" title="저장 설정의 형식·음질로 내보내요">편집본 내보내기</button>
      </div>
      <div class="ed-tools" id="edTools"></div>
      <div class="ed-canvas"><canvas id="edMain"></canvas><canvas id="edOverview"></canvas><div class="ed-hint" id="edHint" hidden></div></div>
      <div class="ed-status" id="edStatus">
        <span>원곡 <b data-k="orig"></b></span><span>편집본 <b data-k="len"></b></span><span>재생 위치 <b data-k="pos"></b></span>
        <span>선택 <input data-k="sa" placeholder="시작" title="m:ss.00"> ~ <input data-k="sb" placeholder="끝" title="m:ss.00"> <b data-k="sl"></b></span>
        <span class="spacer"></span>
        <span class="zoom">확대 <input type="range" id="edZoom" min="0" max="100" value="0"><button class="mini" data-fit>전체 보기</button></span>
      </div>
      <div class="note">팁 · 파형을 드래그해 구간을 고르고, 한 번 누르면 재생 위치가 옮겨져요. ⌘ + 스크롤로 확대, 스크롤로 좌우 이동. 스페이스로 재생/정지.</div>`;
  }
  $('#stage').innerHTML = `<section class="mode" id="edWrap">${head}<div class="ed">${body}</div></section>`;
  if (it && !E.loading) {
    renderTools();
    bindCanvas();
    requestAnimationFrame(() => { syncZoom(); draw(); });
  }
}

function parseTime(s) {
  s = String(s).trim();
  if (!s) return null;
  const p = s.split(':');
  const v = p.length === 2 ? Number(p[0]) * 60 + Number(p[1]) : Number(p[0]);
  return isFinite(v) ? v : null;
}

// global pointer state (listeners are registered once below)
let down = null, ovDown = false;
const tAt = (e) => { const cv = mainCv(); const r = cv.getBoundingClientRect(); return clamp(E.view.start + (e.clientX - r.left) * E.view.spp, 0, toT(E.buf.length)); };
function ovMove(e) {
  const ov = $('#edOverview');
  const r = ov.getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * toT(E.buf.length);
  E.view.start = clamp(t - viewDur() / 2, 0, Math.max(0, toT(E.buf.length) - viewDur()));
  draw();
}
function bindCanvas() {
  const cv = mainCv();
  cv.onmousedown = (e) => {
    const t = tAt(e);
    if (E.moveMode) { doMove(t); return; }
    if (e.shiftKey) {
      const a = E.sel ? (Math.abs(t - E.sel.a) < Math.abs(t - E.sel.b) ? E.sel.b : E.sel.a) : E.cursor;
      E.sel = { a: Math.min(a, t), b: Math.max(a, t) };
      renderTools(); draw();
      return;
    }
    down = { t, x: e.clientX };
  };
  cv.onwheel = (e) => {
    e.preventDefault();
    if (e.metaKey || e.ctrlKey) zoomTo(E.view.spp * Math.exp(e.deltaY * 0.01), tAt(e));
    else {
      const d = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * E.view.spp;
      E.view.start = clamp(E.view.start + d, 0, Math.max(0, toT(E.buf.length) - viewDur()));
      draw();
    }
  };
  $('#edOverview').onmousedown = (e) => { ovDown = true; ovMove(e); };
}
addEventListener('mousemove', (e) => {
  const cv = mainCv();
  if (!cv || !E.buf) return;
  if (ovDown) { ovMove(e); return; }
  if (E.moveMode) {
    const r = cv.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) { E.hoverT = tAt(e); draw(); }
  }
  if (down && Math.abs(e.clientX - down.x) > 3) {
    const t = tAt(e);
    E.sel = { a: Math.min(down.t, t), b: Math.max(down.t, t) };
    draw();
  }
});
addEventListener('mouseup', (e) => {
  ovDown = false;
  if (!down) return;
  const d = down;
  down = null;
  if (!mainCv() || !E.buf) return;
  if (Math.abs(e.clientX - d.x) <= 3) {
    E.sel = null;
    E.cursor = d.t;
    if (E.node) play(d.t);
  } else if (E.sel) {
    E.cursor = E.sel.a;
    if (E.node) play(E.sel.a);
  }
  renderTools(); draw();
});

$('#stage').addEventListener('click', (e) => {
  if (S.mode !== 'edit') return;
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open) return openItem(S.byId.get(open));
  if (e.target.closest('#edExport')) return exportEdit();
  if (e.target.closest('[data-fit]')) return fitAll();
  const w = e.target.closest('[data-w]')?.dataset.w;
  if (w) return setWhich(w);
  const op = e.target.closest('[data-op]')?.dataset.op;
  if (!op) return;
  if (op === 'toggle') return toggle();
  if (op === 'loop') { E.loop = !E.loop; if (E.node) play(playheadT()); renderTools(); return; }
  ops[op]?.();
});
$('#stage').addEventListener('input', (e) => {
  if (S.mode !== 'edit') return;
  if (e.target.id === 'edZoom') {
    const lo = Math.log(minSpp()), hi = Math.log(maxSpp());
    zoomTo(Math.exp(hi - (Number(e.target.value) / 100) * (hi - lo)), E.node ? playheadT() : (E.sel ? (E.sel.a + E.sel.b) / 2 : E.cursor));
  }
  if (e.target.matches('[data-fadelen]')) E.fadeLen = clamp(Number(e.target.value) || 3, 0.1, 60);
});
$('#stage').addEventListener('change', (e) => {
  if (S.mode !== 'edit' || !E.buf) return;
  const k = e.target.dataset.k;
  if (k === 'sa' || k === 'sb') {
    const a = parseTime($('[data-k=sa]').value), b = parseTime($('[data-k=sb]').value);
    const dur = toT(E.buf.length);
    if (a != null && b != null && b > a) { E.sel = { a: clamp(a, 0, dur), b: clamp(b, 0, dur) }; E.cursor = E.sel.a; }
    else if (a == null && b == null) E.sel = null;
    renderTools(); draw();
  }
});

document.addEventListener('keydown', (e) => {
  if (S.mode !== 'edit' || !E.buf || document.querySelector('#modalRoot .modal')) return;
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && !['checkbox', 'range'].includes(document.activeElement.type);
  if (typing) return;
  const cmd = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  if (e.key === ' ') { e.preventDefault(); toggle(); }
  else if (e.key === 'Escape') { E.moveMode = false; E.sel = null; renderTools(); draw(); }
  else if ((e.key === 'Backspace' || e.key === 'Delete') && E.sel) { e.preventDefault(); ops.del(); }
  else if (cmd && k === 'z' && e.shiftKey) { e.preventDefault(); ops.redo(); }
  else if (cmd && k === 'z') { e.preventDefault(); ops.undo(); }
  else if (cmd && k === 'x') { e.preventDefault(); ops.cut(); }
  else if (cmd && k === 'c') { e.preventDefault(); ops.copy(); }
  else if (cmd && k === 'v') { e.preventDefault(); ops.paste(); }
  else if (cmd && k === 'a') { e.preventDefault(); E.sel = { a: 0, b: toT(E.buf.length) }; renderTools(); draw(); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    E.cursor = clamp(playheadT() + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 5 : 1), 0, toT(E.buf.length));
    if (E.node) play(E.cursor); else draw();
  }
});
addEventListener('resize', () => { if (S.mode === 'edit' && E.buf) draw(); });

export function leaveEditor() { stop(); }
export const editorDirty = () => E.dirty;
on('edit-item', (it) => openItem(it));
on('player-start', () => { if (E.node) { stop(); renderTools(); draw(); } });
on('items', () => { if (S.mode === 'edit' && !E.item) render(); });
on('focus', () => { if (S.mode === 'edit' && !E.loading) render(); });
