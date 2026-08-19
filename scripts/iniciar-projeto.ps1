$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$apiScript = Join-Path $PSScriptRoot 'iniciar-api.ps1'
$httpsApiScript = Join-Path $PSScriptRoot 'iniciar-api-https.ps1'
$httpsSettings = Join-Path $projectRoot 'work\https\https.env'
$n8nScript = Join-Path $PSScriptRoot 'iniciar-n8n.ps1'

if (Test-Path -LiteralPath $httpsSettings) {
    $apiScript = $httpsApiScript
}

function Test-LocalPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connection = $client.ConnectAsync('127.0.0.1', $Port)
        if (-not $connection.Wait(500)) {
            return $false
        }
        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Start-ProjectWindow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ScriptPath
    )

    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList @('-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$ScriptPath`"") `
        -WorkingDirectory $projectRoot `
        -WindowStyle Normal
}

if (Test-LocalPort -Port 8000) {
    Write-Host 'A API ja esta ativa em http://127.0.0.1:8000.'
}
else {
    Write-Host 'Iniciando a API local...'
    Start-ProjectWindow -ScriptPath $apiScript
}

if (Test-LocalPort -Port 5678) {
    Write-Host 'O n8n ja esta ativo em http://localhost:5678.'
}
else {
    Write-Host 'Iniciando o n8n...'
    Start-ProjectWindow -ScriptPath $n8nScript
}

Write-Host ''
Write-Host 'Servicos solicitados. Mantenha as duas janelas abertas.'
Write-Host 'n8n: http://localhost:5678'
Write-Host 'Formulario: http://localhost:5678/form/e286326c-a54f-45b0-b0f4-59360eb06836'
Write-Host 'API: http://127.0.0.1:8000/saude'
if (Test-Path -LiteralPath $httpsSettings) {
    $localIpLine = Get-Content -LiteralPath $httpsSettings | Where-Object { $_ -like 'API_LOCAL_IP=*' } | Select-Object -First 1
    $localIp = ($localIpLine -split '=', 2)[1]
    Write-Host "HTTPS: https://${localIp}:8443/admin"
}
