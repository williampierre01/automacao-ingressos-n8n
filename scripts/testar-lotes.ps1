# Teste de ponta a ponta dos lotes. Nao usa o banco da API do dia a dia.
# Requer o n8n ja escutando em 127.0.0.1:5678.
# Windows PowerShell 5.1:
#   powershell -ExecutionPolicy Bypass -File .\scripts\testar-lotes.ps1

$ErrorActionPreference = 'Stop'
[System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy

$raiz = Split-Path -Parent $PSScriptRoot
$porta = 8010
$tmp = Join-Path $raiz 'work\tmp-teste-lotes'
$banco = Join-Path $tmp 'teste.sqlite'
$evento = 'evento-demonstracao'
$pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
$marcaTardia = 'recebido após expirar'
$falhas = 0
$proc = $null
$recibos = @()
$adminToken = ''
$node = $null
$bancoReal = ''

function Texto-Seguro([string]$texto) {
  if (-not $texto) { return '' }
  $limpo = [regex]::Replace($texto, '(?i)bearer\s+\S+', 'bearer [omitido]')
  $limpo = [regex]::Replace($limpo, '(?i)(admin_token\s*[=:]\s*)\S+', '$1[omitido]')
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

function Decidir-Pedido($pedidoId, [string]$decisao) {
  $corpo = @{ decisao = $decisao; responsavel = 'Teste'; observacao = 'teste' } | ConvertTo-Json -Compress
  return Invoke-Api -Method 'POST' -Path "/admin/pedidos/$pedidoId/pagamento" -Body $corpo -Admin $true
}

function Invoke-Api {
  param([string]$Method, [string]$Path, [string]$Body, [bool]$Admin)
  $uri = "http://127.0.0.1:$script:porta$Path"
  $req = [System.Net.HttpWebRequest][System.Net.WebRequest]::Create($uri)
  $req.Method = $Method
  $req.Timeout = 30000
  $req.ReadWriteTimeout = 30000
  $req.ContentType = 'application/json; charset=utf-8'
  $req.Accept = 'application/json'
  $req.Proxy = New-Object System.Net.WebProxy
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

function Enviar([string]$telefone, [string]$mensagem) {
  $corpo = @{
    telefone = $telefone
    nome = 'Teste Lotes'
    mensagem = $mensagem
    evento_codigo = $evento
    id_mensagem = 'teste-lotes-' + [guid]::NewGuid().ToString('N')
  } | ConvertTo-Json -Compress
  return Invoke-Api -Method 'POST' -Path '/simular-mensagem' -Body $corpo
}

function Reservar([string]$telefone, [int]$quantidade) {
  $compra = Enviar $telefone 'COMPRAR'
  if ($compra.Status -ne 200) { return $compra }
  $cotacao = Enviar $telefone ([string]$quantidade)
  if ($cotacao.Status -ne 200) { return $cotacao }
  $ultimo = $cotacao
  for ($i = 1; $i -le $quantidade; $i++) {
    $ultimo = Enviar $telefone ("Participante {0:d2} Silva" -f $i)
    if ($ultimo.Status -ne 200) { return $ultimo }
  }
  return $ultimo
}

function Enviar-Comprovante($pedidoId, [string]$telefone) {
  $corpo = @{
    pedido_id = [int]$pedidoId
    telefone = $telefone
    evento_codigo = $evento
    nome_arquivo = 'comprovante.png'
    tipo_mime = 'image/png'
    arquivo_base64 = $pngBase64
  } | ConvertTo-Json -Compress
  $resp = Invoke-Api -Method 'POST' -Path '/comprovantes' -Body $corpo
  if ($resp.Json -and $resp.Json.comprovante_id) {
    $script:recibos += [string]$resp.Json.comprovante_id
  }
  return $resp
}

function Pedidos([string]$status) {
  return Invoke-Api -Method 'GET' -Path "/admin/pedidos?status_pagamento=$status" -Admin $true
}

function Pedido-DoTelefone($lista, [string]$telefone) {
  foreach ($item in (ComoLista $lista)) {
    if ($item.comprador_telefone -eq $telefone) { return $item }
  }
  return $null
}

function Evento-Atual {
  return Invoke-Api -Method 'GET' -Path "/eventos/$evento"
}

function Lote-PorNome($eventoJson, [string]$nome) {
  foreach ($item in (ComoLista $eventoJson.lotes)) {
    if ($item.nome -eq $nome) { return $item }
  }
  return $null
}

function Consultar-Sqlite([string]$caminhoBanco, [string]$comando, [string]$telefone) {
  $arquivo = Join-Path $env:TEMP 'testar-lotes-consulta.mjs'
  $codigo = @'
import { DatabaseSync } from "node:sqlite";
const dbPath = process.argv[2];
const comando = process.argv[3];
const telefone = process.argv[4] || "";
const db = new DatabaseSync(dbPath);
db.exec("PRAGMA busy_timeout = 5000");
if (comando === "consultar") {
  const rows = db.prepare("SELECT id, quantidade, valor_unitario_centavos, valor_total_centavos, status, status_pagamento, reserva_expira_em FROM pedidos WHERE comprador_telefone = ?").all(telefone);
  process.stdout.write(JSON.stringify(rows));
} else if (comando === "backdate") {
  const past = new Date(Date.now() - 120000).toISOString();
  const result = db.prepare("UPDATE pedidos SET reserva_expira_em = ? WHERE comprador_telefone = ? AND status = 'aguardando_pagamento'").run(past, telefone);
  process.stdout.write(JSON.stringify({ changes: Number(result.changes) }));
} else if (comando === "limpar-atendimentos") {
  const result = db.prepare("DELETE FROM atendimentos WHERE id_mensagem LIKE 'teste-lotes-%'").run();
  process.stdout.write(JSON.stringify({ changes: Number(result.changes) }));
} else {
  throw new Error("comando desconhecido");
}
db.close();
'@
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($arquivo, $codigo, $utf8)
  $saida = & $node --no-warnings $arquivo $caminhoBanco $comando $telefone
  if ($LASTEXITCODE -ne 0) { throw "sqlite falhou" }
  if (-not $saida) { return $null }
  return ($saida | ConvertFrom-Json)
}

function Porta-Aberta([int]$numero) {
  $cliente = New-Object System.Net.Sockets.TcpClient
  try {
    $cliente.Connect('127.0.0.1', $numero)
    return $true
  } catch {
    return $false
  } finally {
    $cliente.Close()
  }
}

function Parar-Api {
  if ($proc -and -not $proc.HasExited) {
    try { $proc.Kill() } catch {}
    try { [void]$proc.WaitForExit(8000) } catch {}
  }
}

function Apagar-PastaTemporaria {
  $esperado = [System.IO.Path]::GetFullPath((Join-Path $raiz 'work\tmp-teste-lotes'))
  $resolvido = [System.IO.Path]::GetFullPath($tmp)
  $prefixo = $esperado.TrimEnd('\')
  $igual = [System.StringComparison]::OrdinalIgnoreCase
  $permitido = $resolvido.Equals($prefixo, $igual) -or $resolvido.StartsWith($prefixo + '\', $igual)
  if (-not $permitido) {
    throw "A pasta temporaria resolvida nao comeca com $prefixo. Nada foi apagado."
  }
  if (-not (Test-Path -LiteralPath $resolvido)) { return }
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

function Limpar-Arquivos {
  foreach ($id in $recibos) {
    $arquivo = Join-Path $raiz ("data\comprovantes\{0}.png" -f $id)
    if (Test-Path -LiteralPath $arquivo) {
      Remove-Item -LiteralPath $arquivo -Force -ErrorAction SilentlyContinue
    }
  }
  Apagar-PastaTemporaria
}

function Limpar-Atendimentos-Reais {
  if (-not $bancoReal -or -not (Test-Path -LiteralPath $bancoReal)) { return }
  try { Consultar-Sqlite $bancoReal 'limpar-atendimentos' '' | Out-Null } catch {}
}

try {
  if (-not (Porta-Aberta 5678)) {
    Write-Output 'FALHOU 1. Cotacao de 2 ingressos = R$ 60 e nao cria pedido (n8n nao esta em 127.0.0.1:5678)'
    exit 1
  }
  if (Porta-Aberta $porta) {
    Write-Output "FALHOU 1. Cotacao de 2 ingressos = R$ 60 e nao cria pedido (a porta $porta ja esta em uso)"
    exit 1
  }

  $envFile = Join-Path $raiz '.env'
  $adminToken = Ler-Env $envFile 'ADMIN_TOKEN'
  if ($adminToken.Length -lt 24) {
    Write-Output 'FALHOU 1. Cotacao de 2 ingressos = R$ 60 e nao cria pedido (ADMIN_TOKEN ausente ou curto no .env)'
    exit 1
  }
  if ((Ler-Env $envFile 'API_INTERNAL_TOKEN').Length -lt 24) {
    Write-Output 'FALHOU 1. Cotacao de 2 ingressos = R$ 60 e nao cria pedido (API_INTERNAL_TOKEN ausente ou curto no .env)'
    exit 1
  }
  $caminhoConfigurado = Ler-Env $envFile 'API_DATABASE_PATH'
  if ($caminhoConfigurado) {
    $bancoReal = $caminhoConfigurado
  } else {
    $bancoReal = Join-Path $raiz 'data\atendimentos.sqlite'
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
  $psi.EnvironmentVariables['API_INTERNAL_TOKEN'] = (Ler-Env $envFile 'API_INTERNAL_TOKEN')
  $psi.EnvironmentVariables['API_HOST'] = '127.0.0.1'
  $psi.EnvironmentVariables['API_PORT'] = [string]$porta
  $psi.EnvironmentVariables['API_DATABASE_PATH'] = $banco
  $psi.EnvironmentVariables['SIMULADOR_ATIVO'] = '1'
  $psi.EnvironmentVariables['N8N_WEBHOOK_URL'] = 'http://127.0.0.1:5678/webhook/whatsapp-mensagens'
  $psi.EnvironmentVariables['N8N_VIRADA_LOTE_WEBHOOK_URL'] = 'http://127.0.0.1:9/virada'
  $psi.EnvironmentVariables['API_TLS_CERT_PATH'] = ''
  $psi.EnvironmentVariables['API_TLS_KEY_PATH'] = ''

  $proc = New-Object System.Diagnostics.Process
  $proc.StartInfo = $psi
  [void]$proc.Start()
  $proc.BeginOutputReadLine()
  $proc.BeginErrorReadLine()

  $subiu = $false
  $limite = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $limite) {
    if ($proc.HasExited) { break }
    try {
      $saude = Invoke-Api -Method 'GET' -Path '/saude'
      if ($saude.Status -eq 200) { $subiu = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 200
  }
  if (-not $subiu) {
    Resultado 1 'Cotacao de 2 ingressos = R$ 60 e nao cria pedido' $false 'a API temporaria nao respondeu'
    exit 1
  }

  $telA = '11900010001'
  $telB = '11900010002'
  $telC = '11900010003'
  $telD = '11900010004'
  $telE = '11900010005'
  $telF = '11900010006'
  $telG = '11900010007'

  $compraA = Enviar $telA 'COMPRAR'
  $cotacaoA = Enviar $telA '2'
  $pendentes = Pedidos 'pendente'
  $pedidoAquote = Pedido-DoTelefone $pendentes.Json.pedidos $telA
  $cotacaoOk = $cotacaoA.Status -eq 200 -and $cotacaoA.Json.resposta -like '*Total: R$ 60,00*' -and $null -eq $cotacaoA.Json.pedido_id -and $null -eq $pedidoAquote
  Resultado 1 'Cotacao de 2 ingressos = R$ 60 e nao cria pedido' $cotacaoOk $(if ($cotacaoOk) { '' } else { "status $($cotacaoA.Status) $($cotacaoA.Json.resposta)" })

  $nome1 = Enviar $telA 'Participante 01 Silva'
  $reservaA = Enviar $telA 'Participante 02 Silva'
  $linhasA = ComoLista (Consultar-Sqlite $banco 'consultar' $telA)
  $minutos = -1
  if ($linhasA.Count -eq 1 -and $linhasA[0].reserva_expira_em) {
    $expira = [datetime]::Parse([string]$linhasA[0].reserva_expira_em).ToUniversalTime()
    $minutos = ($expira - [datetime]::UtcNow).TotalMinutes
  }
  $semDocumento = ($nome1.Json.resposta -notmatch 'CPF|RG') -and ($reservaA.Json.resposta -notmatch 'CPF|RG')
  $reservaOk = $reservaA.Status -eq 200 -and $reservaA.Json.estado -eq 'aguardando_pagamento' -and $reservaA.Json.pedido_id -and $reservaA.Json.resposta -like '*Prazo: 60 minutos*' -and $semDocumento -and $minutos -gt 58 -and $minutos -lt 62
  Resultado 2 'Reserva ao receber os nomes, sem CPF/RG, com prazo de 60 min' $reservaOk $(if ($reservaOk) { '' } else { "estado $($reservaA.Json.estado) minutos $minutos linhas $($linhasA.Count)" })

  $onze = Enviar $telB 'COMPRAR'
  if ($onze.Status -eq 200) { $onze = Enviar $telB '11' }
  $dez = Enviar $telB '10'
  $limiteOk = $onze.Status -eq 200 -and $onze.Json.resposta -like '*limite deste evento e de 10 ingressos por telefone*' -and $onze.Json.resposta -like '*ainda pode comprar 10*'
  $dezOk = $dez.Status -eq 200 -and $dez.Json.resposta -like '*Total: R$ 300,00*' -and $dez.Json.resposta -notlike '*limite deste evento*'
  Resultado 3 '11 ingressos do mesmo telefone recusados com a mensagem do limite; 10 aceitos' ($limiteOk -and $dezOk) $(if ($limiteOk -and $dezOk) { '' } else { "11: $($onze.Json.resposta) | 10: $($dez.Json.resposta)" })

  $reservaB = $dez
  for ($i = 1; $i -le 10; $i++) {
    $reservaB = Enviar $telB ("Participante {0:d2} Silva" -f $i)
    if ($reservaB.Status -ne 200 -or -not $reservaB.Json) { break }
  }
  $comprovanteB = $null
  if ($reservaB.Json.pedido_id) { $comprovanteB = Enviar-Comprovante $reservaB.Json.pedido_id $telB }
  $emAnalise = Pedidos 'em_analise'
  $pedidoB = Pedido-DoTelefone $emAnalise.Json.pedidos $telB
  $analiseOk = $comprovanteB -and $comprovanteB.Status -eq 201 -and $comprovanteB.Json.estado -eq 'pagamento_em_analise' -and $pedidoB -and $pedidoB.status_pagamento -eq 'em_analise'
  Resultado 4 'Comprovante PNG falso coloca o pedido em analise' $analiseOk $(if ($analiseOk) { '' } else { "status $($comprovanteB.Status) $($comprovanteB.Json.erro)" })

  $reservaC = Reservar $telC 10
  $reservaD = Reservar $telD 10
  $reservaE = Reservar $telE 1
  $reservaF = Reservar $telF 1
  if ($reservaC.Json.pedido_id) { Enviar-Comprovante $reservaC.Json.pedido_id $telC | Out-Null }
  if ($reservaD.Json.pedido_id) { Enviar-Comprovante $reservaD.Json.pedido_id $telD | Out-Null }
  if ($reservaE.Json.pedido_id) { Enviar-Comprovante $reservaE.Json.pedido_id $telE | Out-Null }

  $aprovaB = Decidir-Pedido $reservaB.Json.pedido_id 'aprovar'
  $aprovaC = Decidir-Pedido $reservaC.Json.pedido_id 'aprovar'
  $antesDaVirada = Evento-Atual
  $lote1Antes = Lote-PorNome $antesDaVirada.Json 'Primeiro lote'
  $marcoEncerrado = [string]$lote1Antes.encerrado_em

  $cotacaoG = Enviar $telG 'COMPRAR'
  if ($cotacaoG.Status -eq 200) { $cotacaoG = Enviar $telG '1' }
  $linhasApos = ComoLista (Consultar-Sqlite $banco 'consultar' $telA)
  $precoCongelado = $linhasApos.Count -eq 1 -and [int]$linhasApos[0].valor_unitario_centavos -eq 3000

  $aprovaD = Decidir-Pedido $reservaD.Json.pedido_id 'aprovar'
  $depois = Evento-Atual
  $lote1 = Lote-PorNome $depois.Json 'Primeiro lote'
  $lote2 = Lote-PorNome $depois.Json 'Segundo lote'
  $aprovados = Pedidos 'aprovado'
  $precos = @($telB, $telC, $telD) | ForEach-Object {
    $item = Pedido-DoTelefone $aprovados.Json.pedidos $_
    if (-not $item) { return $false }
    return ([int]$item.valor_total_centavos / [int]$item.quantidade) -eq 3000
  }
  $precoOk = -not ($precos -contains $false)
  $estouroOk = $aprovaB.Status -eq 200 -and $aprovaC.Status -eq 200 -and $aprovaD.Status -eq 200 -and [int]$lote1.quantidade_vendida -gt 20 -and [int]$lote2.quantidade_vendida -eq 0 -and $lote1.status -eq 'encerrado' -and $lote2.status -eq 'disponivel' -and $precoOk
  Resultado 5 'Aprovacoes fecham o lote 1 com pedido que estoura: R$ 30 para todos, lote 2 intacto e lote 1 acima de 20' $estouroOk $(if ($estouroOk) { '' } else { "vendida1 $($lote1.quantidade_vendida) vendida2 $($lote2.quantidade_vendida) status $($lote1.status)/$($lote2.status)" })

  $viradas = Invoke-Api -Method 'GET' -Path '/admin/viradas' -Admin $true
  $listaViradas = ComoLista $viradas.Json.viradas
  $virada = $listaViradas | Select-Object -First 1
  $webhookFora = $virada -and [string]$virada.erro -and [string]$virada.tipo -eq 'virada'
  $anuncio = $null
  if ($virada) {
    $anuncio = Invoke-Api -Method 'POST' -Path ("/admin/viradas/{0}/anunciada" -f $virada.id) -Admin $true
  }
  $depoisAnuncio = Invoke-Api -Method 'GET' -Path '/admin/viradas' -Admin $true
  $alertaSumiu = (ComoLista $depoisAnuncio.Json.viradas).Count -eq 0
  $viradaOk = $viradas.Status -eq 200 -and $webhookFora -and $aprovaC.Status -eq 200 -and $anuncio.Status -eq 200 -and $alertaSumiu
  Resultado 6 'Virada listada com erro do webhook, aprovacao com sucesso, e anunciada tira o alerta' $viradaOk $(if ($viradaOk) { '' } else { "viradas $($listaViradas.Count) erro [$($virada.erro)] anuncio $($anuncio.Status)" })

  $cotacaoNovaOk = $cotacaoG.Status -eq 200 -and $cotacaoG.Json.resposta -like '*R$ 40,00*' -and $precoCongelado
  Resultado 7 'Reserva anterior a virada mantem R$ 30; nova cotacao mostra R$ 40' $cotacaoNovaOk $(if ($cotacaoNovaOk) { '' } else { "cotacao $($cotacaoG.Json.resposta) unitario $($linhasApos[0].valor_unitario_centavos)" })

  $voltou = Consultar-Sqlite $banco 'backdate' $telF
  $expirou = Invoke-Api -Method 'POST' -Path '/admin/reservas/expirar' -Admin $true
  $pendentesF = Pedidos 'pendente'
  $pedidoF = Pedido-DoTelefone $pendentesF.Json.pedidos $telF
  $comprovanteF = $null
  if ($reservaF.Json.pedido_id) { $comprovanteF = Enviar-Comprovante $reservaF.Json.pedido_id $telF }
  $analiseTardia = Pedidos 'em_analise'
  $pedidoTardio = Pedido-DoTelefone $analiseTardia.Json.pedidos $telF
  $tardioOk = [int]$voltou.changes -eq 1 -and [int]$expirou.Json.expirados -ge 1 -and $pedidoF.status -eq 'expirado' -and $comprovanteF.Status -eq 201 -and [int]$pedidoTardio.recebido_apos_expirar -eq 1 -and [string]$pedidoTardio.observacoes -like ('*{0}*' -f $marcaTardia)
  Resultado 8 'Reserva vencida expira na expiracao manual; comprovante posterior fica em analise com a marca recebido apos expirar' $tardioOk $(if ($tardioOk) { '' } else { "status $($pedidoF.status) flag $($pedidoTardio.recebido_apos_expirar) obs $($pedidoTardio.observacoes)" })

  $loteDepoisExpirar = Lote-PorNome (Evento-Atual).Json 'Primeiro lote'
  $cancelou = Enviar $telA 'cancelar'
  $recusou = Decidir-Pedido $reservaE.Json.pedido_id 'recusar'
  $finalEvento = Evento-Atual
  $lote1Final = Lote-PorNome $finalEvento.Json 'Primeiro lote'
  $lote2Final = Lote-PorNome $finalEvento.Json 'Segundo lote'
  $naoReabre = $loteDepoisExpirar.status -eq 'encerrado' -and $lote1Final.status -eq 'encerrado' -and [string]$lote1Final.encerrado_em -eq $marcoEncerrado -and [int]$lote1Final.quantidade_vendida -eq [int]$lote1.quantidade_vendida -and $lote2Final.status -eq 'disponivel' -and [int]$lote2Final.quantidade_vendida -eq 0 -and $cancelou.Json.estado -eq 'cancelado' -and $recusou.Status -eq 200
  Resultado 9 'Lote 1 nao reabre apos expirar, cancelar ou recusar' $naoReabre $(if ($naoReabre) { '' } else { "lote1 $($lote1Final.status) lote2 $($lote2Final.status) vendida $($lote1Final.quantidade_vendida) cancel $($cancelou.Json.estado) recusa $($recusou.Status)" })
} catch {
  if ($falhas -eq 0) {
    Resultado 1 'Cotacao de 2 ingressos = R$ 60 e nao cria pedido' $false $_.Exception.Message
  } else {
    Write-Output ("FALHOU interrompido ({0})" -f (Texto-Seguro $_.Exception.Message))
    $falhas++
  }
} finally {
  Parar-Api
  Limpar-Atendimentos-Reais
  Limpar-Arquivos
  $consulta = Join-Path $env:TEMP 'testar-lotes-consulta.mjs'
  if (Test-Path -LiteralPath $consulta) { Remove-Item -LiteralPath $consulta -Force -ErrorAction SilentlyContinue }
}

if ($falhas -gt 0) { exit 1 }
exit 0
