import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { adminAuthorized, requireSecret } from './auth.mjs';

const apiFolder = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(apiFolder);
const dataFolder = join(projectRoot, 'data');
const receiptsFolder = join(dataFolder, 'comprovantes');
const databasePath = process.env.API_DATABASE_PATH || join(dataFolder, 'atendimentos.sqlite');
const simulatorPath = join(projectRoot, 'web', 'simulador.html');
const adminPath = join(projectRoot, 'web', 'admin.html');
const schemaPath = join(apiFolder, 'schema.sql');
const host = process.env.API_HOST || '127.0.0.1';
const port = Number(process.env.API_PORT || 8000);
const httpsHost = process.env.API_HTTPS_HOST || '0.0.0.0';
const httpsPort = Number(process.env.API_HTTPS_PORT || 8443);
const tlsCertificatePath = process.env.API_TLS_CERT_PATH || '';
const tlsKeyPath = process.env.API_TLS_KEY_PATH || '';
const n8nWebhook = process.env.N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/whatsapp-mensagens';
const simulatorEnabled = process.env.SIMULADOR_ATIVO === '1';

if (Boolean(tlsCertificatePath) !== Boolean(tlsKeyPath)) {
  throw new Error('Informe API_TLS_CERT_PATH e API_TLS_KEY_PATH juntos para ativar HTTPS.');
}

const adminToken = requireSecret('ADMIN_TOKEN');

mkdirSync(dataFolder, { recursive: true });
mkdirSync(receiptsFolder, { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec(readFileSync(schemaPath, 'utf8'));

const now = new Date().toISOString();
const eventCount = Number(database.prepare('SELECT COUNT(*) AS quantidade FROM eventos').get().quantidade);
if (eventCount === 0) {
  const insertEvent = database.prepare(`
    INSERT INTO eventos (
      codigo, nome, descricao, organizador, data_evento, horario, local, endereco,
      inicio_vendas, fim_vendas, capacidade_total, limite_por_comprador,
      prazo_reserva_minutos, mensagem_boas_vindas, orientacoes_entrada,
      texto_privacidade, documento_obrigatorio, status, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = insertEvent.run(
    'evento-demonstracao',
    'Evento de demonstracao',
    'Evento criado para validar a automacao generica.',
    'Organizacao de demonstracao',
    '2026-12-31',
    '22:00',
    'Local a definir',
    '',
    '2026-08-01T00:00:00-03:00',
    '2026-12-30T23:59:59-03:00',
    300,
    5,
    30,
    'Ola! Vou ajudar voce a comprar seu ingresso.',
    'Apresente seu documento na entrada.',
    'Seus dados serao usados somente para a venda e validacao da entrada.',
    1,
    'vendas_abertas',
    now,
    now,
  );

  const insertLot = database.prepare(`
    INSERT INTO lotes (
      evento_id, nome, valor_centavos, inicio, fim, quantidade_total,
      limite_por_comprador, status, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertLot.run(
    Number(result.lastInsertRowid),
    'Primeiro lote',
    3000,
    '2026-08-01T00:00:00-03:00',
    '2026-09-30T23:59:59-03:00',
    150,
    5,
    'disponivel',
    now,
    now,
  );
  insertLot.run(
    Number(result.lastInsertRowid),
    'Segundo lote',
    4000,
    '2026-10-01T00:00:00-03:00',
    '2026-12-30T23:59:59-03:00',
    150,
    5,
    'futuro',
    now,
    now,
  );
}

database.prepare(`
  UPDATE eventos
  SET pix_chave = 'PIX-DEMONSTRACAO-NAO-PAGAR', pix_tipo = 'demonstracao',
      pix_favorecido = 'Favorecido de demonstracao', atualizado_em = ?
  WHERE codigo = 'evento-demonstracao' AND pix_chave = ''
`).run(now);

const insertStatement = database.prepare(`
  INSERT INTO atendimentos (
    data_hora, telefone, nome, mensagem, origem, status, resposta, id_mensagem
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const listStatement = database.prepare(`
  SELECT data_hora, telefone, nome, mensagem, origem, status, resposta, id_mensagem
  FROM atendimentos
  ORDER BY id DESC
  LIMIT ?
`);

const allStatement = database.prepare(`
  SELECT data_hora, telefone, nome, mensagem, origem, status, resposta, id_mensagem
  FROM atendimentos
  ORDER BY id ASC
`);

const listEventsStatement = database.prepare(`
  SELECT
    id, codigo, nome, descricao, organizador, data_evento, horario, local,
    capacidade_total, limite_por_comprador, prazo_reserva_minutos,
    documento_obrigatorio, status
  FROM eventos
  ORDER BY data_evento ASC, id ASC
`);

const eventByCodeStatement = database.prepare(`
  SELECT * FROM eventos WHERE codigo = ?
`);

const lotsByEventStatement = database.prepare(`
  SELECT
    id, evento_id, nome, valor_centavos, inicio, fim, quantidade_total,
    quantidade_reservada, quantidade_vendida, limite_por_comprador, status
  FROM lotes
  WHERE evento_id = ?
  ORDER BY COALESCE(inicio, ''), id
`);

const createEventStatement = database.prepare(`
  INSERT INTO eventos (
    codigo, nome, descricao, organizador, data_evento, horario, local, endereco,
    inicio_vendas, fim_vendas, capacidade_total, limite_por_comprador,
    prazo_reserva_minutos, pix_chave, pix_tipo, pix_favorecido, contato_humano,
    mensagem_boas_vindas, orientacoes_entrada, politica_cancelamento,
    texto_privacidade, documento_obrigatorio, status, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const createLotStatement = database.prepare(`
  INSERT INTO lotes (
    evento_id, nome, valor_centavos, inicio, fim, quantidade_total,
    limite_por_comprador, status, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const conversationStatement = database.prepare(`
  SELECT * FROM conversas WHERE evento_id = ? AND telefone = ?
`);

const saveConversationStatement = database.prepare(`
  INSERT INTO conversas (
    evento_id, telefone, nome_comprador, estado, quantidade, lote_id,
    dados_json, pedido_id, origem, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(evento_id, telefone) DO UPDATE SET
    nome_comprador = excluded.nome_comprador,
    estado = excluded.estado,
    quantidade = excluded.quantidade,
    lote_id = excluded.lote_id,
    dados_json = excluded.dados_json,
    pedido_id = excluded.pedido_id,
    origem = excluded.origem,
    atualizado_em = excluded.atualizado_em
`);

const lotByIdStatement = database.prepare('SELECT * FROM lotes WHERE id = ?');
const createOrderStatement = database.prepare(`
  INSERT INTO pedidos (
    protocolo, evento_id, lote_id, data_contato, origem, comprador_nome,
    comprador_telefone, quantidade, valor_unitario_centavos, valor_total_centavos,
    reserva_expira_em, status, status_pagamento, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const createParticipantStatement = database.prepare(`
  INSERT INTO participantes (
    pedido_id, evento_id, nome_completo, tipo_documento, numero_documento,
    status_ingresso, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, 'pendente', ?, ?)
`);
const reserveLotStatement = database.prepare(`
  UPDATE lotes
  SET quantidade_reservada = quantidade_reservada + ?, atualizado_em = ?
  WHERE id = ? AND quantidade_total - quantidade_reservada - quantidade_vendida >= ?
`);
const orderByIdStatement = database.prepare('SELECT * FROM pedidos WHERE id = ?');
const insertReceiptStatement = database.prepare(`
  INSERT INTO comprovantes (id, pedido_id, nome_original, tipo_mime, caminho, tamanho_bytes, recebido_em)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const receiptByIdStatement = database.prepare('SELECT * FROM comprovantes WHERE id = ?');
const pendingPaymentsStatement = database.prepare(`
  SELECT
    p.id, p.protocolo, p.comprador_nome, p.comprador_telefone, p.quantidade,
    p.valor_total_centavos, p.status, p.status_pagamento, p.comprovante_id,
    p.criado_em, e.nome AS evento_nome, l.nome AS lote_nome,
    c.nome_original AS comprovante_nome, c.tipo_mime AS comprovante_tipo
  FROM pedidos p
  JOIN eventos e ON e.id = p.evento_id
  LEFT JOIN lotes l ON l.id = p.lote_id
  LEFT JOIN comprovantes c ON c.id = p.comprovante_id
  WHERE p.status_pagamento = ?
  ORDER BY p.atualizado_em ASC
`);

const confirmedParticipantsByEventStatement = database.prepare(`
  SELECT
    p.protocolo,
    pt.nome_completo,
    pt.tipo_documento,
    pt.numero_documento,
    l.nome AS lote_nome,
    p.comprador_nome,
    p.comprador_telefone,
    pt.status_ingresso,
    p.aprovado_em,
    pt.entrada_em
  FROM participantes pt
  JOIN pedidos p ON p.id = pt.pedido_id
  LEFT JOIN lotes l ON l.id = p.lote_id
  WHERE pt.evento_id = ?
    AND p.status_pagamento = 'aprovado'
    AND pt.status_ingresso IN ('valido', 'utilizado')
  ORDER BY pt.nome_completo COLLATE NOCASE, pt.id
`);

const checkInCandidateStatement = database.prepare(`
  SELECT
    pt.id AS participante_id,
    pt.nome_completo,
    pt.tipo_documento,
    pt.numero_documento,
    pt.status_ingresso,
    pt.entrada_em,
    p.protocolo,
    p.comprador_nome,
    l.nome AS lote_nome
  FROM participantes pt
  JOIN pedidos p ON p.id = pt.pedido_id
  LEFT JOIN lotes l ON l.id = p.lote_id
  WHERE pt.evento_id = ?
    AND p.status_pagamento = 'aprovado'
    AND (
      UPPER(REPLACE(REPLACE(REPLACE(REPLACE(pt.numero_documento, '.', ''), '-', ''), '/', ''), ' ', '')) = ?
      OR UPPER(REPLACE(REPLACE(REPLACE(REPLACE(p.protocolo, '.', ''), '-', ''), '/', ''), ' ', '')) = ?
    )
  ORDER BY pt.id
`);

const checkInParticipantStatement = database.prepare(`
  SELECT
    pt.id AS participante_id,
    pt.nome_completo,
    pt.tipo_documento,
    pt.numero_documento,
    pt.status_ingresso,
    pt.entrada_em,
    p.protocolo,
    l.nome AS lote_nome
  FROM participantes pt
  JOIN pedidos p ON p.id = pt.pedido_id
  LEFT JOIN lotes l ON l.id = p.lote_id
  WHERE pt.id = ? AND pt.evento_id = ? AND p.status_pagamento = 'aprovado'
`);

function requiresAdmin(method, pathname) {
  if (pathname.startsWith('/admin/')) return true;
  return method === 'GET' && (pathname === '/atendimentos' || pathname === '/exportar');
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(JSON.stringify(body));
}

function normalizeText(value, maximumLength) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, maximumLength);
}

function positiveInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function normalizedCheckInSearch(value) {
  return normalizeText(value, 200).replace(/[^\p{L}\p{N}]/gu, '').toLocaleUpperCase('pt-BR');
}

function readJson(request, maximumSize = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maximumSize) {
        reject(new Error('Corpo da requisicao muito grande.'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('JSON invalido.'));
      }
    });

    request.on('error', reject);
  });
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function createCsv(rows) {
  const columns = [
    'data_hora',
    'telefone',
    'nome',
    'mensagem',
    'origem',
    'status',
    'resposta',
    'id_mensagem',
  ];

  const lines = [columns.map(csvCell).join(';')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(';'));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function createParticipantsCsv(rows) {
  const columns = [
    ['protocolo', 'Protocolo'],
    ['nome_completo', 'Participante'],
    ['tipo_documento', 'Tipo de documento'],
    ['numero_documento', 'Documento'],
    ['lote_nome', 'Lote'],
    ['comprador_nome', 'Comprador'],
    ['comprador_telefone', 'Telefone'],
    ['status_ingresso', 'Status do ingresso'],
    ['aprovado_em', 'Pagamento aprovado em'],
    ['entrada_em', 'Entrada registrada em'],
  ];
  const lines = [columns.map(([, label]) => csvCell(label)).join(';')];
  for (const row of rows) {
    lines.push(columns.map(([field]) => csvCell(row[field])).join(';'));
  }
  return `\uFEFFsep=;\r\n${lines.join('\r\n')}\r\n`;
}

function publicEvent(event) {
  if (!event) return null;
  const { pix_chave, pix_tipo, pix_favorecido, ...safeEvent } = event;
  return {
    ...safeEvent,
    documento_obrigatorio: Boolean(event.documento_obrigatorio),
  };
}

function publicLot(lot) {
  const available = Math.max(
    Number(lot.quantidade_total) - Number(lot.quantidade_reservada) - Number(lot.quantidade_vendida),
    0,
  );
  return {
    ...lot,
    disponivel: available,
    valor: (Number(lot.valor_centavos) / 100).toFixed(2).replace('.', ','),
  };
}

function currentLot(lots, referenceDate = new Date()) {
  const reference = referenceDate.getTime();
  return lots.find((lot) => {
    if (lot.status !== 'disponivel') return false;
    const startsAt = lot.inicio ? new Date(lot.inicio).getTime() : Number.NEGATIVE_INFINITY;
    const endsAt = lot.fim ? new Date(lot.fim).getTime() : Number.POSITIVE_INFINITY;
    return reference >= startsAt && reference <= endsAt && publicLot(lot).disponivel > 0;
  }) ?? null;
}

function conversationData(conversation) {
  try {
    return JSON.parse(conversation?.dados_json || '{}');
  } catch {
    return {};
  }
}

function saveConversation(conversation) {
  const timestamp = new Date().toISOString();
  saveConversationStatement.run(
    conversation.evento_id,
    conversation.telefone,
    conversation.nome_comprador,
    conversation.estado,
    conversation.quantidade ?? null,
    conversation.lote_id ?? null,
    JSON.stringify(conversation.dados ?? {}),
    conversation.pedido_id ?? null,
    conversation.origem || '',
    conversation.criado_em || timestamp,
    timestamp,
  );
}

function maskedDocument(documentNumber) {
  const text = String(documentNumber);
  return `${'*'.repeat(Math.max(text.length - 4, 0))}${text.slice(-4)}`;
}

function createReservation({ conversation, event, lot, participants }) {
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + Number(event.prazo_reserva_minutos) * 60_000).toISOString();
  const protocol = `ING-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
  database.exec('BEGIN IMMEDIATE');
  try {
    const reservation = reserveLotStatement.run(conversation.quantidade, timestamp, lot.id, conversation.quantidade);
    if (Number(reservation.changes) !== 1) throw new Error('Nao ha mais ingressos suficientes neste lote.');
    const order = createOrderStatement.run(
      protocol, event.id, lot.id, timestamp, conversation.origem,
      conversation.nome_comprador, conversation.telefone, conversation.quantidade,
      lot.valor_centavos, lot.valor_centavos * conversation.quantidade,
      expiresAt, 'aguardando_pagamento', 'pendente', timestamp, timestamp,
    );
    const orderId = Number(order.lastInsertRowid);
    for (const participant of participants) {
      createParticipantStatement.run(
        orderId, event.id, participant.nome, participant.tipo_documento,
        participant.numero_documento, timestamp, timestamp,
      );
    }
    database.exec('COMMIT');
    return { orderId, protocol, expiresAt };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function processConversation({ event, lot, payload }) {
  let stored = conversationStatement.get(event.id, payload.telefone);
  const text = payload.mensagem.trim();
  const normalized = text.toLocaleLowerCase('pt-BR');

  if (normalized === 'cancelar') {
    const cancelled = {
      ...(stored || {}), evento_id: event.id, telefone: payload.telefone,
      nome_comprador: payload.nome, estado: 'cancelado', quantidade: null,
      lote_id: null, dados: {}, pedido_id: null, origem: payload.origem,
    };
    saveConversation(cancelled);
    return { estado: 'cancelado', resposta: 'Atendimento cancelado. Quando quiser recomecar, envie COMPRAR.' };
  }

  if (!stored || ['cancelado', 'concluido'].includes(stored.estado) || normalized === 'comprar') {
    const fresh = {
      evento_id: event.id, telefone: payload.telefone, nome_comprador: payload.nome,
      estado: 'aguardando_quantidade', quantidade: null, lote_id: lot.id,
      dados: { participantes: [], atual: {} }, pedido_id: null, origem: payload.origem,
    };
    saveConversation(fresh);
    return {
      estado: fresh.estado,
      resposta: `O ${event.nome} esta no ${lot.nome}, por R$ ${publicLot(lot).valor}. Quantos ingressos voce deseja?`,
    };
  }

  const conversation = { ...stored, dados: conversationData(stored), nome_comprador: payload.nome };
  conversation.dados.participantes ||= [];
  conversation.dados.atual ||= {};

  if (conversation.estado === 'aguardando_quantidade') {
    const quantity = Number(text.match(/\d+/)?.[0]);
    const limit = Math.min(Number(event.limite_por_comprador), Number(lot.limite_por_comprador || event.limite_por_comprador));
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > limit || quantity > publicLot(lot).disponivel) {
      return { estado: conversation.estado, resposta: `Informe uma quantidade entre 1 e ${Math.min(limit, publicLot(lot).disponivel)}.` };
    }
    conversation.quantidade = quantity;
    conversation.lote_id = lot.id;
    conversation.estado = 'aguardando_participante_nome';
    saveConversation(conversation);
    return { estado: conversation.estado, resposta: `Qual e o nome completo do participante 1 de ${quantity}?` };
  }

  if (conversation.estado === 'aguardando_participante_nome') {
    if (text.length < 3) return { estado: conversation.estado, resposta: 'Informe o nome completo do participante.' };
    conversation.dados.atual = { nome: text };
    conversation.estado = 'aguardando_participante_documento_tipo';
    saveConversation(conversation);
    return { estado: conversation.estado, resposta: 'Qual documento sera usado na entrada? Responda CPF ou RG.' };
  }

  if (conversation.estado === 'aguardando_participante_documento_tipo') {
    const documentType = normalized.includes('cpf') ? 'CPF' : normalized === 'rg' || normalized.includes(' rg') ? 'RG' : '';
    if (!documentType) return { estado: conversation.estado, resposta: 'Responda somente CPF ou RG.' };
    conversation.dados.atual.tipo_documento = documentType;
    conversation.estado = 'aguardando_participante_documento_numero';
    saveConversation(conversation);
    return { estado: conversation.estado, resposta: `Digite somente os numeros do ${documentType}.` };
  }

  if (conversation.estado === 'aguardando_participante_documento_numero') {
    const documentNumber = text.replace(/\D/g, '');
    const documentType = conversation.dados.atual.tipo_documento;
    const valid = documentType === 'CPF' ? documentNumber.length === 11 : documentNumber.length >= 5 && documentNumber.length <= 14;
    if (!valid) return { estado: conversation.estado, resposta: `O numero informado nao possui o formato esperado para ${documentType}. Tente novamente.` };
    conversation.dados.atual.numero_documento = documentNumber;
    conversation.dados.participantes.push(conversation.dados.atual);
    conversation.dados.atual = {};
    if (conversation.dados.participantes.length < conversation.quantidade) {
      conversation.estado = 'aguardando_participante_nome';
      saveConversation(conversation);
      const next = conversation.dados.participantes.length + 1;
      return { estado: conversation.estado, resposta: `Qual e o nome completo do participante ${next} de ${conversation.quantidade}?` };
    }
    conversation.estado = 'aguardando_confirmacao';
    saveConversation(conversation);
    const summary = conversation.dados.participantes.map((participant, index) => (
      `${index + 1}. ${participant.nome} — ${participant.tipo_documento} ${maskedDocument(participant.numero_documento)}`
    )).join('\n');
    const total = ((Number(lot.valor_centavos) * conversation.quantidade) / 100).toFixed(2).replace('.', ',');
    return { estado: conversation.estado, resposta: `Confira os dados:\n${summary}\nTotal: R$ ${total}\n\nResponda CONFIRMAR para criar a reserva ou CORRIGIR para recomecar.` };
  }

  if (conversation.estado === 'aguardando_confirmacao') {
    if (normalized === 'corrigir') {
      conversation.estado = 'aguardando_quantidade';
      conversation.quantidade = null;
      conversation.dados = { participantes: [], atual: {} };
      saveConversation(conversation);
      return { estado: conversation.estado, resposta: 'Vamos recomecar. Quantos ingressos voce deseja?' };
    }
    if (normalized !== 'confirmar') return { estado: conversation.estado, resposta: 'Responda CONFIRMAR ou CORRIGIR.' };
    if (!event.pix_chave) {
      conversation.estado = 'atendimento_humano';
      saveConversation(conversation);
      return { estado: conversation.estado, resposta: 'O pagamento deste evento ainda nao foi configurado. O atendimento sera encaminhado para uma pessoa.' };
    }
    const currentReservedLot = lotByIdStatement.get(conversation.lote_id);
    const reservation = createReservation({ conversation, event, lot: currentReservedLot, participants: conversation.dados.participantes });
    conversation.estado = 'aguardando_pagamento';
    conversation.pedido_id = reservation.orderId;
    saveConversation(conversation);
    const total = ((Number(currentReservedLot.valor_centavos) * conversation.quantidade) / 100).toFixed(2).replace('.', ',');
    const demoWarning = event.pix_tipo === 'demonstracao' ? 'AMBIENTE DE TESTE — NAO REALIZE PAGAMENTO.\n' : '';
    return {
      estado: conversation.estado,
      pedido_id: reservation.orderId,
      protocolo: reservation.protocol,
      resposta: `${demoWarning}Reserva ${reservation.protocol} criada.\nTotal: R$ ${total}\nPix: ${event.pix_chave}\nFavorecido: ${event.pix_favorecido}\nPrazo: ${event.prazo_reserva_minutos} minutos.\nEnvie o comprovante para analise.`,
    };
  }

  if (conversation.estado === 'aguardando_pagamento') {
    return { estado: conversation.estado, pedido_id: conversation.pedido_id, resposta: 'Sua reserva esta aguardando o comprovante e a validacao do pagamento.' };
  }

  return { estado: conversation.estado, resposta: 'Este atendimento precisa ser continuado por uma pessoa.' };
}

const requestListener = async (request, response) => {
  const requestStartedAt = Date.now();
  response.on('finish', () => {
    const duration = Date.now() - requestStartedAt;
    const timestamp = new Date().toLocaleString('pt-BR');
    console.log(`[${timestamp}] ${request.method} ${request.url} -> ${response.statusCode} (${duration} ms)`);
  });

  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    response.end();
    return;
  }

  if (requiresAdmin(request.method, url.pathname)) {
    if (!adminAuthorized(request.headers.authorization, adminToken)) {
      sendJson(response, 401, { erro: 'Nao autorizado.' });
      return;
    }
  }

  if (request.method === 'GET' && url.pathname === '/saude') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/simulador')) {
    if (!simulatorEnabled) {
      sendJson(response, 404, { erro: 'Rota nao encontrada.' });
      return;
    }
    try {
      const html = readFileSync(simulatorPath, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(html);
    } catch {
      sendJson(response, 500, { erro: 'A tela do simulador nao foi encontrada.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/admin') {
    try {
      const html = readFileSync(adminPath, 'utf8');
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(html);
    } catch {
      sendJson(response, 500, { erro: 'A tela administrativa nao foi encontrada.' });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/atendimentos') {
    const requestedLimit = Number(url.searchParams.get('limite') || 100);
    const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? requestedLimit : 100, 1), 1000);
    const rows = listStatement.all(limit);
    sendJson(response, 200, { quantidade: rows.length, atendimentos: rows });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/eventos') {
    const requestedStatus = normalizeText(url.searchParams.get('status'), 50);
    const events = listEventsStatement.all()
      .filter((event) => !requestedStatus || event.status === requestedStatus)
      .map(publicEvent);
    sendJson(response, 200, { quantidade: events.length, eventos: events });
    return;
  }

  const eventMatch = url.pathname.match(/^\/eventos\/([^/]+)$/);
  if (request.method === 'GET' && eventMatch) {
    const eventCode = decodeURIComponent(eventMatch[1]);
    const event = eventByCodeStatement.get(eventCode);
    if (!event) {
      sendJson(response, 404, { erro: 'Evento nao encontrado.' });
      return;
    }
    const lots = lotsByEventStatement.all(event.id).map(publicLot);
    sendJson(response, 200, {
      evento: publicEvent(event),
      lotes: lots,
      lote_atual: currentLot(lots),
    });
    return;
  }

  const currentLotMatch = url.pathname.match(/^\/eventos\/([^/]+)\/lote-atual$/);
  if (request.method === 'GET' && currentLotMatch) {
    const eventCode = decodeURIComponent(currentLotMatch[1]);
    const event = eventByCodeStatement.get(eventCode);
    if (!event) {
      sendJson(response, 404, { erro: 'Evento nao encontrado.' });
      return;
    }
    if (event.status !== 'vendas_abertas') {
      sendJson(response, 409, { erro: 'As vendas deste evento nao estao abertas.', status: event.status });
      return;
    }
    const lot = currentLot(lotsByEventStatement.all(event.id));
    if (!lot) {
      sendJson(response, 404, { erro: 'Nao existe lote disponivel neste momento.' });
      return;
    }
    sendJson(response, 200, { evento: publicEvent(event), lote: publicLot(lot) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/admin/eventos') {
    try {
      const body = await readJson(request);
      const timestamp = new Date().toISOString();
      const event = {
        codigo: normalizeText(body.codigo, 100).toLowerCase(),
        nome: normalizeText(body.nome, 200),
        descricao: normalizeText(body.descricao, 2000),
        organizador: normalizeText(body.organizador, 200),
        data_evento: normalizeText(body.data_evento, 30),
        horario: normalizeText(body.horario, 20),
        local: normalizeText(body.local, 300),
        endereco: normalizeText(body.endereco, 500),
        inicio_vendas: normalizeText(body.inicio_vendas, 50) || null,
        fim_vendas: normalizeText(body.fim_vendas, 50) || null,
        capacidade_total: nonNegativeInteger(body.capacidade_total),
        limite_por_comprador: positiveInteger(body.limite_por_comprador, 5),
        prazo_reserva_minutos: positiveInteger(body.prazo_reserva_minutos, 30),
        pix_chave: normalizeText(body.pix_chave, 300),
        pix_tipo: normalizeText(body.pix_tipo, 50),
        pix_favorecido: normalizeText(body.pix_favorecido, 200),
        contato_humano: normalizeText(body.contato_humano, 100),
        mensagem_boas_vindas: normalizeText(body.mensagem_boas_vindas, 1000),
        orientacoes_entrada: normalizeText(body.orientacoes_entrada, 2000),
        politica_cancelamento: normalizeText(body.politica_cancelamento, 2000),
        texto_privacidade: normalizeText(body.texto_privacidade, 2000),
        documento_obrigatorio: body.documento_obrigatorio === false ? 0 : 1,
        status: normalizeText(body.status, 30) || 'rascunho',
      };

      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(event.codigo)) {
        sendJson(response, 400, { erro: 'Use um codigo com letras minusculas, numeros e hifens.' });
        return;
      }
      const missing = ['nome', 'data_evento', 'local'].filter((field) => !event[field]);
      if (missing.length > 0 || event.capacidade_total < 1) {
        sendJson(response, 400, { erro: 'Preencha nome, data, local e capacidade.' });
        return;
      }

      const result = createEventStatement.run(
        event.codigo, event.nome, event.descricao, event.organizador, event.data_evento,
        event.horario, event.local, event.endereco, event.inicio_vendas, event.fim_vendas,
        event.capacidade_total, event.limite_por_comprador, event.prazo_reserva_minutos,
        event.pix_chave, event.pix_tipo, event.pix_favorecido, event.contato_humano,
        event.mensagem_boas_vindas, event.orientacoes_entrada, event.politica_cancelamento,
        event.texto_privacidade, event.documento_obrigatorio, event.status, timestamp, timestamp,
      );
      sendJson(response, 201, { criado: true, id: Number(result.lastInsertRowid), codigo: event.codigo });
    } catch (error) {
      const duplicated = String(error.message).includes('UNIQUE constraint failed');
      sendJson(response, duplicated ? 409 : 400, {
        erro: duplicated ? 'Ja existe um evento com esse codigo.' : error.message,
      });
    }
    return;
  }

  const createLotMatch = url.pathname.match(/^\/admin\/eventos\/([^/]+)\/lotes$/);
  if (request.method === 'POST' && createLotMatch) {
    try {
      const eventCode = decodeURIComponent(createLotMatch[1]);
      const event = eventByCodeStatement.get(eventCode);
      if (!event) {
        sendJson(response, 404, { erro: 'Evento nao encontrado.' });
        return;
      }
      const body = await readJson(request);
      const timestamp = new Date().toISOString();
      const name = normalizeText(body.nome, 150);
      const priceInCents = nonNegativeInteger(body.valor_centavos, -1);
      const quantity = nonNegativeInteger(body.quantidade_total, -1);
      const status = normalizeText(body.status, 30) || 'futuro';
      if (!name || priceInCents < 0 || quantity < 1) {
        sendJson(response, 400, { erro: 'Preencha nome, valor e quantidade do lote.' });
        return;
      }
      const result = createLotStatement.run(
        event.id,
        name,
        priceInCents,
        normalizeText(body.inicio, 50) || null,
        normalizeText(body.fim, 50) || null,
        quantity,
        positiveInteger(body.limite_por_comprador, event.limite_por_comprador),
        status,
        timestamp,
        timestamp,
      );
      sendJson(response, 201, { criado: true, id: Number(result.lastInsertRowid), evento: event.codigo });
    } catch (error) {
      const duplicated = String(error.message).includes('UNIQUE constraint failed');
      sendJson(response, duplicated ? 409 : 400, {
        erro: duplicated ? 'Ja existe um lote com esse nome neste evento.' : error.message,
      });
    }
    return;
  }

  const confirmedParticipantsMatch = url.pathname.match(
    /^\/admin\/eventos\/([^/]+)\/participantes-confirmados(?:\.json)?$/,
  );
  if (request.method === 'GET' && confirmedParticipantsMatch) {
    const eventCode = decodeURIComponent(confirmedParticipantsMatch[1]);
    const event = eventByCodeStatement.get(eventCode);
    if (!event) {
      sendJson(response, 404, { erro: 'Evento nao encontrado.' });
      return;
    }
    const participants = confirmedParticipantsByEventStatement.all(event.id);
    sendJson(response, 200, {
      evento: publicEvent(event),
      quantidade: participants.length,
      participantes: participants,
    });
    return;
  }

  const exportParticipantsMatch = url.pathname.match(
    /^\/admin\/eventos\/([^/]+)\/exportar-participantes\.csv$/,
  );
  if (request.method === 'GET' && exportParticipantsMatch) {
    const eventCode = decodeURIComponent(exportParticipantsMatch[1]);
    const event = eventByCodeStatement.get(eventCode);
    if (!event) {
      sendJson(response, 404, { erro: 'Evento nao encontrado.' });
      return;
    }
    const participants = confirmedParticipantsByEventStatement.all(event.id);
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lista-entrada-${event.codigo}.csv"`,
      'Cache-Control': 'no-store',
    });
    response.end(createParticipantsCsv(participants));
    return;
  }

  const checkInMatch = url.pathname.match(/^\/admin\/eventos\/([^/]+)\/check-in$/);
  if (request.method === 'GET' && checkInMatch) {
    const eventCode = decodeURIComponent(checkInMatch[1]);
    const event = eventByCodeStatement.get(eventCode);
    if (!event) {
      sendJson(response, 404, { erro: 'Evento nao encontrado.' });
      return;
    }
    const search = normalizedCheckInSearch(url.searchParams.get('busca'));
    if (search.length < 4) {
      sendJson(response, 400, { erro: 'Informe o documento completo ou o protocolo do ingresso.' });
      return;
    }
    const candidates = checkInCandidateStatement.all(event.id, search, search);
    if (candidates.length === 0) {
      sendJson(response, 404, { erro: 'Nenhum ingresso confirmado foi encontrado.' });
      return;
    }
    if (candidates.length > 1) {
      sendJson(response, 409, { erro: 'A busca encontrou mais de um ingresso. Use o protocolo completo.' });
      return;
    }
    sendJson(response, 200, { evento: publicEvent(event), participante: candidates[0] });
    return;
  }

  if (request.method === 'POST' && checkInMatch) {
    try {
      const eventCode = decodeURIComponent(checkInMatch[1]);
      const event = eventByCodeStatement.get(eventCode);
      if (!event) {
        sendJson(response, 404, { erro: 'Evento nao encontrado.' });
        return;
      }
      const body = await readJson(request);
      const participantId = positiveInteger(body.participante_id);
      const participant = checkInParticipantStatement.get(participantId, event.id);
      if (!participant) {
        sendJson(response, 404, { erro: 'Ingresso confirmado nao encontrado neste evento.' });
        return;
      }
      if (participant.status_ingresso === 'utilizado') {
        sendJson(response, 409, {
          erro: 'Este ingresso ja foi utilizado.',
          entrada_em: participant.entrada_em,
          participante: participant.nome_completo,
        });
        return;
      }
      if (participant.status_ingresso !== 'valido') {
        sendJson(response, 409, { erro: 'Este ingresso nao esta liberado para entrada.' });
        return;
      }
      const timestamp = new Date().toISOString();
      const result = database.prepare(`
        UPDATE participantes
        SET status_ingresso = 'utilizado', entrada_em = ?, atualizado_em = ?
        WHERE id = ? AND evento_id = ? AND status_ingresso = 'valido'
      `).run(timestamp, timestamp, participantId, event.id);
      if (Number(result.changes) !== 1) {
        sendJson(response, 409, { erro: 'O ingresso foi atualizado por outro atendimento. Consulte novamente.' });
        return;
      }
      sendJson(response, 200, {
        entrada_confirmada: true,
        entrada_em: timestamp,
        participante: participant.nome_completo,
        protocolo: participant.protocolo,
      });
    } catch (error) {
      sendJson(response, 400, { erro: error.message });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/comprovantes') {
    try {
      const body = await readJson(request, 7_000_000);
      const orderId = positiveInteger(body.pedido_id);
      const phone = normalizeText(body.telefone, 30);
      const eventCode = normalizeText(body.evento_codigo, 100);
      const originalName = (normalizeText(body.nome_arquivo, 250) || 'comprovante')
        .replace(/[^\p{L}\p{N}._ -]/gu, '_');
      const mimeType = normalizeText(body.tipo_mime, 100);
      const allowedTypes = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
      if (!orderId || !phone || !eventCode || !allowedTypes[mimeType]) {
        sendJson(response, 400, { erro: 'Dados do comprovante invalidos. Use JPG, PNG ou PDF.' });
        return;
      }
      const event = eventByCodeStatement.get(eventCode);
      const order = orderByIdStatement.get(orderId);
      const conversation = event ? conversationStatement.get(event.id, phone) : null;
      if (!event || !order || !conversation || Number(conversation.pedido_id) !== orderId) {
        sendJson(response, 403, { erro: 'O comprovante nao pertence a esta conversa.' });
        return;
      }
      if (order.status_pagamento !== 'pendente' || order.status !== 'aguardando_pagamento') {
        sendJson(response, 409, { erro: 'Este pedido nao esta aguardando comprovante.' });
        return;
      }
      const base64 = normalizeText(body.arquivo_base64, 7_000_000).replace(/^data:[^;]+;base64,/, '');
      const file = Buffer.from(base64, 'base64');
      if (!file.length || file.length > 5_000_000) {
        sendJson(response, 400, { erro: 'O arquivo deve possuir no maximo 5 MB.' });
        return;
      }
      const receiptId = randomUUID();
      const filePath = join(receiptsFolder, `${receiptId}.${allowedTypes[mimeType]}`);
      const timestamp = new Date().toISOString();
      writeFileSync(filePath, file, { flag: 'wx' });
      database.exec('BEGIN IMMEDIATE');
      try {
        insertReceiptStatement.run(receiptId, orderId, originalName, mimeType, filePath, file.length, timestamp);
        database.prepare(`
          UPDATE pedidos SET comprovante_id = ?, status = 'pagamento_em_analise',
            status_pagamento = 'em_analise', atualizado_em = ? WHERE id = ?
        `).run(receiptId, timestamp, orderId);
        database.prepare(`
          UPDATE conversas SET estado = 'pagamento_em_analise', atualizado_em = ? WHERE pedido_id = ?
        `).run(timestamp, orderId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 201, {
        recebido: true,
        comprovante_id: receiptId,
        estado: 'pagamento_em_analise',
        resposta: 'Comprovante recebido. O pagamento sera analisado antes da liberacao do ingresso.',
      });
    } catch (error) {
      sendJson(response, 400, { erro: error.message });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/admin/pedidos') {
    const status = normalizeText(url.searchParams.get('status_pagamento'), 30) || 'em_analise';
    const orders = pendingPaymentsStatement.all(status).map((order) => ({
      ...order,
      valor_total: (Number(order.valor_total_centavos) / 100).toFixed(2).replace('.', ','),
    }));
    sendJson(response, 200, { quantidade: orders.length, pedidos: orders });
    return;
  }

  const receiptMatch = url.pathname.match(/^\/admin\/comprovantes\/([a-f0-9-]+)$/);
  if (request.method === 'GET' && receiptMatch) {
    const receipt = receiptByIdStatement.get(receiptMatch[1]);
    if (!receipt) {
      sendJson(response, 404, { erro: 'Comprovante nao encontrado.' });
      return;
    }
    response.writeHead(200, {
      'Content-Type': receipt.tipo_mime,
      'Content-Disposition': `inline; filename="${receipt.nome_original.replaceAll('"', '')}"`,
      'Cache-Control': 'no-store',
    });
    response.end(readFileSync(receipt.caminho));
    return;
  }

  const paymentDecisionMatch = url.pathname.match(/^\/admin\/pedidos\/(\d+)\/pagamento$/);
  if (request.method === 'POST' && paymentDecisionMatch) {
    try {
      const orderId = Number(paymentDecisionMatch[1]);
      const body = await readJson(request);
      const decision = normalizeText(body.decisao, 20);
      const reviewer = normalizeText(body.responsavel, 150) || 'Administrador local';
      const note = normalizeText(body.observacao, 1000);
      if (!['aprovar', 'recusar'].includes(decision)) {
        sendJson(response, 400, { erro: 'Use a decisao aprovar ou recusar.' });
        return;
      }
      const order = orderByIdStatement.get(orderId);
      if (!order || order.status_pagamento !== 'em_analise') {
        sendJson(response, 409, { erro: 'O pedido nao esta aguardando analise.' });
        return;
      }
      const timestamp = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        if (decision === 'aprovar') {
          database.prepare(`
            UPDATE pedidos SET status = 'concluido', status_pagamento = 'aprovado',
              aprovado_em = ?, aprovado_por = ?, observacoes = ?, atualizado_em = ? WHERE id = ?
          `).run(timestamp, reviewer, note, timestamp, orderId);
          database.prepare(`
            UPDATE lotes SET quantidade_reservada = MAX(quantidade_reservada - ?, 0),
              quantidade_vendida = quantidade_vendida + ?, atualizado_em = ? WHERE id = ?
          `).run(order.quantidade, order.quantidade, timestamp, order.lote_id);
          database.prepare("UPDATE participantes SET status_ingresso = 'valido', atualizado_em = ? WHERE pedido_id = ?")
            .run(timestamp, orderId);
          database.prepare("UPDATE conversas SET estado = 'concluido', atualizado_em = ? WHERE pedido_id = ?")
            .run(timestamp, orderId);
        } else {
          database.prepare(`
            UPDATE pedidos SET status = 'pagamento_recusado', status_pagamento = 'recusado',
              aprovado_por = ?, observacoes = ?, atualizado_em = ? WHERE id = ?
          `).run(reviewer, note, timestamp, orderId);
          database.prepare(`
            UPDATE lotes SET quantidade_reservada = MAX(quantidade_reservada - ?, 0), atualizado_em = ? WHERE id = ?
          `).run(order.quantidade, timestamp, order.lote_id);
          database.prepare("UPDATE participantes SET status_ingresso = 'cancelado', atualizado_em = ? WHERE pedido_id = ?")
            .run(timestamp, orderId);
          database.prepare("UPDATE conversas SET estado = 'pagamento_recusado', atualizado_em = ? WHERE pedido_id = ?")
            .run(timestamp, orderId);
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      sendJson(response, 200, {
        atualizado: true,
        pedido_id: orderId,
        status_pagamento: decision === 'aprovar' ? 'aprovado' : 'recusado',
      });
    } catch (error) {
      sendJson(response, 400, { erro: error.message });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/exportar') {
    const csv = createCsv(allStatement.all());
    response.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="atendimentos.csv"',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(csv);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/atendimentos') {
    try {
      const body = await readJson(request);
      const record = {
        data_hora: normalizeText(body.data_hora, 50) || new Date().toISOString(),
        telefone: normalizeText(body.telefone, 30),
        nome: normalizeText(body.nome, 150),
        mensagem: normalizeText(body.mensagem, 5000),
        origem: normalizeText(body.origem, 100) || 'n8n',
        status: normalizeText(body.status, 100) || 'recebido',
        resposta: normalizeText(body.resposta, 5000),
        id_mensagem: normalizeText(body.id_mensagem, 200) || randomUUID(),
      };

      const missing = ['telefone', 'nome', 'mensagem'].filter((field) => !record[field]);
      if (missing.length > 0) {
        sendJson(response, 400, {
          erro: 'Campos obrigatorios ausentes.',
          campos: missing,
        });
        return;
      }

      const result = insertStatement.run(
        record.data_hora,
        record.telefone,
        record.nome,
        record.mensagem,
        record.origem,
        record.status,
        record.resposta,
        record.id_mensagem,
      );

      sendJson(response, 201, {
        salvo: true,
        id: Number(result.lastInsertRowid),
        registro: record,
      });
    } catch (error) {
      const duplicated = String(error.message).includes('UNIQUE constraint failed');
      sendJson(response, duplicated ? 409 : 400, {
        erro: duplicated ? 'Este id_mensagem ja foi registrado.' : error.message,
      });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/simular-mensagem') {
    if (!simulatorEnabled) {
      sendJson(response, 404, { erro: 'Rota nao encontrada.' });
      return;
    }
    try {
      const body = await readJson(request);
      const payload = {
        telefone: normalizeText(body.telefone, 30),
        nome: normalizeText(body.nome, 150),
        mensagem: normalizeText(body.mensagem, 5000),
        evento_codigo: normalizeText(body.evento_codigo, 100).toLowerCase(),
        origem: normalizeText(body.origem, 100) || 'simulador_local',
        id_mensagem: normalizeText(body.id_mensagem, 200) || randomUUID(),
      };

      const missing = ['telefone', 'nome', 'mensagem', 'evento_codigo'].filter((field) => !payload[field]);
      if (missing.length > 0) {
        sendJson(response, 400, { erro: 'Selecione o evento e preencha nome, telefone e mensagem.', campos: missing });
        return;
      }

      const selectedEvent = eventByCodeStatement.get(payload.evento_codigo);
      if (!selectedEvent) {
        sendJson(response, 404, { erro: 'O evento selecionado nao foi encontrado.' });
        return;
      }
      if (selectedEvent.status !== 'vendas_abertas') {
        sendJson(response, 409, { erro: 'As vendas deste evento nao estao abertas.' });
        return;
      }
      const selectedLot = currentLot(lotsByEventStatement.all(selectedEvent.id));
      if (!selectedLot) {
        sendJson(response, 409, { erro: 'Este evento nao possui lote disponivel no momento.' });
        return;
      }
      const lotForSale = publicLot(selectedLot);
      const payloadForN8n = {
        ...payload,
        evento_id: selectedEvent.id,
        evento_nome: selectedEvent.nome,
        lote_id: selectedLot.id,
        lote_nome: selectedLot.nome,
        valor_unitario_centavos: selectedLot.valor_centavos,
      };

      const n8nResponse = await fetch(n8nWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payloadForN8n),
      });
      const responseText = await n8nResponse.text();

      if (!n8nResponse.ok) {
        sendJson(response, 502, {
          erro: 'O n8n nao conseguiu processar a mensagem.',
          detalhe: responseText.slice(0, 500),
        });
        return;
      }

      let n8nResult;
      try {
        n8nResult = JSON.parse(responseText);
      } catch {
        n8nResult = { recebido: true };
      }

      const conversationResult = processConversation({
        event: selectedEvent,
        lot: selectedLot,
        payload,
      });
      sendJson(response, 200, {
        ...n8nResult,
        ...conversationResult,
        evento: publicEvent(selectedEvent),
        lote: lotForSale,
      });
    } catch (error) {
      sendJson(response, 400, { erro: error.message });
    }
    return;
  }

  sendJson(response, 404, {
    erro: 'Rota nao encontrada.',
    rotas: [
      'GET /simulador',
      'GET /admin',
      'POST /simular-mensagem',
      'POST /admin/eventos',
      'POST /admin/eventos/:codigo/lotes',
      'GET /admin/eventos/:codigo/participantes-confirmados',
      'GET /admin/eventos/:codigo/exportar-participantes.csv',
      'GET /admin/eventos/:codigo/check-in?busca=',
      'POST /admin/eventos/:codigo/check-in',
      'POST /comprovantes',
      'GET /admin/pedidos',
      'GET /admin/comprovantes/:id',
      'POST /admin/pedidos/:id/pagamento',
      'GET /eventos',
      'GET /eventos/:codigo',
      'GET /eventos/:codigo/lote-atual',
      'GET /saude',
      'POST /atendimentos',
      'GET /atendimentos',
      'GET /exportar',
    ],
  });
};

const server = createHttpServer(requestListener);
const secureServer = tlsCertificatePath && tlsKeyPath
  ? createHttpsServer({
      cert: readFileSync(tlsCertificatePath),
      key: readFileSync(tlsKeyPath),
    }, requestListener)
  : null;

server.listen(port, host, () => {
  console.log(`API local iniciada em http://${host}:${port}`);
  console.log(`Banco de dados: ${databasePath}`);
});

secureServer?.listen(httpsPort, httpsHost, () => {
  console.log(`HTTPS local iniciado em https://${httpsHost}:${httpsPort}`);
});

function closeServer() {
  let pendingServers = secureServer ? 2 : 1;
  const afterClose = () => {
    pendingServers -= 1;
    if (pendingServers === 0) {
      database.close();
      process.exit(0);
    }
  };
  server.close(afterClose);
  secureServer?.close(afterClose);
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
