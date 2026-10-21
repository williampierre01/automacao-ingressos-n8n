$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = 'n8n - Automacao WhatsApp'

$projectRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $projectRoot '.env'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'Arquivo .env nao encontrado. Crie-o antes de iniciar o n8n.'
}

function Permitida-NoN8n([string]$nome) {
    # O fluxo 04 recebe o Bearer na requisicao. O processo do n8n nao leva o token interno.
    return $nome -eq 'N8N_ENCRYPTION_KEY' -or $nome -eq 'GENERIC_TIMEZONE' -or $nome -eq 'TZ'
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

foreach ($nome in @('ADMIN_TOKEN', 'META_APP_SECRET', 'API_INTERNAL_TOKEN', 'N8N_BLOCK_ENV_ACCESS_IN_NODE')) {
    [Environment]::SetEnvironmentVariable($nome, $null, 'Process')
}

$env:N8N_USER_FOLDER = Join-Path $projectRoot 'work\n8n-user'
$env:N8N_HOST = 'localhost'
$env:N8N_PORT = '5678'
$env:N8N_PROTOCOL = 'http'
$env:N8N_SECURE_COOKIE = 'false'
$env:N8N_LISTEN_ADDRESS = '127.0.0.1'
$env:EXECUTIONS_DATA_SAVE_ON_SUCCESS = 'none'
$env:EXECUTIONS_DATA_SAVE_ON_ERROR = 'none'
$env:EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS = 'false'
$env:EXECUTIONS_DATA_SAVE_ON_PROGRESS = 'false'
$env:EXECUTIONS_DATA_PRUNE = 'true'
$env:EXECUTIONS_DATA_MAX_AGE = '72'
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

# n8n 2.34.6, com saveDataSuccessExecution=none, grava a execucao e so preenche deletedAt.
# O corpo (cabecalho e mensagem) continuaria no banco. A limpeza apaga o que ja
# estava marcado; o trigger apaga a marcacao futura.
$bancoN8n = Join-Path $env:N8N_USER_FOLDER '.n8n\database.sqlite'
if (Test-Path -LiteralPath $bancoN8n) {
    $garantirTrigger = Join-Path $env:TEMP 'n8n-garantir-trigger.mjs'
    $utf8Trigger = New-Object System.Text.UTF8Encoding $false
    [System.IO.File]::WriteAllText($garantirTrigger, @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
for (const tabela of ["execution_data", "execution_metadata", "execution_entity"]) {
  const achou = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabela);
  if (!achou) {
    throw new Error("Tabela " + tabela + " nao existe nesta versao do n8n.");
  }
}
db.exec("DELETE FROM execution_data WHERE executionId IN (SELECT id FROM execution_entity WHERE deletedAt IS NOT NULL)");
db.exec("DELETE FROM execution_metadata WHERE executionId IN (SELECT id FROM execution_entity WHERE deletedAt IS NOT NULL)");
db.exec("DELETE FROM execution_entity WHERE deletedAt IS NOT NULL");
db.exec("DROP TRIGGER IF EXISTS limpar_execucao_apagada");
db.exec(`
CREATE TRIGGER limpar_execucao_apagada
AFTER UPDATE OF deletedAt ON execution_entity
WHEN NEW.deletedAt IS NOT NULL AND OLD.deletedAt IS NULL
BEGIN
  DELETE FROM execution_data WHERE executionId = NEW.id;
  DELETE FROM execution_metadata WHERE executionId = NEW.id;
  DELETE FROM execution_entity WHERE id = NEW.id;
END;
`);
db.close();
'@, $utf8Trigger)
    & $portableNode $garantirTrigger $bancoN8n
    if ($LASTEXITCODE -ne 0) { throw 'Nao foi possivel preparar a limpeza das execucoes do n8n.' }
    Remove-Item -LiteralPath $garantirTrigger -Force -ErrorAction SilentlyContinue
}

# O n8n carrega o .env da pasta atual e reporia ADMIN_TOKEN e META_APP_SECRET.
$n8nCwd = Join-Path $projectRoot 'work\n8n-cwd'
New-Item -ItemType Directory -Force -Path $n8nCwd | Out-Null
Set-Location -LiteralPath $n8nCwd
& $portableNode $npxCli --yes n8n@2.34.6 start
