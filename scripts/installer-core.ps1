# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory=$true)][ValidateSet('Install','Uninstall')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$AppGuid,
  [Parameter(Mandatory=$true)][string]$Version,
  [string]$Payload,
  [string]$UninstallerPath,
  [Parameter(Mandatory=$true)][string]$HelperDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpInstallerNative {
  [StructLayout(LayoutKind.Sequential)] public struct Attributes { public uint Value; public uint Tag; }
  [StructLayout(LayoutKind.Sequential)] public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegLoadAppKey(string path, out SafeRegistryHandle key, uint access, uint options, uint reserved);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool CreateDirectory(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool MoveFileEx(string source, string target, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int klass, out Attributes info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle, int klass, ref Disposition info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("shell32.dll")] public static extern void SHChangeNotify(uint eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@

function Open-Checked([string]$Path, [bool]$Directory) {
  $access = if ($Directory) { [uint32]128 } else { [uint32]2147549184 }
  $share = if ($Directory) { [uint32]3 } else { [uint32]0 }
  $flags = if ($Directory) { [uint32]0x02200000 } else { [uint32]0x00200080 }
  $handle = [LLMMarkUpInstallerNative]::CreateFile($Path, $access, $share, [IntPtr]::Zero, 3, $flags, [IntPtr]::Zero)
  if ($handle.IsInvalid) { throw 'An installation path is unavailable or in use.' }
  $attributes = [LLMMarkUpInstallerNative+Attributes]::new()
  if (-not [LLMMarkUpInstallerNative]::GetFileInformationByHandleEx($handle, 9, [ref]$attributes, 8) -or
      ($attributes.Value -band 0x400) -ne 0 -or (($attributes.Value -band 0x10) -ne 0) -ne $Directory) {
    $handle.Dispose(); throw 'An installation path has an unexpected type or is a link.'
  }
  return $handle
}
function Final-Path($Handle) {
  $text = [Text.StringBuilder]::new(32768)
  $length = [LLMMarkUpInstallerNative]::GetFinalPathNameByHandle($Handle, $text, [uint32]$text.Capacity, 0)
  if ($length -eq 0 -or $length -ge $text.Capacity) { throw 'Cannot resolve an installation path.' }
  return $text.ToString().TrimEnd('\')
}
function Create-Directory([string]$Path) {
  if (-not [LLMMarkUpInstallerNative]::CreateDirectory($Path, [IntPtr]::Zero)) { throw 'An installation directory already exists or cannot be created.' }
}
function Hash-Bytes([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Hash-File([string]$Path) {
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Verify-InstalledManifest([string]$Runtime, [string]$ManifestPath) {
  $manifest = [IO.File]::ReadAllText($ManifestPath, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json
  if ($manifest.schema -ne 1 -or $manifest.product -ne 'llmmarkup' -or -not ($manifest.files -is [array]) -or $manifest.files.Count -lt 3 -or $manifest.files.Count -gt 10000) { throw 'The installed manifest is invalid.' }
  $runtimeHandle = Open-Checked $Runtime $true
  try {
    $prefix = (Final-Path $runtimeHandle) + '\'
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $manifest.files) {
      if ($record.path -isnot [string] -or [IO.Path]::IsPathRooted($record.path) -or $record.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'The installed manifest has an invalid entry.' }
      $parts = @($record.path -split '[\\/]')
      if (@($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[<>:"|?*\x00-\x1f]' -or $_ -match '[. ]$' }).Count -ne 0) { throw 'The installed manifest has an invalid path.' }
      $relative = $parts -join '\'
      if (-not $seen.Add($relative)) { throw 'The installed manifest contains a duplicate.' }
      $handle = Open-Checked ([IO.Path]::Combine($Runtime, $relative)) $false
      try {
        if (-not (Final-Path $handle).StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'An installed file resolves outside its runtime.' }
        $stream = [IO.FileStream]::new($handle, [IO.FileAccess]::Read)
        try {
          $algorithm = [Security.Cryptography.SHA256]::Create()
          try { $hash = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
          if ($hash -ne $record.sha256) { throw 'An installed application file changed.' }
        } finally { $stream.Dispose() }
      } catch { $handle.Dispose(); throw }
    }
    foreach ($required in @('LLMMarkUp.exe','llmmarkup-launcher.exe','llmmarkup-uninstall.exe','resources\app.asar')) { if (-not $seen.Contains($required)) { throw 'The installed application is incomplete.' } }
  } finally { $runtimeHandle.Dispose() }
}
function Write-NewFile([string]$Path, [byte[]]$Bytes) {
  $file = [IO.FileStream]::new($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $file.Write($Bytes, 0, $Bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
function Copy-NewFile([string]$Source, [string]$Target) {
  $sourceFile = [IO.File]::Open($Source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $targetFile = [IO.FileStream]::new($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $sourceFile.CopyTo($targetFile); $targetFile.Flush($true) } finally { $targetFile.Dispose() }
  } finally { $sourceFile.Dispose() }
}
function Remove-Verified([string]$Path, [string]$ExpectedHash, [string]$Parent) {
  if (-not [IO.File]::Exists($Path)) { return }
  $dir = Open-Checked $Parent $true
  try {
    $handle = Open-Checked $Path $false
    try {
      if (-not (Final-Path $handle).StartsWith(((Final-Path $dir) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'A file resolves outside its expected directory.' }
      $stream = [IO.FileStream]::new($handle, [IO.FileAccess]::Read)
      try {
        $algorithm = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $algorithm.Dispose() }
        if ($actual -ne $ExpectedHash) { throw 'A changed file was preserved.' }
        $disposition = [LLMMarkUpInstallerNative+Disposition]::new(); $disposition.DeleteFile = $true
        if (-not [LLMMarkUpInstallerNative]::SetFileInformationByHandle($stream.SafeFileHandle, 4, [ref]$disposition, 4)) { throw 'Cannot remove an unchanged installation file.' }
      } finally { $stream.Dispose() }
    } catch { $handle.Dispose(); throw }
  } finally { $dir.Dispose() }
}
function Invoke-Helper([string]$File, [string[]]$Arguments) {
  $shell = [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  $result = & $shell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $File @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) { throw (($result | Out-String).Trim()) }
}
function Open-Registry {
  if ($env:LLMMARKUP_TEST_DATA) {
    $test = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA).TrimEnd('\')
    if ($root -notin @([IO.Path]::Combine($test, 'install'), [IO.Path]::Combine($test, 'legacy-install'))) { throw 'A synthetic installation must use its isolated test root.' }
    foreach ($path in @($HelperDirectory, $Payload, $UninstallerPath) | Where-Object { $_ }) {
      if (-not [IO.Path]::GetFullPath($path).StartsWith(($test + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'A synthetic helper or payload is outside the test root.' }
    }
    $handle = $null
    $status = [LLMMarkUpInstallerNative]::RegLoadAppKey([IO.Path]::Combine($test, 'synthetic-registry.dat'), [ref]$handle, 0xF003F, 0, 0)
    if ($status -ne 0 -or $handle.IsInvalid) { throw 'Cannot open the isolated test registry.' }
    return [Microsoft.Win32.RegistryKey]::FromHandle($handle)
  }
  return [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64)
}
function Open-MachineRegistries {
  if ($env:LLMMARKUP_TEST_DATA) {
    $file = [IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'synthetic-machine-registry.dat')
    if (-not [IO.File]::Exists($file)) { return @() }
    $handle = $null
    $status = [LLMMarkUpInstallerNative]::RegLoadAppKey($file, [ref]$handle, 0x20019, 0, 0)
    if ($status -ne 0 -or $handle.IsInvalid) { throw 'Cannot open the isolated machine registry.' }
    return @([Microsoft.Win32.RegistryKey]::FromHandle($handle))
  }
  return @(
    [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry64),
    [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, [Microsoft.Win32.RegistryView]::Registry32)
  )
}
function Registry-Value($Base, [string]$Key, [string]$Name) {
  $subkey = $Base.OpenSubKey($Key, $false)
  if (-not $subkey) { return $null }
  try { return $subkey.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $subkey.Dispose() }
}
function Set-PendingLocation($Base) {
  $key = $Base.CreateSubKey($appKey)
  try {
    $previous = $key.GetValue('PendingInstallLocation')
    if ($previous -and -not [IO.Path]::GetFullPath([string]$previous).TrimEnd('\').Equals($root, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.File]::Exists([IO.Path]::Combine([IO.Path]::GetFullPath([string]$previous), '.llmmarkup-pending.json'))) { throw 'Another installation has an unfinished transaction.' }
    $key.SetValue('PendingInstallLocation', $root, [Microsoft.Win32.RegistryValueKind]::String)
  } finally { $key.Dispose() }
}
function Remove-PendingLocation($Base) {
  $key = $Base.OpenSubKey($appKey, $true)
  if ($key) {
    try {
      $previous = $key.GetValue('PendingInstallLocation')
      if ($previous -and [IO.Path]::GetFullPath([string]$previous).TrimEnd('\').Equals($root, [StringComparison]::OrdinalIgnoreCase)) { $key.DeleteValue('PendingInstallLocation', $false) }
    } finally { $key.Dispose() }
  }
}
function Registered-Location($Base) {
  $location = Registry-Value $Base $appKey 'InstallLocation'
  $command = Registry-Value $Base $uninstallKey 'UninstallString'
  $fromUninstaller = $null
  if ($command) {
    $match = [regex]::Match([string]$command, '^\s*"([^"]+)"(?:\s|$)')
    if (-not $match.Success) { throw 'An existing uninstall command cannot be identified safely.' }
    $uninstaller = [IO.Path]::GetFullPath($match.Groups[1].Value)
    if ([IO.Path]::GetFileName($uninstaller) -notin @('Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) { throw 'An existing uninstall command has an unexpected target.' }
    $fromUninstaller = [IO.Path]::GetDirectoryName($uninstaller)
  }
  if ($location) { $location = [IO.Path]::GetFullPath([string]$location).TrimEnd('\') }
  if ($location -and $fromUninstaller -and -not $location.Equals($fromUninstaller.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Existing installation registry locations disagree.' }
  if ($location) { return $location }
  return $fromUninstaller
}
function New-RegistryPlan([string]$Id, [string]$ManifestHash, [string]$EntryName, [string]$UninstallerName, [string]$ProductVersion) {
  $str = [Microsoft.Win32.RegistryValueKind]::String
  $dword = [Microsoft.Win32.RegistryValueKind]::DWord
  $entry = [IO.Path]::Combine($root, $EntryName)
  $uninstallCommand = '"' + [IO.Path]::Combine($root, $UninstallerName) + '"'
  $openCommand = '"' + $entry + '" "%1"'
  $classes = 'Software\Classes\'
  return @(
    @{ Key=$appKey; Name='InstallLocation'; Value=$root; Kind=$str },
    @{ Key=$appKey; Name='CurrentManifestSha256'; Value=$ManifestHash; Kind=$str },
    @{ Key=$appKey; Name='EntryName'; Value=$EntryName; Kind=$str },
    @{ Key=$appKey; Name='UninstallerName'; Value=$UninstallerName; Kind=$str },
    @{ Key=$uninstallKey; Name='DisplayName'; Value='LLMMarkUp'; Kind=$str },
    @{ Key=$uninstallKey; Name='DisplayVersion'; Value=$ProductVersion; Kind=$str },
    @{ Key=$uninstallKey; Name='InstallLocation'; Value=$root; Kind=$str },
    @{ Key=$uninstallKey; Name='UninstallString'; Value=$uninstallCommand; Kind=$str },
    @{ Key=$uninstallKey; Name='QuietUninstallString'; Value=($uninstallCommand + ' /S'); Kind=$str },
    @{ Key=$uninstallKey; Name='DisplayIcon'; Value=('"' + $entry + '",0'); Kind=$str },
    @{ Key=$uninstallKey; Name='NoModify'; Value=1; Kind=$dword },
    @{ Key=$uninstallKey; Name='NoRepair'; Value=1; Kind=$dword },
    @{ Key=($classes + 'LLMMarkUp.Markdown'); Name=''; Value='Markdown document'; Kind=$str },
    @{ Key=($classes + 'LLMMarkUp.Markdown\Application'); Name='ApplicationName'; Value='LLMMarkUp'; Kind=$str },
    @{ Key=($classes + 'LLMMarkUp.Markdown\DefaultIcon'); Name=''; Value=('"' + $entry + '",0'); Kind=$str },
    @{ Key=($classes + 'LLMMarkUp.Markdown\shell\open\command'); Name=''; Value=$openCommand; Kind=$str },
    @{ Key=($classes + '.md\OpenWithProgids'); Name='LLMMarkUp.Markdown'; Value=''; Kind=$str },
    @{ Key=($classes + '.markdown\OpenWithProgids'); Name='LLMMarkUp.Markdown'; Value=''; Kind=$str },
    @{ Key=($classes + 'Applications\LLMMarkUp.exe'); Name='FriendlyAppName'; Value='LLMMarkUp'; Kind=$str },
    @{ Key=($classes + 'Applications\LLMMarkUp.exe\SupportedTypes'); Name='.md'; Value=''; Kind=$str },
    @{ Key=($classes + 'Applications\LLMMarkUp.exe\SupportedTypes'); Name='.markdown'; Value=''; Kind=$str },
    @{ Key=($classes + 'Applications\LLMMarkUp.exe\shell\open\command'); Name=''; Value=$openCommand; Kind=$str },
    @{ Key=$appKey; Name='CurrentInstallId'; Value=$Id; Kind=$str }
  )
}
function Registry-Write($Base, $Item) {
  $key = $Base.CreateSubKey($Item.Key)
  try {
    $present = $key.GetValueNames() -contains $Item.Name
    $before = if ($present) { $key.GetValue($Item.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
    $kind = if ($present) { $key.GetValueKind($Item.Name) } else { $null }
    $key.SetValue($Item.Name, $Item.Value, $Item.Kind)
    return [pscustomobject]@{ Key=$Item.Key; Name=$Item.Name; Old=$before; Kind=$kind; Present=$present; Written=$Item.Value }
  } finally { $key.Dispose() }
}
function Registry-Snapshot($Base, $Item) {
  $key = $Base.OpenSubKey($Item.Key, $false)
  try {
    $present = $null -ne $key -and $key.GetValueNames() -contains $Item.Name
    $old = if ($present) { $key.GetValue($Item.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
    $kind = if ($present) { [string]$key.GetValueKind($Item.Name) } else { $null }
    if ($present -and $kind -notin @('String','DWord','ExpandString')) { throw 'An existing installation registry value has an unsupported type.' }
    return [pscustomobject]@{ Key=$Item.Key; Name=$Item.Name; Old=$old; Kind=$kind; Present=$present; Written=$Item.Value }
  } finally { if ($key) { $key.Dispose() } }
}
function Registry-Reconcile($Base, $Journal) {
  for ($i=$Journal.Count-1; $i -ge 0; $i--) {
    $item = $Journal[$i]
    $key = $Base.OpenSubKey($item.Key, $true)
    if (-not $key) { if ($item.Present) { throw 'A previous registry key is missing.' }; continue }
    try {
      $present = $key.GetValueNames() -contains $item.Name
      $current = if ($present) { $key.GetValue($item.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { $null }
      if ($present -and $current -eq $item.Written) {
        if ($item.Present) { $key.SetValue($item.Name, $item.Old, [Microsoft.Win32.RegistryValueKind]$item.Kind) }
        else { $key.DeleteValue($item.Name, $false) }
      } elseif ($present -ne $item.Present -or ($present -and $current -ne $item.Old)) {
        throw 'A changed registry value was preserved.'
      }
    } finally { $key.Dispose() }
  }
}
function Shortcut-Directories([bool]$Create) {
  if ($env:LLMMARKUP_TEST_DATA) {
    $paths = @([IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'desktop'), [IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'start-menu'))
    if ($Create) { foreach ($path in $paths) { if (-not [IO.Directory]::Exists($path)) { Create-Directory $path } } }
    return $paths
  }
  return @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'))
}
function Ensure-Shortcuts($Base, [string]$EntryName) {
  $directories = @(Shortcut-Directories $true)
  $shell = New-Object -ComObject WScript.Shell
  for ($i=0; $i -lt 2; $i++) {
    if (-not $directories[$i] -or -not [IO.Directory]::Exists($directories[$i])) { continue }
    $destination = [IO.Path]::Combine($directories[$i], 'LLMMarkUp.lnk')
    if ([IO.File]::Exists($destination) -or [IO.Directory]::Exists($destination)) { continue }
    $temporary = [IO.Path]::Combine($HelperDirectory, ('shortcut-' + [guid]::NewGuid().ToString('N') + '.lnk'))
    try {
      $link = $shell.CreateShortcut($temporary)
      $link.TargetPath = [IO.Path]::Combine($root, $EntryName)
      $link.WorkingDirectory = $root
      $link.IconLocation = '"' + $link.TargetPath + '",0'
      $link.Save()
      Copy-NewFile $temporary $destination
      $prefix = if ($i -eq 0) { 'DesktopShortcut' } else { 'StartMenuShortcut' }
      $key = $Base.CreateSubKey($appKey)
      try {
        $key.SetValue(($prefix + 'Path'), $destination, [Microsoft.Win32.RegistryValueKind]::String)
        $key.SetValue(($prefix + 'Hash'), (Hash-File $destination), [Microsoft.Win32.RegistryValueKind]::String)
      } finally { $key.Dispose() }
    } catch { } finally {
      if ([IO.File]::Exists($temporary)) { try { Remove-Verified $temporary (Hash-File $temporary) $HelperDirectory } catch {} }
    }
  }
}
function Remove-Shortcuts($Base) {
  $directories = @(Shortcut-Directories $false)
  for ($i=0; $i -lt 2; $i++) {
    $prefix = if ($i -eq 0) { 'DesktopShortcut' } else { 'StartMenuShortcut' }
    $path = Registry-Value $Base $appKey ($prefix + 'Path')
    $hash = Registry-Value $Base $appKey ($prefix + 'Hash')
    if ($directories[$i] -and $path -and $hash -match '^[0-9a-f]{64}$' -and $path.Equals([IO.Path]::Combine($directories[$i], 'LLMMarkUp.lnk'), [StringComparison]::OrdinalIgnoreCase)) {
      try { Remove-Verified $path $hash $directories[$i] } catch {}
    }
  }
}
function Remove-RegistryValueIfMatching($Base, $Item) {
  $key = $Base.OpenSubKey($Item.Key, $true)
  if ($key) {
    try { if ($key.GetValueNames() -contains $Item.Name -and $key.GetValue($Item.Name) -eq $Item.Value) { $key.DeleteValue($Item.Name, $false) } }
    finally { $key.Dispose() }
  }
}
function Registry-Restore($Base, $Journal) {
  for ($i=$Journal.Count-1; $i -ge 0; $i--) {
    $item = $Journal[$i]; $key = $Base.OpenSubKey($item.Key, $true)
    if (-not $key) { throw 'An installation registry entry changed during rollback.' }
    try {
      $current = $key.GetValue($item.Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      if ($current -ne $item.Written) { throw 'A changed registry value was preserved.' }
      if ($item.Present) { $key.SetValue($item.Name, $item.Old, $item.Kind) }
      else { $key.DeleteValue($item.Name, $false) }
    } finally { $key.Dispose() }
  }
}
function Complete-Uninstall($Base, $Pending, [string]$PendingPath, [byte[]]$PendingBytes, [bool]$Resume) {
  if ($Pending.installId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or
      $Pending.version -notmatch '^\d+\.\d+\.\d+$' -or $Pending.manifestHash -notmatch '^[0-9a-f]{64}$' -or $Pending.markerHash -notmatch '^[0-9a-f]{64}$' -or
      $Pending.entryName -notin @('LLMMarkUp.exe','MDPPT Studio.exe') -or $Pending.uninstallerName -notin @('Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) { throw 'The pending uninstall record is invalid.' }
  $runtime = [IO.Path]::Combine($root, '.llmmarkup-versions', $Pending.installId)
  $manifestPath = [IO.Path]::Combine($runtime, '.llmmarkup-manifest.json')
  $markerPath = [IO.Path]::Combine($runtime, '.llmmarkup-owned.json')
  $currentId = Registry-Value $Base $appKey 'CurrentInstallId'
  if ($currentId -and $currentId -ne $Pending.installId) { throw 'Another installation replaced the pending uninstall.' }
  if ($currentId) {
    if (-not [IO.File]::Exists($manifestPath) -or -not [IO.File]::Exists($markerPath) -or (Hash-File $manifestPath) -ne $Pending.manifestHash -or (Hash-File $markerPath) -ne $Pending.markerHash) { throw 'The pending uninstall records cannot be verified.' }
    $arguments = @('-InstallRoot',$runtime,'-ManifestPath',$manifestPath,'-InstallId',$Pending.installId,'-EntrypointName',$Pending.entryName,'-UninstallerName',$Pending.uninstallerName,'-PreserveRecords')
    if ($Resume) { $arguments += '-Resume' }
    Invoke-Helper ([IO.Path]::Combine($HelperDirectory, 'safe-uninstall.ps1')) $arguments
    if ($env:LLMMARKUP_UNINSTALL_TEST_PAUSE -eq 'after-cleanup') {
      if (-not $env:LLMMARKUP_TEST_DATA -or -not $root.Equals([IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'install'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic pause requires an isolated test installation.' }
      [IO.File]::WriteAllText([IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'uninstall-paused'), [string]$PID)
      while ($true) { [Threading.Thread]::Sleep(1000) }
    }
  }
  Remove-Shortcuts $Base
  $plan = @(New-RegistryPlan $Pending.installId $Pending.manifestHash $Pending.entryName $Pending.uninstallerName $Pending.version)
  $classes = 'Software\Classes\'
  $command = '"' + [IO.Path]::Combine($root, $Pending.entryName) + '" "%1"'
  $progCommand = Registry-Value $Base ($classes + 'LLMMarkUp.Markdown\shell\open\command') ''
  $appCommand = Registry-Value $Base ($classes + 'Applications\LLMMarkUp.exe\shell\open\command') ''
  $ownsProgId = $Pending.ownsProgId -and ($null -eq $progCommand -or $progCommand -eq $command)
  $ownsApplication = $Pending.ownsApplication -and ($null -eq $appCommand -or $appCommand -eq $command)
  foreach ($item in $plan) {
    if ($item.Key -in @($appKey,$uninstallKey) -or
        ($ownsProgId -and ($item.Key.StartsWith(($classes + 'LLMMarkUp.Markdown'), [StringComparison]::OrdinalIgnoreCase) -or $item.Key -in @(($classes + '.md\OpenWithProgids'), ($classes + '.markdown\OpenWithProgids')))) -or
        ($ownsApplication -and $item.Key.StartsWith(($classes + 'Applications\LLMMarkUp.exe'), [StringComparison]::OrdinalIgnoreCase))) { Remove-RegistryValueIfMatching $Base $item }
    if ($env:LLMMARKUP_UNINSTALL_TEST_PAUSE -eq 'after-location-removed' -and $item.Key -eq $uninstallKey -and $item.Name -eq 'UninstallString') {
      if (-not $env:LLMMARKUP_TEST_DATA -or $root -notin @([IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'install'), [IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'legacy-install'))) { throw 'Synthetic pause requires an isolated test installation.' }
      [IO.File]::WriteAllText([IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'uninstall-paused'), [string]$PID)
      while ($true) { [Threading.Thread]::Sleep(1000) }
    }
  }
  if ($env:LLMMARKUP_UNINSTALL_TEST_PAUSE -eq 'after-registry') {
    if (-not $env:LLMMARKUP_TEST_DATA -or -not $root.Equals([IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'install'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic pause requires an isolated test installation.' }
    [IO.File]::WriteAllText([IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'uninstall-paused'), [string]$PID)
    while ($true) { [Threading.Thread]::Sleep(1000) }
  }
  $key = $Base.OpenSubKey($appKey, $true)
  if ($key) { try { foreach ($name in @('DesktopShortcutPath','DesktopShortcutHash','StartMenuShortcutPath','StartMenuShortcutHash')) { $key.DeleteValue($name, $false) } } finally { $key.Dispose() } }
  if ([IO.File]::Exists($manifestPath)) { Remove-Verified $manifestPath $Pending.manifestHash $runtime }
  if ([IO.File]::Exists($markerPath)) { Remove-Verified $markerPath $Pending.markerHash $runtime }
  Remove-Verified $PendingPath (Hash-Bytes $PendingBytes) $root
  Remove-PendingLocation $Base
  if (-not $env:LLMMARKUP_TEST_DATA) { [LLMMarkUpInstallerNative]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }
}
function Cleanup-Previous([string]$Id, [string]$ExpectedHash) {
  if (-not $Id -or $Id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or $ExpectedHash -notmatch '^[0-9a-f]{64}$') { return }
  $oldRuntime = [IO.Path]::Combine($root, '.llmmarkup-versions', $Id)
  $oldManifest = [IO.Path]::Combine($oldRuntime, '.llmmarkup-manifest.json')
  $oldMarker = [IO.Path]::Combine($oldRuntime, '.llmmarkup-owned.json')
  if (-not [IO.File]::Exists($oldManifest) -or -not [IO.File]::Exists($oldMarker) -or (Hash-File $oldManifest) -ne $ExpectedHash) { return }
  $oldMarkerHash = Hash-File $oldMarker
  Invoke-Helper ([IO.Path]::Combine($HelperDirectory, 'safe-uninstall.ps1')) @('-InstallRoot',$oldRuntime,'-ManifestPath',$oldManifest,'-InstallId',$Id,'-PreserveRecords')
  Remove-Verified $oldManifest $ExpectedHash $oldRuntime
  Remove-Verified $oldMarker $oldMarkerHash $oldRuntime
}
function Recover-Pending($Base, [string]$PendingPath) {
  $pendingBytes = [IO.File]::ReadAllBytes($PendingPath)
  if ($pendingBytes.Length -gt 1048576) { throw 'The pending installation record is too large.' }
  $pending = [Text.UTF8Encoding]::new($false, $true).GetString($pendingBytes) | ConvertFrom-Json
  if ($pending.schema -ne 1 -or $pending.product -ne 'llmmarkup') { throw 'The pending installation record is invalid.' }
  if ($pending.mode -eq 'uninstall') {
    Complete-Uninstall $Base $pending $PendingPath $pendingBytes $true
    return 'uninstall'
  }
  if ($pending.schema -ne 1 -or $pending.product -ne 'llmmarkup' -or $pending.installId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or $pending.version -notmatch '^\d+\.\d+\.\d+$' -or
      $pending.entryName -notin @('LLMMarkUp.exe','MDPPT Studio.exe') -or $pending.uninstallerName -notin @('Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) { throw 'The pending installation record is invalid.' }
  $runtime = [IO.Path]::Combine($root, '.llmmarkup-versions', $pending.installId)
  $runtimeHandle = Open-Checked $runtime $true
  $rootHandle = Open-Checked $root $true
  try {
    if (-not (Final-Path $runtimeHandle).StartsWith(((Final-Path $rootHandle) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The pending runtime is outside the installation root.' }
    $manifestPath = [IO.Path]::Combine($runtime, '.llmmarkup-manifest.json')
    $marker = [IO.File]::ReadAllText([IO.Path]::Combine($runtime, '.llmmarkup-owned.json')) | ConvertFrom-Json
    if ($marker.schema -ne 1 -or $marker.product -ne 'llmmarkup' -or $marker.installId -ne $pending.installId -or $marker.manifestSha256 -ne $pending.manifestHash -or (Hash-File $manifestPath) -ne $pending.manifestHash) { throw 'The pending runtime cannot be verified.' }
    $launcher = [IO.Path]::Combine($runtime, 'llmmarkup-launcher.exe')
    $uninstaller = [IO.Path]::Combine($runtime, 'llmmarkup-uninstall.exe')
    if ((Hash-File $launcher) -ne $pending.launcherHash -or (Hash-File $uninstaller) -ne $pending.uninstallerHash) { throw 'The pending entrypoints cannot be verified.' }
    $journal = @($pending.registry)
    $plan = @(New-RegistryPlan $pending.installId $pending.manifestHash $pending.entryName $pending.uninstallerName $pending.version)
    if ($journal.Count -ne $plan.Count) { throw 'The pending registry record is invalid.' }
    for ($i=0; $i -lt $plan.Count; $i++) {
      if ($journal[$i].Key -ne $plan[$i].Key -or $journal[$i].Name -ne $plan[$i].Name -or $journal[$i].Written -ne $plan[$i].Value -or ($journal[$i].Present -and $journal[$i].Kind -notin @('String','DWord','ExpandString'))) { throw 'The pending registry record is invalid.' }
    }
    $currentId = Registry-Value $Base $appKey 'CurrentInstallId'
    if ($currentId -eq $pending.installId) {
      Remove-Verified $PendingPath (Hash-Bytes $pendingBytes) $root
      Remove-PendingLocation $Base
      try { Cleanup-Previous $pending.previousInstallId $pending.previousManifestHash } catch {}
      return 'install'
    }
    if ($currentId -ne $pending.previousInstallId) { throw 'The installation identity changed during recovery.' }
    Registry-Reconcile $Base $journal
    if ($pending.legacy) {
      if ([IO.File]::Exists([IO.Path]::Combine($runtime, '.llmmarkup-migration.json'))) {
        $migrationArgs = @('-Mode','Rollback','-InstallRoot',$root,'-RuntimeRoot',$runtime,'-InstallId',$pending.installId,'-LegacyExecutable',$pending.entryName,'-LegacyUninstaller',$pending.uninstallerName,'-LauncherPath',$launcher,'-SafeUninstallerPath',$uninstaller,'-ManifestPath',$manifestPath)
        if ($pending.previousInstallId) { $migrationArgs += @('-ExistingInstallId',$pending.previousInstallId,'-ExistingManifestHash',$pending.previousManifestHash) }
        Invoke-Helper ([IO.Path]::Combine($HelperDirectory, 'safe-migrate.ps1')) $migrationArgs
      }
    } else {
      Remove-Verified ([IO.Path]::Combine($root, $pending.entryName)) $pending.launcherHash $root
      Remove-Verified ([IO.Path]::Combine($root, $pending.uninstallerName)) $pending.uninstallerHash $root
    }
    Remove-Verified $PendingPath (Hash-Bytes $pendingBytes) $root
    Remove-PendingLocation $Base
    return 'install'
  } finally { $runtimeHandle.Dispose(); $rootHandle.Dispose() }
}

if ($AppGuid -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or $Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid product identity.' }
$root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'A drive root cannot be used as an installation directory.' }
$appKey = 'Software\' + $AppGuid
$uninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $AppGuid
$base = Open-Registry
$directoryHandles = [Collections.ArrayList]::new()
$registryJournal = [Collections.ArrayList]::new()
$createdEntries = [Collections.ArrayList]::new()
$migrated = $false
$committed = $false
try {
  foreach ($machine in @(Open-MachineRegistries)) {
    try {
      if ((Registry-Value $machine $appKey 'InstallLocation') -or (Registry-Value $machine $uninstallKey 'UninstallString')) { throw 'A machine-wide previous installation was detected; it cannot be migrated safely by this per-user installer.' }
    } finally { $machine.Dispose() }
  }
  if ($Mode -eq 'Install' -and @(Get-Process -Name 'LLMMarkUp','MDPPT Studio','Uninstall LLMMarkUp','Uninstall MDPPT Studio','old-uninstaller','Au_' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Close the application and any existing uninstaller before installing.' }
  $pendingPath = [IO.Path]::Combine($root, '.llmmarkup-pending.json')
  if ([IO.File]::Exists($pendingPath)) {
    if ($Mode -eq 'Uninstall') {
      $existingPending = [IO.File]::ReadAllText($pendingPath) | ConvertFrom-Json
      if ($existingPending.mode -ne 'uninstall') { throw 'Retry the interrupted installer before uninstalling.' }
    }
    $recovered = Recover-Pending $base $pendingPath
    if ($Mode -eq 'Uninstall' -and $recovered -eq 'uninstall') { $committed = $true; Write-Output 'Interrupted uninstall completed.'; exit 0 }
  }
  if ([IO.Directory]::Exists($pendingPath)) { throw 'The installation transaction path is occupied.' }
  $registered = Registered-Location $base
  if ($registered -and -not [IO.Path]::GetFullPath($registered).TrimEnd('\').Equals($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Another installation is registered in a different directory.' }
  $installedId = Registry-Value $base $appKey 'CurrentInstallId'
  if ($Mode -eq 'Install') {
    if (-not $Payload -or -not $UninstallerPath) { throw 'The installation payload is incomplete.' }
    if ($installedId) {
      if ($installedId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Invalid installed identity.' }
      $currentRuntime = [IO.Path]::Combine($root, '.llmmarkup-versions', $installedId)
      $currentHandle = Open-Checked $currentRuntime $true; [void]$directoryHandles.Add($currentHandle)
      $currentManifest = [IO.Path]::Combine($currentRuntime, '.llmmarkup-manifest.json')
      $currentHash = Registry-Value $base $appKey 'CurrentManifestSha256'
      $currentMarker = [IO.File]::ReadAllText([IO.Path]::Combine($currentRuntime, '.llmmarkup-owned.json')) | ConvertFrom-Json
      $currentEntry = Registry-Value $base $appKey 'EntryName'
      $currentUninstaller = Registry-Value $base $appKey 'UninstallerName'
      if ($currentEntry -notin @('LLMMarkUp.exe','MDPPT Studio.exe') -or $currentUninstaller -notin @('Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe') -or
          $currentMarker.product -ne 'llmmarkup' -or $currentMarker.installId -ne $installedId -or $currentMarker.manifestSha256 -ne $currentHash -or
          (Hash-File $currentManifest) -ne $currentHash -or
          (Hash-File ([IO.Path]::Combine($currentRuntime, 'llmmarkup-launcher.exe'))) -ne (Hash-File ([IO.Path]::Combine($root, $currentEntry))) -or
          (Hash-File ([IO.Path]::Combine($currentRuntime, 'llmmarkup-uninstall.exe'))) -ne (Hash-File ([IO.Path]::Combine($root, $currentUninstaller)))) { throw 'The current installation cannot be verified.' }
      Verify-InstalledManifest $currentRuntime $currentManifest
      $currentVersion = Registry-Value $base $uninstallKey 'DisplayVersion'
      if ($currentVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'The installed application version is invalid.' }
      if ([version]$currentVersion -gt [version]$Version) { throw 'An older installer cannot replace a newer installed version.' }
      if ([version]$currentVersion -eq [version]$Version) {
        $committed = $true
        try { Ensure-Shortcuts $base $currentEntry } catch {}
        Write-Output 'This version is already installed and verified.'
        exit 0
      }
      $previousRuntime = $currentRuntime
      $previousManifest = $currentManifest
      $previousManifestHash = $currentHash
      $previousAppHandle = Open-Checked ([IO.Path]::Combine($previousRuntime, 'LLMMarkUp.exe')) $false
      [void]$directoryHandles.Add($previousAppHandle)
    }
    $payloadRoot = [IO.Path]::GetFullPath($Payload).TrimEnd('\')
    $payloadHandle = Open-Checked $payloadRoot $true; [void]$directoryHandles.Add($payloadHandle)
    $payloadManifestPath = [IO.Path]::Combine($payloadRoot, 'llmmarkup-payload-manifest.json')
    $payloadManifestBytes = [IO.File]::ReadAllBytes($payloadManifestPath)
    if ($payloadManifestBytes.Length -gt 16777216) { throw 'The payload manifest is too large.' }
    $payloadManifestHash = Hash-Bytes $payloadManifestBytes
    $payloadManifest = [Text.UTF8Encoding]::new($false, $true).GetString($payloadManifestBytes) | ConvertFrom-Json
    if ($payloadManifest.schema -ne 1 -or $payloadManifest.product -ne 'llmmarkup' -or -not ($payloadManifest.files -is [array]) -or $payloadManifest.files.Count -lt 3 -or $payloadManifest.files.Count -gt 10000) { throw 'The payload manifest is invalid.' }
    $expectedFiles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $payloadManifest.files) {
      if ($record.path -isnot [string] -or [IO.Path]::IsPathRooted($record.path) -or $record.sha256 -notmatch '^[0-9a-f]{64}$') { throw 'The payload manifest contains an invalid file.' }
      $parts = @($record.path -split '[\\/]')
      if (@($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[<>:"|?*\x00-\x1f]' -or $_ -match '[. ]$' }).Count -ne 0) { throw 'The payload manifest contains an invalid path.' }
      $relative = $parts -join '\'
      if ($relative -ieq 'llmmarkup-payload-manifest.json' -or $expectedFiles.ContainsKey($relative)) { throw 'The payload manifest contains a duplicate or reserved path.' }
      $expectedFiles.Add($relative, $record.sha256)
    }
    foreach ($required in @('LLMMarkUp.exe','llmmarkup-launcher.exe','resources\app.asar')) { if (-not $expectedFiles.ContainsKey($required)) { throw 'The payload is missing a required file.' } }
    $payloadPrefix = $payloadRoot + '\'
    $payloadItems = @(Get-ChildItem -LiteralPath $payloadRoot -Recurse -Force | Sort-Object { $_.FullName.Length })
    $actualCount = 0
    foreach ($item in $payloadItems) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.FullName.StartsWith($payloadPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation payload contains an unexpected link or path.' }
      if (-not $item.PSIsContainer) {
        $relative = $item.FullName.Substring($payloadPrefix.Length)
        if ($relative -ieq 'llmmarkup-payload-manifest.json') { continue }
        if (-not $expectedFiles.ContainsKey($relative) -or (Hash-File $item.FullName) -ne $expectedFiles[$relative]) { throw "The installation payload is incomplete or changed: $relative" }
        $actualCount++
      }
    }
    if ($actualCount -ne $expectedFiles.Count) { throw 'The installation payload is incomplete.' }
    $legacy = $null
    if ([IO.Directory]::Exists($root)) {
      $rootHandle = Open-Checked $root $true; [void]$directoryHandles.Add($rootHandle)
      if ($installedId) {
        $legacy = [pscustomobject]@{ Exe=$currentEntry; Uninstaller=$currentUninstaller }
      } elseif ($registered) {
        $found = @(@(
          [pscustomobject]@{ Exe='LLMMarkUp.exe'; Uninstaller='Uninstall LLMMarkUp.exe' },
          [pscustomobject]@{ Exe='MDPPT Studio.exe'; Uninstaller='Uninstall MDPPT Studio.exe' }
        ) | Where-Object { [IO.File]::Exists([IO.Path]::Combine($root, $_.Exe)) -and [IO.File]::Exists([IO.Path]::Combine($root, $_.Uninstaller)) })
        if ($found.Count -ne 1) { throw 'The existing installation cannot be identified safely.' }
        $legacy = $found[0]
      } else {
        foreach ($name in @('LLMMarkUp.exe','MDPPT Studio.exe','Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) {
          if ([IO.File]::Exists([IO.Path]::Combine($root, $name)) -or [IO.Directory]::Exists([IO.Path]::Combine($root, $name))) { throw 'An existing unregistered entrypoint was preserved.' }
        }
      }
    } else {
      if ($registered) { throw 'The registered installation directory is missing.' }
      Create-Directory $root
      $rootHandle = Open-Checked $root $true; [void]$directoryHandles.Add($rootHandle)
    }
    $versions = [IO.Path]::Combine($root, '.llmmarkup-versions')
    if (-not [IO.Directory]::Exists($versions)) { Create-Directory $versions }
    $versionsHandle = Open-Checked $versions $true; [void]$directoryHandles.Add($versionsHandle)
    if (-not (Final-Path $versionsHandle).StartsWith(((Final-Path $rootHandle) + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation directory resolves outside its root.' }
    $installId = [guid]::NewGuid().ToString('D')
    $runtime = [IO.Path]::Combine($versions, $installId)
    Create-Directory $runtime
    $runtimeHandle = Open-Checked $runtime $true; [void]$directoryHandles.Add($runtimeHandle)
    $records = [Collections.ArrayList]::new()
    foreach ($item in $payloadItems) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or -not $item.FullName.StartsWith($payloadPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation payload contains an unexpected link or path.' }
      $relative = $item.FullName.Substring($payloadPrefix.Length)
      $destination = [IO.Path]::Combine($runtime, $relative)
      if ($item.PSIsContainer) { Create-Directory $destination }
      else {
        Copy-NewFile $item.FullName $destination
        $copiedHash = Hash-File $destination
        $expectedHash = if ($relative -ieq 'llmmarkup-payload-manifest.json') { $payloadManifestHash } else { $expectedFiles[$relative] }
        if ($copiedHash -ne $expectedHash) { throw 'An installation file changed while copying.' }
        [void]$records.Add([ordered]@{ path=$relative; sha256=$copiedHash })
      }
    }
    $runtimeUninstaller = [IO.Path]::Combine($runtime, 'llmmarkup-uninstall.exe')
    Copy-NewFile $UninstallerPath $runtimeUninstaller
    [void]$records.Add([ordered]@{ path='llmmarkup-uninstall.exe'; sha256=(Hash-File $runtimeUninstaller) })
    $launcher = [IO.Path]::Combine($runtime, 'llmmarkup-launcher.exe')
    if (-not [IO.File]::Exists($launcher) -or -not [IO.File]::Exists([IO.Path]::Combine($runtime, 'LLMMarkUp.exe'))) { throw 'The application payload lacks its required entrypoints.' }
    $manifest = [ordered]@{ schema=1; product='llmmarkup'; files=@($records) }
    $manifestBytes = [Text.UTF8Encoding]::new($false).GetBytes(($manifest | ConvertTo-Json -Depth 5 -Compress))
    $manifestHash = Hash-Bytes $manifestBytes
    $manifestPath = [IO.Path]::Combine($runtime, '.llmmarkup-manifest.json')
    Write-NewFile $manifestPath $manifestBytes
    $marker = [ordered]@{ schema=1; product='llmmarkup'; installId=$installId; manifestSha256=$manifestHash }
    Write-NewFile ([IO.Path]::Combine($runtime, '.llmmarkup-owned.json')) ([Text.UTF8Encoding]::new($false).GetBytes(($marker | ConvertTo-Json -Compress)))
    $entryName = if ($legacy) { $legacy.Exe } else { 'LLMMarkUp.exe' }
    $uninstallName = if ($legacy) { $legacy.Uninstaller } else { 'Uninstall LLMMarkUp.exe' }
    $writes = @(New-RegistryPlan $installId $manifestHash $entryName $uninstallName $Version)
    $snapshots = @($writes | ForEach-Object { Registry-Snapshot $base $_ })
    $pending = [ordered]@{ schema=1; product='llmmarkup'; mode='install'; version=$Version; installId=$installId; previousInstallId=$installedId; previousManifestHash=$previousManifestHash; legacy=[bool]$legacy; entryName=$entryName; uninstallerName=$uninstallName; manifestHash=$manifestHash; launcherHash=(Hash-File $launcher); uninstallerHash=(Hash-File $runtimeUninstaller); registry=$snapshots }
    $pendingBytes = [Text.UTF8Encoding]::new($false).GetBytes(($pending | ConvertTo-Json -Depth 8 -Compress))
    $pendingStage = [IO.Path]::Combine($runtime, '.llmmarkup-pending.tmp')
    Write-NewFile $pendingStage $pendingBytes
    if (-not [LLMMarkUpInstallerNative]::MoveFileEx($pendingStage, $pendingPath, 0)) { throw 'Cannot create the installation transaction record.' }
    Set-PendingLocation $base
    if ($legacy) {
      $migrationArgs = @('-Mode','Begin','-InstallRoot',$root,'-RuntimeRoot',$runtime,'-InstallId',$installId,'-LegacyExecutable',$entryName,'-LegacyUninstaller',$uninstallName,'-LauncherPath',$launcher,'-SafeUninstallerPath',$runtimeUninstaller,'-ManifestPath',$manifestPath)
      if ($installedId) { $migrationArgs += @('-ExistingInstallId',$installedId,'-ExistingManifestHash',$previousManifestHash) }
      Invoke-Helper ([IO.Path]::Combine($HelperDirectory, 'safe-migrate.ps1')) $migrationArgs
      $migrated = $true
    } else {
      $index = 0
      foreach ($pair in @(@($launcher,$entryName), @($runtimeUninstaller,$uninstallName))) {
        $target = [IO.Path]::Combine($root, $pair[1]); $stage = [IO.Path]::Combine($runtime, ('entrypoint-' + $index + '.tmp'))
        Copy-NewFile $pair[0] $stage
        if ((Hash-File $stage) -ne (Hash-File $pair[0]) -or -not [LLMMarkUpInstallerNative]::MoveFileEx($stage, $target, 0)) { throw 'Cannot install a verified entrypoint without replacing an existing file.' }
        [void]$createdEntries.Add([pscustomobject]@{ Path=$target; Hash=(Hash-File $pair[0]) })
        $index++
      }
    }
    for ($i=0; $i -lt $writes.Count; $i++) {
      $current = Registry-Snapshot $base $writes[$i]; $expected = $snapshots[$i]
      if ($current.Present -ne $expected.Present -or $current.Old -ne $expected.Old -or $current.Kind -ne $expected.Kind) { throw 'An installation registry value changed during setup.' }
      [void]$registryJournal.Add((Registry-Write $base $writes[$i]))
      if ($env:LLMMARKUP_INSTALL_TEST_PAUSE -eq ('after-write-' + $i)) {
        if (-not $env:LLMMARKUP_TEST_DATA -or -not $root.Equals([IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'install'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic pause requires an isolated test installation.' }
        [IO.File]::WriteAllText([IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'installation-paused'), [string]$PID)
        while ($true) { [Threading.Thread]::Sleep(1000) }
      }
    }
    $committed = $true
    try { Remove-Verified $pendingPath (Hash-Bytes $pendingBytes) $root; Remove-PendingLocation $base } catch {}
    if ($previousAppHandle) {
      $previousAppHandle.Dispose()
      try { Cleanup-Previous $installedId $previousManifestHash } catch {}
    }
    try { Ensure-Shortcuts $base $entryName } catch {}
    if (-not $env:LLMMARKUP_TEST_DATA) { [LLMMarkUpInstallerNative]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero) }
    Write-Output 'Installation completed.'
  } else {
    if (-not $registered -or -not $installedId) { throw 'No installation with the new layout is registered.' }
    if ($installedId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Invalid installation identity.' }
    $entryName = Registry-Value $base $appKey 'EntryName'
    $uninstallName = Registry-Value $base $appKey 'UninstallerName'
    $runtime = [IO.Path]::Combine($root, '.llmmarkup-versions', $installedId)
    $manifestPath = [IO.Path]::Combine($runtime, '.llmmarkup-manifest.json')
    $actualHash = Hash-File $manifestPath
    if ($actualHash -ne (Registry-Value $base $appKey 'CurrentManifestSha256')) { throw 'The installation record and manifest disagree.' }
    $classes = 'Software\Classes\'
    $command = '"' + [IO.Path]::Combine($root, $entryName) + '" "%1"'
    $ownsProgId = (Registry-Value $base ($classes + 'LLMMarkUp.Markdown\shell\open\command') '') -eq $command
    $ownsApplication = (Registry-Value $base ($classes + 'Applications\LLMMarkUp.exe\shell\open\command') '') -eq $command
    $markerPath = [IO.Path]::Combine($runtime, '.llmmarkup-owned.json')
    $pending = [ordered]@{ schema=1; product='llmmarkup'; mode='uninstall'; version=$Version; installId=$installedId; entryName=$entryName; uninstallerName=$uninstallName; manifestHash=$actualHash; markerHash=(Hash-File $markerPath); ownsProgId=$ownsProgId; ownsApplication=$ownsApplication }
    $pendingBytes = [Text.UTF8Encoding]::new($false).GetBytes(($pending | ConvertTo-Json -Depth 5 -Compress))
    $pendingStage = [IO.Path]::Combine($runtime, '.llmmarkup-uninstall-pending.tmp')
    Write-NewFile $pendingStage $pendingBytes
    if (-not [LLMMarkUpInstallerNative]::MoveFileEx($pendingStage, $pendingPath, 0)) { throw 'Cannot create the uninstall transaction record.' }
    Set-PendingLocation $base
    Complete-Uninstall $base ([pscustomobject]$pending) $pendingPath $pendingBytes $false
    $committed = $true
    Write-Output 'Owned application files were removed; user files were preserved.'
  }
} catch {
  $errorText = $_.Exception.Message
  if ($Mode -eq 'Install' -and -not $committed) {
    try { Registry-Restore $base $registryJournal } catch { $errorText += ' Registry rollback stopped; changed values were preserved.' }
    if ($migrated) {
      try {
        $migrationArgs[1] = 'Rollback'
        Invoke-Helper ([IO.Path]::Combine($HelperDirectory, 'safe-migrate.ps1')) $migrationArgs
      } catch { $errorText += ' Legacy rollback stopped; the backup and journal were preserved.' }
    } else {
      foreach ($entry in $createdEntries) { try { Remove-Verified $entry.Path $entry.Hash $root } catch { $errorText += ' A changed entrypoint was preserved.' } }
    }
  }
  [Console]::Error.WriteLine('Installation operation stopped: ' + $errorText)
} finally {
  foreach ($handle in $directoryHandles) { $handle.Dispose() }
  $base.Dispose()
}
if (-not $committed) { exit 2 }
exit 0
