param(
    [string]$LocalIp = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsFolder = Join-Path $projectRoot 'work\tools'
$httpsFolder = Join-Path $projectRoot 'work\https'
$projectMkcert = Join-Path $toolsFolder 'mkcert.exe'
$mkcertCommand = Get-Command mkcert -ErrorAction SilentlyContinue

if (Test-Path -LiteralPath $projectMkcert) {
    $mkcert = $projectMkcert
}
elseif ($mkcertCommand) {
    $mkcert = $mkcertCommand.Source
}
else {
    throw 'mkcert nao encontrado. Coloque mkcert.exe em work\tools ou instale-o no Windows.'
}

if (-not $LocalIp) {
    $networkInterface = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        Where-Object {
            $_.OperationalStatus -eq 'Up' -and
            $_.NetworkInterfaceType -ne 'Loopback' -and
            $_.GetIPProperties().GatewayAddresses.Count -gt 0
        } |
        Select-Object -First 1

    if ($networkInterface) {
        $LocalIp = $networkInterface.GetIPProperties().UnicastAddresses |
            Where-Object { $_.Address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
            Select-Object -ExpandProperty Address -First 1
        $LocalIp = [string]$LocalIp
    }
}

$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($LocalIp, [ref]$parsedIp)) {
    throw 'Nao foi possivel identificar o IPv4 local. Execute novamente com -LocalIp 192.168.x.x.'
}

New-Item -ItemType Directory -Path $httpsFolder -Force | Out-Null
$caFolder = Join-Path $httpsFolder 'ca'
New-Item -ItemType Directory -Path $caFolder -Force | Out-Null
$env:CAROOT = $caFolder

Write-Host 'Instalando a autoridade certificadora local no Windows...'
& $mkcert -install
$trustInstalled = $LASTEXITCODE -eq 0
if (-not $trustInstalled) {
    Write-Warning 'O Windows nao permitiu instalar a autoridade nesta sessao. Execute este script como Administrador para remover o alerta do navegador.'
}

$certificatePath = Join-Path $httpsFolder 'local-cert.pem'
$keyPath = Join-Path $httpsFolder 'local-key.pem'
& $mkcert -cert-file $certificatePath -key-file $keyPath localhost 127.0.0.1 ::1 $LocalIp
if ($LASTEXITCODE -ne 0) { throw 'O mkcert nao conseguiu gerar o certificado local.' }

$caRoot = (& $mkcert -CAROOT | Select-Object -Last 1).Trim()
$rootCertificate = Join-Path $caRoot 'rootCA.pem'
if (-not (Test-Path -LiteralPath $rootCertificate)) {
    throw 'O certificado raiz do mkcert nao foi encontrado.'
}
$localRootCertificate = Join-Path $httpsFolder 'rootCA.pem'
Copy-Item -LiteralPath $rootCertificate -Destination $localRootCertificate -Force
Copy-Item -LiteralPath $rootCertificate -Destination (Join-Path $httpsFolder 'rootCA.crt') -Force

$settings = @(
    "API_HTTPS_HOST=0.0.0.0"
    "API_HTTPS_PORT=8443"
    "API_TLS_CERT_PATH=$certificatePath"
    "API_TLS_KEY_PATH=$keyPath"
    "API_LOCAL_IP=$LocalIp"
)
Set-Content -LiteralPath (Join-Path $httpsFolder 'https.env') -Value $settings -Encoding UTF8

Write-Host ''
Write-Host 'HTTPS local configurado.' -ForegroundColor Green
Write-Host "Computador: https://localhost:8443/admin"
Write-Host "Celular:    https://${LocalIp}:8443/admin"
Write-Host "Certificado para o celular: $(Join-Path $httpsFolder 'rootCA.crt')"
Write-Host 'Nunca compartilhe o arquivo rootCA-key.pem.' -ForegroundColor Yellow
if (-not $trustInstalled) {
    Write-Host 'Pendente: executar novamente como Administrador para confiar no certificado neste computador.' -ForegroundColor Yellow
}
