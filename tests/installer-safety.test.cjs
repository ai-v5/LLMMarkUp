// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const outputs = path.join(project, 'outputs');
const cache = process.env.ELECTRON_BUILDER_CACHE || path.join(outputs, 'cache', 'electron-builder');
function childDirectory(parent, prefix) {
  if (!fs.existsSync(parent)) return null;
  const entry = fs.readdirSync(parent, { withFileTypes: true }).find(item => item.isDirectory() && item.name.startsWith(prefix));
  return entry ? path.join(parent, entry.name) : null;
}
const nsis = childDirectory(path.join(cache, 'nsis-3.0.4.1'), 'nsis-');
const resources = childDirectory(path.join(cache, 'nsis-resources-3.4.1'), 'nsis-resources-');
const compiler = nsis && path.join(nsis, 'Bin', 'makensis.exe');
const plugins = resources && path.join(resources, 'plugins', 'x86-unicode');
const available = process.platform === 'win32' && compiler && plugins && fs.existsSync(compiler) && fs.existsSync(plugins);
const quote = value => String(value).replaceAll('$', '$$').replaceAll('"', '$\\"');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function withinProject(target) {
  const relative = path.relative(project, path.resolve(target));
  return !!relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}
function command(file, args, timeout = 30000) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout, windowsHide: true });
  if (result.error) throw result.error;
  return result;
}
async function waitForFile(file, child) {
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) {
    if (child.exitCode !== null) throw new Error(`Synthetic process exited: ${child.exitCode}`);
    await delay(100);
  }
  assert.ok(fs.existsSync(file), 'synthetic process did not become ready');
}
async function stopSynthetic(child) {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}

test('installer and uninstaller refuse running synthetic processes without terminating them',
  { skip: available ? false : 'Windows NSIS build tools unavailable; run the Windows distribution build first', timeout: 90000 }, async t => {
    fs.mkdirSync(outputs, { recursive: true });
    assert.ok(withinProject(fs.realpathSync(outputs)), 'test output resolves outside the project');
    const root = fs.mkdtempSync(path.join(outputs, 'installer-safety-'));
    assert.ok(withinProject(root));
    t.after(async () => {
      assert.ok(withinProject(root));
      for (let attempt = 0; attempt < 20; attempt++) {
        try { fs.rmSync(root, { recursive: true, force: true }); return; }
        catch (error) {
          if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error;
          await delay(250);
        }
      }
    });
    const token = crypto.randomBytes(10).toString('hex');
    const currentName = `SyntheticCurrent_${token}.exe`;
    const legacyName = `SyntheticLegacy_${token}.exe`;
    const currentExe = path.join(root, currentName);
    const legacyExe = path.join(root, legacyName);
    fs.copyFileSync(process.execPath, currentExe);
    fs.copyFileSync(process.execPath, legacyExe);
    const dummy = path.join(root, 'dummy.cjs');
    fs.writeFileSync(dummy, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
    const marker = path.join(root, 'section-ran');
    const setup = path.join(root, 'guard-test.exe');
    const uninstaller = path.join(root, 'guard-uninstall.exe');
    const includeDir = path.join(project, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include');
    const source = `Unicode true\nRequestExecutionLevel user\nSilentInstall silent\n` +
      `!addincludedir "${quote(includeDir)}"\n!addplugindir /x86-unicode "${quote(plugins)}"\n` +
      `!include "LogicLib.nsh"\n!include "nsProcess.nsh"\n!include "${quote(path.join(project, 'installer.nsh'))}"\n` +
      `Name "Synthetic installer guard"\nOutFile "${quote(setup)}"\n` +
      `Section\n  !insertmacro GuardRunningApplications "${currentName}" "${legacyName}"\n` +
      `  FileOpen $0 "${quote(marker)}" w\n  FileWrite $0 "ran"\n  FileClose $0\n` +
      `  WriteUninstaller "${quote(uninstaller)}"\nSectionEnd\n` +
      `Function un.onInit\n  !insertmacro GuardRunningApplications "${currentName}" "${legacyName}"\nFunctionEnd\n` +
      `Section "un.install"\n  FileOpen $0 "${quote(marker)}" w\n  FileWrite $0 "uninstalled"\n  FileClose $0\nSectionEnd\n`;
    const nsi = path.join(root, 'guard-test.nsi');
    fs.writeFileSync(nsi, source);
    const built = command(compiler, ['/V2', nsi]);
    assert.equal(built.status, 0, built.stderr || built.stdout);
    const initial = command(setup, ['/S']);
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    assert.ok(fs.existsSync(marker));
    assert.ok(fs.existsSync(uninstaller));
    fs.unlinkSync(marker);

    for (const executable of [currentExe, legacyExe]) {
      const ready = path.join(root, `${path.basename(executable)}.ready`);
      const child = spawn(executable, [dummy, ready], { windowsHide: true, stdio: 'ignore' });
      try {
        await waitForFile(ready, child);
        const setupResult = command(setup, ['/S']);
        assert.notEqual(setupResult.status, 0, 'setup should refuse while the application is running');
        assert.equal(child.exitCode, null, 'setup terminated the synthetic process');
        assert.equal(child.signalCode, null, 'setup terminated the synthetic process');
        assert.equal(fs.existsSync(marker), false, 'setup continued after detecting a running process');
        const uninstallResult = command(uninstaller, ['/S', `_?=${root}`]);
        assert.notEqual(uninstallResult.status, 0, 'uninstaller should refuse while the application is running');
        assert.equal(child.exitCode, null, 'uninstaller terminated the synthetic process');
        assert.equal(child.signalCode, null, 'uninstaller terminated the synthetic process');
        assert.equal(fs.existsSync(marker), false, 'uninstaller continued after detecting a running process');
      } finally {
        await stopSynthetic(child);
      }
    }
    const final = command(uninstaller, ['/S', `_?=${root}`]);
    assert.equal(final.status, 0, final.stderr || final.stdout);
    assert.equal(fs.readFileSync(marker, 'utf8'), 'uninstalled');
  });
