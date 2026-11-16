DESATUALIZADO: historico anterior a Tarefa 4a. Valem docs/OBJETIVO.md e docs/ESTADO_ATUAL.md.

# Arquitetura inicial

## Objetivo

Receber mensagens iniciadas pelo usuario no WhatsApp, conduzir uma coleta estruturada de informacoes e registrar o resultado no Google Sheets.

## Componentes

1. **WhatsApp Cloud API:** recebe e envia as mensagens autorizadas.
2. **Endereco publico temporario:** encaminha os eventos do WhatsApp ao computador durante os testes.
3. **n8n Community:** organiza as perguntas, respostas, validacoes e confirmacao.
4. **Google Sheets:** armazena um registro por atendimento concluido.

## Limites do prototipo gratuito

- O computador precisa estar ligado durante os testes.
- O endereco publico temporario pode mudar ao reiniciar.
- A empresa nao iniciara conversas nem enviara campanhas.
- Nenhuma inteligencia artificial paga sera usada na primeira versao.
- Os dados de teste devem ser ficticios ate a validacao das medidas de privacidade.

## Seguranca

- Tokens e senhas ficam somente no arquivo local `.env` ou no gerenciador de credenciais do n8n.
- O n8n fica acessivel apenas no proprio computador; o webhook sera exposto separadamente quando necessario.
- O repositorio remoto devera ser privado.
- Nenhuma planilha com dados pessoais sera armazenada no repositorio.

