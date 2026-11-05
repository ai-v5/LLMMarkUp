# SPDX-License-Identifier: AGPL-3.0-only
param([Parameter(Mandatory=$true)][int]$ProcessId, [Parameter(Mandatory=$true)][string]$Executable, [switch]$WrongStart, [switch]$WrongExe, [switch]$Legacy)
$ErrorActionPreference = 'Stop'
if (-not $env:LLMMARKUP_TEST_DATA) { throw 'An isolated test root is required.' }
$prefix = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA).TrimEnd('\') + '\'
if (-not [IO.Path]::GetFullPath($Executable).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The synthetic process is outside the test root.' }
$entry = Get-CimInstance Win32_Process -Filter ("ProcessId = " + $ProcessId)
if (-not $entry -or -not [IO.Path]::GetFullPath($entry.ExecutablePath).Equals([IO.Path]::GetFullPath($Executable), [StringComparison]::OrdinalIgnoreCase)) { throw 'The synthetic process identity cannot be verified.' }
if ($WrongStart) { $entry = [pscustomobject]@{ ProcessId=$entry.ProcessId; ExecutablePath=$entry.ExecutablePath; CreationDate=$entry.CreationDate.AddMinutes(-5) } }
$tokens = $null; $parseErrors = $null
$project = Split-Path -Parent $PSScriptRoot
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $project 'install-local.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'The local installer script does not parse.' }
foreach ($name in @('File-Hash','Request-VerifiedClose')) {
  $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
  if (-not $function) { throw 'A local close function is missing.' }
  Invoke-Expression $function.Extent.Text
}
$previous = if ($WrongStart -or $WrongExe -or $Legacy) { [pscustomobject]@{ name='llmmarkup' } } else { $null }
$existing = [pscustomobject]@{ Runtime=[IO.Path]::GetDirectoryName($Executable); Id=$null; Hash=$null }
if ($WrongStart -or $WrongExe) {
  $manifest = [ordered]@{ schema=1; product='llmmarkup'; files=@(@{ path='LLMMarkUp.exe'; sha256=(File-Hash (Join-Path $existing.Runtime 'LLMMarkUp.exe')).ToLowerInvariant() }) }
  $manifestPath = Join-Path $existing.Runtime '.llmmarkup-manifest.json'
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5 -Compress), [Text.UTF8Encoding]::new($false))
  $existing.Id = [guid]::NewGuid().ToString('D'); $existing.Hash = (File-Hash $manifestPath).ToLowerInvariant()
}
Request-VerifiedClose @($entry) $previous $existing
