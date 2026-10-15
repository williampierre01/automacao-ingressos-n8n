# Teste de ponta a ponta da entrada unificada. Nao usa o banco da API do dia a dia.
# Requer o n8n ja escutando em 127.0.0.1:5678, iniciado por scripts/iniciar-n8n.ps1,
# com o fluxo 04 publicado neste processo.
# Windows PowerShell 5.1:
#   powershell -ExecutionPolicy Bypass -File .\scripts\testar-entrada.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$porta = 8012
$portaGateway = 8013
$portaApoio = 8014
$tmp = Join-Path $raiz 'work\tmp-teste-entrada'
$banco = Join-Path $tmp 'teste.sqlite'
$evento = 'evento-demonstracao'
$webhookReal = 'http://127.0.0.1:5678/webhook/whatsapp-mensagens'
$falhas = 0
$proc = $null
$gateway = $null
$apoio = $null
$adminToken = ''
$internalToken = ''
$metaSecret = ''
$node = $null

function Texto-Seguro([string]$texto) {
  if (-not $texto) { return '' }
  $limpo = [regex]::Replace($texto, '(?i)bearer\s+\S+', 'bearer [omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)(api_internal_token|admin_token|meta_app_secret)\s*[=:]\s*\S+', '$1=[omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)sha256=[0-9a-f]+', 'sha256=[omitido]')
  foreach ($segredo in @($script:adminToken, $script:internalToken, $script:metaSecret)) {
    if ($segredo -and $segredo.Length -ge 8) { $limpo = $limpo.Replace($segredo, '[omitido]') }
  }
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
  param([string]$Method, [string]$Path, [string]$Body, [bool]$Interno, [bool]$Admin)
  $uri = "http://127.0.0.1:$script:porta$Path"
  $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
  $req.Method = $Method
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 30000
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Accept = 'application/json'
  $req.Proxy = New-Object System.Net.WebProxy
  if ($Interno) { [void]$req.Headers.Add('Authorization', "Bearer $script:internalToken") }
  if ($Admin) { [void]$req.Headers.Add('Authorization', "Bearer $script:adminToken") }
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

function ComoLista($valor) {
  $lista = New-Object System.Collections.Generic.List[object]
  if ($null -eq $valor) {
    Write-Output -NoEnumerate $lista
    return
  }
  if ($valor -is [System.Array]) {
    foreach ($item in $valor) {
      if ($null -ne $item) { $lista.Add($item) }
    }
  } else {
    $lista.Add($valor)
  }
  Write-Output -NoEnumerate $lista
}

function Silenciar-Fila {
  & $script:node --no-warnings $script:consulta $script:banco silenciar | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'nao foi possivel silenciar a fila anterior' }
}

function Estado-Atual {
  $saida = & $script:node --no-warnings $script:consulta $script:banco estado
  if ($LASTEXITCODE -ne 0) { throw 'consulta sqlite falhou' }
  $texto = ($saida | Out-String).Trim()
  if (-not $texto) { throw 'consulta sqlite vazia' }
  return $texto | ConvertFrom-Json
}

function Fila-De($estado, [string]$wamid) {
  if (-not $estado) { return $null }
  foreach ($item in (ComoLista $estado.fila)) {
    if ([string]$item.wamid -eq $wamid) { return $item }
  }
  return $null
}

function Saida-De($estado, [string]$wamid) {
  if (-not $estado) { return $null }
  foreach ($item in (ComoLista $estado.saidas)) {
    if ([string]$item.wamid -eq $wamid) { return $item }
  }
  return $null
}

function Esperar([scriptblock]$teste, [int]$segundos) {
  $limite = (Get-Date).AddSeconds($segundos)
  $ultimo = $null
  do {
    $ultimo = Estado-Atual
    if (& $teste $ultimo) { return $ultimo }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $limite)
  return $ultimo
}

function Novo-Wamid([string]$marca) {
  return 'wamid.' + $marca + '.' + [guid]::NewGuid().ToString('N')
}

function Json-Texto([string]$valor) {
  $limpo = $valor.Replace('\', '\\').Replace('"', '\"')
  return '"' + $limpo + '"'
}

function Bytes-Envelope([string]$telefone, [string]$wamid, [string]$texto, [string]$nome) {
  # PowerShell 5.1 desfaz array de um item no ConvertTo-Json. O envelope da Cloud API precisa de arrays.
  $json = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":' + (Json-Texto $nome) + '},"wa_id":' + (Json-Texto $telefone) + '}],"messages":[{"from":' + (Json-Texto $telefone) + ',"id":' + (Json-Texto $wamid) + ',"timestamp":"1760500000","type":"text","text":{"body":' + (Json-Texto $texto) + '}}]}}]}]}'
  return [System.Text.Encoding]::UTF8.GetBytes($json)
}

function Assinar-Bytes([byte[]]$bytes) {
  $hmac = New-Object System.Security.Cryptography.HMACSHA256
  $hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($script:metaSecret)
  $hash = $hmac.ComputeHash($bytes)
  $hmac.Dispose()
  return 'sha256=' + ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
}

function Ler-Http($req) {
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
  if ($texto) {
    try { $json = $texto | ConvertFrom-Json } catch { $json = $null }
  }
  return [pscustomobject]@{ Status = $codigo; Json = $json; Text = $texto }
}

function Invoke-Gateway([byte[]]$bytes, [string]$assinatura) {
  $uri = "http://127.0.0.1:$script:portaGateway/whatsapp-webhook"
  $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
  $req.Method = 'POST'
  $req.Timeout = 15000
  $req.ReadWriteTimeout = 15000
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Proxy = New-Object System.Net.WebProxy
  if ($assinatura) { [void]$req.Headers.Add('X-Hub-Signature-256', $assinatura) }
  $req.ContentLength = $bytes.Length
  $fluxo = $req.GetRequestStream()
  $fluxo.Write($bytes, 0, $bytes.Length)
  $fluxo.Close()
  return Ler-Http $req
}

function Parar-Processo($processo) {
  if ($processo -and -not $processo.HasExited) {
    try { $processo.Kill() } catch {}
    try { [void]$processo.WaitForExit(8000) } catch {}
  }
}

function Aguardar-Porta([int]$alvo, $processo, [int]$tentativas) {
  for ($i = 0; $i -lt $tentativas; $i++) {
    if ($processo -and $processo.HasExited) { return $false }
    if (Porta-Aberta $alvo) { return $true }
    Start-Sleep -Milliseconds 200
  }
  return $false
}

function Iniciar-Filho([string]$argumentos) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:node
  $psi.Arguments = $argumentos
  $psi.WorkingDirectory = $raiz
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  return $psi
}

function Iniciar-Gateway([string]$webhook) {
  Parar-Processo $script:gateway
  for ($i = 0; $i -lt 25; $i++) {
    if (-not (Porta-Aberta $script:portaGateway)) { break }
    Start-Sleep -Milliseconds 200
  }
  if (Porta-Aberta $script:portaGateway) { throw 'porta do gateway ocupada' }
  $psi = Iniciar-Filho '--no-warnings api/whatsapp-gateway.mjs'
  $psi.EnvironmentVariables['META_APP_SECRET'] = $script:metaSecret
  $psi.EnvironmentVariables['API_DATABASE_PATH'] = $script:banco
  $psi.EnvironmentVariables['API_HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['API_PORT'] = [string]$script:porta
  $psi.EnvironmentVariables['GATEWAY_PORT'] = [string]$script:portaGateway
  $psi.EnvironmentVariables['N8N_WEBHOOK_URL'] = $webhook
  $psi.EnvironmentVariables['WHATSAPP_EVENTO_CODIGO'] = $script:evento
  $psi.EnvironmentVariables['API_TLS_CERT_PATH'] = ''
  $psi.EnvironmentVariables['API_TLS_KEY_PATH'] = ''
  $script:gateway = New-Object System.Diagnostics.Process
  $script:gateway.StartInfo = $psi
  [void]$script:gateway.Start()
  $script:gateway.BeginOutputReadLine()
  $script:gateway.BeginErrorReadLine()
  if (-not (Aguardar-Porta $script:portaGateway $script:gateway 40)) { throw 'gateway nao subiu' }
}

function Iniciar-Apoio([string]$modo, [string]$destino, [string]$falhar) {
  Parar-Processo $script:apoio
  for ($i = 0; $i -lt 25; $i++) {
    if (-not (Porta-Aberta $script:portaApoio)) { break }
    Start-Sleep -Milliseconds 200
  }
  if (Porta-Aberta $script:portaApoio) { throw 'porta de apoio ocupada' }
  $argumentos = "--no-warnings `"$script:apoioArquivo`" $modo $script:portaApoio"
  if ($destino) { $argumentos += " `"$destino`"" }
  if ($falhar) { $argumentos += " `"$falhar`"" }
  $psi = Iniciar-Filho $argumentos
  $script:apoio = New-Object System.Diagnostics.Process
  $script:apoio.StartInfo = $psi
  [void]$script:apoio.Start()
  $script:apoio.BeginOutputReadLine()
  $script:apoio.BeginErrorReadLine()
  if (-not (Aguardar-Porta $script:portaApoio $script:apoio 25)) { throw 'apoio nao subiu' }
}

function Saida-Pronta($estado, [string]$wamid) {
  if (-not $estado) { return $false }
  $fila = Fila-De $estado $wamid
  $saida = Saida-De $estado $wamid
  return [bool]($fila -and $fila.status -eq 'entregue' -and $saida -and $saida.status -eq 'pendente_envio' -and [string]$saida.texto -match 'Quantos ingressos')
}

function Cenario([int]$numero, [string]$esperado, [scriptblock]$bloco) {
  try {
    $detalhe = & $bloco
    if ($detalhe -eq $true) {
      Resultado $numero $esperado $true ''
    } else {
      Resultado $numero $esperado $false ([string]$detalhe)
    }
  } catch {
    Resultado $numero $esperado $false $_.Exception.Message
  }
}

function Pid-Ouvindo([int]$alvo) {
  $linhas = & netstat.exe -ano -p tcp
  foreach ($linha in $linhas) {
    if ($linha -match (":{0}\s+\S+\s+LISTENING\s+(\d+)" -f $alvo)) {
      return [int]$Matches[1]
    }
  }
  return 0
}

function Variavel-Definida([int]$pidAlvo, [string]$nome) {
  return [EntradaProbeAmbiente]::Definida($pidAlvo, $nome)
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

if (-not ('EntradaProbeAmbiente' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class EntradaProbeAmbiente {
    const int ProcessBasicInformation = 0;
    const uint PROCESS_QUERY_INFORMATION = 0x0400;
    const uint PROCESS_VM_READ = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr Reserved3;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, ref PROCESS_BASIC_INFORMATION processInformation, int processInformationLength, out int returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr hProcess, IntPtr lpBaseAddress, byte[] lpBuffer, int dwSize, out IntPtr lpNumberOfBytesRead);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    static IntPtr ReadPtr(IntPtr process, IntPtr address) {
        byte[] buffer = new byte[IntPtr.Size];
        IntPtr read;
        if (!ReadProcessMemory(process, address, buffer, buffer.Length, out read) || read.ToInt64() != buffer.Length) {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        return IntPtr.Size == 8 ? (IntPtr)BitConverter.ToInt64(buffer, 0) : (IntPtr)BitConverter.ToInt32(buffer, 0);
    }

    public static bool Definida(int pid, string name) {
        IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            var info = new PROCESS_BASIC_INFORMATION();
            int length;
            int status = NtQueryInformationProcess(handle, ProcessBasicInformation, ref info, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out length);
            if (status != 0) throw new InvalidOperationException("status " + status);
            int parametersOffset = IntPtr.Size == 8 ? 0x20 : 0x10;
            IntPtr parameters = ReadPtr(handle, info.PebBaseAddress + parametersOffset);
            int environmentOffset = IntPtr.Size == 8 ? 0x80 : 0x48;
            IntPtr environment = ReadPtr(handle, parameters + environmentOffset);
            var block = new byte[128 * 1024];
            IntPtr read;
            if (!ReadProcessMemory(handle, environment, block, block.Length, out read) || read.ToInt64() < 4) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            int count = (int)read.ToInt64();
            if ((count % 2) == 1) count -= 1;
            string text = Encoding.Unicode.GetString(block, 0, count);
            string prefix = name + "=";
            int index = 0;
            while (index < text.Length) {
                int end = text.IndexOf('\0', index);
                if (end < 0 || end == index) break;
                string entry = text.Substring(index, end - index);
                if (entry.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && entry.Length > prefix.Length) return true;
                index = end + 1;
            }
            return false;
        } finally {
            CloseHandle(handle);
        }
    }
}
'@
}

try {
  if (-not (Porta-Aberta 5678)) {
    Write-Output 'FALHOU 1. COMPRAR pelo simulador passa no n8n (n8n nao esta em 127.0.0.1:5678)'
    exit 1
  }
  foreach ($ocupada in @($porta, $portaGateway, $portaApoio)) {
    if (Porta-Aberta $ocupada) {
      Write-Output "FALHOU 1. COMPRAR pelo simulador passa no n8n (a porta $ocupada ja esta em uso)"
      exit 1
    }
  }

  $envFile = Join-Path $raiz '.env'
  $adminToken = Ler-Env $envFile 'ADMIN_TOKEN'
  $internalToken = Ler-Env $envFile 'API_INTERNAL_TOKEN'
  $metaSecret = Ler-Env $envFile 'META_APP_SECRET'
  if ($adminToken.Length -lt 24 -or $internalToken.Length -lt 24 -or $metaSecret.Length -lt 1) {
    Write-Output 'FALHOU 1. COMPRAR pelo simulador passa no n8n (tokens ausentes ou curtos no .env)'
    exit 1
  }
  if (-not (Test-Path -LiteralPath (Join-Path $raiz 'work\whatsapp\verify-token.txt'))) {
    Write-Output 'FALHOU 4. mensagem assinada pelo gateway (verify-token ausente)'
    exit 1
  }

  $pidN8n = Pid-Ouvindo 5678
  $nomeN8n = ''
  if ($pidN8n -gt 0) { $nomeN8n = [string](Get-Process -Id $pidN8n -ErrorAction SilentlyContinue).ProcessName }
  $temInterno = $false
  $temAdmin = $true
  $temMeta = $true
  if ($pidN8n -gt 0) {
    $temInterno = Variavel-Definida $pidN8n 'API_INTERNAL_TOKEN'
    $temAdmin = Variavel-Definida $pidN8n 'ADMIN_TOKEN'
    $temMeta = Variavel-Definida $pidN8n 'META_APP_SECRET'
  }
  if ($nomeN8n -ne 'node' -or -not $temInterno -or $temAdmin -or $temMeta) {
    Write-Output ("FALHOU ambiente. API_INTERNAL_TOKEN={0} ADMIN_TOKEN={1} META_APP_SECRET={2} processo={3} (reinicie com scripts/iniciar-n8n.ps1)" -f $temInterno, $temAdmin, $temMeta, $nomeN8n)
    exit 1
  }
  Write-Output 'OK ambiente. o processo do n8n tem API_INTERNAL_TOKEN e nao tem ADMIN_TOKEN nem META_APP_SECRET'

  $portatil = Join-Path $raiz 'work\runtime\node_modules\node\bin\node.exe'
  if (Test-Path -LiteralPath $portatil) { $node = $portatil } else { $node = 'node' }

  Apagar-PastaTemporaria
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $script:consulta = Join-Path $tmp 'consulta.mjs'
  $script:apoioArquivo = Join-Path $tmp 'apoio.mjs'
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($script:consulta, @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const comando = process.argv[3];
if (comando === "silenciar") {
  db.prepare("UPDATE fila_webhook SET status = 'entregue', corpo = '' WHERE status IN ('pendente', 'processando')").run();
  process.stdout.write("ok");
} else if (comando === "estado") {
  const fila = db.prepare("SELECT id, wamid, telefone, status, tentativas, proxima_tentativa_em, ultimo_erro FROM fila_webhook").all();
  const saidas = db.prepare("SELECT wamid, texto, status FROM mensagens_saida").all();
  process.stdout.write(JSON.stringify({ fila, saidas }));
} else {
  throw new Error("comando desconhecido");
}
db.close();
'@, $utf8)
  [System.IO.File]::WriteAllText($script:apoioArquivo, @'
import { createServer } from "node:http";
const modo = process.argv[2];
const porta = Number(process.argv[3]);
const destino = process.argv[4] || "";
const falhar = process.argv[5] || "";
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  if (modo === "atrasar") {
    await new Promise((resolve) => setTimeout(resolve, 15000));
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("tarde");
    return;
  }
  if (modo === "recusar") {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("recusado");
    return;
  }
  let id = "";
  try { id = JSON.parse(body.toString("utf8")).id_mensagem || ""; } catch {}
  if (modo === "falhar-um" && id === falhar) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("falha");
    return;
  }
  try {
    const resposta = await fetch(destino, { method: "POST", headers: { "content-type": "application/json" }, body });
    const texto = Buffer.from(await resposta.arrayBuffer());
    res.writeHead(resposta.status, { "content-type": resposta.headers.get("content-type") || "application/json" });
    res.end(texto);
  } catch {
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("destino");
  }
});
server.listen(porta, "127.0.0.1");
'@, $utf8)

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

  Iniciar-Gateway $webhookReal

  Cenario 4 'mensagem de texto assinada devolve 200, processa e grava saida pendente_envio' {
    $script:wamid4 = Novo-Wamid 't4'
    $bytes4 = Bytes-Envelope '5511900004100' $script:wamid4 'COMPRAR' 'Teste Entrada'
    $assinado = Invoke-Gateway $bytes4 (Assinar-Bytes $bytes4)
    $estado = Esperar { param($e) Saida-Pronta $e $script:wamid4 } 30
    if ($assinado.Status -eq 200 -and (Saida-Pronta $estado $script:wamid4)) { return $true }
    $fila = Fila-De $estado $script:wamid4
    return "http $($assinado.Status) fila $($fila.status) $($assinado.Text)"
  }

  Cenario 5 'o mesmo wamid reenviado devolve 200 sem reprocessar nem duplicar saida' {
    $bytes5 = Bytes-Envelope '5511900004100' $script:wamid4 'COMPRAR' 'Teste Entrada'
    $repetido = Invoke-Gateway $bytes5 (Assinar-Bytes $bytes5)
    Start-Sleep -Seconds 2
    $estado = Estado-Atual
    $saidas = 0
    foreach ($item in (ComoLista $estado.saidas)) {
      if ([string]$item.wamid -eq $script:wamid4) { $saidas++ }
    }
    $fila = Fila-De $estado $script:wamid4
    $novas = -1
    if ($repetido.Json) { $novas = [int]$repetido.Json.enfileiradas }
    if ($repetido.Status -eq 200 -and $novas -eq 0 -and $saidas -eq 1 -and $fila.status -eq 'entregue') { return $true }
    return "http $($repetido.Status) novas $novas saidas $saidas fila $($fila.status)"
  }

  Cenario 6 'assinatura invalida devolve 401 e nao grava linha na fila' {
    $wamid6 = Novo-Wamid 't6'
    $antes = (ComoLista (Estado-Atual).fila).Count
    $bytes6 = Bytes-Envelope '5511900004600' $wamid6 'COMPRAR' 'Teste Entrada'
    $ruim = Invoke-Gateway $bytes6 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
    Start-Sleep -Milliseconds 400
    $estado = Estado-Atual
    $depois = (ComoLista $estado.fila).Count
    if ($ruim.Status -eq 401 -and $depois -eq $antes -and -not (Fila-De $estado $wamid6)) { return $true }
    return "http $($ruim.Status) antes $antes depois $depois"
  }

  Cenario 7 'destino indisponivel acumula a fila e, com o n8n de volta, entrega e processa' {
    $portaFechada = 0
    foreach ($candidata in @(8019, 8021, 8023, 9)) {
      if (-not (Porta-Aberta $candidata)) { $portaFechada = $candidata; break }
    }
    if ($portaFechada -eq 0) { return 'nenhuma porta fechada para o destino' }
    Iniciar-Gateway "http://127.0.0.1:${portaFechada}/webhook/whatsapp-mensagens"
    $wamidA = Novo-Wamid 't7a'
    $wamidB = Novo-Wamid 't7b'
    $corpoA = Bytes-Envelope '5511900004701' $wamidA 'COMPRAR' 'Teste Entrada'
    $corpoB = Bytes-Envelope '5511900004702' $wamidB 'COMPRAR' 'Teste Entrada'
    $respA = Invoke-Gateway $corpoA (Assinar-Bytes $corpoA)
    $respB = Invoke-Gateway $corpoB (Assinar-Bytes $corpoB)
    if ($respA.Status -ne 200 -or $respB.Status -ne 200) { return "http $($respA.Status)/$($respB.Status)" }
    $parado = Esperar {
      param($e)
      $a = Fila-De $e $wamidA
      $b = Fila-De $e $wamidB
      return ($a -and $b -and [int]$a.tentativas -ge 1 -and [int]$b.tentativas -ge 1 -and $a.status -eq 'pendente' -and $b.status -eq 'pendente' -and -not (Saida-De $e $wamidA) -and -not (Saida-De $e $wamidB))
    } 20
    $filaA = Fila-De $parado $wamidA
    $filaB = Fila-De $parado $wamidB
    if (-not $filaA -or -not $filaB -or $filaA.status -ne 'pendente' -or $filaB.status -ne 'pendente') {
      return "acumulo http $($respA.Status)/$($respB.Status) $($filaA.status)/$($filaB.status)"
    }
    Parar-Processo $script:gateway
    Iniciar-Gateway $script:webhookReal
    $entregue = Esperar { param($e) (Saida-Pronta $e $wamidA) -and (Saida-Pronta $e $wamidB) } 40
    if ((Saida-Pronta $entregue $wamidA) -and (Saida-Pronta $entregue $wamidB)) { return $true }
    return 'a fila nao foi entregue depois que o destino voltou'
  }

  Cenario 8 'falha da primeira segura a segunda do mesmo telefone; outro telefone passa' {
    $wamidA1 = Novo-Wamid 't8a'
    $wamidA2 = Novo-Wamid 't8b'
    $wamidB = Novo-Wamid 't8c'
    Iniciar-Apoio 'falhar-um' $script:webhookReal $wamidA1
    Iniciar-Gateway "http://127.0.0.1:$script:portaApoio/"
    $corpo1 = Bytes-Envelope '5511900004801' $wamidA1 'COMPRAR' 'Teste Entrada'
    $primeiro = Invoke-Gateway $corpo1 (Assinar-Bytes $corpo1)
    $falhou = Esperar {
      param($e)
      $a1 = Fila-De $e $wamidA1
      return ($a1 -and [int]$a1.tentativas -ge 1 -and $a1.status -eq 'pendente')
    } 15
    if (-not (Fila-De $falhou $wamidA1) -or (Fila-De $falhou $wamidA1).status -ne 'pendente') {
      return "primeira nao ficou pendente http $($primeiro.Status)"
    }
    $corpo2 = Bytes-Envelope '5511900004801' $wamidA2 '2' 'Teste Entrada'
    $corpoB = Bytes-Envelope '5511900004802' $wamidB 'COMPRAR' 'Teste Entrada'
    Invoke-Gateway $corpo2 (Assinar-Bytes $corpo2) | Out-Null
    Invoke-Gateway $corpoB (Assinar-Bytes $corpoB) | Out-Null
    $estado = Esperar {
      param($e)
      $a1 = Fila-De $e $wamidA1
      $a2 = Fila-De $e $wamidA2
      $b = Fila-De $e $wamidB
      $saidaB = Saida-De $e $wamidB
      return ($a1 -and $a1.status -ne 'entregue' -and $a2 -and $a2.status -eq 'pendente' -and [int]$a2.tentativas -eq 0 -and $b -and $b.status -eq 'entregue' -and $saidaB -and $saidaB.status -eq 'pendente_envio' -and [string]$saidaB.texto -match 'Quantos ingressos' -and -not (Saida-De $e $wamidA1) -and -not (Saida-De $e $wamidA2))
    } 25
    $a2 = Fila-De $estado $wamidA2
    $b = Fila-De $estado $wamidB
    if ($a2 -and [int]$a2.tentativas -eq 0 -and $b.status -eq 'entregue' -and -not (Saida-De $estado $wamidA1)) { return $true }
    return "segunda $($a2.status)/$($a2.tentativas) outra $($b.status)"
  }

  Cenario 9 'reinicio do worker retoma pendentes e processando' {
    Parar-Processo $script:gateway
    Parar-Processo $script:apoio
    Silenciar-Fila
    $wamidP = Novo-Wamid 't9p'
    $wamidQ = Novo-Wamid 't9q'
    Iniciar-Apoio 'atrasar' '' ''
    Iniciar-Gateway "http://127.0.0.1:$script:portaApoio/"
    $corpoP = Bytes-Envelope '5511900004901' $wamidP 'COMPRAR' 'Teste Entrada'
    $respP = Invoke-Gateway $corpoP (Assinar-Bytes $corpoP)
    $processando = Esperar {
      param($e)
      $p = Fila-De $e $wamidP
      return ($p -and $p.status -eq 'processando')
    } 15
    $linhaP = Fila-De $processando $wamidP
    if (-not $linhaP -or $linhaP.status -ne 'processando') {
      return "a primeira nao ficou processando http $($respP.Status) status $($linhaP.status) tentativas $($linhaP.tentativas) erro $($linhaP.ultimo_erro)"
    }
    $corpoQ = Bytes-Envelope '5511900004902' $wamidQ 'COMPRAR' 'Teste Entrada'
    Invoke-Gateway $corpoQ (Assinar-Bytes $corpoQ) | Out-Null
    $enfileirou = Esperar {
      param($e)
      $p = Fila-De $e $wamidP
      $q = Fila-De $e $wamidQ
      return ($p -and $p.status -eq 'processando' -and $q -and $q.status -eq 'pendente')
    } 10
    if (-not (Fila-De $enfileirou $wamidQ) -or (Fila-De $enfileirou $wamidP).status -ne 'processando') {
      return 'pendente e processando nao conviveram'
    }
    Parar-Processo $script:gateway
    Parar-Processo $script:apoio
    Iniciar-Gateway $script:webhookReal
    $entregue = Esperar { param($e) (Saida-Pronta $e $wamidP) -and (Saida-Pronta $e $wamidQ) } 40
    if ((Saida-Pronta $entregue $wamidP) -and (Saida-Pronta $entregue $wamidQ)) { return $true }
    return 'o worker reiniciado nao entregou as duas'
  }

  Cenario 10 'reenfileirar recoloca um evento que falhou na fila' {
    Parar-Processo $script:gateway
    Parar-Processo $script:apoio
    $wamid = Novo-Wamid 't10'
    Iniciar-Apoio 'recusar' '' ''
    Iniciar-Gateway "http://127.0.0.1:$script:portaApoio/"
    $corpo = Bytes-Envelope '5511900005001' $wamid 'COMPRAR' 'Teste Entrada'
    $resp = Invoke-Gateway $corpo (Assinar-Bytes $corpo)
    $falhou = Esperar {
      param($e)
      $linha = Fila-De $e $wamid
      return ($linha -and $linha.status -eq 'falhou')
    } 15
    $linha = Fila-De $falhou $wamid
    if (-not $linha -or $linha.status -ne 'falhou') { return "nao falhou http $($resp.Status) $($linha.status)" }
    Parar-Processo $script:gateway
    Parar-Processo $script:apoio
    $lista = Invoke-Api -Method 'GET' -Path '/admin/whatsapp/fila' -Admin $true
    $item = $null
    foreach ($candidato in (ComoLista $lista.Json.itens)) {
      if ([string]$candidato.id -eq [string]$linha.id) { $item = $candidato }
    }
    $reposto = Invoke-Api -Method 'POST' -Path ("/admin/whatsapp/fila/{0}/reenfileirar" -f $linha.id) -Admin $true
    $estado = Estado-Atual
    $deNovo = Fila-De $estado $wamid
    if ($lista.Status -ne 200 -or -not $item -or [int]$item.tem_corpo -ne 1 -or $reposto.Status -ne 200 -or $deNovo.status -ne 'pendente' -or [int]$deNovo.tentativas -ne 0) {
      return "lista $($lista.Status) repor $($reposto.Status) status $($deNovo.status) tentativas $($deNovo.tentativas)"
    }
    Iniciar-Gateway $script:webhookReal
    $entregue = Esperar { param($e) Saida-Pronta $e $wamid } 30
    if (Saida-Pronta $entregue $wamid) { return $true }
    return 'reenfileirou mas nao entregou'
  }
} finally {
  Parar-Processo $gateway
  Parar-Processo $apoio
  Parar-Processo $proc
  $consultaSolta = Join-Path $env:TEMP 'testar-entrada-consulta.mjs'
  if (Test-Path -LiteralPath $consultaSolta) { Remove-Item -LiteralPath $consultaSolta -Force -ErrorAction SilentlyContinue }
  Apagar-PastaTemporaria
}

if ($falhas -gt 0) { exit 1 }
Write-Output 'Entrada unificada ok.'
