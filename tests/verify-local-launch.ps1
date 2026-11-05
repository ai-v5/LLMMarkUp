# SPDX-License-Identifier: AGPL-3.0-only
param([Parameter(Mandatory=$true)][string]$EntryPath, [Parameter(Mandatory=$true)][string]$Runtime, [string]$Profile, [string]$InstallRoot)
$ErrorActionPreference = 'Stop'
if (-not $env:LLMMARKUP_TEST_DATA) { throw 'An isolated test root is required.' }
$prefix = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA).TrimEnd('\') + '\'
foreach ($path in @($EntryPath, $Runtime, $Profile, $InstallRoot) | Where-Object { $_ }) {
  if (-not [IO.Path]::GetFullPath($path).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The synthetic launcher is outside the test root.' }
}
$tokens = $null; $parseErrors = $null
$project = Split-Path -Parent $PSScriptRoot
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'install-local.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The local installer script does not parse.' }
foreach ($name in @('Initialize-SyntheticLaunchProfile','Start-VerifiedApplication')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw 'A local launcher function is missing.' }
  Invoke-Expression $function.Extent.Text
}
if ($Profile) {
  if (-not $InstallRoot) { throw 'The synthetic installation root is required.' }
  $package = Get-Content -Raw -LiteralPath (Join-Path $project 'package.json') | ConvertFrom-Json
  $marker = Get-Content -Raw -LiteralPath (Join-Path $Runtime '.llmmarkup-owned.json') | ConvertFrom-Json
  Initialize-SyntheticLaunchProfile $Profile ([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA)) $InstallRoot ([pscustomobject]@{ Id=$marker.installId; Hash=$marker.manifestSha256 })
}
Start-VerifiedApplication $EntryPath $Runtime $Profile
