// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('Local Windows installation is available only on Windows.');
if (!process.env.npm_execpath) throw new Error('Run this command through npm.');
const project = path.resolve(__dirname, '..');
const outputs = path.join(project, 'outputs');
fs.mkdirSync(outputs, { recursive: true });
const outputName = `local-build-${crypto.randomUUID().replaceAll('-', '')}`;
const outputDirectory = path.join(outputs, outputName);
fs.mkdirSync(outputDirectory);
function run(file, args) {
  const result = spawnSync(file, args, { cwd: project, env: process.env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(process.execPath, [process.env.npm_execpath, 'run', 'dist', '--', `--config.directories.output=outputs/${outputName}`]);
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
if (process.env.LLMMARKUP_TEST_DATA) {
  const testRoot = fs.realpathSync(process.env.LLMMARKUP_TEST_DATA);
  const relative = path.relative(fs.realpathSync(outputs), testRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) ||
      path.resolve(process.env.TEMP || '') !== path.join(testRoot, 'temp') ||
      path.resolve(process.env.TMP || '') !== path.join(testRoot, 'temp')) throw new Error('The local delivery test is not isolated.');
  delete process.env.LLMMARKUP_TEST_LEGACY_SESSION;
  delete process.env.LLMMARKUP_LOCAL_SMOKE_PROFILE;
  process.env.LLMMARKUP_LOCAL_TEST_OUTPUT = outputDirectory;
  run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'tests', 'run-local-delivery.ps1'), '-InstallRoot', path.join(testRoot, 'install')]);
} else {
  run(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(project, 'install-local.ps1'), '-BuildOutputDirectory', outputDirectory, '-Launch']);
}
console.log(`Local build retained in outputs/${outputName}`);
