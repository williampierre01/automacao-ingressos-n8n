# API local de atendimentos

A API recebe os dados enviados pelo n8n e grava tudo no banco local SQLite em `data/atendimentos.sqlite`.

## Autenticacao

A API so inicia com `ADMIN_TOKEN` e `API_INTERNAL_TOKEN`, cada um com pelo menos 24 caracteres. Rotas `/admin/*`, `GET /atendimentos` e `GET /exportar` exigem `Authorization: Bearer` do admin. `POST /interno/mensagem` exige o token interno, tambem em `Authorization: Bearer`.

`GET /saude`, o catalogo de eventos, `POST /comprovantes` e `POST /atendimentos` nao usam o token do admin. `GET /`, `GET /simulador` e `POST /simular-mensagem` so existem com `SIMULADOR_ATIVO=1`; sem a flag respondem 404.

`POST /simular-mensagem` monta a mensagem normalizada, envia `Authorization: Bearer` do token interno ao webhook do fluxo 04 e espera no maximo 30 segundos. Sem resposta nesse prazo, devolve 504. A venda roda em `POST /interno/mensagem`. O gateway grava o evento na fila e responde 200; o worker entrega ao mesmo webhook com o mesmo Bearer. Imagem e documento recebem um texto provisorio. Reacao registra o `wamid` e nao gera saida. Evento sem vendas abertas responde texto. A resposta, quando existe, fica em `mensagens_saida` com status `pendente_envio`.

## Enderecos

- `GET /saude`: verifica se a API esta funcionando.
- `POST /interno/mensagem`: recebe a mensagem ja normalizada, executa a venda e grava a saida como `pendente_envio`. Exige o token interno.
- `GET /admin/whatsapp/fila`: lista entregas que falharam e devolve a contagem de pendentes, a de processando e a idade em segundos do pendente mais antigo.
- `POST /admin/whatsapp/fila/:id/reenfileirar`: devolve o item a fila, se o corpo ainda existir. Se ja houver mensagem mais nova do mesmo telefone entregue, responde aviso e so reenfileira com `?confirmar=1`.
- `POST /atendimentos`: grava um atendimento.
- `GET /atendimentos`: lista os registros mais recentes.
- `GET /exportar`: baixa todos os registros em CSV compativel com Excel.
- `GET /eventos`: lista os eventos configurados.
- `GET /eventos/:codigo`: mostra um evento, seus lotes e o lote atual.
- `GET /eventos/:codigo/lote-atual`: consulta o lote vigente. Datas do lote não entram na escolha.
- `POST /comprovantes`: recebe JPG, PNG ou PDF de ate 5 MB. Pedido expirado também entra em análise, marcado como recebido após expirar.
- `GET /admin/pedidos`: lista pagamentos para analise local.
- `POST /admin/pedidos/:id/pagamento`: aprova ou recusa um pagamento. A aprovação soma a quantidade vendida e pode virar o lote.
- `GET /admin/viradas`: lista viradas e esgotamentos ainda não anunciados.
- `POST /admin/viradas/:id/anunciada`: tira o alerta do admin.
- `POST /admin/reservas/expirar`: marca como expirada a reserva que ainda espera comprovante e já passou do prazo.
- `GET /admin/eventos/:codigo/participantes-confirmados`: lista somente ingressos liberados para entrada.
- `GET /admin/eventos/:codigo/exportar-participantes.csv`: baixa a lista do evento para abrir no Excel.
- `GET /admin/eventos/:codigo/check-in?busca=`: localiza um ingresso aprovado pelo documento ou protocolo.
- `POST /admin/eventos/:codigo/check-in`: confirma a entrada de um participante uma unica vez.

## Campos enviados

`telefone`, `nome` e `mensagem` sao obrigatorios. Os demais campos sao opcionais: `data_hora`, `origem`, `status`, `resposta` e `id_mensagem`.

## Inicializacao

Em um terminal separado do n8n:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\iniciar-api.ps1
```

Para criar a planilha local:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\exportar-planilha.ps1
```

O arquivo resultante fica em `planilha/dados/atendimentos.csv` e pode ser aberto no Excel.

## Modelo generico de ingressos

O banco tambem possui as tabelas `eventos`, `lotes`, `pedidos`, `participantes` e `viradas_lote`. Ao iniciar uma base vazia, a API cria um evento de demonstracao com tres lotes (20, 30 e 50 ingressos; R$ 30, R$ 40 e R$ 50) e prazo de reserva de 60 minutos. A virada usa a quantidade vendida, não a data. A reserva congela o preço e não consome o saldo do lote. Chaves Pix nunca sao retornadas pelas rotas publicas de consulta.

Os comprovantes ficam em `data/comprovantes/`, fora do GitHub. O envio altera o pagamento para `em_analise`; a aprovacao ou recusa deve ser feita manualmente em `http://127.0.0.1:8000/admin`. Se `N8N_VIRADA_LOTE_WEBHOOK_URL` estiver preenchida, a aprovação avisa essa URL depois de gravar a virada. Falha nesse envio não desfaz o pagamento.

No painel, cada evento possui uma exportacao propria. O alerta de virada permanece até o botão **Marcar como anunciada**. Documentos e telefones sao mantidos como texto para preservar zeros a esquerda. Como a lista contem dados pessoais, o arquivo exportado nao deve ser publicado no GitHub.
