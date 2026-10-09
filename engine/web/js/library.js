// SROAD library (left column): upload, list, focus, batch selection
import { S, $, $$, esc, T, api, toast, showCtx, emit, on, miniWave, MODES, fmtTime, fmtFormat, itemTitle, laneClass, ICON, confirmBox } from './core.js';

const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'flac', 'aac', 'aif', 'aiff', 'ogg', 'opus', 'caf', 'alac']);
const extOf = (n) => (n.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

export function focusItem(id) {
  S.focusId = id;
  renderLibrary();
  emit('focus', id);
}
export const focused = () => S.byId.get(S.focusId);

export function checkedItems() {
  return [...S.checked].map((id) => S.byId.get(id)).filter(Boolean);
}

// ── upload ──
export function pickFiles() { $('#filePick').click(); }
$('#filePick').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; addFiles(f); };

export function addFiles(files) {
  const ok = files.filter((f) => AUDIO_EXT.has(extOf(f.name)) || (f.type.startsWith('audio/')));
  if (ok.length < files.length) toast(`음원이 아닌 파일 ${files.length - ok.length}개는 뺐어요`);
  if (!ok.length) return;
  for (const f of ok) S.uploads.push({ key: Math.random().toString(36).slice(2), name: f.name, file: f, progress: 0 });
  renderLibrary();
  pump();
}

let active = 0;
function pump() {
  while (active < 3) {
    const u = S.uploads.find((x) => !x.started);
    if (!u) break;
    u.started = true;
    active++;
    upload(u).finally(() => { active--; pump(); });
  }
}

function upload(u) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?name=${encodeURIComponent(u.name)}`);
    xhr.setRequestHeader('x-token', T);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { u.progress = e.loaded / e.total; updateUploadRow(u); } };
    xhr.onload = () => {
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      S.uploads = S.uploads.filter((x) => x !== u);
      if (xhr.status !== 200 || !j.ok) toast(`⚠️ ${j.error || u.name + ' 을(를) 넣지 못했어요'}`, 5000);
      else {
        if (!S.focusId) S.focusId = j.item.id;
        emit('refresh');
      }
      renderLibrary();
      resolve();
    };
    xhr.onerror = () => { S.uploads = S.uploads.filter((x) => x !== u); toast('⚠️ 업로드하지 못했어요'); renderLibrary(); resolve(); };
    xhr.send(u.file);
  });
}
function updateUploadRow(u) {
  const el = $(`#libList [data-up="${u.key}"] .sub`);
  if (el) el.textContent = `불러오는 중 ${Math.round(u.progress * 100)}%`;
}

// ── drag & drop (whole window, folders too) ──
async function filesFromDrop(dt) {
  const entries = [...(dt.items || [])].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.());
  if (!entries.some((en) => en && en.isDirectory)) return [...dt.files];
  const out = [];
  const walk = async (entry, path) => {
    if (!entry) return;
    if (entry.isFile) {
      const f = await new Promise((res) => entry.file(res, () => res(null)));
      if (f && !f.name.startsWith('.')) out.push({ f, p: path + f.name });
    } else if (entry.isDirectory) {
      const r = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res) => r.readEntries(res, () => res([])));
        for (const ch of batch) await walk(ch, path + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const en of entries) await walk(en, '');
  out.sort((a, b) => a.p.localeCompare(b.p, 'ko', { numeric: true }));
  return out.map((o) => o.f);
}
let depth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; $('#drop').classList.add('on'); });
addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; if (--depth <= 0) { depth = 0; $('#drop').classList.remove('on'); } });
addEventListener('dragover', (e) => { e.preventDefault(); });
addEventListener('drop', async (e) => {
  e.preventDefault();
  depth = 0;
  $('#drop').classList.remove('on');
  if (!hasFiles(e)) return;
  if (S.mode === 'edit' && e.target.closest?.('#edWrap')) return; // editor handles its own drops
  addFiles(await filesFromDrop(e.dataTransfer));
});

// ── render ──
function busyFor(id) {
  const j = S.jobs.find((x) => x.itemId === id && (x.state === 'running' || x.state === 'queued'));
  if (!j) return '';
  return j.state === 'running' ? `${MODES[j.kind]?.ko || j.title} ${Math.round(j.progress * 100)}%` : '대기 중';
}

function rowHTML(it, child) {
  const lane = laneClass(it);
  const color = it.kind === 'result' ? MODES[it.mode]?.hex : '#a29fbd';
  const sub = it.kind === 'result'
    ? `<span class="chip">${esc(it.label)}</span><span>${fmtTime(it.duration)}</span><span>${it.savedPath ? '저장됨' : '저장 전'}</span>`
    : `<span>${fmtTime(it.duration)}</span><span>${esc(fmtFormat(it))}</span>${it.artist ? `<span>${esc(it.artist)}</span>` : ''}`;
  const busy = busyFor(it.id);
  const stem = it.mode === 'track' && it.stem ? ' stem-' + it.stem : '';
  return `<div class="row ${child ? 'child' : ''} ${lane}${stem} ${S.focusId === it.id ? 'focus' : ''}" data-id="${it.id}">
    <input type="checkbox" class="chk" ${S.checked.has(it.id) ? 'checked' : ''} title="일괄 처리에 포함">
    <button class="pbtn" data-play title="재생"><span class="lane"></span>${ICON.play}</button>
    <div class="meta"><div class="nm" title="${esc(itemTitle(it))}">${esc(child ? it.base : itemTitle(it))}</div>
      <div class="sub">${sub}</div>${child ? '' : miniWave(it.peaks, color)}</div>
    <button class="x" data-x title="목록에서 빼기">✕</button>
    ${busy ? `<span class="busy">${esc(busy)}</span>` : ''}
  </div>`;
}

export function renderLibrary() {
  const list = $('#libList');
  const sources = S.items.filter((x) => x.kind === 'source');
  const kids = new Map();
  for (const it of S.items) if (it.parentId) (kids.get(it.parentId) || kids.set(it.parentId, []).get(it.parentId)).push(it);
  let html = '';
  const walk = (it, lvl) => {
    html += rowHTML(it, lvl > 0);
    for (const k of kids.get(it.id) || []) walk(k, lvl + 1);
  };
  sources.forEach((s) => walk(s, 0));
  for (const u of S.uploads) {
    html += `<div class="row uploading" data-up="${u.key}"><span></span><button class="pbtn"><span class="spin"></span>${ICON.note}</button><div class="meta"><div class="nm">${esc(u.name)}</div><div class="sub">불러오는 중 ${Math.round(u.progress * 100)}%</div></div></div>`;
  }
  if (!sources.length && !S.uploads.length) {
    html = `<div class="lib-empty">
      <svg width="86" height="86" viewBox="0 0 86 86"><circle cx="43" cy="43" r="40" fill="#1f1c38"/><circle cx="43" cy="43" r="30" fill="none" stroke="#3a3560" stroke-width="1"/><circle cx="43" cy="43" r="22" fill="none" stroke="#3a3560" stroke-width="1"/><circle cx="43" cy="43" r="11" fill="var(--accent)"/><circle cx="43" cy="43" r="2.5" fill="#1f1c38"/></svg>
      <b>음원을 끌어다 놓으세요</b>MP3 · M4A · WAV · FLAC<br>여러 곡, 폴더째 넣어도 돼요
      <div style="margin-top:14px"><button class="btn go" data-pick>＋ 음원 선택</button></div></div>`;
  }
  list.innerHTML = html;
  $('#libCount').textContent = sources.length ? `${sources.length}곡` : '';
  const n = S.checked.size;
  $('#checkedInfo').textContent = n ? `${n}개 선택됨` : '체크하면 일괄 처리';
  const all = S.items.length > 0 && S.items.every((x) => S.checked.has(x.id));
  $('#checkAll').checked = all;
  $('#checkAll').indeterminate = n > 0 && !all;
  emit('play-marks');
}

$('#libList').addEventListener('click', (e) => {
  if (e.target.closest('[data-pick]')) { pickFiles(); return; }
  const row = e.target.closest('.row[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.classList.contains('chk')) {
    e.target.checked ? S.checked.add(id) : S.checked.delete(id);
    renderLibrary();
    emit('checked');
    return;
  }
  if (e.target.closest('[data-play]')) { emit('play-item', S.byId.get(id)); return; }
  if (e.target.closest('[data-x]')) { removeItems([id]); return; }
  focusItem(id);
});
$('#libList').addEventListener('dblclick', (e) => {
  const row = e.target.closest('.row[data-id]');
  if (row && !e.target.closest('button,input')) emit('play-item', S.byId.get(row.dataset.id));
});
$('#libList').addEventListener('contextmenu', (e) => {
  const row = e.target.closest('.row[data-id]');
  if (!row) return;
  e.preventDefault();
  const it = S.byId.get(row.dataset.id);
  focusItem(it.id);
  const items = [
    { label: '▶︎  재생', onClick: () => emit('play-item', it) },
    { label: '✂︎  ROAD Edit에서 편집', onClick: () => { emit('set-mode', 'edit'); emit('edit-item', it); } },
  ];
  if (it.parentId) items.push({ label: '⇄  원곡과 비교해서 듣기', onClick: () => emit('compare', it) });
  if (it.savedPath) items.push({ label: '📁  Finder에서 보기', onClick: () => api('/api/reveal', { paths: [it.savedPath] }) });
  items.push('-', { label: '🗑  목록에서 빼기', onClick: () => removeItems([it.id]) });
  showCtx(e.clientX, e.clientY, items);
});

$('#checkAll').onchange = (e) => {
  if (e.target.checked) S.items.forEach((x) => S.checked.add(x.id));
  else S.checked.clear();
  renderLibrary();
  emit('checked');
};
$('#addBtn').onclick = pickFiles;

export async function removeItems(ids) {
  const set = new Set(ids);
  const kids = S.items.filter((x) => set.has(x.parentId)).length;
  if (kids && !(await confirmBox('목록에서 빼기', '이 곡에서 만든 결과도 함께 목록에서 빠져요.<br>이미 저장한 파일은 지워지지 않아요.', '빼기'))) return;
  await api('/api/remove', { ids }).catch((e) => toast('⚠️ ' + e.message));
  ids.forEach((id) => S.checked.delete(id));
  if (set.has(S.focusId)) S.focusId = null;
  emit('refresh');
}

// apply new items from the engine
on('items', (items) => {
  S.items = items;
  S.byId = new Map(items.map((x) => [x.id, x]));
  for (const id of [...S.checked]) if (!S.byId.has(id)) S.checked.delete(id);
  if (S.focusId && !S.byId.has(S.focusId)) S.focusId = null;
  if (!S.focusId && items.length) S.focusId = items.find((x) => x.kind === 'source')?.id || items[0].id;
  renderLibrary();
});
on('jobs-tick', () => {
  // refresh only busy labels to keep the list calm
  $$('#libList .row[data-id]').forEach((row) => {
    const b = busyFor(row.dataset.id);
    let el = $('.busy', row);
    if (!b) { el?.remove(); return; }
    if (!el) { el = document.createElement('span'); el.className = 'busy'; row.append(el); }
    el.textContent = b;
  });
});
