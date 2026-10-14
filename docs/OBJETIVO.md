# Objetivo e plano

O cliente inicia a conversa no WhatsApp; um atendimento no n8n (máquina de estados) usa a API como fonte de verdade de lote, preço e vagas; a IA só interpreta texto livre com tom aprendido de conversas antigas **anonimizadas** e só comunica valores que a API devolver; nomes entram na lista (SQLite → Excel) **somente** após confirmação do comprovante (OCR como triagem + revisão humana nos casos duvidosos; conciliação bancária como confirmação final quando existir); casos duvidosos ficam em `revisao_manual` no admin. Sem disparo a leads. Custo mínimo; sem CNPJ/MEI.

## Critérios de aceite (verificáveis)

- [ ] Entrada na festa = **nome na lista**. Não há ingresso físico/digital como garantia.
- [ ] Nome só entra na lista se o pedido está `confirmado` (pagamento validado).
- [ ] Preço e lote vigentes vêm da API; o LLM **nunca** calcula total nem inventa lote/vaga.
- [ ] Há um nome (item) por ingresso; quantidade N gera N linhas.
- [ ] Desconto por quantidade, se existir, é regra **configurável** no banco, não hardcoded chutado.
- [ ] Pedido aberto congela o preço do lote vigente na criação da reserva, com prazo de validade que **expira e devolve estoque**.
- [ ] Webhook WhatsApp rejeita POST sem `X-Hub-Signature-256` válida; GET de verificação exige token.
- [ ] Admin e rotas `/admin/*` exigem autenticação; comprovantes e PII não são públicos.
- [ ] Mensagens WhatsApp duplicadas (`messages[].id`) não criam dois pedidos; resposta HTTP 200 idempotente.
- [ ] OCR nunca aprova sozinho; baixa confiança / valor divergente / campo ilegível → `revisao_manual`.
- [ ] Lista Excel exportada é idempotente (reexportar não duplica nomes).
- [ ] Portaria busca nome sem acento/caixa e marca `já entrou` uma vez.
- [ ] Comprovantes e conversas reais ficam fora do git.
- [ ] Cada status webhook grava `pricing.billable` / `type` / `category` em `mensagens_custo`; existe relatório mensal.
- [ ] Bot agrupa respostas; respeita janela de 24h; avisa antes de expirar; não envia template pago sem decisão explícita.
- [ ] Fora de escopo: campanhas/disparos a lista de leads — não implementado.

## Gap — tarefas ordenadas (arquivos afetados)

Ordem pensada para não construir IA/OCR em cima de schema e segurança furados.

1. **Higiene de git e docs** — `.gitignore`, `README.md` (seção Estrutura), `docs/arquitetura.md` / `docs/decisoes.md` (Sheets → SQLite). Incluir `contexto_n8n.txt` e pastas de conversas/comprovantes.
2. **Auth da API/admin + HMAC do webhook** — `api/server.mjs`, `api/whatsapp-gateway.mjs`, `web/admin.html`, `.env.example`, `scripts/iniciar-gateway-whatsapp.ps1`.
3. **Módulo A — schema e API de preço/lote** — `api/schema.sql`, `api/server.mjs`, `web/admin.html` (job de expiração; virada de lote; estados alinhados).
4. **Unificar caminho simulador = WhatsApp** — `workflows/04-*.json`, `api/server.mjs` (`/simular-mensagem` deixa de duplicar lógica), gateway responde 200 rápido e enfileira.
5. **Módulo D mínimo — lista por nome + portaria** — schema participantes, `web/` página de portaria, export Excel.
6. **Módulo C — OCR local + antifraude + estados de pedido** — novo serviço OCR, `comprovantes`, `admin.html`.
7. **Módulo B — import anonimizado + prompt/RAG + guardrails + eval** — pasta fora do git, n8n state machine, embeddings sqlite-vec.
8. **Módulo F — custo WhatsApp, janela 24h, limites** — tabela `mensagens_custo`, relatório, agrupamento de replies.
9. **Módulo E** — só depois da avaliação abaixo; implementar o que for priorizado (não nesta fase).

---

## Módulo A — Lotes e preços

**Hoje:** tabelas `eventos`, `lotes`, `pedidos`, `participantes` existem. Preço unitário em centavos; total na API. Reserva grava `valor_unitario_centavos` no pedido. Não há tabela `itens` separada (o item é `participantes`, mas exige CPF/RG). Sem desconto por quantidade. Sem job de virada/expiração. Status de lote (`futuro`/`disponivel`) não acompanha data automaticamente.

**Alvo:**

- Modelar: eventos, lotes (nome, preço unitário, limite por data **e/ou** quantidade, ativo), pedidos, itens (um nome por ingresso).
- Total **sempre** na API.
- Virada de lote por data ou quantidade vendida.
- Pedido aberto mantém preço do lote vigente na **criação da reserva**; prazo de validade (hoje `prazo_reserva_minutos`, default 30 — **perguntar** se esse é o prazo de negócio).
- Desconto por quantidade: **não inventar**. Campo configurável (ex. JSON de faixas ou tabela `lote_precos_quantidade`) mesmo que vazio.

**Arquivos:** `api/schema.sql`, `api/server.mjs`, `web/admin.html`, `api/README.md`.

**Pergunta em aberto:** existe desconto/tabela por quantidade? Se sim, quais faixas?

---

## Módulo B — IA de atendimento + conversas antigas

**Hoje:** regras fixas em `processConversation` (palavras `COMPRAR`/`CONFIRMAR`/`CPF`). Sem LLM, sem import de chats, sem RAG, sem eval.

**Alvo:**

- Importar exportações WhatsApp → parse → **anonimizar** (telefones, nomes, chaves Pix, CPF) **antes** de qualquer uso. Dados fora do git.
- Extrair FAQ, objeções, tom, fluxo típico, bordas — artefato em `docs/` sem PII.
- Começar por **prompt de sistema + few-shot**; RAG com embeddings **locais** + `sqlite-vec`. Fine-tuning só se o eval mostrar falha sistemática (custo, GPU, manutenção); justificar com métricas do conjunto de teste.
- n8n = máquina de estados; LLM só classifica/extrai texto livre (quantidade, nomes, “quero 2”).
- Guardrails: não promete preço/lote/vaga fora da API; não confirma pagamento; recusa assunto fora de venda do evento; escala a humano.
- Eval (ex. promptfoo) com conversas de teste e resultado esperado.

**Arquivos previstos:** `workflows/` (fluxo de estados), `api/server.mjs` (endpoints de preço/estado), pasta local `work/conversas/` (gitignored), `docs/tom-atendimento.md` (sem PII), eval em `eval/`.

---

## Módulo C — OCR e validação do comprovante

**Hoje:** upload + fila `em_analise` + botão humano. Sem OCR, hash, EXIF, E2E.

**Comparação na sua máquina: não executada nesta fase** (sem evidência de GPU/RAM local). Dados públicos (não substituem o teste):

| | PaddleOCR-VL-1.6 (0.9B) | PP-OCR (pipeline) |
| --- | --- | --- |
| Licença | Apache 2.0 | Apache 2.0 |
| Papel | VLM documento; melhor em layout/tabela de Pix | OCR clássico, mais leve em CPU |
| Recurso | ~0.9B params; ordem de ~2 GB VRAM em FP16 (fontes HF/docs); CPU possível mas lento | CPU/RAM bem menor |
| Risco | Alucina campos “plausíveis” (o próprio requisito) | Pode errar valor/E2E em print ruim |

**Recomendação provisória (até o benchmark na sua máquina):** se houver GPU NVIDIA usável, testar VL-1.6 primeiro pela extração de comprovante; senão, PP-OCR como triagem. **Nunca auto-aprovar.** Confirmação final preferencialmente conciliação (Módulo E.1).

**Alvo de extração:** valor, data/hora, pagador, destinatário/chave, ID E2E.

**Validação:** valor == total do pedido; destinatário correto; data recente; ID inédito; E2E 32 chars (`E` + 8 dígitos ISPB + 12 data/hora + 11 alfanuméricos).

**Antifraude:** hash arquivo + hash perceptual + E2E; EXIF.

**Estados do pedido:** `aguardando_nomes`, `aguardando_comprovante`, `em_validacao`, `revisao_manual`, `confirmado`, `recusado`, `expirado`.

**Arquivos:** `api/schema.sql` (colunas hash/ocr/estado), `api/server.mjs`, novo `api/ocr-*.mjs` ou script Python isolado em `work/`, `web/admin.html`.

---

## Módulo D — Lista final

**Hoje:** CSV de participantes com pagamento `aprovado`; check-in por documento. Nome não é chave de busca. Sem política de correção/cancelamento de nome. Export de `atendimentos` (log) não é a lista da festa.

**Alvo:**

- Só `confirmado` gera linha (nome, lote, valor pago, data).
- Excel idempotente (chave estável: `pedido_id + indice_item` ou nome normalizado + protocolo).
- Corrigir/cancelar nome: operação no admin que marca item `cancelado`/`substituido` e some da lista ativa; auditoria em `observacoes`.
- Comprovante associado fora do git (já em `data/comprovantes/`).
- Página de portaria em `web/`: busca nome **sem acento/caixa**; botão **já entrou**.

**Arquivos:** `api/schema.sql`, `api/server.mjs`, `web/admin.html` ou `web/portaria.html`, `scripts/exportar-planilha.ps1` (hoje exporta o log errado para a festa).

---

## Módulo E — Otimizações gratuitas (avaliar; **não implementar agora**)

| # | Item | Viabilidade | Esforço | Risco | Arquivos | Conta/domínio/pago |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Pix sem API bancária: pasta OFX/CSV no n8n + centavos únicos; OCR só triagem | Alta para PF (extrato do app). Centavos únicos exigem valor com quebra (ex. 50,01) — precisa aceite do comprador | Médio | Médio: atraso do extrato; mismatch de nome; dois pedidos mesmo valor | `api/schema.sql` (valor cobrado vs face), `api/server.mjs`, `workflows/` (watch folder), pasta `data/extratos/` | Conta banco (já tem). Sem Open Finance. **Sinalizar:** formato OFX/CSV varia por banco |
| 2 | BR Code / Pix copia-e-cola com valor da API | Alta (payload EMV estático/dinâmico **sem** PSP se a chave for CPF/email/aleatória). QR é string; gerar imagem é local | Baixo–médio | Sem CNPJ não há cobrança “Pix automático” da instituição; é só instrução de pagamento. Valor precisa bater com E.1 | `api/server.mjs`, possivelmente `web/` | Nenhum, se chave Pix pessoal já existir |
| 3 | Túnel webhook | **Quick Cloudflare:** já no repo; URL muda a cada restart — Meta quebra. **Named Cloudflare Tunnel:** URL estável, grátis, **exige conta Cloudflare + domínio**. **Hookdeck/Webhook Relay:** conta, plano free com limite de eventos/retenção | Quick: já feito. Named: médio (DNS). Hookdeck: baixo | Quick inaceitável em “produção”. Named é o único estável a custo 0 se houver domínio | `scripts/iniciar-tunel-whatsapp.ps1`, docs | **Named: conta + domínio.** Hookdeck: conta, teto do free. Quick: só conta Cloudflare opcional |
| 4 | HMAC, gitleaks, backup SQLite, `n8n export:workflow --all --separate`, alerta Telegram | HMAC: obrigatório (hoje ausente). gitleaks: binário/pre-commit grátis. Backup: Task Scheduler + cópia `data/*.sqlite`. Export n8n: CLI da instância local. Telegram: bot gratuito | Médio no conjunto | HMAC mal configurado derruba o webhook. Backup sem teste de restore é teatro | `api/whatsapp-gateway.mjs`, `.gitignore`/hooks, `scripts/`, `workflows/` | Telegram: conta + bot. gitleaks: nenhum. Cloudflare HMAC usa App Secret da Meta (conta Meta) |
| 5 | `.cursor/rules/` com regra de negócio | Alta, local, zero custo | Baixo | Baixo | `.cursor/rules/` | Nenhum |

**Recomendação de túnel (quando for a hora):** testes = quick tunnel; operação = **Cloudflare Tunnel nomeado** se (e só se) houver domínio. Sem domínio, não há opção estável realmente zero — Hookdeck free **sinaliza conta + limites**.

**Prioridade sugerida (ainda sem implementar):** 4 HMAC → 5 rules → 2 BR Code → 1 OFX/centavos → 3 túnel nomeado → resto do 4 (gitleaks/backup/export/Telegram).

---

## Módulo F — Custo e regras do WhatsApp

**Não assumir custo zero.** Docs oficiais da Meta (atualização out/2026): service messages passam a ser cobradas **por mensagem entregue** a partir de 01/10/2026, com **1.000 service messages grátis/mês por número**; o 1.001º cobra tarifa de utility/auth do mercado do destinatário; utility **dentro** da janela 24h também passa a cobrar. Webhooks de status usam `pricing.type` (`free_customer_service` vs `regular`) e `category`. Fontes: [pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), [non-template](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages.md). Relatos de imprensa (ex. Índia) divergem em valores locais — por isso **gravar o objeto `pricing`**, não uma tabela hardcoded.

**Hoje:** nenhum envio Cloud API; nenhum `mensagens_custo`; fluxo 04 não trata `statuses[]`.

**Alvo:**

- Persistir `pricing.billable` / `type` / `category` (e id da mensagem) por webhook de status.
- Relatório mensal (contagem service vs free vs template).
- Agrupar respostas do bot; teto de mensagens por conversa.
- Projetar para responder **dentro da janela 24h** do cliente; alerta se a janela estiver acabando; **não** disparar template pago automaticamente.
- Número de teste Cloud API: 5 destinatários. Planejar número real + display name. Sem verificação de empresa: teto **250 contatos únicos / 24h**.

**Arquivos:** `api/schema.sql` (`mensagens_custo`), `api/whatsapp-gateway.mjs` ou workflow n8n de status, `api/server.mjs`, `web/admin.html` (relatório), `docs/`.

---

## Fine-tuning vs prompt/RAG

Começar sem fine-tuning: volume de chats de um evento costuma ser pequeno; anonimização + few-shot + RAG local cobre tom e FAQ; Fine-tune exigiria GPU, pipeline de treino e re-anonimização a cada evento. Só reavaliar se o conjunto de eval (promptfoo) mostrar erro estável de tom/fluxo **depois** de RAG.

---

## Perguntas em aberto

1. **Desconto por quantidade** — existe? Quais faixas?
2. **Formas de pagamento aceitas** — só Pix? Outras?
3. **Prazo de reserva do lote** — o código usa 30 min (`prazo_reserva_minutos`). Qual o prazo real?
4. **Política de reembolso / recusa** — o que falar e o que fazer no estoque/lista?
5. Extra (não confirmado no código): a portaria ainda precisa de **CPF/RG**, ou a lista é **só nome**? Tem **domínio** para túnel Cloudflare nomeado? A máquina de OCR tem **GPU**?

## Primeira tarefa proposta

Higiene — incluir `contexto_n8n.txt` e pastas de conversas/chats no `.gitignore`, e atualizar a seção Estrutura do `README.md` (listar `api/` e `web/`). Sem mudar comportamento da API.

**Concluída:** `contexto_n8n.txt`, `conversas/`, `chats/` e `exports/whatsapp/` no `.gitignore`; seção Estrutura do README lista `api/` e `web/`.
