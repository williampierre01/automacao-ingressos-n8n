$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeFolder = Join-Path $projectRoot 'work\runtime'
$npmCache = Join-Path $projectRoot 'work\npm-cache'

New-Item -ItemType Directory -Force -Path $runtimeFolder | Out-Null
New-Item -ItemType Directory -Force -Path $npmCache | Out-Null

$env:npm_config_cache = $npmCache

Write-Output 'Preparando o Node.js portatil 22.22.3...'
npm install --prefix $runtimeFolder node@22.22.3 --no-save --no-audit --no-fund

$portableNode = Join-Path $runtimeFolder 'node_modules\node\bin\node.exe'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'A instalacao do Node.js portatil nao foi concluida.'
}

Write-Output "Ambiente preparado com $(& $portableNode --version)."

