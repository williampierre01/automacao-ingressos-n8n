# Revisão — Fase 1

Revisão em 2026-10-12, só leitura de código e docs. Runtime (API, n8n e gateway no ar) **não confirmado**. Segredos de `.env` não foram abertos nem impressos.

Itens checados de propósito: assinatura `X-Hub-Signature-256` e token do webhook; auth da API e do `admin.html`; retry, erro e idempotência nos workflows; validação e SQL em `api/server.mjs` / `api/schema.sql`; `.gitignore`; README (seção Estrutura).

## Alta

| Problema | Arquivo / linha | Notas |
| --- | --- | --- |
| POST do webhook **sem** `X-Hub-Signature-256`. Quem acerta a URL pública injeta JSON | `api/whatsapp-gateway.mjs` L73–89 | GET de verificação existe (L60–70); HMAC no POST **não**. Não há `createHmac` / `timingSafeEqual` no repo |
| **Zero autenticação** em admin, comprovantes, check-in, export CSV, criação de evento/lote. CORS `Access-Control-Allow-Origin: *` | `api/server.mjs` L286–290, L604–611, L633–644, L702–757, L760–798, L801–912, L977–1062; `web/admin.html` (fetches sem token) | Qualquer cliente na rede que alcance a API administra o evento |
| HTTPS da API escuta `0.0.0.0:8443` por padrão, expondo o admin na LAN sem senha | `api/server.mjs` L19–20, L1233–1247; `scripts/iniciar-api-https.ps1` | Combinado com o item anterior |
| Caminho **simulador ≠ WhatsApp**: a venda (lotes, nomes, reserva) só roda em `POST /simular-mensagem`; o fluxo 04 só grava `atendimentos` e o gateway **não** envia resposta à Cloud API | `api/server.mjs` L1124–1202, L1188–1192; `workflows/04-webhook-whatsapp-simulado.json` L6–17, L21, L31–32; `api/whatsapp-gateway.mjs` L78–82 | WhatsApp real não entra na máquina de estados |
| Seed do lote de demo, na data da revisão (2026-10-12), tende a **não ter `lote_atual`** | `api/server.mjs` L75–98, L404–411, L1151–1154 | 1º lote `disponivel` termina `2026-09-30`; 2º começa `2026-10-01` mas status `futuro`. `currentLot` exige `status === 'disponivel'` **e** janela de datas |
| Reserva **não expira**; estoque fica preso. Status `expirado` existe no schema, sem job | `api/server.mjs` L446, L456; `api/schema.sql` L78, L83 | `prazo_reserva_minutos` só gera `reserva_expira_em` |
| `cancelar` a conversa **não solta** reserva / pedido | `api/server.mjs` L478–485 | Só zera estado da conversa |
| PII sem senha: lista de atendimentos, export CSV, comprovante inline | `api/server.mjs` L647–652, L987–999, L1065–1072 | Telefone, nome, mensagem, arquivo do comprovante |

## Média

| Problema | Arquivo / linha | Notas |
| --- | --- | --- |
| Token GET do webhook usa `===` (não constant-time) | `api/whatsapp-gateway.mjs` L65 | Token lido de `work/whatsapp/verify-token.txt` (L8–16); arquivo vazio aborta (L14–16) |
| Idempotência só em `atendimentos.id_mensagem` UNIQUE. Sem id do WhatsApp a API gera UUID → retry duplica. 409 no n8n **quebra** o webhook | `api/schema.sql` L13; `api/server.mjs` L1087, L1116–1118; `workflows/04-webhook-whatsapp-simulado.json` L21 (`id_mensagem: body.id_mensagem ?? mensagemWhatsApp.id`) | Pedidos/conversas **não** usam o id da mensagem da Meta |
| Workflows **sem** retry, `onError`, `continueOnFail` ou Error Trigger | `workflows/01-simulacao-whatsapp.json`, `02-simulacao-api-local.json`, `03-formulario-local.json`, `04-webhook-whatsapp-simulado.json` | Grep zerado no repo |
| Fluxo 04 exportado com `active: false`; webhook n8n sem autenticação de header | `workflows/04-webhook-whatsapp-simulado.json` L6–17 (`options: {}`), L72 | Publicado na instância local: **não confirmado** |
| Gateway devolve o status do n8n à Meta em vez de 200 imediato | `api/whatsapp-gateway.mjs` L85–89 | Timeout / falha do n8n vira reentrega da Meta |
| Check-in por **CPF/RG/protocolo**, não por nome normalizado | `api/server.mjs` L246–265, L308–310, L840–863; `web/admin.html` L103–107 | Conflita com “entrada = nome na lista” |
| Participantes exigem CPF ou RG | `api/schema.sql` L102–103; `api/server.mjs` L526–539 | Regra de negócio alvo é nome após comprovante |
| Comprovante: MIME declarado, sem magic bytes, hash, perceptual hash, EXIF, E2E | `api/server.mjs` L924–949; `api/schema.sql` L129–137 | OCR/antifraude ausentes (módulo C) |
| `GET /saude` devolve o caminho do banco | `api/server.mjs` L614–616 | Disclosure de path |
| `CREATE TABLE IF NOT EXISTS` sem migração: colunas novas não entram em base antiga | `api/server.mjs` L32–33; `api/schema.sql` (arquivo inteiro) | Dívida de schema |
| `compose.yaml` usa `n8n:latest`, não 2.34.6, e não sobe a API | `compose.yaml` L3–17 | Caminho principal é Node portátil |
| README seção **Estrutura** omite `api/` e `web/` | `README.md` L38–47 | Corpo do README menciona API/admin/simulador; a árvore não |
| Docs ainda citam Google Sheets | `docs/arquitetura.md` L5, L12; `docs/decisoes.md` L7 | Código grava SQLite/CSV |
| `.gitignore` sem regra explícita para exports de conversas WhatsApp | `.gitignore` | **Corrigido na primeira tarefa:** `conversas/`, `chats/`, `exports/whatsapp/`. `contexto_n8n.txt` já estava coberto |
| Mídia WhatsApp (imagem/PDF de comprovante) não é interpretada | `workflows/04-webhook-whatsapp-simulado.json` L21 | Só texto, botão e list reply |
| Estados de pedido no schema ≠ estados alvo | `api/schema.sql` L79–85 vs alvo `aguardando_nomes` / `em_validacao` / `revisao_manual` / `confirmado` | Dívida do módulo A/C |
| Aprovação de pagamento **não** checa `reserva_expira_em` | `api/server.mjs` L1015–1035 | Pode confirmar pedido já vencido no papel |
| Preço na reserva é o do lote **no momento do CONFIRMAR**, não um snapshot na abertura da conversa (além do `lote_id`) | `api/server.mjs` L488–492, L572–576 | Se o preço do lote mudar no admin (hoje não há PATCH), o pedido muda |
| `publicEvent` omite Pix nas rotas GET, mas a resposta da conversa inclui chave e favorecido | `api/server.mjs` L383–389, L577–583 | Esperado para o comprador; risco se a conversa vazar no log `/atendimentos` |

## Baixa

| Problema | Arquivo / linha | Notas |
| --- | --- | --- |
| CPF: só comprimento 11, sem dígitos verificadores | `api/server.mjs` L536–538 | RG: 5–14 dígitos |
| `iniciar-projeto.ps1` tem UUID de formulário n8n hardcoded | `scripts/iniciar-projeto.ps1` L66 | Quebra se o workflow 03 for reimportado |
| `mostrar-token-whatsapp.ps1` imprime o token no terminal | `scripts/mostrar-token-whatsapp.ps1` L10–11 | Risco se a sessão for logada |
| `scripts/exportar-planilha.ps1` baixa o **log** de atendimentos, não a lista da festa | `scripts/exportar-planilha.ps1` L8; `api/server.mjs` L343–360 vs L363–380 | Lista correta: `GET .../exportar-participantes.csv` |
| Comparação de token / CORS sem `Access-Control-Allow-Headers` de auth (quando houver token) | `api/server.mjs` L604–611 | Preparação para auth futura |
| n8n Community: script não define basic auth / usuário; setup de owner na 1ª subida | `scripts/iniciar-n8n.ps1` | **Não confirmado** se a instância local já tem dono |
| `.env.example` não documenta variáveis da API | `.env.example` L1–6 vs `api/server.mjs` L13–23 | `API_*`, `N8N_WEBHOOK_URL` |
| Seed grava Pix de demonstração no banco | `api/server.mjs` L101–106 | Só se `pix_chave = ''` no evento demo |
| Upload aceita `application/pdf` / imagem pelo header, conteúdo não verificado | `api/server.mjs` L924–941 | Relacionado ao item médio de magic bytes |
| Índice de participantes por documento, não por nome normalizado | `api/schema.sql` L143 | Portaria alvo busca nome |
| `UNIQUE (evento_id, telefone)` em conversas: um telefone = um fluxo por evento; segundo comprador no mesmo número sobrescreve | `api/schema.sql` L126; `api/server.mjs` L170–184 | Pode ser regra desejada; **não confirmado** |
| Workflow 03 `authentication: none` no form trigger | `workflows/03-formulario-local.json` L7 | Aceitável em localhost |

## Validação de entrada e SQL (síntese)

- **SQL injection:** não encontrada. Uso de `database.prepare` / `.run` / `.get` / `.all` com placeholders (`api/server.mjs` em todo o arquivo; `api/schema.sql` com `CHECK` e FKs).
- **Validação presente:** `normalizeText` (L293–296), `positiveInteger` / `nonNegativeInteger` (L298–306), limite de body JSON 1 MB (7 MB em comprovantes), MIME allowlist, tamanho 5 MB, código de evento `[a-z0-9-]+` (L732–735), campos obrigatórios em `/atendimentos` (L1090–1096).
- **Furos:** rotas `/admin/*` sem auth; comprovante amarra pedido+telefone mas qualquer um que conheça os três campos envia; check-in POST só precisa de `participante_id` se já autenticado na rede; `id_mensagem` opcional.

## Assinatura e token do webhook (síntese)

| Controle | Estado |
| --- | --- |
| GET `hub.mode=subscribe` + `hub.verify_token` | Implementado (`api/whatsapp-gateway.mjs` L60–70) |
| POST `X-Hub-Signature-256` | **Ausente** (L73–89) |
| Auth do webhook n8n (`whatsapp-mensagens`) | **Ausente** (`workflows/04-webhook-whatsapp-simulado.json` L6–17) |

## Autenticação da API e do admin (síntese)

Nenhuma variável `API_TOKEN` / sessão / basic auth. `web/admin.html` chama `/admin/eventos`, `/admin/pedidos`, `/admin/comprovantes/:id`, check-in e pagamento com `fetch` anônimo. Páginas HTML em `GET /admin` e `GET /simulador` são públicas no bind da API.

## Retry, erro e idempotência nos workflows (síntese)

Fluxo linear: webhook → code → HTTP POST `/atendimentos` → respond. Sem ramo de erro. Duplicata Unique em `id_mensagem` vira falha da execução. Gateway replica o status ao chamador. Não há tabela de mensagens WhatsApp processadas para a máquina de venda.

## `.gitignore` vs pedido da Fase 1

| Alvo | Coberto? |
| --- | --- |
| `.env` | Sim (`.gitignore` L2–4, `!.env.example`) |
| `work/` (inclui `work/https/` e token WhatsApp) | Sim (L25) |
| `*.sqlite` | Sim (L9–11) |
| `data/` (banco + comprovantes) | Sim (L21) |
| `planilha/dados/` | Sim (L20) |
| `contexto_n8n.txt` | Sim (L22). Na revisão original de 2026-10-12 estava **ausente** |
| Exportações de conversas / chats | Sim: `conversas/`, `chats/`, `exports/whatsapp/` |

## README desatualizado

`README.md` seção Estrutura **passa a listar** `api/` e `web/` (primeira tarefa). `docs/arquitetura.md` e `docs/decisoes.md` ainda apontam Google Sheets.

## Itens marcados “não confirmado”

- Instância n8n local com fluxo 04 publicado/ativo (`work/n8n-user` fora do git).
- GPU/RAM desta máquina para PaddleOCR-VL-1.6 vs PP-OCR (benchmark não rodou).
- Se um telefone = uma conversa por evento é regra de negócio.
- Se o prazo real de reserva é os 30 minutos do seed (`api/server.mjs` L59, L719).
- Owner/login do n8n 2.34.6 após o primeiro start.
