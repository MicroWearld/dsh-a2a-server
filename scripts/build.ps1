# Build dsh-a2a-server on Windows: create dependency junctions, compile with the
# DSH checkout's tsc, then bundle with tsdown.
# Usage:
#   $env:DSH_CHECKOUT = "D:\path\to\deepseek-harness"
#   powershell -ExecutionPolicy Bypass -File scripts/build.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$checkout = $env:DSH_CHECKOUT
if (-not $checkout) {
  foreach ($candidate in @(
    (Join-Path $HOME 'dsh-harness'),
    (Join-Path $HOME 'dsh'),
    (Join-Path $HOME '.dsh\dsh-harness')
  )) {
    if (Test-Path (Join-Path $candidate 'packages')) { $checkout = $candidate; break }
  }
}
if (-not $checkout -or -not (Test-Path (Join-Path $checkout 'packages'))) {
  throw 'build: cannot locate the dsh checkout (set DSH_CHECKOUT)'
}

function Link-Pkg {
  param(
    [string]$LinkPath,
    [string]$TargetPath
  )
  if (Test-Path $LinkPath) {
    Remove-Item $LinkPath -Recurse -Force
  }
  $parent = Split-Path -Parent $LinkPath
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  New-Item -ItemType Junction -Path $LinkPath -Target $TargetPath | Out-Null
}

Write-Host "=== Linking build dependencies (checkout: $checkout) ==="
New-Item -ItemType Directory -Force -Path 'node_modules\@deepseek-ai' | Out-Null
New-Item -ItemType Directory -Force -Path 'node_modules\@a2a-js' | Out-Null
New-Item -ItemType Directory -Force -Path 'node_modules\@types' | Out-Null

Link-Pkg 'node_modules\cordis' (Join-Path $checkout 'vendor\cordis')
Link-Pkg 'node_modules\cosmokit' (Join-Path $checkout 'vendor\cosmokit')
Link-Pkg 'node_modules\schemastery' (Join-Path $checkout 'vendor\schemastery')
Link-Pkg 'node_modules\@deepseek-ai\dsh-llm' (Join-Path $checkout 'packages\llm\llm')
Link-Pkg 'node_modules\@deepseek-ai\dsh-agent' (Join-Path $checkout 'packages\core\agent')
Link-Pkg 'node_modules\@deepseek-ai\dsh-session' (Join-Path $checkout 'packages\core\session')
Link-Pkg 'node_modules\@deepseek-ai\dsh-user-approval' (Join-Path $checkout 'packages\interaction\user-approval')
$a2aWorkspace = Join-Path $checkout 'packages\a2a\a2a-protocol'
$a2aSdk = $env:A2A_SDK_PATH
if (-not $a2aSdk) {
  $a2aSdk = & node -e @'
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const req = createRequire(path.resolve(process.argv[1], 'package.json'));
let current = req.resolve('@a2a-js/sdk');
while (!fs.existsSync(path.join(current, 'package.json'))) {
  const parent = path.dirname(current);
  if (parent === current) process.exit(1);
  current = parent;
}
process.stdout.write(current);
'@ $a2aWorkspace
}
if ($LASTEXITCODE -ne 0 -or -not $a2aSdk -or -not (Test-Path $a2aSdk)) {
  throw 'build: cannot locate @a2a-js/sdk in the dsh checkout'
}
Link-Pkg 'node_modules\@a2a-js\sdk' $a2aSdk
Link-Pkg 'node_modules\@types\node' (Join-Path $checkout 'node_modules\@types\node')

$tsc = Join-Path $checkout 'node_modules\.bin\tsc.cmd'
if (-not (Test-Path $tsc)) { throw "build: tsc not found at $tsc" }

Write-Host '=== Compiling src → lib ==='
& $tsc -p tsconfig.json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$tsdown = Join-Path $checkout 'node_modules\.bin\tsdown.cmd'
if (Test-Path $tsdown) {
  Write-Host '=== Bundling host lib ==='
  & $tsdown --config tsdown.config.ts
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
  Write-Warning 'build: tsdown not found; skipping bundle (lib remains tsc output)'
}

Write-Host '=== Build complete ==='
