// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(project, 'outputs');
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const available = process.platform === 'win32' && fs.existsSync(shell);
const guid = require('../package.json').build.nsis.guid;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('local installer resolves the registered synthetic runtime and rejects changed ownership', { skip: !available, timeout: 60000 }, t => {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relative = path.relative(project, outputReal);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  const base = fs.mkdtempSync(path.join(outputReal, 'install-local-test-'));
  t.after(() => {
    const rel = path.relative(outputReal, base);
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
    fs.rmSync(base, { recursive: true, force: true });
  });
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
