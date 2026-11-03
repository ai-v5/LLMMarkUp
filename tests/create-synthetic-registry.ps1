# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [string]$InstallId,
  [string]$ManifestSha256,
  [string]$EntryName,
  [Parameter(Mandatory=$true)][string]$AppGuid,
  [switch]$Legacy,
  [switch]$UninstallOnly,
  [switch]$Machine
)
$ErrorActionPreference = 'Stop'
if (-not $env:LLMMARKUP_TEST_DATA) { throw 'An isolated test root is required.' }
$testRoot = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA).TrimEnd('\')
if ([IO.Path]::GetFullPath($InstallRoot) -notin @([IO.Path]::Combine($testRoot, 'install'), [IO.Path]::Combine($testRoot, 'legacy-install'))) { throw 'Synthetic installation must be inside the test root.' }
$hiveName = if ($Machine) { 'synthetic-machine-registry.dat' } else { 'synthetic-registry.dat' }
$hiveFile = [IO.Path]::Combine($testRoot, $hiveName)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpSyntheticRegistry {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegLoadAppKey(string file, out SafeRegistryHandle key, uint access, uint options, uint reserved);
}
'@
$handle = $null
$code = [LLMMarkUpSyntheticRegistry]::RegLoadAppKey($hiveFile, [ref]$handle, 0xF003F, 0, 0)
if ($code -ne 0 -or $handle.IsInvalid) { throw 'Cannot create the synthetic registry hive.' }
$baseKey = [Microsoft.Win32.RegistryKey]::FromHandle($handle)
try {
  if ($UninstallOnly) {
    $key = $baseKey.CreateSubKey(('Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $AppGuid))
    try { $key.SetValue('UninstallString', ('"' + [IO.Path]::Combine($InstallRoot, 'Uninstall LLMMarkUp.exe') + '"'), [Microsoft.Win32.RegistryValueKind]::String) }
    finally { $key.Dispose() }
    return
  }
  $key = $baseKey.CreateSubKey(('Software\' + $AppGuid))
  try {
    $key.SetValue('InstallLocation', $InstallRoot, [Microsoft.Win32.RegistryValueKind]::String)
    if (-not $Legacy) {
      if (-not $InstallId -or -not $ManifestSha256) { throw 'Synthetic install identity is required.' }
      $key.SetValue('CurrentInstallId', $InstallId, [Microsoft.Win32.RegistryValueKind]::String)
      $key.SetValue('CurrentManifestSha256', $ManifestSha256, [Microsoft.Win32.RegistryValueKind]::String)
      if ($EntryName) { $key.SetValue('EntryName', $EntryName, [Microsoft.Win32.RegistryValueKind]::String) }
    }
  } finally { $key.Dispose() }
} finally { $baseKey.Dispose() }
