$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Gateway publico - WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $projectRoot 'work\runtime\node_modules\node\bin\node.exe'
$gatewayFile = Join-Path $projectRoot 'api\whatsapp-gateway.mjs'
$tokenFile = Join-Path $projectRoot 'work\whatsapp\verify-token.txt'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js portatil nao encontrado. Execute primeiro scripts\preparar-ambiente.ps1.'
}

if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw 'Token de verificacao nao encontrado em work\whatsapp\verify-token.txt.'
}

Set-Location -LiteralPath $projectRoot
& $portableNode --no-warnings $gatewayFile
