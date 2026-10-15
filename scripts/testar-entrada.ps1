# Teste de ponta a ponta da entrada unificada. Nao usa o banco da API do dia a dia.
# Requer o n8n ja escutando em 127.0.0.1:5678, com o fluxo 04 publicado neste processo.
# Windows PowerShell 5.1:
#   powershell -ExecutionPolicy Bypass -File .\scripts\testar-entrada.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$porta = 8012
$tmp = Join-Path $raiz 'work\tmp-teste-entrada'
$banco = Join-Path $tmp 'teste.sqlite'
$evento = 'evento-demonstracao'
$falhas = 0
$proc = $null
$adminToken = ''
$node = $null

function Texto-Seguro([string]$texto) {
  if (-not $texto) { return '' }
  $limpo = [regex]::Replace($texto, '(?i)bearer\s+\S+', 'bearer [omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)(api_internal_token|admin_token)\s*[=:]\s*\S+', '$1=[omitido]')
  $limpo = $limpo.Replace("`r", ' ').Replace("`n", ' ')
  if ($limpo.Length -gt 220) { return $limpo.Substring(0, 220) }
  return $limpo
}

function Ler-Env([string]$caminho, [string]$chave) {
  if (-not (Test-Path -LiteralPath $caminho)) { return '' }
  foreach ($linha in [System.IO.File]::ReadAllLines($caminho)) {
    $texto = $linha.Trim()
    if ($texto -eq '' -or $texto.StartsWith('#')) { continue }
    $igual = $texto.IndexOf('=')
    if ($igual -lt 1) { continue }
    if ($texto.Substring(0, $igual).Trim() -ne $chave) { continue }
    $valor = $texto.Substring($igual + 1).Trim()
    if ($valor.Length -ge 2) {
      $abre = $valor.Substring(0, 1)
      $fecha = $valor.Substring($valor.Length - 1, 1)
      if (($abre -eq '"' -and $fecha -eq '"') -or ($abre -eq "'" -and $fecha -eq "'")) {
        $valor = $valor.Substring(1, $valor.Length - 2)
      }
    }
    return $valor
  }
  return ''
}

function Resultado([int]$numero, [string]$esperado, [bool]$ok, [string]$detalhe) {
  if ($ok) {
    Write-Output "OK $numero. $esperado"
    return
  }
  $script:falhas++
  if ($detalhe) {
    Write-Output ("FALHOU $numero. $esperado ({0})" -f (Texto-Seguro $detalhe))
  } else {
    Write-Output "FALHOU $numero. $esperado"
  }
}

function Porta-Aberta([int]$alvo) {
  $cliente = New-Object System.Net.Sockets.TcpClient
  try {
    $cliente.Connect('127.0.0.1', $alvo)
    return $true
  } catch {
    return $false
  } finally {
    $cliente.Close()
  }
}

function Invoke-Api {
  param([string]$Method, [string]$Path, [string]$Body, [bool]$Interno)
  $uri = "http://127.0.0.1:$script:porta$Path"
  $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
  $req.Method = $Method
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 30000
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Accept = 'application/json'
  $req.Proxy = New-Object System.Net.WebProxy
  if ($Interno) { [void]$req.Headers.Add('Authorization', "Bearer $script:internalToken") }
  if ($PSBoundParameters.ContainsKey('Body') -and $null -ne $Body) {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $req.ContentLength = $bytes.Length
    $fluxo = $req.GetRequestStream()
    $fluxo.Write($bytes, 0, $bytes.Length)
    $fluxo.Close()
  } elseif ($Method -eq 'POST') {
    $req.ContentLength = 0
  }
  $resp = $null
  try {
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { throw }
  }
  try {
    $leitor = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
    $texto = $leitor.ReadToEnd()
    $leitor.Close()
    $codigo = [int]$resp.StatusCode
  } finally {
    $resp.Close()
  }
  $json = $null
  if ($texto) { $json = $texto | ConvertFrom-Json }
  return [pscustomobject]@{ Status = $codigo; Json = $json; Text = $texto }
}

function Contar-Conversas([string]$telefone) {
  $arquivo = Join-Path $env:TEMP 'testar-entrada-consulta.mjs'
  $codigo = @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const n = db.prepare("SELECT COUNT(*) AS n FROM conversas WHERE telefone = ?").get(process.argv[3]);
const s = db.prepare("SELECT COUNT(*) AS n FROM mensagens_saida").get();
process.stdout.write(JSON.stringify({ conversas: Number(n.n), saidas: Number(s.n) }));
db.close();
'@
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($arquivo, $codigo, $utf8)
  $saida = & $script:node $arquivo $script:banco $telefone
  return $saida | ConvertFrom-Json
}

function Apagar-PastaTemporaria {
  if (-not (Test-Path -LiteralPath $tmp)) { return }
  $resolvido = [System.IO.Path]::GetFullPath($tmp)
  $permitido = [System.IO.Path]::GetFullPath((Join-Path $raiz 'work'))
  if (-not $resolvido.StartsWith($permitido)) { throw 'Pasta temporaria fora de work.' }
  for ($i = 0; $i -lt 8; $i++) {
    try {
      Remove-Item -LiteralPath $resolvido -Recurse -Force -ErrorAction Stop
      return
    } catch {
      if ($i -eq 7) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

try {
  if (-not (Porta-Aberta 5678)) {
    Write-Output 'FALHOU 1. COMPRAR pelo simulador passa no n8n (n8n nao esta em 127.0.0.1:5678)'
    exit 1
  }
  if (Porta-Aberta $porta) {
    Write-Output "FALHOU 1. COMPRAR pelo simulador passa no n8n (a porta $porta ja esta em uso)"
    exit 1
  }

  $envFile = Join-Path $raiz '.env'
  $adminToken = Ler-Env $envFile 'ADMIN_TOKEN'
  $internalToken = Ler-Env $envFile 'API_INTERNAL_TOKEN'
  if ($adminToken.Length -lt 24 -or $internalToken.Length -lt 24) {
    Write-Output 'FALHOU 1. COMPRAR pelo simulador passa no n8n (tokens ausentes ou curtos no .env)'
    exit 1
  }

  $portatil = Join-Path $raiz 'work\runtime\node_modules\node\bin\node.exe'
  if (Test-Path -LiteralPath $portatil) { $node = $portatil } else { $node = 'node' }

  Apagar-PastaTemporaria
  New-Item -ItemType Directory -Path $tmp | Out-Null

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $node
  $psi.Arguments = '--no-warnings api/server.mjs'
  $psi.WorkingDirectory = $raiz
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.EnvironmentVariables['ADMIN_TOKEN'] = $adminToken
  $psi.EnvironmentVariables['API_INTERNAL_TOKEN'] = $internalToken
  $psi.EnvironmentVariables['API_HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['API_PORT'] = [string]$porta
  $psi.EnvironmentVariables['API_DATABASE_PATH'] = $banco
  $psi.EnvironmentVariables['SIMULADOR_ATIVO'] = '1'
  $psi.EnvironmentVariables['N8N_WEBHOOK_URL'] = 'http://127.0.0.1:5678/webhook/whatsapp-mensagens'
  $psi.EnvironmentVariables['API_TLS_CERT_PATH'] = ''
  $psi.EnvironmentVariables['API_TLS_KEY_PATH'] = ''

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()

  $subiu = $false
  for ($i = 0; $i -lt 50; $i++) {
    if ($proc.HasExited) { break }
    try {
      $saude = Invoke-Api -Method 'GET' -Path '/saude'
      if ($saude.Status -eq 200) { $subiu = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
  if (-not $subiu) {
    Write-Output 'FALHOU 1. COMPRAR pelo simulador passa no n8n (API de teste nao subiu)'
    exit 1
  }

  $id = 'teste-entrada-' + [guid]::NewGuid().ToString('N')
  $corpo = @{
    telefone = '11955554444'
    nome = 'Teste Entrada'
    mensagem = 'COMPRAR'
    evento_codigo = $evento
    id_mensagem = $id
  } | ConvertTo-Json -Compress
  $compra = Invoke-Api -Method 'POST' -Path '/simular-mensagem' -Body $corpo
  $texto = ''
  if ($compra.Json) { $texto = [string]$compra.Json.resposta }
  Resultado 1 'COMPRAR pelo simulador passa no n8n e devolve a cotacao' ($compra.Status -eq 200 -and $texto -match 'Quantos ingressos') $compra.Text

  $deNovo = Invoke-Api -Method 'POST' -Path '/simular-mensagem' -Body $corpo
  $contagem = Contar-Conversas '11955554444'
  Resultado 2 'o mesmo id nao cria outra conversa nem outra saida' ($deNovo.Status -eq 200 -and $deNovo.Json.duplicada -eq $true -and $contagem.conversas -eq 1 -and $contagem.saidas -eq 1) $deNovo.Text

  $imagemId = 'teste-entrada-img-' + [guid]::NewGuid().ToString('N')
  $imagem = @{
    telefone = '5511955554444'
    nome = 'Teste Entrada'
    tipo = 'imagem'
    texto = ''
    id_mensagem = $imagemId
    timestamp = (Get-Date).ToUniversalTime().ToString('o')
    origem = 'teste'
    evento_codigo = $evento
    porta_api = $porta
  } | ConvertTo-Json -Compress
  $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create('http://127.0.0.1:5678/webhook/whatsapp-mensagens')
  $req.Method = 'POST'
  $req.Timeout = 30000
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Proxy = New-Object System.Net.WebProxy
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($imagem)
  $req.ContentLength = $bytes.Length
  $fluxo = $req.GetRequestStream()
  $fluxo.Write($bytes, 0, $bytes.Length)
  $fluxo.Close()
  $resp = $null
  try { $resp = $req.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response }
  $leitor = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
  $webhookTexto = $leitor.ReadToEnd()
  $leitor.Close()
  $resp.Close()
  $webhook = $null
  if ($webhookTexto) { $webhook = $webhookTexto | ConvertFrom-Json }
  $respostaImagem = ''
  if ($webhook) { $respostaImagem = [string]$webhook.resposta }
  Resultado 3 'imagem no mesmo webhook recebe o texto provisorio' ($respostaImagem -eq 'Recebi seu arquivo. O envio de comprovante por aqui ainda nao esta disponivel.') $webhookTexto
} finally {
  if ($proc -and -not $proc.HasExited) {
    $proc.Kill()
    $proc.WaitForExit(5000) | Out-Null
  }
  Apagar-PastaTemporaria
}

if ($falhas -gt 0) { exit 1 }
Write-Output 'Entrada unificada ok.'
