// SPDX-License-Identifier: AGPL-3.0-only
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Workspace } = require('./workspace.cjs');
const { SessionStore } = require('./session.cjs');

const workspace = new Workspace();
app.setName('LLMMarkUp');
app.setAppUserModelId('io.ai-v5.llmmarkup');
let window;
let allowClose = false;
let busy = false;
const page = pathToFileURL(path.join(__dirname, 'dist', 'index.html')).href;
const assets = new Set(['index.html', 'renderer.js', 'styles.css', 'katex.min.css',
  ...fs.readdirSync(path.join(__dirname, 'dist', 'fonts'))
    .filter(name => /^KaTeX_[\w-]+\.(?:woff2?|ttf)$/.test(name)).map(name => `fonts/${name}`)]
  .map(file => pathToFileURL(path.join(__dirname, 'dist', file)).href));
// Keep development/test sessions isolated from an installed application.
if (process.env.LLMMARKUP_TEST_DATA) app.setPath('userData', process.env.LLMMARKUP_TEST_DATA);
const settings = new SessionStore(path.join(app.getPath('userData'), 'studio-session.json'));
const legacySession = process.env.LLMMARKUP_TEST_DATA ? process.env.LLMMARKUP_TEST_LEGACY_SESSION :
  path.join(app.getPath('appData'), 'mdppt-studio', 'studio-session.json');

function trusted(event) {
  return window && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === page;
}

function handle(channel, action) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) return { ok: false, code: 'SENDER', message: '请求来源无效。' };
    if (busy) return { ok: false, code: 'BUSY', message: '文件操作进行中，请稍后再试。' };
    busy = true;
    try { return { ok: true, value: await action(...args) }; }
    catch (error) {
      const systemMessages = { EACCES: '无权访问该文件或目录。', EPERM: '文件被占用或无写入权限。',
        ENOENT: '文件或文件夹已被移动或删除。', EEXIST: '同名文件已存在，不会覆盖。',
        ENOTDIR: '文件夹已变化，请刷新目录。', EISDIR: '目标是文件夹。' };
      const known = new Set(['PATH', 'ROOT', 'LINK', 'TYPE', 'SIZE', 'ENCODING', 'CONFLICT', 'BUSY', 'TEXT', 'NAME', 'MOVE_PARTIAL']);
      return { ok: false, code: error.code || 'IO', message: systemMessages[error.code] ||
        (known.has(error.code) ? error.message : '文件操作失败，请检查权限与磁盘状态。') };
    } finally { busy = false; }
  });
}

app.whenReady().then(async () => {
  await settings.load(legacySession);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  // Only bundled UI and KaTeX font resources; documents cannot read arbitrary files or use the network.
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !assets.has(details.url) });
  });
  window = new BrowserWindow({ width: 1440, height: 920, minWidth: 980, minHeight: 640,
    title: 'LLMMarkUp', icon: path.join(__dirname, 'assets', 'studio.ico'), backgroundColor: '#f6f8fb', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.on('close', event => {
    if (!allowClose) {
      event.preventDefault();
      if (!busy) window.webContents.send('window:request-close');
    }
  });
  ipcMain.on('window:close', async event => {
    if (trusted(event) && !busy) { await settings.flush().catch(() => {}); allowClose = true; window.close(); }
  });
  ipcMain.on('session:update', (event, value) => {
    if (!trusted(event) || !value || typeof value !== 'object') return;
    const tabs = Array.isArray(value.tabs) ? value.tabs.filter(id => workspace.opened.has(id)) : [];
    const recents = tabs.includes(value.activeId) && workspace.root ?
      [{ folder: workspace.root, id: value.activeId }, ...settings.state.recentFiles.filter(item => item.folder !== workspace.root || item.id !== value.activeId)] : settings.state.recentFiles;
    settings.update({ folder: workspace.root, tabs, activeId: value.activeId, recentFiles: recents,
      editorTheme: value.editorTheme, previewTheme: value.previewTheme, editorScale: value.editorScale, previewScale: value.previewScale })
      .catch(() => window?.webContents.send('session:error'));
  });
  handle('session:restore', async () => {
    const state = settings.snapshot();
    const files = [];
    let selected = null;
    if (state.folder) {
      try {
        selected = await workspace.select(state.folder);
        for (const id of state.tabs) { try { files.push(await workspace.read(id)); } catch {} }
      } catch {}
    }
    return { ...state, folderInfo: selected, files, warning: settings.error || (!!state.folder && !selected) || files.length !== state.tabs.length };
  });
  handle('session:recent', () => ({ folders: settings.state.recentFolders, files: settings.state.recentFiles }));
  handle('workspace:recent', async (kind, index) => {
    const entry = kind === 'folder' ? settings.state.recentFolders[index] : settings.state.recentFiles[index]?.folder;
    if (!entry || !Number.isInteger(index)) throw Object.assign(new Error('最近记录已失效。'), { code: 'PATH' });
    const selected = await workspace.select(entry);
    await settings.rememberFolder(selected.path).catch(() => window.webContents.send('session:error'));
    return selected;
  });
  handle('workspace:choose', async () => {
    const result = await dialog.showOpenDialog(window, { title: '打开 Markdown 文件夹', properties: ['openDirectory'] });
    if (result.canceled) return null;
    const selected = await workspace.select(result.filePaths[0]);
    await settings.rememberFolder(selected.path).catch(() => window.webContents.send('session:error'));
    return selected;
  });
  handle('workspace:list', id => workspace.list(id));
  handle('workspace:inspect', id => workspace.read(id));
  handle('workspace:read', async id => {
    const file = await workspace.read(id);
    await settings.rememberFile(workspace.root, id).catch(() => window.webContents.send('session:error'));
    return file;
  });
  handle('workspace:save', (id, text, version) => workspace.save(id, text, version));
  handle('workspace:changed', (id, version) => workspace.changed(id, version));
  handle('workspace:create', (name, parent) => workspace.create(name, parent));
  handle('workspace:mkdir', (parent, name) => workspace.createDirectory(parent, name));
  handle('workspace:move-directory', async () => {
    if (!workspace.root) throw Object.assign(new Error('请先打开文件夹。'), { code: 'ROOT' });
    const result = await dialog.showOpenDialog(window, { title: '选择移动目标（当前工作目录内）',
      defaultPath: workspace.root, properties: ['openDirectory'] });
    return result.canceled ? null : workspace.directoryId(result.filePaths[0]);
  });
  handle('workspace:move', async (id, parent, version) => {
    const moved = await workspace.move(id, parent, version);
    await settings.relocateFile(workspace.root, id, moved.id).catch(() => window.webContents.send('session:error'));
    return moved;
  });
  handle('workspace:trash', async (id, version) => {
    const removed = await workspace.trash(id, version, target => shell.trashItem(target));
    await settings.relocateFile(workspace.root, id).catch(() => window.webContents.send('session:error'));
    return removed;
  });
  handle('workspace:rename', async (id, name, version) => {
    const renamed = await workspace.rename(id, name, version);
    await settings.relocateFile(workspace.root, id, renamed.id).catch(() => window.webContents.send('session:error'));
    return renamed;
  });
  handle('workspace:copy-path', async id => {
    await clipboard.writeText(await workspace.filePath(id));
  });
  const command = name => () => window.webContents.send('menu:command', name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '文件', submenu: [
      { label: '打开文件夹…', accelerator: 'CmdOrCtrl+O', click: command('open') },
      { label: '最近打开…', click: command('recent') },
      { label: '新建 Markdown…', accelerator: 'CmdOrCtrl+N', click: command('new') },
      { label: '新建目录…', accelerator: 'CmdOrCtrl+Shift+N', click: command('new-folder') },
      { label: '保存', accelerator: 'CmdOrCtrl+S', click: command('save') },
      { label: '重新读取磁盘文件', accelerator: 'CmdOrCtrl+R', click: command('reload') },
      { label: '关闭当前标签', accelerator: 'CmdOrCtrl+W', click: command('close-tab') },
      { type: 'separator' }, { label: '退出', role: 'quit' }] },
    { label: '编辑', submenu: [{ label: '撤销', role: 'undo' }, { label: '重做', role: 'redo' },
      { type: 'separator' }, { label: '剪切', role: 'cut' }, { label: '复制', role: 'copy' },
      { label: '粘贴', role: 'paste' }, { label: '全选', role: 'selectAll' }] },
    { label: '视图', submenu: [{ label: '放大', role: 'zoomIn' }, { label: '缩小', role: 'zoomOut' },
      { label: '实际大小', role: 'resetZoom' }, { label: '全屏', role: 'togglefullscreen' }] },
    { label: '帮助', submenu: [{ label: '关于 LLMMarkUp', click: () => dialog.showMessageBox(window, {
      type: 'info', title: '关于 LLMMarkUp', message: `LLMMarkUp ${app.getVersion()}`,
      detail: 'AGPL-3.0-only\n源码：https://github.com/ai-v5/LLMMarkUp\n安装目录 resources 中包含 LICENSE、NOTICE 与 THIRD_PARTY_NOTICES.txt。'
    }) }] }
  ]));
  window.loadFile(path.join(__dirname, 'dist', 'index.html'));
  window.once('ready-to-show', () => window.show());
});
app.on('window-all-closed', () => app.quit());
