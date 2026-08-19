$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Tunel HTTPS - WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$cloudflared = Join-Path $projectRoot 'work\tools\cloudflared.exe'

if (-not (Test-Path -LiteralPath $cloudflared)) {
    throw 'cloudflared nao encontrado. Execute primeiro a preparacao do tunel.'
}

Write-Host 'A URL HTTPS abaixo e temporaria e muda quando o tunel e reiniciado.'
Write-Host 'Use na Meta: https://SEU-ENDERECO.trycloudflare.com/whatsapp-webhook'
Write-Host ''

& $cloudflared tunnel --url http://127.0.0.1:8001 --no-autoupdate
