# Objetivo

## Alvo

Venda de uma festa pelo WhatsApp. A entrada é o nome na lista, depois do comprovante aprovado. Não há ingresso físico nem digital. Sem CNPJ/MEI. A divulgação é só orgânica. Disparo em massa fica fora de escopo. Custo mínimo. Só Pix.

## Regras vigentes

- Os lotes valem por quantidade e por ordem.
- O pedido inteiro fica no preço do lote vigente na reserva. O excedente permanece nesse lote.
- A virada só ocorre na aprovação. É irreversível. Gera `viradas_lote`, alerta no admin e webhook opcional.
- O último lote encerrado deixa o evento esgotado.
- `capacidade_maxima_evento` é um teto opcional.
- A cotação não reserva. A reserva nasce ao enviar os nomes, com o preço congelado, por 60 minutos configuráveis, e só enquanto o pedido aguarda comprovante.
- Comprovante tardio vai para análise com a marca "recebido após expirar".
- Se o preço mudou entre a cotação e os nomes, o bot pede CONFIRMAR.
- O máximo é 10 ingressos por telefone (só dígitos). `NULL` não limita.
- Desconto por quantidade é `descontos_quantidade_json`, vazio por padrão.
- CPF e RG não são pedidos. A portaria por nome é o alvo (Tarefa 5). O check-in existente busca CPF, RG ou protocolo.
- Comprovante recusado, regra decidida: pode reenviar com o motivo; o reembolso manual fica fora do sistema. Ainda não implementado.

## Arquitetura

A máquina de estados da venda vive na API e o n8n só encaminha; o detalhe está em `docs/ESTADO_ATUAL.md`.

## Ainda não existe

- App e número na Meta.
- Portaria por nome.
- OCR.
- LLM.
- Relatório mensal de custo.
- Reenvio de comprovante recusado.
- Política de LGPD das mensagens.

## Próximas tarefas

1. Integração real com a Meta, incluindo tratar token inválido ou expirado pausando o envio.
2. OCR local com antifraude e conciliação por extrato.
3. Portaria por nome.
4. IA de atendimento com RAG de conversas anonimizadas.
5. Túnel estável.
6. Alertas por Telegram.
