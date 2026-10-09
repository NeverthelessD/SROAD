// SROAD player (bottom bar) with A/B compare against the original
import { S, $, $$, esc, on, emit, streamURL, drawPeaks, fmtTime, MODES, ICON, itemTitle, laneClass, toast } from './core.js';

const P = {
  item: null,      // what is shown (result when comparing)
  other: null,     // original when comparing
  side: 'B',       // 'A' = original, 'B' = result
  a: new Audio(),  // original
  b: new Audio(),  // main
  vol: 1,
};
P.a.preload = 'auto';
P.b.preload = 'auto';

function canNative(it) {
  const probe = document.createElement('audio');
  const types = { mp3: 'audio/mpeg', aac: 'audio/mp4; codecs="mp4a.40.2"', flac: 'audio/flac', vorbis: 'audio/ogg; codecs="vorbis"', opus: 'audio/ogg; codecs="opus"' };
  if (it.codec?.startsWith('pcm_')) return true;
  const t = types[it.codec];
  return t ? probe.canPlayType(t) !== '' : false;
}
const src = (it) => streamURL(it.id, !canNative(it));
const main = () => P.b;
const audible = () => (P.other && P.side === 'A' ? P.a : P.b);

export function renderPlayer() {
  const el = $('#player');
  const it = P.item;
  const lane = it ? laneClass(it) : '';
  el.className = `player ${lane} ${!main().paused ? 'playing' : ''}`;
  el.innerHTML = `
    <div class="np"><div class="disc"></div><div class="t"><b>${it ? esc(itemTitle(it)) : '재생 중인 곡이 없어요'}</b>
      <span>${it ? (it.kind === 'result' ? `${esc(it.label)} · ${MODES[it.mode]?.name || ''}` : '원곡') : '라이브러리에서 ▶︎를 눌러 보세요'}</span></div></div>
    <div class="transport">
      <button class="play-big" id="pPlay" ${it ? '' : 'disabled'} title="재생 / 일시정지 (스페이스)">${main().paused ? ICON.play : ICON.pause}</button>
      <button class="mini" id="pStop" ${it ? '' : 'disabled'} title="처음으로">${ICON.stop}</button>
    </div>
    <div class="scrub"><span class="tm" id="pCur">0:00</span><canvas id="pWave"></canvas><span class="tm" id="pDur">${it ? fmtTime(it.duration) : '0:00'}</span></div>
    <div class="ab">
      ${P.other ? `<div class="seg" id="pAB" title="재생 중에 바꾸면 같은 위치에서 이어서 들려요"><button data-s="A" class="${P.side === 'A' ? 'on' : ''}">원곡</button><button data-s="B" class="${P.side === 'B' ? 'on' : ''}">${esc(it.label || '결과')}</button></div>` : ''}
      <input type="range" class="vol" id="pVol" min="0" max="1" step="0.01" value="${P.vol}" title="볼륨">
    </div>`;
  drawWave();
  $('#pPlay', el).onclick = toggle;
  $('#pStop', el).onclick = () => { seek(0); pause(); };
  $('#pVol', el).oninput = (e) => { P.vol = Number(e.target.value); applyVolume(); };
  $('#pWave', el).onclick = (e) => {
    if (!P.item) return;
    const r = e.target.getBoundingClientRect();
    seek(((e.clientX - r.left) / r.width) * (main().duration || P.item.duration));
  };
  const ab = $('#pAB', el);
  if (ab) ab.onclick = (e) => { const s = e.target.closest('[data-s]')?.dataset.s; if (s) setSide(s); };
}

function drawWave() {
  const cv = $('#pWave');
  if (!cv) return;
  const it = P.side === 'A' && P.other ? P.other : P.item;
  const d = main().duration || P.item?.duration || 1;
  const color = P.item?.kind === 'result' ? MODES[P.item.mode]?.hex : '#a29fbd';
  drawPeaks(cv, it?.peaks, { color, progress: main().currentTime / d, played: color });
}

function applyVolume() {
  if (P.other) {
    P.a.volume = P.side === 'A' ? P.vol : 0;
    P.b.volume = P.side === 'B' ? P.vol : 0;
  } else {
    P.b.volume = P.vol;
  }
}

function load(item, other) {
  pause();
  P.item = item;
  P.other = other || null;
  P.side = 'B';
  P.b.src = src(item);
  if (P.other) { P.a.src = src(P.other); } else { P.a.removeAttribute('src'); P.a.load(); }
  applyVolume();
  renderPlayer();
  emit('play-marks');
}

export async function playItem(item, at = 0) {
  if (!item) return;
  if (P.item?.id !== item.id || P.other) load(item, null);
  else if (!main().paused && at === 0) { pause(); return; }
  if (at) await waitMeta(main()).then(() => seek(at * main().duration));
  play();
}

export async function compare(result) {
  const orig = S.byId.get(result.parentId);
  if (!orig) return toast('원곡이 목록에 없어요');
  load(result, orig);
  play();
  toast('원곡 ↔ 결과 버튼을 눌러 번갈아 들어 보세요');
}

function waitMeta(a) {
  return a.readyState >= 1 ? Promise.resolve() : new Promise((r) => a.addEventListener('loadedmetadata', r, { once: true }));
}

export function play() {
  if (!P.item) return;
  emit('player-start');
  if (P.other) {
    P.a.currentTime = P.b.currentTime;
    P.a.play().catch(() => {});
  }
  P.b.play().catch((e) => toast('⚠️ 재생할 수 없어요: ' + e.message));
}
export function pause() { P.a.pause(); P.b.pause(); }
export function toggle() { main().paused ? play() : pause(); }
export function isPlaying() { return !main().paused; }
export function seek(t) {
  P.b.currentTime = t;
  if (P.other) P.a.currentTime = t;
  drawWave();
}
function setSide(s) {
  if (!P.other || s === P.side) return;
  P.side = s;
  if (Math.abs(P.a.currentTime - P.b.currentTime) > 0.04) P.a.currentTime = P.b.currentTime;
  applyVolume();
  renderPlayer();
}
export function playingId() { return isPlaying() ? P.item?.id : null; }

for (const a of [P.b]) {
  a.addEventListener('play', () => { $('#player')?.classList.add('playing'); const b = $('#pPlay'); if (b) b.innerHTML = ICON.pause; emit('play-marks'); });
  a.addEventListener('pause', () => { $('#player')?.classList.remove('playing'); const b = $('#pPlay'); if (b) b.innerHTML = ICON.play; emit('play-marks'); });
  a.addEventListener('ended', () => { P.a.pause(); emit('play-marks'); });
  a.addEventListener('loadedmetadata', () => { const d = $('#pDur'); if (d) d.textContent = fmtTime(a.duration); });
  a.addEventListener('error', () => { if (P.item) toast('⚠️ 이 파일을 재생하지 못했어요'); });
}
let last = 0;
function loop(ts) {
  if (!main().paused && ts - last > 60) {
    last = ts;
    const c = $('#pCur');
    if (c) c.textContent = fmtTime(main().currentTime);
    if (P.other && Math.abs(P.a.currentTime - P.b.currentTime) > 0.08) P.a.currentTime = P.b.currentTime;
    drawWave();
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
addEventListener('resize', drawWave);

on('play-item', (it, at) => playItem(it, at || 0));
on('compare', (r) => compare(r));
on('pause-all', pause);
on('play-marks', () => {
  const id = playingId();
  $$('#libList .row[data-id] .pbtn').forEach((b) => {
    const on = b.closest('.row').dataset.id === id;
    b.classList.toggle('playing', on);
    b.innerHTML = '<span class="lane"></span>' + (on ? ICON.pause : ICON.play);
  });
});
on('items', () => {
  if (P.item && !S.byId.has(P.item.id)) { pause(); P.item = null; P.other = null; renderPlayer(); }
});
