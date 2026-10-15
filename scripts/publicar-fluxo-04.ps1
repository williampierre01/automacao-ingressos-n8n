# Importa e publica o fluxo 04 no n8n local 2.34.6.
# Se o n8n ja estiver aberto, reinicie-o depois: a publicacao so vale no proximo processo.
# Windows PowerShell 5.1:
#   powershell -ExecutionPolicy Bypass -File .\scripts\publicar-fluxo-04.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $raiz '.env'
$fluxo = Join-Path $raiz 'workflows\04-webhook-whatsapp-simulado.json'
$nodeDir = Join-Path $raiz 'work\runtime\node_modules\node\bin'
$node = Join-Path $nodeDir 'node.exe'
$npxCli = Join-Path (Split-Path -Parent (Get-Command npm).Source) 'node_modules\npm\bin\npx-cli.js'

if (-not (Test-Path -LiteralPath $node)) { throw 'Node.js portatil nao encontrado.' }
if (-not (Test-Path -LiteralPath $npxCli)) { throw 'Iniciador do npm nao encontrado.' }
if (-not (Test-Path -LiteralPath $fluxo)) { throw 'Fluxo 04 nao encontrado.' }

Get-Content -LiteralPath $envFile | Where-Object { $_ -and -not $_.StartsWith('#') } | ForEach-Object {
  $partes = $_.Split('=', 2)
  if ($partes.Count -eq 2 -and $partes[0]) {
    [Environment]::SetEnvironmentVariable($partes[0], $partes[1], 'Process')
  }
}

$env:N8N_USER_FOLDER = Join-Path $raiz 'work\n8n-user'
$env:N8N_BLOCK_ENV_ACCESS_IN_NODE = 'false'
$env:Path = "$nodeDir;$env:Path"
$env:npm_config_cache = Join-Path $raiz 'work\npm-cache'

function Invocar-N8n([string[]]$argumentos) {
  & $node $npxCli --yes n8n@2.34.6 @argumentos
  if ($LASTEXITCODE -ne 0) { throw "n8n $($argumentos -join ' ') falhou." }
}

Invocar-N8n @('import:workflow', "--input=$fluxo")
Invocar-N8n @('publish:workflow', '--id=webhookWhatsapp0001')

$consulta = Join-Path $env:TEMP 'publicar-fluxo-04-consulta.mjs'
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($consulta, @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.N8N_USER_FOLDER + "/.n8n/database.sqlite");
const rows = db.prepare("SELECT id FROM workflow_entity WHERE name = ? AND id != ? AND active = 1").all("04 - Webhook de WhatsApp simulado", "webhookWhatsapp0001");
for (const row of rows) console.log(row.id);
db.prepare("DELETE FROM webhook_entity WHERE workflowId != ? AND webhookPath = ?").run("webhookWhatsapp0001", "whatsapp-mensagens");
db.close();
'@, $utf8)
$outros = & $node $consulta
foreach ($id in @($outros)) {
  $limpo = [string]$id
  if ($limpo.Trim() -eq '') { continue }
  Invocar-N8n @('unpublish:workflow', "--id=$($limpo.Trim())")
}

Write-Output 'Fluxo 04 importado e publicado. Reinicie o n8n se ele ja estava aberto.'
