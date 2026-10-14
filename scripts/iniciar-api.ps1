$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'API local - n8n WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$portableNodeFolder = Join-Path $projectRoot 'work\runtime\node_modules\node\bin'
$portableNode = Join-Path $portableNodeFolder 'node.exe'
$apiFile = Join-Path $projectRoot 'api\server.mjs'
$envFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js portatil nao encontrado. Execute primeiro scripts\preparar-ambiente.ps1.'
}

if (-not (Test-Path -LiteralPath $apiFile)) {
    throw 'Arquivo da API nao encontrado.'
}

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Arquivo .env nao encontrado. Copie .env.example e preencha ADMIN_TOKEN.'
}

Get-Content -LiteralPath $envFile |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object {
        $parts = $_.Split('=', 2)
        if ($parts.Count -eq 2 -and $parts[0]) {
            [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }

Set-Location -LiteralPath $projectRoot
& $portableNode --no-warnings $apiFile
