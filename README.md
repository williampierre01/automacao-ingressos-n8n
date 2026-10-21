# Atendimento pelo WhatsApp com n8n

Projeto de aprendizagem para criar uma automacao gratuita que recebe uma conversa pelo WhatsApp, coleta informacoes e registra os dados em uma planilha.

## Situacao atual

- [x] Estrutura segura do projeto
- [x] Configuracao local do n8n com Node.js
- [x] Definicao inicial dos campos da conversa
- [x] Criacao e validacao do modelo da planilha
- [x] Primeiro fluxo de simulacao no n8n
- [x] API local com banco SQLite
- [x] Exportacao local compativel com Excel
- [ ] Integracao com o WhatsApp Cloud API
- [ ] Testes completos

## Caminho da automacao

```text
Usuario inicia a conversa no WhatsApp
                 |
                 v
         WhatsApp Cloud API
                 |
                 v
                n8n
        pergunta, valida e confirma
                 |
                 v
       API local + SQLite
                 |
                 v
        Planilha para Excel
```

Para manter o prototipo sem custos, o usuario inicia a conversa e o atendimento acontece dentro da janela gratuita de atendimento do WhatsApp. O n8n roda localmente no computador.

## Estrutura

```text
.
|-- compose.yaml          Alternativa de execucao com Docker
|-- .env.example          Modelo de configuracao sem segredos
|-- api/                  API Node + SQLite e gateway WhatsApp
|-- web/                  admin.html e simulador.html
|-- scripts/              Inicializacao local (n8n, API, tunel)
|-- docs/                 Arquitetura, estado atual e plano
|-- planilha/             Definicao das colunas e exportacoes locais
`-- workflows/            Fluxos exportados do n8n
```

## Como executar

Pre-requisito: Node.js instalado. O projeto usa uma copia portatil e isolada do Node.js 22.22.3 em `work/`, sem alterar a versao global do computador. A versao do n8n foi fixada em 2.34.6.

1. Na primeira utilizacao, execute `powershell -ExecutionPolicy Bypass -File .\scripts\preparar-ambiente.ps1`.
2. Confirme que o arquivo privado `.env` existe.
3. Execute `powershell -ExecutionPolicy Bypass -File .\scripts\iniciar-n8n.ps1`.
4. Aguarde a mensagem de inicializacao.
5. Abra `http://localhost:5678` no navegador.

Depois que o ambiente ja estiver preparado, os dois servicos podem ser iniciados juntos com:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\iniciar-projeto.ps1
```

O script abre uma janela para o n8n e outra para a API. As janelas devem permanecer abertas durante o uso.

O arquivo `.env`, as credenciais, o banco SQLite e os dados recebidos nunca devem ser enviados ao GitHub.

O fluxo 04 nao le segredo do ambiente. O gateway e o simulador enviam `Authorization: Bearer` ao webhook, e o no HTTP repassa esse cabecalho para a API. `scripts/iniciar-n8n.ps1` sobe o n8n so em `127.0.0.1` e nao coloca `API_INTERNAL_TOKEN` no processo. O fluxo pede para nao gravar execucao bem-sucedida nem execucao com erro (`saveDataSuccessExecution=none`, `saveDataErrorExecution=none`). O n8n 2.34.6 ainda cria a linha de sucesso e o corpo e so marca `deletedAt`; o script apaga essa linha ao subir, para o cabecalho e a mensagem nao permanecerem. Nao foi possivel provocar uma execucao com status de erro neste fluxo: falha da API cai no ramo tratado do no HTTP, e JSON invalido ou gzip falham antes de existir linha. Por isso nao ficou provado se uma execucao com erro seria apagada na hora. `EXECUTIONS_DATA_PRUNE=true` e `EXECUTIONS_DATA_MAX_AGE=72` continuam como rede de seguranca.

Para importar e publicar o fluxo 04 sem a interface:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\publicar-fluxo-04.ps1
```

O comando usa `n8n import:workflow --input=workflows/04-webhook-whatsapp-simulado.json` e `n8n publish:workflow --id=webhookWhatsapp0001`. Se a porta 5678 estiver em uso, o script aborta. Feche o n8n, publique e abra de novo.

## HTTPS na rede local

O projeto pode manter o HTTP interno em `127.0.0.1:8000` para o n8n e abrir, ao mesmo tempo, HTTPS na porta `8443` para celulares da mesma rede. A configuracao usa o mkcert somente para desenvolvimento local.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\configurar-https-local.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\iniciar-api-https.ps1
```

Os certificados ficam em `work/https/`, fora do GitHub. Para o celular confiar no HTTPS, instale apenas `work/https/rootCA.crt` como certificado de autoridade. Nunca copie ou compartilhe `rootCA-key.pem`.

## API local e planilha

Abra um segundo terminal e execute:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\iniciar-api.ps1
```

A API fica em `http://127.0.0.1:8000`. O fluxo `02 - Salvar atendimento na API local` envia os dados para ela sem usar credenciais externas.

Para gerar o arquivo que abre no Excel:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\exportar-planilha.ps1
```

O resultado fica em `planilha/dados/atendimentos.csv`.

## Formulario para testes variaveis

O fluxo `03 - Formulario local de atendimento` permite informar nome, telefone e mensagem sem editar os nos. No n8n, abra esse fluxo, execute o no `Receber formulario` e preencha o formulario de teste que sera aberto.

## Simulador de conversa

Com `SIMULADOR_ATIVO=1`, a API e o n8n ativos, abra `http://127.0.0.1:8000/simulador`. A tela envia nome, telefone e mensagem ao webhook do fluxo 04. O fluxo chama `POST /interno/mensagem`, que conduz a venda. Assim o simulador e o WhatsApp usam o mesmo caminho.

## Administracao de eventos

Abra `http://127.0.0.1:8000/admin` para cadastrar eventos e lotes. A tela e exclusivamente local e permite configurar varios eventos sem editar o fluxo do n8n.

A mesma tela mostra pagamentos em analise e o alerta de virada de lote. O administrador pode abrir o comprovante e aprovar ou recusar. A aprovacao soma a quantidade vendida do lote e pode encerrar o lote vigente. A reserva em si nao consome esse saldo.

Cada evento tambem possui os botoes **Ver confirmados** e **Exportar para Excel**. A lista inclui somente participantes de pedidos com pagamento aprovado e pode ser usada na conferencia da entrada.

Na secao **Check-in na entrada**, procure o participante pelo CPF, RG ou protocolo. Depois de conferir os dados, clique em **Confirmar entrada**. O ingresso passa para `utilizado` e uma segunda tentativa exibe o alerta de entrada ja registrada.

## Webhook para mensagens externas

O fluxo `04 - Webhook de WhatsApp simulado` prepara a entrada que futuramente sera usada pelo WhatsApp. Depois de publicar o fluxo no n8n, teste com:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testar-webhook.ps1
```

Mais detalhes estao em `docs/webhook-local.md`.

## Gateway publico de testes

Para a futura verificacao da Meta, o projeto possui um gateway isolado na porta 8001. Ele expoe somente `/whatsapp-webhook`, valida o token de configuracao e encaminha mensagens ao fluxo 04. O token privado fica em `work/whatsapp/verify-token.txt` e nao deve ser enviado ao GitHub.

### Alternativa com Docker

O arquivo `compose.yaml` permanece disponivel caso o Docker Desktop seja configurado futuramente. Ele nao e necessario para continuar o prototipo.

## Exportacao dos fluxos

Na edicao Community, cada fluxo concluido sera exportado manualmente do n8n em formato JSON e salvo em `workflows/`. Antes de qualquer envio ao GitHub, o arquivo exportado deve ser revisado para confirmar que nao contem tokens, telefones ou dados pessoais.

## Proxima decisao

Publicar e testar o fluxo `workflows/04-webhook-whatsapp-simulado.json`. Depois, disponibilizar o webhook por HTTPS e configurar a entrada real do WhatsApp.
