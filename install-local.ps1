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

if (-not $InstallDirectory) {
  if ($locations.Count -gt 1) { throw 'Multiple application locations are running; specify one install directory after closing the others.' }
  if ($locations.Count -eq 1) {
    $InstallDirectory = $locations[0]
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
foreach ($location in $locations) {
  if (-not $target.Equals([IO.Path]::GetFullPath($location).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    throw 'An application from another directory is running; no process will be forced to stop.'
  }
}
if ($running.Count -ne 0 -and $locations.Count -eq 0) { throw 'Cannot verify running application ownership.' }
$previous = if (Test-Path -LiteralPath $target) { Read-AppPackage $target } else { $null }

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
$actual = Read-AppPackage $target
if ($actual.name -ne 'llmmarkup' -or $actual.version -ne $version) { throw 'Installed application identity or version differs from the candidate.' }
$builtAsar = File-Hash 'outputs/installers/win-unpacked/resources/app.asar'
$installedAsar = File-Hash (Join-Path $target 'resources\app.asar')
if ($builtAsar -ne $installedAsar) { throw 'Installed application content differs from the packaged candidate.' }
$receipt = [ordered]@{
  version = $actual.version
  previousVersion = if ($previous) { $previous.version } else { $null }
  installDirectory = $target
  installerSha256 = File-Hash $installer
  installedAsarSha256 = $installedAsar
  timestampUtc = [DateTime]::UtcNow.ToString('o')
}
$receipt | ConvertTo-Json | Set-Content -LiteralPath "outputs/local-install-$version.json" -Encoding utf8
if ($Launch) { Start-Process -FilePath (Join-Path $target 'LLMMarkUp.exe') | Out-Null }
Write-Output "LOCAL_UPDATE_PASS: $version; installed package identity, version and content hash verified."
