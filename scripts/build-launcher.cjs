// SPDX-License-Identifier: AGPL-3.0-only
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

if (process.platform !== 'win32') throw new Error('The Windows launcher must be built on Windows.');
const project = path.resolve(__dirname, '..');
const metadata = require('../package.json');
if (!/^\d+\.\d+\.\d+$/.test(metadata.version) || !/^[0-9a-f-]{36}$/i.test(metadata.build.nsis.guid)) {
  throw new Error('Invalid launcher version or application identity.');
}
const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const output = path.join(project, 'outputs', 'launcher-build');
fs.mkdirSync(output, { recursive: true });
const buildInfo = path.join(output, 'build-info.cs');
fs.writeFileSync(buildInfo, `using System.Reflection;\n[assembly: AssemblyProduct("LLMMarkUp")]\n[assembly: AssemblyVersion("${metadata.version}.0")]\ninternal static class LauncherBuildInfo { public const string AppGuid = "${metadata.build.nsis.guid}"; }\n`);
const result = spawnSync(path.join(framework, 'csc.exe'), [
  '/nologo', '/codepage:65001', '/target:winexe', `/reference:${path.join(framework, 'System.Web.Extensions.dll')}`,
  `/win32icon:${path.join(project, 'assets', 'studio.ico')}`,
  `/out:${path.join(output, 'llmmarkup-launcher.exe')}`, path.join(__dirname, 'launcher.cs'), buildInfo,
], { cwd: project, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status || 1);
