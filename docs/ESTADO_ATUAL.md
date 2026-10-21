# Estado atual

Revisão em 2026-10-12, só leitura de código e docs. **Não confirmei runtime** (API, n8n e gateway não foram exercitados nesta fase). Evidência = trechos versionados. Segredos de `.env` não foram abertos nem impressos.

## Entrada unificada (2026-10-15)

O WhatsApp e o simulador chegam na venda pelo mesmo caminho.

1. O gateway valida o HMAC, grava uma linha por mensagem em `fila_webhook` e responde 200. `statuses[]` não entra na fila. Se `user_version` for menor que 2, o gateway recusa subir com `suba a API primeiro`.
2. O worker entrega a mensagem mais antiga de cada telefone ao webhook `whatsapp-mensagens`, com `Authorization: Bearer` do `API_INTERNAL_TOKEN` e timeout de 30 s. 404, 408, 425, 429, 5xx, timeout e erro de rede esperam, com backoff até 300 s e no máximo `FILA_MAX_TENTATIVAS` (padrão 30). Os outros 4xx marcam `falhou` na hora. Se a entrega processou uma linha, o próximo ciclo é imediato; o intervalo de 1 s só vale com a fila vazia. O admin lista as falhas, a contagem de pendentes e processando e a idade do pendente mais antigo (alerta acima de 300 s). `POST /admin/whatsapp/fila/:id/reenfileirar` devolve o item; se já houver mensagem mais nova do mesmo telefone entregue, responde aviso e só segue com `confirmar=1`. O corpo bruto de uma falha some depois de `FILA_RETENCAO_DIAS` (padrão 7). Linha `entregue` mais velha que esse prazo é apagada. `mensagens_entrada` e `mensagens_saida` ficam.
3. O fluxo 04 repassa o cabeçalho `Authorization` recebido para `POST /interno/mensagem` (timeout 15 s) e devolve o JSON. Não há `$env` nem lógica de venda no n8n. `saveDataSuccessExecution=none`, `saveDataErrorExecution=none` e `saveManualExecutions=false`. O n8n 2.34.6 ainda grava a execução de sucesso e só preenche `deletedAt`, com o corpo no banco. `scripts/iniciar-n8n.ps1` cria o trigger `limpar_execucao_apagada`, que apaga essa linha e o corpo, e ao subir apaga as que já estavam marcadas. Não foi reproduzida uma execução com status de erro: o nó HTTP usa `continueErrorOutput` e `neverError`, e JSON inválido ou gzip responde erro sem gravar linha. Não ficou provado se o trigger cobriria esse caso.
4. A API registra o `wamid`, roda `processarMensagem` e grava `mensagens_saida` com status `pendente_envio` na mesma transação. Repetição responde 200 sem processar de novo. Sem token ou com token errado, responde 401 e não grava mensagem nem pedido. Evento sem vendas abertas responde 200, estado `vendas_fechadas` e saída `pendente_envio`. Evento inexistente responde 422 (`Evento X nao encontrado. Verifique WHATSAPP_EVENTO_CODIGO.`) e a fila marca `falhou` com esse texto. Imagem e documento respondem que o comprovante por ali ainda não está disponível. Áudio, figurinha e localização respondem que só texto é lido. Reação registra o `wamid` e não responde. O envio pela Cloud API fica para a 4b.

`POST /simular-mensagem` monta esse JSON e espera o n8n. Continua exigindo `SIMULADOR_ATIVO=1`. `POST /atendimentos` permanece para os fluxos 02 e 03.

`scripts/iniciar-n8n.ps1` carrega do `.env` só `N8N_ENCRYPTION_KEY`, `GENERIC_TIMEZONE` e `TZ`. O processo não recebe `API_INTERNAL_TOKEN`, `ADMIN_TOKEN` nem `META_APP_SECRET`, e não define `N8N_BLOCK_ENV_ACCESS_IN_NODE`. Escuta em `N8N_LISTEN_ADDRESS=127.0.0.1`. `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`, `EXECUTIONS_DATA_SAVE_ON_ERROR=none`, `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false` e `EXECUTIONS_DATA_SAVE_ON_PROGRESS=false` acompanham o fluxo. `EXECUTIONS_DATA_PRUNE=true` e `EXECUTIONS_DATA_MAX_AGE=72` continuam como rede de segurança. Antes de subir, o script apaga execuções já marcadas com `deletedAt` e recria o trigger que apaga a marcação futura. As `N8N_*` de arranque (`N8N_USER_FOLDER`, `N8N_HOST`, `N8N_PORT`, `N8N_PROTOCOL`, `N8N_SECURE_COOKIE`) ficam no próprio script. A pasta atual é `work/n8n-cwd`: o n8n lê um `.env` na pasta de onde sobe e, no diretório do projeto, reporia esses segredos. Publicar o fluxo só com o n8n fechado (a porta 5678 em uso aborta o script):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publicar-fluxo-04.ps1
```

Isso executa `import:workflow --input=workflows/04-webhook-whatsapp-simulado.json` e `publish:workflow --id=webhookWhatsapp0001`.

`GATEWAY_PORT` muda a porta do gateway. Vazio continua `8001`. O gateway exige `API_INTERNAL_TOKEN` (mínimo 24 caracteres) e não sobe sem ele. `scripts/testar-entrada.ps1` sobe API e gateway em portas temporárias, com o n8n real em `127.0.0.1:5678`, e não imprime segredo. O script confere que o processo da 5678 escuta só em `127.0.0.1` e não tem `API_INTERNAL_TOKEN`, `ADMIN_TOKEN`, `META_APP_SECRET` nem `N8N_BLOCK_ENV_ACCESS_IN_NODE`. Pelo gateway, com HMAC válido e envelope da Cloud API: texto assinado grava `pendente_envio`; o mesmo `wamid` responde 200 sem outra saída; assinatura inválida responde 401 e não cria linha; webhook sem token ou com token errado responde 401 e não cria mensagem nem pedido; 404 do destino reagenda; destino em porta fechada acumula a fila e, apontando de novo para o n8n, entrega; a segunda mensagem do mesmo telefone não passa à frente de uma falha pendente, e a de outro telefone passa; o reinício retoma `pendente` e `processando`; `POST /admin/whatsapp/fila/:id/reenfileirar` devolve um item `falhou` para a fila. Uma mensagem bem-sucedida não aumenta `execution_entity` do fluxo 04. O teste confere `EXECUTIONS_DATA_SAVE_ON_ERROR=none` no processo e `saveDataErrorExecution=none` no fluxo publicado. Não houve execução com status de erro para conferir o banco nesse caso. A limpeza inicial é provada num SQLite temporário, sem usar o banco de `work/n8n-user`.

## O que funciona (evidência no código)

- **API HTTP local** em `api/server.mjs`: escuta `API_HOST`/`API_PORT` (padrão `127.0.0.1:8000`), cria `data/` e `data/comprovantes/`, aplica `api/schema.sql` via `DatabaseSync`.
- **SQLite com WAL e foreign keys** (`api/schema.sql` L1–2). Consultas usam *prepared statements* (não há concatenação de SQL com input).
- **Modelo parcial de eventos/lotes/pedidos/participantes/conversas/comprovantes** (`api/schema.sql` L16–137). Seed de demonstração se a base está vazia (`api/server.mjs` L35–106).
- **Cálculo de total na API**, em `api/lotes.mjs` (`totalCentavos`). O preço unitário do lote fica congelado no pedido.
- **Máquina de estados local** em `api/conversa.mjs`: quantidade (cotação) → nomes → reserva e Pix, ou `CONFIRMAR` se o preço mudou. Documento não é pedido. Disparada por `POST /interno/mensagem`.
- **Reserva atômica** em `BEGIN IMMEDIATE`: congela preço, prazo, cota do telefone e teto do evento. Não incrementa `quantidade_reservada`.
- **Upload de comprovante** JPG/PNG/PDF até 5 MB, amarra pedido+telefone+evento. Arquivo em `data/comprovantes/` (pasta coberta por `.gitignore` via `data/`). Pedido já expirado entra em análise com a marca de recebimento tardio.
- **Aprovação/recusa humana** em `POST /admin/pedidos/:id/pagamento`: promove participantes a `valido` ou `cancelado`. A aprovação soma `quantidade_vendida` e pode virar o lote. A recusa não mexe no saldo do lote.
- **Lista de confirmados e CSV** (`GET .../participantes-confirmados`, `.../exportar-participantes.csv`, L801–837). Só `status_pagamento = 'aprovado'` e ingresso `valido`/`utilizado`.
- **Check-in** por documento/protocolo, uma vez (`L840–912` e `web/admin.html` L103–238). Concorrência tratada com `WHERE status_ingresso = 'valido'`.
- **Idempotência parcial de log**: `atendimentos.id_mensagem UNIQUE` (`schema.sql` L13); `POST /atendimentos` devolve 409 se repetir (`server.mjs` L1116–1118).
- **Gateway WhatsApp**: GET de verificação com `hub.mode=subscribe` + `hub.verify_token` lido de `work/whatsapp/verify-token.txt`, comparado em tempo constante. POST exige `X-Hub-Signature-256` (HMAC-SHA256 do corpo bruto com `META_APP_SECRET`) e responde 401 sem assinatura válida, antes de encaminhar ao n8n. Corpo acima de 1 MB responde 413 antes do HMAC (`api/body.mjs`). Bind em `127.0.0.1:8001`. Túnel Cloudflare *quick* em `scripts/iniciar-tunel-whatsapp.ps1`.
- **Scripts de boot**: Node 22.22.3 portátil + n8n `2.34.6` (`scripts/preparar-ambiente.ps1`, `scripts/iniciar-n8n.ps1` L46). `iniciar-projeto.ps1` sobe API e n8n.
- **HTTPS local mkcert** (`scripts/configurar-https-local.ps1`, `iniciar-api-https.ps1`): certs em `work/https/` (coberto por `work/` no `.gitignore`). Continua em `0.0.0.0:8443`, com a mesma autenticação do HTTP.
- **Simulador** `web/simulador.html` só é servido com `SIMULADOR_ATIVO=1` (`GET /` e `GET /simulador`). Sem a flag, 404. O admin `web/admin.html` continua em `GET /admin`.
- **Workflows 01–03**: simulação manual / formulário n8n / POST `/atendimentos`. Workflow 04: webhook `whatsapp-mensagens` encaminha o JSON ao `POST /interno/mensagem` e devolve a resposta (`workflows/04-webhook-whatsapp-simulado.json`). O JSON exportado continua `active: false`; a publicação é `publish:workflow`.

## O que é só simulação

| Peça | Por quê |
| --- | --- |
| Fluxos 01–03 | Trigger manual ou form n8n; dados fictícios. |
| Fluxo 04 | O JSON no git nasce `active: false`. A instância local precisa do `publicar-fluxo-04.ps1` e de um reinício do n8n. A saída para a Cloud API ainda é `pendente_envio`. |
| `POST /simular-mensagem` | Encaminha o JSON normalizado ao n8n e não chama `processarMensagem` por fora. Sem o fluxo 04 publicado, a venda não grava. |
| Pix do evento seed | Chave `PIX-DEMONSTRACAO-NAO-PAGAR` / tipo `demonstracao` (`server.mjs` L101–106, L578). |
| “Integração WhatsApp” no README | Checklist ainda aberto. Gateway não envia resposta à Cloud API. Não há download de mídia. |
| Google Sheets (`docs/arquitetura.md`, `docs/decisoes.md`) | Destino antigo; o código grava SQLite/CSV. |
| OCR, IA, embeddings, `mensagens_custo`, conciliação OFX, BR Code | Ausentes do repositório. |
| Docker `compose.yaml` | Só n8n `latest`, sem API; caminho principal é Node portátil. |

## O que está quebrado ou incompleto (impacto prático)

- **Envio real e mídia.** A resposta fica `pendente_envio`. Download de comprovante pelo WhatsApp fica para a 4b. Imagem e documento já recebem texto provisório.
- **Check-in é por CPF/RG/protocolo**, não por nome normalizado (regra de negócio alvo: lista por **nome**).
- **Estados do pedido** no schema (`iniciado`, `aguardando_pagamento`, `concluido`…) ≠ estados alvo (`aguardando_nomes`, `em_validacao`, `revisao_manual`…).
- **Workflows sem retry/onError** (grep zerado). 409 de `id_mensagem` falha o webhook em vez de 200 idempotente.
- **n8n exportado `active: false`**: o JSON no git não prova que o fluxo está publicado na instância local. **Não confirmado** no runtime.

## Variáveis de ambiente

Definidas em `.env.example` (valores de segredo **não** reproduzidos):

- `N8N_ENCRYPTION_KEY`
- `GENERIC_TIMEZONE` / `TZ` (padrão `America/Sao_Paulo`)
- `ADMIN_TOKEN` — obrigatório, no mínimo 24 caracteres; abaixo disso a API não sobe
- `META_APP_SECRET` — obrigatório para o gateway; sem ele o gateway não sobe
- `SIMULADOR_ATIVO` — só `1` liga o simulador; o padrão é desligado
- `API_DATABASE_PATH`, `API_HOST`, `API_PORT`
- `API_HTTPS_HOST` (no `.env.example`, `127.0.0.1`; o fallback do código e o `https.env` gerado continuam `0.0.0.0`), `API_HTTPS_PORT` (8443)
- `API_TLS_CERT_PATH`, `API_TLS_KEY_PATH` (juntas ou nenhuma)
- `N8N_WEBHOOK_URL` (padrão `http://127.0.0.1:5678/webhook/whatsapp-mensagens`)
- `API_INTERNAL_TOKEN` — obrigatório, no mínimo 24 caracteres; abaixo disso a API e o gateway não sobem. O gateway e `POST /simular-mensagem` enviam este Bearer ao webhook. O fluxo 04 só repassa o cabeçalho recebido.
- `WHATSAPP_EVENTO_CODIGO` — vazio usa o único evento com vendas abertas
- `FILA_MAX_TENTATIVAS` (padrão 30) e `FILA_RETENCAO_DIAS` (padrão 7)
- O processo do `iniciar-n8n.ps1` não recebe `API_INTERNAL_TOKEN`, `ADMIN_TOKEN`, `META_APP_SECRET` nem as variáveis da API. `N8N_LISTEN_ADDRESS=127.0.0.1`. `EXECUTIONS_DATA_SAVE_ON_SUCCESS=none`, `EXECUTIONS_DATA_SAVE_ON_ERROR=none`, `EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=false`, `EXECUTIONS_DATA_SAVE_ON_PROGRESS=false`, `EXECUTIONS_DATA_PRUNE=true` e `EXECUTIONS_DATA_MAX_AGE=72` ficam nesse script, não no `.env`
- `GATEWAY_PORT` — vazio usa `8001`
- `N8N_VIRADA_LOTE_WEBHOOK_URL` — opcional; aviso de virada ou esgotamento. Vazio ou n8n fora do ar não desfaz a aprovação

HTTPS: `work/https/https.env` gerado pelo script (fora do git) e carregado depois do `.env`. O verify token do GET continua em `work/whatsapp/verify-token.txt`, não no `.env`.

`scripts/iniciar-api.ps1`, `iniciar-api-https.ps1` e `iniciar-gateway-whatsapp.ps1` carregam o `.env` no processo e não imprimem os segredos.

## Auth e HMAC (2026-10-14)

As citações de linha da revisão de 2026-10-12 podem ter deslocado depois desta mudança.

- `ADMIN_TOKEN` comparado com SHA-256 + `crypto.timingSafeEqual` (`api/auth.mjs`). Header: `Authorization: Bearer`. Token esperado ou recebido vazio não autoriza. Mínimo de 24 caracteres.
- Exigem o token: `/admin/*`, `GET /atendimentos`, `GET /exportar`.
- Sem o token: `GET /admin` (só o HTML), `GET /saude` (não devolve o caminho do banco), catálogo `/eventos`, `POST /comprovantes`, `POST /atendimentos`.
- Simulador desligado por padrão. `SIMULADOR_ATIVO=1` liga `GET /`, `GET /simulador` e `POST /simular-mensagem`. Sem a flag, essas rotas respondem 404.
- `web/admin.html` pede o token ao abrir e guarda só em `sessionStorage`. CSV, confirmados e comprovante baixam por `fetch`, porque um link não envia o header.
- Gateway: HMAC do corpo bruto em `api/meta-signature.mjs`. Assinatura ausente, errada ou de outro corpo → 401, sem gravar na fila. Acima de 1 MB → 413, antes do HMAC. Com HMAC válido, a fila grava e o gateway responde 200.
- `API_INTERNAL_TOKEN` usa a mesma comparação do admin. Sem ele, ou com menos de 24 caracteres, a API não sobe.
- Testes: `node --test`.

**Risco do HTTPS em rede compartilhada.** O `.env.example` usa `API_HTTPS_HOST=127.0.0.1`. O código, se a variável vier vazia, e o `scripts/configurar-https-local.ps1` ainda gravam `0.0.0.0`. `scripts/iniciar-api-https.ps1` avisa quando o valor efetivo é `0.0.0.0`: quem estiver na mesma rede alcança a porta, e `POST /atendimentos` e `POST /comprovantes` ficam abertos. Admin e listagens continuam exigindo `ADMIN_TOKEN`.

## Lotes e preços (2026-10-14)

A virada é por quantidade vendida. `inicio` e `fim` continuam no banco e não entram na regra. O lote vigente é o de menor `ordem` com status `disponivel` e `ativo = 1`. `ativo = 0` pausa a venda desse lote. Sem lote `disponivel` e com algum `encerrado`, o evento está esgotado.

A cotação, ao saber a quantidade, informa o total e não grava pedido. A reserva nasce quando o último nome chega, ou depois de `CONFIRMAR` se o preço mudou desde a cotação. Ela congela o preço, grava o prazo e conta no limite do telefone e no teto do evento. Não soma `quantidade_reservada`. Um pedido pode deixar `quantidade_vendida` acima da capacidade do lote vigente; o excedente não consome o lote seguinte.

A virada ocorre na aprovação do pagamento, dentro de `BEGIN IMMEDIATE`. O lote vigente é encerrado quando os confirmados dele atingem a capacidade, o próximo `futuro` passa a `disponivel`, e entra uma linha em `viradas_lote` (`virada` ou `esgotado`). Expirar, cancelar ou recusar não reabre lote. Pedido reservado antes da virada mantém o preço gravado.

O alerta no admin permanece até `POST /admin/viradas/:id/anunciada`. O webhook opcional sai depois do commit; o payload não leva telefone nem nome de comprador. `enviado_em` e `erro` ficam na própria virada.

O telefone do limite é só dígitos. Contam ingressos aprovados, em análise e reservas ainda dentro do prazo, somando os pedidos daquele número. O padrão é `max_ingressos_por_pessoa = 10`; `NULL` não limita. `capacidade_maxima_evento` NULL não cria teto. O desconto é o JSON `descontos_quantidade_json`, vazio por padrão. O total em centavos é `floor((preço × quantidade × (100 − percentual) + 50) / 100)`.

O prazo padrão do evento novo e do demonstração é 60 minutos. A cada 60 segundos, e em `POST /admin/reservas/expirar`, a API marca como `expirado` só o pedido que ainda está `aguardando_pagamento` com o prazo vencido. Comprovante enviado depois disso volta o pedido para `em_analise` com `recebido_apos_expirar = 1`, e o preço congelado continua. O comprovante é aceito pelo telefone do pedido (só dígitos) e pelo evento, mesmo que a conversa atual já seja outro atendimento. `cancelar` cancela o pedido que ainda espera comprovante. No estado `pagamento_em_analise`, a conversa responde que o comprovante está em análise.

A conversa não pede CPF/RG. As colunas de documento ficam e aceitam vazio. Banco antigo sobe com `PRAGMA user_version`: toda migração da versão 0 para a 1 grava `backup-pre-migracao-<timestamp>` ao lado do arquivo do banco, mesmo sem recriar `participantes`. Se a tabela antiga tiver coluna extra, a migração aborta e o backup fica. Foreign keys desligam só na cópia de `participantes`, e a cópia aborta se a contagem de linhas divergir. O seed vazio cria os lotes de 20, 30 e 50 ingressos, a R$ 30, R$ 40 e R$ 50, sem data. Um demonstração antigo ganha o terceiro lote e o prazo de 60 minutos, sem apagar os lotes que já existiam.

Não há override do limite por pessoa. Comprovante recusado continua fora desta etapa: a recusa libera a cota e não reabre prazo nem lote.

Testes: `node --test`.

## Como rodar do zero (pelo que os scripts fazem)

1. Node.js com `npm` no PATH (o portátil é instalado *via* npm).
2. `powershell -ExecutionPolicy Bypass -File .\scripts\preparar-ambiente.ps1` → Node `22.22.3` em `work/runtime/`.
3. Copiar `.env.example` → `.env` e preencher `N8N_ENCRYPTION_KEY`, `ADMIN_TOKEN`, `API_INTERNAL_TOKEN` e `META_APP_SECRET` (não commitar).
4. `.\scripts\iniciar-projeto.ps1` (ou `iniciar-n8n.ps1` + `iniciar-api.ps1`).
5. Abrir n8n `http://localhost:5678`, importar/ativar `workflows/04-webhook-whatsapp-simulado.json` (**não confirmado** se já está ativo na pasta `work/n8n-user`).
6. Simulador, só com `SIMULADOR_ATIVO=1`: `http://127.0.0.1:8000/simulador`. Admin: `http://127.0.0.1:8000/admin` (a página pede o `ADMIN_TOKEN`).
7. Exportar log antigo: `.\scripts\exportar-planilha.ps1` → `planilha/dados/atendimentos.csv` (envia o Bearer). Lista de entrada: botão no admin ou `GET /admin/eventos/:codigo/exportar-participantes.csv` com o mesmo token.
8. Gateway (opcional): `META_APP_SECRET` no `.env`, token em `work/whatsapp/verify-token.txt`, `iniciar-gateway-whatsapp.ps1` + `iniciar-tunel-whatsapp.ps1` (exige `work/tools/cloudflared.exe`).

O computador precisa ficar ligado. Integração Meta **não** está concluída no código.

## `.gitignore` vs pedido da Fase 1

| Alvo | Coberto? |
| --- | --- |
| `.env` | Sim (`.gitignore` L2–4, `!.env.example`) |
| `work/` | Sim (L24) → inclui `work/https/` e o token WhatsApp |
| `*.sqlite` | Sim (L9–11) |
| `data/` (banco + comprovantes) | Sim (L21) |
| `planilha/dados/` | Sim (L20) |
| `contexto_n8n.txt` | Sim (`.gitignore`) |
| Exportações de conversas WhatsApp | Sim: `conversas/`, `chats/`, `exports/whatsapp/` |

## README desatualizado

A seção **Estrutura** (`README.md` L38–47) omite `api/`, `web/`, `scripts/` além do n8n, e `data/`. O corpo do README *menciona* API, admin e simulador, mas a árvore não. `docs/arquitetura.md` ainda cita Google Sheets.
