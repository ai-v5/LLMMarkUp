# SPDX-License-Identifier: AGPL-3.0-only
param(
  [string]$InstallDirectory,
  [string]$BuildOutputDirectory,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
$version = $package.version
$outputDirectory = Join-Path $PSScriptRoot 'outputs\installers'
if ($BuildOutputDirectory) {
  $candidateOutput = [IO.Path]::GetFullPath($BuildOutputDirectory).TrimEnd('\')
  $outputPrefix = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'outputs')).TrimEnd('\') + '\'
  if (-not $candidateOutput.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The build output is outside the workspace.' }
  $outputDirectory = $candidateOutput
}
if ($env:LLMMARKUP_LOCAL_TEST_OUTPUT) {
  if (-not $env:LLMMARKUP_TEST_DATA) { throw 'A local test output requires an isolated test profile.' }
  $candidateOutput = [IO.Path]::GetFullPath($env:LLMMARKUP_LOCAL_TEST_OUTPUT).TrimEnd('\')
  $outputPrefix = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'outputs')).TrimEnd('\') + '\'
  if (-not $candidateOutput.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The local test output is outside the workspace.' }
  $outputDirectory = $candidateOutput
}
$installer = (Resolve-Path -LiteralPath (Join-Path $outputDirectory "LLMMarkUp-$version-Setup.exe")).Path
$processFilter = "Name = 'LLMMarkUp.exe' OR Name = 'MDPPT Studio.exe'"
$running = @(Get-CimInstance Win32_Process -Filter $processFilter)
if (@($running | Where-Object { -not $_.ExecutablePath }).Count -ne 0) {
  throw 'Cannot verify every running application path; no process will be closed.'
}
$locations = @($running | Where-Object { $_.ExecutablePath } | ForEach-Object {
  Split-Path -Parent $_.ExecutablePath
} | Sort-Object -Unique)

function Read-AppPackage([string]$Directory) {
  $readScript = 'const {extractFile}=require(''@electron/asar''); const path=require(''node:path''); const p=JSON.parse(extractFile(path.join(process.argv[1],''resources'',''app.asar''),''package.json'').toString()); console.log(JSON.stringify({name:p.name,version:p.version}));'
  $metadata = node -e $readScript $Directory
  if ($LASTEXITCODE -ne 0) { throw 'Cannot verify the existing application package.' }
  $metadata = $metadata | ConvertFrom-Json
  if ($metadata.name -notin @('llmmarkup', 'mdppt-studio')) { throw 'Target is not LLMMarkUp or its legacy desktop build; no files were changed.' }
  return $metadata
}
function File-Hash([string]$File) {
  $stream = [IO.File]::OpenRead((Resolve-Path -LiteralPath $File).Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '') }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Resolve-InstalledRuntime([string]$Directory, [Microsoft.Win32.RegistryKey[]]$RegistryViews) {
  $root = [IO.Path]::GetFullPath($Directory).TrimEnd('\')
  $matches = @()
  $ownsViews = -not $RegistryViews
  if ($ownsViews) {
    $RegistryViews = @(
      [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry64),
      [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryView]::Registry32)
    )
  }
  foreach ($hive in $RegistryViews) {
    try {
      $key = $hive.OpenSubKey("Software\$($package.build.nsis.guid)")
      if ($key) {
        try {
          $location = $key.GetValue('InstallLocation')
          if ($location -and [IO.Path]::GetFullPath($location).TrimEnd('\').Equals($root, [StringComparison]::OrdinalIgnoreCase)) {
            $id = $key.GetValue('CurrentInstallId')
            if ($id) { $matches += [pscustomobject]@{ Id=$id; Hash=$key.GetValue('CurrentManifestSha256'); Entry=$key.GetValue('EntryName') } }
          }
        } finally { $key.Dispose() }
      }
    } finally { if ($ownsViews) { $hive.Dispose() } }
  }
  $matches = @($matches | Sort-Object Id,Hash,Entry -Unique)
  if ($matches.Count -gt 1) { throw 'Conflicting installation identities were found; no files were changed.' }
  if ($matches.Count -eq 0) { return [pscustomobject]@{ Runtime=$root; Entry='LLMMarkUp.exe'; Id=$null; Hash=$null } }
  $record = $matches[0]
  if ($record.Id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or
      $record.Hash -notmatch '^[0-9a-f]{64}$' -or $record.Entry -notin @('LLMMarkUp.exe','MDPPT Studio.exe')) { throw 'The installed application record is invalid.' }
  $runtime = Join-Path (Join-Path $root '.llmmarkup-versions') $record.Id
  $markerPath = Join-Path $runtime '.llmmarkup-owned.json'
  $manifestPath = Join-Path $runtime '.llmmarkup-manifest.json'
  $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
  if ($marker.product -ne 'llmmarkup' -or $marker.installId -ne $record.Id -or $marker.manifestSha256 -ne $record.Hash -or (File-Hash $manifestPath).ToLowerInvariant() -ne $record.Hash) { throw 'The installed application ownership cannot be verified.' }
  return [pscustomobject]@{ Runtime=$runtime; Entry=$record.Entry; Id=$record.Id; Hash=$record.Hash }
}
function Initialize-SyntheticLaunchProfile([string]$Profile, [string]$OutputRoot, [string]$InstallRoot, $Installed) {
  $profilePath = [IO.Path]::GetFullPath($Profile).TrimEnd('\')
  $outputPath = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
  if (-not [IO.Path]::GetDirectoryName($profilePath).Equals($outputPath, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($profilePath) -notmatch '^local-smoke-[0-9a-f]{32}$' -or -not [IO.Directory]::Exists($profilePath) -or
      ([IO.File]::GetAttributes($profilePath) -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.Directory]::GetFileSystemEntries($profilePath).Length -ne 0 -or
      $Installed.Id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or $Installed.Hash -notmatch '^[0-9a-f]{64}$') { throw 'The isolated local launch profile is invalid.' }
  if (-not ('LLMMarkUpLocalSmokeRegistry' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LLMMarkUpLocalSmokeRegistry {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode)] public static extern int RegLoadAppKey(string file, out SafeRegistryHandle key, uint access, uint options, uint reserved);
}
'@
  }
  $handle = $null
  $status = [LLMMarkUpLocalSmokeRegistry]::RegLoadAppKey([IO.Path]::Combine($profilePath, 'synthetic-registry.dat'), [ref]$handle, 0xF003F, 0, 0)
  if ($status -ne 0 -or $handle.IsInvalid) { throw 'Cannot create the isolated local launch registry.' }
  $base = [Microsoft.Win32.RegistryKey]::FromHandle($handle)
  try {
    $key = $base.CreateSubKey(('Software\' + $package.build.nsis.guid))
    try {
      $key.SetValue('InstallLocation', $InstallRoot, [Microsoft.Win32.RegistryValueKind]::String)
      $key.SetValue('CurrentInstallId', $Installed.Id, [Microsoft.Win32.RegistryValueKind]::String)
      $key.SetValue('CurrentManifestSha256', $Installed.Hash, [Microsoft.Win32.RegistryValueKind]::String)
    } finally { $key.Dispose() }
  } finally { $base.Dispose() }
}
function Start-VerifiedApplication([string]$EntryPath, [string]$Runtime, [string]$IsolatedProfile) {
  $oldProfile = [Environment]::GetEnvironmentVariable('LLMMARKUP_TEST_DATA', 'Process')
  $oldLegacy = [Environment]::GetEnvironmentVariable('LLMMARKUP_TEST_LEGACY_SESSION', 'Process')
  $marker = if ($IsolatedProfile) { '--llmmarkup-local-smoke=' + [IO.Path]::GetFileName($IsolatedProfile) } else { $null }
  try {
    if ($IsolatedProfile) {
      [Environment]::SetEnvironmentVariable('LLMMARKUP_TEST_DATA', $IsolatedProfile, 'Process')
      [Environment]::SetEnvironmentVariable('LLMMARKUP_TEST_LEGACY_SESSION', $null, 'Process')
    }
    $launcher = if ($marker) { Start-Process -FilePath $EntryPath -ArgumentList $marker -PassThru } else { Start-Process -FilePath $EntryPath -PassThru }
  } finally {
    if ($IsolatedProfile) {
      [Environment]::SetEnvironmentVariable('LLMMARKUP_TEST_DATA', $oldProfile, 'Process')
      [Environment]::SetEnvironmentVariable('LLMMARKUP_TEST_LEGACY_SESSION', $oldLegacy, 'Process')
    }
  }
  if (-not $launcher.WaitForExit(15000)) { throw 'The installed version was verified, but the launcher did not report whether reopening succeeded.' }
  if ($launcher.ExitCode -ne 0) { throw "The installed version was verified, but reopening failed (launcher exit code $($launcher.ExitCode))." }
  $expectedExe = [IO.Path]::GetFullPath((Join-Path $Runtime 'LLMMarkUp.exe'))
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $windowReady = $false
  while ([DateTime]::UtcNow -lt $deadline -and -not $windowReady) {
    foreach ($entry in @(Get-CimInstance Win32_Process -Filter "Name = 'LLMMarkUp.exe'")) {
      if ($entry.ExecutablePath -and [IO.Path]::GetFullPath($entry.ExecutablePath).Equals($expectedExe, [StringComparison]::OrdinalIgnoreCase) -and
          (-not $marker -or ($entry.CommandLine -and $entry.CommandLine.Contains($marker)))) {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) { $windowReady = $true; break }
      }
    }
    if (-not $windowReady) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $windowReady) { throw 'The installed version was verified, but its application window did not appear.' }
}
function Request-VerifiedClose([object[]]$Running, $Previous, $Existing) {
  if ($Running.Count -ne 0 -and -not $Previous) { throw 'Cannot verify the running application package; no process was closed.' }
  if ($Running.Count -ne 0) {
    if (-not $Existing.Id -or -not $Existing.Hash) { throw 'The running legacy application cannot be verified; save and close it before updating.' }
    $manifestPath = Join-Path $Existing.Runtime '.llmmarkup-manifest.json'
    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    $records = @($manifest.files | Where-Object { $_.path -ieq 'LLMMarkUp.exe' -and $_.sha256 -match '^[0-9a-f]{64}$' })
    if ((File-Hash $manifestPath).ToLowerInvariant() -ne $Existing.Hash -or $manifest.schema -ne 1 -or $manifest.product -ne 'llmmarkup' -or
        $records.Count -ne 1 -or (File-Hash (Join-Path $Existing.Runtime 'LLMMarkUp.exe')).ToLowerInvariant() -ne $records[0].sha256) { throw 'The running executable cannot be verified; no process was closed.' }
  }
  $ownedExecutable = if ($Running.Count -ne 0) { [IO.Path]::GetFullPath((Join-Path $Existing.Runtime 'LLMMarkUp.exe')) } else { $null }
  $verifiedProcesses = [Collections.ArrayList]::new()
  foreach ($entry in $Running) {
    $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    try {
      [void]$process.Handle
      if ($process.HasExited) { continue }
      $processPath = [IO.Path]::GetFullPath($process.MainModule.FileName)
      $expectedPath = [IO.Path]::GetFullPath($entry.ExecutablePath)
      if (-not $entry.CreationDate -or -not $processPath.Equals($expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
          -not $processPath.Equals($ownedExecutable, [StringComparison]::OrdinalIgnoreCase) -or
          [Math]::Abs(($process.StartTime.ToUniversalTime() - $entry.CreationDate.ToUniversalTime()).TotalSeconds) -gt 1) { throw 'Process identity changed.' }
      [void]$verifiedProcesses.Add($process)
    } catch { throw 'Cannot verify a running process identity; no process was closed.' }
  }
  foreach ($process in $verifiedProcesses) {
    if (-not $process.HasExited -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
  }
}

if (-not $InstallDirectory) {
  if ($locations.Count -gt 1) { throw 'Multiple application locations are running; specify one install directory after closing the others.' }
  if ($locations.Count -eq 1) {
    $InstallDirectory = $locations[0]
    $parent = [IO.Path]::GetDirectoryName($InstallDirectory)
    if ([IO.Path]::GetFileName($parent) -eq '.llmmarkup-versions') {
      $candidateRoot = [IO.Path]::GetDirectoryName($parent)
      $candidate = Resolve-InstalledRuntime $candidateRoot
      if (-not [IO.Path]::GetFullPath($candidate.Runtime).Equals([IO.Path]::GetFullPath($InstallDirectory), [StringComparison]::OrdinalIgnoreCase)) { throw 'The running application does not match its installation record.' }
      $InstallDirectory = $candidateRoot
    }
  } else {
    $guid = $package.build.nsis.guid
    $registered = @()
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $hive = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser, $view)
      try {
        $key = $hive.OpenSubKey("Software\$guid")
        if ($key) {
          try { $location = $key.GetValue('InstallLocation'); if ($location) { $registered += $location } }
          finally { $key.Dispose() }
        }
        $key = $hive.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Uninstall\$guid")
        if ($key) {
          try {
            $command = $key.GetValue('UninstallString')
            if ($command -match '^\s*"([^"]+)"(?:\s|$)') {
              $uninstaller = $matches[1]
              if ((Split-Path -Leaf $uninstaller) -in @('Uninstall LLMMarkUp.exe', 'Uninstall MDPPT Studio.exe')) {
                $registered += Split-Path -Parent $uninstaller
              }
            }
          } finally { $key.Dispose() }
        }
      } finally { $hive.Dispose() }
    }
    $registered = @($registered | Sort-Object -Unique)
    if ($registered.Count -gt 1) { throw 'Multiple registered install locations; specify the intended directory.' }
    $InstallDirectory = if ($registered.Count -eq 1) { $registered[0] } else {
      Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\LLMMarkUp'
    }
  }
}

$target = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\')
if ($target -eq [IO.Path]::GetPathRoot($target).TrimEnd('\')) { throw 'An installation cannot target a drive root.' }
if ($env:LLMMARKUP_LOCAL_TEST_OUTPUT) {
  $testRoot = [IO.Path]::GetFullPath($env:LLMMARKUP_TEST_DATA).TrimEnd('\')
  $outputPrefix = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'outputs')).TrimEnd('\') + '\'
  if (-not $testRoot.StartsWith($outputPrefix, [StringComparison]::OrdinalIgnoreCase) -or
      -not $target.Equals([IO.Path]::Combine($testRoot, 'install'), [StringComparison]::OrdinalIgnoreCase)) { throw 'The local test target is outside its isolated workspace.' }
}
$existing = Resolve-InstalledRuntime $target
foreach ($location in $locations) {
  if (-not [IO.Path]::GetFullPath($existing.Runtime).TrimEnd('\').Equals([IO.Path]::GetFullPath($location).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'An application from another directory is running; no process will be forced to stop.'
  }
}
if ($running.Count -ne 0 -and $locations.Count -eq 0) { throw 'Cannot verify running application ownership.' }
$previous = if (Test-Path -LiteralPath (Join-Path $existing.Runtime 'resources\app.asar')) { Read-AppPackage $existing.Runtime } else { $null }

# The app's close handler preserves unsaved content. Never use Stop-Process or installer force flags.
Request-VerifiedClose $running $previous $existing
$deadline = [DateTime]::UtcNow.AddSeconds(30)
while (@(Get-CimInstance Win32_Process -Filter $processFilter).Count -ne 0) {
  if ([DateTime]::UtcNow -ge $deadline) { throw 'Application remains open (possibly an unsaved-content dialog). Save/close it and retry; update was not started.' }
  Start-Sleep -Milliseconds 300
}

$installation = Start-Process -FilePath $installer -ArgumentList @('/S', '/currentuser', "/D=$target") -WindowStyle Hidden -PassThru -Wait
if ($installation.ExitCode -ne 0) { throw "Installer exit code: $($installation.ExitCode)" }
$installed = Resolve-InstalledRuntime $target
$actual = Read-AppPackage $installed.Runtime
if ($actual.name -ne 'llmmarkup' -or $actual.version -ne $version) { throw 'Installed application identity or version differs from the candidate.' }
$builtAsar = File-Hash (Join-Path $outputDirectory 'win-unpacked\resources\app.asar')
$installedAsar = File-Hash (Join-Path $installed.Runtime 'resources\app.asar')
if ($builtAsar -ne $installedAsar) { throw 'Installed application content differs from the packaged candidate.' }
$receipt = [ordered]@{
  version = $actual.version
  previousVersion = if ($previous) { $previous.version } else { $null }
  installDirectory = $target
  installerSha256 = File-Hash $installer
  installedAsarSha256 = $installedAsar
  launched = [bool]$Launch
  isolatedLaunchProfile = [bool]$env:LLMMARKUP_LOCAL_SMOKE_PROFILE
  timestampUtc = [DateTime]::UtcNow.ToString('o')
}
if ($Launch) {
  $isolatedProfile = $env:LLMMARKUP_LOCAL_SMOKE_PROFILE
  if ($isolatedProfile) { Initialize-SyntheticLaunchProfile $isolatedProfile (Join-Path $PSScriptRoot 'outputs') $target $installed }
  Start-VerifiedApplication (Join-Path $target $installed.Entry) $installed.Runtime $isolatedProfile
}
$receiptPath = if ($env:LLMMARKUP_LOCAL_TEST_OUTPUT) { Join-Path $testRoot 'local-install-receipt.json' } else { Join-Path 'outputs' ("local-install-$version-" + [guid]::NewGuid().ToString('N') + '.json') }
$receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json) + "`n")
$receiptFile = [IO.FileStream]::new($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $receiptFile.Write($receiptBytes, 0, $receiptBytes.Length); $receiptFile.Flush($true) } finally { $receiptFile.Dispose() }
Write-Output "LOCAL_UPDATE_PASS: $version; installed package identity, version and content hash verified."
