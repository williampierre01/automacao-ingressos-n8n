# Webhook local para mensagens externas

O fluxo `04 - Webhook de WhatsApp simulado` recebe uma requisicao HTTP, interpreta os dados, envia o registro para a API local e devolve uma confirmacao.

## Endereco de producao local

```text
POST http://localhost:5678/webhook/whatsapp-mensagens
```

O endereco funciona quando o fluxo esta publicado e o n8n esta aberto.

## Teste

Com o n8n e a API ativos, execute na pasta principal do projeto:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\testar-webhook.ps1
```

O resultado esperado informa `recebido: true` e `salvo: true`. A API deve registrar uma requisicao `POST /atendimentos -> 201`.

## Papel no projeto

O webhook simulado usa um JSON simples com `nome`, `telefone` e `mensagem`. O no `Interpretar mensagem` tambem reconhece a estrutura principal de mensagens de texto da WhatsApp Cloud API. A conexao real ainda exigira uma URL HTTPS publica e a configuracao do aplicativo na Meta.
