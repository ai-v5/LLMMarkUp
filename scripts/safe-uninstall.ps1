# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [Parameter(Mandatory=$true)][string]$InstallId,
  [string]$EntrypointName,
  [string]$UninstallerName,
  [switch]$PreserveRecords,
  [switch]$Resume
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpOwnedCleanup {
  [StructLayout(LayoutKind.Sequential)] public struct AttributeTag { public uint Attributes; public uint Tag; }
  [StructLayout(LayoutKind.Sequential)] public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int klass, out AttributeTag info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle, int klass, ref Disposition info, uint size);
}
'@

function Hash-Bytes([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Open-Checked([string]$Path, [bool]$Directory) {
  $access = if ($Directory) { [uint32]128 } else { [uint32]2147549184 }
  $share = if ($Directory) { [uint32]3 } else { [uint32]0 }
  $flags = if ($Directory) { [uint32]0x02200000 } else { [uint32]0x00200080 }
  $handle = [LLMMarkUpOwnedCleanup]::CreateFile($Path, $access, $share, [IntPtr]::Zero, 3, $flags, [IntPtr]::Zero)
  if ($handle.IsInvalid) { throw 'An installed path is unavailable or in use.' }
  $info = [LLMMarkUpOwnedCleanup+AttributeTag]::new()
  if (-not [LLMMarkUpOwnedCleanup]::GetFileInformationByHandleEx($handle, 9, [ref]$info, 8)) { $handle.Dispose(); throw 'Cannot inspect an installed path.' }
  if (($info.Attributes -band 0x400) -ne 0 -or (($info.Attributes -band 0x10) -ne 0) -ne $Directory) {
    $handle.Dispose(); throw 'An installed path has an unexpected type or reparse point.'
  }
  return $handle
}
function Final-Path($Handle) {
  $buffer = [Text.StringBuilder]::new(32768)
  $length = [LLMMarkUpOwnedCleanup]::GetFinalPathNameByHandle($Handle, $buffer, [uint32]$buffer.Capacity, 0)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot resolve an installed path.' }
  return $buffer.ToString().TrimEnd('\')
}
function Open-OwnedFile([string]$Path, [string]$RootPrefix) {
  $handle = Open-Checked $Path $false
  try {
    $final = Final-Path $handle
    if (-not $final.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'An installed file resolves outside its owned directory.' }
    return [IO.FileStream]::new($handle, [IO.FileAccess]::Read)
  } catch { $handle.Dispose(); throw }
}
function Hash-Stream([IO.Stream]$Stream) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}

$directoryHandles = [Collections.ArrayList]::new()
$streams = [Collections.ArrayList]::new()
$marked = [Collections.ArrayList]::new()
$directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$complete = $false
try {
  if ($Resume -and -not $PreserveRecords) { throw 'Resuming cleanup requires the installation records.' }
  if ($InstallId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Invalid installation identity.' }
  $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $parent = [IO.Path]::GetDirectoryName($root)
  if ([IO.Path]::GetFileName($root) -ne $InstallId -or [IO.Path]::GetFileName($parent) -ne '.llmmarkup-versions') { throw 'The installation directory does not match its identity.' }
  $manifestBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ManifestPath).Path)
  $manifestHash = Hash-Bytes $manifestBytes
  $manifest = [Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes) | ConvertFrom-Json
  if ($manifest.schema -ne 1 -or $manifest.product -ne 'llmmarkup' -or -not ($manifest.files -is [array]) -or $manifest.files.Count -eq 0 -or $manifest.files.Count -gt 10000) { throw 'Invalid installation manifest.' }

  $items = [Collections.ArrayList]::new()
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $manifest.files) {
    if ($entry.path -isnot [string] -or $entry.sha256 -isnot [string] -or $entry.sha256 -notmatch '^[0-9a-fA-F]{64}$' -or [IO.Path]::IsPathRooted($entry.path)) { throw 'Invalid manifest entry.' }
    $parts = @($entry.path -split '[\\/]')
    if ($parts.Count -eq 0 -or @($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $_ -match '[<>:"|?*\x00-\x1f]' -or $_ -match '[. ]$' }).Count -ne 0) { throw 'Invalid manifest path.' }
    $relative = $parts -join '\'
    if ($relative -ieq '.llmmarkup-owned.json' -or -not $seen.Add($relative)) { throw 'Duplicate or reserved manifest path.' }
    [void]$items.Add([pscustomobject]@{ Relative=$relative; Hash=$entry.sha256.ToLowerInvariant() })
    $dir = $root
    for ($i=0; $i -lt $parts.Count-1; $i++) { $dir = [IO.Path]::Combine($dir, $parts[$i]); [void]$directories.Add($dir) }
  }
  if (-not $seen.Contains('LLMMarkUp.exe')) { throw 'Manifest lacks the application executable.' }

  $rootHandle = Open-Checked $root $true
  [void]$directoryHandles.Add($rootHandle)
  $rootPrefix = (Final-Path $rootHandle) + '\'
  foreach ($dir in @($directories | Sort-Object Length)) {
    if (-not [IO.Directory]::Exists($dir)) {
      if ([IO.File]::Exists($dir)) { throw 'A required directory is occupied by a file.' }
      continue
    }
    $handle = Open-Checked $dir $true
    [void]$directoryHandles.Add($handle)
    if (-not (Final-Path $handle).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'An installed directory resolves outside its owned root.' }
  }

  $markerStream = Open-OwnedFile ([IO.Path]::Combine($root, '.llmmarkup-owned.json')) $rootPrefix
  [void]$streams.Add([pscustomobject]@{ Stream=$markerStream; Relative='.llmmarkup-owned.json'; Keep=[bool]$PreserveRecords })
  $memory = [IO.MemoryStream]::new()
  try { $markerStream.CopyTo($memory); $marker = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray()) | ConvertFrom-Json }
  finally { $memory.Dispose() }
  if ($marker.schema -ne 1 -or $marker.product -ne 'llmmarkup' -or $marker.installId -ne $InstallId -or $marker.manifestSha256 -ne $manifestHash) { throw 'Installation ownership cannot be verified.' }

  $preserved = 0
  if ($EntrypointName -or $UninstallerName) {
    if ($EntrypointName -notin @('LLMMarkUp.exe','MDPPT Studio.exe') -or
        $UninstallerName -notin @('Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) { throw 'Invalid installation entrypoints.' }
    $installParent = [IO.Path]::GetDirectoryName($parent)
    $installHandle = Open-Checked $installParent $true
    [void]$directoryHandles.Add($installHandle)
    $installPrefix = (Final-Path $installHandle) + '\'
    if (-not $rootPrefix.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The runtime does not belong to the installation root.' }
    foreach ($pair in @(@($EntrypointName, 'llmmarkup-launcher.exe'), @($UninstallerName, 'llmmarkup-uninstall.exe'))) {
      $record = @($items | Where-Object { $_.Relative -ieq $pair[1] })
      if ($record.Count -ne 1) { throw 'The installation entrypoint is not recorded in the manifest.' }
      $entryPath = [IO.Path]::Combine($installParent, $pair[0])
      if ([IO.Directory]::Exists($entryPath)) { throw 'An installation entrypoint has changed type.' }
      if ([IO.File]::Exists($entryPath)) {
        $entryStream = Open-OwnedFile $entryPath $installPrefix
        if ((Hash-Stream $entryStream) -eq $record[0].Hash) {
          [void]$streams.Add([pscustomobject]@{ Stream=$entryStream; Relative=('entrypoint:' + $pair[0]) })
        } else { $entryStream.Dispose(); $preserved++ }
      }
    }
    $runtimeManifest = [IO.Path]::Combine($root, '.llmmarkup-manifest.json')
    if (-not [IO.Path]::GetFullPath($ManifestPath).Equals($runtimeManifest, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installation manifest is outside its runtime.' }
    $manifestStream = Open-OwnedFile $runtimeManifest $rootPrefix
    if ((Hash-Stream $manifestStream) -ne $manifestHash) { $manifestStream.Dispose(); throw 'The installation manifest changed.' }
    [void]$streams.Add([pscustomobject]@{ Stream=$manifestStream; Relative='.llmmarkup-manifest.json'; Keep=[bool]$PreserveRecords })
  }

  $hasExecutable = $false
  foreach ($item in $items) {
    $target = [IO.Path]::Combine($root, $item.Relative)
    if (-not [IO.File]::Exists($target)) {
      if (($item.Relative -ieq 'LLMMarkUp.exe' -and -not $Resume) -or [IO.Directory]::Exists($target)) { throw 'An expected application file is missing or has changed type.' }
      continue
    }
    $stream = Open-OwnedFile $target $rootPrefix
    $actual = Hash-Stream $stream
    if ($actual -ne $item.Hash) {
      $stream.Dispose()
      if ($item.Relative -ieq 'LLMMarkUp.exe') { throw 'The application executable was changed.' }
      $preserved++
      continue
    }
    if ($item.Relative -ieq 'LLMMarkUp.exe') { $hasExecutable = $true }
    [void]$streams.Add([pscustomobject]@{ Stream=$stream; Relative=$item.Relative })
  }
  if (-not $hasExecutable -and -not $Resume) { throw 'The application executable cannot be verified.' }

  foreach ($item in @($streams | Sort-Object { if ($_.Relative -ieq 'LLMMarkUp.exe') { 0 } elseif ($_.Relative -ieq '.llmmarkup-owned.json') { 2 } else { 1 } })) {
    if ($item.Keep) { continue }
    $disposition = [LLMMarkUpOwnedCleanup+Disposition]::new()
    $disposition.DeleteFile = $true
    if (-not [LLMMarkUpOwnedCleanup]::SetFileInformationByHandle($item.Stream.SafeFileHandle, 4, [ref]$disposition, 4)) { throw 'An owned file could not be removed safely.' }
    [void]$marked.Add($item.Stream)
    if ($env:LLMMARKUP_UNINSTALL_TEST_PAUSE -eq 'during-cleanup' -and $marked.Count -eq 1) {
      if (-not $env:LLMMARKUP_TEST_DATA -or -not $root.Equals([IO.Path]::Combine([IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA), 'install', '.llmmarkup-versions', $InstallId), [StringComparison]::OrdinalIgnoreCase)) { throw 'Synthetic pause requires an isolated test installation.' }
      [IO.File]::WriteAllText([IO.Path]::Combine($env:LLMMARKUP_TEST_DATA, 'uninstall-paused'), [string]$PID)
      while ($true) { [Threading.Thread]::Sleep(1000) }
    }
  }
  $complete = $true
} catch {
  foreach ($stream in $marked) {
    $disposition = [LLMMarkUpOwnedCleanup+Disposition]::new()
    $disposition.DeleteFile = $false
    [void][LLMMarkUpOwnedCleanup]::SetFileInformationByHandle($stream.SafeFileHandle, 4, [ref]$disposition, 4)
  }
  [Console]::Error.WriteLine('Uninstall stopped safely: ' + $_.Exception.Message)
} finally {
  foreach ($item in $streams) { $item.Stream.Dispose() }
  foreach ($handle in $directoryHandles) { $handle.Dispose() }
}

if (-not $complete) { exit 2 }
foreach ($dir in @($directories | Sort-Object Length -Descending)) {
  try { if ([IO.Directory]::Exists($dir) -and (([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) -eq 0)) { [IO.Directory]::Delete($dir, $false) } } catch {}
}
try { [IO.Directory]::Delete($root, $false) } catch {}
Write-Output "Owned files removed; modified files preserved: $preserved"
exit 0
