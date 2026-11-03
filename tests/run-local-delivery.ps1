# SPDX-License-Identifier: AGPL-3.0-only
param([Parameter(Mandatory=$true)][string]$InstallRoot)
$ErrorActionPreference = 'Stop'
if (-not $env:LLMMARKUP_TEST_DATA -or -not $env:LLMMARKUP_LOCAL_TEST_OUTPUT) { throw 'An isolated test registry and payload are required.' }
$testRoot = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA).TrimEnd('\')
if (-not [IO.Path]::GetFullPath($InstallRoot).Equals([IO.Path]::Combine($testRoot, 'install'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The synthetic installation is outside its test root.' }
$hive = [IO.Path]::Combine($testRoot, 'synthetic-registry.dat')
if (-not [IO.File]::Exists($hive)) { throw 'The synthetic registry is unavailable.' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpLocalDeliveryRegistry {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegLoadAppKey(string file, out SafeRegistryHandle key, uint access, uint options, uint reserved);
  [DllImport("advapi32.dll")] public static extern int RegOverridePredefKey(IntPtr predefined, IntPtr replacement);
}
'@
$handle = $null
$status = [LLMMarkUpLocalDeliveryRegistry]::RegLoadAppKey($hive, [ref]$handle, 0xF003F, 0, 0)
if ($status -ne 0 -or $handle.IsInvalid) { throw 'Cannot open the synthetic registry.' }
$currentUser = [IntPtr]::new([int64]-2147483647)
try {
  if ([LLMMarkUpLocalDeliveryRegistry]::RegOverridePredefKey($currentUser, $handle.DangerousGetHandle()) -ne 0) { throw 'Cannot isolate the synthetic registry.' }
  & (Join-Path (Split-Path -Parent $PSScriptRoot) 'install-local.ps1') -InstallDirectory $InstallRoot -Launch
} finally {
  [void][LLMMarkUpLocalDeliveryRegistry]::RegOverridePredefKey($currentUser, [IntPtr]::Zero)
  $handle.Dispose()
}
