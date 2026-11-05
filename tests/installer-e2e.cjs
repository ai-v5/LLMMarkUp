// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawn, spawnSync } = require('node:child_process');
const { chromium, expect } = require('@playwright/test');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = fs.realpathSync(path.join(project, 'outputs'));
const installer = process.env.LLMMARKUP_INSTALLER && fs.realpathSync(process.env.LLMMARKUP_INSTALLER);
const available = process.platform === 'win32' && installer && fs.existsSync(installer);
const legacyApp = process.env.LLMMARKUP_LEGACY_APP_DIR && fs.realpathSync(process.env.LLMMARKUP_LEGACY_APP_DIR);
const legacyUninstaller = process.env.LLMMARKUP_LEGACY_UNINSTALLER && fs.realpathSync(process.env.LLMMARKUP_LEGACY_UNINSTALLER);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const appGuid = require('../package.json').build.nsis.guid;

async function hashStream(stream) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

function fixture(t, rootName = 'install') {
  const relation = path.relative(project, output);
  assert.ok(relation && !relation.startsWith('..') && !path.isAbsolute(relation));
  const installerRelation = path.relative(output, installer);
  assert.ok(installerRelation && !installerRelation.startsWith('..') && !path.isAbsolute(installerRelation));
  const base = fs.mkdtempSync(path.join(output, 'installer-e2e-'));
  assert.ok(['install', 'legacy-install'].includes(rootName));
  const root = path.join(base, rootName);
  const temp = path.join(base, 'temp');
  fs.mkdirSync(root);
  fs.mkdirSync(temp);
  fs.writeFileSync(path.join(root, 'user-document.md'), 'synthetic document');
  t.after(async () => {
    if (process.env.LLMMARKUP_KEEP_TEST_OUTPUT === '1') { console.log(`Synthetic fixture: ${base}`); return; }
    const relative = path.relative(output, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    for (let attempt = 0; attempt < 40; attempt++) {
      try { fs.rmSync(base, { recursive: true, force: true }); return; }
      catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 39) throw error;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    }
  });
  return { base, root, temp };
}
function run(file, args, fx, temp = fx.temp, extra = {}) {
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: temp, TMP: temp, TMPDIR: temp };
  for (const name of ['LLMMARKUP_TEST_LEGACY_SESSION', 'LLMMARKUP_LOCAL_SMOKE_PROFILE', 'LLMMARKUP_LOCAL_TEST_OUTPUT', 'LLMMARKUP_INSTALL_TEST_PAUSE', 'LLMMARKUP_MIGRATION_TEST_PAUSE', 'LLMMARKUP_MIGRATION_TEST_FAIL', 'LLMMARKUP_UNINSTALL_TEST_PAUSE']) delete env[name];
  Object.assign(env, extra);
  delete env.ELECTRON_RUN_AS_NODE;
  return spawnSync(file, args, { env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
}

test('installer rejects a misconfigured synthetic temporary directory', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  const badTemp = path.join(fx.base, 'wrong-temp');
  fs.mkdirSync(badTemp);
  const result = run(installer, ['/S'], fx, badTemp);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(fx.base, 'synthetic-registry.dat')), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
});

test('actual installer finds an interrupted uninstall in a synthetic custom directory', { skip: !available, timeout: 240000 }, async t => {
  const fx = fixture(t, 'legacy-install');
  let result = run(installer, ['/S'], fx, fx.temp, { LLMMARKUP_TEST_TARGET: fx.root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const helpers = path.join(fx.base, 'helpers');
  fs.mkdirSync(helpers);
  for (const name of ['safe-migrate.ps1', 'safe-uninstall.ps1']) fs.copyFileSync(path.join(project, 'scripts', name), path.join(helpers, name));
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.temp, TMP: fx.temp, TMPDIR: fx.temp, LLMMARKUP_UNINSTALL_TEST_PAUSE: 'after-location-removed' };
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'scripts', 'installer-core.ps1'),
    '-Mode', 'Uninstall', '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Version', '0.7.1', '-HelperDirectory', helpers], { env, windowsHide: true, stdio: 'ignore' });
  try {
    const marker = path.join(fx.base, 'uninstall-paused');
    for (let i = 0; i < 600 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(marker), 'the synthetic uninstall did not reach the interruption point');
    assert.equal(Number(fs.readFileSync(marker, 'utf8')), child.pid);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  result = run(installer, ['/S'], fx);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(path.join(fx.root, 'LLMMarkUp.exe')));
  assert.equal(fs.existsSync(path.join(fx.base, 'install')), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
});

test('actual installer and uninstaller preserve synthetic user files', { skip: !available, timeout: 240000 }, async t => {
  const fx = fixture(t);
  const installed = run(installer, ['/S'], fx);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const launcher = path.join(fx.root, 'LLMMarkUp.exe');
  const uninstaller = path.join(fx.root, 'Uninstall LLMMarkUp.exe');
  assert.ok(fs.existsSync(launcher));
  assert.ok(fs.existsSync(uninstaller));
  assert.ok(fs.existsSync(path.join(fx.base, 'synthetic-registry.dat')));
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const ids = fs.readdirSync(versions);
  assert.equal(ids.length, 1);
  const runtime = path.join(versions, ids[0]);
  fs.writeFileSync(path.join(runtime, 'user-note.md'), 'synthetic runtime note');
  const removed = run(uninstaller, ['/S'], fx);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  for (let i = 0; i < 600 && fs.existsSync(launcher); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(launcher), false);
  assert.equal(fs.existsSync(uninstaller), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  assert.equal(fs.readFileSync(path.join(runtime, 'user-note.md'), 'utf8'), 'synthetic runtime note');
});

test('installed launcher opens the real app, edits and saves a synthetic document', { skip: !available, timeout: 240000 }, async t => {
  const fx = fixture(t);
  const installed = run(installer, ['/S'], fx);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const launcher = path.join(fx.root, 'LLMMarkUp.exe');
  const document = path.join(fx.root, 'user-document.md');
  fs.writeFileSync(document, '\uFEFF# Synthetic heading\r\n');
  const started = run(launcher, ['--remote-debugging-port=0', `--user-data-dir=${fx.base}`, document], fx);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const portFile = path.join(fx.base, 'DevToolsActivePort');
  for (let i = 0; i < 300 && !fs.existsSync(portFile); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(fs.existsSync(portFile), 'the isolated application did not expose its test debugging port');
  const port = Number(fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0]);
  assert.ok(port > 0 && port < 65536);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page;
  try {
    const context = browser.contexts()[0];
    for (let i = 0; i < 200 && !context.pages().length; i++) await new Promise(resolve => setTimeout(resolve, 100));
    page = context.pages()[0];
    assert.ok(page, 'the isolated application did not open a window');
    await expect(page.locator('#preview h1')).toHaveText('Synthetic heading', { timeout: 30000 });
    await page.locator('.cm-content').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.insertText('\n## Synthetic edit\n');
    await expect(page.locator('#preview h2').last()).toHaveText('Synthetic edit');
    await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'true');
    const blockedInstall = run(installer, ['/S'], fx);
    assert.notEqual(blockedInstall.status, 0, 'installer must refuse the running app');
    const uninstaller = path.join(fx.root, 'Uninstall LLMMarkUp.exe');
    const blockedUninstall = run(uninstaller, ['/S', `_?=${fx.root}`], fx);
    assert.notEqual(blockedUninstall.status, 0, 'uninstaller must refuse the running app');
    await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'true');
    assert.ok(fs.existsSync(launcher));
    assert.doesNotMatch(fs.readFileSync(document, 'utf8'), /Synthetic edit/);
    await page.keyboard.press('Control+s');
    await expect(page.locator('#document-status')).toHaveAttribute('data-dirty', 'false');
    const saved = fs.readFileSync(document, 'utf8');
    assert.ok(saved.startsWith('\uFEFF'));
    assert.match(saved, /\r\n## Synthetic edit/);
    await page.close();
  } finally {
    if (page && !page.isClosed()) {
      await page.keyboard.press('Control+s').catch(() => {});
      await page.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const runtime = path.join(versions, fs.readdirSync(versions)[0]);
  const checkEnv = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.temp, TMP: fx.temp, TMPDIR: fx.temp, SYNTHETIC_APP_EXE: path.join(runtime, 'LLMMarkUp.exe') };
  delete checkEnv.LLMMARKUP_TEST_LEGACY_SESSION;
  delete checkEnv.LLMMARKUP_LOCAL_SMOKE_PROFILE;
  async function waitUntilClosed() {
    let running = true;
    for (let i = 0; i < 60 && running; i++) {
      const check = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'LLMMarkUp.exe'\" | Where-Object { $_.ExecutablePath -eq $env:SYNTHETIC_APP_EXE }); if ($p.Count -eq 0) { exit 0 } else { exit 2 }"], { env: checkEnv, windowsHide: true });
      running = check.status !== 0;
      if (running) await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.equal(running, false, 'the synthetic app did not close normally');
  }
  await waitUntilClosed();
  try {
    const isolatedProfile = path.join(fx.base, `local-smoke-${crypto.randomUUID().replaceAll('-', '')}`);
    fs.mkdirSync(isolatedProfile);
    const localLaunch = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'verify-local-launch.ps1'),
      '-EntryPath', launcher, '-Runtime', runtime, '-Profile', isolatedProfile, '-InstallRoot', fx.root], { env: checkEnv, encoding: 'utf8', windowsHide: true, timeout: 45000 });
    assert.equal(localLaunch.status, 0, localLaunch.stderr || localLaunch.stdout);
  } finally {
    spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'LLMMarkUp.exe'\" | Where-Object { $_.ExecutablePath -eq $env:SYNTHETIC_APP_EXE }); foreach ($item in $p) { $proc=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if ($proc -and $proc.MainWindowHandle -ne 0) { [void]$proc.CloseMainWindow() } }"], { env: checkEnv, windowsHide: true });
  }
  await waitUntilClosed();
  const uninstaller = path.join(fx.root, 'Uninstall LLMMarkUp.exe');
  const removed = run(uninstaller, ['/S'], fx);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  for (let i = 0; i < 600 && fs.existsSync(launcher); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(launcher), false);
  assert.match(fs.readFileSync(document, 'utf8'), /Synthetic edit/);
});

for (const uninstallOnly of [false, true]) {
test(`actual installer migrates a previous packaged application with ${uninstallOnly ? 'uninstall-only' : 'normal'} registration`, { skip: !available || !legacyApp || !legacyUninstaller, timeout: 300000 }, async t => {
  const fx = fixture(t, uninstallOnly ? 'legacy-install' : 'install');
  for (const source of [legacyApp, legacyUninstaller]) {
    const relative = path.relative(output, source);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  fs.mkdirSync(path.join(fx.root, 'resources'));
  const oldExe = path.join(fx.root, 'LLMMarkUp.exe');
  const oldUninstaller = path.join(fx.root, 'Uninstall LLMMarkUp.exe');
  fs.copyFileSync(path.join(legacyApp, 'LLMMarkUp.exe'), oldExe);
  fs.copyFileSync(path.join(legacyApp, 'resources', 'app.asar'), path.join(fx.root, 'resources', 'app.asar'));
  fs.copyFileSync(legacyUninstaller, oldUninstaller);
  const oldExeHash = await hashStream(fs.createReadStream(oldExe));
  const oldUninstallerHash = await hashStream(fs.createReadStream(oldUninstaller));
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.temp, TMP: fx.temp, TMPDIR: fx.temp };
  const registered = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
    '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Legacy', ...(uninstallOnly ? ['-UninstallOnly'] : [])], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  const installed = run(installer, ['/S'], fx);
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  if (uninstallOnly) assert.equal(fs.existsSync(path.join(fx.base, 'install')), false);
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const ids = fs.readdirSync(versions);
  assert.equal(ids.length, 1);
  const runtime = path.join(versions, ids[0]);
  const backup = path.join(runtime, '.legacy-backup');
  assert.equal(await hashStream(fs.createReadStream(path.join(backup, 'LLMMarkUp.exe.gz')).pipe(zlib.createGunzip())), oldExeHash);
  assert.equal(await hashStream(fs.createReadStream(path.join(backup, 'Uninstall LLMMarkUp.exe.gz')).pipe(zlib.createGunzip())), oldUninstallerHash);
  assert.notEqual(await hashStream(fs.createReadStream(oldExe)), oldExeHash);
  assert.notEqual(await hashStream(fs.createReadStream(oldUninstaller)), oldUninstallerHash);
  const removed = run(oldUninstaller, ['/S'], fx);
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  for (let i = 0; i < 600 && fs.existsSync(oldExe); i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(oldExe), false);
  assert.equal(fs.existsSync(oldUninstaller), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  assert.ok(fs.existsSync(path.join(fx.root, 'resources', 'app.asar')));
  assert.ok(fs.existsSync(path.join(backup, 'Uninstall LLMMarkUp.exe.gz')));
});
}

test('local delivery migrates a synthetic previous install and reopens its real application', { skip: !available || !legacyApp || !legacyUninstaller, timeout: 300000 }, async t => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.root, 'resources'));
  fs.copyFileSync(path.join(legacyApp, 'LLMMarkUp.exe'), path.join(fx.root, 'LLMMarkUp.exe'));
  fs.copyFileSync(path.join(legacyApp, 'resources', 'app.asar'), path.join(fx.root, 'resources', 'app.asar'));
  fs.copyFileSync(legacyUninstaller, path.join(fx.root, 'Uninstall LLMMarkUp.exe'));
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.temp, TMP: fx.temp, TMPDIR: fx.temp, LLMMARKUP_LOCAL_TEST_OUTPUT: path.dirname(installer) };
  delete env.LLMMARKUP_TEST_LEGACY_SESSION;
  delete env.LLMMARKUP_LOCAL_SMOKE_PROFILE;
  for (const name of ['LLMMARKUP_INSTALL_TEST_PAUSE', 'LLMMARKUP_MIGRATION_TEST_PAUSE', 'LLMMARKUP_MIGRATION_TEST_FAIL', 'LLMMARKUP_UNINSTALL_TEST_PAUSE']) delete env[name];
  const registered = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
    '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Legacy'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  let runtime;
  try {
    const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const command = process.env.LLMMARKUP_TEST_FULL_LOCAL ? process.execPath : powershell;
    const args = process.env.LLMMARKUP_TEST_FULL_LOCAL
      ? [npmCli, 'run', 'dist:local']
      : ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'run-local-delivery.ps1'), '-InstallRoot', fx.root];
    if (process.env.LLMMARKUP_TEST_FULL_LOCAL) assert.ok(fs.existsSync(npmCli), 'npm CLI is unavailable');
    const result = spawnSync(command, args, { env, encoding: 'utf8', windowsHide: true, timeout: 180000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const versions = path.join(fx.root, '.llmmarkup-versions');
    const ids = fs.readdirSync(versions);
    assert.equal(ids.length, 1);
    runtime = path.join(versions, ids[0]);
    const receipt = JSON.parse(fs.readFileSync(path.join(fx.base, 'local-install-receipt.json'), 'utf8'));
    assert.equal(receipt.version, '0.7.1');
    assert.equal(receipt.previousVersion, '0.7.0');
    assert.equal(receipt.launched, true);
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  } finally {
    if (!runtime) {
      const versions = path.join(fx.root, '.llmmarkup-versions');
      if (fs.existsSync(versions)) {
        const ids = fs.readdirSync(versions).filter(id => /^[0-9a-f-]{36}$/i.test(id));
        if (ids.length === 1) runtime = path.join(versions, ids[0]);
      }
    }
    if (runtime) {
      const processEnv = { ...env, SYNTHETIC_APP_EXE: path.join(runtime, 'LLMMarkUp.exe') };
      spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        "$p=@(Get-CimInstance Win32_Process -Filter \"Name = 'LLMMarkUp.exe'\" | Where-Object { $_.ExecutablePath -eq $env:SYNTHETIC_APP_EXE }); foreach ($item in $p) { $proc=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue; if ($proc -and $proc.MainWindowHandle -ne 0) { [void]$proc.CloseMainWindow() } }"], { env: processEnv, windowsHide: true });
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
});
