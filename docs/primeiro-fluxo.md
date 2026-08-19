# Primeiro fluxo de aprendizagem

O fluxo `01 - Simulacao de mensagem do WhatsApp` valida a estrutura basica antes das integracoes externas.

## Etapas

1. `Executar teste`: inicia o fluxo manualmente.
2. `Mensagem simulada`: representa os dados que futuramente chegarao do WhatsApp.
3. `Preparar registro`: organiza os campos no formato de uma linha da planilha e cria uma resposta ficticia.

Todos os valores usados sao ficticios. O fluxo nao possui credenciais, nao envia mensagens e nao grava dados fora do n8n.

## Resultado esperado

O ultimo no deve produzir:

- data e hora da execucao;
- telefone e nome ficticios;
- mensagem recebida;
- origem da informacao;
- status `pronto_para_planilha`;
- texto que futuramente sera devolvido ao usuario.

