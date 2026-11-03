# SPDX-License-Identifier: AGPL-3.0-only
param(
  [string]$InstallDirectory,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$package = Get-Content -Raw -LiteralPath 'package.json' | ConvertFrom-Json
$version = $package.version
$installer = (Resolve-Path -LiteralPath "outputs/installers/LLMMarkUp-$version-Setup.exe").Path
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
  if ($matches.Count -eq 0) { return [pscustomobject]@{ Runtime=$root; Entry='LLMMarkUp.exe' } }
  $record = $matches[0]
  if ($record.Id -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' -or
      $record.Hash -notmatch '^[0-9a-f]{64}$' -or $record.Entry -notin @('LLMMarkUp.exe','MDPPT Studio.exe')) { throw 'The installed application record is invalid.' }
  $runtime = Join-Path (Join-Path $root '.llmmarkup-versions') $record.Id
  $markerPath = Join-Path $runtime '.llmmarkup-owned.json'
  $manifestPath = Join-Path $runtime '.llmmarkup-manifest.json'
  $marker = Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json
  if ($marker.product -ne 'llmmarkup' -or $marker.installId -ne $record.Id -or $marker.manifestSha256 -ne $record.Hash -or (File-Hash $manifestPath).ToLowerInvariant() -ne $record.Hash) { throw 'The installed application ownership cannot be verified.' }
  return [pscustomobject]@{ Runtime=$runtime; Entry=$record.Entry }
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
$existing = Resolve-InstalledRuntime $target
foreach ($location in $locations) {
  if (-not [IO.Path]::GetFullPath($existing.Runtime).TrimEnd('\').Equals([IO.Path]::GetFullPath($location).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'An application from another directory is running; no process will be forced to stop.'
  }
}
if ($running.Count -ne 0 -and $locations.Count -eq 0) { throw 'Cannot verify running application ownership.' }
$previous = if (Test-Path -LiteralPath (Join-Path $existing.Runtime 'resources\app.asar')) { Read-AppPackage $existing.Runtime } else { $null }

# The app's close handler preserves unsaved content. Never use Stop-Process or installer force flags.
foreach ($entry in $running) {
  $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
  if ($process -and $process.MainWindowHandle -ne 0) { [void]$process.CloseMainWindow() }
}
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
$builtAsar = File-Hash 'outputs/installers/win-unpacked/resources/app.asar'
$installedAsar = File-Hash (Join-Path $installed.Runtime 'resources\app.asar')
if ($builtAsar -ne $installedAsar) { throw 'Installed application content differs from the packaged candidate.' }
$receipt = [ordered]@{
  version = $actual.version
  previousVersion = if ($previous) { $previous.version } else { $null }
  installDirectory = $target
  installerSha256 = File-Hash $installer
  installedAsarSha256 = $installedAsar
  launched = [bool]$Launch
  timestampUtc = [DateTime]::UtcNow.ToString('o')
}
if ($Launch) {
  $launcher = Start-Process -FilePath (Join-Path $target $installed.Entry) -PassThru
  if (-not $launcher.WaitForExit(15000)) { throw 'The installed version was verified, but the launcher did not report whether reopening succeeded.' }
  if ($launcher.ExitCode -ne 0) { throw "The installed version was verified, but reopening failed (launcher exit code $($launcher.ExitCode))." }
  $expectedExe = [IO.Path]::GetFullPath((Join-Path $installed.Runtime 'LLMMarkUp.exe'))
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  $windowReady = $false
  while ([DateTime]::UtcNow -lt $deadline -and -not $windowReady) {
    foreach ($entry in @(Get-CimInstance Win32_Process -Filter "Name = 'LLMMarkUp.exe'")) {
      if ($entry.ExecutablePath -and [IO.Path]::GetFullPath($entry.ExecutablePath).Equals($expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
        $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
        if ($process -and $process.MainWindowHandle -ne 0) { $windowReady = $true; break }
      }
    }
    if (-not $windowReady) { Start-Sleep -Milliseconds 250 }
  }
  if (-not $windowReady) { throw 'The installed version was verified, but its application window did not appear.' }
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath "outputs/local-install-$version.json" -Encoding utf8
Write-Output "LOCAL_UPDATE_PASS: $version; installed package identity, version and content hash verified."
