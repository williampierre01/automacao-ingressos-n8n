$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'API HTTPS local - n8n Ingressos'

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $projectRoot 'work\runtime\node_modules\node\bin\node.exe'
$apiFile = Join-Path $projectRoot 'api\server.mjs'
$httpsFolder = Join-Path $projectRoot 'work\https'
$settingsFile = Join-Path $httpsFolder 'https.env'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js portatil nao encontrado. Execute primeiro scripts\preparar-ambiente.ps1.'
}
if (-not (Test-Path -LiteralPath $settingsFile)) {
    throw 'HTTPS ainda nao foi configurado. Execute scripts\configurar-https-local.ps1.'
}

foreach ($line in Get-Content -LiteralPath $settingsFile) {
    if (-not $line -or $line.StartsWith('#')) { continue }
    $name, $value = $line -split '=', 2
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

Set-Location -LiteralPath $projectRoot
Write-Host "HTTP interno: http://127.0.0.1:8000"
Write-Host "HTTPS na rede: https://$($env:API_LOCAL_IP):$($env:API_HTTPS_PORT)"
& $portableNode --no-warnings $apiFile
