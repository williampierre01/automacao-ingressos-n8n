$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$destinationFolder = Join-Path $projectRoot 'planilha\dados'
$destinationFile = Join-Path $destinationFolder 'atendimentos.csv'
$envFile = Join-Path $projectRoot '.env'

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

if (-not $env:ADMIN_TOKEN) {
    throw 'ADMIN_TOKEN nao definido no .env.'
}

New-Item -ItemType Directory -Force -Path $destinationFolder | Out-Null
Invoke-WebRequest -Uri 'http://127.0.0.1:8000/exportar' -OutFile $destinationFile -Headers @{
    Authorization = "Bearer $($env:ADMIN_TOKEN)"
}

Write-Host "Planilha exportada para: $destinationFile"
