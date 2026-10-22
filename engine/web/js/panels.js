// SROAD side panel (save settings + queue), first-run setup, updates, settings
import { S, $, $$, esc, api, toast, emit, on, openModal, closeModal, confirmBox, MODES, shortPath, saveUI, fmtTime } from './core.js';

// ── save settings ──
const FORMATS = [['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV'], ['flac', 'FLAC']];
const QUALITY = [['128', '128k'], ['192', '192k'], ['320', '320k'], ['lossless', '무손실']];

function qualityNote() {
  const { format, quality } = S.export;
  if (format === 'wav') return 'WAV는 압축하지 않은 원음 그대로예요. 용량이 가장 커요.';
  if (format === 'flac') return 'FLAC은 음질 손실 없이 용량을 줄인 형식이에요.';
  if (format === 'm4a' && quality === 'lossless') return 'M4A 무손실은 Apple Lossless(ALAC)로 저장해요.';
  return { 128: '용량이 가장 작아요. 미리 듣기나 공유용', 192: '용량과 음질의 균형', 320: 'MP3·AAC 최고 음질이에요 (기본값)' }[quality] || '';
}

export function renderExport() {
  const el = $('#exportBox');
  const { format, quality, folder } = S.export;
  const def = S.settings?.resolvedDefaultFolder || '';
  const isDef = folder === def;
  const lossless = format === 'wav' || format === 'flac';
  el.innerHTML = `
    <h4>저장 설정</h4>
    <div class="lbl">파일 형식</div>
    <div class="seg" id="fmtSeg">${FORMATS.map(([v, l]) => `<button data-f="${v}" class="${format === v ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="lbl">음질</div>
    <div class="seg" id="qSeg">${QUALITY.map(([v, l]) => `<button data-q="${v}" class="${(lossless ? 'lossless' : quality) === v ? 'on' : ''}" ${lossless && v !== 'lossless' ? 'disabled' : ''}>${l}</button>`).join('')}</div>
    <div class="note">${esc(qualityNote())}</div>
    <div class="lbl">저장 폴더</div>
    <div class="folder"><div class="fi"><svg width="18" height="18" viewBox="0 0 20 20"><path d="M2.5 5.5A1.5 1.5 0 0 1 4 4h3.6l1.6 1.8H16a1.5 1.5 0 0 1 1.5 1.5v7.2A1.5 1.5 0 0 1 16 16H4a1.5 1.5 0 0 1-1.5-1.5z" fill="var(--tempo)"/></svg></div>
      <div class="ft"><b>${esc(folder.split('/').filter(Boolean).pop() || folder)}</b><span title="${esc(folder)}">${esc(shortPath(folder))}</span></div>
      <button class="mini" data-fa="change">변경</button></div>
    <div class="folder-sub">${isDef ? '<span class="ok-badge">✓ 기본 저장 폴더</span>' : '<button class="link" data-fa="default">이 폴더를 기본 폴더로</button>'}<button class="link" data-fa="open">폴더 열기</button></div>
    <label class="switch-row" style="font-size:12px"><input type="checkbox" data-autosave ${S.settings?.autoSave ? 'checked' : ''}><span class="switch"></span>작업이 끝나면 자동으로 저장</label>`;
}

$('#exportBox').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-f]')?.dataset.f;
  if (f) {
    S.export.format = f;
    if ((f === 'mp3') && S.export.quality === 'lossless') S.export.quality = '320';
    renderExport(); saveUI(); return;
  }
  const qv = e.target.closest('[data-q]')?.dataset.q;
  if (qv) {
    if (qv === 'lossless' && S.export.format === 'mp3') { S.export.format = 'flac'; toast('MP3에는 무손실이 없어서 FLAC으로 바꿨어요'); }
    S.export.quality = qv;
    renderExport(); saveUI(); return;
  }
  const fa = e.target.closest('[data-fa]')?.dataset.fa;
  try {
    if (fa === 'change') {
      const j = await api('/api/choose-folder', { start: S.export.folder });
      if (j.path) { S.export.folder = j.path; renderExport(); }
    } else if (fa === 'default') {
      S.settings = await api('/api/settings', { defaultFolder: S.export.folder });
      renderExport(); toast('📌 기본 저장 폴더로 정했어요');
    } else if (fa === 'open') api('/api/open', { path: S.export.folder });
  } catch (err) { toast('⚠️ ' + err.message); }
});
$('#exportBox').addEventListener('change', async (e) => {
  if (e.target.matches('[data-autosave]')) S.settings = await api('/api/settings', { autoSave: e.target.checked }).catch(() => S.settings);
});

// ── queue ──
function eta(j) {
  if (j.state !== 'running' || !j.started || j.progress < 0.08) return '';
  const el = (Date.now() - j.started) / 1000;
  const rest = (el / j.progress) * (1 - j.progress);
  return rest > 3 ? ` · 약 ${fmtTime(rest)} 남음` : '';
}
export function renderQueue() {
  const el = $('#queueBox');
  const jobs = S.jobs.slice().reverse();
  const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued').length;
  const finished = jobs.length - active;
  el.innerHTML = `
    <h4>작업 대기열 ${active ? `<span class="muted num" style="font-weight:600">${active}개 진행 중</span>` : ''}<span class="spacer"></span>
      ${active > 1 ? '<button class="link" data-qa="cancel-all">모두 취소</button>' : ''}
      ${finished ? '<button class="link" data-qa="clear">완료 지우기</button>' : ''}</h4>
    <div class="queue">${jobs.length ? jobs.slice(0, 60).map(qItem).join('') : '<div class="qempty">아직 작업이 없어요</div>'}</div>`;
}
function qItem(j) {
  const kind = j.kind === 'export' || j.kind === 'save' ? 'edit' : j.kind;
  const st = { queued: '대기', running: `${Math.round(j.progress * 100)}%`, done: '완료', error: '실패', canceled: '취소됨' }[j.state];
  return `<div class="qitem lane-${kind} ${j.state}" data-job="${j.id}" title="${esc(j.error || j.stage || '')}"><span class="qe"></span>
    <div class="qt"><b>${esc(j.itemName)}</b><span>${esc(j.title)} · ${esc(j.detail)}${j.state === 'running' ? ' · ' + esc(j.stage || '') + eta(j) : j.state === 'error' ? ' · ' + esc(j.error) : ''}</span>
      ${j.state === 'running' || j.state === 'queued' ? `<div class="bar"><i style="width:${Math.round(j.progress * 100)}%"></i></div>` : ''}</div>
    <div style="display:flex;align-items:center;gap:6px"><span class="qs num">${st}</span>
      ${j.state === 'running' || j.state === 'queued' ? `<button class="qx" data-cancel="${j.id}" title="취소">✕</button>` : ''}
      ${j.state === 'done' && j.saved?.length ? `<button class="qx" data-reveal="${j.id}" title="Finder에서 보기">📁</button>` : ''}</div></div>`;
}
$('#queueBox').addEventListener('click', (e) => {
  const c = e.target.closest('[data-cancel]')?.dataset.cancel;
  if (c) return api(`/api/job/cancel?id=${c}`).catch(() => {});
  const r = e.target.closest('[data-reveal]')?.dataset.reveal;
  if (r) { const j = S.jobs.find((x) => x.id === r); return api('/api/reveal', { paths: j.saved }); }
  const qa = e.target.closest('[data-qa]')?.dataset.qa;
  if (qa === 'cancel-all') api('/api/jobs/cancel-all', {}).catch(() => {});
  if (qa === 'clear') api('/api/jobs/clear', {}).then(() => emit('refresh')).catch(() => {});
  const item = e.target.closest('[data-job]');
  if (item && !qa) {
    const j = S.jobs.find((x) => x.id === item.dataset.job);
    const target = j?.results?.length ? S.byId.get(j.results[0])?.parentId : j?.itemId;
    if (target && S.byId.has(target)) { if (j.kind in MODES) emit('set-mode', j.kind); emit('focus-item', target); }
  }
});

// ── first-run setup overlay ──
let setupEl = null;
export function renderSetup() {
  const st = S.setup;
  const need = st && !st.ready;
  if (!need) { setupEl?.remove(); setupEl = null; return; }
  if (!setupEl) { setupEl = document.createElement('div'); setupEl.className = 'setup'; document.body.append(setupEl); }
  const steps = st.steps || [];
  const running = st.running;
  const upgrade = st.needUpgrade;
  const total = steps.reduce((n, s) => n + s.weight, 0) || 1;
  const pct = steps.reduce((n, s) => n + s.weight * (s.state === 'done' ? 1 : s.state === 'run' && s.total ? s.done / s.total : 0), 0) / total;
  setupEl.innerHTML = `<div class="setup-card">
    <div class="lanes-art"><i style="background:var(--vocal)"></i><i style="background:var(--track)"></i><i style="background:var(--pitch)"></i><i style="background:var(--tempo)"></i><i style="background:var(--edit)"></i></div>
    <h2>${upgrade ? 'AI 엔진을 새로 맞출게요' : 'SROAD에 오신 걸 환영해요'}</h2>
    <p>${upgrade ? '새 버전에 맞게 AI 엔진 일부를 다시 설치해야 해요. 몇 분이면 끝나요.' : '음원을 나누는 AI 엔진을 처음 한 번만 설치할게요. 약 300MB를 내려받고, 인터넷 속도에 따라 3~10분쯤 걸려요. 모든 파일은 이 앱 전용 폴더에만 들어가요.'}</p>
    ${st.error ? `<div class="setup-err" style="margin-top:16px">⚠️ ${esc(st.error)}</div>` : ''}
    ${steps.length ? `<div class="steps">${steps.map(stepHTML).join('')}</div>` : '<div style="height:22px"></div>'}
    ${running ? `<div class="bar" style="height:8px;--lane:var(--accent)"><i style="width:${Math.round(pct * 100)}%"></i></div><p style="margin-top:10px;font-size:12px">설치하는 동안 창을 닫아도 계속 진행돼요. 다시 열면 이어서 보여 드릴게요.</p>`
      : `<button class="btn go big" id="setupGo" style="width:100%">${st.error ? '다시 시도하기' : upgrade ? '업데이트 시작' : 'AI 엔진 설치 시작'}</button>`}
  </div>`;
  const go = $('#setupGo', setupEl);
  if (go) go.onclick = () => api('/api/setup/start', {}).then(() => emit('refresh')).catch((e) => toast('⚠️ ' + e.message));
}
function stepHTML(s) {
  const lbl = { wait: '대기', run: '설치 중', done: '완료', error: '실패' }[s.state];
  const el = s.state === 'run' && s.start ? Math.round((Date.now() - s.start) / 1000) : 0;
  const prog = s.state === 'run' ? (s.total ? `<div class="bar"><i style="width:${Math.round((s.done / s.total) * 100)}%"></i></div>` : '<div class="bar ind"><i></i></div>') : '';
  return `<div class="stp ${s.state}"><div class="se">${s.emoji}</div><div><b>${esc(s.label)}</b><span>${esc(s.state === 'run' && s.detail ? s.detail : s.hint)}</span>${prog}</div>
    <div class="ss">${lbl}${el > 4 ? ` · ${el}s` : ''}</div></div>`;
}

// ── version badge, update modal, banner ──
export function renderVersion() {
  const u = S.update;
  if (!u) return;
  const b = $('#verBtn');
  b.className = 'ver ' + ({ available: 'available', ready: 'ready', downloading: 'busy', installing: 'busy', checking: 'busy', error: 'error' }[u.status] || '');
  $('#verText').textContent = 'v' + u.current;
  b.title = { available: `새 버전 v${u.latest?.version}이 있어요`, ready: `v${u.installed} 설치 완료 · 다시 시작하면 적용돼요`, downloading: '업데이트를 내려받는 중', installing: '업데이트 설치 중', uptodate: '최신 버전이에요' }[u.status] || '버전 · 업데이트';
  renderBanner();
  if (updEl?.isConnected) fillUpdate();
}

function renderBanner() {
  const u = S.update;
  const el = $('#banner');
  if (u?.status === 'ready' && u.installed) {
    el.hidden = false;
    el.innerHTML = `<span style="font-size:18px">✨</span><div style="flex:1"><b>SROAD v${esc(u.installed)}을(를) 설치했어요.</b> <span class="muted">다시 시작하면 새 버전이 적용돼요.</span></div>
      <button class="btn go" data-up="restart">지금 다시 시작</button><button class="btn ghost" data-up="later">나중에</button>`;
  } else if (u?.status === 'available' && !u.autoUpdate) {
    el.hidden = false;
    el.innerHTML = `<span style="font-size:18px">🎁</span><div style="flex:1"><b>새 버전 v${esc(u.latest.version)}이 나왔어요.</b></div>
      <button class="btn go" data-up="install">업데이트</button><button class="btn ghost" data-up="later">나중에</button>`;
  } else el.hidden = true;
}
$('#banner').addEventListener('click', (e) => {
  const a = e.target.closest('[data-up]')?.dataset.up;
  if (a === 'restart') restartApp();
  if (a === 'install') api('/api/update/install', {}).then(() => emit('refresh'));
  if (a === 'later') $('#banner').hidden = true;
});

export async function restartApp() {
  const busy = S.jobs.some((j) => j.state === 'running' || j.state === 'queued');
  if (busy && !(await confirmBox('다시 시작', '진행 중인 작업이 있어요. 다시 시작하면 그 작업은 취소돼요.', '다시 시작'))) return;
  try {
    await api('/api/update/restart', {});
    showEnded('새 버전으로 다시 시작하는 중이에요…', true);
    const old = S.build;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const j = await api('/api/ping'); if (j.build && j.build !== old) { location.reload(); return; } if (i > 8) { location.reload(); return; } } catch { /* starting */ }
    }
    showEnded('다시 시작하지 못했어요. SROAD 앱을 직접 실행해 주세요.');
  } catch (err) { toast('⚠️ ' + err.message, 6000); }
}

let updEl = null;
export function openUpdate() {
  updEl = document.createElement('div');
  updEl.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  openModal('버전 · 업데이트', updEl, { onClose: () => { updEl = null; } });
  fillUpdate();
  api('/api/update/check').then(() => emit('refresh')).catch(() => {});
}
function fillUpdate() {
  const u = S.update;
  const st = {
    checking: '확인하는 중…', uptodate: '최신 버전을 쓰고 있어요 ✓', available: `새 버전 v${u.latest?.version}이 있어요`,
    downloading: `내려받는 중 ${Math.round((u.progress || 0) * 100)}%`, installing: '설치하는 중…', ready: `v${u.installed} 설치 완료 · 다시 시작하면 적용돼요`,
    error: u.error || '확인하지 못했어요', idle: '아직 확인하지 않았어요',
  }[u.status];
  const notes = u.latest?.notes?.length ? `<div class="box" style="gap:6px"><h4>v${esc(u.latest.version)} 바뀐 점 <span class="muted" style="font-weight:500">${esc(u.latest.date || '')}</span></h4><ul class="notes">${u.latest.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></div>` : '';
  updEl.innerHTML = `
    <div class="box">
      <div class="kv"><span>지금 버전</span><b class="disp">v${esc(u.current)}</b></div>
      <div class="kv"><span>최신 버전</span><b class="disp">${u.latest ? 'v' + esc(u.latest.version) : '—'}</b></div>
      <div class="kv"><span>상태</span><b>${esc(st)}</b></div>
      ${u.status === 'downloading' ? `<div class="bar"><i style="width:${Math.round((u.progress || 0) * 100)}%"></i></div>` : ''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" data-u="check" ${['checking', 'downloading', 'installing'].includes(u.status) ? 'disabled' : ''}>업데이트 확인</button>
        ${u.status === 'available' ? '<button class="btn go" data-u="install">지금 업데이트</button>' : ''}
        ${u.status === 'ready' ? '<button class="btn go" data-u="restart">다시 시작해서 적용</button>' : ''}
      </div>
    </div>
    ${notes}
    <div class="box">
      <label class="switch-row"><input type="checkbox" data-u="auto" ${u.autoUpdate ? 'checked' : ''}><span class="switch"></span>자동 업데이트</label>
      <div class="note">켜 두면 앱을 켤 때와 6시간마다 새 버전을 확인하고, 진행 중인 작업이 끝난 뒤 알아서 설치해요. 새 버전은 다시 시작할 때 적용돼요.</div>
      ${u.canRollback ? `<div class="folder-sub"><span class="muted">문제가 생기면 이전 버전으로 돌아갈 수 있어요.</span><button class="link" data-u="rollback">v${esc(u.backupVersion)}으로 되돌리기</button></div>` : ''}
    </div>`;
}
document.addEventListener('click', async (e) => {
  const a = e.target.closest('#modalRoot [data-u]')?.dataset.u;
  if (!a || a === 'auto') return;
  try {
    if (a === 'check') { S.update.status = 'checking'; fillUpdate(); await api('/api/update/check'); }
    if (a === 'install') { await api('/api/update/install', {}); toast('업데이트를 내려받기 시작했어요'); }
    if (a === 'restart') { closeModal(); return restartApp(); }
    if (a === 'rollback') {
      if (!(await confirmBox('이전 버전으로 되돌리기', `v${esc(S.update.backupVersion)}으로 되돌릴까요? 다시 시작하면 적용돼요.`, '되돌리기'))) return;
      await api('/api/update/rollback', {});
      toast('이전 버전으로 바꿨어요. 다시 시작하면 적용돼요. 자동 업데이트는 꺼 두었어요', 6000);
    }
    emit('refresh');
  } catch (err) { toast('⚠️ ' + err.message, 5000); }
});
document.addEventListener('change', async (e) => {
  if (e.target.matches('#modalRoot [data-u=auto]')) {
    S.settings = await api('/api/settings', { autoUpdate: e.target.checked }).catch(() => S.settings);
    emit('refresh');
  }
});

// ── settings modal ──
export function openSettings() {
  const body = document.createElement('div');
  body.style.cssText = 'display:flex;flex-direction:column;gap:12px';
  const render = () => {
    const st = S.settings, info = S.setup?.info || {};
    body.innerHTML = `
      <div class="box"><h4>화면 모드</h4>
        <div class="seg" data-s="theme">${[['system', '시스템 설정'], ['light', '라이트'], ['dark', '다크']].map(([v, l]) => `<button data-v="${v}" class="${(st.appearance || 'system') === v ? 'on' : ''}">${l}</button>`).join('')}</div>
        <div class="note">‘시스템 설정’을 고르면 macOS의 라이트·다크 모드를 그대로 따라가요.</div></div>
      <div class="box"><h4>기본 저장 폴더</h4>
        <div class="folder"><div class="fi">📁</div><div class="ft"><b>${esc(st.resolvedDefaultFolder.split('/').pop())}</b><span>${esc(shortPath(st.resolvedDefaultFolder))}</span></div><button class="mini" data-s="folder">변경</button></div>
        <div class="folder-sub"><span class="muted">앱을 켤 때마다 이 폴더가 저장 위치가 돼요.</span>${st.defaultFolder ? '<button class="link" data-s="reset">음악 › SROAD로 되돌리기</button>' : ''}</div></div>
      <div class="box"><h4>작업</h4>
        <label class="switch-row"><input type="checkbox" data-s="autosave" ${st.autoSave ? 'checked' : ''}><span class="switch"></span>작업이 끝나면 자동으로 저장</label>
        <label class="switch-row"><input type="checkbox" data-s="reveal" ${st.revealAfter ? 'checked' : ''}><span class="switch"></span>저장이 끝나면 Finder에서 보여 주기</label></div>
      <div class="box"><h4>AI 엔진</h4>
        <div class="kv"><span>상태</span><b>${S.setup?.ready ? '준비됨' : '설치 필요'}</b></div>
        <div class="kv"><span>GPU 가속 (Apple Silicon)</span><b>${info.mps ? '사용 중' : '사용 안 함'}</b></div>
        <div class="kv"><span>구성</span><b class="muted" style="font-weight:500">PyTorch ${esc(info.torch || '—')} · Demucs 4 · Rubber Band</b></div>
        <div class="folder-sub"><span class="muted">분리가 계속 실패하면 다시 설치해 보세요.</span><button class="link" data-s="reinstall">AI 엔진 다시 설치</button></div></div>
      <div class="box"><h4>정보</h4>
        <div class="kv"><span>버전</span><b class="disp">SROAD v${esc(st.build)}</b></div>
        <div class="kv"><span>업데이트</span><button class="link" data-s="update">버전 · 업데이트 열기</button></div>
        <div class="kv"><span>오픈소스</span><span style="text-align:right">Demucs (Meta, MIT) · Rubber Band (pedalboard, GPL) · FFmpeg · Pretendard · Unbounded</span></div>
        <button class="btn danger" data-s="quit" style="margin-top:4px">SROAD 종료</button></div>
      <div style="text-align:center;font:600 10.5px Unbounded,sans-serif;letter-spacing:.05em;color:var(--muted)">made by. Nevertheless_D</div>`;
  };
  render();
  openModal('설정', body);
  body.addEventListener('click', async (e) => {
    const s = e.target.closest('[data-s]')?.dataset.s;
    const v = e.target.closest('[data-v]')?.dataset.v;
    try {
      if (v && e.target.closest('[data-s=theme]')) { emit('theme', v); S.settings = await api('/api/settings', { appearance: v }); render(); }
      else if (s === 'folder') {
        const j = await api('/api/choose-folder', { start: S.settings.resolvedDefaultFolder, prompt: '기본으로 쓸 저장 폴더를 고르세요' });
        if (j.path) { S.settings = await api('/api/settings', { defaultFolder: j.path }); S.export.folder = S.settings.resolvedDefaultFolder; renderExport(); render(); }
      } else if (s === 'reset') { S.settings = await api('/api/settings', { defaultFolder: '' }); S.export.folder = S.settings.resolvedDefaultFolder; renderExport(); render(); }
      else if (s === 'reinstall') {
        if (await confirmBox('AI 엔진 다시 설치', 'AI 엔진을 다시 설치할까요? 몇 분 정도 걸려요.', '다시 설치')) { await api('/api/setup/reinstall', {}); emit('refresh'); }
      } else if (s === 'update') { closeModal(); openUpdate(); }
      else if (s === 'quit') { closeModal(); quitApp(); }
    } catch (err) { toast('⚠️ ' + err.message); }
  });
  body.addEventListener('change', async (e) => {
    const s = e.target.dataset.s;
    if (s === 'autosave') { S.settings = await api('/api/settings', { autoSave: e.target.checked }); renderExport(); }
    if (s === 'reveal') S.settings = await api('/api/settings', { revealAfter: e.target.checked });
  });
}

export function showEnded(msg, waiting, sub) {
  let el = $('.ended');
  if (!el) { el = document.createElement('div'); el.className = 'ended'; document.body.append(el); }
  el.innerHTML = `<svg width="64" height="64" viewBox="0 0 34 34"><rect x="2" y="12" width="4.6" height="12" rx="2.3" fill="#ff5c8a"/><rect x="8.6" y="6" width="4.6" height="22" rx="2.3" fill="#8a6cff"/><rect x="14.7" y="2" width="4.6" height="30" rx="2.3" fill="#2bc5e8"/><rect x="20.8" y="8" width="4.6" height="18" rx="2.3" fill="#ffb020"/><rect x="27.4" y="13" width="4.6" height="10" rx="2.3" fill="#2fd39a"/></svg>
    <b>${esc(msg)}</b><span>${sub || (waiting ? '잠시만 기다려 주세요.' : '이 창은 닫아도 돼요. 다시 쓰려면 SROAD 앱을 실행하세요.')}</span>`;
}

export async function quitApp() {
  const busy = S.jobs.some((j) => j.state === 'running' || j.state === 'queued');
  if (busy && !(await confirmBox('SROAD 종료', '진행 중인 작업이 있어요. 종료하면 그 작업은 취소돼요.', '종료'))) return;
  await api('/api/quit', {}).catch(() => {});
  emit('ended');
  showEnded('SROAD를 종료했어요 👋');
  setTimeout(() => window.close(), 400);
}
