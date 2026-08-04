# ─────────────────────────────────────────────────────────────────────────────
# Assemble the tree the Windows installer packages.
#
#   stage\node\   official Node runtime for win-x64
#   stage\app\    the published package plus production dependencies
#   stage\aura.cmd  launcher: runtime + entry point
#
# A private runtime rather than a single-file binary: the CLI reads its own
# package.json through __dirname at load (cli/index.ts, versioncheck.ts), and
# under Node SEA there is no such path, so it throws before doing anything.
# The staged tree is byte-for-byte what npm produces, which has no bundler
# risk at all.
#
# Runs on the Windows runner rather than cross-staging from Linux, because the
# npm install here must resolve win32 optional dependencies.
# ─────────────────────────────────────────────────────────────────────────────
[CmdletBinding()]
param(
  # Bundled runtime. Kept well above package.json's engines floor (>=18) so
  # the shipped product is not the oldest thing that merely works.
  [string]$NodeVersion = '22.14.0',
  [string]$StageDir
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $StageDir) { $StageDir = Join-Path $RepoRoot 'build\stage-win' }

$Version = (Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "==> Staging Aura $Version with Node $NodeVersion"

if (Test-Path $StageDir) { Remove-Item $StageDir -Recurse -Force }
New-Item -ItemType Directory -Path $StageDir -Force | Out-Null

# ── Node runtime ─────────────────────────────────────────────────────────────
$NodeZip = Join-Path $env:TEMP "node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

Write-Host "==> Downloading $NodeUrl"
Invoke-WebRequest -Uri $NodeUrl -OutFile $NodeZip -UseBasicParsing

# Verify against the release manifest rather than trusting the download. A
# corrupted or substituted runtime would otherwise be signed into an installer
# and handed to users.
$ShaUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"
$Sums = (Invoke-WebRequest -Uri $ShaUrl -UseBasicParsing).Content
$Expected = ($Sums -split "`n" |
  Where-Object { $_ -match "node-v$NodeVersion-win-x64\.zip" } |
  ForEach-Object { ($_ -split '\s+')[0] })
if (-not $Expected) { throw "No SHASUMS entry for node-v$NodeVersion-win-x64.zip" }

$Actual = (Get-FileHash -Path $NodeZip -Algorithm SHA256).Hash.ToLower()
if ($Actual -ne $Expected.ToLower()) {
  throw "Node runtime checksum mismatch`n  expected $Expected`n  got      $Actual"
}
Write-Host "==> Runtime checksum verified"

$NodeTmp = Join-Path $env:TEMP "node-extract-$Version"
if (Test-Path $NodeTmp) { Remove-Item $NodeTmp -Recurse -Force }
Expand-Archive -Path $NodeZip -DestinationPath $NodeTmp -Force
Move-Item (Join-Path $NodeTmp "node-v$NodeVersion-win-x64") (Join-Path $StageDir 'node')

# npm and npx are not needed to *run* Aura and roughly double the runtime's
# size. The agent shells out to whatever npm the user already has.
foreach ($drop in @('npm', 'npm.cmd', 'npx', 'npx.cmd', 'corepack', 'corepack.cmd')) {
  $p = Join-Path $StageDir "node\$drop"
  if (Test-Path $p) { Remove-Item $p -Recurse -Force }
}
$NodeModulesNpm = Join-Path $StageDir 'node\node_modules\npm'
if (Test-Path $NodeModulesNpm) { Remove-Item $NodeModulesNpm -Recurse -Force }

# ── Application ──────────────────────────────────────────────────────────────
Write-Host '==> Packing the application'
Push-Location $RepoRoot
try {
  $Tarball = (npm pack --silent | Select-Object -Last 1).Trim()
  if (-not (Test-Path $Tarball)) { throw "npm pack did not produce $Tarball" }

  $AppDir = Join-Path $StageDir 'app'
  New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
  tar -xzf $Tarball -C $AppDir --strip-components=1
  Remove-Item $Tarball -Force

  Write-Host '==> Installing production dependencies'
  Push-Location $AppDir
  try {
    # --omit=dev drops typescript, vite and rollup, which are build-time only
    # and account for most of the tree.
    npm install --omit=dev --no-audit --no-fund --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }
  } finally { Pop-Location }
} finally { Pop-Location }

# ── Launcher ─────────────────────────────────────────────────────────────────
# %~dp0 keeps this relative to the install directory, so it works wherever the
# user chose to install and needs no absolute path baked in at build time.
$Launcher = @'
@echo off
setlocal
"%~dp0node\node.exe" "%~dp0app\dist\cli\index.js" %*
'@
Set-Content -Path (Join-Path $StageDir 'aura.cmd') -Value $Launcher -Encoding ASCII

$SizeMb = [math]::Round((Get-ChildItem $StageDir -Recurse -File |
  Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "==> Staged $StageDir ($SizeMb MB)"

# Smoke test: the staged tree must actually run before it is packaged. This
# catches a bad runtime, a missing dist, or a dependency that npm pack left out.
Write-Host '==> Smoke test'
& (Join-Path $StageDir 'aura.cmd') --version
if ($LASTEXITCODE -ne 0) { throw "Staged build failed to run (exit $LASTEXITCODE)" }
