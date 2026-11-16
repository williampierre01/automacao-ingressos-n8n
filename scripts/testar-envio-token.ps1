# Pausa por token invalido: Graph falso local, n8n real e banco temporario.
# Requer o n8n em 127.0.0.1:5678 com o fluxo 04 publicado.
# Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testar-envio-token.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$porta = 8032
$portaGateway = 8033
$portaGraph = 8034
$tmp = Join-Path $raiz 'work\tmp-teste-envio-token'
$banco = Join-Path $tmp 'teste.sqlite'
$evento = 'evento-demonstracao'
$falhas = 0
$proc = $null
$gateway = $null
$graph = $null
$adminToken = ''
$internalToken = ''
$metaSecret = ''
$tokenA = 'envio-teste-token-a-123456'
$tokenB = 'envio-teste-token-b-123456'
$phoneId = '123456789012345'
$telefoneA = '5511900003331'
$telefoneB = '5511900003332'
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

function Enviar-Webhook([string]$telefone, [string]$wamid) {
  $agoraUnix = [string]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())
  $json = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","contacts":[{"profile":{"name":"Ana"},"wa_id":' + (Json-Texto $telefone) + '}],"messages":[{"from":' + (Json-Texto $telefone) + ',"id":' + (Json-Texto $wamid) + ',"timestamp":' + (Json-Texto $agoraUnix) + ',"type":"text","text":{"body":"oi"}}]}}]}]}'
  $arquivo = Join-Path $script:tmp ('webhook-' + [guid]::NewGuid().ToString('N') + '.json')
  Gravar-Json $arquivo $json
  $bytes = [System.IO.File]::ReadAllBytes($arquivo)
  return Invoke-Curl 'POST' "http://127.0.0.1:$script:portaGateway/whatsapp-webhook" @{
    'Content-Type' = 'application/json; charset=utf-8'
    'X-Hub-Signature-256' = (Assinar-Bytes $bytes)
  } $arquivo
}

function Obter-Admin {
  return Invoke-Curl 'GET' "http://127.0.0.1:$script:porta/admin/whatsapp/saidas" @{
    Authorization = "Bearer $($script:adminToken)"
  } ''
}

function Contagem-Graph {
  $resposta = Invoke-Curl 'GET' "http://127.0.0.1:$script:portaGraph/contagem" @{} ''
  return [int]$resposta.Text.Trim()
}

function Modo-Graph([string]$modo) {
  $resposta = Invoke-Curl 'GET' "http://127.0.0.1:$script:portaGraph/modo?valor=$modo" @{} ''
  if ($resposta.Status -ne 200) { throw 'nao mudei o modo do graph falso' }
}

function Saidas-Do([string]$wamid) {
  $lista = @()
  $estado = Estado-Atual
  foreach ($item in (ComoLista $estado.saidas)) {
    if ([string]$item.wamid -eq $wamid) { $lista += $item }
  }
  return ,$lista
}

function Aguardar-Ate([scriptblock]$pronto, [int]$segundos) {
  $limite = (Get-Date).AddSeconds($segundos)
  do {
    if (& $pronto) { return $true }
    Start-Sleep -Milliseconds 300
  } while ((Get-Date) -lt $limite)
  return [bool](& $pronto)
}

function Resumo-Saidas($wamid) {
  $partes = New-Object System.Collections.Generic.List[string]
  foreach ($item in (Saidas-Do $wamid)) {
    $partes.Add(('{0}/t{1}/m{2}/{3}' -f $item.status, $item.tentativas, $item.tem_marca, (Texto-Seguro ([string]$item.ultimo_erro))))
  }
  if ($partes.Count -eq 0) { return 'sem saida' }
  return ($partes -join '; ')
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
  $processo = New-Object System.Diagnostics.Process
  $processo.StartInfo = $psi
  [void]$processo.Start()
  $processo.BeginOutputReadLine()
  $processo.BeginErrorReadLine()
  if (-not (Aguardar-Porta $script:porta $processo 40)) { throw 'API nao subiu' }
  return $processo
}

if (-not ('TokenProbeAmbiente' -as [type])) {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class TokenProbeAmbiente {
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
    Write-Output 'FALHOU 1. token invalido pausa o envio (n8n nao esta em 127.0.0.1:5678)'
    exit 1
  }
  foreach ($ocupada in @($porta, $portaGateway, $portaGraph)) {
    if (Porta-Aberta $ocupada) {
      Write-Output "FALHOU 1. token invalido pausa o envio (a porta $ocupada ja esta em uso)"
      exit 1
    }
  }

  $envFile = Join-Path $raiz '.env'
  $adminToken = Ler-Env $envFile 'ADMIN_TOKEN'
  $internalToken = Ler-Env $envFile 'API_INTERNAL_TOKEN'
  $metaSecret = Ler-Env $envFile 'META_APP_SECRET'
  if ($adminToken.Length -lt 24 -or $internalToken.Length -lt 24 -or $metaSecret.Length -lt 1) {
    Write-Output 'FALHOU 1. token invalido pausa o envio (tokens ausentes ou curtos no .env)'
    exit 1
  }
  if ($adminToken -eq $tokenA -or $internalToken -eq $tokenA -or $metaSecret -eq $tokenA -or $adminToken -eq $tokenB) {
    Write-Output 'FALHOU 1. token invalido pausa o envio (token de teste coincide com segredo do .env)'
    exit 1
  }

  $pidN8n = Pid-Ouvindo 5678
  $nomeN8n = ''
  if ($pidN8n -gt 0) { $nomeN8n = [string](Get-Process -Id $pidN8n -ErrorAction SilentlyContinue).ProcessName }
  $temAcesso = $true
  if ($pidN8n -gt 0) { $temAcesso = [TokenProbeAmbiente]::Definida($pidN8n, 'META_ACCESS_TOKEN') }
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
  $script:consulta = Join-Path $tmp 'consulta.mjs'
  $script:graphArquivo = Join-Path $tmp 'graph.mjs'
  [System.IO.File]::WriteAllText($script:consulta, @'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.argv[2]);
db.exec("PRAGMA busy_timeout = 5000");
if (process.argv[3] !== "estado") throw new Error("comando desconhecido");
const saidas = db.prepare(`
  SELECT wamid, status, tentativas, ultimo_erro,
    CASE WHEN erro_meta IS NOT NULL AND substr(erro_meta, 1, 6) = 'pausa:' THEN 1 ELSE 0 END AS tem_marca
  FROM mensagens_saida
`).all();
const falhou = Number(db.prepare("SELECT COUNT(*) AS n FROM mensagens_saida WHERE status = 'falhou'").get().n);
process.stdout.write(JSON.stringify({ saidas, falhou }));
db.close();
'@, $utf8)
  [System.IO.File]::WriteAllText($script:graphArquivo, @'
import { createServer } from "node:http";
let modo = "401";
let posts = 0;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/contagem") {
    res.end(String(posts));
    return;
  }
  if (req.method === "GET" && url.pathname === "/modo") {
    const valor = url.searchParams.get("valor");
    if (valor) modo = valor;
    res.end("ok");
    return;
  }
  if (req.method === "POST" && url.pathname.endsWith("/messages")) {
    posts += 1;
    if (modo === "200") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: [{ id: "wamid.falso." + posts }] }));
      return;
    }
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "recusado", type: "OAuthException", code: 190, error_subcode: 463 } }));
    return;
  }
  res.writeHead(404);
  res.end("nao");
});
server.listen(Number(process.argv[2]), "127.0.0.1");
'@, $utf8)

  $psiGraph = Iniciar-Filho "--no-warnings `"$script:graphArquivo`" $portaGraph"
  [void]$psiGraph.EnvironmentVariables.Remove('META_ACCESS_TOKEN')
  $graph = New-Object System.Diagnostics.Process
  $graph.StartInfo = $psiGraph
  [void]$graph.Start()
  $graph.BeginOutputReadLine()
  $graph.BeginErrorReadLine()
  if (-not (Aguardar-Porta $portaGraph $graph 25)) { throw 'graph falso nao subiu' }

  $proc = Subir-Api $tokenA

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

  $wamidA = 'wamid.token.' + [guid]::NewGuid().ToString('N')
  $respostaA = Enviar-Webhook $telefoneA $wamidA
  if ($respostaA.Status -ne 200) { throw "webhook respondeu $($respostaA.Status)" }

  $pausou = Aguardar-Ate {
    $admin = Obter-Admin
    if ($admin.Status -ne 200) { return $false }
    $json = $admin.Text | ConvertFrom-Json
    $estado = Estado-Atual
    $pendente = $false
    foreach ($item in (ComoLista $estado.saidas)) {
      if ([string]$item.wamid -eq $wamidA -and [string]$item.status -eq 'pendente_envio' -and [int]$item.tem_marca -eq 1) {
        $pendente = $true
      }
    }
    return ($json.envio_pausado -eq $true -and [int]$json.codigo -eq 190 -and [int]$json.saidas_aguardando -ge 1 -and $pendente -and (Contagem-Graph) -eq 1 -and [int]$estado.falhou -eq 0)
  } 30
  $adminPausa = Obter-Admin
  $jsonPausa = $adminPausa.Text | ConvertFrom-Json
  $postsPausa = Contagem-Graph
  $estadoPausa = Estado-Atual
  $alertaOk = $pausou -and $adminPausa.Text.Contains('pausa:') -eq $false -and [string]$jsonPausa.pausado_desde -ne ''
  Resultado 1 '401 com code 190 pausa, alerta, zero falhou e um unico POST' $alertaOk "pausou=$pausou posts=$postsPausa falhou=$($estadoPausa.falhou) http=$($adminPausa.Status)"

  $arquivoVazio = Join-Path $tmp 'vazio.json'
  Gravar-Json $arquivoVazio '{}'
  $semConfirmar = Invoke-Curl 'POST' "http://127.0.0.1:$porta/admin/whatsapp/envio/retomar" @{
    Authorization = "Bearer $adminToken"
    'Content-Type' = 'application/json'
  } $arquivoVazio
  $json409 = $semConfirmar.Text | ConvertFrom-Json
  $estado409 = Estado-Atual
  $ainda = $false
  foreach ($item in (ComoLista $estado409.saidas)) {
    if ([string]$item.wamid -eq $wamidA -and [string]$item.status -eq 'pendente_envio' -and [int]$item.tem_marca -eq 1 -and [int]$item.tentativas -eq 0) {
      $ainda = $true
    }
  }
  Resultado 2 'retomar sem confirmar responde 409 e nao muda o banco' ($semConfirmar.Status -eq 409 -and $json409.exige_confirmacao -eq $true -and $ainda -and (Contagem-Graph) -eq 1) "status=$($semConfirmar.Status) posts=$(Contagem-Graph)"

  Modo-Graph '200'
  $confirmado = Invoke-Curl 'POST' "http://127.0.0.1:$porta/admin/whatsapp/envio/retomar?confirmar=1" @{
    Authorization = "Bearer $adminToken"
    'Content-Type' = 'application/json'
  } $arquivoVazio
  $jsonRetome = $confirmado.Text | ConvertFrom-Json
  $enviou = Aguardar-Ate {
    $lista = Saidas-Do $wamidA
    if ($lista.Count -lt 1) { return $false }
    foreach ($item in $lista) {
      if ([string]$item.status -ne 'enviada') { return $false }
    }
    return $true
  } 25
  $estadoEnviado = Estado-Atual
  Resultado 3 'retomar com confirmar=1 entrega a saida' ($confirmado.Status -eq 200 -and $jsonRetome.retomado -eq $true -and $enviou -and [int]$estadoEnviado.falhou -eq 0 -and $confirmado.Text.Contains('pausa:') -eq $false) ("http={0} enviou={1} falhou={2} posts={3} {4}" -f $confirmado.Status, $enviou, $estadoEnviado.falhou, (Contagem-Graph), (Resumo-Saidas $wamidA))

  Modo-Graph '401'
  $postsAntes = Contagem-Graph
  $wamidB = 'wamid.token.' + [guid]::NewGuid().ToString('N')
  $respostaB = Enviar-Webhook $telefoneB $wamidB
  if ($respostaB.Status -ne 200) { throw "segundo webhook respondeu $($respostaB.Status)" }
  $segundaPausa = Aguardar-Ate {
    $admin = Obter-Admin
    $json = $admin.Text | ConvertFrom-Json
    $marca = $false
    foreach ($item in (Saidas-Do $wamidB)) {
      if ([string]$item.status -eq 'pendente_envio' -and [int]$item.tem_marca -eq 1) { $marca = $true }
    }
    return ($json.envio_pausado -eq $true -and $marca -and (Contagem-Graph) -eq ($postsAntes + 1))
  } 30
  if (-not $segundaPausa) { throw 'a segunda mensagem nao pausou' }
  Start-Sleep -Seconds 2
  if ((Contagem-Graph) -ne ($postsAntes + 1)) { throw 'a pausa gerou POST extra' }

  $postsTravados = Contagem-Graph
  Parar-Processo $proc
  $proc = $null
  if (-not (Aguardar-PortaFechada $porta 25)) { throw 'a porta da API nao liberou' }
  $proc = Subir-Api $tokenA
  Start-Sleep -Seconds 3
  $adminMesmo = Obter-Admin
  $jsonMesmo = $adminMesmo.Text | ConvertFrom-Json
  $marcaMesma = $false
  foreach ($item in (Saidas-Do $wamidB)) {
    if ([string]$item.status -eq 'pendente_envio' -and [int]$item.tem_marca -eq 1) { $marcaMesma = $true }
  }
  Resultado 4 'reinicio com o mesmo token continua pausado e sem POST' ($jsonMesmo.envio_pausado -eq $true -and $marcaMesma -and (Contagem-Graph) -eq $postsTravados) "posts=$(Contagem-Graph) esperado=$postsTravados pausado=$($jsonMesmo.envio_pausado)"

  Parar-Processo $proc
  $proc = $null
  if (-not (Aguardar-PortaFechada $porta 25)) { throw 'a porta da API nao liberou na troca' }
  Modo-Graph '200'
  $postsTroca = Contagem-Graph
  $proc = Subir-Api $tokenB
  $trocou = Aguardar-Ate {
    $admin = Obter-Admin
    $json = $admin.Text | ConvertFrom-Json
    if ($json.envio_pausado -eq $true) { return $false }
    $lista = Saidas-Do $wamidB
    if ($lista.Count -lt 1) { return $false }
    foreach ($item in $lista) {
      if ([string]$item.status -ne 'enviada' -or [int]$item.tem_marca -ne 0) { return $false }
    }
    return ((Contagem-Graph) -ge ($postsTroca + 1))
  } 25
  $adminTroca = Obter-Admin
  $jsonTroca = $adminTroca.Text | ConvertFrom-Json
  Resultado 5 'outro token limpa a pausa e envia a pendente' ($trocou -and $jsonTroca.envio_pausado -eq $false -and [int](Estado-Atual).falhou -eq 0) ("posts={0} base={1} pausado={2} {3}" -f (Contagem-Graph), $postsTroca, $jsonTroca.envio_pausado, (Resumo-Saidas $wamidB))
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
