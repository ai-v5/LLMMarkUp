# SPDX-License-Identifier: AGPL-3.0-only
param([Parameter(Mandatory=$true)][string]$Key, [AllowEmptyString()][string]$Name = '')
$ErrorActionPreference = 'Stop'
if (-not $env:LLMMARKUP_TEST_DATA) { throw 'An isolated test root is required.' }
$hiveFile = [IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'synthetic-registry.dat')
if (-not [IO.File]::Exists($hiveFile)) { throw 'The synthetic registry does not exist.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpSyntheticRegistryRead {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegLoadAppKey(string file, out SafeRegistryHandle key, uint access, uint options, uint reserved);
}
'@
$handle = $null
$code = [LLMMarkUpSyntheticRegistryRead]::RegLoadAppKey($hiveFile, [ref]$handle, 0x20019, 0, 0)
if ($code -ne 0 -or $handle.IsInvalid) { throw 'Cannot open the synthetic registry.' }
$base = [Microsoft.Win32.RegistryKey]::FromHandle($handle)
try {
  $subkey = $base.OpenSubKey($Key, $false)
  $exists = $null -ne $subkey -and $subkey.GetValueNames() -contains $Name
  $value = if ($exists) { $subkey.GetValue($Name) } else { $null }
  [ordered]@{ exists=$exists; value=$value } | ConvertTo-Json -Compress
  if ($subkey) { $subkey.Dispose() }
} finally { $base.Dispose() }
