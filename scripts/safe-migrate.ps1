# SPDX-License-Identifier: AGPL-3.0-only
param(
  [Parameter(Mandatory=$true)][ValidateSet('Begin','Rollback')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$InstallRoot,
  [Parameter(Mandatory=$true)][string]$RuntimeRoot,
  [Parameter(Mandatory=$true)][string]$InstallId,
  [Parameter(Mandatory=$true)][string]$LegacyExecutable,
  [Parameter(Mandatory=$true)][string]$LegacyUninstaller,
  [Parameter(Mandatory=$true)][string]$LauncherPath,
  [Parameter(Mandatory=$true)][string]$SafeUninstallerPath,
  [Parameter(Mandatory=$true)][string]$ManifestPath,
  [string]$ExistingInstallId,
  [string]$ExistingManifestHash
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpMigrationNative {
  [StructLayout(LayoutKind.Sequential)] public struct AttributeTag { public uint Attributes; public uint Tag; }
  [StructLayout(LayoutKind.Sequential)] public struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool DeleteFile; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool CreateDirectory(string path, IntPtr security);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool MoveFileEx(string source, string target, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int klass, out AttributeTag info, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetFinalPathNameByHandle(SafeFileHandle handle, StringBuilder path, uint length, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] public static extern bool SetFileInformationByHandle(SafeFileHandle handle, int klass, ref Disposition info, uint size);
  [DllImport("kernel32.dll", EntryPoint="SetFileInformationByHandle", SetLastError=true)] [return:MarshalAs(UnmanagedType.Bool)] private static extern bool SetFileInformationBuffer(SafeFileHandle handle, int klass, IntPtr info, uint size);
  public static bool RenameByHandle(SafeFileHandle handle, string target) {
    byte[] name = Encoding.Unicode.GetBytes(target);
    int root = IntPtr.Size == 8 ? 8 : 4;
    int length = root + IntPtr.Size;
    int offset = length + 4;
    int size = offset + name.Length + 2;
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      for (int i=0; i<size; i++) Marshal.WriteByte(buffer, i, 0);
      Marshal.WriteIntPtr(buffer, root, IntPtr.Zero);
      Marshal.WriteInt32(buffer, length, name.Length);
      Marshal.Copy(name, 0, IntPtr.Add(buffer, offset), name.Length);
      return SetFileInformationBuffer(handle, 3, buffer, (uint)size);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
}
'@

function Hash-Bytes([byte[]]$Bytes) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Hash-Stream([IO.Stream]$Stream) {
  $Stream.Position = 0
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $Stream.Position = 0 }
}
function Hash-Gzip([IO.Stream]$Stream) {
  $Stream.Position = 0
  $gzip = [IO.Compression.GZipStream]::new($Stream, [IO.Compression.CompressionMode]::Decompress, $true)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($gzip)).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $gzip.Dispose(); $Stream.Position = 0 }
}
function Write-VerifiedBackup([IO.FileStream]$Source, [string]$Target, [string]$ExpectedHash) {
  $file = [IO.FileStream]::new($Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Compress, $true)
    try { $Source.Position = 0; $Source.CopyTo($gzip) } finally { $gzip.Dispose(); $Source.Position = 0 }
    $file.Flush($true)
  } finally { $file.Dispose() }
  $verify = [IO.File]::Open($Target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { if ((Hash-Gzip $verify) -ne $ExpectedHash) { throw 'A legacy backup could not be verified.' } }
  finally { $verify.Dispose() }
}
function Open-Checked([string]$Path, [bool]$Directory, [bool]$AllowMove) {
  $access = if ($Directory) { [uint32]128 } elseif ($AllowMove) { [uint32]2147549184 } else { [uint32]2147483648 }
  $share = if ($Directory) { [uint32]3 } elseif ($AllowMove) { [uint32]0 } else { [uint32]1 }
  $flags = if ($Directory) { [uint32]0x02200000 } else { [uint32]0x00200080 }
  $handle = [LLMMarkUpMigrationNative]::CreateFile($Path, $access, $share, [IntPtr]::Zero, 3, $flags, [IntPtr]::Zero)
  if ($handle.IsInvalid) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "An installation path is unavailable or in use (directory=$Directory, code=$code)." }
  $info = [LLMMarkUpMigrationNative+AttributeTag]::new()
  if (-not [LLMMarkUpMigrationNative]::GetFileInformationByHandleEx($handle, 9, [ref]$info, 8)) { $handle.Dispose(); throw 'Cannot inspect an installation path.' }
  if (($info.Attributes -band 0x400) -ne 0 -or (($info.Attributes -band 0x10) -ne 0) -ne $Directory) { $handle.Dispose(); throw 'An installation path has an unexpected type or reparse point.' }
  return $handle
}
function Final-Path($Handle) {
  $buffer = [Text.StringBuilder]::new(32768)
  $length = [LLMMarkUpMigrationNative]::GetFinalPathNameByHandle($Handle, $buffer, [uint32]$buffer.Capacity, 0)
  if ($length -eq 0 -or $length -ge $buffer.Capacity) { throw 'Cannot resolve an installation path.' }
  return $buffer.ToString().TrimEnd('\')
}
function Open-Stream([string]$Path, [bool]$AllowMove, [string]$RootPrefix) {
  $handle = Open-Checked $Path $false $AllowMove
  try {
    if (-not (Final-Path $handle).StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'An installation file resolves outside its root.' }
    return [IO.FileStream]::new($handle, [IO.FileAccess]::Read)
  } catch { $handle.Dispose(); throw }
}
function Read-LegacyIdentity([IO.FileStream]$Stream) {
  $reader = [IO.BinaryReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $true)
  try {
    if ($Stream.Length -lt 16 -or $reader.ReadUInt32() -ne 4) { throw 'Invalid legacy application archive.' }
    $headerSize = [int64]$reader.ReadUInt32()
    if ($headerSize -lt 8 -or $headerSize -gt 16777216 -or 8+$headerSize -gt $Stream.Length) { throw 'Invalid legacy application header.' }
    $payloadSize = [int64]$reader.ReadUInt32()
    $jsonSize = [int64]$reader.ReadInt32()
    if ($payloadSize+4 -ne $headerSize -or $jsonSize -lt 2 -or $jsonSize -gt $headerSize-8) { throw 'Invalid legacy application metadata.' }
    $headerBytes = $reader.ReadBytes([int]$jsonSize)
    if ($headerBytes.Length -ne $jsonSize) { throw 'Incomplete legacy application metadata.' }
    $header = [Text.UTF8Encoding]::new($false, $true).GetString($headerBytes) | ConvertFrom-Json
    $item = $header.files.'package.json'
    if (-not $item -or $item.unpacked -or $item.link -or $item.size -lt 1 -or $item.size -gt 1048576) { throw 'Legacy application identity is unavailable.' }
    [int64]$offset = 0
    if (-not [int64]::TryParse([string]$item.offset, [ref]$offset) -or $offset -lt 0 -or $offset -gt $Stream.Length-8-$headerSize-[int64]$item.size) { throw 'Invalid legacy application identity offset.' }
    $Stream.Position = 8+$headerSize+$offset
    $packageBytes = $reader.ReadBytes([int]$item.size)
    if ($packageBytes.Length -ne $item.size) { throw 'Incomplete legacy application identity.' }
    $package = [Text.UTF8Encoding]::new($false, $true).GetString($packageBytes) | ConvertFrom-Json
    if ($package.name -notin @('llmmarkup', 'mdppt-studio') -or $package.version -isnot [string]) { throw 'The existing installation is not a recognized application.' }
    return $package
  } finally { $reader.Dispose(); $Stream.Position = 0 }
}
function Move-Locked([IO.FileStream]$Stream, [string]$Source, [string]$Target) {
  if (-not [LLMMarkUpMigrationNative]::RenameByHandle($Stream.SafeFileHandle, $Target)) { $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw "Cannot move a locked entrypoint without replacing another file (code=$code)." }
  $full = [IO.Path]::GetFullPath($Target)
  $expected = if ($full.StartsWith('\\')) { '\\?\UNC\' + $full.Substring(2) } else { '\\?\' + $full }
  if (-not (Final-Path $Stream.SafeFileHandle).Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
    if (-not [LLMMarkUpMigrationNative]::RenameByHandle($Stream.SafeFileHandle, $Source)) { throw 'An entrypoint was moved to an unexpected path; its handle could not be restored.' }
    throw 'An entrypoint move did not reach its intended path and was reverted.'
  }
}
function Restore-Transaction($Journal, [string]$Root, [string]$Runtime, [string]$RootPrefix) {
  $ops = @($Journal.operations)
  if ($Journal.schema -ne 1 -or $Journal.product -ne 'llmmarkup' -or $Journal.installId -ne $InstallId -or $ops.Count -ne 2) { throw 'Invalid migration journal.' }
  $expected = @($LegacyExecutable, $LegacyUninstaller)
  $locked = [Collections.ArrayList]::new()
  $dirs = [Collections.ArrayList]::new()
  $entries = [Collections.ArrayList]::new()
  try {
    foreach ($dir in @([IO.Path]::Combine($Root, '.llmmarkup-versions'), $Runtime, [IO.Path]::Combine($Runtime, '.legacy-backup'))) {
      $directory = Open-Checked $dir $true $false; [void]$dirs.Add($directory)
      if (-not (Final-Path $directory).StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'A backup directory resolves outside its installation root.' }
    }
    for ($i=0; $i -lt 2; $i++) {
      $op = $ops[$i]
      if ($op.name -ne $expected[$i] -or $op.oldHash -notmatch '^[0-9a-f]{64}$' -or $op.newHash -notmatch '^[0-9a-f]{64}$') { throw 'Invalid migration journal entry.' }
      $original = [IO.Path]::Combine($Root, $op.name)
      $backup = [IO.Path]::Combine($Runtime, '.legacy-backup', ($op.name + '.gz'))
      $backupStream = $null; $originalStream = $null
      $restore = $false
      if ([IO.File]::Exists($original)) {
        $originalStream = Open-Stream $original $true $RootPrefix; [void]$locked.Add($originalStream)
        $currentHash = Hash-Stream $originalStream
        if ($currentHash -eq $op.oldHash) { $restore = $false }
        elseif ($currentHash -eq $op.newHash) { $restore = $true }
        else { throw 'An entrypoint was changed; it will be preserved.' }
      } else { $restore = $true }
      if ($restore) {
        if (-not [IO.File]::Exists($backup)) { throw 'A legacy entrypoint and its backup are both missing.' }
        $backupStream = Open-Stream $backup $false $RootPrefix; [void]$locked.Add($backupStream)
        if ((Hash-Gzip $backupStream) -ne $op.oldHash) { throw 'A legacy backup was changed; it will be preserved.' }
      }
      $restorePath = $null; $restoreStream = $null
      if ($restore) {
        $restorePath = [IO.Path]::Combine($Runtime, '.legacy-backup', ('restore-' + [guid]::NewGuid().ToString('N') + '.tmp'))
        $file = [IO.FileStream]::new($restorePath, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        try {
          $backupStream.Position = 0
          $gzip = [IO.Compression.GZipStream]::new($backupStream, [IO.Compression.CompressionMode]::Decompress, $true)
          try { $gzip.CopyTo($file) } finally { $gzip.Dispose(); $backupStream.Position = 0 }
          $file.Flush($true); $file.Position = 0
          if ((Hash-Stream $file) -ne $op.oldHash) { throw 'A staged legacy entrypoint could not be verified.' }
        } finally { $file.Dispose() }
        $restoreStream = Open-Stream $restorePath $true $RootPrefix; [void]$locked.Add($restoreStream)
        if ((Hash-Stream $restoreStream) -ne $op.oldHash) { throw 'A staged legacy entrypoint changed.' }
      }
      [void]$entries.Add([pscustomobject]@{ Original=$original; RestorePath=$restorePath; OriginalStream=$originalStream; RestoreStream=$restoreStream; Restore=$restore })
    }
    if (@(Get-Process -Name 'LLMMarkUp','MDPPT Studio','Uninstall LLMMarkUp','Uninstall MDPPT Studio','old-uninstaller','Au_' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'An application or uninstaller is running; recovery was stopped.' }
    for ($i=1; $i -ge 0; $i--) {
      $entry = $entries[$i]
      if ($entry.Restore) {
        if ($entry.OriginalStream) {
          $disposition = [LLMMarkUpMigrationNative+Disposition]::new(); $disposition.DeleteFile = $true
          if (-not [LLMMarkUpMigrationNative]::SetFileInformationByHandle($entry.OriginalStream.SafeFileHandle, 4, [ref]$disposition, 4)) { throw 'Cannot remove an unchanged replacement entrypoint.' }
          $entry.OriginalStream.Dispose()
        }
        Move-Locked $entry.RestoreStream $entry.RestorePath $entry.Original
      }
    }
  } finally {
    foreach ($stream in $locked) { $stream.Dispose() }
    foreach ($directory in $dirs) { $directory.Dispose() }
  }
}

$handles = [Collections.ArrayList]::new()
$streams = [Collections.ArrayList]::new()
$journal = $null
$journalWritten = $false
$failure = $null
$stage = 'validate'
$syntheticFailure = $null
$syntheticPause = $null
try {
  if ($InstallId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { throw 'Invalid installation identity.' }
  if ($LegacyExecutable -notin @('LLMMarkUp.exe','MDPPT Studio.exe') -or $LegacyUninstaller -notin @('Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) { throw 'Unrecognized legacy entrypoint name.' }
  $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  $runtime = [IO.Path]::GetFullPath($RuntimeRoot).TrimEnd('\')
  $expectedRuntime = [IO.Path]::Combine($root, '.llmmarkup-versions', $InstallId)
  if (-not $runtime.Equals($expectedRuntime, [StringComparison]::OrdinalIgnoreCase) -or $root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Invalid installation root or runtime.' }
  if ($env:LLMMARKUP_MIGRATION_TEST_FAIL) {
    if (-not $env:LLMMARKUP_TEST_DATA) { throw 'Synthetic failure injection requires an isolated test root.' }
    $testRoot = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA)
    if (-not $root.Equals([IO.Path]::Combine($testRoot, 'legacy-root'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid synthetic migration test root.' }
    if ($env:LLMMARKUP_MIGRATION_TEST_FAIL -notin @('before-first','after-first-backup','after-first-delete','after-first-swap','after-second-backup','after-second-delete','after-second-swap')) { throw 'Invalid synthetic failure point.' }
    $syntheticFailure = $env:LLMMARKUP_MIGRATION_TEST_FAIL
  }
  if ($env:LLMMARKUP_MIGRATION_TEST_PAUSE) {
    if (-not $env:LLMMARKUP_TEST_DATA) { throw 'Synthetic pause requires an isolated test root.' }
    $testRoot = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA)
    if ($root -notin @([IO.Path]::Combine($testRoot, 'legacy-root'), [IO.Path]::Combine($testRoot, 'install')) -or
        $env:LLMMARKUP_MIGRATION_TEST_PAUSE -notin @('during-journal','after-first-delete','after-first-swap','after-second-delete')) { throw 'Invalid synthetic migration pause.' }
    $syntheticPause = $env:LLMMARKUP_MIGRATION_TEST_PAUSE
  }
  foreach ($path in @($LauncherPath, $SafeUninstallerPath)) {
    if (-not [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($path)).Equals($runtime, [StringComparison]::OrdinalIgnoreCase)) { throw 'A replacement source is outside the owned runtime.' }
  }
  $rootHandle = Open-Checked $root $true $false; [void]$handles.Add($rootHandle)
  $rootPrefix = (Final-Path $rootHandle) + '\'
  $requiredDirs = @([IO.Path]::Combine($root, '.llmmarkup-versions'), $runtime)
  if (-not $ExistingInstallId) { $requiredDirs += [IO.Path]::Combine($root, 'resources') }
  foreach ($dir in $requiredDirs) {
    $handle = Open-Checked $dir $true $false; [void]$handles.Add($handle)
    if (-not (Final-Path $handle).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'A migration directory resolves outside its installation root.' }
  }
  $manifestBytes = [IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $ManifestPath).Path)
  $manifest = [Text.UTF8Encoding]::new($false, $true).GetString($manifestBytes) | ConvertFrom-Json
  $stage = 'ownership-marker'
  $markerStream = Open-Stream ([IO.Path]::Combine($runtime, '.llmmarkup-owned.json')) $false $rootPrefix; [void]$streams.Add($markerStream)
  $memory = [IO.MemoryStream]::new()
  try { $markerStream.CopyTo($memory); $marker = [Text.UTF8Encoding]::new($false, $true).GetString($memory.ToArray()) | ConvertFrom-Json }
  finally { $memory.Dispose() }
  if ($manifest.schema -ne 1 -or $manifest.product -ne 'llmmarkup' -or $marker.schema -ne 1 -or $marker.product -ne 'llmmarkup' -or $marker.installId -ne $InstallId -or $marker.manifestSha256 -ne (Hash-Bytes $manifestBytes)) { throw 'The new runtime ownership cannot be verified.' }
  $stage = 'legacy-identity'
  $previousManifest = $null
  if ($ExistingInstallId) {
    if ($ExistingInstallId -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or $ExistingManifestHash -notmatch '^[0-9a-f]{64}$' -or $ExistingInstallId -eq $InstallId) { throw 'The previous installation identity is invalid.' }
    $oldRuntime = [IO.Path]::Combine($root, '.llmmarkup-versions', $ExistingInstallId)
    $oldHandle = Open-Checked $oldRuntime $true $false; [void]$handles.Add($oldHandle)
    if (-not (Final-Path $oldHandle).StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The previous installation is outside its root.' }
    $oldManifestStream = Open-Stream ([IO.Path]::Combine($oldRuntime, '.llmmarkup-manifest.json')) $false $rootPrefix; [void]$streams.Add($oldManifestStream)
    $oldMarkerStream = Open-Stream ([IO.Path]::Combine($oldRuntime, '.llmmarkup-owned.json')) $false $rootPrefix; [void]$streams.Add($oldMarkerStream)
    if ((Hash-Stream $oldManifestStream) -ne $ExistingManifestHash) { throw 'The previous installation manifest changed.' }
    $reader = [IO.StreamReader]::new($oldManifestStream, [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
    try { $previousManifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    $reader = [IO.StreamReader]::new($oldMarkerStream, [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
    try { $oldMarker = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($previousManifest.schema -ne 1 -or $previousManifest.product -ne 'llmmarkup' -or $oldMarker.schema -ne 1 -or $oldMarker.product -ne 'llmmarkup' -or $oldMarker.installId -ne $ExistingInstallId -or $oldMarker.manifestSha256 -ne $ExistingManifestHash) { throw 'The previous installation ownership cannot be verified.' }
  } else {
    $legacyAsar = Open-Stream ([IO.Path]::Combine($root, 'resources', 'app.asar')) $false $rootPrefix; [void]$streams.Add($legacyAsar)
    $legacyPackage = Read-LegacyIdentity $legacyAsar
    if ($legacyPackage.version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:[.-].*)?$') { throw 'The legacy application version is invalid.' }
    $expectedVersion = $Matches[1] + '.' + $Matches[2] + '.' + $Matches[3]
    $expectedProduct = if ($legacyPackage.name -eq 'llmmarkup') { 'LLMMarkUp' } else { 'MDPPT Studio' }
  }
  $journalPath = [IO.Path]::Combine($runtime, '.llmmarkup-migration.json')
  if ($Mode -eq 'Rollback') {
    $journalStream = Open-Stream $journalPath $false $rootPrefix; [void]$streams.Add($journalStream)
    $reader = [IO.StreamReader]::new($journalStream, [Text.UTF8Encoding]::new($false, $true), $false, 1024, $true)
    try { $journal = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    Restore-Transaction $journal $root $runtime $rootPrefix
  } else {
    if ([IO.File]::Exists($journalPath) -or [IO.Directory]::Exists([IO.Path]::Combine($runtime, '.legacy-backup'))) { throw 'A migration record or backup already exists.' }
    foreach ($other in @('LLMMarkUp.exe','MDPPT Studio.exe','Uninstall LLMMarkUp.exe','Uninstall MDPPT Studio.exe')) {
      if ($other -notin @($LegacyExecutable, $LegacyUninstaller) -and ([IO.File]::Exists([IO.Path]::Combine($root, $other)) -or [IO.Directory]::Exists([IO.Path]::Combine($root, $other)))) { throw 'Multiple legacy entrypoints require manual review.' }
    }
    $stage = 'replacement-sources'
    $launcher = Open-Stream ([IO.Path]::GetFullPath($LauncherPath)) $false $rootPrefix; [void]$streams.Add($launcher)
    $safeUninstaller = Open-Stream ([IO.Path]::GetFullPath($SafeUninstallerPath)) $false $rootPrefix; [void]$streams.Add($safeUninstaller)
    $replacementStreams = @($launcher, $safeUninstaller)
    $names = @($LegacyExecutable, $LegacyUninstaller)
    $oldStreams = [Collections.ArrayList]::new()
    $operations = [Collections.ArrayList]::new()
    for ($i=0; $i -lt 2; $i++) {
      $sourceName = [IO.Path]::GetFileName(@($LauncherPath, $SafeUninstallerPath)[$i])
      $matching = @($manifest.files | Where-Object { $_.path -eq $sourceName -and $_.sha256 -match '^[0-9a-fA-F]{64}$' })
      if ($matching.Count -ne 1 -or (Hash-Stream $replacementStreams[$i]) -ne $matching[0].sha256.ToLowerInvariant()) { throw 'A replacement entrypoint cannot be verified.' }
      $oldPath = [IO.Path]::Combine($root, $names[$i])
      $initial = Open-Stream $oldPath $false $rootPrefix
      try {
        $initialHash = Hash-Stream $initial
        if ($previousManifest) {
          $oldName = @('llmmarkup-launcher.exe', 'llmmarkup-uninstall.exe')[$i]
          $oldRecord = @($previousManifest.files | Where-Object { $_.path -eq $oldName -and $_.sha256 -match '^[0-9a-f]{64}$' })
          if ($oldRecord.Count -ne 1 -or $oldRecord[0].sha256 -ne $initialHash) { throw 'The previous entrypoint does not match its installation manifest.' }
        } else {
          $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($oldPath)
          if ($versionInfo.ProductName -ne $expectedProduct -or $versionInfo.ProductVersion -notmatch '^(\d+)\.(\d+)\.(\d+)(?:[.\-+].*)?$' -or ($Matches[1] + '.' + $Matches[2] + '.' + $Matches[3]) -ne $expectedVersion) { throw 'A legacy entrypoint does not match the recognized product and version.' }
        }
      } finally { $initial.Dispose() }
      $stage = 'legacy-entrypoint-' + $i
      $oldStream = Open-Stream $oldPath $true $rootPrefix; [void]$streams.Add($oldStream); [void]$oldStreams.Add($oldStream)
      if ((Hash-Stream $oldStream) -ne $initialHash) { throw 'A legacy entrypoint changed during validation.' }
      [void]$operations.Add([ordered]@{ name=$names[$i]; oldHash=(Hash-Stream $oldStream); newHash=(Hash-Stream $replacementStreams[$i]) })
    }
    if (-not $previousManifest -and (($legacyPackage.name -eq 'llmmarkup' -and $LegacyExecutable -ne 'LLMMarkUp.exe') -or ($legacyPackage.name -eq 'mdppt-studio' -and $LegacyExecutable -ne 'MDPPT Studio.exe'))) { throw 'Legacy executable and application identity disagree.' }
    if (@(Get-Process -Name 'LLMMarkUp','MDPPT Studio','Uninstall LLMMarkUp','Uninstall MDPPT Studio','old-uninstaller','Au_' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'An application or uninstaller is running; close it before migration.' }
    $backupDir = [IO.Path]::Combine($runtime, '.legacy-backup')
    if (-not [LLMMarkUpMigrationNative]::CreateDirectory($backupDir, [IntPtr]::Zero)) { throw 'The legacy backup directory cannot be created exclusively.' }
    $backupHandle = Open-Checked $backupDir $true $false; [void]$handles.Add($backupHandle)
    $journal = [ordered]@{ schema=1; product='llmmarkup'; installId=$InstallId; operations=@($operations) }
    $journalBytes = [Text.UTF8Encoding]::new($false).GetBytes(($journal | ConvertTo-Json -Depth 5 -Compress))
    $journalTemp = [IO.Path]::Combine($backupDir, 'journal.tmp')
    $journalFile = [IO.FileStream]::new($journalTemp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try {
      if ($syntheticPause -eq 'during-journal') {
        $half = [Math]::Max(1, [int]($journalBytes.Length / 2))
        $journalFile.Write($journalBytes, 0, $half); $journalFile.Flush($true)
        [IO.File]::WriteAllText([IO.Path]::Combine($testRoot, 'migration-paused'), [string]$PID)
        while ($true) { [Threading.Thread]::Sleep(1000) }
      }
      $journalFile.Write($journalBytes, 0, $journalBytes.Length); $journalFile.Flush($true)
    } finally { $journalFile.Dispose() }
    if (-not [LLMMarkUpMigrationNative]::MoveFileEx($journalTemp, $journalPath, 0)) { throw 'Cannot create the migration journal without replacing an existing file.' }
    $journalWritten = $true
    if ($syntheticFailure -eq 'before-first') { throw 'Synthetic interruption before first entrypoint.' }
    for ($i=0; $i -lt 2; $i++) {
      $original = [IO.Path]::Combine($root, $names[$i])
      $backup = [IO.Path]::Combine($backupDir, ($names[$i] + '.gz'))
      $stage = 'swap-' + $i
      $stagedPath = [IO.Path]::Combine($backupDir, ('replacement-' + $i + '.tmp'))
      $stagedFile = [IO.FileStream]::new($stagedPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $replacementStreams[$i].Position=0; $replacementStreams[$i].CopyTo($stagedFile); $stagedFile.Flush($true) } finally { $stagedFile.Dispose(); $replacementStreams[$i].Position=0 }
      $stagedStream = Open-Stream $stagedPath $true $rootPrefix; [void]$streams.Add($stagedStream)
      if ((Hash-Stream $stagedStream) -ne $operations[$i].newHash) { throw 'A staged replacement entrypoint could not be verified.' }
      Write-VerifiedBackup $oldStreams[$i] $backup $operations[$i].oldHash
      if (($i -eq 0 -and $syntheticFailure -eq 'after-first-backup') -or ($i -eq 1 -and $syntheticFailure -eq 'after-second-backup')) { throw 'Synthetic interruption after backing up an entrypoint.' }
      $disposition = [LLMMarkUpMigrationNative+Disposition]::new(); $disposition.DeleteFile = $true
      if (-not [LLMMarkUpMigrationNative]::SetFileInformationByHandle($oldStreams[$i].SafeFileHandle, 4, [ref]$disposition, 4)) { throw 'Cannot safely replace a legacy entrypoint.' }
      $oldStreams[$i].Dispose()
      if (($i -eq 0 -and $syntheticPause -eq 'after-first-delete') -or ($i -eq 1 -and $syntheticPause -eq 'after-second-delete')) {
        [IO.File]::WriteAllText([IO.Path]::Combine($testRoot, 'migration-paused'), [string]$PID)
        while ($true) { [Threading.Thread]::Sleep(1000) }
      }
      if (($i -eq 0 -and $syntheticFailure -eq 'after-first-delete') -or ($i -eq 1 -and $syntheticFailure -eq 'after-second-delete')) { throw 'Synthetic interruption after removing an entrypoint.' }
      Move-Locked $stagedStream $stagedPath $original
      if ($i -eq 0 -and $syntheticPause -eq 'after-first-swap') {
        [IO.File]::WriteAllText([IO.Path]::Combine($testRoot, 'migration-paused'), [string]$PID)
        while ($true) { [Threading.Thread]::Sleep(1000) }
      }
      if (($i -eq 0 -and $syntheticFailure -eq 'after-first-swap') -or ($i -eq 1 -and $syntheticFailure -eq 'after-second-swap')) { throw 'Synthetic interruption after replacing an entrypoint.' }
    }
  }
} catch { $failure = $stage + ': ' + $_.Exception.Message }
finally {
  foreach ($stream in $streams) { $stream.Dispose() }
  foreach ($handle in $handles) { $handle.Dispose() }
}

if ($failure -and $journalWritten) {
  try {
    $rootHandle = Open-Checked $root $true $false
    try { Restore-Transaction $journal $root $runtime ((Final-Path $rootHandle) + '\') }
    finally { $rootHandle.Dispose() }
  } catch { $failure += ' Automatic rollback stopped; the legacy backup and journal were preserved.' }
}
if ($failure) { [Console]::Error.WriteLine('Migration stopped: ' + $failure); exit 2 }
Write-Output ('Migration ' + $Mode + ' completed; unrelated files were preserved.')
exit 0
