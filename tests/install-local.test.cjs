// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(project, 'outputs');
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const available = process.platform === 'win32' && fs.existsSync(shell);
const guid = require('../package.json').build.nsis.guid;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function removeFixture(outputReal, base) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const resolved = fs.realpathSync(base);
      const relative = path.relative(outputReal, resolved);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      fs.rmSync(base, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 39) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

test('local installer resolves the registered synthetic runtime and rejects changed ownership', { skip: !available, timeout: 60000 }, t => {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relative = path.relative(project, outputReal);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const base = fs.mkdtempSync(path.join(outputReal, 'install-local-test-'));
  t.after(() => removeFixture(outputReal, base));
  const root = path.join(base, 'install');
  const id = crypto.randomUUID();
  const runtime = path.join(root, '.llmmarkup-versions', id);
  fs.mkdirSync(runtime, { recursive: true });
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: [] }));
  const hash = sha(manifest);
  fs.writeFileSync(path.join(runtime, '.llmmarkup-manifest.json'), manifest);
  fs.writeFileSync(path.join(runtime, '.llmmarkup-owned.json'), JSON.stringify({ schema: 1, product: 'llmmarkup', installId: id, manifestSha256: hash }));
  const env = { ...process.env, LLMMARKUP_TEST_DATA: base, TEMP: base, TMP: base, TMPDIR: base };
  const registered = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
    '-InstallRoot', root, '-InstallId', id, '-ManifestSha256', hash, '-EntryName', 'MDPPT Studio.exe', '-AppGuid', guid], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(registered.status, 0, registered.stderr || registered.stdout);
  const inspect = () => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'inspect-local-install.ps1'), '-InstallRoot', root], { env, encoding: 'utf8', windowsHide: true });
  let result = inspect();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const resolved = JSON.parse(result.stdout);
  assert.equal(resolved.Runtime.toLowerCase(), runtime.toLowerCase());
  assert.equal(resolved.Entry, 'MDPPT Studio.exe');
  fs.writeFileSync(path.join(runtime, '.llmmarkup-owned.json'), '{}');
  result = inspect();
  assert.notEqual(result.status, 0);
});

test('local delivery does not report success when a synthetic launcher fails', { skip: !available || !fs.existsSync(compiler), timeout: 60000 }, t => {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relative = path.relative(project, outputReal);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const base = fs.mkdtempSync(path.join(outputReal, 'local-launch-test-'));
  t.after(() => removeFixture(outputReal, base));
  const source = path.join(base, 'launcher.cs');
  const executable = path.join(base, 'launcher.exe');
  const runtime = path.join(base, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(source, 'public static class Synthetic { public static int Main() { return 7; } }');
  const built = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${executable}`, source], { encoding: 'utf8', windowsHide: true });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const env = { ...process.env, LLMMARKUP_TEST_DATA: base, TEMP: base, TMP: base, TMPDIR: base };
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'verify-local-launch.ps1'),
    '-EntryPath', executable, '-Runtime', runtime], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reopening failed \(launcher exit code 7\)/i);
});

test('local delivery never closes an unverified synthetic same-name process', { skip: !available, timeout: 60000 }, async t => {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relative = path.relative(project, outputReal);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const base = fs.mkdtempSync(path.join(outputReal, 'local-close-test-'));
  t.after(() => removeFixture(outputReal, base));
  const executable = path.join(base, 'LLMMarkUp.exe');
  const script = path.join(base, 'dummy.cjs');
  const ready = path.join(base, 'ready');
  fs.copyFileSync(process.execPath, executable);
  fs.writeFileSync(script, "require('node:fs').writeFileSync(process.argv[2], 'ready'); setInterval(() => {}, 1000);\n");
  const child = spawn(executable, [script, ready], { windowsHide: true, stdio: 'ignore' });
  let other;
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(ready));
    const env = { ...process.env, LLMMARKUP_TEST_DATA: base, TEMP: base, TMP: base, TMPDIR: base };
    for (const extra of [[], ['-Legacy'], ['-WrongStart']]) {
      const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'verify-local-close.ps1'),
        '-ProcessId', String(child.pid), '-Executable', executable, ...extra], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, extra.includes('-WrongStart') ? /process identity/i : extra.includes('-Legacy') ? /running legacy application/i : /application package/i);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    }
    const otherExecutable = path.join(base, 'MDPPT Studio.exe');
    const otherReady = path.join(base, 'other-ready');
    fs.copyFileSync(process.execPath, otherExecutable);
    other = spawn(otherExecutable, [script, otherReady], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(otherReady); i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(fs.existsSync(otherReady));
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'verify-local-close.ps1'),
      '-ProcessId', String(other.pid), '-Executable', otherExecutable, '-WrongExe'], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /process identity/i);
    assert.equal(other.exitCode, null);
    assert.equal(other.signalCode, null);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    for (const process of [other, child]) {
      if (process && process.exitCode === null && process.signalCode === null) {
        const exited = new Promise(resolve => process.once('exit', resolve));
        process.kill();
        await exited;
      }
    }
  }
});
