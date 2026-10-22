// SROAD bootstrap: polling, mode switching, theme
// made by. Nevertheless_D
import { S, $, $$, api, emit, on, toast, saveUI, modalOpen, IS_SHELL } from './core.js';
import { renderLibrary, focusItem, pickFiles } from './library.js';
import { renderStage, tickResults, renderResults } from './modes.js';
import { renderPlayer, toggle as togglePlayer } from './player.js';
import { render as renderEditor, leaveEditor } from './editor.js';
import { renderExport, renderQueue, renderSetup, renderVersion, openUpdate, openSettings, quitApp, showEnded } from './panels.js';

// ── theme ──
function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  $$('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.theme === (mode || 'system')));
}
$('#themeSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-theme]');
  if (!b) return;
  applyTheme(b.dataset.theme);
  S.settings = await api('/api/settings', { appearance: b.dataset.theme }).catch(() => S.settings);
});
on('theme', applyTheme);

// ── modes ──
function setMode(m) {
  if (S.mode === 'edit' && m !== 'edit') leaveEditor();
  S.mode = m;
  document.body.dataset.mode = m;
  $$('#tabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === m));
  if (m === 'edit') renderEditor(); else renderStage();
  saveUI();
}
$('#tabs').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) setMode(t.dataset.mode); });
on('set-mode', (m) => { if (S.mode !== m) setMode(m); });
on('focus-item', (id) => focusItem(id));

$('#verBtn').onclick = openUpdate;
$('#settingsBtn').onclick = openSettings;
$('#quitBtn').onclick = quitApp;

// ── keyboard ──
document.addEventListener('keydown', (e) => {
  if (modalOpen()) { if (e.key === 'Escape') { $('#modalRoot [data-close]')?.click(); } return; }
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName) && !['checkbox', 'range', 'radio'].includes(document.activeElement.type);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); pickFiles(); return; }
  if (typing || S.mode === 'edit') return;
  if (e.key === ' ') { e.preventDefault(); togglePlayer(); }
});

// ── polling ──
let ended = false, fails = 0, lastJobsSig = '';
on('ended', () => { ended = true; });
async function poll() {
  if (ended) return;
  try {
    const d = await api(`/api/poll?rev=${S.rev}`);
    fails = 0;
    S.build = d.build;
    // 1.1.0 부터 SROAD 는 Dock 에 보이는 앱 창으로 열려요. 예전 Chrome 창이 남아 있으면 안내만 보여 주고 멈춰요.
    if (d.shell === 'native' && !IS_SHELL) {
      ended = true;
      showEnded('SROAD가 새 모습으로 바뀌었어요', false, '이제 SROAD는 Dock에 아이콘이 있는 앱으로 열려요. 이 창은 닫아도 돼요.');
      setTimeout(() => { try { window.close(); } catch { /* 닫을 수 없으면 안내만 보여 줘요 */ } }, 2500);
      return;
    }
    const prevReady = S.setup?.ready;
    S.setup = d.setup;
    S.update = d.update;
    if (d.items) { S.rev = d.rev; emit('items', d.items); if (S.mode !== 'edit') renderStage(); }
    const sig = d.jobs.map((j) => j.id + j.state + Math.round(j.progress * 100) + j.stage).join('|');
    const prevStates = new Map(S.jobs.map((j) => [j.id, j.state]));
    S.jobs = d.jobs;
    if (sig !== lastJobsSig) {
      lastJobsSig = sig;
      renderQueue();
      emit('jobs-tick');
      if (S.mode !== 'edit') tickResults();
      for (const j of d.jobs) {
        if (prevStates.get(j.id) === 'running' && j.state === 'done' && j.kind !== 'save' && j.kind !== 'export') toast(`✅ ${j.itemName} · ${j.title} 완료`);
        if (prevStates.get(j.id) === 'running' && j.state === 'done' && j.kind === 'export') toast('✅ 편집본을 저장했어요');
        if (prevStates.get(j.id) === 'running' && j.state === 'error') toast(`⚠️ ${j.itemName}: ${j.error}`, 6000);
      }
    }
    renderSetup();
    renderVersion();
    if (prevReady !== S.setup.ready && S.mode !== 'edit') renderStage();
  } catch {
    if (++fails >= 4) { ended = true; showEnded('SROAD 엔진이 종료됐어요'); }
  }
}
on('refresh', poll);
async function loop() {
  for (;;) {
    await poll();
    const busy = S.jobs.some((j) => j.state === 'running' || j.state === 'queued') || S.setup?.running || ['downloading', 'installing', 'checking'].includes(S.update?.status);
    await new Promise((r) => setTimeout(r, busy ? 700 : 2000));
    if (ended) return;
  }
}

// ── start ──
(async function init() {
  try {
    S.settings = await api('/api/settings');
  } catch {
    showEnded('SROAD 엔진에 연결하지 못했어요');
    return;
  }
  applyTheme(S.settings.appearance);
  const ui = S.settings.ui || {};
  if (ui.export) Object.assign(S.export, ui.export);
  if (ui.params) for (const k of Object.keys(S.params)) Object.assign(S.params[k], ui.params[k] || {});
  S.export.folder = S.settings.resolvedDefaultFolder;
  renderExport();
  renderQueue();
  renderPlayer();
  renderLibrary();
  await poll();
  setMode(ui.mode && ui.mode !== 'edit' ? ui.mode : 'vocal');
  loop();
})();
