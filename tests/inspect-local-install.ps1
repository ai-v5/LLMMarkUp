# SPDX-License-Identifier: AGPL-3.0-only
param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
if (-not $env:LLMMARKUP_TEST_DATA) { throw 'An isolated test root is required.' }
$testRoot = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA)
if (-not [IO.Path]::GetFullPath($InstallRoot).Equals([IO.Path]::Combine($testRoot, 'install'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The synthetic installation is outside its test root.' }
$project = Split-Path -Parent $PSScriptRoot
$package = Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'install-local.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The local installer script does not parse.' }
foreach ($name in @('File-Hash','Resolve-InstalledRuntime')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw 'A local installer function is missing.' }
  Invoke-Expression $function.Extent.Text
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpLocalTestRegistry {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegLoadAppKey(string file, out SafeRegistryHandle key, uint access, uint options, uint reserved);
}
'@
$handle = $null
$status = [LLMMarkUpLocalTestRegistry]::RegLoadAppKey([IO.Path]::Combine($testRoot, 'synthetic-registry.dat'), [ref]$handle, 0x20019, 0, 0)
if ($status -ne 0 -or $handle.IsInvalid) { throw 'Cannot open the synthetic registry.' }
$base = [Microsoft.Win32.RegistryKey]::FromHandle($handle)
try { Resolve-InstalledRuntime $InstallRoot @($base) | ConvertTo-Json -Compress } finally { $base.Dispose() }
