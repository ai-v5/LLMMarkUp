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
let current = null;
const documents = new Map();
let ready = false;
let lastSession = '';
let folder = null;
let selectedDirectory = '';
const directories = new Map();
let busy = false;
let previewTimer;
let dialogResolve;

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px', color: 'var(--editor-ink)', backgroundColor: 'var(--surface)' },
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
    previewScale: Number($('preview-scale').value) };
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
function notice(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').hidden = !message;
  $('notice').className = error ? 'error' : '';
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
function newFile() {
  if (busy || !folder) return;
  if (documents.size >= 50) { notice('最多同时打开 50 个文件，请先关闭部分标签。', true); return; }
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
function modalOpen() { return $('new-dialog').open || $('folder-dialog').open || $('unsaved-dialog').open; }
$('new-file').onclick = newFile;
$('new-cancel').onclick = () => $('new-dialog').close();
$('new-form').onsubmit = event => {
  event.preventDefault();
  const name = $('new-name').value;
  $('new-dialog').close();
  action(async () => {
    loadDocument(unwrap(await api.create(name)));
    await listInto('', $('tree'));
  });
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
$('preview-scale').onchange = () => {
  $('preview').style.zoom = $('preview-scale').value;
  syncPreview();
  rememberSession();
};
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
$('preview').addEventListener('click', event => { if (event.target.closest('a')) event.preventDefault(); });
api.onSessionError(() => notice('无法保存打开记录或界面配置；文档内容仍可正常编辑和保存。', true));
action(async () => {
  const state = unwrap(await api.restore());
  $(`editor-${state.editorTheme}`).click(); $(`preview-${state.previewTheme}`).click();
  $('preview-scale').value = String(state.previewScale); $('preview').style.zoom = String(state.previewScale);
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
