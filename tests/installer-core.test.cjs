// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const asar = require('@electron/asar');
const { createManifest } = require('../scripts/payload-manifest.cjs');
const { spawn, spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(project, 'outputs');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const available = process.platform === 'win32' && fs.existsSync(powershell);
const appGuid = require('../package.json').build.nsis.guid;
const core = path.join(project, 'scripts', 'installer-core.ps1');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

function fixture(t) {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const rel = path.relative(project, outputReal);
  assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  const base = fs.mkdtempSync(path.join(outputReal, 'installer-core-test-'));
  const fx = { base, root: path.join(base, 'install'), payload: path.join(base, 'payload'), helpers: path.join(base, 'helpers'), uninstaller: path.join(base, 'uninstaller.exe') };
  fs.mkdirSync(fx.payload);
  fs.mkdirSync(fx.helpers);
  fs.mkdirSync(path.join(fx.payload, 'resources'));
  fs.writeFileSync(path.join(fx.payload, 'LLMMarkUp.exe'), 'synthetic application executable');
  fs.writeFileSync(path.join(fx.payload, 'llmmarkup-launcher.exe'), 'synthetic launcher');
  fs.writeFileSync(path.join(fx.payload, 'resources', 'app.asar'), 'synthetic application package');
  createManifest(fx.payload);
  fs.writeFileSync(fx.uninstaller, 'synthetic uninstaller');
  for (const name of ['safe-migrate.ps1', 'safe-uninstall.ps1']) fs.copyFileSync(path.join(project, 'scripts', name), path.join(fx.helpers, name));
  t.after(() => {
    const relative = path.relative(outputReal, base);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(base, { recursive: true, force: true });
  });
  return fx;
}
function args(fx, mode, version = '0.7.1') {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', core,
    '-Mode', mode, '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Version', version,
    '-Payload', fx.payload, '-UninstallerPath', fx.uninstaller, '-HelperDirectory', fx.helpers];
}
function run(fx, mode, version = '0.7.1') {
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base };
  delete env.LLMMARKUP_MIGRATION_TEST_PAUSE;
  delete env.LLMMARKUP_INSTALL_TEST_PAUSE;
  delete env.LLMMARKUP_UNINSTALL_TEST_PAUSE;
  return spawnSync(powershell, args(fx, mode, version),
  { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}
function registry(fx, key, name) {
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base };
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'read-synthetic-registry.ps1'), '-Key', key, '-Name', name], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('install and uninstall use only a synthetic registry and preserve unrelated files', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  fs.mkdirSync(fx.root);
  fs.writeFileSync(path.join(fx.root, 'user-document.md'), 'synthetic document');
  const installed = run(fx, 'Install');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const repeated = run(fx, 'Install');
  assert.equal(repeated.status, 0, repeated.stderr || repeated.stdout);
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher');
  assert.equal(fs.readFileSync(path.join(fx.root, 'Uninstall LLMMarkUp.exe'), 'utf8'), 'synthetic uninstaller');
  for (const dir of ['desktop', 'start-menu']) assert.ok(fs.existsSync(path.join(fx.base, dir, 'LLMMarkUp.lnk')));
  assert.equal(registry(fx, 'Software\\Classes\\.md\\OpenWithProgids', 'LLMMarkUp.Markdown').exists, true);
  assert.equal(registry(fx, 'Software\\Classes\\Applications\\LLMMarkUp.exe', 'FriendlyAppName').value, 'LLMMarkUp');
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const ids = fs.readdirSync(versions);
  assert.equal(ids.length, 1);
  const runtime = path.join(versions, ids[0]);
  assert.equal(fs.readFileSync(path.join(runtime, 'resources', 'app.asar'), 'utf8'), 'synthetic application package');
  fs.writeFileSync(path.join(runtime, 'user-note.txt'), 'synthetic runtime note');
  const uninstalled = run(fx, 'Uninstall');
  assert.equal(uninstalled.status, 0, uninstalled.stderr || uninstalled.stdout);
  assert.equal(fs.existsSync(path.join(fx.root, 'LLMMarkUp.exe')), false);
  assert.equal(fs.existsSync(path.join(fx.root, 'Uninstall LLMMarkUp.exe')), false);
  for (const dir of ['desktop', 'start-menu']) assert.equal(fs.existsSync(path.join(fx.base, dir, 'LLMMarkUp.lnk')), false);
  assert.equal(registry(fx, 'Software\\Classes\\.md\\OpenWithProgids', 'LLMMarkUp.Markdown').exists, false);
  assert.equal(fs.existsSync(path.join(runtime, 'resources', 'app.asar')), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  assert.equal(fs.readFileSync(path.join(runtime, 'user-note.txt'), 'utf8'), 'synthetic runtime note');
  const reinstalled = run(fx, 'Install');
  assert.equal(reinstalled.status, 0, reinstalled.stderr || reinstalled.stdout);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  assert.equal(fs.readFileSync(path.join(runtime, 'user-note.txt'), 'utf8'), 'synthetic runtime note');
});

test('installer preserves an existing shortcut and a modified shortcut on uninstall', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  fs.mkdirSync(path.join(fx.base, 'desktop'));
  fs.writeFileSync(path.join(fx.base, 'desktop', 'LLMMarkUp.lnk'), 'synthetic existing shortcut');
  const installed = run(fx, 'Install');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(fs.readFileSync(path.join(fx.base, 'desktop', 'LLMMarkUp.lnk'), 'utf8'), 'synthetic existing shortcut');
  const menu = path.join(fx.base, 'start-menu', 'LLMMarkUp.lnk');
  assert.ok(fs.existsSync(menu));
  fs.writeFileSync(menu, 'synthetic modified shortcut');
  const removed = run(fx, 'Uninstall');
  assert.equal(removed.status, 0, removed.stderr || removed.stdout);
  assert.equal(fs.readFileSync(path.join(fx.base, 'desktop', 'LLMMarkUp.lnk'), 'utf8'), 'synthetic existing shortcut');
  assert.equal(fs.readFileSync(menu, 'utf8'), 'synthetic modified shortcut');
});

test('a newer layout upgrades in place while preserving files added to the old runtime', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  let result = run(fx, 'Install', '0.7.1');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const oldRuntime = path.join(versions, fs.readdirSync(versions)[0]);
  fs.writeFileSync(path.join(oldRuntime, 'user-note.md'), 'synthetic note');
  fs.writeFileSync(path.join(fx.payload, 'LLMMarkUp.exe'), 'synthetic application executable v2');
  fs.writeFileSync(path.join(fx.payload, 'llmmarkup-launcher.exe'), 'synthetic launcher v2');
  fs.writeFileSync(fx.uninstaller, 'synthetic uninstaller v2');
  createManifest(fx.payload);
  result = run(fx, 'Install', '0.7.2');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(registry(fx, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appGuid}`, 'DisplayVersion').value, '0.7.2');
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher v2');
  const downgrade = run(fx, 'Install', '0.7.1');
  assert.notEqual(downgrade.status, 0);
  assert.match(downgrade.stderr, /older installer/i);
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher v2');
  assert.equal(fs.readFileSync(path.join(oldRuntime, 'user-note.md'), 'utf8'), 'synthetic note');
  assert.equal(fs.existsSync(path.join(oldRuntime, 'LLMMarkUp.exe')), false);
  result = run(fx, 'Uninstall', '0.7.2');
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(oldRuntime, 'user-note.md'), 'utf8'), 'synthetic note');
});

test('install refuses a same-name unregistered file without overwriting it', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  fs.mkdirSync(fx.root);
  fs.writeFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'synthetic user file');
  const result = run(fx, 'Install');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unregistered entrypoint/);
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic user file');
});

test('install rejects a missing payload file and preserves a changed installed application', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  const payloadAsar = path.join(fx.payload, 'resources', 'app.asar');
  fs.unlinkSync(payloadAsar);
  const incomplete = run(fx, 'Install');
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /payload is incomplete/i);
  assert.equal(fs.existsSync(path.join(fx.root, 'LLMMarkUp.exe')), false);
  fs.writeFileSync(payloadAsar, 'synthetic application package');
  const installed = run(fx, 'Install');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const runtime = path.join(versions, fs.readdirSync(versions)[0]);
  const installedAsar = path.join(runtime, 'resources', 'app.asar');
  fs.writeFileSync(installedAsar, 'synthetic changed package');
  const repeated = run(fx, 'Install');
  assert.notEqual(repeated.status, 0);
  assert.equal(fs.readFileSync(installedAsar, 'utf8'), 'synthetic changed package');
});

for (const legacy of [false, true]) {
  test(`install migrates and safely uninstalls a synthetic ${legacy ? 'MDPPT Studio' : 'LLMMarkUp'} installation`, { skip: !available || !fs.existsSync(compiler), timeout: 60000 }, async t => {
    const fx = fixture(t);
    fs.mkdirSync(fx.root);
    fs.mkdirSync(path.join(fx.root, 'resources'));
    const syntheticPackage = path.join(fx.base, 'old-package');
    fs.mkdirSync(syntheticPackage);
    fs.writeFileSync(path.join(syntheticPackage, 'package.json'), JSON.stringify({ name: legacy ? 'mdppt-studio' : 'llmmarkup', version: '0.1.0' }));
    await asar.createPackage(syntheticPackage, path.join(fx.root, 'resources', 'app.asar'));
    await new Promise(resolve => setTimeout(resolve, 150));
    const exe = legacy ? 'MDPPT Studio.exe' : 'LLMMarkUp.exe';
    const uninstaller = legacy ? 'Uninstall MDPPT Studio.exe' : 'Uninstall LLMMarkUp.exe';
    const source = path.join(fx.base, 'old.cs');
    const product = legacy ? 'MDPPT Studio' : 'LLMMarkUp';
    fs.writeFileSync(source, `using System.Reflection;\n[assembly: AssemblyProduct("${product}")]\n[assembly: AssemblyVersion("0.1.0.0")]\npublic static class Synthetic { public static void Main() {} }\n`);
    for (const name of [exe, uninstaller]) {
      const built = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(fx.root, name)}`, source], { encoding: 'utf8', windowsHide: true });
      assert.equal(built.status, 0, built.stderr || built.stdout);
    }
    const oldHash = sha(fs.readFileSync(path.join(fx.root, exe)));
    const oldUninstallerHash = sha(fs.readFileSync(path.join(fx.root, uninstaller)));
    fs.writeFileSync(path.join(fx.root, 'user-document.md'), 'synthetic old document');
    const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base };
    const registered = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
      '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Legacy'], { env, encoding: 'utf8', windowsHide: true });
    assert.equal(registered.status, 0, registered.stderr || registered.stdout);
    const installed = run(fx, 'Install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    assert.equal(fs.readFileSync(path.join(fx.root, exe), 'utf8'), 'synthetic launcher');
    assert.equal(fs.readFileSync(path.join(fx.root, uninstaller), 'utf8'), 'synthetic uninstaller');
    const runtime = path.join(fx.root, '.llmmarkup-versions', fs.readdirSync(path.join(fx.root, '.llmmarkup-versions'))[0]);
    assert.equal(sha(zlib.gunzipSync(fs.readFileSync(path.join(runtime, '.legacy-backup', `${exe}.gz`)))), oldHash);
    assert.equal(sha(zlib.gunzipSync(fs.readFileSync(path.join(runtime, '.legacy-backup', `${uninstaller}.gz`)))), oldUninstallerHash);
    const removed = run(fx, 'Uninstall');
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(fs.existsSync(path.join(fx.root, exe)), false);
    assert.equal(fs.existsSync(path.join(fx.root, uninstaller)), false);
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic old document');
    assert.ok(fs.existsSync(path.join(fx.root, 'resources', 'app.asar')));
    assert.ok(fs.existsSync(path.join(runtime, '.legacy-backup', `${uninstaller}.gz`)));
  });
}

async function makeLegacy(fx, ...extra) {
  fs.mkdirSync(fx.root);
  fs.mkdirSync(path.join(fx.root, 'resources'));
  const packageDir = path.join(fx.base, 'old-package');
  fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'llmmarkup', version: '0.1.0' }));
  await asar.createPackage(packageDir, path.join(fx.root, 'resources', 'app.asar'));
  await new Promise(resolve => setTimeout(resolve, 150));
  const source = path.join(fx.base, 'old.cs');
  fs.writeFileSync(source, 'using System.Reflection; [assembly: AssemblyProduct("LLMMarkUp")] [assembly: AssemblyVersion("0.1.0.0")] public static class Synthetic { public static void Main() {} }');
  for (const name of ['LLMMarkUp.exe', 'Uninstall LLMMarkUp.exe']) {
    const result = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(fx.root, name)}`, source], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  fs.writeFileSync(path.join(fx.root, 'user-document.md'), 'synthetic old document');
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base };
  const registered = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
    '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Legacy', ...extra], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
}

test('legacy migration discovers an uninstall-only synthetic registry record', { skip: !available || !fs.existsSync(compiler), timeout: 60000 }, async t => {
  const fx = fixture(t);
  await makeLegacy(fx, '-UninstallOnly');
  const installed = run(fx, 'Install');
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher');
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic old document');
});

test('installer refuses a synthetic machine-wide registration without changing it', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  fs.mkdirSync(fx.root);
  fs.writeFileSync(path.join(fx.root, 'user-document.md'), 'synthetic document');
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base };
  const registered = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
    '-InstallRoot', fx.root, '-AppGuid', appGuid, '-Legacy', '-Machine'], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  const installed = run(fx, 'Install');
  assert.notEqual(installed.status, 0);
  assert.match(installed.stderr, /machine-wide previous installation/);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  assert.equal(fs.existsSync(path.join(fx.root, 'LLMMarkUp.exe')), false);
});

async function terminatePausedInstall(fx, variable, point, sentinel, helperChild, mode = 'Install', version = '0.7.1') {
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base, [variable]: point };
  const child = spawn(powershell, args(fx, mode, version), { env, windowsHide: true, stdio: 'ignore' });
  let verifiedHelperPid = null;
  try {
    const marker = path.join(fx.base, sentinel);
    for (let i = 0; i < 300 && !fs.existsSync(marker); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(marker), 'synthetic installer did not reach its pause point');
    const pausedPid = Number(fs.readFileSync(marker, 'utf8'));
    assert.ok(Number.isSafeInteger(pausedPid) && pausedPid > 0);
    if (helperChild) {
      const relation = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pausedPid}'; if ($p.ParentProcessId -eq ${child.pid}) { exit 0 } else { exit 2 }`], { encoding: 'utf8', windowsHide: true });
      assert.equal(relation.status, 0, 'paused helper is not a child of this synthetic installer');
      verifiedHelperPid = pausedPid;
    } else assert.equal(pausedPid, child.pid);
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
    if (helperChild) {
      process.kill(pausedPid);
      verifiedHelperPid = null;
      for (let i = 0; i < 100; i++) {
        try { process.kill(pausedPid, 0); } catch { break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    if (verifiedHelperPid !== null) { try { process.kill(verifiedHelperPid); } catch {} }
  }
}

for (const point of ['during-journal', 'after-first-delete', 'after-first-swap', 'after-second-delete']) {
  test(`a hard interruption at ${point} is recovered before retrying a legacy migration`, { skip: !available || !fs.existsSync(compiler), timeout: 120000 }, async t => {
    const fx = fixture(t);
    await makeLegacy(fx);
    const oldExeHash = sha(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe')));
    const oldUninstallerHash = sha(fs.readFileSync(path.join(fx.root, 'Uninstall LLMMarkUp.exe')));
    await terminatePausedInstall(fx, 'LLMMARKUP_MIGRATION_TEST_PAUSE', point, 'migration-paused', true);
    assert.ok(fs.existsSync(path.join(fx.root, '.llmmarkup-pending.json')));
    const retried = run(fx, 'Install');
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher');
    assert.equal(fs.readFileSync(path.join(fx.root, 'Uninstall LLMMarkUp.exe'), 'utf8'), 'synthetic uninstaller');
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic old document');
    const runtimes = fs.readdirSync(path.join(fx.root, '.llmmarkup-versions'));
    const backups = runtimes.map(id => path.join(fx.root, '.llmmarkup-versions', id, '.legacy-backup'));
    assert.ok(backups.some(dir => fs.existsSync(path.join(dir, 'LLMMarkUp.exe.gz')) && sha(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'LLMMarkUp.exe.gz')))) === oldExeHash));
    assert.ok(backups.some(dir => fs.existsSync(path.join(dir, 'Uninstall LLMMarkUp.exe.gz')) && sha(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'Uninstall LLMMarkUp.exe.gz')))) === oldUninstallerHash));
  });
}

for (const point of ['after-write-5', 'after-write-22']) {
  test(`a hard interruption at ${point} is recovered before retrying installation`, { skip: !available, timeout: 120000 }, async t => {
    const fx = fixture(t);
    fs.mkdirSync(fx.root);
    fs.writeFileSync(path.join(fx.root, 'user-document.md'), 'synthetic document');
    await terminatePausedInstall(fx, 'LLMMARKUP_INSTALL_TEST_PAUSE', point, 'installation-paused', false);
    const retried = run(fx, 'Install');
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher');
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
  });
}

for (const point of ['during-cleanup', 'after-cleanup', 'after-location-removed', 'after-registry']) {
  test(`a hard interruption at ${point} is recovered before reinstalling`, { skip: !available, timeout: 120000 }, async t => {
    const fx = fixture(t);
    fs.mkdirSync(fx.root);
    fs.writeFileSync(path.join(fx.root, 'user-document.md'), 'synthetic document');
    const installed = run(fx, 'Install');
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const versions = path.join(fx.root, '.llmmarkup-versions');
    const oldRuntime = path.join(versions, fs.readdirSync(versions)[0]);
    fs.writeFileSync(path.join(oldRuntime, 'user-note.md'), 'synthetic runtime note');
    await terminatePausedInstall(fx, 'LLMMARKUP_UNINSTALL_TEST_PAUSE', point, 'uninstall-paused', point === 'during-cleanup', 'Uninstall');
    const retried = run(fx, 'Install');
    assert.equal(retried.status, 0, retried.stderr || retried.stdout);
    assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher');
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic document');
    assert.equal(fs.readFileSync(path.join(oldRuntime, 'user-note.md'), 'utf8'), 'synthetic runtime note');
  });
}

for (const point of ['after-first-delete', 'after-write-5', 'after-write-22']) {
  test(`a new-layout upgrade recovers a hard interruption at ${point}`, { skip: !available, timeout: 120000 }, async t => {
    const fx = fixture(t);
    let result = run(fx, 'Install', '0.7.1');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const oldRuntime = path.join(fx.root, '.llmmarkup-versions', fs.readdirSync(path.join(fx.root, '.llmmarkup-versions'))[0]);
    fs.writeFileSync(path.join(oldRuntime, 'user-note.md'), 'synthetic note');
    fs.writeFileSync(path.join(fx.payload, 'llmmarkup-launcher.exe'), 'synthetic launcher v2');
    fs.writeFileSync(fx.uninstaller, 'synthetic uninstaller v2');
    createManifest(fx.payload);
    const migrationPause = point.startsWith('after-first');
    await terminatePausedInstall(fx, migrationPause ? 'LLMMARKUP_MIGRATION_TEST_PAUSE' : 'LLMMARKUP_INSTALL_TEST_PAUSE', point,
      migrationPause ? 'migration-paused' : 'installation-paused', migrationPause, 'Install', '0.7.2');
    result = run(fx, 'Install', '0.7.2');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic launcher v2');
    assert.equal(fs.readFileSync(path.join(oldRuntime, 'user-note.md'), 'utf8'), 'synthetic note');
    assert.equal(registry(fx, `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${appGuid}`, 'DisplayVersion').value, '0.7.2');
  });
}
