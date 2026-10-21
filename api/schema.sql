PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS atendimentos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  data_hora TEXT NOT NULL,
  telefone TEXT NOT NULL,
  nome TEXT NOT NULL,
  mensagem TEXT NOT NULL,
  origem TEXT NOT NULL,
  status TEXT NOT NULL,
  resposta TEXT NOT NULL,
  id_mensagem TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS eventos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nome TEXT NOT NULL,
  descricao TEXT NOT NULL DEFAULT '',
  organizador TEXT NOT NULL DEFAULT '',
  data_evento TEXT NOT NULL,
  horario TEXT NOT NULL DEFAULT '',
  local TEXT NOT NULL,
  endereco TEXT NOT NULL DEFAULT '',
  inicio_vendas TEXT,
  fim_vendas TEXT,
  capacidade_total INTEGER NOT NULL CHECK (capacidade_total >= 0),
  capacidade_maxima_evento INTEGER CHECK (capacidade_maxima_evento IS NULL OR capacidade_maxima_evento >= 0),
  limite_por_comprador INTEGER NOT NULL DEFAULT 5 CHECK (limite_por_comprador > 0),
  max_ingressos_por_pessoa INTEGER DEFAULT 10 CHECK (max_ingressos_por_pessoa IS NULL OR max_ingressos_por_pessoa > 0),
  prazo_reserva_minutos INTEGER NOT NULL DEFAULT 60 CHECK (prazo_reserva_minutos > 0),
  descontos_quantidade_json TEXT NOT NULL DEFAULT '',
  pix_chave TEXT NOT NULL DEFAULT '',
  pix_tipo TEXT NOT NULL DEFAULT '',
  pix_favorecido TEXT NOT NULL DEFAULT '',
  contato_humano TEXT NOT NULL DEFAULT '',
  mensagem_boas_vindas TEXT NOT NULL DEFAULT '',
  orientacoes_entrada TEXT NOT NULL DEFAULT '',
  politica_cancelamento TEXT NOT NULL DEFAULT '',
  texto_privacidade TEXT NOT NULL DEFAULT '',
  documento_obrigatorio INTEGER NOT NULL DEFAULT 1 CHECK (documento_obrigatorio IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (
    status IN ('rascunho', 'vendas_abertas', 'vendas_pausadas', 'encerrado', 'cancelado')
  ),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  nome TEXT NOT NULL,
  valor_centavos INTEGER NOT NULL CHECK (valor_centavos >= 0),
  inicio TEXT,
  fim TEXT,
  quantidade_total INTEGER NOT NULL CHECK (quantidade_total >= 0),
  quantidade_reservada INTEGER NOT NULL DEFAULT 0 CHECK (quantidade_reservada >= 0),
  quantidade_vendida INTEGER NOT NULL DEFAULT 0 CHECK (quantidade_vendida >= 0),
  limite_por_comprador INTEGER CHECK (limite_por_comprador IS NULL OR limite_por_comprador > 0),
  ativo INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  ordem INTEGER NOT NULL DEFAULT 0,
  encerrado_em TEXT,
  status TEXT NOT NULL DEFAULT 'futuro' CHECK (
    status IN ('futuro', 'disponivel', 'encerrado', 'esgotado')
  ),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE (evento_id, nome)
);

CREATE TABLE IF NOT EXISTS pedidos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocolo TEXT NOT NULL UNIQUE,
  evento_id INTEGER NOT NULL REFERENCES eventos(id),
  lote_id INTEGER REFERENCES lotes(id),
  data_contato TEXT NOT NULL,
  origem TEXT NOT NULL DEFAULT '',
  comprador_nome TEXT NOT NULL,
  comprador_telefone TEXT NOT NULL,
  quantidade INTEGER NOT NULL CHECK (quantidade > 0),
  valor_unitario_centavos INTEGER NOT NULL CHECK (valor_unitario_centavos >= 0),
  valor_total_centavos INTEGER NOT NULL CHECK (valor_total_centavos >= 0),
  reserva_expira_em TEXT,
  recebido_apos_expirar INTEGER NOT NULL DEFAULT 0 CHECK (recebido_apos_expirar IN (0, 1)),
  status TEXT NOT NULL CHECK (
    status IN (
      'iniciado', 'aguardando_dados', 'aguardando_confirmacao', 'reserva_criada',
      'aguardando_pagamento', 'pagamento_em_analise', 'pagamento_aprovado',
      'pagamento_recusado', 'concluido', 'expirado', 'cancelado', 'atendimento_humano'
    )
  ),
  status_pagamento TEXT NOT NULL DEFAULT 'pendente' CHECK (
    status_pagamento IN ('pendente', 'em_analise', 'aprovado', 'recusado', 'estornado')
  ),
  comprovante_id TEXT,
  aprovado_em TEXT,
  aprovado_por TEXT,
  observacoes TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS participantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  evento_id INTEGER NOT NULL REFERENCES eventos(id),
  nome_completo TEXT NOT NULL,
  tipo_documento TEXT CHECK (tipo_documento IS NULL OR tipo_documento IN ('CPF', 'RG')),
  numero_documento TEXT,
  status_ingresso TEXT NOT NULL DEFAULT 'pendente' CHECK (
    status_ingresso IN ('pendente', 'valido', 'cancelado', 'utilizado')
  ),
  codigo_ingresso TEXT UNIQUE,
  entrada_em TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos(id) ON DELETE CASCADE,
  telefone TEXT NOT NULL,
  nome_comprador TEXT NOT NULL,
  estado TEXT NOT NULL,
  quantidade INTEGER,
  lote_id INTEGER REFERENCES lotes(id),
  dados_json TEXT NOT NULL DEFAULT '{}',
  pedido_id INTEGER REFERENCES pedidos(id),
  origem TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE (evento_id, telefone)
);

CREATE TABLE IF NOT EXISTS comprovantes (
  id TEXT PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  nome_original TEXT NOT NULL,
  tipo_mime TEXT NOT NULL,
  caminho TEXT NOT NULL,
  tamanho_bytes INTEGER NOT NULL,
  recebido_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_eventos_status ON eventos(status);
CREATE INDEX IF NOT EXISTS idx_lotes_evento_status ON lotes(evento_id, status);
CREATE INDEX IF NOT EXISTS idx_pedidos_evento_status ON pedidos(evento_id, status);
CREATE INDEX IF NOT EXISTS idx_pedidos_telefone ON pedidos(comprador_telefone);
CREATE INDEX IF NOT EXISTS idx_participantes_documento ON participantes(evento_id, tipo_documento, numero_documento);
CREATE INDEX IF NOT EXISTS idx_conversas_evento_telefone ON conversas(evento_id, telefone);
CREATE INDEX IF NOT EXISTS idx_comprovantes_pedido ON comprovantes(pedido_id);

CREATE TABLE IF NOT EXISTS viradas_lote (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  evento_id INTEGER NOT NULL REFERENCES eventos(id),
  lote_anterior_id INTEGER NOT NULL REFERENCES lotes(id),
  lote_novo_id INTEGER REFERENCES lotes(id),
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('virada', 'esgotado')),
  criado_em TEXT NOT NULL,
  enviado_em TEXT,
  erro TEXT,
  anunciada_em TEXT
);

CREATE INDEX IF NOT EXISTS idx_viradas_pendentes ON viradas_lote(anunciada_em, id);

CREATE TABLE IF NOT EXISTS mensagens_entrada (
  wamid TEXT PRIMARY KEY,
  telefone TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  recebida_em TEXT NOT NULL,
  origem TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mensagens_saida (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wamid TEXT NOT NULL REFERENCES mensagens_entrada(wamid),
  texto TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente_envio',
  criada_em TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fila_webhook (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wamid TEXT NOT NULL UNIQUE,
  telefone TEXT NOT NULL,
  nome TEXT NOT NULL DEFAULT '',
  tipo TEXT NOT NULL,
  texto TEXT NOT NULL DEFAULT '',
  timestamp_mensagem TEXT NOT NULL,
  origem TEXT NOT NULL,
  evento_codigo TEXT NOT NULL DEFAULT '',
  corpo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pendente', 'processando', 'entregue', 'falhou')),
  tentativas INTEGER NOT NULL DEFAULT 0,
  proxima_tentativa_em TEXT NOT NULL,
  ultimo_erro TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mensagens_saida_wamid ON mensagens_saida(wamid);
CREATE INDEX IF NOT EXISTS idx_fila_telefone_status ON fila_webhook(telefone, status, id);
