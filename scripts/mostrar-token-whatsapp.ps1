$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$tokenFile = Join-Path $projectRoot 'work\whatsapp\verify-token.txt'

if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw 'Token de verificacao nao encontrado.'
}

Write-Host 'Token de verificacao para informar na Meta:'
Get-Content -Raw -LiteralPath $tokenFile
