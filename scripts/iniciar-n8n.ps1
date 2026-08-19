$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'n8n - Automacao WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Arquivo .env nao encontrado. Crie-o antes de iniciar o n8n.'
}

Get-Content -LiteralPath $envFile |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object {
        $parts = $_.Split('=', 2)
        if ($parts.Count -eq 2) {
            [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }

$env:N8N_USER_FOLDER = Join-Path $projectRoot 'work\n8n-user'
$env:N8N_HOST = 'localhost'
$env:N8N_PORT = '5678'
$env:N8N_PROTOCOL = 'http'
$env:N8N_SECURE_COOKIE = 'false'
$env:npm_config_cache = Join-Path $projectRoot 'work\npm-cache'

$portableNodeFolder = Join-Path $projectRoot 'work\runtime\node_modules\node\bin'
$portableNode = Join-Path $portableNodeFolder 'node.exe'

if (-not (Test-Path -LiteralPath $portableNode)) {
    throw 'Node.js portatil nao encontrado em work/runtime.'
}

$env:Path = "$portableNodeFolder;$env:Path"
$npmCommand = (Get-Command npm -ErrorAction Stop).Source
$npxCli = Join-Path (Split-Path -Parent $npmCommand) 'node_modules\npm\bin\npx-cli.js'

if (-not (Test-Path -LiteralPath $npxCli)) {
    throw 'Iniciador do npm nao encontrado.'
}

New-Item -ItemType Directory -Force -Path $env:N8N_USER_FOLDER | Out-Null
New-Item -ItemType Directory -Force -Path $env:npm_config_cache | Out-Null

Set-Location -LiteralPath $projectRoot
& $portableNode $npxCli --yes n8n@2.34.6 start
