# Envio real simulado: Graph falso local, n8n real e banco temporario.
# Requer o n8n em 127.0.0.1:5678 com o fluxo 04 publicado.
# Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testar-envio.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$porta = 8022
$portaGateway = 8023
$portaGraph = 8024
$tmp = Join-Path $raiz 'work\tmp-teste-envio'
$banco = Join-Path $tmp 'teste.sqlite'
$comprovantes = Join-Path $tmp 'comprovantes'
$evento = 'evento-demonstracao'
$falhas = 0
$proc = $null
$gateway = $null
$graph = $null
$adminToken = ''
$internalToken = ''
$metaSecret = ''
$tokenEnvio = 'envio-teste-local-token-123456'
$phoneId = '123456789012345'
$wamidSaida = 'wamid.saida.falso'
$telefoneTexto = '5511900001111'
$telefoneImagem = '5511900002222'
$node = $null

function Texto-Seguro([string]$texto) {
  if (-not $texto) { return '' }
  $limpo = [regex]::Replace($texto, '(?i)bearer\s+\S+', 'bearer [omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)(api_internal_token|admin_token|meta_app_secret|meta_access_token)\s*[=:]\s*\S+', '$1=[omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)sha256=[0-9a-f]+', 'sha256=[omitido]')
  foreach ($segredo in @($script:adminToken, $script:internalToken, $script:metaSecret, $script:tokenEnvio)) {
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

function Json-Texto([string]$valor) {
  $limpo = $valor.Replace('\', '\\').Replace('"', '\"')
  return '"' + $limpo + '"'
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
  return [pscustomobject]@{ Status = $codigo; Text = $texto }
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

function Estado-Atual {
  $saida = & $script:node --no-warnings $script:consulta $script:banco estado
  if ($LASTEXITCODE -ne 0) { throw 'consulta do banco falhou' }
  return ($saida | Out-String).Trim() | ConvertFrom-Json
}

function ComoLista($valor) {
  if ($null -eq $valor) { return @() }
  if ($valor -is [System.Array]) { return $valor }
  return @($valor)
}

function Enderecos-Escuta([int]$alvo) {
  $lista = New-Object System.Collections.Generic.List[string]
  foreach ($proto in @('tcp', 'tcpv6')) {
    foreach ($linha in (& netstat.exe -ano -p $proto)) {
      if ($linha -notmatch 'LISTENING') { continue }
      $padrao = "(\S+):{0}\s+" -f $alvo
      if ($linha -match $padrao) { $lista.Add($Matches[1]) }
    }
  }
  return $lista
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

if (-not ('EnvioProbeAmbiente' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class EnvioProbeAmbiente {
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

    static bool Alguma(int pid, Func<string, bool> predicado) {
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
            var block = new System.Collections.Generic.List<byte>();
            int offset = 0;
            while (offset < 256 * 1024) {
                byte[] chunk = new byte[4096];
                IntPtr read;
                IntPtr address = new IntPtr(environment.ToInt64() + offset);
                bool ok = ReadProcessMemory(handle, address, chunk, chunk.Length, out read);
                int n = read.ToInt64() > 0 ? (int)read.ToInt64() : 0;
                for (int i = 0; i < n; i++) block.Add(chunk[i]);
                offset += n;
                if (!ok || n < chunk.Length) break;
                if (block.Count >= 4 && block[block.Count - 1] == 0 && block[block.Count - 2] == 0 && block[block.Count - 3] == 0 && block[block.Count - 4] == 0) break;
            }
            if (block.Count < 4) throw new Win32Exception(Marshal.GetLastWin32Error());
            byte[] bytes = block.ToArray();
            int count = bytes.Length;
            if ((count % 2) == 1) count -= 1;
            string text = Encoding.Unicode.GetString(bytes, 0, count);
            int index = 0;
            while (index < text.Length) {
                int end = text.IndexOf('\0', index);
                if (end < 0 || end == index) break;
                string entry = text.Substring(index, end - index);
                if (predicado(entry)) return true;
                index = end + 1;
            }
            return false;
        } finally {
            CloseHandle(handle);
        }
    }

    public static bool Definida(int pid, string name) {
        string prefix = name + "=";
        return Alguma(pid, entry => entry.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) && entry.Length > prefix.Length);
    }
}
'@
}

try {
  if (-not (Porta-Aberta 5678)) {
    Write-Output 'FALHOU 1. texto assinado chega a enviada (n8n nao esta em 127.0.0.1:5678)'
    exit 1
  }
  foreach ($ocupada in @($porta, $portaGateway, $portaGraph)) {
    if (Porta-Aberta $ocupada) {
      Write-Output "FALHOU 1. texto assinado chega a enviada (a porta $ocupada ja esta em uso)"
      exit 1
    }
  }

  $envFile = Join-Path $raiz '.env'
  $adminToken = Ler-Env $envFile 'ADMIN_TOKEN'
  $internalToken = Ler-Env $envFile 'API_INTERNAL_TOKEN'
  $metaSecret = Ler-Env $envFile 'META_APP_SECRET'
  if ($adminToken.Length -lt 24 -or $internalToken.Length -lt 24 -or $metaSecret.Length -lt 1) {
    Write-Output 'FALHOU 1. texto assinado chega a enviada (tokens ausentes ou curtos no .env)'
    exit 1
  }

  $pidN8n = Pid-Ouvindo 5678
  $nomeN8n = ''
  if ($pidN8n -gt 0) { $nomeN8n = [string](Get-Process -Id $pidN8n -ErrorAction SilentlyContinue).ProcessName }
  $temAcesso = $true
  if ($pidN8n -gt 0) { $temAcesso = [EnvioProbeAmbiente]::Definida($pidN8n, 'META_ACCESS_TOKEN') }
  $enderecos = Enderecos-Escuta 5678
  $soLocal = $enderecos.Count -gt 0
  foreach ($endereco in $enderecos) {
    if ([string]$endereco -ne '127.0.0.1') { $soLocal = $false }
  }
  if ($nomeN8n -ne 'node' -or $temAcesso -or -not $soLocal) {
    Write-Output ("FALHOU 6. n8n so em 127.0.0.1 e sem META_ACCESS_TOKEN (processo={0} escuta={1} token={2})" -f $nomeN8n, ($enderecos -join ','), $temAcesso)
    exit 1
  }
  Resultado 6 'n8n so em 127.0.0.1 e sem META_ACCESS_TOKEN' $true ''

  $portatil = Join-Path $raiz 'work\runtime\node_modules\node\bin\node.exe'
  if (Test-Path -LiteralPath $portatil) { $node = $portatil } else { $node = 'node' }

  Apagar-PastaTemporaria
  New-Item -ItemType Directory -Path $tmp | Out-Null
  New-Item -ItemType Directory -Path $comprovantes | Out-Null
  $script:consulta = Join-Path $tmp 'consulta.mjs'
  $script:graphArquivo = Join-Path $tmp 'graph.mjs'
  $png = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hashPng = ([System.BitConverter]::ToString($sha.ComputeHash($png))).Replace('-', '').ToLowerInvariant()
  $sha.Dispose()
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($script:consulta, @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const comando = process.argv[3];
if (comando === "estado") {
  const saidas = db.prepare("SELECT id, wamid, status, wamid_saida FROM mensagens_saida").all();
  const entradas = db.prepare("SELECT wamid FROM mensagens_entrada").all();
  const custos = db.prepare("SELECT wamid_saida, status, billable FROM mensagens_custo").all();
  const pedidos = db.prepare("SELECT comprador_telefone, status, status_pagamento FROM pedidos").all();
  process.stdout.write(JSON.stringify({ saidas, entradas, custos, pedidos }));
} else if (comando === "pedido") {
  const evento = db.prepare("SELECT id FROM eventos WHERE codigo = ?").get(process.argv[4]);
  const lote = db.prepare("SELECT id FROM lotes WHERE evento_id = ? LIMIT 1").get(evento.id);
  const agora = new Date().toISOString();
  const telefone = process.argv[5];
  db.prepare(`
    INSERT INTO pedidos (
      protocolo, evento_id, lote_id, data_contato, origem, comprador_nome, comprador_telefone,
      quantidade, valor_unitario_centavos, valor_total_centavos, reserva_expira_em,
      status, status_pagamento, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, 'teste', 'Ana', ?, 1, 1000, 1000, ?, 'aguardando_pagamento', 'pendente', ?, ?)
  `).run("P-envio-" + telefone, evento.id, lote.id, agora, telefone, agora, agora, agora);
  process.stdout.write("ok");
} else {
  throw new Error("comando desconhecido");
}
db.close();
'@, $utf8)
  $pngBase64 = [Convert]::ToBase64String($png)
  $graphCodigo = @"
import { createServer } from 'node:http';
const png = Buffer.from('$pngBase64', 'base64');
const porta = Number(process.argv[2]);
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: '$wamidSaida' }] }));
    return;
  }
  if (url.pathname.endsWith('/midia-img')) {
    res.end(JSON.stringify({
      url: 'http://127.0.0.1:' + porta + '/arquivo.png',
      mime_type: 'image/png',
      file_size: png.length,
    }));
    return;
  }
  if (url.pathname === '/arquivo.png') {
    res.end(png);
    return;
  }
  res.writeHead(404);
  res.end('nao');
});
server.listen(porta, '127.0.0.1');
"@
  [System.IO.File]::WriteAllText($script:graphArquivo, $graphCodigo, $utf8)

  $psiGraph = Iniciar-Filho "--no-warnings `"$script:graphArquivo`" $portaGraph"
  [void]$psiGraph.EnvironmentVariables.Remove('META_ACCESS_TOKEN')
  $graph = New-Object System.Diagnostics.Process
  $graph.StartInfo = $psiGraph
  [void]$graph.Start()
  $graph.BeginOutputReadLine()
  $graph.BeginErrorReadLine()
  if (-not (Aguardar-Porta $portaGraph $graph 25)) { throw 'graph falso nao subiu' }

  $psi = Iniciar-Filho '--no-warnings api/server.mjs'
  $psi.EnvironmentVariables['ADMIN_TOKEN'] = $adminToken
  $psi.EnvironmentVariables['API_INTERNAL_TOKEN'] = $internalToken
  $psi.EnvironmentVariables['API_HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['API_PORT'] = [string]$porta
  $psi.EnvironmentVariables['API_DATABASE_PATH'] = $banco
  $psi.EnvironmentVariables['API_TLS_CERT_PATH'] = ''
  $psi.EnvironmentVariables['API_TLS_KEY_PATH'] = ''
  $psi.EnvironmentVariables['USAR_PORTA_TESTE'] = '1'
  $psi.EnvironmentVariables['META_ACCESS_TOKEN'] = $tokenEnvio
  $psi.EnvironmentVariables['META_PHONE_NUMBER_ID'] = $phoneId
  $psi.EnvironmentVariables['META_GRAPH_VERSION'] = 'v0.0'
  $psi.EnvironmentVariables['META_GRAPH_BASE_URL'] = "http://127.0.0.1:$portaGraph"
  $psi.EnvironmentVariables['COMPROVANTES_DIR'] = $comprovantes
  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()
  if (-not (Aguardar-Porta $porta $proc 40)) { throw 'API nao subiu' }

  $pedido = & $node --no-warnings $script:consulta $banco pedido $evento $telefoneImagem
  if ($LASTEXITCODE -ne 0 -or (($pedido | Out-String).Trim() -ne 'ok')) { throw 'nao criei o pedido em aberto' }

  $psiGateway = Iniciar-Filho '--no-warnings api/whatsapp-gateway.mjs'
  $psiGateway.EnvironmentVariables['META_APP_SECRET'] = $metaSecret
  $psiGateway.EnvironmentVariables['API_INTERNAL_TOKEN'] = $internalToken
  $psiGateway.EnvironmentVariables['API_DATABASE_PATH'] = $banco
  $psiGateway.EnvironmentVariables['API_HOST'] = '127.0.0.1'
  $psiGateway.EnvironmentVariables['API_PORT'] = [string]$porta
  $psiGateway.EnvironmentVariables['GATEWAY_PORT'] = [string]$portaGateway
  $psiGateway.EnvironmentVariables['N8N_WEBHOOK_URL'] = 'http://127.0.0.1:5678/webhook/whatsapp-mensagens'
  $psiGateway.EnvironmentVariables['WHATSAPP_EVENTO_CODIGO'] = $evento
  $psiGateway.EnvironmentVariables['API_TLS_CERT_PATH'] = ''
  $psiGateway.EnvironmentVariables['API_TLS_KEY_PATH'] = ''
  $psiGateway.EnvironmentVariables['USAR_PORTA_TESTE'] = '1'
  [void]$psiGateway.EnvironmentVariables.Remove('META_ACCESS_TOKEN')
  $gateway = New-Object System.Diagnostics.Process
  $gateway.StartInfo = $psiGateway
  [void]$gateway.Start()
  $gateway.BeginOutputReadLine()
  $gateway.BeginErrorReadLine()
  if (-not (Aguardar-Porta $portaGateway $gateway 40)) { throw 'gateway nao subiu' }

  $agoraUnix = [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  $wamidTexto = 'wamid.texto.' + [guid]::NewGuid().ToString('N')
  $jsonTexto = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":"Ana"},"wa_id":' + (Json-Texto $telefoneTexto) + '}],"messages":[{"from":' + (Json-Texto $telefoneTexto) + ',"id":' + (Json-Texto $wamidTexto) + ',"timestamp":' + (Json-Texto $agoraUnix) + ',"type":"text","text":{"body":"oi"}}]}}]}]}'
  $bytesTexto = [System.Text.Encoding]::UTF8.GetBytes($jsonTexto)
  $respostaTexto = Invoke-Gateway $bytesTexto (Assinar-Bytes $bytesTexto)
  if ($respostaTexto.Status -ne 200) { throw "webhook de texto respondeu $($respostaTexto.Status)" }

  $estadoEnviada = $null
  $limite = (Get-Date).AddSeconds(25)
  do {
    $estadoEnviada = Estado-Atual
    $achou = $false
    foreach ($item in (ComoLista $estadoEnviada.saidas)) {
      if ([string]$item.wamid -eq $wamidTexto -and [string]$item.status -eq 'enviada' -and [string]$item.wamid_saida -eq $wamidSaida) {
        $achou = $true
      }
    }
    if ($achou) { break }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $limite)
  Resultado 1 'texto assinado chega a enviada com o wamid do falso' $achou ($(if ($estadoEnviada) { $estadoEnviada | ConvertTo-Json -Compress } else { 'sem estado' }))

  $repetido = Invoke-Gateway $bytesTexto (Assinar-Bytes $bytesTexto)
  Start-Sleep -Seconds 2
  $estadoRepetido = Estado-Atual
  $contagemSaida = 0
  foreach ($item in (ComoLista $estadoRepetido.saidas)) {
    if ([string]$item.wamid -eq $wamidTexto) { $contagemSaida++ }
  }
  Resultado 2 'o mesmo wamid de entrada nao gera segunda saida' ($repetido.Status -eq 200 -and $contagemSaida -eq 1) "status=$($repetido.Status) saidas=$contagemSaida"

  $idSaida = ''
  foreach ($item in (ComoLista $estadoRepetido.saidas)) {
    if ([string]$item.wamid -eq $wamidTexto) { $idSaida = [string]$item.id }
  }
  $jsonStatus = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","statuses":[{"id":' + (Json-Texto $wamidSaida) + ',"status":"delivered","timestamp":' + (Json-Texto $agoraUnix) + ',"biz_opaque_callback_data":' + (Json-Texto $idSaida) + '}]}}]}]}'
  $bytesStatus = [System.Text.Encoding]::UTF8.GetBytes($jsonStatus)
  $respostaStatus = Invoke-Gateway $bytesStatus (Assinar-Bytes $bytesStatus)
  $estadoCusto = Estado-Atual
  $linhasCusto = 0
  foreach ($item in (ComoLista $estadoCusto.custos)) {
    if ([string]$item.wamid_saida -eq $wamidSaida -and [string]$item.status -eq 'delivered') { $linhasCusto++ }
  }
  Resultado 3 'status delivered grava uma linha de custo' ($respostaStatus.Status -eq 200 -and $linhasCusto -eq 1) "status=$($respostaStatus.Status) linhas=$linhasCusto"

  $wamidImagem = 'wamid.imagem.' + [guid]::NewGuid().ToString('N')
  $jsonImagem = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":"Ana"},"wa_id":' + (Json-Texto $telefoneImagem) + '}],"messages":[{"from":' + (Json-Texto $telefoneImagem) + ',"id":' + (Json-Texto $wamidImagem) + ',"timestamp":' + (Json-Texto $agoraUnix) + ',"type":"image","image":{"id":"midia-img","mime_type":"image/png","sha256":' + (Json-Texto $hashPng) + ',"filename":"pix.png"}}]}}]}]}'
  $bytesImagem = [System.Text.Encoding]::UTF8.GetBytes($jsonImagem)
  $respostaImagem = Invoke-Gateway $bytesImagem (Assinar-Bytes $bytesImagem)
  $analise = $false
  $arquivo = $false
  $limiteImagem = (Get-Date).AddSeconds(25)
  do {
    $estadoImagem = Estado-Atual
    foreach ($item in (ComoLista $estadoImagem.pedidos)) {
      if ([string]$item.comprador_telefone -eq $telefoneImagem -and [string]$item.status -eq 'pagamento_em_analise') {
        $analise = $true
      }
    }
    $arquivo = @(Get-ChildItem -LiteralPath $comprovantes -File -ErrorAction SilentlyContinue).Count -ge 1
    if ($analise -and $arquivo) { break }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $limiteImagem)
  Resultado 4 'imagem de pedido em aberto vira arquivo no data temporario e pedido em analise' ($respostaImagem.Status -eq 200 -and $analise -and $arquivo) "webhook=$($respostaImagem.Status) analise=$analise arquivo=$arquivo"

  $ruim = Invoke-Gateway $bytesTexto 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
  Resultado 5 'HMAC invalido continua 401' ($ruim.Status -eq 401) "status=$($ruim.Status)"
} catch {
  $falhas++
  Write-Output ("FALHOU execucao. {0}" -f (Texto-Seguro $_.Exception.Message))
} finally {
  Parar-Processo $gateway
  Parar-Processo $proc
  Parar-Processo $graph
  try { Apagar-PastaTemporaria } catch {}
}

if ($falhas -gt 0) { exit 1 }
exit 0
