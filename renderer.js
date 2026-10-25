// SPDX-License-Identifier: AGPL-3.0-only
import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { oneDark } from '@codemirror/theme-one-dark';
import { renderMarkdown } from './preview.mjs';

const $ = id => document.getElementById(id);
const api = window.studio;
const editable = new Compartment();
const appearance = new Compartment();
let editorDark = false;
let editorScale = 1;
let newFileParent = '';
let renameTarget = null;
let current = null;
const documents = new Map();
let ready = false;
let lastSession = '';
let folder = null;
let selectedDirectory = '';
const directories = new Map();
let busy = false;
let previewTimer;
let zoomTimer;
let noticeTimer;
let dialogResolve;
let trashResolve;

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: 'calc(14px * var(--editor-scale, 1))', color: 'var(--editor-ink)', backgroundColor: 'var(--surface)' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Microsoft YaHei", monospace', lineHeight: '1.85' },
  '.cm-content': { padding: '22px 12px 80px', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--heading-bg)', borderRight: '1px solid var(--line)', color: 'var(--muted)', minWidth: '42px' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection)' }
});
const view = new EditorView({ parent: $('editor'), state: makeState('') });

function makeState(text) {
  return EditorState.create({ doc: text, extensions: [basicSetup,
    markdown({ base: markdownLanguage }), EditorView.lineWrapping, theme, appearance.of(editorDark ? oneDark : []),
    editable.of([EditorView.editable.of(!busy && !!current), EditorState.readOnly.of(busy || !current)]),
    keymap.of([indentWithTab]), EditorView.updateListener.of(update => {
      if (update.docChanged) {
        updateStatus();
        clearTimeout(previewTimer);
        previewTimer = setTimeout(renderPreview, 100);
      }
      if (update.selectionSet || update.docChanged) updateCursor();
    })] });
}

function content(entry) { return entry === current ? view.state.doc.toString() : entry.state.doc.toString(); }
function dirty(entry = current) { return !!entry && content(entry) !== entry.savedText; }
function rememberSession() {
  if (!ready) return;
  const state = { tabs: [...documents.keys()], activeId: current?.id || null,
    editorTheme: editorDark ? 'dark' : 'light', previewTheme: $('preview-pane').dataset.theme,
    editorScale, previewScale: Number($('preview-scale').value) };
  const serialized = JSON.stringify({ folder: folder?.path, ...state });
  if (serialized !== lastSession) { lastSession = serialized; api.remember(state); }
}
function renderTabs() {
  $('document-tabs').replaceChildren();
  for (const entry of documents.values()) {
    const tab = document.createElement('div'); tab.className = `file-tab${entry === current ? ' active' : ''}`;
    const select = document.createElement('button'); select.className = 'tab-select'; select.setAttribute('role', 'tab');
    select.setAttribute('aria-selected', String(entry === current)); select.title = entry.id;
    select.textContent = `${dirty(entry) ? '● ' : ''}${entry.id.split('/').at(-1)}`;
    select.onclick = () => action(async () => { activateDocument(entry.id); await revealDirectory(selectedDirectory); });
    const close = document.createElement('button'); close.className = 'tab-close'; close.textContent = '×';
    close.setAttribute('aria-label', `关闭 ${entry.id}`); close.onclick = () => action(() => closeDocument(entry.id));
    tab.append(select, close); $('document-tabs').append(tab);
  }
  $('document-tabs').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function updateStatus(message) {
  const modified = dirty();
  $('document-status').dataset.dirty = String(modified);
  $('document-status').textContent = message || (current ? (modified ? '有未保存的修改' : '已保存到本机') : '等待打开文件');
  $('word-count').textContent = `${view.state.doc.length.toLocaleString()} 字符`;
  document.title = `${modified ? '● ' : ''}${current ? current.id + ' — ' : ''}LLMMarkUp`;
  renderTabs(); rememberSession();
}
function updateCursor() {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  $('cursor-position').textContent = `行 ${line.number}，列 ${head - line.from + 1}`;
}
function notice(message = '', error = false, duration = 0) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').className = error ? 'error' : '';
  if (message && !error && duration > 0) noticeTimer = setTimeout(() => notice(), duration);
}
function unwrap(result) {
  if (!result.ok) throw Object.assign(new Error(result.message), { code: result.code });
  return result.value;
}
function setBusy(value) {
  busy = value;
  $('open-folder').disabled = value;
  $('welcome-open').disabled = value;
  $('refresh').disabled = value || !folder;
  $('new-file').disabled = value || !folder;
  $('new-folder').disabled = value || !folder;
  $('tree').inert = value;
  view.dispatch({ effects: editable.reconfigure([EditorView.editable.of(!value && !!current),
    EditorState.readOnly.of(value || !current)]) });
  updateStatus();
}
async function action(callback) {
  if (busy) return;
  setBusy(true);
  try { await callback(); }
  catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}
function renderPreview() {
  $('preview').innerHTML = renderMarkdown(view.state.doc.toString());
}
function stashDocument() {
  if (current) { current.state = view.state; current.scroll = view.scrollDOM.scrollTop; current.previewScroll = $('preview-scroll').scrollTop; }
}
function activateDocument(id) {
  if (current?.id === id) return;
  stashDocument();
  current = documents.get(id);
  selectedDirectory = current.id.includes('/') ? current.id.slice(0, current.id.lastIndexOf('/')) : '';
  view.setState(current.state);
  view.dispatch({ effects: [appearance.reconfigure(editorDark ? oneDark : []),
    editable.reconfigure([EditorView.editable.of(!busy), EditorState.readOnly.of(busy)])] });
  $('encoding').textContent = `UTF-8${current.bom ? ' BOM' : ''} · ${current.eol}`;
  $('welcome').hidden = true; $('panes').hidden = false;
  renderPreview(); markActive(); updateCursor(); updateStatus();
  const entry = current;
  requestAnimationFrame(() => { if (current === entry) { view.scrollDOM.scrollTop = entry.scroll || 0; $('preview-scroll').scrollTop = entry.previewScroll || 0; view.focus(); } });
}
function loadDocument(file) {
  clearTimeout(previewTimer);
  stashDocument();
  current = { ...file, savedText: file.text, state: null };
  documents.set(file.id, current);
  selectedDirectory = file.id.includes('/') ? file.id.slice(0, file.id.lastIndexOf('/')) : '';
  view.setState(makeState(file.text));
  current.state = view.state;
  $('encoding').textContent = `UTF-8${file.bom ? ' BOM' : ''} · ${file.eol}`;
  $('welcome').hidden = true;
  $('panes').hidden = false;
  $('preview-scroll').scrollTop = 0;
  renderPreview();
  notice();
  markActive();
  updateCursor();
  updateStatus();
  requestAnimationFrame(() => view.focus());
}
async function openDocument(id) {
  if (documents.has(id)) activateDocument(id);
  else {
    if (documents.size >= 50) throw new Error('最多同时打开 50 个文件，请先关闭部分标签。');
    loadDocument(unwrap(await api.read(id)));
  }
  await revealDirectory(selectedDirectory);
}
async function closeDocument(id) {
  const entry = documents.get(id);
  if (!entry || !await ensureSaved(entry)) return;
  await removeDocument(id);
}
async function removeDocument(id) {
  const entry = documents.get(id);
  const index = [...documents.keys()].indexOf(id);
  documents.delete(id);
  if (current === entry) {
    if (documents.size) { activateDocument([...documents.keys()][Math.min(index, documents.size - 1)]); await revealDirectory(selectedDirectory); }
    else { current = null; view.setState(makeState('')); $('panes').hidden = true; $('welcome').hidden = false; markActive(); updateCursor(); }
  }
  updateStatus();
}
function markActive() {
  for (const button of $('tree').querySelectorAll('button[data-file]')) {
    const active = button.dataset.file === current?.id;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
}
async function save(entry = current) {
  if (!entry || !dirty(entry)) return true;
  const text = content(entry);
  const result = unwrap(await api.save(entry.id, text, entry.version));
  entry.version = result.version;
  entry.savedText = text;
  notice();
  updateStatus();
  return true;
}
async function ensureSaved(entry = current) {
  if (!dirty(entry)) return true;
  $('unsaved-message').textContent = `文件“${entry.id}”有未保存的内容。请选择如何继续。`;
  const choice = await new Promise(resolve => {
    dialogResolve = resolve;
    $('unsaved-dialog').showModal();
    $('unsaved-dialog').querySelector('[data-choice="cancel"]').focus();
  });
  if (choice === 'cancel') return false;
  if (choice === 'save') return save(entry);
  return true;
}
async function ensureAllSaved() {
  for (const entry of documents.values()) if (!await ensureSaved(entry)) return false;
  return true;
}
$('unsaved-dialog').addEventListener('click', event => {
  const choice = event.target.dataset.choice;
  if (choice) { $('unsaved-dialog').close(); dialogResolve?.(choice); }
});
$('unsaved-dialog').addEventListener('cancel', event => {
  event.preventDefault(); $('unsaved-dialog').close(); dialogResolve?.('cancel');
});

async function listInto(id, container) {
  const entries = unwrap(await api.list(id));
  if (!id) { directories.clear(); directories.set('', folder.name); }
  container.replaceChildren();
  if (!entries.length) {
    const hint = document.createElement('p'); hint.className = 'tree-hint';
    hint.textContent = '暂无 Markdown 文件'; container.append(hint);
  }
  for (const entry of entries) {
    const row = document.createElement('div'); row.className = 'tree-row';
    const button = document.createElement('button'); button.className = 'tree-item';
    const icon = document.createElement('span'); icon.className = `tree-icon ${entry.kind}`;
    icon.textContent = entry.kind === 'directory' ? '›' : 'M↓';
    const label = document.createElement('span'); label.textContent = entry.name;
    button.append(icon, label); button.title = entry.id; row.append(button); container.append(row);
    if (entry.kind === 'file') {
      button.dataset.file = entry.id;
      button.onclick = () => action(async () => {
        if (entry.id !== current?.id) await openDocument(entry.id);
      });
    } else {
      directories.set(entry.id, `${folder.name}/${entry.id}`);
      button.dataset.directory = entry.id;
      button.setAttribute('aria-expanded', 'false');
      const children = document.createElement('div'); children.className = 'tree-children'; children.hidden = true; row.append(children);
      button.onclick = () => action(async () => {
        selectedDirectory = entry.id;
        if (children.hidden) { await listInto(entry.id, children); children.hidden = false; icon.textContent = '⌄'; }
        else { children.hidden = true; icon.textContent = '›'; }
        button.setAttribute('aria-expanded', String(!children.hidden));
      });
    }
  }
  markActive();
}
async function revealDirectory(parent) {
  let prefix = '';
  for (const part of parent.split('/').filter(Boolean)) {
    prefix = prefix ? `${prefix}/${part}` : part;
    const button = [...$('tree').querySelectorAll('[data-directory]')].find(item => item.dataset.directory === prefix);
    if (!button) break;
    const children = button.parentElement.querySelector('.tree-children');
    if (children.hidden) { await listInto(prefix, children); children.hidden = false; }
    button.setAttribute('aria-expanded', 'true'); button.querySelector('.tree-icon').textContent = '⌄';
  }
  markActive();
}
async function changeWorkspace(selected) {
  folder = selected;
  current = null; documents.clear();
  selectedDirectory = '';
  view.setState(makeState(''));
  $('folder-name').textContent = folder.name;
  $('folder-name').title = folder.path;
  $('panes').hidden = true; $('welcome').hidden = false;
  notice(); updateStatus();
  await listInto('', $('tree'));
}
async function chooseFolder() {
  if (!await ensureAllSaved()) return;
  const selected = unwrap(await api.chooseFolder());
  if (selected) await changeWorkspace(selected);
}
async function showRecent() {
  const recent = unwrap(await api.recent());
  const menu = $('open-menu'); menu.replaceChildren();
  const choose = document.createElement('button'); choose.setAttribute('role', 'menuitem'); choose.textContent = '打开文件夹…';
  choose.onclick = () => { menu.hidePopover(); action(chooseFolder); }; menu.append(choose);
  for (const [kind, entries, heading] of [['file', recent.files, '最近文件'], ['folder', recent.folders, '最近目录']]) {
    const label = document.createElement('div'); label.className = 'recent-heading'; label.textContent = heading; menu.append(label);
    if (!entries.length) { const empty = document.createElement('div'); empty.className = 'recent-empty'; empty.textContent = '暂无记录'; menu.append(empty); }
    entries.forEach((entry, index) => {
      const root = kind === 'folder' ? entry : entry.folder;
      const button = document.createElement('button'); button.setAttribute('role', 'menuitem');
      button.textContent = kind === 'folder' ? root.split(/[\\/]/).filter(Boolean).at(-1) : `${root.split(/[\\/]/).filter(Boolean).at(-1)} / ${entry.id}`;
      button.title = kind === 'folder' ? root : `${root}/${entry.id}`;
      button.onclick = () => { menu.hidePopover(); action(async () => {
        if (folder?.path !== root) {
          if (!await ensureAllSaved()) return;
          await changeWorkspace(unwrap(await api.openRecent(kind, index)));
        }
        if (kind === 'file') await openDocument(entry.id);
      }); }; menu.append(button);
    });
  }
  const bounds = $('open-folder').getBoundingClientRect();
  menu.style.left = `${Math.min(bounds.left, window.innerWidth - 340)}px`; menu.style.top = `${bounds.bottom + 4}px`;
  menu.showPopover();
}
$('open-folder').onclick = () => action(showRecent);
$('welcome-open').onclick = () => action(chooseFolder);
$('refresh').onclick = () => action(() => listInto('', $('tree')));
async function reload() {
  if (current && await ensureSaved()) loadDocument(unwrap(await api.read(current.id)));
}
function newFile(parent = '') {
  if (busy || !folder) return;
  if (documents.size >= 50) { notice('最多同时打开 50 个文件，请先关闭部分标签。', true); return; }
  newFileParent = parent;
  $('new-location').textContent = `在 ${parent ? `${folder.name}/${parent}` : folder.name} 中创建，不覆盖同名文件。`;
  $('new-name').value = ''; $('new-dialog').showModal(); $('new-name').focus();
}
function newDirectory() {
  if (busy || !folder) return;
  $('folder-parent').replaceChildren();
  for (const [id, label] of directories) {
    const option = document.createElement('option'); option.value = id; option.textContent = label;
    $('folder-parent').append(option);
  }
  $('folder-parent').value = directories.has(selectedDirectory) ? selectedDirectory : '';
  $('folder-new-name').value = ''; $('folder-dialog').showModal(); $('folder-new-name').focus();
}
$('new-folder').onclick = newDirectory;
$('folder-cancel').onclick = () => $('folder-dialog').close();
$('folder-form').onsubmit = event => {
  event.preventDefault();
  const parent = $('folder-parent').value;
  const name = $('folder-new-name').value;
  $('folder-dialog').close();
  action(async () => {
    const created = unwrap(await api.createDirectory(parent, name));
    await listInto('', $('tree'));
    await revealDirectory(parent);
    selectedDirectory = created.id;
    notice(`已新建目录：${created.id}`);
  });
};
function modalOpen() { return $('new-dialog').open || $('folder-dialog').open || $('unsaved-dialog').open || $('trash-dialog').open || $('rename-dialog').open; }
$('new-file').onclick = () => newFile();
$('new-cancel').onclick = () => $('new-dialog').close();
$('new-form').onsubmit = event => {
  event.preventDefault();
  const name = $('new-name').value;
  $('new-dialog').close();
  action(async () => {
    loadDocument(unwrap(await api.create(name, newFileParent)));
    await listInto('', $('tree'));
    await revealDirectory(selectedDirectory);
  });
};
function confirmTrash(id) {
  $('trash-message').textContent = `文件“${id}”将移至系统回收站，之后可从回收站恢复。`;
  return new Promise(resolve => {
    trashResolve = resolve; $('trash-dialog').showModal();
    $('trash-dialog').querySelector('[data-trash-choice="cancel"]').focus();
  });
}
$('trash-dialog').onclick = event => {
  if (event.target.dataset.trashChoice) {
    $('trash-dialog').close(); trashResolve?.(event.target.dataset.trashChoice === 'trash');
  }
};
$('trash-dialog').oncancel = event => { event.preventDefault(); $('trash-dialog').close(); trashResolve?.(false); };
async function trashFile(id) {
  const entry = documents.get(id);
  if (entry && !await ensureSaved(entry)) return;
  const file = entry || unwrap(await api.inspect(id));
  if (!await confirmTrash(id)) return;
  unwrap(await api.trash(id, file.version));
  if (entry) await removeDocument(id);
  await listInto('', $('tree')); await revealDirectory(selectedDirectory);
  notice(`已移至回收站：${id}`);
}
async function applyRelocation(moved) {
  const entry = documents.get(moved.from);
  if (entry && moved.id !== moved.from) {
    const entries = [...documents].map(([key, value]) => [key === moved.from ? moved.id : key, value]);
    entry.id = moved.id; entry.version = moved.version;
    documents.clear(); for (const [key, value] of entries) documents.set(key, value);
  }
  selectedDirectory = moved.id.includes('/') ? moved.id.slice(0, moved.id.lastIndexOf('/')) : '';
  updateStatus();
  await listInto('', $('tree')); await revealDirectory(selectedDirectory);
}
function renameFile(id) {
  if (busy || !folder) return;
  renameTarget = id;
  const name = id.split('/').at(-1);
  $('rename-name').value = name;
  $('rename-dialog').showModal(); $('rename-name').focus();
  $('rename-name').setSelectionRange(0, name.lastIndexOf('.'));
}
$('rename-cancel').onclick = () => $('rename-dialog').close();
$('rename-form').onsubmit = event => {
  event.preventDefault();
  const id = renameTarget, name = $('rename-name').value;
  $('rename-dialog').close();
  action(async () => {
    const parent = id.includes('/') ? id.slice(0, id.lastIndexOf('/')) : '';
    const destination = parent ? `${parent}/${name}` : name;
    if (destination !== id && documents.has(destination)) throw new Error('目标文件有已打开的标签，请先关闭该标签后再重命名。');
    const file = documents.get(id) || unwrap(await api.inspect(id));
    const renamed = unwrap(await api.rename(id, name, file.version));
    await applyRelocation(renamed);
    notice(renamed.id === id ? '文件名未改变。' : `已重命名为：${renamed.id}`);
  });
};
async function moveFile(id) {
  const entry = documents.get(id);
  const file = entry || unwrap(await api.inspect(id));
  const parent = unwrap(await api.chooseMoveDirectory());
  if (parent === null) return;
  const destination = parent ? `${parent}/${id.split('/').at(-1)}` : id.split('/').at(-1);
  if (destination !== id && documents.has(destination)) throw new Error('目标文件有已打开的标签，请先关闭该标签后再移动。');
  const moved = unwrap(await api.move(id, parent, file.version));
  await applyRelocation(moved);
  notice(moved.id === id ? '文件已在该目录中。' : `已移动至：${moved.id}`);
}
function showTreeMenu(event, button) {
  event.preventDefault();
  if (busy || !folder || modalOpen()) return;
  const id = button?.dataset.file ?? button?.dataset.directory ?? '';
  const file = button?.dataset.file !== undefined;
  const menu = $('tree-menu'); menu.replaceChildren();
  const choices = file ? [
    ['重命名…', () => renameFile(id)],
    ['复制文件路径', () => action(async () => { notice(); unwrap(await api.copyPath(id)); notice('已复制文件完整路径', false, 2500); })],
    ['移动到…', () => action(() => moveFile(id))],
    ['删除（移至回收站）…', () => action(() => trashFile(id))]
  ] : [
    ['新建 Markdown…', () => newFile(id)],
    ['新建子目录…', () => { selectedDirectory = id; newDirectory(); }]
  ];
  for (const [label, run] of choices) {
    const item = document.createElement('button'); item.setAttribute('role', 'menuitem'); item.textContent = label;
    item.onclick = () => { menu.hidePopover(); run(); }; menu.append(item);
  }
  menu.showPopover();
  const bounds = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(event.clientX, window.innerWidth - bounds.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(event.clientY, window.innerHeight - bounds.height - 4))}px`;
  menu.querySelector('button').focus();
}
$('tree').oncontextmenu = event => showTreeMenu(event, event.target.closest('[data-file], [data-directory]'));
$('folder-name').oncontextmenu = event => showTreeMenu(event, null);
$('tree').onkeydown = event => {
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
  const button = event.target.closest('[data-file], [data-directory]');
  const bounds = (button || $('tree')).getBoundingClientRect();
  showTreeMenu({ preventDefault: () => event.preventDefault(), clientX: bounds.left + 15, clientY: bounds.top + 20 }, button);
};

api.onCommand(command => {
  if (modalOpen()) return;
  if (command === 'open') action(chooseFolder);
  if (command === 'recent') action(showRecent);
  if (command === 'save') action(save);
  if (command === 'reload') action(reload);
  if (command === 'new') newFile();
  if (command === 'new-folder') newDirectory();
  if (command === 'close-tab' && current) action(() => closeDocument(current.id));
});
// Also handle DOM keyboard events (including accessibility/automation input).
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'n') {
    event.preventDefault(); if (!modalOpen()) newDirectory(); return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey ||
      !['s', 'o', 'n', 'r', 'w'].includes(event.key.toLowerCase())) return;
  event.preventDefault();
  if (modalOpen()) return;
  if (event.key.toLowerCase() === 's') action(save);
  if (event.key.toLowerCase() === 'o') action(chooseFolder);
  if (event.key.toLowerCase() === 'n') newFile();
  if (event.key.toLowerCase() === 'r') action(reload);
  if (event.key.toLowerCase() === 'w' && current) action(() => closeDocument(current.id));
}, true);
api.onClose(() => action(async () => { if (await ensureAllSaved()) { rememberSession(); api.close(); } }));
window.addEventListener('focus', () => {
  if (!current || busy || modalOpen()) return;
  action(async () => {
    if (unwrap(await api.changed(current.id, current.version))) {
      notice('磁盘文件已变化或被删除。当前编辑已保留；请用“文件 → 重新读取磁盘文件”（Ctrl+R）核对。保存将检查冲突。', true);
    }
  });
});
// The editor is the scroll source. Source-line anchors keep headings and code blocks aligned.
function syncPreview() {
  if (!$('sync-scroll').checked || !current) return;
  const block = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
  const line = view.state.doc.lineAt(block.from).number - 1;
  const anchors = [...$('preview').querySelectorAll('[data-source-line]')];
  let anchor = anchors[0];
  for (const item of anchors) {
    if (Number(item.dataset.sourceLine) > line) break;
    anchor = item;
  }
  if (anchor) {
    const scroll = $('preview-scroll');
    scroll.scrollTop += anchor.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
  }
}
view.scrollDOM.addEventListener('scroll', syncPreview);
$('sync-scroll').onchange = syncPreview;
function setPanelScale(panel, value, offset = 0) {
  const next = Math.round(Math.max(0.5, Math.min(2, value)) * 1000) / 1000;
  if (panel === 'editor') {
    editorScale = next; $('editor').style.setProperty('--editor-scale', String(next));
    $('editor-scale').textContent = `${Math.round(next * 100)}%`; view.requestMeasure();
  } else {
    const old = Number($('preview-scale').value);
    $('preview-scale').querySelector('[data-custom]')?.remove();
    if (![...$('preview-scale').options].some(option => Number(option.value) === next)) {
      const option = new Option(`${Math.round(next * 100)}%`, String(next)); option.dataset.custom = 'true';
      $('preview-scale').add(option);
    }
    $('preview-scale').value = String(next); $('preview').style.zoom = String(next);
    const scroll = $('preview-scroll'); scroll.scrollTop = (scroll.scrollTop + offset) * next / old - offset;
  }
}
$('editor-scale').onclick = () => { setPanelScale('editor', 1); rememberSession(); };
$('preview-scale').onchange = () => { setPanelScale('preview', Number($('preview-scale').value)); syncPreview(); rememberSession(); };
for (const panel of ['editor', 'preview']) {
  $(`${panel}-pane`).addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (busy || modalOpen()) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
    const old = panel === 'editor' ? editorScale : Number($('preview-scale').value);
    const offset = Math.max(0, event.clientY - $('preview-scroll').getBoundingClientRect().top);
    setPanelScale(panel, old * Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.006), offset);
    clearTimeout(zoomTimer); zoomTimer = setTimeout(rememberSession, 150);
  }, { passive: false, capture: true });
}
for (const panel of ['editor', 'preview']) {
  for (const mode of ['light', 'dark']) {
    $(`${panel}-${mode}`).onclick = () => {
      $(`${panel}-pane`).dataset.theme = mode;
      for (const choice of ['light', 'dark']) $(`${panel}-${choice}`).setAttribute('aria-pressed', String(choice === mode));
      if (panel === 'editor') {
        document.querySelector('.workspace').dataset.theme = mode;
        editorDark = mode === 'dark';
        view.dispatch({ effects: appearance.reconfigure(editorDark ? oneDark : []) });
      }
      rememberSession();
    };
  }
}
function resize(clientX) {
  const bounds = $('panes').getBoundingClientRect();
  const fraction = Math.max(0.28, Math.min(0.72, (clientX - bounds.left) / bounds.width));
  $('panes').style.setProperty('--editor-width', `${fraction * 100}%`);
  view.requestMeasure();
}
function resizeSidebar(clientX) {
  const bounds = document.querySelector('.workspace').getBoundingClientRect();
  const width = Math.max(170, Math.min(520, bounds.width - 600, clientX - bounds.left));
  document.querySelector('.workspace').style.setProperty('--sidebar-width', `${width}px`);
  view.requestMeasure();
}
for (const [id, adjust] of [['splitter', resize], ['sidebar-splitter', resizeSidebar]]) {
  const splitter = $(id);
  splitter.onpointerdown = event => { if (event.button === 0) splitter.setPointerCapture(event.pointerId); };
  splitter.onpointermove = event => { if (splitter.hasPointerCapture(event.pointerId)) adjust(event.clientX); };
  splitter.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    adjust(splitter.getBoundingClientRect().left + (event.key === 'ArrowRight' ? 24 : -24));
  };
}
window.addEventListener('resize', () => resizeSidebar($('sidebar-splitter').getBoundingClientRect().left));
// Documents cannot navigate the privileged application page.
$('preview').addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute('href');
  if (href?.startsWith('#')) {
    const target = document.getElementById(href.slice(1));
    if (target && $('preview').contains(target)) target.scrollIntoView({ block: 'center' });
  }
});
api.onSessionError(() => notice('无法保存打开记录或界面配置；文档内容仍可正常编辑和保存。', true));
action(async () => {
  const state = unwrap(await api.restore());
  $(`editor-${state.editorTheme}`).click(); $(`preview-${state.previewTheme}`).click();
  setPanelScale('editor', state.editorScale); setPanelScale('preview', state.previewScale);
  if (state.folderInfo) {
    await changeWorkspace(state.folderInfo);
    for (const file of state.files) loadDocument(file);
    if (documents.has(state.activeId)) activateDocument(state.activeId);
    if (current) await revealDirectory(selectedDirectory);
  }
  if (state.warning) notice('部分打开记录已失效或无法读取；有效文件已恢复，可以从最近打开重新选择。', true);
  ready = true;
  rememberSession();
});
