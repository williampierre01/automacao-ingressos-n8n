import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { processarMensagem } from './conversa.mjs';
import {
  MARCA_COMPROVANTE_TARDIO,
  MENSAGEM_ESGOTADO,
  MENSAGEM_PAUSADA,
  aprovarPagamento,
  cancelarPedidoPendente,
  digitosTelefone,
  expirarReservas,
  garantirEventoDemonstracao,
  listarViradasPendentes,
  marcarAnunciada,
  migrar,
  payloadVirada,
  recusarPagamento,
  registrarComprovante,
  reservar,
  totalCentavos,
} from './lotes.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const adminToken = 'abcdefghijklmnopqrstuvwx';

const schemaLegado = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE eventos (
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
  limite_por_comprador INTEGER NOT NULL DEFAULT 5 CHECK (limite_por_comprador > 0),
  prazo_reserva_minutos INTEGER NOT NULL DEFAULT 30 CHECK (prazo_reserva_minutos > 0),
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
CREATE TABLE lotes (
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
  status TEXT NOT NULL DEFAULT 'futuro' CHECK (
    status IN ('futuro', 'disponivel', 'encerrado', 'esgotado')
  ),
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  UNIQUE (evento_id, nome)
);
CREATE TABLE pedidos (
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
CREATE TABLE participantes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  evento_id INTEGER NOT NULL REFERENCES eventos(id),
  nome_completo TEXT NOT NULL,
  tipo_documento TEXT NOT NULL CHECK (tipo_documento IN ('CPF', 'RG')),
  numero_documento TEXT NOT NULL,
  status_ingresso TEXT NOT NULL DEFAULT 'pendente' CHECK (
    status_ingresso IN ('pendente', 'valido', 'cancelado', 'utilizado')
  ),
  codigo_ingresso TEXT UNIQUE,
  entrada_em TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
CREATE TABLE conversas (
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
CREATE TABLE comprovantes (
  id TEXT PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  nome_original TEXT NOT NULL,
  tipo_mime TEXT NOT NULL,
  caminho TEXT NOT NULL,
  tamanho_bytes INTEGER NOT NULL,
  recebido_em TEXT NOT NULL
);
`;

async function temporario() {
  return mkdtemp(join(tmpdir(), 'lotes-'));
}

function abrirNovo(diretorio, nome = 'teste.sqlite') {
  const caminho = join(diretorio, nome);
  const database = new DatabaseSync(caminho);
  database.exec(schema);
  migrar(database, { databasePath: caminho });
  return { database, caminho };
}

function agoraIso() {
  return new Date().toISOString();
}

function criarEvento(database, extras = {}) {
  const agora = agoraIso();
  const evento = database.prepare(`
    INSERT INTO eventos (
      codigo, nome, data_evento, local, capacidade_total, limite_por_comprador,
      max_ingressos_por_pessoa, prazo_reserva_minutos, capacidade_maxima_evento,
      descontos_quantidade_json, pix_chave, pix_tipo, pix_favorecido,
      documento_obrigatorio, status, criado_em, atualizado_em
    ) VALUES (?, 'Festa', '2026-12-31', 'Local', 300, 10, ?, 60, ?, ?, 'pix-teste', 'demonstracao', 'Favorecido', 0, 'vendas_abertas', ?, ?)
  `).run(
    extras.codigo || `festa-${randomUUID().slice(0, 8)}`,
    extras.max === undefined ? 10 : extras.max,
    extras.teto === undefined ? null : extras.teto,
    extras.descontos || '',
    agora,
    agora,
  );
  const eventoId = Number(evento.lastInsertRowid);
  const inserir = database.prepare(`
    INSERT INTO lotes (
      evento_id, nome, valor_centavos, quantidade_total, ativo, ordem, status, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const definicoes = extras.lotes || [
    { nome: 'Lote 1', valor: 1000, quantidade: 20, ordem: 1, status: 'disponivel' },
    { nome: 'Lote 2', valor: 2000, quantidade: 30, ordem: 2, status: 'futuro' },
  ];
  const loteIds = definicoes.map((lote) => Number(inserir.run(
    eventoId, lote.nome, lote.valor, lote.quantidade, lote.ativo ?? 1, lote.ordem, lote.status, agora, agora,
  ).lastInsertRowid));
  return {
    eventoId,
    loteIds,
    evento: database.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId),
  };
}

function inserirPedido(database, campos) {
  const agora = agoraIso();
  return Number(database.prepare(`
    INSERT INTO pedidos (
      protocolo, evento_id, lote_id, data_contato, origem, comprador_nome, comprador_telefone,
      quantidade, valor_unitario_centavos, valor_total_centavos, reserva_expira_em,
      status, status_pagamento, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, 'teste', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `P-${randomUUID()}`,
    campos.eventoId,
    campos.loteId,
    agora,
    campos.nome || 'Ana Compradora',
    digitosTelefone(campos.telefone),
    campos.quantidade,
    campos.valor,
    campos.total ?? campos.valor * campos.quantidade,
    campos.expira ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    campos.status,
    campos.pagamento,
    agora,
    agora,
  ).lastInsertRowid);
}

function contar(database, tabela) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n);
}

function lote(database, id) {
  return database.prepare('SELECT * FROM lotes WHERE id = ?').get(id);
}

function pedido(database, id) {
  return database.prepare('SELECT * FROM pedidos WHERE id = ?').get(id);
}

function falar(database, evento, telefone, mensagem, nome = 'Ana Compradora') {
  return processarMensagem(database, {
    evento,
    payload: { telefone, nome, mensagem, origem: 'teste' },
  });
}

function executarNoWorker(dados) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./lotes.mjs', import.meta.url), { workerData: dados });
    const timer = setTimeout(() => {
      worker.terminate().finally(() => reject(new Error('O worker excedeu o tempo.')));
    }, 8000);
    const encerrar = (concluir) => {
      clearTimeout(timer);
      worker.terminate().then(concluir, concluir);
    };
    worker.once('message', (message) => encerrar(() => resolve(message)));
    worker.once('error', (error) => encerrar(() => reject(error)));
  });
}

test('total arredonda meio centavo para cima e desconto zero permanece exato', () => {
  assert.equal(totalCentavos(3333, 1, 10), 3000);
  assert.equal(totalCentavos(3334, 1, 10), 3001);
  assert.equal(totalCentavos(1, 1, 50), 1);
  assert.equal(totalCentavos(1, 1, 51), 0);
  assert.equal(totalCentavos(3333, 2, 0), 6666);
});

test('seed vazio cria tres lotes por quantidade e prazo de 60 minutos', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    garantirEventoDemonstracao(database);
    garantirEventoDemonstracao(database);
    const evento = database.prepare(`SELECT * FROM eventos WHERE codigo = 'evento-demonstracao'`).get();
    const lotes = database.prepare(`SELECT * FROM lotes WHERE evento_id = ? ORDER BY ordem`).all(evento.id);
    assert.equal(evento.prazo_reserva_minutos, 60);
    assert.equal(lotes.length, 3);
    assert.deepEqual(lotes.map((item) => item.quantidade_total), [20, 30, 50]);
    assert.deepEqual(lotes.map((item) => item.valor_centavos), [3000, 4000, 5000]);
    assert.equal(lotes[0].inicio, null);
    assert.equal(lotes[0].status, 'disponivel');
    assert.equal(lotes[1].status, 'futuro');
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('migracao de banco populado preserva linhas, aceita documento vazio e e idempotente', async () => {
  const diretorio = await temporario();
  try {
    const caminho = join(diretorio, 'legado.sqlite');
    const database = new DatabaseSync(caminho);
    database.exec(schemaLegado);
    const agora = agoraIso();
    const evento = database.prepare(`
      INSERT INTO eventos (codigo, nome, data_evento, local, capacidade_total, status, criado_em, atualizado_em)
      VALUES ('festa', 'Festa', '2026-12-31', 'Local', 100, 'vendas_abertas', ?, ?)
    `).run(agora, agora);
    const loteId = Number(database.prepare(`
      INSERT INTO lotes (evento_id, nome, valor_centavos, quantidade_total, status, criado_em, atualizado_em)
      VALUES (?, 'Primeiro', 1000, 20, 'disponivel', ?, ?)
    `).run(Number(evento.lastInsertRowid), agora, agora).lastInsertRowid);
    const pedidoId = Number(database.prepare(`
      INSERT INTO pedidos (
        protocolo, evento_id, lote_id, data_contato, comprador_nome, comprador_telefone,
        quantidade, valor_unitario_centavos, valor_total_centavos, status, status_pagamento, criado_em, atualizado_em
      ) VALUES ('ING-1', ?, ?, ?, 'Ana', '(11) 98888-7777', 2, 1000, 2000, 'concluido', 'aprovado', ?, ?)
    `).run(Number(evento.lastInsertRowid), loteId, agora, agora, agora).lastInsertRowid);
    database.prepare(`
      INSERT INTO participantes (
        pedido_id, evento_id, nome_completo, tipo_documento, numero_documento, status_ingresso,
        codigo_ingresso, entrada_em, criado_em, atualizado_em
      ) VALUES (?, ?, 'Ana Silva', 'CPF', '12345678901', 'utilizado', 'ING-A', ?, ?, ?)
    `).run(pedidoId, Number(evento.lastInsertRowid), '2026-10-01T22:00:00.000Z', agora, agora);
    database.prepare(`
      INSERT INTO participantes (
        pedido_id, evento_id, nome_completo, tipo_documento, numero_documento, status_ingresso, criado_em, atualizado_em
      ) VALUES (?, ?, 'Bia Souza', 'RG', '1234567', 'valido', ?, ?)
    `).run(pedidoId, Number(evento.lastInsertRowid), agora, agora);
    database.prepare(`
      INSERT INTO comprovantes (id, pedido_id, nome_original, tipo_mime, caminho, tamanho_bytes, recebido_em)
      VALUES ('comp-1', ?, 'pix.png', 'image/png', 'C:/tmp/pix.png', 120, ?)
    `).run(pedidoId, agora);
    database.prepare(`
      INSERT INTO conversas (evento_id, telefone, nome_comprador, estado, criado_em, atualizado_em)
      VALUES (?, '(11) 98888-7777', 'Ana', 'concluido', ?, ?)
    `).run(Number(evento.lastInsertRowid), agora, agora);

    const primeira = migrar(database, { databasePath: caminho });
    const segunda = migrar(database, { databasePath: caminho });
    assert.equal(primeira.migrado, true);
    assert.equal(segunda.migrado, false);
    assert.equal(segunda.backup, null);
    const backups = (await readdir(diretorio)).filter((nome) => nome.startsWith('backup-pre-migracao-'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(diretorio, backups[0]));
    assert.equal(Number(backup.prepare('SELECT COUNT(*) AS n FROM participantes').get().n), 2);
    backup.close();

    assert.equal(contar(database, 'participantes'), 2);
    assert.equal(contar(database, 'pedidos'), 1);
    assert.equal(contar(database, 'comprovantes'), 1);
    const entrou = database.prepare(`SELECT * FROM participantes WHERE codigo_ingresso = 'ING-A'`).get();
    assert.equal(entrou.status_ingresso, 'utilizado');
    assert.equal(entrou.entrada_em, '2026-10-01T22:00:00.000Z');
    assert.equal(entrou.numero_documento, '12345678901');
    assert.equal(database.prepare(`SELECT comprador_telefone FROM pedidos WHERE id = ?`).get(pedidoId).comprador_telefone, '11988887777');
    assert.equal(database.prepare('SELECT telefone FROM conversas').get().telefone, '11988887777');
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 1);
    database.prepare(`
      INSERT INTO participantes (pedido_id, evento_id, nome_completo, status_ingresso, criado_em, atualizado_em)
      VALUES (?, ?, 'Sem documento', 'pendente', ?, ?)
    `).run(pedidoId, Number(evento.lastInsertRowid), agora, agora);
    assert.throws(() => database.prepare(`
      INSERT INTO participantes (pedido_id, evento_id, nome_completo, status_ingresso, criado_em, atualizado_em)
      VALUES (999999, ?, 'Orfao', 'pendente', ?, ?)
    `).run(Number(evento.lastInsertRowid), agora, agora));
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('migracao aborta quando a copia de participantes diverge', async () => {
  const diretorio = await temporario();
  try {
    const caminho = join(diretorio, 'legado.sqlite');
    const database = new DatabaseSync(caminho);
    database.exec(schemaLegado);
    const agora = agoraIso();
    const evento = database.prepare(`
      INSERT INTO eventos (codigo, nome, data_evento, local, capacidade_total, status, criado_em, atualizado_em)
      VALUES ('festa', 'Festa', '2026-12-31', 'Local', 10, 'vendas_abertas', ?, ?)
    `).run(agora, agora);
    const pedidoId = Number(database.prepare(`
      INSERT INTO pedidos (
        protocolo, evento_id, data_contato, comprador_nome, comprador_telefone, quantidade,
        valor_unitario_centavos, valor_total_centavos, status, status_pagamento, criado_em, atualizado_em
      ) VALUES ('ING-1', ?, ?, 'Ana', '11999999999', 2, 1000, 2000, 'concluido', 'aprovado', ?, ?)
    `).run(Number(evento.lastInsertRowid), agora, agora, agora).lastInsertRowid);
    const inserir = database.prepare(`
      INSERT INTO participantes (
        pedido_id, evento_id, nome_completo, tipo_documento, numero_documento, criado_em, atualizado_em
      ) VALUES (?, ?, ?, 'CPF', ?, ?, ?)
    `);
    inserir.run(pedidoId, Number(evento.lastInsertRowid), 'Ana', '11111111111', agora, agora);
    inserir.run(pedidoId, Number(evento.lastInsertRowid), 'Bia', '22222222222', agora, agora);
    assert.throws(
      () => migrar(database, { databasePath: caminho, falharCopia: true }),
      /Migracao abortada: a tabela participantes tinha 2 linhas e a copia ficou com 1/,
    );
    assert.equal(contar(database, 'participantes'), 2);
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 0);
    const sql = database.prepare(`SELECT sql FROM sqlite_master WHERE name = 'participantes'`).get().sql;
    assert.match(sql, /tipo_documento TEXT NOT NULL/);
    assert.equal(Number(database.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('migracao da versao 0 grava backup mesmo sem recriar participantes', async () => {
  const diretorio = await temporario();
  try {
    const caminho = join(diretorio, 'novo.sqlite');
    const database = new DatabaseSync(caminho);
    database.exec(schema);
    const resultado = migrar(database, { databasePath: caminho });
    assert.equal(resultado.migrado, true);
    assert.ok(resultado.backup);
    const backups = (await readdir(diretorio)).filter((nome) => nome.startsWith('backup-pre-migracao-'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(diretorio, backups[0]));
    assert.equal(Number(backup.prepare('PRAGMA user_version').get().user_version), 0);
    const sql = backup.prepare(`SELECT sql FROM sqlite_master WHERE name = 'participantes'`).get().sql;
    assert.doesNotMatch(sql, /tipo_documento TEXT NOT NULL/i);
    backup.close();
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 1);
    assert.equal(migrar(database, { databasePath: caminho }).backup, null);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('migracao aborta quando participantes tem coluna extra e mantem o backup', async () => {
  const diretorio = await temporario();
  try {
    const caminho = join(diretorio, 'legado.sqlite');
    const database = new DatabaseSync(caminho);
    database.exec(schemaLegado);
    database.exec('ALTER TABLE participantes ADD COLUMN apelido TEXT');
    const agora = agoraIso();
    const eventoId = Number(database.prepare(`
      INSERT INTO eventos (codigo, nome, data_evento, local, capacidade_total, status, criado_em, atualizado_em)
      VALUES ('festa', 'Festa', '2026-12-31', 'Local', 10, 'vendas_abertas', ?, ?)
    `).run(agora, agora).lastInsertRowid);
    const pedidoId = Number(database.prepare(`
      INSERT INTO pedidos (
        protocolo, evento_id, data_contato, comprador_nome, comprador_telefone, quantidade,
        valor_unitario_centavos, valor_total_centavos, status, status_pagamento, criado_em, atualizado_em
      ) VALUES ('ING-1', ?, ?, 'Ana', '11999999999', 1, 1000, 1000, 'concluido', 'aprovado', ?, ?)
    `).run(eventoId, agora, agora, agora).lastInsertRowid);
    database.prepare(`
      INSERT INTO participantes (
        pedido_id, evento_id, nome_completo, tipo_documento, numero_documento, apelido, criado_em, atualizado_em
      ) VALUES (?, ?, 'Ana', 'CPF', '11111111111', 'Aninha', ?, ?)
    `).run(pedidoId, eventoId, agora, agora);
    assert.throws(
      () => migrar(database, { databasePath: caminho }),
      /Migracao abortada: a tabela participantes tem coluna extra: apelido/,
    );
    assert.equal(Number(database.prepare('PRAGMA user_version').get().user_version), 0);
    assert.equal(contar(database, 'participantes'), 1);
    assert.equal(database.prepare(`SELECT apelido FROM participantes`).get().apelido, 'Aninha');
    assert.equal(database.prepare(`SELECT name FROM sqlite_master WHERE name = 'participantes_nova'`).get(), undefined);
    const backups = (await readdir(diretorio)).filter((nome) => nome.startsWith('backup-pre-migracao-'));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(diretorio, backups[0]));
    assert.equal(backup.prepare('SELECT apelido FROM participantes').get().apelido, 'Aninha');
    backup.close();
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('reserva pendente nao vira lote e pedido grande estoura so o lote vigente', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const { eventoId, loteIds } = criarEvento(database, {
      max: null,
      lotes: [
        { nome: 'Lote 1', valor: 1000, quantidade: 20, ordem: 1, status: 'disponivel' },
        { nome: 'Lote 2', valor: 2000, quantidade: 30, ordem: 2, status: 'futuro' },
      ],
    });
    inserirPedido(database, {
      eventoId, loteId: loteIds[0], telefone: '5511900000001', quantidade: 25, valor: 1000,
      status: 'aguardando_pagamento', pagamento: 'pendente',
    });
    assert.equal(lote(database, loteIds[0]).status, 'disponivel');
    assert.equal(lote(database, loteIds[0]).quantidade_vendida, 0);
    assert.equal(contar(database, 'viradas_lote'), 0);

    const grande = inserirPedido(database, {
      eventoId, loteId: loteIds[0], telefone: '5511900000002', quantidade: 25, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    await aprovarPagamento(database, { pedidoId: grande, webhookUrl: '' });
    assert.equal(lote(database, loteIds[0]).quantidade_vendida, 25);
    assert.equal(lote(database, loteIds[0]).status, 'encerrado');
    assert.ok(lote(database, loteIds[0]).encerrado_em);
    assert.equal(lote(database, loteIds[1]).quantidade_vendida, 0);
    assert.equal(lote(database, loteIds[1]).status, 'disponivel');
    const virada = database.prepare('SELECT * FROM viradas_lote').get();
    assert.equal(virada.tipo, 'virada');
    assert.equal(virada.lote_anterior_id, loteIds[0]);
    assert.equal(virada.lote_novo_id, loteIds[1]);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('expirar, recusar e cancelar nao reabrem lote e o preco congelado continua valendo', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const { eventoId, loteIds } = criarEvento(database, {
      max: null,
      lotes: [
        { nome: 'Lote 1', valor: 1000, quantidade: 20, ordem: 1, status: 'disponivel' },
        { nome: 'Lote 2', valor: 2500, quantidade: 30, ordem: 2, status: 'futuro' },
      ],
    });
    const fecha = inserirPedido(database, {
      eventoId, loteId: loteIds[0], telefone: '5511900000010', quantidade: 20, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    const antigo = inserirPedido(database, {
      eventoId, loteId: loteIds[0], telefone: '5511900000011', quantidade: 2, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise', nome: 'Preco Antigo',
    });
    const recusado = inserirPedido(database, {
      eventoId, loteId: loteIds[0], telefone: '5511900000012', quantidade: 1, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    const pendente = inserirPedido(database, {
      eventoId, loteId: loteIds[0], telefone: '5511900000013', quantidade: 1, valor: 1000,
      status: 'aguardando_pagamento', pagamento: 'pendente',
      expira: new Date(Date.now() - 60_000).toISOString(),
    });
    await aprovarPagamento(database, { pedidoId: fecha });
    const marco = lote(database, loteIds[0]).encerrado_em;
    await aprovarPagamento(database, { pedidoId: antigo });
    recusarPagamento(database, { pedidoId: recusado, observacao: 'nao confere' });
    expirarReservas(database);
    cancelarPedidoPendente(database, pendente);
    assert.equal(lote(database, loteIds[0]).status, 'encerrado');
    assert.equal(lote(database, loteIds[0]).encerrado_em, marco);
    assert.equal(lote(database, loteIds[1]).status, 'disponivel');
    assert.equal(lote(database, loteIds[0]).quantidade_vendida, 22);
    assert.equal(pedido(database, antigo).valor_unitario_centavos, 1000);
    assert.equal(contar(database, 'viradas_lote'), 1);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('cotacao nao reserva e mudanca de preco so reserva depois do CONFIRMAR', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database, {
      lotes: [
        { nome: 'Lote 1', valor: 1000, quantidade: 1, ordem: 1, status: 'disponivel' },
        { nome: 'Lote 2', valor: 2000, quantidade: 1, ordem: 2, status: 'futuro' },
        { nome: 'Lote 3', valor: 3000, quantidade: 10, ordem: 3, status: 'futuro' },
      ],
    });
    const primeiro = falar(database, criado.evento, '11911111111', 'COMPRAR');
    assert.match(primeiro.resposta, /Lote 1/);
    const cotacao = falar(database, criado.evento, '11911111111', '1');
    assert.match(cotacao.resposta, /Total: R\$ 10,00/);
    assert.equal(contar(database, 'pedidos'), 0);

    const fecha1 = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '5511900000020', quantidade: 1, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    await aprovarPagamento(database, { pedidoId: fecha1 });
    const nome = falar(database, criado.evento, '(11) 91111-1111', 'Ana Compradora');
    assert.match(nome.resposta, /O valor mudou/);
    assert.match(nome.resposta, /Lote 2/);
    assert.equal(contar(database, 'pedidos'), 1);

    const fecha2 = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[1], telefone: '5511900000021', quantidade: 1, valor: 2000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    await aprovarPagamento(database, { pedidoId: fecha2 });
    const deNovo = falar(database, criado.evento, '11911111111', 'CONFIRMAR');
    assert.match(deNovo.resposta, /Lote 3/);
    assert.equal(deNovo.protocolo, undefined);
    assert.equal(contar(database, 'pedidos'), 2);

    const reservado = falar(database, criado.evento, '11911111111', 'CONFIRMAR');
    assert.match(reservado.resposta, /Reserva/);
    assert.equal(reservado.estado, 'aguardando_pagamento');
    const novo = database.prepare(`SELECT * FROM pedidos WHERE comprador_telefone = '11911111111'`).get();
    assert.equal(novo.valor_unitario_centavos, 3000);
    assert.equal(novo.lote_id, criado.loteIds[2]);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('reserva expirada abre pedido novo no preco vigente', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database, {
      lotes: [
        { nome: 'Lote 1', valor: 1000, quantidade: 2, ordem: 1, status: 'disponivel' },
        { nome: 'Lote 2', valor: 2000, quantidade: 10, ordem: 2, status: 'futuro' },
      ],
    });
    falar(database, criado.evento, '11922222222', 'COMPRAR');
    falar(database, criado.evento, '11922222222', '1');
    const reserva = falar(database, criado.evento, '11922222222', 'Ana Compradora');
    assert.equal(reserva.estado, 'aguardando_pagamento');
    database.prepare(`UPDATE pedidos SET reserva_expira_em = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), reserva.pedido_id);
    assert.equal(expirarReservas(database).expirados, 1);
    const fecha = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '5511900000030', quantidade: 2, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    await aprovarPagamento(database, { pedidoId: fecha });
    falar(database, criado.evento, '11922222222', 'COMPRAR');
    const cotacao = falar(database, criado.evento, '11922222222', '1');
    assert.match(cotacao.resposta, /Lote 2/);
    assert.match(cotacao.resposta, /20,00/);
    const nova = falar(database, criado.evento, '11922222222', 'Bia Nova');
    assert.equal(nova.estado, 'aguardando_pagamento');
    assert.equal(pedido(database, nova.pedido_id).valor_unitario_centavos, 2000);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('ultimo lote esgota o evento e o teto opcional bloqueia a reserva', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const esgotado = criarEvento(database, {
      codigo: 'esgotar',
      lotes: [{ nome: 'Unico', valor: 1000, quantidade: 1, ordem: 1, status: 'disponivel' }],
    });
    const fecha = inserirPedido(database, {
      eventoId: esgotado.eventoId, loteId: esgotado.loteIds[0], telefone: '5511900000040', quantidade: 1, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    const resultado = await aprovarPagamento(database, { pedidoId: fecha });
    assert.equal(resultado.virada.tipo, 'esgotado');
    assert.equal(resultado.virada.loteNovo, null);
    const resposta = falar(database, esgotado.evento, '11933333333', 'COMPRAR');
    assert.equal(resposta.resposta, MENSAGEM_ESGOTADO);

    const pausado = criarEvento(database, {
      codigo: 'pausa',
      lotes: [{ nome: 'Pausado', valor: 1000, quantidade: 10, ordem: 1, status: 'disponivel', ativo: 0 }],
    });
    assert.equal(falar(database, pausado.evento, '11933333334', 'COMPRAR').resposta, MENSAGEM_PAUSADA);
    assert.notEqual(MENSAGEM_PAUSADA, MENSAGEM_ESGOTADO);

    const limitado = criarEvento(database, { codigo: 'teto', teto: 5, max: null });
    inserirPedido(database, {
      eventoId: limitado.eventoId, loteId: limitado.loteIds[0], telefone: '5511900000041', quantidade: 3, valor: 1000,
      status: 'concluido', pagamento: 'aprovado',
    });
    const bloqueio = falar(database, limitado.evento, '11944444444', 'COMPRAR');
    assert.match(bloqueio.resposta, /Lote 1/);
    const acima = falar(database, limitado.evento, '11944444444', '3');
    assert.match(acima.resposta, /Ainda cabem 2/);
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM pedidos WHERE comprador_telefone = '11944444444'`).get().n, 0);
    falar(database, limitado.evento, '11944444444', '2');
    const nomes = falar(database, limitado.evento, '11944444444', 'Carlos Um');
    falar(database, limitado.evento, '11944444444', nomes.estado === 'aguardando_participante_nome' ? 'Diana Dois' : 'Diana Dois');
    const reservados = database.prepare(`SELECT COUNT(*) AS n FROM pedidos WHERE evento_id = ? AND comprador_telefone = '11944444444'`).get(limitado.eventoId);
    assert.equal(Number(reservados.n), 1);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('limite por telefone soma pedidos, libera ao expirar e NULL nao corta', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database, { max: 10 });
    inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '5511999990000', quantidade: 6, valor: 1000,
      status: 'concluido', pagamento: 'aprovado',
    });
    inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '(55) 11 99999-0000', quantidade: 2, valor: 1000,
      status: 'aguardando_pagamento', pagamento: 'pendente',
    });
    falar(database, criado.evento, '(55) 11 99999-0000', 'COMPRAR');
    const acima = falar(database, criado.evento, '55 11 99999-0000', '3');
    assert.match(acima.resposta, /10 ingressos por telefone/);
    assert.match(acima.resposta, /ainda pode comprar 2/i);
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM pedidos WHERE comprador_telefone = '5511999990000'`).get().n, 2);

    const cheio = criarEvento(database, { codigo: 'cheio', max: 10 });
    falar(database, cheio.evento, '11955555555', 'COMPRAR');
    falar(database, cheio.evento, '11955555555', '10');
    for (let indice = 1; indice <= 10; indice += 1) {
      falar(database, cheio.evento, '11955555555', `Pessoa Numero ${indice}`);
    }
    const reservado = database.prepare(`SELECT id FROM pedidos WHERE evento_id = ?`).get(cheio.eventoId);
    database.prepare(`UPDATE pedidos SET reserva_expira_em = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), reservado.id);
    expirarReservas(database);
    falar(database, cheio.evento, '11955555555', 'COMPRAR');
    const deNovo = falar(database, cheio.evento, '11955555555', '10');
    assert.match(deNovo.resposta, /participante 1 de 10/);

    const livre = criarEvento(database, { codigo: 'livre', max: null });
    const amplo = reservar(database, {
      eventoId: livre.eventoId,
      telefone: '11966666666',
      nomeComprador: 'Sem Limite',
      origem: 'teste',
      quantidade: 11,
      participantes: Array.from({ length: 11 }, (_, indice) => ({ nome: `Nome ${indice}` })),
      loteIdEsperado: livre.loteIds[0],
      valorUnitarioEsperado: 1000,
      totalEsperado: 11000,
    });
    assert.equal(amplo.total, 11000);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('comprovante no prazo impede a expiracao e comprovante tardio segue para analise', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database);
    falar(database, criado.evento, '11977777777', 'COMPRAR');
    falar(database, criado.evento, '11977777777', '1');
    const reserva = falar(database, criado.evento, '11977777777', 'Eva No Prazo');
    const valor = pedido(database, reserva.pedido_id).valor_unitario_centavos;
    registrarComprovante(database, {
      pedidoId: reserva.pedido_id,
      telefone: '(11) 97777-7777',
      eventoCodigo: criado.evento.codigo,
      comprovanteId: randomUUID(),
      nomeOriginal: 'pix.png',
      tipoMime: 'image/png',
      caminho: 'C:/tmp/pix.png',
      tamanhoBytes: 10,
    });
    database.prepare(`UPDATE pedidos SET reserva_expira_em = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), reserva.pedido_id);
    assert.equal(expirarReservas(database).expirados, 0);
    assert.equal(pedido(database, reserva.pedido_id).status, 'pagamento_em_analise');
    assert.equal(pedido(database, reserva.pedido_id).recebido_apos_expirar, 0);

    falar(database, criado.evento, '11988888888', 'COMPRAR');
    falar(database, criado.evento, '11988888888', '1');
    const tardio = falar(database, criado.evento, '11988888888', 'Eva Tardia');
    database.prepare(`UPDATE pedidos SET reserva_expira_em = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), tardio.pedido_id);
    expirarReservas(database);
    const recebido = registrarComprovante(database, {
      pedidoId: tardio.pedido_id,
      telefone: '11988888888',
      eventoCodigo: criado.evento.codigo,
      comprovanteId: randomUUID(),
      nomeOriginal: 'pix.png',
      tipoMime: 'image/png',
      caminho: 'C:/tmp/tarde.png',
      tamanhoBytes: 10,
    });
    const gravado = pedido(database, tardio.pedido_id);
    assert.equal(recebido.tardio, true);
    assert.equal(gravado.status, 'pagamento_em_analise');
    assert.equal(gravado.recebido_apos_expirar, 1);
    assert.match(gravado.observacoes, new RegExp(MARCA_COMPROVANTE_TARDIO));
    assert.equal(gravado.valor_unitario_centavos, valor);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('comprovante do pedido expirado entra em analise depois de um novo COMPRAR', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database);
    const telefone = '11933334444';
    falar(database, criado.evento, telefone, 'COMPRAR');
    falar(database, criado.evento, telefone, '1');
    const reserva = falar(database, criado.evento, telefone, 'Ana Expirada');
    database.prepare(`UPDATE pedidos SET reserva_expira_em = ? WHERE id = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), reserva.pedido_id);
    expirarReservas(database);
    const nova = falar(database, criado.evento, telefone, 'COMPRAR');
    assert.equal(nova.estado, 'aguardando_quantidade');
    const conversa = database.prepare('SELECT estado, pedido_id FROM conversas WHERE telefone = ?').get(telefone);
    assert.equal(conversa.estado, 'aguardando_quantidade');
    assert.equal(conversa.pedido_id, null);

    assert.throws(
      () => registrarComprovante(database, {
        pedidoId: reserva.pedido_id,
        telefone: '11900000000',
        eventoCodigo: criado.evento.codigo,
        comprovanteId: randomUUID(),
        nomeOriginal: 'outro.png',
        tipoMime: 'image/png',
        caminho: 'C:/tmp/outro.png',
        tamanhoBytes: 8,
      }),
      (erro) => erro.codigo === 'PROIBIDO',
    );
    assert.equal(pedido(database, reserva.pedido_id).status, 'expirado');

    const recebido = registrarComprovante(database, {
      pedidoId: reserva.pedido_id,
      telefone: '(11) 93333-4444',
      eventoCodigo: criado.evento.codigo,
      comprovanteId: randomUUID(),
      nomeOriginal: 'tarde.png',
      tipoMime: 'image/png',
      caminho: 'C:/tmp/tarde.png',
      tamanhoBytes: 8,
    });
    const gravado = pedido(database, reserva.pedido_id);
    assert.equal(recebido.tardio, true);
    assert.equal(gravado.status, 'pagamento_em_analise');
    assert.equal(gravado.status_pagamento, 'em_analise');
    assert.equal(gravado.recebido_apos_expirar, 1);
    assert.match(gravado.observacoes, new RegExp(MARCA_COMPROVANTE_TARDIO));
    const depois = database.prepare('SELECT estado, pedido_id FROM conversas WHERE telefone = ?').get(telefone);
    assert.equal(depois.estado, 'aguardando_quantidade');
    assert.equal(depois.pedido_id, null);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('conversa em analise pede para aguardar a confirmacao', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database);
    falar(database, criado.evento, '11922223333', 'COMPRAR');
    falar(database, criado.evento, '11922223333', '1');
    const reserva = falar(database, criado.evento, '11922223333', 'Bia Analise');
    registrarComprovante(database, {
      pedidoId: reserva.pedido_id,
      telefone: '11922223333',
      eventoCodigo: criado.evento.codigo,
      comprovanteId: randomUUID(),
      nomeOriginal: 'pix.png',
      tipoMime: 'image/png',
      caminho: 'C:/tmp/pix.png',
      tamanhoBytes: 8,
    });
    const resposta = falar(database, criado.evento, '11922223333', 'e ai');
    assert.equal(resposta.estado, 'pagamento_em_analise');
    assert.equal(resposta.resposta, 'Seu comprovante esta em analise. Aguarde a confirmacao.');
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('corrida entre expirar e comprovante termina em analise com o preco congelado', async () => {
  const diretorio = await temporario();
  try {
    const { database, caminho } = abrirNovo(diretorio);
    const criado = criarEvento(database);
    const pedidoId = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '11900000000', quantidade: 2, valor: 4321,
      status: 'aguardando_pagamento', pagamento: 'pendente',
      expira: new Date(Date.now() - 1000).toISOString(),
    });
    const agora = agoraIso();
    database.prepare(`
      INSERT INTO conversas (evento_id, telefone, nome_comprador, estado, pedido_id, dados_json, criado_em, atualizado_em)
      VALUES (?, '11900000000', 'Corrida', 'aguardando_pagamento', ?, '{}', ?, ?)
    `).run(criado.eventoId, pedidoId, agora, agora);
    database.close();
    const [expiracao, comprovante] = await Promise.all([
      executarNoWorker({ comando: 'expirar', databasePath: caminho, agora: new Date().toISOString() }),
      executarNoWorker({
        comando: 'comprovante',
        databasePath: caminho,
        agora: new Date().toISOString(),
        pedidoId,
        telefone: '11900000000',
        eventoCodigo: criado.evento.codigo,
        comprovanteId: randomUUID(),
        nomeOriginal: 'pix.png',
        tipoMime: 'image/png',
        caminho: 'C:/tmp/corrida.png',
        tamanhoBytes: 8,
      }),
    ]);
    assert.equal(expiracao.ok, true);
    assert.equal(comprovante.ok, true);
    const conferido = new DatabaseSync(caminho);
    const final = conferido.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
    assert.equal(final.status, 'pagamento_em_analise');
    assert.equal(final.status_pagamento, 'em_analise');
    assert.equal(final.valor_unitario_centavos, 4321);
    assert.equal(final.valor_total_centavos, 8642);
    conferido.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('aprovacao registra o webhook sem telefone e sem falhar quando ele esta fora', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database, {
      lotes: [
        { nome: 'Lote 1', valor: 1000, quantidade: 1, ordem: 1, status: 'disponivel' },
        { nome: 'Lote 2', valor: 2000, quantidade: 5, ordem: 2, status: 'futuro' },
      ],
    });
    const pedidoId = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '5511988887777', quantidade: 1, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise', nome: 'Maria Teste Unica',
    });
    let corpo;
    const ok = await aprovarPagamento(database, {
      pedidoId,
      webhookUrl: 'http://webhook.local/virada',
      fetchImpl: async (_url, options) => {
        corpo = JSON.parse(options.body);
        return { ok: true };
      },
    });
    assert.equal(ok.status_pagamento, 'aprovado');
    assert.equal(JSON.stringify(corpo).includes('5511988887777'), false);
    assert.equal(JSON.stringify(corpo).includes('Maria Teste Unica'), false);
    assert.equal(corpo.tipo, 'virada');
    assert.deepEqual(Object.keys(corpo).sort(), Object.keys(payloadVirada(ok.virada, criado.evento.codigo)).sort());
    const enviada = database.prepare('SELECT * FROM viradas_lote WHERE id = ?').get(ok.virada.id);
    assert.ok(enviada.enviado_em);
    assert.equal(enviada.erro, null);
    assert.equal(listarViradasPendentes(database).length, 1);
    marcarAnunciada(database, ok.virada.id);
    assert.equal(listarViradasPendentes(database).length, 0);

    const outro = criarEvento(database, {
      codigo: 'fora',
      lotes: [{ nome: 'Sozinho', valor: 1000, quantidade: 1, ordem: 1, status: 'disponivel' }],
    });
    const falho = inserirPedido(database, {
      eventoId: outro.eventoId, loteId: outro.loteIds[0], telefone: '5511977776666', quantidade: 1, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    const resposta = await aprovarPagamento(database, {
      pedidoId: falho,
      webhookUrl: 'http://127.0.0.1:9/virada',
      fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    assert.equal(resposta.status_pagamento, 'aprovado');
    assert.equal(pedido(database, falho).status_pagamento, 'aprovado');
    assert.match(database.prepare('SELECT erro FROM viradas_lote WHERE pedido_id = ?').get(falho).erro, /ECONNREFUSED/);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('duas aprovacoes concorrentes somam as vendas e registram uma virada', async () => {
  const diretorio = await temporario();
  try {
    const { database, caminho } = abrirNovo(diretorio);
    const criado = criarEvento(database, {
      max: null,
      lotes: [
        { nome: 'Lote 1', valor: 1000, quantidade: 20, ordem: 1, status: 'disponivel' },
        { nome: 'Lote 2', valor: 2000, quantidade: 30, ordem: 2, status: 'futuro' },
      ],
    });
    const primeiro = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '5511900000081', quantidade: 15, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    const segundo = inserirPedido(database, {
      eventoId: criado.eventoId, loteId: criado.loteIds[0], telefone: '5511900000082', quantidade: 15, valor: 1000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    database.close();
    const resultados = await Promise.all([
      executarNoWorker({ comando: 'aprovar', databasePath: caminho, pedidoId: primeiro, webhookUrl: '' }),
      executarNoWorker({ comando: 'aprovar', databasePath: caminho, pedidoId: segundo, webhookUrl: '' }),
    ]);
    assert.equal(resultados.every((item) => item.ok), true);
    const conferido = new DatabaseSync(caminho);
    assert.equal(conferido.prepare('SELECT quantidade_vendida, status FROM lotes WHERE id = ?').get(criado.loteIds[0]).quantidade_vendida, 30);
    assert.equal(conferido.prepare('SELECT status FROM lotes WHERE id = ?').get(criado.loteIds[0]).status, 'encerrado');
    assert.equal(conferido.prepare('SELECT quantidade_vendida, status FROM lotes WHERE id = ?').get(criado.loteIds[1]).quantidade_vendida, 0);
    assert.equal(conferido.prepare('SELECT status FROM lotes WHERE id = ?').get(criado.loteIds[1]).status, 'disponivel');
    assert.equal(Number(conferido.prepare('SELECT COUNT(*) AS n FROM viradas_lote').get().n), 1);
    conferido.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('desconto configurado entra no total da reserva', async () => {
  const diretorio = await temporario();
  try {
    const { database } = abrirNovo(diretorio);
    const criado = criarEvento(database, { descontos: '[{"min":2,"percentual":10}]' });
    falar(database, criado.evento, '11912121212', 'COMPRAR');
    const cotacao = falar(database, criado.evento, '11912121212', '2');
    assert.match(cotacao.resposta, /Total: R\$ 18,00/);
    falar(database, criado.evento, '11912121212', 'Nome Um Silva');
    const reserva = falar(database, criado.evento, '11912121212', 'Nome Dois Silva');
    assert.equal(pedido(database, reserva.pedido_id).valor_unitario_centavos, 1000);
    assert.equal(pedido(database, reserva.pedido_id).valor_total_centavos, 1800);
    database.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

async function startApi(extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'ingressos-api-'));
  const databasePath = join(directory, 'teste.sqlite');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: adminToken,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      API_DATABASE_PATH: databasePath,
      ...extraEnv,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) throw new Error(stderr || 'A API encerrou antes de responder.');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/saude`);
      if (response.status === 200) return { child, port, directory, databasePath };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  child.kill();
  throw new Error(`A API nao respondeu. ${stderr}`);
}

async function stopApi(api) {
  api.child.kill();
  await new Promise((resolve) => api.child.on('exit', resolve));
  await rm(api.directory, { recursive: true, force: true });
}

test('rota de aprovacao nao falha com webhook indisponivel e o alerta sai ao anunciar', async () => {
  const api = await startApi({ N8N_VIRADA_LOTE_WEBHOOK_URL: 'http://127.0.0.1:9/virada' });
  try {
    const loteAtual = await fetch(`http://127.0.0.1:${api.port}/eventos/evento-demonstracao/lote-atual`);
    const corpo = await loteAtual.json();
    assert.equal(loteAtual.status, 200);
    assert.equal(corpo.lote.nome, 'Primeiro lote');
    assert.equal(corpo.lote.valor, '30,00');
    assert.equal(corpo.lote.disponivel, 20);
    const database = new DatabaseSync(api.databasePath);
    database.exec('PRAGMA busy_timeout = 5000');
    const eventoId = corpo.lote.evento_id;
    const pedidoId = inserirPedido(database, {
      eventoId, loteId: corpo.lote.id, telefone: '11910101010', quantidade: 20, valor: 3000,
      status: 'pagamento_em_analise', pagamento: 'em_analise',
    });
    database.close();
    const aprovacao = await fetch(`http://127.0.0.1:${api.port}/admin/pedidos/${pedidoId}/pagamento`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ decisao: 'aprovar', responsavel: 'Teste' }),
    });
    assert.equal(aprovacao.status, 200);
    const viradas = await fetch(`http://127.0.0.1:${api.port}/admin/viradas`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const lista = await viradas.json();
    assert.equal(lista.viradas.length, 1);
    assert.equal(lista.viradas[0].tipo, 'virada');
    assert.equal(JSON.stringify(lista).includes('11910101010'), false);
    const anuncio = await fetch(`http://127.0.0.1:${api.port}/admin/viradas/${lista.viradas[0].id}/anunciada`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(anuncio.status, 200);
    const depois = await fetch(`http://127.0.0.1:${api.port}/admin/viradas`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal((await depois.json()).viradas.length, 0);
    const seguinte = await fetch(`http://127.0.0.1:${api.port}/eventos/evento-demonstracao/lote-atual`);
    assert.equal((await seguinte.json()).lote.nome, 'Segundo lote');
  } finally {
    await stopApi(api);
  }
});

test('comprovante de outro telefone responde 403', async () => {
  const api = await startApi({});
  try {
    const loteAtual = await fetch(`http://127.0.0.1:${api.port}/eventos/evento-demonstracao/lote-atual`);
    const corpo = await loteAtual.json();
    const database = new DatabaseSync(api.databasePath);
    database.exec('PRAGMA busy_timeout = 5000');
    const pedidoId = inserirPedido(database, {
      eventoId: corpo.lote.evento_id,
      loteId: corpo.lote.id,
      telefone: '11944445555',
      quantidade: 1,
      valor: 3000,
      status: 'expirado',
      pagamento: 'pendente',
      expira: new Date(Date.now() - 1000).toISOString(),
    });
    database.close();
    const resposta = await fetch(`http://127.0.0.1:${api.port}/comprovantes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pedido_id: pedidoId,
        telefone: '11900000099',
        evento_codigo: 'evento-demonstracao',
        nome_arquivo: 'falso.png',
        tipo_mime: 'image/png',
        arquivo_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      }),
    });
    assert.equal(resposta.status, 403);
    const conferido = new DatabaseSync(api.databasePath);
    assert.equal(conferido.prepare('SELECT status FROM pedidos WHERE id = ?').get(pedidoId).status, 'expirado');
    conferido.close();
  } finally {
    await stopApi(api);
  }
});
