// SPDX-License-Identifier: AGPL-3.0-only
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const project = fs.realpathSync(path.resolve(__dirname, '..'));
const output = path.join(project, 'outputs');
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const compiler = path.join(framework, 'csc.exe');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const available = process.platform === 'win32' && fs.existsSync(compiler) && fs.existsSync(powershell);
const appGuid = require('../package.json').build.nsis.guid;
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function command(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30000, ...options });
  if (result.error) throw result.error;
  return result;
}
function compile(target, sources) {
  const result = command(compiler, ['/nologo', '/codepage:65001', '/target:winexe', `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`, `/out:${target}`, ...sources]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
async function fixture(t) {
  fs.mkdirSync(output, { recursive: true });
  const outputReal = fs.realpathSync(output);
  const relation = path.relative(project, outputReal);
  assert.ok(relation && !relation.startsWith('..') && !path.isAbsolute(relation));
  const base = fs.mkdtempSync(path.join(outputReal, 'launcher-test-'));
  const root = path.join(base, 'install');
  const installId = crypto.randomUUID();
  const runtime = path.join(root, '.llmmarkup-versions', installId);
  fs.mkdirSync(runtime, { recursive: true });
  const buildInfo = path.join(base, 'build-info.cs');
  fs.writeFileSync(buildInfo, `using System.Reflection;\n[assembly: AssemblyProduct("LLMMarkUp")]\n[assembly: AssemblyVersion("0.7.1.0")]\ninternal static class LauncherBuildInfo { public const string AppGuid = "${appGuid}"; }\n`);
  const launcher = path.join(root, 'LLMMarkUp.exe');
  compile(launcher, [path.join(project, 'scripts', 'launcher.cs'), buildInfo]);
  const targetSource = path.join(base, 'target.cs');
  fs.writeFileSync(targetSource, 'using System; using System.IO; public static class Synthetic { public static void Main(string[] args) { string p=Environment.GetEnvironmentVariable("SYNTHETIC_RECEIPT"); string[] lines=new string[args.Length+1]; lines[0]=Environment.CurrentDirectory; Array.Copy(args,0,lines,1,args.Length); File.WriteAllLines(p,lines,new System.Text.UTF8Encoding(false)); } }');
  const target = path.join(runtime, 'LLMMarkUp.exe');
  compile(target, [targetSource]);
  const workdir = path.join(base, 'synthetic workdir');
  fs.mkdirSync(workdir);
  const fx = { base, root, runtime, installId, launcher, target, workdir, receipt: path.join(base, 'child-receipt.txt') };
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
  await register(fx);
  return fx;
}
async function register(fx) {
  const manifest = Buffer.from(JSON.stringify({ schema: 1, product: 'llmmarkup', files: [{ path: 'LLMMarkUp.exe', sha256: sha(fs.readFileSync(fx.target)) }] }));
  const manifestHash = sha(manifest);
  fs.writeFileSync(path.join(fx.runtime, '.llmmarkup-manifest.json'), manifest);
  fs.writeFileSync(path.join(fx.runtime, '.llmmarkup-owned.json'), JSON.stringify({ schema: 1, product: 'llmmarkup', installId: fx.installId, manifestSha256: manifestHash }));
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base };
  const result = command(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'create-synthetic-registry.ps1'),
    '-InstallRoot', fx.root, '-InstallId', fx.installId, '-ManifestSha256', manifestHash, '-AppGuid', appGuid], { env });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
function launch(fx, args = []) {
  const env = { ...process.env, LLMMARKUP_TEST_DATA: fx.base, TEMP: fx.base, TMP: fx.base, TMPDIR: fx.base, SYNTHETIC_RECEIPT: fx.receipt };
  return command(fx.launcher, args, { env, cwd: fx.workdir, timeout: 10000 });
}

test('launcher preserves arguments and working directory through a synthetic registry', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  const args = ['相对 目录\\文档.md', 'quoted"argument', 'C:\\folder with spaces\\', ''];
  const result = launch(fx, args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (let i = 0; i < 100 && !fs.existsSync(fx.receipt); i++) await delay(100);
  assert.ok(fs.existsSync(fx.receipt), 'synthetic child did not start');
  const lines = fs.readFileSync(fx.receipt, 'utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  assert.equal(lines.shift().toLowerCase(), fx.workdir.toLowerCase());
  assert.deepEqual(lines, args);
  await delay(150);
});

test('launcher rejects changed executable and self-copy without spawning a child', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  fs.appendFileSync(fx.target, 'changed');
  let result = launch(fx);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(fx.receipt), false);
  fs.copyFileSync(fx.launcher, fx.target);
  await register(fx);
  result = launch(fx);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(fx.receipt), false);
});

test('launcher rejects a junction in the synthetic runtime path', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  const versions = path.join(fx.root, '.llmmarkup-versions');
  const moved = path.join(fx.base, 'synthetic-versions');
  for (const target of [versions, moved]) {
    const rel = path.relative(fx.base, path.resolve(target));
    assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }
  fs.renameSync(versions, moved);
  fs.symlinkSync(moved, versions, 'junction');
  const result = launch(fx);
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(fx.receipt), false);
  assert.ok(fs.existsSync(path.join(moved, fx.installId, 'LLMMarkUp.exe')));
});

test('launcher refuses while a synthetic legacy application is running', { skip: !available, timeout: 60000 }, async t => {
  const fx = await fixture(t);
  const source = path.join(fx.base, 'legacy.cs');
  const legacy = path.join(fx.root, 'MDPPT Studio.exe');
  const ready = path.join(fx.base, 'legacy-ready');
  fs.writeFileSync(source, 'using System.IO; using System.Threading; public static class Synthetic { public static void Main(string[] args) { File.WriteAllText(args[0], "ready"); Thread.Sleep(60000); } }');
  compile(legacy, [source]);
  const child = spawn(legacy, [ready], { windowsHide: true, stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await delay(100);
    assert.ok(fs.existsSync(ready));
    const result = launch(fx);
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(fx.receipt), false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
  }
});
