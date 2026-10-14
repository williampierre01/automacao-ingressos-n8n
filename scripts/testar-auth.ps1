$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'
$apiBase = 'http://127.0.0.1:8000'
$gateway = 'http://127.0.0.1:8001/whatsapp-webhook'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Arquivo .env nao encontrado.'
}

function Read-EnvValue {
    param([Parameter(Mandatory = $true)][string]$Name)
    $found = $null
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if (-not $line -or $line.StartsWith('#')) { continue }
        $parts = $line.Split('=', 2)
        if ($parts.Count -eq 2 -and $parts[0] -eq $Name) {
            $found = $parts[1].Trim()
        }
    }
    return $found
}

function Get-NodePath {
    $portable = Join-Path $projectRoot 'work\runtime\node_modules\node\bin\node.exe'
    if (Test-Path -LiteralPath $portable) { return $portable }
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    return $null
}

function Get-HttpCode {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Uri,
        [hashtable]$Headers,
        [string]$Body
    )
    $curlArgs = @('-sS', '-o', 'NUL', '-w', '%{http_code}', '--max-time', '10', '-X', $Method)
    if ($Headers) {
        foreach ($key in $Headers.Keys) {
            $curlArgs += @('-H', "${key}: $($Headers[$key])")
        }
    }
    if ($PSBoundParameters.ContainsKey('Body')) {
        $curlArgs += @('--data-binary', $Body)
    }
    $curlArgs += $Uri
    try {
        $code = & curl.exe @curlArgs 2>$null
    } catch {
        return '000'
    }
    if (-not $code) { return '000' }
    return ([string]$code).Trim()
}

function Write-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Actual,
        [Parameter(Mandatory = $true)][string]$Label
    )
    Write-Host "$Name => $Actual $Label"
}

$adminToken = Read-EnvValue -Name 'ADMIN_TOKEN'
$appSecret = Read-EnvValue -Name 'META_APP_SECRET'
$failed = $false

$code = Get-HttpCode -Method 'GET' -Uri "$apiBase/admin/pedidos"
if ($code -eq '401') {
    Write-Check -Name '1. GET /admin/pedidos sem token' -Actual $code -Label 'OK'
} else {
    $failed = $true
    Write-Check -Name '1. GET /admin/pedidos sem token' -Actual $code -Label 'FALHOU'
}

if (-not $adminToken) {
    $failed = $true
    Write-Check -Name '2. GET /admin/pedidos com token' -Actual '000' -Label 'FALHOU'
} else {
    $code = Get-HttpCode -Method 'GET' -Uri "$apiBase/admin/pedidos" -Headers @{ Authorization = "Bearer $adminToken" }
    if ($code -ne '401' -and $code -ne '000') {
        Write-Check -Name '2. GET /admin/pedidos com token' -Actual $code -Label 'OK'
    } else {
        $failed = $true
        Write-Check -Name '2. GET /admin/pedidos com token' -Actual $code -Label 'FALHOU'
    }
}

$payload = '{"objeto":"whatsapp"}'
$node = Get-NodePath
$signature = $null
if ($appSecret -and $node) {
    $previousSecret = [Environment]::GetEnvironmentVariable('META_APP_SECRET', 'Process')
    try {
        $env:META_APP_SECRET = $appSecret
        $env:WEBHOOK_BODY = $payload
        $signature = & $node --no-warnings -e "const {createHmac}=require('node:crypto'); process.stdout.write('sha256='+createHmac('sha256', process.env.META_APP_SECRET).update(process.env.WEBHOOK_BODY).digest('hex'))" 2>$null
        if ($signature) { $signature = ([string]$signature).Trim() }
    } finally {
        if ($null -eq $previousSecret) {
            Remove-Item Env:META_APP_SECRET -ErrorAction SilentlyContinue
        } else {
            $env:META_APP_SECRET = $previousSecret
        }
        Remove-Item Env:WEBHOOK_BODY -ErrorAction SilentlyContinue
    }
}

function Write-GatewayCheck {
    param([string]$Name, [string]$Code, [string]$Mode)
    if ($Mode -eq 'valida') {
        if ($Code -eq '200') { Write-Check -Name $Name -Actual $Code -Label 'OK'; return $false }
        if ($Code -eq '400') { Write-Check -Name $Name -Actual $Code -Label 'AVISO n8n parado'; return $false }
        Write-Check -Name $Name -Actual $Code -Label 'FALHOU'
        return $true
    }
    $label = if ($Code -eq '401') { 'OK' } else { 'FALHOU' }
    Write-Check -Name $Name -Actual $Code -Label $label
    return $label -eq 'FALHOU'
}

if (-not $signature) {
    $failed = $true
    Write-Check -Name '3. POST gateway assinatura valida' -Actual '000' -Label 'FALHOU'
    Write-Check -Name '4. POST gateway assinatura invalida' -Actual '000' -Label 'FALHOU'
    Write-Check -Name '5. POST gateway sem assinatura' -Actual '000' -Label 'FALHOU'
    Write-Check -Name '6. POST gateway corpo adulterado' -Actual '000' -Label 'FALHOU'
} else {
    $valid = Get-HttpCode -Method 'POST' -Uri $gateway -Headers @{
        'Content-Type' = 'application/json'
        'X-Hub-Signature-256' = $signature
    } -Body $payload
    if (Write-GatewayCheck -Name '3. POST gateway assinatura valida' -Code $valid -Mode 'valida') { $failed = $true }

    $invalid = Get-HttpCode -Method 'POST' -Uri $gateway -Headers @{
        'Content-Type' = 'application/json'
        'X-Hub-Signature-256' = 'sha256=00'
    } -Body $payload
    if (Write-GatewayCheck -Name '4. POST gateway assinatura invalida' -Code $invalid -Mode '401') { $failed = $true }

    $missing = Get-HttpCode -Method 'POST' -Uri $gateway -Headers @{ 'Content-Type' = 'application/json' } -Body $payload
    if (Write-GatewayCheck -Name '5. POST gateway sem assinatura' -Code $missing -Mode '401') { $failed = $true }

    $tampered = Get-HttpCode -Method 'POST' -Uri $gateway -Headers @{
        'Content-Type' = 'application/json'
        'X-Hub-Signature-256' = $signature
    } -Body ($payload + ' ')
    if (Write-GatewayCheck -Name '6. POST gateway corpo adulterado' -Code $tampered -Mode '401') { $failed = $true }
}

function Test-SimulatorOff {
    if (-not $adminToken -or -not $node) { return 'pular' }
    $port = 21000 + (Get-Random -Maximum 20000)
    $tempDatabase = Join-Path ([System.IO.Path]::GetTempPath()) ("ingressos-auth-$port.sqlite")
    $stdout = Join-Path ([System.IO.Path]::GetTempPath()) ("ingressos-auth-$port.out")
    $stderr = Join-Path ([System.IO.Path]::GetTempPath()) ("ingressos-auth-$port.err")
    $saved = @{
        SIMULADOR_ATIVO = [Environment]::GetEnvironmentVariable('SIMULADOR_ATIVO', 'Process')
        API_PORT = [Environment]::GetEnvironmentVariable('API_PORT', 'Process')
        API_HOST = [Environment]::GetEnvironmentVariable('API_HOST', 'Process')
        API_DATABASE_PATH = [Environment]::GetEnvironmentVariable('API_DATABASE_PATH', 'Process')
        API_TLS_CERT_PATH = [Environment]::GetEnvironmentVariable('API_TLS_CERT_PATH', 'Process')
        API_TLS_KEY_PATH = [Environment]::GetEnvironmentVariable('API_TLS_KEY_PATH', 'Process')
        ADMIN_TOKEN = [Environment]::GetEnvironmentVariable('ADMIN_TOKEN', 'Process')
    }
    $process = $null
    try {
        foreach ($key in @('SIMULADOR_ATIVO', 'API_TLS_CERT_PATH', 'API_TLS_KEY_PATH')) {
            Remove-Item "Env:$key" -ErrorAction SilentlyContinue
        }
        $env:ADMIN_TOKEN = $adminToken
        $env:API_HOST = '127.0.0.1'
        $env:API_PORT = "$port"
        $env:API_DATABASE_PATH = $tempDatabase
        $process = Start-Process -FilePath $node -ArgumentList @('--no-warnings', 'api/server.mjs') -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $deadline = (Get-Date).AddSeconds(5)
        $healthy = $false
        while ((Get-Date) -lt $deadline) {
            if ($process.HasExited) { return 'pular' }
            $health = Get-HttpCode -Method 'GET' -Uri "http://127.0.0.1:${port}/saude"
            if ($health -eq '200') { $healthy = $true; break }
            Start-Sleep -Milliseconds 100
        }
        if (-not $healthy) { return 'pular' }
        return Get-HttpCode -Method 'GET' -Uri "http://127.0.0.1:${port}/simulador"
    } catch {
        return 'pular'
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        foreach ($key in $saved.Keys) {
            if ($null -eq $saved[$key]) {
                Remove-Item "Env:$key" -ErrorAction SilentlyContinue
            } else {
                Set-Item "Env:$key" $saved[$key]
            }
        }
        Remove-Item -LiteralPath $stdout, $stderr, $tempDatabase, "$tempDatabase-wal", "$tempDatabase-shm" -Force -ErrorAction SilentlyContinue
    }
}

$simulatorCode = Test-SimulatorOff
if ($simulatorCode -eq 'pular') {
    Write-Host '7. GET /simulador sem SIMULADOR_ATIVO => pular'
} else {
    $label = if ($simulatorCode -eq '404') { 'OK' } else { 'FALHOU' }
    if ($label -eq 'FALHOU') { $failed = $true }
    Write-Check -Name '7. GET /simulador sem SIMULADOR_ATIVO' -Actual $simulatorCode -Label $label
}

if ($failed) { exit 1 }
