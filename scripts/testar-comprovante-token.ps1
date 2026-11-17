# Download de comprovante com token invalido: Graph falso local, n8n real e banco temporario.
# Requer o n8n em 127.0.0.1:5678 com o fluxo 04 publicado.
# O backoff de producao nao muda (teto 300 s, FILA_MAX_TENTATIVAS 30).
# Para nao esperar esse backoff, o script grava proxima_tentativa_em no passado
# so no banco temporario. Outra forma, sem mexer no padrao da API, e definir
# FILA_MAX_TENTATIVAS apenas no processo de teste. Este script nao define essa variavel.
# Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testar-comprovante-token.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$porta = 8042
$portaGateway = 8043
$portaGraph = 8044
$tmp = Join-Path $raiz 'work\tmp-teste-comprovante-token'
$comprovantes = Join-Path $tmp 'comprovantes'
$banco = Join-Path $tmp 'teste.sqlite'
$evento = 'evento-demonstracao'
$falhas = 0
$proc = $null
$gateway = $null
$graph = $null
$adminToken = ''
$internalToken = ''
$metaSecret = ''
$tokenA = 'comprovante-token-a-123456'
$tokenB = 'comprovante-token-b-123456'
$phoneId = '123456789012345'
$telefone = '5511900004441'
$node = $null
$utf8 = New-Object System.Text.UTF8Encoding $false

function Texto-Seguro([string]$texto) {
  if (-not $texto) { return '' }
  $limpo = [regex]::Replace($texto, '(?i)bearer\s+\S+', 'bearer [omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)(api_internal_token|admin_token|meta_app_secret|meta_access_token)\s*[=:]\s*\S+', '$1=[omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)sha256=[0-9a-f]+', 'sha256=[omitido]')
  foreach ($segredo in @($script:adminToken, $script:internalToken, $script:metaSecret, $script:tokenA, $script:tokenB)) {
    if ($segredo -and $segredo.Length -ge 8) { $limpo = $limpo.Replace($segredo, '[omitido]') }
  }
  $limpo = $limpo.Replace("`r", ' ').Replace("`n", ' ')
  if ($limpo.Length -gt 220) { return $limpo.Substring(0, 220) }
  return $limpo
}

function Garantir-SemSegredo([string]$texto) {
  if (-not $texto) { return }
  foreach ($segredo in @($script:adminToken, $script:internalToken, $script:metaSecret, $script:tokenA, $script:tokenB)) {
    if ($segredo -and $segredo.Length -ge 8 -and $texto.Contains($segredo)) {
      throw 'a saida contem segredo'
    }
  }
}

function Vigiar($processo) {
  # Sem callback em PowerShell: o evento reentraria no runspace e travaria o script.
  $processo.BeginOutputReadLine()
  $processo.BeginErrorReadLine()
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
  $seguro = Texto-Seguro $detalhe
  Garantir-SemSegredo $seguro
  if ($ok) {
    Write-Output "OK $numero. $esperado"
    return
  }
  $script:falhas++
  if ($seguro) {
    Write-Output ("FALHOU $numero. $esperado ({0})" -f $seguro)
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

function Aguardar-PortaFechada([int]$alvo, [int]$tentativas) {
  for ($i = 0; $i -lt $tentativas; $i++) {
    if (-not (Porta-Aberta $alvo)) { return $true }
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
  $texto = ($saida | Out-String).Trim()
  Garantir-SemSegredo $texto
  if ($texto.Contains('pausa:')) { throw 'a saida contem segredo' }
  return $texto | ConvertFrom-Json
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

function Invoke-Curl([string]$method, [string]$uri, [hashtable]$headers, [string]$bodyFile) {
  $saida = Join-Path $script:tmp ('curl-' + [guid]::NewGuid().ToString('N') + '.txt')
  $curlArgs = @('-sS', '--noproxy', '*', '-o', $saida, '-w', '%{http_code}', '--max-time', '20', '-X', $method)
  if ($headers) {
    foreach ($chave in $headers.Keys) {
      $curlArgs += @('-H', ($chave + ': ' + $headers[$chave]))
    }
  }
  if ($bodyFile) { $curlArgs += @('--data-binary', "@$bodyFile") }
  $curlArgs += $uri
  $preferencia = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $codigo = & curl.exe @curlArgs 2>$null
  } finally {
    $ErrorActionPreference = $preferencia
  }
  $texto = ''
  if (Test-Path -LiteralPath $saida) { $texto = [System.IO.File]::ReadAllText($saida) }
  Garantir-SemSegredo $texto
  $status = 0
  [void][int]::TryParse(([string]$codigo).Trim(), [ref]$status)
  return [pscustomobject]@{ Status = $status; Text = $texto }
}

function Gravar-Json([string]$caminho, [string]$json) {
  [System.IO.File]::WriteAllText($caminho, $json, $script:utf8)
}

function Enviar-Imagem([string]$wamid, [string]$hashPng) {
  $agoraUnix = [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  $json = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":"Ana"},"wa_id":' + (Json-Texto $script:telefone) + '}],"messages":[{"from":' + (Json-Texto $script:telefone) + ',"id":' + (Json-Texto $wamid) + ',"timestamp":' + (Json-Texto $agoraUnix) + ',"type":"image","image":{"id":"midia-img","mime_type":"image/png","sha256":' + (Json-Texto $hashPng) + ',"filename":"pix.png"}}]}}]}]}'
  $arquivo = Join-Path $script:tmp ('webhook-' + [guid]::NewGuid().ToString('N') + '.json')
  Gravar-Json $arquivo $json
  $bytes = [System.IO.File]::ReadAllBytes($arquivo)
  return Invoke-Curl 'POST' "http://127.0.0.1:$script:portaGateway/whatsapp-webhook" @{
    'Content-Type' = 'application/json; charset=utf-8'
    'X-Hub-Signature-256' = (Assinar-Bytes $bytes)
  } $arquivo
}

function Obter-Admin([string]$caminho) {
  return Invoke-Curl 'GET' "http://127.0.0.1:$script:porta$caminho" @{
    Authorization = "Bearer $($script:adminToken)"
  } ''
}

function Contagem-Graph {
  $resposta = Invoke-Curl 'GET' "http://127.0.0.1:$script:portaGraph/contagem" @{} ''
  if ($resposta.Status -ne 200) { throw 'contagem do graph falso falhou' }
  return $resposta.Text | ConvertFrom-Json
}

function Modo-Graph([string]$modo) {
  $resposta = Invoke-Curl 'GET' "http://127.0.0.1:$script:portaGraph/modo?valor=$modo" @{} ''
  if ($resposta.Status -ne 200) { throw 'nao mudei o modo do graph falso' }
}

function Adiantar-Fila {
  # So o banco temporario. Nao altera FILA_MAX_TENTATIVAS nem o teto de 300 s.
  $saida = & $script:node --no-warnings $script:consulta $script:banco adiantar
  if ($LASTEXITCODE -ne 0) { throw 'nao antecipei a fila temporaria' }
  Garantir-SemSegredo (($saida | Out-String).Trim())
}

function Aguardar-Ate([scriptblock]$pronto, [int]$segundos) {
  $limite = (Get-Date).AddSeconds($segundos)
  do {
    if (& $pronto) { return $true }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $limite)
  return [bool](& $pronto)
}

function Arquivos-Locais {
  return @(Get-ChildItem -LiteralPath $script:comprovantes -File -ErrorAction SilentlyContinue).Count
}

function Entrada-Do([string]$wamid, $estado) {
  $n = 0
  foreach ($item in (ComoLista $estado.entradas)) {
    if ([string]$item.wamid -eq $wamid) { $n++ }
  }
  return $n
}

function Fila-Do([string]$wamid, $estado) {
  foreach ($item in (ComoLista $estado.fila)) {
    if ([string]$item.wamid -eq $wamid) { return $item }
  }
  return $null
}

function Pedido-Aguardando($estado) {
  foreach ($item in (ComoLista $estado.pedidos)) {
    if ([string]$item.comprador_telefone -eq $script:telefone -and [string]$item.status -eq 'aguardando_pagamento') {
      return $true
    }
  }
  return $false
}

function Pedido-Analise($estado) {
  foreach ($item in (ComoLista $estado.pedidos)) {
    if ([string]$item.comprador_telefone -eq $script:telefone -and [string]$item.status -eq 'pagamento_em_analise') {
      return $true
    }
  }
  return $false
}

function N8n-SoLocal {
  $pidN8n = Pid-Ouvindo 5678
  $nomeN8n = ''
  if ($pidN8n -gt 0) { $nomeN8n = [string](Get-Process -Id $pidN8n -ErrorAction SilentlyContinue).ProcessName }
  $temAcesso = $true
  if ($pidN8n -gt 0) { $temAcesso = [ComprovanteProbeAmbiente]::Definida($pidN8n, 'META_ACCESS_TOKEN') }
  $enderecos = Enderecos-Escuta 5678
  $soLocal = $enderecos.Count -gt 0
  foreach ($endereco in $enderecos) {
    if ([string]$endereco -ne '127.0.0.1') { $soLocal = $false }
  }
  return [pscustomobject]@{
    Ok = ($nomeN8n -eq 'node' -and -not $temAcesso -and $soLocal)
    Nome = $nomeN8n
    Escuta = ($enderecos -join ',')
    Token = $temAcesso
  }
}

function Subir-Api([string]$tokenEnvio) {
  $psi = Iniciar-Filho '--no-warnings api/server.mjs'
  $psi.EnvironmentVariables['ADMIN_TOKEN'] = $script:adminToken
  $psi.EnvironmentVariables['API_INTERNAL_TOKEN'] = $script:internalToken
  $psi.EnvironmentVariables['API_HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['API_PORT'] = [string]$script:porta
  $psi.EnvironmentVariables['API_DATABASE_PATH'] = $script:banco
  $psi.EnvironmentVariables['API_TLS_CERT_PATH'] = ''
  $psi.EnvironmentVariables['API_TLS_KEY_PATH'] = ''
  $psi.EnvironmentVariables['USAR_PORTA_TESTE'] = '1'
  $psi.EnvironmentVariables['META_ACCESS_TOKEN'] = $tokenEnvio
  $psi.EnvironmentVariables['META_PHONE_NUMBER_ID'] = $script:phoneId
  $psi.EnvironmentVariables['META_GRAPH_VERSION'] = 'v0.0'
  $psi.EnvironmentVariables['META_GRAPH_BASE_URL'] = "http://127.0.0.1:$script:portaGraph"
  $psi.EnvironmentVariables['COMPROVANTES_DIR'] = $script:comprovantes
  $processo = New-Object System.Diagnostics.Process
  $processo.StartInfo = $psi
  [void]$processo.Start()
  Vigiar $processo
  if (-not (Aguardar-Porta $script:porta $processo 40)) { throw 'API nao subiu' }
  return $processo
}

if (-not ('ComprovanteProbeAmbiente' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ComprovanteProbeAmbiente {
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
    Write-Output 'FALHOU 4. n8n so em 127.0.0.1 e sem META_ACCESS_TOKEN (n8n nao esta em 127.0.0.1:5678)'
    exit 1
  }
  foreach ($ocupada in @($porta, $portaGateway, $portaGraph)) {
    if (Porta-Aberta $ocupada) {
      Write-Output "FALHOU 1. token invalido no download reagenda (a porta $ocupada ja esta em uso)"
      exit 1
    }
  }

  $envFile = Join-Path $raiz '.env'
  $adminToken = Ler-Env $envFile 'ADMIN_TOKEN'
  $internalToken = Ler-Env $envFile 'API_INTERNAL_TOKEN'
  $metaSecret = Ler-Env $envFile 'META_APP_SECRET'
  if ($adminToken.Length -lt 24 -or $internalToken.Length -lt 24 -or $metaSecret.Length -lt 1) {
    Write-Output 'FALHOU 1. token invalido no download reagenda (tokens ausentes ou curtos no .env)'
    exit 1
  }
  if ($adminToken -eq $tokenA -or $internalToken -eq $tokenA -or $metaSecret -eq $tokenA -or $adminToken -eq $tokenB -or $internalToken -eq $tokenB) {
    Write-Output 'FALHOU 1. token invalido no download reagenda (token de teste coincide com segredo do .env)'
    exit 1
  }

  $n8nInicio = N8n-SoLocal
  if (-not $n8nInicio.Ok) {
    Write-Output ("FALHOU 4. n8n so em 127.0.0.1 e sem META_ACCESS_TOKEN (processo={0} escuta={1} token={2})" -f $n8nInicio.Nome, $n8nInicio.Escuta, $n8nInicio.Token)
    exit 1
  }

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
  $pngBase64 = [Convert]::ToBase64String($png)
  [System.IO.File]::WriteAllText($script:consulta, @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
const comando = process.argv[3];
if (comando === "estado") {
  const entradas = db.prepare("SELECT wamid FROM mensagens_entrada").all();
  const pedidos = db.prepare("SELECT comprador_telefone, status, status_pagamento FROM pedidos").all();
  const fila = db.prepare("SELECT wamid, status, tentativas, ultimo_erro FROM fila_webhook").all();
  const falhou = Number(db.prepare("SELECT COUNT(*) AS n FROM fila_webhook WHERE status = 'falhou'").get().n);
  process.stdout.write(JSON.stringify({ entradas, pedidos, fila, falhou }));
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
  `).run("P-comprovante-" + telefone, evento.id, lote.id, agora, telefone, agora, agora, agora);
  process.stdout.write("ok");
} else if (comando === "adiantar") {
  const quando = new Date(Date.now() - 1000).toISOString();
  const resultado = db.prepare("UPDATE fila_webhook SET proxima_tentativa_em = ? WHERE status = 'pendente'").run(quando);
  process.stdout.write(String(resultado.changes));
} else {
  throw new Error("comando desconhecido");
}
db.close();
'@, $utf8)
  $graphCodigo = @"
import { createServer } from 'node:http';
const png = Buffer.from('$pngBase64', 'base64');
let modo = '401';
const n = { meta401: 0, meta200: 0, arquivos: 0 };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/contagem') {
    res.end(JSON.stringify(n));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/modo') {
    const valor = url.searchParams.get('valor');
    if (valor) modo = valor;
    res.end('ok');
    return;
  }
  if (req.method === 'POST' && url.pathname.endsWith('/messages')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ messages: [{ id: 'wamid.falso.saida' }] }));
    return;
  }
  if (url.pathname.endsWith('/midia-img')) {
    if (modo !== '200') {
      n.meta401 += 1;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'recusado', type: 'OAuthException', code: 190, error_subcode: 463 } }));
      return;
    }
    n.meta200 += 1;
    res.end(JSON.stringify({
      url: 'http://127.0.0.1:' + server.address().port + '/arquivo.png',
      mime_type: 'image/png',
      file_size: png.length,
    }));
    return;
  }
  if (url.pathname === '/arquivo.png') {
    n.arquivos += 1;
    res.end(png);
    return;
  }
  res.writeHead(404);
  res.end('nao');
});
server.listen(Number(process.argv[2]), '127.0.0.1');
"@
  [System.IO.File]::WriteAllText($script:graphArquivo, $graphCodigo, $utf8)

  $psiGraph = Iniciar-Filho "--no-warnings `"$script:graphArquivo`" $portaGraph"
  [void]$psiGraph.EnvironmentVariables.Remove('META_ACCESS_TOKEN')
  $graph = New-Object System.Diagnostics.Process
  $graph.StartInfo = $psiGraph
  [void]$graph.Start()
  Vigiar $graph
  if (-not (Aguardar-Porta $portaGraph $graph 25)) { throw 'graph falso nao subiu' }

  $proc = Subir-Api $tokenA
  $pedido = & $node --no-warnings $script:consulta $banco pedido $evento $telefone
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
  Vigiar $gateway
  if (-not (Aguardar-Porta $portaGateway $gateway 40)) { throw 'gateway nao subiu' }

  $wamid = 'wamid.comprovante.' + [guid]::NewGuid().ToString('N')
  $resposta = Enviar-Imagem $wamid $hashPng
  if ($resposta.Status -ne 200) { throw "webhook respondeu $($resposta.Status)" }

  $reagendou = Aguardar-Ate {
    $estado = Estado-Atual
    $item = Fila-Do $wamid $estado
    $graphAgora = Contagem-Graph
    return ($item -and [string]$item.status -eq 'pendente' -and [int]$item.tentativas -eq 1 -and [string]$item.ultimo_erro -eq 'token invalido (code 190)' -and [int]$estado.falhou -eq 0 -and (Entrada-Do $wamid $estado) -eq 0 -and (Pedido-Aguardando $estado) -and (Arquivos-Locais) -eq 0 -and [int]$graphAgora.meta401 -ge 1 -and [int]$graphAgora.arquivos -eq 0)
  } 30
  $estadoPausa = Estado-Atual
  $itemPausa = Fila-Do $wamid $estadoPausa
  $admin = Obter-Admin '/admin/whatsapp/saidas'
  $filaAdmin = Obter-Admin '/admin/whatsapp/fila'
  $json = $null
  if ($admin.Status -eq 200) { $json = $admin.Text | ConvertFrom-Json }
  $semMarca = $admin.Text.Contains('pausa:') -eq $false -and $filaAdmin.Text.Contains('pausa:') -eq $false
  $adminOk = $json -and $json.envio_pausado -eq $true -and [int]$json.codigo -eq 190 -and [int]$json.fila_token_invalido_pendentes -ge 1 -and [int]$json.fila_token_invalido_falhou -eq 0
  $tentativas = 0
  if ($itemPausa) { $tentativas = [int]$itemPausa.tentativas }
  Resultado 1 '401 no download nao grava, reagenda e pausa sem falhou' ($reagendou -and $semMarca -and $adminOk -and $tentativas -eq 1 -and $filaAdmin.Status -eq 200) "reagendou=$reagendou tentativas=$tentativas admin=$($admin.Status) pausado=$($json.envio_pausado) fila=$($json.fila_token_invalido_pendentes)"

  $arquivoVazio = Join-Path $tmp 'vazio.json'
  Gravar-Json $arquivoVazio '{}'
  $semConfirmar = Invoke-Curl 'POST' "http://127.0.0.1:$porta/admin/whatsapp/envio/retomar" @{
    Authorization = "Bearer $adminToken"
    'Content-Type' = 'application/json'
  } $arquivoVazio
  $json409 = $null
  if ($semConfirmar.Text) { $json409 = $semConfirmar.Text | ConvertFrom-Json }
  $ainda = Estado-Atual
  $itemAinda = Fila-Do $wamid $ainda
  Resultado 2 'retomar sem confirmar responde 409' ($semConfirmar.Status -eq 409 -and $json409.exige_confirmacao -eq $true -and $semConfirmar.Text.Contains('pausa:') -eq $false -and $itemAinda -and [string]$itemAinda.status -eq 'pendente') "status=$($semConfirmar.Status)"

  Parar-Processo $proc
  $proc = $null
  if (-not (Aguardar-PortaFechada $porta 25)) { throw 'a porta da API nao liberou' }
  Modo-Graph '200'
  $proc = Subir-Api $tokenB
  $baixou = Aguardar-Ate {
    Adiantar-Fila
    $estado = Estado-Atual
    $graphAgora = Contagem-Graph
    return ((Pedido-Analise $estado) -and (Entrada-Do $wamid $estado) -eq 1 -and (Arquivos-Locais) -ge 1 -and [int]$graphAgora.meta200 -eq 1 -and [int]$graphAgora.arquivos -eq 1)
  } 30
  $estadoFinal = Estado-Atual
  $graphFinal = Contagem-Graph
  $adminFinal = Obter-Admin '/admin/whatsapp/saidas'
  $filaFinal = Obter-Admin '/admin/whatsapp/fila'
  Resultado 3 'token novo baixa uma vez e o pedido vai para analise' ($baixou -and $adminFinal.Text.Contains('pausa:') -eq $false -and $filaFinal.Text.Contains('pausa:') -eq $false -and [int]$graphFinal.arquivos -eq 1) "analise=$(Pedido-Analise $estadoFinal) entradas=$(Entrada-Do $wamid $estadoFinal) arquivos=$($graphFinal.arquivos) meta200=$($graphFinal.meta200)"

  $n8nFim = N8n-SoLocal
  Resultado 4 'n8n so em 127.0.0.1 e sem META_ACCESS_TOKEN' $n8nFim.Ok ("processo={0} escuta={1} token={2}" -f $n8nFim.Nome, $n8nFim.Escuta, $n8nFim.Token)
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
