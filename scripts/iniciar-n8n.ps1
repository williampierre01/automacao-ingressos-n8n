$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'n8n - Automacao WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Arquivo .env nao encontrado. Crie-o antes de iniciar o n8n.'
}

function Permitida-NoN8n([string]$nome) {
    # So o que o fluxo 04 e o arranque do n8n usam. O script define as N8N_* de host logo abaixo.
    return $nome -eq 'N8N_ENCRYPTION_KEY' -or $nome -eq 'GENERIC_TIMEZONE' -or $nome -eq 'TZ' -or $nome -eq 'API_INTERNAL_TOKEN'
}

$chavesDoArquivo = New-Object System.Collections.Generic.List[string]
Get-Content -LiteralPath $envFile |
    Where-Object { $_ -and -not $_.StartsWith('#') } |
    ForEach-Object {
        $parts = $_.Split('=', 2)
        if ($parts.Count -ne 2 -or -not $parts[0]) { return }
        $chavesDoArquivo.Add($parts[0])
        if (Permitida-NoN8n $parts[0]) {
            [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
        }
    }

foreach ($nome in $chavesDoArquivo) {
    if (-not (Permitida-NoN8n $nome)) {
        [Environment]::SetEnvironmentVariable($nome, $null, 'Process')
    }
}

foreach ($nome in @('ADMIN_TOKEN', 'META_APP_SECRET')) {
    [Environment]::SetEnvironmentVariable($nome, $null, 'Process')
}

$env:N8N_USER_FOLDER = Join-Path $projectRoot 'work\n8n-user'
$env:N8N_HOST = 'localhost'
$env:N8N_PORT = '5678'
$env:N8N_PROTOCOL = 'http'
$env:N8N_SECURE_COOKIE = 'false'
# n8n 2.34.6 bloqueia $env no no enquanto esta variavel nao for a string false.
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = 'false'
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

# O n8n carrega o .env da pasta atual e reporia ADMIN_TOKEN e META_APP_SECRET.
$n8nCwd = Join-Path $projectRoot 'work\n8n-cwd'
New-Item -ItemType Directory -Force -Path $n8nCwd | Out-Null
Set-Location -LiteralPath $n8nCwd
& $portableNode $npxCli --yes n8n@2.34.6 start
