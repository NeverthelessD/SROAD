// SROAD stage for ROAD Vocal / Track / Pitch / Tempo
import { S, $, $$, esc, api, toast, emit, on, MODES, fmtTime, itemTitle, laneClass, drawPeaks, ICON, saveUI, clamp } from './core.js';
import { focused, checkedItems, pickFiles, focusItem } from './library.js';

// ── illustrations ──
const ART = {
  vocal: `<svg width="270" height="140" viewBox="0 0 270 140" aria-hidden="true">
    <defs><linearGradient id="vg" x1="0" x2="1"><stop offset="0" stop-color="#ff5c8a" stop-opacity=".0"/><stop offset=".35" stop-color="#ff5c8a"/></linearGradient>
    <linearGradient id="vg2" x1="0" x2="1"><stop offset="0" stop-color="#8a6cff" stop-opacity=".0"/><stop offset=".35" stop-color="#8a6cff"/></linearGradient></defs>
    <path d="M118 70 C 160 70, 170 38, 262 38" stroke="url(#vg)" stroke-width="16" fill="none" stroke-linecap="round"/>
    <path d="M118 70 C 160 70, 170 102, 262 102" stroke="url(#vg2)" stroke-width="16" fill="none" stroke-linecap="round"/>
    <g fill="#fff" opacity=".9"><path d="M226 30v16M231 33v10M236 28v20M241 34v8M246 31v14" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g>
    <g stroke="#fff" stroke-width="2.4" stroke-linecap="round" opacity=".9"><path d="M222 94v16M227 98v8M232 92v20M237 97v10M242 95v14M247 99v6"/></g>
    <rect x="52" y="22" width="40" height="66" rx="20" fill="#ff5c8a"/>
    <g stroke="#fff" stroke-opacity=".55" stroke-width="2"><path d="M60 42h24M60 50h24M60 58h24M60 66h24"/></g>
    <path d="M42 66a30 30 0 0 0 60 0" stroke="currentColor" stroke-width="5" fill="none" stroke-linecap="round" opacity=".55"/>
    <path d="M72 96v20M58 118h28" stroke="currentColor" stroke-width="5" stroke-linecap="round" opacity=".55"/>
    <path d="M20 44c-7 8-7 22 0 30M30 50c-4 5-4 13 0 18" stroke="#ff5c8a" stroke-width="3" fill="none" stroke-linecap="round" opacity=".7"/>
  </svg>`,
  track: `<svg width="270" height="140" viewBox="0 0 270 140" aria-hidden="true">
    ${[['#ff5c8a', 'M', 18], ['#8a6cff', 'D', 48], ['#2bc5e8', 'B', 78], ['#ffb020', 'K', 108]].map(([c, l, y], i) => `
      <rect x="10" y="${y}" width="250" height="24" rx="12" fill="${c}" opacity=".16"/>
      <circle cx="22" cy="${y + 12}" r="12" fill="${c}"/>
      <text x="22" y="${y + 16.5}" text-anchor="middle" font-family="Unbounded" font-weight="700" font-size="11" fill="#fff">${l}</text>
      <g stroke="${c}" stroke-width="3" stroke-linecap="round">${Array.from({ length: 26 }, (_, k) => { const h = 3 + Math.abs(Math.sin((k + 1) * (i + 1.7) * 0.9)) * 13; const x = 46 + k * 8; return `<path d="M${x} ${y + 12 - h / 2}v${h}"/>`; }).join('')}</g>`).join('')}
  </svg>`,
  pitch: `<svg width="270" height="140" viewBox="0 0 270 140" aria-hidden="true">
    ${Array.from({ length: 10 }, (_, i) => `<rect x="${20 + i * 23}" y="56" width="21" height="72" rx="4" fill="${i === 2 ? '#a29fbd' : i === 6 ? '#2bc5e8' : 'currentColor'}" opacity="${i === 2 || i === 6 ? 1 : .14}"/>`).join('')}
    ${[1, 2, 4, 5, 6, 8, 9].map((i) => `<rect x="${20 + i * 23 - 7}" y="56" width="14" height="44" rx="3" fill="#2d2a45"/>`).join('')}
    <path d="M82 48 C 100 18, 150 18, 174 46" stroke="#2bc5e8" stroke-width="4" fill="none" stroke-linecap="round"/>
    <path d="M164 42 l11 6 l2-12" stroke="#2bc5e8" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="128" y="16" text-anchor="middle" font-family="Unbounded" font-weight="800" font-size="15" fill="#2bc5e8">+2</text>
  </svg>`,
  tempo: `<svg width="270" height="140" viewBox="0 0 270 140" aria-hidden="true">
    <path d="M100 128 L124 16 h22 L170 128 z" fill="#ffb020" opacity=".9"/>
    <rect x="96" y="120" width="78" height="12" rx="4" fill="#ffb020"/>
    <path d="M110 104 h50" stroke="#fff" stroke-width="3" opacity=".5"/>
    <g class="pend"><path d="M135 104 L135 26" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><rect x="127" y="44" width="16" height="12" rx="3" fill="currentColor"/></g>
    <g stroke="#ffb020" stroke-width="3" stroke-linecap="round" opacity=".7"><path d="M200 50 h44M200 70 h30M200 90 h52"/></g>
    <g stroke="#ffb020" stroke-width="3" stroke-linecap="round" opacity=".7"><path d="M30 60 h40M42 80 h28"/></g>
    <style>.pend{transform-origin:135px 104px;animation:sw 1.2s ease-in-out infinite alternate}@keyframes sw{from{transform:rotate(-22deg)}to{transform:rotate(22deg)}}@media (prefers-reduced-motion: reduce){.pend{animation:none}}</style>
  </svg>`,
};

const COPY = {
  vocal: { h: ['ROAD ', 'Vocal'], ko: '보컬 추출', p: 'AI가 목소리와 반주를 나눠요. 노래방 MR과 목소리만 남긴 아카펠라를 한 번에 만들 수 있어요.', verb: '보컬 추출', batch: '일괄 보컬 추출' },
  track: { h: ['ROAD ', 'Track'], ko: '악기 분리', p: '보컬, 드럼, 베이스, 그 밖의 악기를 각각 파일로 나눠요. 악기 연습용으로 필요한 트랙만 골라 합칠 수도 있어요.', verb: '악기 분리', batch: '일괄 악기 분리' },
  pitch: { h: ['ROAD ', 'Pitch'], ko: '키 변경', p: '빠르기는 그대로 두고 키만 반음 단위로 올리거나 내려요. 내 음역대에 맞춰 부르기 좋게.', verb: '키 변경', batch: '일괄 키 변경' },
  tempo: { h: ['ROAD ', 'Tempo'], ko: '템포 변경', p: '음 높이는 그대로 두고 빠르기만 바꿔요. 어려운 구간 연습은 느리게, 운동용은 빠르게.', verb: '템포 변경', batch: '일괄 템포 변경' },
};

const STEMS4 = [['vocals', '보컬', 'var(--vocal)'], ['drums', '드럼', 'var(--track)'], ['bass', '베이스', 'var(--pitch)'], ['other', '그 밖의 악기', 'var(--tempo)']];
const STEMS6 = [...STEMS4.slice(0, 3), ['guitar', '기타', 'var(--edit)'], ['piano', '피아노', '#ff8f5c'], ['other', '그 밖의 악기', 'var(--tempo)']];

// ── option consoles ──
function consoleHTML(mode) {
  const p = S.params[mode];
  const models = S.setup?.models || {};
  if (mode === 'vocal') {
    return `
    <div class="crow"><div class="cl">만들 파일<small>둘 다 고를 수 있어요</small></div>
      <div class="pills">
        <button class="pill ${p.instrumental ? 'on' : ''}" data-tog="instrumental"><span class="bx"></span><span>MR<small>목소리를 뺀 반주</small></span></button>
        <button class="pill ${p.vocals ? 'on' : ''}" data-tog="vocals"><span class="bx"></span><span>보컬<small>목소리만 남긴 아카펠라</small></span></button>
      </div></div>
    <div class="crow"><div class="cl">AI 품질</div>
      <div><div class="pills">
        <button class="pill ${p.model === 'htdemucs' ? 'on' : ''}" data-model="htdemucs"><span>빠르게<small>대부분의 곡에 충분해요</small></span></button>
        <button class="pill ${p.model === 'htdemucs_ft' ? 'on' : ''}" data-model="htdemucs_ft"><span>더 깨끗하게<small>시간이 약 4배 걸려요</small></span></button>
      </div>${p.model === 'htdemucs_ft' && !models.htdemucs_ft ? '<div class="hint">처음 쓸 때 고품질 모델(약 336MB)을 한 번 받아요.</div>' : ''}</div></div>`;
  }
  if (mode === 'track') {
    const stems = p.model === 'htdemucs_6s' ? STEMS6 : STEMS4;
    const avail = new Set(stems.map((s) => s[0]));
    const chips = (key) => stems.map(([k, l, c]) => `<button class="pill ${p[key].includes(k) && avail.has(k) ? 'on' : ''}" data-stem="${key}:${k}" style="--sc:${c}"><span class="bx"></span><span class="sw"></span>${l}</button>`).join('');
    return `
    <div class="crow"><div class="cl">분리 방식</div>
      <div><div class="pills">
        <button class="pill ${p.model === 'htdemucs' ? 'on' : ''}" data-model="htdemucs"><span>4트랙<small>보컬 · 드럼 · 베이스 · 그 밖의 악기</small></span></button>
        <button class="pill ${p.model === 'htdemucs_6s' ? 'on' : ''}" data-model="htdemucs_6s"><span>6트랙 (실험)<small>기타와 피아노를 더 나눠요</small></span></button>
      </div>${p.model === 'htdemucs_6s' ? `<div class="hint">피아노는 아직 정확도가 낮을 수 있어요.${!models.htdemucs_6s ? ' 처음 쓸 때 모델(약 55MB)을 받아요.' : ''}</div>` : ''}</div></div>
    <div class="crow"><div class="cl">저장할 트랙</div><div class="pills">${chips('stems')}</div></div>
    <div class="crow"><div class="cl">합친 파일도 만들기<small>예: 드럼만 뺀 연습용</small></div>
      <div><label class="switch-row"><input type="checkbox" data-mixon ${p.mixOn ? 'checked' : ''}><span class="switch"></span>고른 트랙을 하나로 합친 파일 만들기</label>
      ${p.mixOn ? `<div class="pills" style="margin-top:10px">${chips('mix')}</div>
      <div class="presets"><button data-mixp="vocals">노래방 (보컬 빼기)</button><button data-mixp="drums">드럼 연습 (드럼 빼기)</button><button data-mixp="bass">베이스 연습 (베이스 빼기)</button></div>` : ''}</div></div>`;
  }
  if (mode === 'pitch') {
    const n = p.semitones;
    const desc = n === 0 ? '원래 키' : `${Math.abs(n) === 12 ? '한 옥타브' : Math.abs(n) === 2 ? '온음' : Math.abs(n) === 1 ? '반음' : `반음 ${Math.abs(n)}개`} ${n > 0 ? '올림' : '내림'}`;
    // two octaves of a real keyboard: C4 is the original key, the accent key is the new one
    const WHITE = [0, 2, 4, 5, 7, 9, 11], BLACK = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 };
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const from = 12, to = 12 + n; // semitone index from C3
    let whites = '', blacks = '';
    const wCount = 15;
    for (let i = 0; i < wCount; i++) {
      const semi = Math.floor(i / 7) * 12 + WHITE[i % 7];
      const cls = semi === from ? 'from' : semi === to ? 'to' : '';
      whites += `<i class="w ${cls}">${semi === from || semi === to ? `<span class="lab">${NAMES[semi % 12]}</span>` : ''}</i>`;
    }
    for (let o = 0; o < 2; o++) for (const [b, w] of Object.entries(BLACK)) {
      const semi = o * 12 + Number(b);
      const left = ((o * 7 + w + 1) / wCount) * 100;
      const cls = semi === from ? 'from' : semi === to ? 'to' : '';
      blacks += `<i class="k ${cls}" style="left:calc(${left}% - 2.6%);width:5.2%"></i>`;
    }
    const keys = [whites + blacks];
    return `
    <div class="crow"><div class="cl">키<small>반음 단위, −12 ~ +12</small></div>
      <div><div class="dial"><button class="step" data-st="-1" title="반음 내리기">−</button>
        <div class="val">${n > 0 ? '+' : ''}${n}<small>${desc}</small></div>
        <button class="step" data-st="1" title="반음 올리기">+</button>
        <input type="range" class="range" min="-12" max="12" step="1" value="${n}" data-semi style="flex:1"></div>
        <div class="keys">${keys.join('')}</div>
        <div class="presets">${[-5, -3, -2, -1, 1, 2, 3, 5].map((v) => `<button data-semip="${v}" class="${v === n ? 'on' : ''}">${v > 0 ? '+' : ''}${v}</button>`).join('')}</div></div></div>
    <div class="crow"><div class="cl">목소리 자연스럽게<small>보컬이 있는 곡에 추천</small></div>
      <label class="switch-row"><input type="checkbox" data-formants ${p.formants ? 'checked' : ''}><span class="switch"></span>목소리 톤이 변하지 않게 보정하기</label></div>`;
  }
  // tempo
  const pct = Math.round(p.rate * 100);
  const bpm = parseFloat(p.bpm);
  return `
    <div class="crow"><div class="cl">빠르기<small>50% ~ 200%</small></div>
      <div><div class="dial"><button class="step" data-tp="-5" title="5% 느리게">−</button>
        <div class="val">${pct}%<small>${pct === 100 ? '원래 빠르기' : pct < 100 ? `${100 - pct}% 느리게` : `${pct - 100}% 빠르게`}</small></div>
        <button class="step" data-tp="5" title="5% 빠르게">+</button>
        <input type="range" class="range" min="50" max="200" step="1" value="${pct}" data-rate style="flex:1"></div>
        <div class="presets">${[50, 75, 85, 90, 110, 125, 150].map((v) => `<button data-ratep="${v}" class="${v === pct ? 'on' : ''}">${v}%</button>`).join('')}</div></div></div>
    <div class="crow"><div class="cl">BPM으로 정하기<small>원곡 BPM을 알 때</small></div>
      <div class="bpm"><span class="grp">원곡 <input type="number" min="20" max="400" placeholder="예: 120" value="${esc(p.bpm)}" data-bpm> BPM</span>
        ${bpm > 0 ? `<span class="grp muted">지금 설정이면 <b style="color:var(--text)">${Math.round(bpm * p.rate)} BPM</b></span><span class="grp">목표 <input type="number" min="20" max="400" placeholder="BPM" data-target> BPM으로</span>` : ''}</div></div>
    <div class="crow"><div class="cl">음 높이</div>
      <div><label class="switch-row"><input type="checkbox" data-keep ${p.keepPitch ? 'checked' : ''}><span class="switch"></span>음 높이는 그대로 두기</label>
      <div class="hint">끄면 레코드판처럼 빨라질수록 음도 높아져요.</div></div></div>`;
}

// ── render ──
export function renderStage() {
  const mode = S.mode;
  if (mode === 'edit') return;
  const c = COPY[mode];
  const it = focused();
  const checked = checkedItems();
  const target = it
    ? `<div class="tw ${laneClass(it)}">${ICON.note}</div><div style="min-width:0;flex:1"><div class="tn">${esc(itemTitle(it))}</div>
       <div class="ts">${it.kind === 'result' ? `${esc(it.label)} 결과 · ` : ''}${fmtTime(it.duration)} · ${it.sampleRate / 1000}kHz${it.artist ? ' · ' + esc(it.artist) : ''}</div></div>
       <button class="mini" data-act="play">${ICON.play} 들어보기</button>`
    : `<div class="tw">${ICON.note}</div><div class="empty" style="flex:1">라이브러리에서 곡을 고르거나 음원을 넣어 주세요.</div><button class="btn go" data-act="pick">＋ 음원 선택</button>`;
  $('#stage').innerHTML = `<section class="mode">
    <div class="hero"><div><h1>${c.h[0]}<span>${c.h[1]}</span></h1><div class="ko">${c.ko}</div><p>${c.p}</p></div>${ART[mode]}</div>
    <div class="target">${target}</div>
    <div class="console" id="console">${consoleHTML(mode)}</div>
    <div class="actions">
      <button class="btn go big" data-act="run" ${it && ready() ? '' : 'disabled'}>${c.verb}</button>
      <button class="btn line big" data-act="batch" ${checked.length && ready() ? '' : 'disabled'}>${c.batch}${checked.length ? ` (${checked.length}곡)` : ''}</button>
      <span class="note">${checked.length ? '체크한 곡을 차례대로 처리해요' : '라이브러리에서 여러 곡을 체크하면 일괄 처리할 수 있어요'}</span>
    </div>
    <div class="results" id="results"></div>
  </section>`;
  renderResults();
}

const ready = () => !!S.setup?.ready;

export function renderResults() {
  const box = $('#results');
  if (!box) return;
  const it = focused();
  if (!it) { box.innerHTML = ''; return; }
  const results = S.items.filter((x) => x.parentId === it.id && x.mode === S.mode);
  const pending = S.jobs.filter((j) => j.itemId === it.id && j.kind === S.mode && (j.state === 'running' || j.state === 'queued'));
  const failed = S.jobs.filter((j) => j.itemId === it.id && j.kind === S.mode && j.state === 'error').slice(-1);
  let html = `<h3>이 곡의 ${MODES[S.mode].ko} 결과 <small>${results.length ? `${results.length}개 · 레인을 누르면 그 위치부터 재생돼요` : ''}</small></h3><div class="lanes">`;
  for (const j of pending) {
    html += `<div class="lane pending lane-${j.kind}"><span class="edge"></span><div class="lname"><b>${j.state === 'running' ? '처리 중' : '대기 중'}</b><span>${esc(j.detail)}</span></div>
      <div class="lwave"><div class="stage-txt">${esc(j.stage || '')}${j.device === 'mps' ? ' · GPU 가속' : ''}</div><div class="bar ${j.state === 'queued' ? '' : ''}"><i style="width:${Math.round(j.progress * 100)}%"></i></div></div>
      <div class="lact"><button class="mini" data-cancel="${j.id}">취소</button></div></div>`;
  }
  for (const r of results) {
    html += `<div class="lane ${laneClass(r)} ${r.mode === 'track' && r.stem ? 'stem-' + r.stem : ''}" data-id="${r.id}"><span class="edge"></span>
      <div class="lname"><b>${esc(r.label)}</b><span>${fmtTime(r.duration)} · ${r.savedPath ? esc(r.savedPath.split('.').pop().toUpperCase()) + ' 저장됨' : '저장 전'}</span></div>
      <div class="lwave" data-seek title="누르면 그 위치부터 재생"><canvas></canvas></div>
      <div class="lact">
        <button class="mini" data-r="play" title="재생">${ICON.play}</button>
        <button class="mini" data-r="compare" title="원곡과 번갈아 듣기">${ICON.compare} 비교</button>
        <button class="mini" data-r="edit" title="ROAD Edit에서 편집">${ICON.scissors}</button>
        <button class="mini" data-r="focus" title="이 결과로 다른 작업 하기 (예: MR의 키 바꾸기)">${ICON.next}</button>
        ${r.savedPath ? `<button class="mini" data-r="reveal" title="Finder에서 보기">${ICON.finder}</button>` : `<button class="mini" data-r="save" title="저장">${ICON.save} 저장</button>`}
      </div></div>`;
  }
  for (const j of failed) {
    if (!results.length && !pending.length) html += `<div class="none">⚠️ ${esc(j.error)}</div>`;
  }
  if (!results.length && !pending.length && !failed.length) html += `<div class="none">아직 결과가 없어요. 위에서 설정을 고르고 ‘${COPY[S.mode].verb}’를 눌러 주세요.</div>`;
  box.innerHTML = html + '</div>';
  $$('.lane[data-id] canvas', box).forEach((cv) => {
    const r = S.byId.get(cv.closest('.lane').dataset.id);
    const stemHex = { vocals: '#ff5c8a', drums: '#8a6cff', bass: '#2bc5e8', other: '#ffb020', guitar: '#2fd39a', piano: '#ff8f5c', mix: getComputedStyle(document.body).color };
    drawPeaks(cv, r.peaks, { color: r.mode === 'track' && r.stem ? stemHex[r.stem] : MODES[r.mode].hex });
  });
}

// pending lanes update without re-rendering everything
export function tickResults() {
  const box = $('#results');
  if (!box) return;
  const it = focused();
  const pend = it ? S.jobs.filter((j) => j.itemId === it.id && j.kind === S.mode && (j.state === 'running' || j.state === 'queued')) : [];
  const shown = $$('.lane.pending', box).length;
  if (pend.length !== shown) { renderResults(); return; }
  $$('.lane.pending', box).forEach((el, i) => {
    const j = pend[i];
    $('.bar i', el).style.width = Math.round(j.progress * 100) + '%';
    $('.stage-txt', el).textContent = (j.stage || '') + (j.device === 'mps' ? ' · GPU 가속' : '');
    $('.lname b', el).textContent = j.state === 'running' ? '처리 중' : '대기 중';
  });
}

// ── events ──
$('#stage').addEventListener('click', async (e) => {
  if (S.mode === 'edit') return;
  const t = e.target;
  const p = S.params[S.mode];
  const act = t.closest('[data-act]')?.dataset.act;
  if (act === 'pick') return pickFiles();
  if (act === 'play') return emit('play-item', focused());
  if (act === 'run') return submit([S.focusId], false);
  if (act === 'batch') return submit(checkedItems().map((x) => x.id), true);

  const tog = t.closest('[data-tog]')?.dataset.tog;
  if (tog) {
    p[tog] = !p[tog];
    if (!p.instrumental && !p.vocals) p[tog === 'vocals' ? 'instrumental' : 'vocals'] = true;
    return rerenderConsole();
  }
  const model = t.closest('[data-model]')?.dataset.model;
  if (model) {
    p.model = model;
    if (S.mode === 'track') {
      const avail = new Set((model === 'htdemucs_6s' ? STEMS6 : STEMS4).map((s) => s[0]));
      p.stems = [...avail];
      p.mix = p.mix.filter((s) => avail.has(s));
    }
    return rerenderConsole();
  }
  const stem = t.closest('[data-stem]')?.dataset.stem;
  if (stem) {
    const [key, name] = stem.split(':');
    const arr = p[key];
    const i = arr.indexOf(name);
    i >= 0 ? arr.splice(i, 1) : arr.push(name);
    if (key === 'stems' && !arr.length) arr.push(name);
    return rerenderConsole();
  }
  const mixp = t.closest('[data-mixp]')?.dataset.mixp;
  if (mixp) {
    const all = (p.model === 'htdemucs_6s' ? STEMS6 : STEMS4).map((s) => s[0]);
    p.mix = all.filter((s) => s !== mixp);
    return rerenderConsole();
  }
  const st = t.closest('[data-st]')?.dataset.st;
  if (st) { p.semitones = clamp(p.semitones + Number(st), -12, 12); return rerenderConsole(); }
  const sp = t.closest('[data-semip]')?.dataset.semip;
  if (sp) { p.semitones = Number(sp); return rerenderConsole(); }
  const tp = t.closest('[data-tp]')?.dataset.tp;
  if (tp) { p.rate = clamp(Math.round(p.rate * 100 + Number(tp)) / 100, 0.5, 2); return rerenderConsole(); }
  const rp = t.closest('[data-ratep]')?.dataset.ratep;
  if (rp) { p.rate = Number(rp) / 100; return rerenderConsole(); }

  // result lanes
  const lane = t.closest('.lane[data-id]');
  const cancel = t.closest('[data-cancel]')?.dataset.cancel;
  if (cancel) { api(`/api/job/cancel?id=${cancel}`).catch(() => {}); return; }
  if (!lane) return;
  const r = S.byId.get(lane.dataset.id);
  const ra = t.closest('[data-r]')?.dataset.r;
  if (ra === 'play') emit('play-item', r);
  else if (ra === 'compare') emit('compare', r);
  else if (ra === 'edit') { emit('set-mode', 'edit'); emit('edit-item', r); }
  else if (ra === 'focus') { focusItem(r.id); toast(`‘${r.label}’ 결과를 골랐어요. 이제 다른 ROAD 기능을 적용할 수 있어요`); }
  else if (ra === 'reveal') api('/api/reveal', { paths: [r.savedPath] });
  else if (ra === 'save') saveResult(r);
  else if (t.closest('[data-seek]')) {
    const rect = t.closest('[data-seek]').getBoundingClientRect();
    emit('play-item', r, (e.clientX - rect.left) / rect.width);
  }
});

$('#stage').addEventListener('input', (e) => {
  if (S.mode === 'edit') return;
  const p = S.params[S.mode];
  const t = e.target;
  if (t.matches('[data-semi]')) { p.semitones = Number(t.value); rerenderConsole(true); }
  else if (t.matches('[data-rate]')) { p.rate = Number(t.value) / 100; rerenderConsole(true); }
  else if (t.matches('[data-bpm]')) { p.bpm = t.value; saveUI(); }
  else if (t.matches('[data-target]')) {
    const b = parseFloat(p.bpm), tg = parseFloat(t.value);
    if (b > 0 && tg > 0) { p.rate = clamp(tg / b, 0.5, 2); updateDialOnly(); }
  }
});
$('#stage').addEventListener('change', (e) => {
  if (S.mode === 'edit') return;
  const p = S.params[S.mode];
  const t = e.target;
  if (t.matches('[data-mixon]')) { p.mixOn = t.checked; rerenderConsole(); }
  else if (t.matches('[data-formants]')) { p.formants = t.checked; saveUI(); }
  else if (t.matches('[data-keep]')) { p.keepPitch = t.checked; saveUI(); }
  else if (t.matches('[data-bpm]')) rerenderConsole();
  else if (t.matches('[data-semi],[data-rate]')) rerenderConsole();
});

function updateDialOnly() {
  const pct = Math.round(S.params.tempo.rate * 100);
  const v = $('#console .val');
  if (v) v.firstChild.textContent = pct + '%';
  const r = $('#console [data-rate]');
  if (r) r.value = pct;
}

function rerenderConsole(keepFocus) {
  const c = $('#console');
  if (!c) return;
  const active = keepFocus ? document.activeElement?.matches('[data-semi],[data-rate]') : false;
  if (active) {
    // while dragging a slider only refresh the readouts
    const p = S.params[S.mode];
    if (S.mode === 'pitch') {
      const n = p.semitones;
      $('.val', c).firstChild.textContent = (n > 0 ? '+' : '') + n;
    } else updateDialOnly();
    saveUI();
    return;
  }
  c.innerHTML = consoleHTML(S.mode);
  saveUI();
}

function paramsFor(mode) {
  const p = S.params[mode];
  if (mode === 'vocal') return { instrumental: p.instrumental, vocals: p.vocals, model: p.model };
  if (mode === 'track') {
    const avail = new Set((p.model === 'htdemucs_6s' ? STEMS6 : STEMS4).map((s) => s[0]));
    return { model: p.model, stems: p.stems.filter((s) => avail.has(s)), mix: p.mixOn ? p.mix.filter((s) => avail.has(s)) : [] };
  }
  if (mode === 'pitch') return { semitones: p.semitones, formants: p.formants };
  return { rate: p.rate, keepPitch: p.keepPitch };
}

async function submit(ids, batch) {
  ids = ids.filter(Boolean);
  if (!ids.length) return;
  const mode = S.mode;
  if (mode === 'pitch' && S.params.pitch.semitones === 0) return toast('키를 먼저 바꿔 주세요 (지금은 원래 키예요)');
  if (mode === 'tempo' && Math.round(S.params.tempo.rate * 100) === 100) return toast('빠르기를 먼저 바꿔 주세요 (지금은 100%예요)');
  if (mode === 'track' && S.params.track.mixOn && S.params.track.mix.length < 2) return toast('합칠 트랙을 두 개 이상 골라 주세요');
  try {
    const j = await api('/api/jobs', { kind: mode, ids, params: paramsFor(mode), export: { ...S.export }, batch });
    toast(batch ? `🎶 ${j.jobs.length}곡을 대기열에 넣었어요` : `🎶 ${COPY[mode].verb}을 시작했어요`);
    emit('refresh');
    if (!batch) setTimeout(() => $('#results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 400);
  } catch (err) { toast('⚠️ ' + err.message, 5000); }
}

export async function saveResult(r) {
  try {
    await api('/api/save-item', { id: r.id, export: { ...S.export } });
    toast('💾 저장을 시작했어요');
    emit('refresh');
  } catch (err) { toast('⚠️ ' + err.message); }
}

on('focus', () => { if (S.mode !== 'edit') renderStage(); });
on('checked', () => { if (S.mode !== 'edit') renderStage(); });
