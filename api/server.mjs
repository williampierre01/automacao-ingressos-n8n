import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { adminAuthorized, requireSecret } from './auth.mjs';
import { processarEntrada } from './entrada.mjs';
import { apagarEntregues, listarFalhas, montarCorpoSimulador, reenfileirar, resumoFila, reterCorpos, retencaoDias } from './fila-whatsapp.mjs';
import { rodarRotinas } from './rotinas.mjs';
import {
  MENSAGEM_ESGOTADO,
  MENSAGEM_PAUSADA,
  aprovarPagamento,
  descontosParaGravar,
  expirarReservas,
  garantirEventoDemonstracao,
  listarViradasPendentes,
  lotePublico,
  marcarAnunciada,
  migrar,
  recusarPagamento,
  registrarComprovante,
  situacaoLotes,
} from './lotes.mjs';

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
const viradaWebhook = process.env.N8N_VIRADA_LOTE_WEBHOOK_URL || '';
const simulatorEnabled = process.env.SIMULADOR_ATIVO === '1';

if (Boolean(tlsCertificatePath) !== Boolean(tlsKeyPath)) {
  throw new Error('Informe API_TLS_CERT_PATH e API_TLS_KEY_PATH juntos para ativar HTTPS.');
}

const adminToken = requireSecret('ADMIN_TOKEN');
const internalToken = requireSecret('API_INTERNAL_TOKEN');

mkdirSync(dataFolder, { recursive: true });
mkdirSync(receiptsFolder, { recursive: true });

const database = new DatabaseSync(databasePath);
database.exec('PRAGMA busy_timeout = 5000');
database.exec(readFileSync(schemaPath, 'utf8'));
migrar(database, { databasePath });
garantirEventoDemonstracao(database);

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
    capacidade_total, capacidade_maxima_evento, limite_por_comprador,
    max_ingressos_por_pessoa, prazo_reserva_minutos, documento_obrigatorio, status
  FROM eventos
  ORDER BY data_evento ASC, id ASC
`);

const eventByCodeStatement = database.prepare(`
  SELECT * FROM eventos WHERE codigo = ?
`);

const lotsByEventStatement = database.prepare(`
  SELECT * FROM lotes WHERE evento_id = ? ORDER BY ordem ASC, id ASC
`);

const createEventStatement = database.prepare(`
  INSERT INTO eventos (
    codigo, nome, descricao, organizador, data_evento, horario, local, endereco,
    inicio_vendas, fim_vendas, capacidade_total, capacidade_maxima_evento,
    limite_por_comprador, max_ingressos_por_pessoa, prazo_reserva_minutos,
    descontos_quantidade_json, pix_chave, pix_tipo, pix_favorecido, contato_humano,
    mensagem_boas_vindas, orientacoes_entrada, politica_cancelamento,
    texto_privacidade, documento_obrigatorio, status, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const createLotStatement = database.prepare(`
  INSERT INTO lotes (
    evento_id, nome, valor_centavos, inicio, fim, quantidade_total,
    ativo, ordem, status, criado_em, atualizado_em
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const receiptByIdStatement = database.prepare('SELECT * FROM comprovantes WHERE id = ?');
const pendingPaymentsStatement = database.prepare(`
  SELECT
    p.id, p.protocolo, p.comprador_nome, p.comprador_telefone, p.quantidade,
    p.valor_total_centavos, p.status, p.status_pagamento, p.comprovante_id,
    p.recebido_apos_expirar, p.observacoes, p.criado_em, e.nome AS evento_nome, l.nome AS lote_nome,
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
    const lots = lotsByEventStatement.all(event.id).map(lotePublico);
    const situacao = situacaoLotes(lots);
    sendJson(response, 200, {
      evento: publicEvent(event),
      lotes: lots,
      situacao: situacao.tipo,
      lote_atual: situacao.tipo === 'vigente' ? lotePublico(situacao.lote) : null,
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
    const situacao = situacaoLotes(lotsByEventStatement.all(event.id));
    if (situacao.tipo === 'pausado') {
      sendJson(response, 409, { erro: MENSAGEM_PAUSADA, situacao: situacao.tipo });
      return;
    }
    if (situacao.tipo === 'esgotado') {
      sendJson(response, 409, { erro: MENSAGEM_ESGOTADO, situacao: situacao.tipo });
      return;
    }
    if (situacao.tipo !== 'vigente') {
      sendJson(response, 404, { erro: 'Nao existe lote disponivel neste momento.', situacao: situacao.tipo });
      return;
    }
    sendJson(response, 200, { evento: publicEvent(event), lote: lotePublico(situacao.lote), situacao: situacao.tipo });
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
        capacidade_maxima_evento: body.capacidade_maxima_evento === undefined || body.capacidade_maxima_evento === null || body.capacidade_maxima_evento === ''
          ? null
          : nonNegativeInteger(body.capacidade_maxima_evento, -1),
        max_ingressos_por_pessoa: body.max_ingressos_por_pessoa === undefined || body.max_ingressos_por_pessoa === null || body.max_ingressos_por_pessoa === ''
          ? null
          : positiveInteger(body.max_ingressos_por_pessoa, 0),
        prazo_reserva_minutos: positiveInteger(body.prazo_reserva_minutos, 60),
        descontos_quantidade_json: descontosParaGravar(body.descontos_quantidade_json),
        pix_chave: normalizeText(body.pix_chave, 300),
        pix_tipo: normalizeText(body.pix_tipo, 50),
        pix_favorecido: normalizeText(body.pix_favorecido, 200),
        contato_humano: normalizeText(body.contato_humano, 100),
        mensagem_boas_vindas: normalizeText(body.mensagem_boas_vindas, 1000),
        orientacoes_entrada: normalizeText(body.orientacoes_entrada, 2000),
        politica_cancelamento: normalizeText(body.politica_cancelamento, 2000),
        texto_privacidade: normalizeText(body.texto_privacidade, 2000),
        documento_obrigatorio: body.documento_obrigatorio === true ? 1 : 0,
        limite_por_comprador: positiveInteger(body.max_ingressos_por_pessoa, 10),
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
      if (event.capacidade_maxima_evento === -1 || event.max_ingressos_por_pessoa === 0) {
        sendJson(response, 400, { erro: 'Capacidade maxima e limite por telefone precisam ser numeros validos.' });
        return;
      }

      const result = createEventStatement.run(
        event.codigo, event.nome, event.descricao, event.organizador, event.data_evento,
        event.horario, event.local, event.endereco, event.inicio_vendas, event.fim_vendas,
        event.capacidade_total, event.capacidade_maxima_evento, event.limite_por_comprador,
        event.max_ingressos_por_pessoa, event.prazo_reserva_minutos, event.descontos_quantidade_json,
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
      const ordem = Number(database.prepare(`
        SELECT COALESCE(MAX(ordem), 0) AS ordem FROM lotes WHERE evento_id = ?
      `).get(event.id).ordem) + 1;
      const ativo = body.ativo === 0 || body.ativo === '0' || body.ativo === false ? 0 : 1;
      const result = createLotStatement.run(
        event.id,
        name,
        priceInCents,
        normalizeText(body.inicio, 50) || null,
        normalizeText(body.fim, 50) || null,
        quantity,
        ativo,
        ordem,
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
      const base64 = normalizeText(body.arquivo_base64, 7_000_000).replace(/^data:[^;]+;base64,/, '');
      const file = Buffer.from(base64, 'base64');
      if (!file.length || file.length > 5_000_000) {
        sendJson(response, 400, { erro: 'O arquivo deve possuir no maximo 5 MB.' });
        return;
      }
      const receiptId = randomUUID();
      const filePath = join(receiptsFolder, `${receiptId}.${allowedTypes[mimeType]}`);
      writeFileSync(filePath, file, { flag: 'wx' });
      try {
        const registrado = registrarComprovante(database, {
          pedidoId: orderId,
          telefone: phone,
          eventoCodigo: eventCode,
          comprovanteId: receiptId,
          nomeOriginal: originalName,
          tipoMime: mimeType,
          caminho: filePath,
          tamanhoBytes: file.length,
        });
        sendJson(response, 201, {
          recebido: true,
          comprovante_id: receiptId,
          estado: 'pagamento_em_analise',
          recebido_apos_expirar: registrado.tardio,
          resposta: registrado.tardio
            ? 'Comprovante recebido apos o prazo. O pagamento sera analisado e o preco da reserva continua valendo.'
            : 'Comprovante recebido. O pagamento sera analisado antes da liberacao do ingresso.',
        });
      } catch (error) {
        try { unlinkSync(filePath); } catch { /* o arquivo pode ja ter sido removido */ }
        throw error;
      }
    } catch (error) {
      const statusCode = error.codigo === 'PROIBIDO' ? 403 : error.codigo === 'CONFLITO' ? 409 : 400;
      sendJson(response, statusCode, { erro: error.message });
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
      if (decision === 'aprovar') {
        const resultado = await aprovarPagamento(database, {
          pedidoId: orderId,
          responsavel: reviewer,
          observacao: note,
          webhookUrl: viradaWebhook,
        });
        sendJson(response, 200, {
          atualizado: true,
          pedido_id: orderId,
          status_pagamento: 'aprovado',
          virada: resultado.virada ? { id: resultado.virada.id, tipo: resultado.virada.tipo } : null,
        });
      } else {
        recusarPagamento(database, { pedidoId: orderId, responsavel: reviewer, observacao: note });
        sendJson(response, 200, {
          atualizado: true,
          pedido_id: orderId,
          status_pagamento: 'recusado',
        });
      }
    } catch (error) {
      sendJson(response, error.codigo === 'CONFLITO' ? 409 : 400, { erro: error.message });
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

  if (request.method === 'POST' && url.pathname === '/interno/mensagem') {
    if (!adminAuthorized(request.headers.authorization, internalToken)) {
      sendJson(response, 401, { erro: 'Nao autorizado.' });
      return;
    }
    try {
      const body = await readJson(request);
      const resultado = processarEntrada(database, {
        telefone: normalizeText(body.telefone, 30),
        nome: normalizeText(body.nome, 150),
        tipo: normalizeText(body.tipo, 30),
        texto: normalizeText(body.texto, 5000),
        id_mensagem: normalizeText(body.id_mensagem, 200),
        timestamp: normalizeText(body.timestamp, 40),
        origem: normalizeText(body.origem, 100) || 'whatsapp',
        evento_codigo: normalizeText(body.evento_codigo, 100).toLowerCase(),
      });
      if (resultado.statusCode) {
        sendJson(response, resultado.statusCode, { erro: resultado.erro });
        return;
      }
      sendJson(response, 200, resultado);
    } catch (error) {
      sendJson(response, 500, { erro: 'Nao foi possivel processar a mensagem.' });
      console.error(`Falha em /interno/mensagem: ${error.message}`);
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
        origem: normalizeText(body.origem, 100) || 'simulador',
        id_mensagem: normalizeText(body.id_mensagem, 200) || randomUUID(),
      };

      const missing = ['telefone', 'nome', 'mensagem', 'evento_codigo'].filter((field) => !payload[field]);
      if (missing.length > 0) {
        sendJson(response, 400, { erro: 'Selecione o evento e preencha nome, telefone e mensagem.', campos: missing });
        return;
      }

      const n8nResponse = await fetch(n8nWebhook, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${internalToken}`,
        },
        body: JSON.stringify(montarCorpoSimulador({
          telefone: payload.telefone,
          nome: payload.nome,
          texto: payload.mensagem,
          id_mensagem: payload.id_mensagem,
          origem: payload.origem,
          evento_codigo: payload.evento_codigo,
          usar_porta_teste: body.usar_porta_teste,
          porta_api: body.porta_api,
        }, {
          porta: port,
          usarPortaTeste: process.env.USAR_PORTA_TESTE === '1',
        })),
        signal: AbortSignal.timeout(30_000),
      });
      const responseText = await n8nResponse.text();
      let n8nResult = {};
      try {
        n8nResult = responseText ? JSON.parse(responseText) : {};
      } catch {
        n8nResult = { erro: 'O n8n nao devolveu JSON.' };
      }
      if (n8nResponse.status === 401) {
        sendJson(response, 502, { erro: 'O n8n recusou o webhook.' });
        return;
      }
      if (!n8nResponse.ok) {
        sendJson(response, n8nResponse.status >= 400 ? n8nResponse.status : 502, {
          erro: n8nResult.erro || 'O n8n nao conseguiu processar a mensagem.',
        });
        return;
      }
      sendJson(response, 200, n8nResult);
    } catch (error) {
      if (error.name === 'TimeoutError') {
        sendJson(response, 504, { erro: 'O n8n nao respondeu em 30 segundos.' });
        return;
      }
      const validacao = error.message === 'JSON invalido.' || error.message === 'Corpo da requisicao muito grande.';
      sendJson(response, validacao ? 400 : 502, {
        erro: validacao ? error.message : 'O n8n nao conseguiu processar a mensagem.',
      });
    }
    return;
  }

  if (request.method === 'GET' && url.pathname === '/admin/viradas') {
    sendJson(response, 200, { viradas: listarViradasPendentes(database) });
    return;
  }

  const announcedMatch = url.pathname.match(/^\/admin\/viradas\/(\d+)\/anunciada$/);
  if (request.method === 'POST' && announcedMatch) {
    try {
      const marcada = marcarAnunciada(database, Number(announcedMatch[1]));
      sendJson(response, 200, marcada);
    } catch (error) {
      sendJson(response, error.codigo === 'NAO_ENCONTRADA' ? 404 : 400, { erro: error.message });
    }
    return;
  }

  if (request.method === 'POST' && url.pathname === '/admin/reservas/expirar') {
    sendJson(response, 200, expirarReservas(database));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/admin/whatsapp/fila') {
    sendJson(response, 200, { itens: listarFalhas(database), ...resumoFila(database) });
    return;
  }

  const reenfileirarMatch = url.pathname.match(/^\/admin\/whatsapp\/fila\/(\d+)\/reenfileirar$/);
  if (request.method === 'POST' && reenfileirarMatch) {
    try {
      const confirmar = url.searchParams.get('confirmar') === '1';
      sendJson(response, 200, reenfileirar(database, Number(reenfileirarMatch[1]), { confirmar }));
    } catch (error) {
      const status = error.codigo === 'NAO_ENCONTRADA'
        ? 404
        : error.codigo === 'EXPIRADO' || error.codigo === 'CONFIRMAR'
          ? 409
          : 400;
      sendJson(response, status, {
        erro: error.message,
        ...(error.codigo === 'CONFIRMAR' ? { exige_confirmacao: true } : {}),
      });
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
      'GET /admin/viradas',
      'POST /admin/viradas/:id/anunciada',
      'POST /admin/reservas/expirar',
      'GET /admin/whatsapp/fila',
      'POST /admin/whatsapp/fila/:id/reenfileirar',
      'POST /interno/mensagem',
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

const expirationTimer = setInterval(() => {
  rodarRotinas([
    () => expirarReservas(database),
    () => {
      reterCorpos(database, retencaoDias());
      apagarEntregues(database, retencaoDias());
    },
  ], (error) => {
    console.error(`Falha na rotina periodica: ${error.message}`);
  });
}, 60_000);
expirationTimer.unref();

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
  clearInterval(expirationTimer);
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
