// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const asar = require('@electron/asar');
const { spawn, spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(project, 'outputs');
const helper = path.join(project, 'scripts', 'safe-migrate.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const available = process.platform === 'win32' && fs.existsSync(powershell) && fs.existsSync(compiler);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, legacy = false) {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relative = path.relative(project, outputReal);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const base = fs.mkdtempSync(path.join(outputReal, 'safe-migration-test-'));
  const root = path.join(base, 'legacy-root');
  const installId = crypto.randomUUID();
  const runtime = path.join(root, '.llmmarkup-versions', installId);
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(path.join(root, 'resources'));
  const packageDir = path.join(base, 'synthetic-package');
  fs.mkdirSync(packageDir);
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: legacy ? 'mdppt-studio' : 'llmmarkup', version: '0.1.0' }));
  await asar.createPackage(packageDir, path.join(root, 'resources', 'app.asar'));
  await delay(150);
  const exe = legacy ? 'MDPPT Studio.exe' : 'LLMMarkUp.exe';
  const uninstaller = legacy ? 'Uninstall MDPPT Studio.exe' : 'Uninstall LLMMarkUp.exe';
  for (const name of [exe, uninstaller]) {
    const script = path.join(base, `${name}.cs`);
    const product = legacy ? 'MDPPT Studio' : 'LLMMarkUp';
    fs.writeFileSync(script, `using System.Reflection;\nusing System.IO;\nusing System.Threading;\n[assembly: AssemblyTitle("${product}")]\n[assembly: AssemblyProduct("${product}")]\n[assembly: AssemblyVersion("0.1.0.0")]\npublic class Synthetic { public static void Main(string[] args) { if (args.Length > 0) { File.WriteAllText(args[0], "ready"); Thread.Sleep(60000); } } }\n`);
    const built = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${path.join(root, name)}`, script], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    assert.equal(built.status, 0, built.stderr || built.stdout);
  }
  const originalExeHash = sha(fs.readFileSync(path.join(root, exe)));
  const originalUninstallerHash = sha(fs.readFileSync(path.join(root, uninstaller)));
  fs.writeFileSync(path.join(root, 'user-document.md'), 'synthetic user document');
  const launcher = path.join(runtime, 'synthetic-launcher.exe');
  const safeUninstaller = path.join(runtime, 'synthetic-safe-uninstaller.exe');
  fs.writeFileSync(launcher, 'synthetic safe launcher');
  fs.writeFileSync(safeUninstaller, 'synthetic safe uninstaller');
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: [
    { path: 'synthetic-launcher.exe', sha256: sha('synthetic safe launcher') },
    { path: 'synthetic-safe-uninstaller.exe', sha256: sha('synthetic safe uninstaller') },
  ] }));
  const manifestPath = path.join(base, 'manifest.json');
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(path.join(runtime, '.llmmarkup-owned.json'), JSON.stringify({ schema: 1, product: 'llmmarkup', installId, manifestSha256: sha(manifest) }));
  t.after(async () => {
    if (process.env.LLMMARKUP_KEEP_TEST_OUTPUT === '1') { console.log(`Synthetic fixture: ${base}`); return; }
    const rel = path.relative(outputReal, base);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    for (let attempt = 0; attempt < 20; attempt++) {
      try { fs.rmSync(base, { recursive: true, force: true }); return; }
      catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 19) throw error;
        await delay(250);
      }
    }
  });
  return { base, root, runtime, installId, exe, uninstaller, launcher, safeUninstaller, manifestPath, originalExeHash, originalUninstallerHash };
}

function migrate(fx, mode, extra = {}) {
  const env = { ...process.env, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base, LLMMARKUP_TEST_DATA: fx.base, ...extra };
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-Mode', mode, '-InstallRoot', fx.root, '-RuntimeRoot', fx.runtime, '-InstallId', fx.installId,
    '-LegacyExecutable', fx.exe, '-LegacyUninstaller', fx.uninstaller,
    '-LauncherPath', fx.launcher, '-SafeUninstallerPath', fx.safeUninstaller, '-ManifestPath', fx.manifestPath],
  { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

for (const legacy of [false, true]) {
  test(`migration preserves files and replaces only verified ${legacy ? 'legacy' : 'current'} entrypoints`, { skip: !available, timeout: 60000 }, async t => {
    const fx = await fixture(t, legacy);
    const result = migrate(fx, 'Begin');
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(fs.readFileSync(path.join(fx.root, fx.exe), 'utf8'), 'synthetic safe launcher');
    assert.equal(fs.readFileSync(path.join(fx.root, fx.uninstaller), 'utf8'), 'synthetic safe uninstaller');
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic user document');
    for (const [name, expected] of [[fx.exe, fx.originalExeHash], [fx.uninstaller, fx.originalUninstallerHash]]) {
      const backup = fs.readFileSync(path.join(fx.runtime, '.legacy-backup', `${name}.gz`));
      assert.deepEqual([...backup.subarray(0, 2)], [0x1f, 0x8b]);
      assert.equal(sha(zlib.gunzipSync(backup)), expected);
    }
    assert.ok(fs.existsSync(path.join(fx.root, 'resources', 'app.asar')));
    const rollback = migrate(fx, 'Rollback');
    assert.equal(rollback.status, 0, rollback.stderr || rollback.stdout);
    assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.exe))), fx.originalExeHash);
    assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.uninstaller))), fx.originalUninstallerHash);
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic user document');
  });
}

for (const point of ['before-first', 'after-first-backup', 'after-first-delete', 'after-first-swap', 'after-second-backup', 'after-second-delete', 'after-second-swap']) {
  test(`migration rolls back a synthetic interruption at ${point}`, { skip: !available, timeout: 60000 }, async t => {
    const fx = await fixture(t);
    const result = migrate(fx, 'Begin', { LLMMARKUP_MIGRATION_TEST_FAIL: point });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Synthetic interruption/);
    assert.doesNotMatch(result.stderr, /rollback stopped/i);
    assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.exe))), fx.originalExeHash);
    assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.uninstaller))), fx.originalUninstallerHash);
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic user document');
  });
}

test('migration refuses collisions and unverified ownership before changing old entrypoints', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  fs.mkdirSync(path.join(fx.runtime, '.legacy-backup'));
  let result = migrate(fx, 'Begin');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /record or backup already exists/);
  assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.exe))), fx.originalExeHash);
  fs.rmdirSync(path.join(fx.runtime, '.legacy-backup'));
  fs.writeFileSync(path.join(fx.runtime, '.llmmarkup-owned.json'), '{}');
  result = migrate(fx, 'Begin');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ownership cannot be verified/);
  assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.uninstaller))), fx.originalUninstallerHash);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic user document');
});

test('migration preserves old entrypoints when a synthetic old uninstaller is already running', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  const copiedUninstaller = path.join(fx.base, 'old-uninstaller.exe');
  fs.copyFileSync(path.join(fx.root, fx.uninstaller), copiedUninstaller);
  const ready = path.join(fx.base, 'uninstaller-ready');
  const child = spawn(copiedUninstaller, [ready], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await delay(100);
    assert.ok(fs.existsSync(ready));
    const result = migrate(fx, 'Begin');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /uninstaller is running/i);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.exe))), fx.originalExeHash);
    assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.uninstaller))), fx.originalUninstallerHash);
    assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic user document');
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});

test('migration refuses an unknown same-name executable and ambiguous old entrypoints', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  fs.writeFileSync(path.join(fx.root, 'MDPPT Studio.exe'), 'synthetic unrelated program');
  let result = migrate(fx, 'Begin');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Multiple legacy entrypoints/);
  assert.equal(fs.readFileSync(path.join(fx.root, 'MDPPT Studio.exe'), 'utf8'), 'synthetic unrelated program');
  fs.unlinkSync(path.join(fx.root, 'MDPPT Studio.exe'));
  fs.writeFileSync(path.join(fx.root, fx.exe), 'synthetic unrelated executable');
  result = migrate(fx, 'Begin');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not match the recognized product/);
  assert.equal(fs.readFileSync(path.join(fx.root, fx.exe), 'utf8'), 'synthetic unrelated executable');
  assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.uninstaller))), fx.originalUninstallerHash);
});

test('rollback refuses a changed replacement and preserves both legacy backups', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  const begin = migrate(fx, 'Begin');
  assert.equal(begin.status, 0, begin.stderr || begin.stdout);
  fs.writeFileSync(path.join(fx.root, fx.exe), 'synthetic user replacement');
  const rollback = migrate(fx, 'Rollback');
  assert.notEqual(rollback.status, 0);
  assert.match(rollback.stderr, /entrypoint was changed/i);
  assert.equal(fs.readFileSync(path.join(fx.root, fx.exe), 'utf8'), 'synthetic user replacement');
  assert.equal(fs.readFileSync(path.join(fx.root, fx.uninstaller), 'utf8'), 'synthetic safe uninstaller');
  assert.equal(sha(zlib.gunzipSync(fs.readFileSync(path.join(fx.runtime, '.legacy-backup', `${fx.exe}.gz`)))), fx.originalExeHash);
  assert.equal(sha(zlib.gunzipSync(fs.readFileSync(path.join(fx.runtime, '.legacy-backup', `${fx.uninstaller}.gz`)))), fx.originalUninstallerHash);
});

test('migration refuses a junction in the synthetic legacy installation', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  const original = path.join(fx.root, 'resources');
  const moved = path.join(fx.base, 'original-resources');
  for (const target of [original, moved]) {
    const relative = path.relative(fx.base, path.resolve(target));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  fs.renameSync(original, moved);
  fs.symlinkSync(moved, original, 'junction');
  const result = migrate(fx, 'Begin');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reparse point/i);
  assert.ok(fs.existsSync(path.join(moved, 'app.asar')));
  assert.equal(sha(fs.readFileSync(path.join(fx.root, fx.exe))), fx.originalExeHash);
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), 'synthetic user document');
});
