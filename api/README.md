# API local de atendimentos

A API recebe os dados enviados pelo n8n e grava tudo no banco local SQLite em `data/atendimentos.sqlite`.

## Autenticacao

A API so inicia com `ADMIN_TOKEN` de pelo menos 24 caracteres. Rotas `/admin/*`, `GET /atendimentos` e `GET /exportar` exigem `Authorization: Bearer`. A pagina `GET /admin` pede esse token e o guarda apenas em `sessionStorage`.

`GET /saude`, o catalogo de eventos, `POST /comprovantes` e `POST /atendimentos` nao usam esse token. `GET /`, `GET /simulador` e `POST /simular-mensagem` so existem com `SIMULADOR_ATIVO=1`; sem a flag respondem 404.

## Enderecos

- `GET /saude`: verifica se a API esta funcionando.
- `POST /atendimentos`: grava um atendimento.
- `GET /atendimentos`: lista os registros mais recentes.
- `GET /exportar`: baixa todos os registros em CSV compativel com Excel.
- `GET /eventos`: lista os eventos configurados.
- `GET /eventos/:codigo`: mostra um evento, seus lotes e o lote atual.
- `GET /eventos/:codigo/lote-atual`: consulta o lote disponivel para venda.
- `POST /comprovantes`: recebe JPG, PNG ou PDF de ate 5 MB para um pedido.
- `GET /admin/pedidos`: lista pagamentos para analise local.
- `POST /admin/pedidos/:id/pagamento`: aprova ou recusa um pagamento.
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

O banco tambem possui as tabelas `eventos`, `lotes`, `pedidos` e `participantes`. Ao iniciar uma base vazia, a API cria um evento de demonstracao com dois lotes para permitir os primeiros testes. Chaves Pix nunca sao retornadas pelas rotas publicas de consulta.

Os comprovantes ficam em `data/comprovantes/`, fora do GitHub. O envio apenas altera o pagamento para `em_analise`; a aprovacao ou recusa deve ser feita manualmente em `http://127.0.0.1:8000/admin`.

No painel, cada evento possui uma exportacao propria. Documentos e telefones sao mantidos como texto para preservar zeros a esquerda. Como a lista contem dados pessoais, o arquivo exportado nao deve ser publicado no GitHub.
