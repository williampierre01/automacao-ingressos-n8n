$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$destinationFolder = Join-Path $projectRoot 'planilha\dados'
$destinationFile = Join-Path $destinationFolder 'atendimentos.csv'

New-Item -ItemType Directory -Force -Path $destinationFolder | Out-Null
Invoke-WebRequest -Uri 'http://127.0.0.1:8000/exportar' -OutFile $destinationFile

Write-Host "Planilha exportada para: $destinationFile"
