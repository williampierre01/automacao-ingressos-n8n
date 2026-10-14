# Estado atual

Revisão em 2026-10-12, só leitura de código e docs. **Não confirmei runtime** (API, n8n e gateway não foram exercitados nesta fase). Evidência = trechos versionados. Segredos de `.env` não foram abertos nem impressos.

## O que funciona (evidência no código)

- **API HTTP local** em `api/server.mjs`: escuta `API_HOST`/`API_PORT` (padrão `127.0.0.1:8000`), cria `data/` e `data/comprovantes/`, aplica `api/schema.sql` via `DatabaseSync`.
- **SQLite com WAL e foreign keys** (`api/schema.sql` L1–2). Consultas usam *prepared statements* (não há concatenação de SQL com input).
- **Modelo parcial de eventos/lotes/pedidos/participantes/conversas/comprovantes** (`api/schema.sql` L16–137). Seed de demonstração se a base está vazia (`api/server.mjs` L35–106).
- **Cálculo de total no código**, não no n8n: `valor_unitario_centavos * quantidade` em `createReservation` (`api/server.mjs` L452–456, L554, L577).
- **Máquina de estados local** em `processConversation` (`api/server.mjs` L473–592): quantidade → nomes → CPF/RG → confirmar → reserva + Pix → espera comprovante. Disparada por `POST /simular-mensagem` (`L1124–1202`).
- **Reserva atômica de estoque** (`BEGIN IMMEDIATE` + `UPDATE` com `quantidade_total - reservada - vendida >= ?`, L448–470, L200–204).
- **Upload de comprovante** JPG/PNG/PDF até 5 MB, amarra pedido+telefone+evento (`L915–974`). Arquivo em `data/comprovantes/` (pasta coberta por `.gitignore` via `data/`).
- **Aprovação/recusa humana** em `POST /admin/pedidos/:id/pagamento` (`L1003–1062`): promove participantes a `valido` ou `cancelado` e ajusta reservada/vendida.
- **Lista de confirmados e CSV** (`GET .../participantes-confirmados`, `.../exportar-participantes.csv`, L801–837). Só `status_pagamento = 'aprovado'` e ingresso `valido`/`utilizado`.
- **Check-in** por documento/protocolo, uma vez (`L840–912` e `web/admin.html` L103–238). Concorrência tratada com `WHERE status_ingresso = 'valido'`.
- **Idempotência parcial de log**: `atendimentos.id_mensagem UNIQUE` (`schema.sql` L13); `POST /atendimentos` devolve 409 se repetir (`server.mjs` L1116–1118).
- **Gateway WhatsApp**: GET de verificação com `hub.mode=subscribe` + `hub.verify_token` lido de `work/whatsapp/verify-token.txt` (`api/whatsapp-gateway.mjs` L8–16, L60–70). Bind em `127.0.0.1:8001`. Túnel Cloudflare *quick* em `scripts/iniciar-tunel-whatsapp.ps1`.
- **Scripts de boot**: Node 22.22.3 portátil + n8n `2.34.6` (`scripts/preparar-ambiente.ps1`, `scripts/iniciar-n8n.ps1` L46). `iniciar-projeto.ps1` sobe API e n8n.
- **HTTPS local mkcert** (`scripts/configurar-https-local.ps1`, `iniciar-api-https.ps1`): certs em `work/https/` (coberto por `work/` no `.gitignore`).
- **Simulador** `web/simulador.html` + admin `web/admin.html` servidos pela API (`server.mjs` L619–644).
- **Workflows 01–03**: simulação manual / formulário n8n / POST `/atendimentos`. Workflow 04: webhook `whatsapp-mensagens` interpreta JSON simples **ou** envelope Cloud API de texto (`workflows/04-webhook-whatsapp-simulado.json` L21).

## O que é só simulação

| Peça | Por quê |
| --- | --- |
| Fluxos 01–03 | Trigger manual ou form n8n; dados fictícios. |
| Fluxo 04 | Nome “WhatsApp simulado”; `active: false` no JSON exportado. Grava só `atendimentos`, **não** chama a máquina de venda. |
| `POST /simular-mensagem` | Encaminha ao n8n **e depois** roda `processConversation` na API. Caminho real (gateway → n8n) **não** replica isso. |
| Pix do evento seed | Chave `PIX-DEMONSTRACAO-NAO-PAGAR` / tipo `demonstracao` (`server.mjs` L101–106, L578). |
| “Integração WhatsApp” no README | Checklist ainda aberto. Gateway não envia resposta à Cloud API. Não há download de mídia. |
| Google Sheets (`docs/arquitetura.md`, `docs/decisoes.md`) | Destino antigo; o código grava SQLite/CSV. |
| OCR, IA, embeddings, `mensagens_custo`, conciliação OFX, BR Code | Ausentes do repositório. |
| Docker `compose.yaml` | Só n8n `latest`, sem API; caminho principal é Node portátil. |

## O que está quebrado ou incompleto (impacto prático)

- **Dois caminhos de atendimento.** WhatsApp real passaria pelo gateway → fluxo 04 → `POST /atendimentos`. A venda (lotes, nomes, reserva) só existe em `/simular-mensagem`. Evidência: `whatsapp-gateway.mjs` L78–82 vs `server.mjs` L1188–1192 vs fluxo 04 L31–32.
- **Lote atual do seed, na data de hoje (2026-10-12), tende a ser nulo.** 1º lote `disponivel` termina `2026-09-30`; 2º lote começa `2026-10-01` mas status `futuro`. `currentLot` exige `status === 'disponivel'` **e** janela de datas (`server.mjs` L404–411, L75–98). Sem lote, o simulador recusa venda (`L1151–1154`).
- **Prazo de reserva não expira.** `reserva_expira_em` é gravado (`L446`, `schema.sql` L78) e o status `expirado` existe, mas nenhum job libera estoque.
- **Cancelar conversa não solta reserva** (`server.mjs` L478–485).
- **Mídia WhatsApp (comprovante) não é tratada.** Fluxo 04 lê texto/botão/lista, não `image`/`document`.
- **Check-in é por CPF/RG/protocolo**, não por nome normalizado (regra de negócio alvo: lista por **nome**).
- **Estados do pedido** no schema (`iniciado`, `aguardando_pagamento`, `concluido`…) ≠ estados alvo (`aguardando_nomes`, `em_validacao`, `revisao_manual`…).
- **Workflows sem retry/onError** (grep zerado). 409 de `id_mensagem` falha o webhook em vez de 200 idempotente.
- **n8n exportado `active: false`**: o JSON no git não prova que o fluxo está publicado na instância local. **Não confirmado** no runtime.

## Variáveis de ambiente

Definidas em `.env.example` (valores de segredo **não** reproduzidos):

- `N8N_ENCRYPTION_KEY`
- `GENERIC_TIMEZONE` / `TZ` (padrão `America/Sao_Paulo`)

Usadas no código da API, **não** documentadas no `.env.example`:

- `API_DATABASE_PATH`, `API_HOST`, `API_PORT`
- `API_HTTPS_HOST` (padrão `0.0.0.0`), `API_HTTPS_PORT` (8443)
- `API_TLS_CERT_PATH`, `API_TLS_KEY_PATH` (juntas ou nenhuma)
- `N8N_WEBHOOK_URL` (padrão `http://127.0.0.1:5678/webhook/whatsapp-mensagens`)

HTTPS: `work/https/https.env` gerado pelo script (fora do git). Gateway: token em arquivo, não em `.env`. **Não há variável de autenticação da API/admin.**

## Como rodar do zero (pelo que os scripts fazem)

1. Node.js com `npm` no PATH (o portátil é instalado *via* npm).
2. `powershell -ExecutionPolicy Bypass -File .\scripts\preparar-ambiente.ps1` → Node `22.22.3` em `work/runtime/`.
3. Copiar `.env.example` → `.env` e preencher `N8N_ENCRYPTION_KEY` (não commitar).
4. `.\scripts\iniciar-projeto.ps1` (ou `iniciar-n8n.ps1` + `iniciar-api.ps1`).
5. Abrir n8n `http://localhost:5678`, importar/ativar `workflows/04-webhook-whatsapp-simulado.json` (**não confirmado** se já está ativo na pasta `work/n8n-user`).
6. Simulador: `http://127.0.0.1:8000/simulador`. Admin: `http://127.0.0.1:8000/admin`.
7. Exportar log antigo: `.\scripts\exportar-planilha.ps1` → `planilha/dados/atendimentos.csv`. Lista de entrada: botão no admin ou `GET /admin/eventos/:codigo/exportar-participantes.csv`.
8. Gateway (opcional): token em `work/whatsapp/verify-token.txt` + `iniciar-gateway-whatsapp.ps1` + `iniciar-tunel-whatsapp.ps1` (exige `work/tools/cloudflared.exe`).

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
