$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'API local - n8n WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableNodeFolder = Join-Path $projectRoot 'work\runtime\node_modules\node\bin'
$portableNode = Join-Path $portableNodeFolder 'node.exe'
$apiFile = Join-Path $projectRoot 'api\server.mjs'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js portatil nao encontrado. Execute primeiro scripts\preparar-ambiente.ps1.'
}

if (-not (Test-Path -LiteralPath $apiFile)) {
    throw 'Arquivo da API nao encontrado.'
}

Set-Location -LiteralPath $projectRoot
& $portableNode --no-warnings $apiFile
