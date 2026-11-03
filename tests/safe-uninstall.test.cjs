// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(project, 'outputs');
const helper = path.join(project, 'scripts', 'safe-uninstall.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const available = process.platform === 'win32' && fs.existsSync(powershell);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relative = path.relative(project, outputReal);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const base = fs.mkdtempSync(path.join(outputReal, 'safe-uninstall-test-'));
  const installId = crypto.randomUUID();
  const root = path.join(base, 'install', '.llmmarkup-versions', installId);
  fs.mkdirSync(root, { recursive: true });
  t.after(async () => {
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
  return { base, root, installId };
}

function writeFixture(fx, files) {
  const entries = [];
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(fx.root, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    entries.push({ path: name, sha256: sha(Buffer.from(content)) });
  }
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: entries }));
  const manifestPath = path.join(fx.base, 'manifest.json');
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(path.join(fx.root, '.llmmarkup-owned.json'), JSON.stringify({
    schema: 1, product: 'llmmarkup', installId: fx.installId, manifestSha256: sha(manifest),
  }));
  return manifestPath;
}

function cleanup(fx, manifest, extra = []) {
  const env = { ...process.env, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base, LLMMARKUP_TEST_DATA: fx.base };
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper,
    '-InstallRoot', fx.root, '-ManifestPath', manifest, '-InstallId', fx.installId, ...extra],
  { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
}

test('uninstall removes verified root entrypoints and preserves a modified one', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  const sourceManifest = writeFixture(fx, { 'LLMMarkUp.exe': 'synthetic app', 'llmmarkup-launcher.exe': 'launcher', 'llmmarkup-uninstall.exe': 'uninstaller' });
  const manifest = path.join(fx.root, '.llmmarkup-manifest.json');
  fs.copyFileSync(sourceManifest, manifest);
  const install = path.dirname(path.dirname(fx.root));
  fs.writeFileSync(path.join(install, 'LLMMarkUp.exe'), 'launcher');
  fs.writeFileSync(path.join(install, 'Uninstall LLMMarkUp.exe'), 'user replacement');
  fs.writeFileSync(path.join(install, 'document.md'), 'synthetic user document');
  const result = cleanup(fx, manifest, ['-EntrypointName', 'LLMMarkUp.exe', '-UninstallerName', 'Uninstall LLMMarkUp.exe']);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(install, 'LLMMarkUp.exe')), false);
  assert.equal(fs.readFileSync(path.join(install, 'Uninstall LLMMarkUp.exe'), 'utf8'), 'user replacement');
  assert.equal(fs.readFileSync(path.join(install, 'document.md'), 'utf8'), 'synthetic user document');
  assert.equal(fs.existsSync(manifest), false);
});

test('uninstall removes only verified owned files and preserves user and modified files', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  const manifest = writeFixture(fx, { 'LLMMarkUp.exe': 'synthetic exe', 'resources/app.asar': 'synthetic application', 'resources/NOTICE': 'original notice' });
  fs.writeFileSync(path.join(fx.root, 'resources', 'NOTICE'), 'user modified notice');
  fs.writeFileSync(path.join(fx.root, 'user-document.md'), '# synthetic user document\n');
  const result = cleanup(fx, manifest);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(path.join(fx.root, 'LLMMarkUp.exe')), false);
  assert.equal(fs.existsSync(path.join(fx.root, 'resources', 'app.asar')), false);
  assert.equal(fs.readFileSync(path.join(fx.root, 'resources', 'NOTICE'), 'utf8'), 'user modified notice');
  assert.equal(fs.readFileSync(path.join(fx.root, 'user-document.md'), 'utf8'), '# synthetic user document\n');
});

test('uninstall rejects modified executable and malformed ownership without deleting files', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  const manifest = writeFixture(fx, { 'LLMMarkUp.exe': 'original exe', 'resources/app.asar': 'synthetic application' });
  fs.writeFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'user replacement');
  let result = cleanup(fx, manifest);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'user replacement');
  assert.equal(fs.readFileSync(path.join(fx.root, 'resources', 'app.asar'), 'utf8'), 'synthetic application');
  fs.writeFileSync(path.join(fx.root, '.llmmarkup-owned.json'), '{}');
  result = cleanup(fx, manifest);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(fx.root, 'resources', 'app.asar'), 'utf8'), 'synthetic application');
});

test('uninstall rejects path traversal and junctions without touching external synthetic files', { skip: !available, timeout: 60000 }, t => {
  const fx = fixture(t);
  const manifest = writeFixture(fx, { 'LLMMarkUp.exe': 'synthetic exe' });
  const sentinel = path.join(fx.base, 'outside.md');
  fs.writeFileSync(sentinel, 'synthetic outside data');
  const malformed = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: [
    { path: 'LLMMarkUp.exe', sha256: sha('synthetic exe') }, { path: '../outside.md', sha256: sha('synthetic outside data') },
  ] }));
  fs.writeFileSync(manifest, malformed);
  fs.writeFileSync(path.join(fx.root, '.llmmarkup-owned.json'), JSON.stringify({ schema: 1, product: 'llmmarkup', installId: fx.installId, manifestSha256: sha(malformed) }));
  let result = cleanup(fx, manifest);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'synthetic outside data');
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic exe');

  const external = path.join(fx.base, 'external-directory');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'app.asar'), 'external synthetic data');
  fs.symlinkSync(external, path.join(fx.root, 'resources'), 'junction');
  const linked = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: [
    { path: 'LLMMarkUp.exe', sha256: sha('synthetic exe') }, { path: 'resources/app.asar', sha256: sha('external synthetic data') },
  ] }));
  fs.writeFileSync(manifest, linked);
  fs.writeFileSync(path.join(fx.root, '.llmmarkup-owned.json'), JSON.stringify({ schema: 1, product: 'llmmarkup', installId: fx.installId, manifestSha256: sha(linked) }));
  result = cleanup(fx, manifest);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(external, 'app.asar'), 'utf8'), 'external synthetic data');
  assert.equal(fs.readFileSync(path.join(fx.root, 'LLMMarkUp.exe'), 'utf8'), 'synthetic exe');
});

test('uninstall refuses a running synthetic application and leaves it alive', { skip: !available, timeout: 60000 }, async t => {
  const fx = fixture(t);
  const executable = path.join(fx.root, 'LLMMarkUp.exe');
  fs.copyFileSync(process.execPath, executable);
  const exeBytes = fs.readFileSync(executable);
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: [{ path: 'LLMMarkUp.exe', sha256: sha(exeBytes) }] }));
  const manifestPath = path.join(fx.base, 'manifest.json');
  fs.writeFileSync(manifestPath, manifest);
  fs.writeFileSync(path.join(fx.root, '.llmmarkup-owned.json'), JSON.stringify({ schema: 1, product: 'llmmarkup', installId: fx.installId, manifestSha256: sha(manifest) }));
  const dummy = path.join(fx.base, 'dummy.cjs');
  const ready = path.join(fx.base, 'ready');
  fs.writeFileSync(dummy, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);\n");
  const child = spawn(executable, [dummy, ready], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await delay(100);
    assert.ok(fs.existsSync(ready));
    const result = cleanup(fx, manifestPath);
    assert.notEqual(result.status, 0, 'uninstall must refuse a running executable');
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    assert.ok(fs.existsSync(executable));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill();
      await exited;
    }
  }
});
