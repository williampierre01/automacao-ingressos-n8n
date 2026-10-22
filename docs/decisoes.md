DESATUALIZADO: historico anterior a Tarefa 4a. Valem docs/OBJETIVO.md e docs/ESTADO_ATUAL.md.

# Registro de decisoes

## 2026-08-17 - Ferramentas gratuitas

- n8n Community executado localmente com Node.js.
- WhatsApp Cloud API oficial.
- Google Sheets como destino dos registros.
- Conversas iniciadas pelo usuario e atendidas dentro da janela de servico.
- Fluxo baseado em perguntas e regras, sem API de inteligencia artificial.

## 2026-08-17 - Execucao local

- Node.js escolhido como caminho principal por ja estar instalado e funcional.
- Node.js 22.22.3 mantido de forma portatil em `work/`, sem alterar a instalacao global.
- n8n fixado na versao 2.34.6 para garantir repetibilidade.
- Docker mantido como alternativa futura.
- Dados internos do n8n e cache de instalacao armazenados em `work/`, fora do Git.

## 2026-08-17 - Controle de versao

- Git para manter o historico local.
- GitHub privado quando o projeto for publicado.
- Exportacao manual dos fluxos do n8n Community.
- Segredos, credenciais e dados reais excluidos do repositorio.
