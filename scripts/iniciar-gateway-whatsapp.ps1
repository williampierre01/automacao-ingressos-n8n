$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'Gateway publico - WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableNode = Join-Path $projectRoot 'work\runtime\node_modules\node\bin\node.exe'
$gatewayFile = Join-Path $projectRoot 'api\whatsapp-gateway.mjs'
$tokenFile = Join-Path $projectRoot 'work\whatsapp\verify-token.txt'
$envFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js portatil nao encontrado. Execute primeiro scripts\preparar-ambiente.ps1.'
}

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Arquivo .env nao encontrado. Copie .env.example e preencha META_APP_SECRET.'
}

Get-Content -LiteralPath $envFile |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object {
        $parts = $_.Split('=', 2)
        if ($parts.Count -eq 2 -and $parts[0]) {
            if ($parts[0] -eq 'META_ACCESS_TOKEN') { return }
            [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }

if (-not $env:META_APP_SECRET) {
    throw 'META_APP_SECRET nao definido no .env.'
}

if (-not (Test-Path -LiteralPath $tokenFile)) {
    throw 'Token de verificacao nao encontrado em work\whatsapp\verify-token.txt.'
}

Set-Location -LiteralPath $projectRoot
& $portableNode --no-warnings $gatewayFile
