// SPDX-License-Identifier: AGPL-3.0-only
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron, expect } = require('@playwright/test');

test('Windows desktop: directory → edit → live preview → save → conflicts → close protection', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-e2e-'));
  let application;
  t.after(async () => {
    if (application) {
      // Only test-created windows/fixtures: bypass the dirty guard during test cleanup.
      await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close');
      }).catch(() => {});
      await application.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const folder = path.join(root, '合成文档'); await fs.mkdir(folder);
  await fs.mkdir(path.join(folder, '章节'));
  const source = '# 合成项目计划\n\n这是一份**虚构的演示文档**，用于验证编辑与预览。\n\n## 任务一览\n\n| 阶段 | 内容 | 状态 |\n| --- | --- | --- |\n| 01 | 梳理想法 | 已完成 |\n| 02 | 编写草稿 | 进行中 |\n| 03 | 核对内容 | 待开始 |\n\n> 所有名称和内容均为合成示例。\n\n## 下一步\n\n- 编写清晰的标题\n- 完善正文与表格\n- 保存到本机\n\n```python\nmessage = "Hello, Markdown"\nprint(message)\n```\n';
  await fs.writeFile(path.join(folder, '项目计划.md'), '\uFEFF' + source.replace(/\n/g, '\r\n'));
  await fs.writeFile(path.join(folder, '章节', '笔记.markdown'), '# 章节笔记\n');
  const mathSource = String.raw`# 复杂公式 · 合成示例

行内公式：$e^{i\pi}+1=0$，$\nabla\cdot\mathbf{E}=\frac{\rho}{\varepsilon_0}$。

## 多行对齐与积分

$$
\begin{aligned}
\mathcal{L}(\theta) &= -\sum_{i=1}^{n}\log p_\theta(x_i) \\
\int_{-\infty}^{\infty}e^{-x^2}\,dx &= \sqrt{\pi}
\end{aligned}
$$

## 矩阵与分段函数

\[
A=\begin{pmatrix}a&b\\c&d\end{pmatrix},\quad
f(x)=\begin{cases}x^2 & x\ge0\\-x & x<0\end{cases}
\]
`;
  await fs.writeFile(path.join(folder, '公式示例.md'), mathSource);
  const env = { ...process.env, LLMMARKUP_TEST_DATA: path.join(root, 'profile') };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    ...(process.env.LLMMARKUP_TEST_EXE ? { executablePath: process.env.LLMMARKUP_TEST_EXE, args: [] } : { args: [path.resolve(__dirname, '..')] }), env
  });
  let page = await application.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const failedFonts = []; page.on('requestfailed', request => { if (/\.(woff2?|ttf)$/.test(request.url())) failedFonts.push(request.url()); });
  await expect(page.locator('h1')).toHaveText('专注内容，看见结果。');
  assert.equal(await page.locator('.app-header, .document-bar').count(), 0);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  const options = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  assert.equal(options.contextIsolation, true); assert.equal(options.sandbox, true); assert.equal(options.nodeIntegration, false);
  // Only the native picker is stubbed; all file reads/writes and renderer IPC are real.
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  await page.locator('#open-folder').click();
  await page.getByRole('menuitem', { name: '打开文件夹…', exact: true }).click();
  await page.getByRole('button', { name: 'M↓ 项目计划.md', exact: true }).click();
  await expect(page.locator('#preview h1')).toHaveText('合成项目计划');
  await expect(page.locator('#preview table')).toBeVisible();
  assert.ok((await page.locator('#panes').boundingBox()).y < 1);
  await page.locator('#new-folder').click();
  await page.locator('#folder-new-name').fill('资料');
  await page.getByRole('button', { name: '创建目录', exact: true }).click();
  await expect(page.getByRole('button', { name: '› 资料', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+n');
  await expect(page.locator('#folder-parent')).toHaveValue('资料');
  await page.locator('#folder-new-name').fill('子目录');
  await page.getByRole('button', { name: '创建目录', exact: true }).click();
  await expect(page.getByRole('button', { name: '› 子目录', exact: true })).toBeVisible();
  assert.ok((await fs.stat(path.join(folder, '资料', '子目录'))).isDirectory());
  await expect(page.locator('#preview h1')).toHaveText('合成项目计划');
  // Both splitters are real pointer targets; independent panel preferences do not dirty the file.
  const beforeSidebar = await page.locator('.sidebar').boundingBox();
  const sidebarHandle = await page.locator('#sidebar-splitter').boundingBox();
  await page.mouse.move(sidebarHandle.x + 2, sidebarHandle.y + 100); await page.mouse.down();
  await page.mouse.move(sidebarHandle.x + 82, sidebarHandle.y + 100, { steps: 8 }); await page.mouse.up();
  assert.ok((await page.locator('.sidebar').boundingBox()).width > beforeSidebar.width + 60);
  const editorHandle = await page.locator('#splitter').boundingBox();
  const beforeEditor = await page.locator('#editor-pane').boundingBox();
  await page.mouse.move(editorHandle.x + 2, editorHandle.y + 100); await page.mouse.down();
  await page.mouse.move(editorHandle.x - 48, editorHandle.y + 100, { steps: 8 }); await page.mouse.up();
  assert.ok((await page.locator('#editor-pane').boundingBox()).width < beforeEditor.width - 30);
  await page.locator('#editor-dark').click();
  await expect(page.locator('#editor-pane')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.workspace')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(32, 36, 44)');
  await expect(page.locator('#preview-pane')).toHaveAttribute('data-theme', 'light');
  await page.locator('#preview-dark').click(); await page.locator('#editor-light').click();
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(246, 248, 252)');
  await expect(page.locator('#preview-pane')).toHaveAttribute('data-theme', 'dark');
  const headingHeight = (await page.locator('#preview h1').boundingBox()).height;
  await page.locator('#preview-scale').selectOption('0.75');
  assert.ok(Math.abs((await page.locator('#preview h1').boundingBox()).height - headingHeight * 0.75) < 1);
  await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'false');
  await page.locator('#preview-scale').selectOption('1'); await page.locator('#preview-light').click();
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n## 实时修改\n\n中文输入与保存。\n');
  await expect(page.locator('#preview h2').last()).toHaveText('实时修改');
  await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'true');
  // Creating a directory does not discard or silently save the open document.
  await page.locator('#new-folder').click(); await page.locator('#folder-parent').selectOption('');
  await page.locator('#folder-new-name').fill('草稿资料');
  await page.getByRole('button', { name: '创建目录', exact: true }).click();
  await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'true');
  await page.keyboard.press('Control+s');
  await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'false');
  const bytes = await fs.readFile(path.join(folder, '项目计划.md'), 'utf8');
  assert.ok(bytes.startsWith('\uFEFF')); assert.match(bytes, /\r\n## 实时修改/);
  await fs.mkdir(path.resolve('outputs/qa'), { recursive: true });
  await page.locator('.cm-content').press('Control+Home');
  await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; document.getElementById('preview-scroll').scrollTop = 0; });
  await page.screenshot({ path: path.resolve('outputs/qa/desktop-editor.png'), scale: 'css' });
  await page.locator('.cm-content').press('Control+f');
  await expect(page.locator('.cm-search')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n尚未保存');
  await page.getByRole('button', { name: '› 章节', exact: true }).click();
  await page.getByRole('button', { name: 'M↓ 笔记.markdown', exact: true }).click();
  await expect(page.locator('#unsaved-dialog')).toBeHidden();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText('\n另一个未保存草稿');
  // Exit must catch a dirty inactive tab as well as the active document.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.locator('#unsaved-dialog')).toBeVisible();
  await expect(page.locator('#unsaved-message')).toContainText('项目计划.md');
  await page.locator('[data-choice="save"]').click();
  await expect(page.locator('#unsaved-message')).toContainText('笔记.markdown');
  await page.locator('[data-choice="cancel"]').click();
  assert.match(await fs.readFile(path.join(folder, '项目计划.md'), 'utf8'), /尚未保存/);
  assert.equal(await fs.readFile(path.join(folder, '章节', '笔记.markdown'), 'utf8'), '# 章节笔记\n');
  await page.getByRole('tab', { name: '项目计划.md', exact: true }).click();
  await expect(page).toHaveTitle(/项目计划\.md/);
  await expect(page.locator('.cm-content')).toContainText('尚未保存');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n第二次草稿');
  await page.keyboard.press('Control+w');
  await expect(page.locator('#unsaved-dialog')).toBeVisible();
  await page.locator('[data-choice="discard"]').click();
  await expect(page.locator('#preview h1')).toHaveText('章节笔记');
  // A disk edit after opening must survive a local save attempt.
  await fs.writeFile(path.join(folder, '章节', '笔记.markdown'), '# 外部修改\n');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('本机候选');
  await page.keyboard.press('Control+s');
  await expect(page.locator('#notice')).toContainText('磁盘文件已变化');
  assert.equal(await fs.readFile(path.join(folder, '章节', '笔记.markdown'), 'utf8'), '# 外部修改\n');
  await page.keyboard.press('Control+r'); await page.locator('[data-choice="discard"]').click();
  await expect(page.locator('#preview h1')).toHaveText('外部修改');
  await page.locator('#new-file').click(); await page.locator('#new-name').fill('新文档.md');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  await expect(page).toHaveTitle(/新文档\.md/);
  assert.equal(await fs.readFile(path.join(folder, '新文档.md'), 'utf8'), '');
  // Adversarial Markdown cannot execute or issue a remote image request.
  await page.locator('.cm-content').click();
  await page.keyboard.insertText('# 安全示例\n\n<script>window.__injected = true</script>\n\n![x](https://example.invalid/x.png)\n');
  await expect(page.locator('#preview')).toContainText('首版不加载图片');
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  assert.equal(await page.locator('#preview script, #preview img').count(), 0);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect(page.locator('#unsaved-dialog')).toBeVisible();
  await page.locator('[data-choice="cancel"]').click();
  assert.equal(application.windows().length, 1);
  // No discard is needed for cleanup: explicitly save the synthetic fixture.
  await page.keyboard.press('Control+s'); await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'false');
  await page.getByRole('button', { name: 'M↓ 公式示例.md', exact: true }).click();
  await expect(page.locator('#preview .katex')).toHaveCount(4);
  assert.equal(await page.locator('#preview .katex-error').count(), 0);
  await page.evaluate(() => document.fonts.ready);
  assert.ok(await page.evaluate(() => [...document.fonts].some(font => font.family.startsWith('KaTeX') && font.status === 'loaded')));
  await page.locator('#preview-scale').selectOption('0.8'); await page.locator('#editor-dark').click();
  await page.evaluate(() => { document.querySelector('.cm-scroller').scrollTop = 0; document.getElementById('preview-scroll').scrollTop = 0; });
  await page.screenshot({ path: path.resolve('outputs/qa/desktop-math.png'), scale: 'css' });
  await page.locator('#preview-dark').click();
  await page.screenshot({ path: path.resolve('outputs/qa/desktop-dark.png'), scale: 'css' });
  // Narrow windows/large sidebars still keep all toolbar controls reachable.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 640));
  const narrow = await page.locator('#sidebar-splitter').boundingBox();
  await page.mouse.move(narrow.x + 2, narrow.y + 50); await page.mouse.down();
  await page.mouse.move(700, narrow.y + 50, { steps: 8 }); await page.mouse.up();
  await page.locator('#preview-scale').selectOption('0.5');
  for (const id of ['preview-dark', 'preview-scale', 'sync-scroll']) await expect(page.locator(`#${id}`)).toBeInViewport();
  assert.deepEqual(failedFonts, []);
  assert.deepEqual(errors, []);
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  await closed;
  application = null;
  // A fresh main process/profile reload restores files and preferences without document contents in the config.
  const persisted = JSON.parse(await fs.readFile(path.join(root, 'profile', 'studio-session.json'), 'utf8'));
  assert.equal(persisted.folder, await fs.realpath(folder));
  assert.ok(persisted.tabs.includes('公式示例.md'));
  assert.equal(persisted.editorTheme, 'dark'); assert.equal(persisted.previewTheme, 'dark'); assert.equal(persisted.previewScale, 0.5);
  application = await electron.launch({
    ...(process.env.LLMMARKUP_TEST_EXE ? { executablePath: process.env.LLMMARKUP_TEST_EXE, args: [] } : { args: [path.resolve(__dirname, '..')] }), env
  });
  page = await application.firstWindow();
  await expect(page.locator('#folder-name')).toHaveText('合成文档');
  await expect(page.locator('#preview h1')).toHaveText('复杂公式 · 合成示例');
  await expect(page.getByRole('tab')).toHaveCount(persisted.tabs.length);
  await expect(page.locator('.sidebar')).toHaveCSS('background-color', 'rgb(32, 36, 44)');
  await expect(page.locator('#preview-pane')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#preview-scale')).toHaveValue('0.5');
  await page.keyboard.press('Control+w');
  await page.locator('#open-folder').click();
  await page.getByRole('menuitem', { name: '合成文档 / 公式示例.md', exact: true }).click();
  await expect(page.locator('#preview .katex')).toHaveCount(4);
  const otherFolder = path.join(root, '其他文档'); await fs.mkdir(otherFolder);
  await fs.writeFile(path.join(otherFolder, '另一个.md'), '# 另一份合成文档\n');
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, otherFolder);
  await page.keyboard.press('Control+o');
  await expect(page.locator('#folder-name')).toHaveText('其他文档');
  await expect(page.locator('#preview-scale')).toHaveValue('0.5');
  await page.getByRole('button', { name: 'M↓ 另一个.md', exact: true }).click();
  await expect(page.locator('#preview h1')).toHaveText('另一份合成文档');
  await page.locator('#open-folder').click();
  await page.getByRole('menuitem', { name: '合成文档 / 公式示例.md', exact: true }).click();
  await expect(page.locator('#folder-name')).toHaveText('合成文档');
  await expect(page.locator('#preview .katex')).toHaveCount(4);
  await expect(page.getByRole('tab')).toHaveCount(1);
  const closedAgain = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  await closedAgain; application = null;
});

test('context actions, compact sidebar, independent pinch zoom and enhanced Markdown survive restart', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-context-e2e-'));
  let application;
  t.after(async () => {
    if (application) {
      await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close');
      }).catch(() => {});
      await application.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const folder = path.join(root, '用于验证窄目录栏省略显示的合成项目目录'); await fs.mkdir(folder);
  const chapter = path.join(folder, '章节'); await fs.mkdir(chapter);
  const source = '# 增强预览\n\n| 内容 | 状态 |\n| - | - |\n| 第一行<br/>第二行 | ~~旧~~ |\n\n- [x] 已完成\n- [ ] 待开始\n\n说明[^a]\n\n' +
    '合成段落。\n\n'.repeat(25) + '[^a]: 合成脚注\n';
  await fs.writeFile(path.join(folder, 'main.md'), source);
  const profile = path.join(root, 'profile');
  const env = { ...process.env, LLMMARKUP_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({
    ...(process.env.LLMMARKUP_TEST_EXE ? { executablePath: process.env.LLMMARKUP_TEST_EXE, args: [] } : { args: [path.resolve(__dirname, '..')] }), env
  });
  application = await launch(); let page = await application.firstWindow();
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, folder);
  await page.locator('#welcome-open').click();
  await page.locator('[data-file="main.md"]').click();
  await expect(page.locator('#preview table br')).toHaveCount(1);
  await expect(page.locator('#preview .task-list-item-checkbox')).toHaveCount(2);
  await expect(page.locator('#preview .task-list-item-checkbox').first()).toBeChecked();
  await expect(page.locator('#preview .task-list-item-checkbox').first()).toBeDisabled();
  const originalUrl = page.url();
  await page.locator('.footnote-ref a[href]').click();
  assert.equal(page.url(), originalUrl);
  await expect(page.locator('.footnote-item')).toBeInViewport();
  await page.locator('#sidebar-splitter').focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
  const layout = await page.locator('.sidebar-toolbar').evaluate(toolbar => ({
    width: toolbar.getBoundingClientRect().width,
    height: toolbar.getBoundingClientRect().height,
    right: toolbar.getBoundingClientRect().right,
    buttons: [...toolbar.querySelectorAll('button')].map(button => {
      const r = button.getBoundingClientRect(); return { top: r.top, right: r.right, width: r.width };
    })
  }));
  assert.ok(layout.width <= 175); assert.ok(layout.height <= 38);
  assert.equal(new Set(layout.buttons.map(button => button.top)).size, 1);
  assert.ok(layout.buttons.every(button => button.right <= layout.right && button.width <= 28));
  assert.equal(await page.locator('#folder-name').evaluate(element => element.scrollWidth > element.clientWidth), true);
  const editorFont = () => page.locator('.cm-editor').evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  const initialFont = await editorFont();
  const cdp = await application.context().newCDPSession(page);
  const pinch = async panel => {
    const bounds = await page.locator(panel).boundingBox();
    await cdp.send('Input.synthesizePinchGesture', { x: bounds.x + bounds.width / 2, y: bounds.y + 80,
      scaleFactor: 1.4, relativeSpeed: 800, gestureSourceType: 'mouse' });
  };
  await pinch('#editor');
  await expect.poll(editorFont).toBeGreaterThan(initialFont);
  await expect(page.locator('#preview-scale')).toHaveValue('1');
  const resizedFont = await editorFont();
  await pinch('#preview-scroll');
  await expect.poll(async () => Number(await page.locator('#preview-scale').inputValue())).toBeGreaterThan(1);
  assert.equal(await editorFont(), resizedFont);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor()), 1);
  assert.equal(await page.evaluate(() => window.visualViewport.scale), 1);
  const context = async (id, label, directory = false) => {
    await page.locator(`[data-${directory ? 'directory' : 'file'}="${id}"]`).click({ button: 'right' });
    await page.locator('#tree-menu').getByRole('menuitem', { name: label, exact: true }).click();
  };
  await context('章节', '新建 Markdown…', true);
  await expect(page.locator('#new-location')).toContainText('/章节');
  await page.locator('#new-name').fill('子文件.md'); await page.getByRole('button', { name: '创建', exact: true }).click();
  await page.locator('.cm-content').click(); await page.keyboard.insertText('# 子文件\n'); await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFile(path.join(chapter, '子文件.md'), 'utf8')).toBe('# 子文件\n');
  await page.locator('.tab-select[title="main.md"]').click();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
  await page.keyboard.insertText('移动中的未保存内容'); await page.keyboard.press('Enter');
  await page.locator('.tab-select[title="章节/子文件.md"]').click();
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, root);
  await context('main.md', '移动到…'); await expect(page.locator('#notice')).toContainText('当前工作目录内');
  assert.equal(await fs.readFile(path.join(folder, 'main.md'), 'utf8'), source);
  await fs.writeFile(path.join(chapter, 'main.md'), 'keep existing');
  await application.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, chapter);
  await context('main.md', '移动到…'); await expect(page.locator('#notice')).toContainText('同名文件');
  assert.equal(await fs.readFile(path.join(chapter, 'main.md'), 'utf8'), 'keep existing');
  await fs.unlink(path.join(chapter, 'main.md'));
  await context('main.md', '移动到…');
  await expect(page.locator('.tab-select[title="章节/main.md"]')).toContainText('●');
  await assert.rejects(fs.access(path.join(folder, 'main.md')));
  await page.locator('.tab-select[title="章节/main.md"]').click();
  await expect(page.locator('.cm-content')).toContainText('移动中的未保存内容');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFile(path.join(chapter, 'main.md'), 'utf8')).toContain('移动中的未保存内容');
  await context('章节/子文件.md', '删除（移至回收站）…');
  await page.locator('[data-trash-choice="cancel"]').click();
  assert.equal(await fs.readFile(path.join(chapter, '子文件.md'), 'utf8'), '# 子文件\n');
  await page.locator('.tab-select[title="章节/子文件.md"]').click();
  await page.locator('.cm-content').click(); await page.keyboard.insertText('保留草稿');
  await context('章节/子文件.md', '删除（移至回收站）…');
  await page.locator('[data-choice="cancel"]').click();
  await expect(page.locator('.cm-content')).toContainText('保留草稿');
  await context('章节/子文件.md', '删除（移至回收站）…');
  await page.locator('[data-choice="save"]').click();
  await expect(page.locator('#trash-dialog')).toBeVisible(); await page.locator('[data-trash-choice="trash"]').click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await assert.rejects(fs.access(path.join(chapter, '子文件.md')));
  await page.locator('#editor-dark').click();
  await page.locator('[data-directory="章节"]').click({ button: 'right' });
  await page.screenshot({ path: path.resolve('outputs/qa/compact-tree-context.png') });
  await page.keyboard.press('Escape');
  const previewScale = await page.locator('#preview-scale').inputValue();
  const scaleLabel = await page.locator('#editor-scale').textContent();
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  await closed; application = await launch(); page = await application.firstWindow();
  await expect(page).toHaveTitle('章节/main.md — LLMMarkUp');
  await expect(page.locator('#preview-scale')).toHaveValue(previewScale);
  await expect(page.locator('#editor-scale')).toHaveText(scaleLabel);
  const state = JSON.parse(await fs.readFile(path.join(profile, 'studio-session.json'), 'utf8'));
  assert.deepEqual(state.tabs, ['章节/main.md']);
  assert.ok(state.recentFiles.every(item => item.id !== 'main.md' && item.id !== '章节/子文件.md'));
  assert.equal(await fs.readFile(path.join(chapter, 'main.md'), 'utf8'), source + '\n移动中的未保存内容\n');
});

test('rename keeps background drafts, undo, recent history and tabs; copy path awaits the clipboard', { timeout: 90000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-rename-e2e-'));
  let application;
  t.after(async () => {
    if (application) {
      await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close');
      }).catch(() => {});
      await application.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const folder = path.join(root, '合成重命名项目'); await fs.mkdir(folder);
  const canonical = await fs.realpath(folder);
  await fs.mkdir(path.join(folder, '章节'));
  const original = '\uFEFF# 合成原文\r\n';
  await fs.writeFile(path.join(folder, '章节', '旧名.md'), original);
  await fs.writeFile(path.join(folder, '章节', '已存在.md'), 'keep');
  await fs.writeFile(path.join(folder, 'other.md'), '# 另一个标签\n');
  await fs.writeFile(path.join(folder, '未打开.md'), Buffer.from([0xff, 0xfe]));
  const profile = path.join(root, 'profile'); await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'studio-session.json'), JSON.stringify({ version: 1, folder: canonical,
    tabs: ['章节/旧名.md', 'other.md'], activeId: '章节/旧名.md',
    recentFiles: [{ folder: canonical, id: '章节/旧名.md' }] }));
  const env = { ...process.env, LLMMARKUP_TEST_DATA: profile }; delete env.ELECTRON_RUN_AS_NODE;
  const launch = () => electron.launch({
    ...(process.env.LLMMARKUP_TEST_EXE ? { executablePath: process.env.LLMMARKUP_TEST_EXE, args: [] } : { args: [path.resolve(__dirname, '..')] }), env
  });
  application = await launch(); let page = await application.firstWindow();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await expect(page).toHaveTitle('章节/旧名.md — LLMMarkUp');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText('保留未保存的编辑');
  const cursor = await page.locator('#cursor-position').textContent();
  await page.locator('.tab-select[title="other.md"]').click();
  const context = async (id, label) => {
    await page.locator(`[data-file="${id}"]`).click({ button: 'right' });
    await page.locator('#tree-menu').getByRole('menuitem', { name: label, exact: true }).click();
  };
  const rename = async name => {
    await context('章节/旧名.md', '重命名…');
    await page.locator('#rename-name').fill(name);
    await page.locator('#rename-form').getByRole('button', { name: '重命名', exact: true }).click();
  };
  // Keep the user's real clipboard untouched; exercise the trusted IPC and async write boundary.
  await application.evaluate(({ clipboard }) => {
    clipboard.writeText = text => new Promise(resolve => { globalThis.copiedPath = text; globalThis.finishCopy = resolve; });
  });
  await context('未打开.md', '复制文件路径');
  await expect.poll(() => application.evaluate(() => globalThis.copiedPath)).toBe(path.join(canonical, '未打开.md'));
  await expect(page.locator('#notice')).not.toContainText('已复制');
  await application.evaluate(() => globalThis.finishCopy());
  await expect(page.locator('#notice')).toHaveText('已复制文件完整路径');
  await expect(page.locator('.tab-select[title="other.md"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.locator('[data-file="章节/旧名.md"]').dispatchEvent('contextmenu', { clientX: 10, clientY: 9000 });
  await expect(page.locator('#tree-menu [role="menuitem"]')).toHaveCount(4);
  assert.equal(await page.locator('#tree-menu').evaluate(menu => {
    const bounds = menu.getBoundingClientRect(); return bounds.top >= 0 && bounds.bottom <= innerHeight && bounds.right <= innerWidth;
  }), true);
  await page.locator('#tree-menu').getByRole('menuitem', { name: '重命名…', exact: true }).click();
  assert.deepEqual(await page.locator('#rename-name').evaluate(input => [input.value, input.selectionStart, input.selectionEnd]), ['旧名.md', 0, 2]);
  await page.locator('#rename-cancel').click();
  await rename('已存在.md'); await expect(page.locator('#notice')).toContainText('同名文件');
  await rename('invalid.txt'); await expect(page.locator('#notice')).toContainText('.markdown');
  assert.equal(await fs.readFile(path.join(folder, '章节', '旧名.md'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(folder, '章节', '已存在.md'), 'utf8'), 'keep');
  // A stale target tab may still own a draft even after its disk file disappears.
  await page.locator('[data-file="章节/已存在.md"]').click();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End');
  await page.keyboard.insertText('目标草稿');
  await fs.unlink(path.join(folder, '章节', '已存在.md'));
  await rename('已存在.md'); await expect(page.locator('#notice')).toContainText('已打开的标签');
  await expect(page.locator('.cm-content')).toContainText('目标草稿');
  await fs.writeFile(path.join(folder, '章节', '已存在.md'), 'keep');
  await page.getByRole('button', { name: '关闭 章节/已存在.md', exact: true }).click();
  await page.locator('[data-choice="discard"]').click();
  await page.locator('.tab-select[title="other.md"]').click();
  await rename('新名称.markdown');
  await expect(page.locator('.tab-select[title="章节/新名称.markdown"]')).toContainText('●');
  await expect(page.locator('.tab-select[title="other.md"]')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('[data-file="章节/旧名.md"]')).toHaveCount(0);
  await assert.rejects(fs.access(path.join(folder, '章节', '旧名.md')));
  assert.equal(await fs.readFile(path.join(folder, '章节', '新名称.markdown'), 'utf8'), original);
  const recent = await page.evaluate(() => window.studio.recent());
  assert.equal(recent.ok, true);
  assert.ok(recent.value.files.some(item => item.id === '章节/新名称.markdown'));
  assert.ok(recent.value.files.every(item => item.id !== '章节/旧名.md'));
  await page.locator('#open-folder').click();
  await expect(page.locator('#open-menu')).toContainText('章节/新名称.markdown');
  await expect(page.locator('#open-menu')).not.toContainText('章节/旧名.md');
  await page.keyboard.press('Escape');
  await application.evaluate(({ clipboard }) => { clipboard.writeText = async text => { globalThis.copiedPath = text; }; });
  await context('章节/新名称.markdown', '复制文件路径');
  await expect(page.locator('#notice')).toHaveText('已复制文件完整路径');
  assert.equal(await application.evaluate(() => globalThis.copiedPath), path.join(canonical, '章节', '新名称.markdown'));
  await application.evaluate(({ clipboard }) => { clipboard.writeText = async () => { throw new Error('synthetic clipboard failure'); }; });
  await context('章节/新名称.markdown', '复制文件路径');
  await expect(page.locator('#notice')).toHaveClass('error'); await expect(page.locator('#notice')).not.toContainText('已复制');
  await page.locator('.tab-select[title="章节/新名称.markdown"]').click();
  await expect(page.locator('.cm-content')).toContainText('保留未保存的编辑');
  await expect(page.locator('#cursor-position')).toHaveText(cursor);
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+z');
  await expect(page.locator('.cm-content')).not.toContainText('保留未保存的编辑');
  await page.keyboard.press('Control+y');
  await expect(page.locator('.cm-content')).toContainText('保留未保存的编辑');
  await page.keyboard.press('Control+s');
  await expect.poll(() => fs.readFile(path.join(folder, '章节', '新名称.markdown'), 'utf8')).toBe(original + '保留未保存的编辑');
  // Renaming an active tab must also update the title and preserve the tab order.
  await page.keyboard.insertText('；活动标签草稿');
  await context('章节/新名称.markdown', '重命名…'); await page.locator('#rename-name').fill('最终名称.md');
  await page.locator('#rename-form').getByRole('button', { name: '重命名', exact: true }).click();
  await expect(page).toHaveTitle('● 章节/最终名称.md — LLMMarkUp');
  await expect(page.locator('.cm-content')).toContainText('；活动标签草稿');
  assert.equal(await fs.readFile(path.join(folder, '章节', '最终名称.md'), 'utf8'), original + '保留未保存的编辑');
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+s');
  await expect(page).toHaveTitle('章节/最终名称.md — LLMMarkUp');
  await expect.poll(() => fs.readFile(path.join(folder, '章节', '最终名称.md'), 'utf8')).toBe(original + '保留未保存的编辑；活动标签草稿');
  assert.deepEqual(await page.getByRole('tab').evaluateAll(tabs => tabs.map(tab => tab.title)), ['章节/最终名称.md', 'other.md']);
  await fs.mkdir(path.resolve('outputs/qa'), { recursive: true });
  await page.locator('[data-file="章节/最终名称.md"]').click({ button: 'right' });
  await page.screenshot({ path: path.resolve('outputs/qa/rename-copy-path.png') }); await page.keyboard.press('Escape');
  const closed = application.waitForEvent('close');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close()).catch(() => {});
  await closed; application = await launch(); page = await application.firstWindow();
  await expect(page).toHaveTitle('章节/最终名称.md — LLMMarkUp');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('.cm-content')).toContainText('保留未保存的编辑');
  const state = JSON.parse(await fs.readFile(path.join(profile, 'studio-session.json'), 'utf8'));
  assert.deepEqual(state.tabs, ['章节/最终名称.md', 'other.md']);
  assert.ok(state.recentFiles.every(item => !['章节/旧名.md', '章节/新名称.markdown'].includes(item.id)));
  assert.deepEqual(errors, []);
});

test('legacy desktop configuration restores in the renamed app without changing the legacy file', { timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'llmmarkup-migration-e2e-'));
  let application;
  t.after(async () => {
    if (application) {
      await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.removeAllListeners('close');
      }).catch(() => {});
      await application.close();
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const folder = path.join(root, '合成旧目录'); await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, '恢复.md'), '# 合成迁移示例\n');
  const legacyFile = path.join(root, 'legacy-session.json');
  const legacy = JSON.stringify({ version: 1, folder, tabs: ['恢复.md'], activeId: '恢复.md',
    editorTheme: 'dark', previewTheme: 'light', previewScale: 0.75,
    recentFolders: [folder], recentFiles: [{ folder, id: '恢复.md' }] });
  await fs.writeFile(legacyFile, legacy);
  const profile = path.join(root, 'new-profile');
  const env = { ...process.env, LLMMARKUP_TEST_DATA: profile, LLMMARKUP_TEST_LEGACY_SESSION: legacyFile };
  delete env.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({
    ...(process.env.LLMMARKUP_TEST_EXE ? { executablePath: process.env.LLMMARKUP_TEST_EXE, args: [] } : { args: [path.resolve(__dirname, '..')] }), env
  });
  const page = await application.firstWindow();
  await expect(page.locator('#preview h1')).toHaveText('合成迁移示例');
  await expect(page).toHaveTitle('恢复.md — LLMMarkUp');
  await expect(page.getByRole('tab', { name: '恢复.md' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.workspace')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('#preview-pane')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('#preview-scale')).toHaveValue('0.75');
  assert.equal(await fs.readFile(legacyFile, 'utf8'), legacy);
  assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'studio-session.json'), 'utf8')).activeId, '恢复.md');
});
