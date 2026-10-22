import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { requireSecret, tokensMatch } from './auth.mjs';
import { readBody, requestBodyError } from './body.mjs';
import { normalizarWebhook } from './entrada.mjs';
import { aplicarStatuses } from './custo-whatsapp.mjs';
import {
  enfileirar,
  exigirBancoPronto,
  maxTentativas,
  processarProxima,
  retomarProcessando,
} from './fila-whatsapp.mjs';
import { emTransacao } from './lotes.mjs';
import { verifyHubSignature } from './meta-signature.mjs';

const apiFolder = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(apiFolder);

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

export function abrirBancoGateway(databasePath) {
  if (!existsSync(databasePath)) throw new Error('suba a API primeiro');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA journal_mode = WAL');
    exigirBancoPronto(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function receberEvento(database, rawBody, {
  signature,
  appSecret,
  eventoCodigo = '',
  agora = new Date(),
} = {}) {
  if (!verifyHubSignature(rawBody, signature, appSecret)) {
    return { status: 401, texto: 'Assinatura invalida.' };
  }
  let json;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return { status: 400, texto: `Requisicao invalida: ${error.message}` };
  }
  const normalizado = normalizarWebhook(json, agora);
  try {
    const resultado = emTransacao(database, () => {
      const custo = aplicarStatuses(database, json, agora);
      const fila = normalizado.mensagens.length > 0
        ? enfileirar(database, normalizado.mensagens, { origem: 'whatsapp', eventoCodigo, agora })
        : { novas: 0 };
      return { custo, fila };
    });
    return {
      status: 200,
      json: {
        recebido: true,
        ignorado: normalizado.mensagens.length === 0,
        enfileiradas: resultado.fila.novas,
        custos: resultado.custo.gravados,
      },
    };
  } catch (error) {
    console.error(`Falha ao gravar webhook: ${error.message}`);
    return { status: 500, texto: 'Falha ao gravar o evento.' };
  }
}

export function criarGateway({ database, appSecret, verifyToken, eventoCodigo = '' }) {
  return createServer(async (request, response) => {
    const startedAt = Date.now();
    response.on('finish', () => {
      const duration = Date.now() - startedAt;
      console.log(`${request.method} ${request.url?.split('?')[0]} -> ${response.statusCode} (${duration} ms)`);
    });

    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/whatsapp-webhook') {
      sendText(response, 404, 'Rota nao encontrada.');
      return;
    }

    if (request.method === 'GET') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && tokensMatch(token || '', verifyToken) && challenge) {
        sendText(response, 200, challenge);
      } else {
        sendText(response, 403, 'Verificacao recusada.');
      }
      return;
    }

    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'GET, POST' });
      response.end();
      return;
    }

    try {
      const rawBody = await readBody(request);
      const resultado = receberEvento(database, rawBody, {
        signature: request.headers['x-hub-signature-256'],
        appSecret,
        eventoCodigo,
      });
      if (resultado.texto) {
        sendText(response, resultado.status, resultado.texto);
        return;
      }
      sendJson(response, resultado.status, resultado.json);
    } catch (error) {
      const failure = requestBodyError(error);
      const message = failure.statusCode === 413
        ? failure.message
        : `Requisicao invalida: ${failure.message}`;
      sendText(response, failure.statusCode, message);
    }
  });
}

export async function entregarAoN8n(mensagem, webhookUrl, token) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(mensagem),
    signal: AbortSignal.timeout(45_000),
  });
  const texto = await response.text();
  let erro = '';
  try {
    const json = texto ? JSON.parse(texto) : {};
    if (typeof json?.erro === 'string') erro = json.erro;
  } catch {
    erro = '';
  }
  return { status: response.status, erro };
}

export function iniciarWorker(database, {
  entregar,
  portaApi = '8000',
  usarPortaTeste = false,
  intervaloMs = 1000,
} = {}) {
  retomarProcessando(database);
  let parado = false;
  let timer = null;
  const ciclo = async () => {
    if (parado) return;
    let espera = intervaloMs;
    try {
      const resultado = await processarProxima(database, {
        entregar,
        maximo: maxTentativas(),
        portaApi,
        usarPortaTeste,
      });
      if (resultado.processou) espera = 0;
    } catch (error) {
      console.error(`Falha na fila: ${error.message}`);
    } finally {
      if (!parado) timer = setTimeout(ciclo, espera);
    }
  };
  timer = setTimeout(ciclo, 0);
  return () => {
    parado = true;
    clearTimeout(timer);
  };
}

function executadoDireto() {
  const entrada = process.argv[1];
  if (!entrada) return false;
  return import.meta.url === pathToFileURL(entrada).href;
}

if (executadoDireto()) {
  const appSecret = requireSecret('META_APP_SECRET');
  const internalToken = requireSecret('API_INTERNAL_TOKEN');
  const databasePath = process.env.API_DATABASE_PATH || join(projectRoot, 'data', 'atendimentos.sqlite');
  let database;
  try {
    database = abrirBancoGateway(databasePath);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const tokenFile = join(projectRoot, 'work', 'whatsapp', 'verify-token.txt');
  const verifyToken = readFileSync(tokenFile, 'utf8').trim();
  if (!verifyToken) {
    console.error('O token de verificacao do WhatsApp esta vazio.');
    process.exit(1);
  }
  const host = '127.0.0.1';
  const port = Number(process.env.GATEWAY_PORT) || 8001;
  const webhook = process.env.N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/whatsapp-mensagens';
  const portaApi = process.env.API_PORT || '8000';
  const eventoCodigo = process.env.WHATSAPP_EVENTO_CODIGO || '';
  const pararWorker = iniciarWorker(database, {
    portaApi,
    usarPortaTeste: process.env.USAR_PORTA_TESTE === '1',
    entregar: (mensagem) => entregarAoN8n(mensagem, webhook, internalToken),
  });
  const server = criarGateway({ database, appSecret, verifyToken, eventoCodigo });
  server.listen(port, host, () => {
    console.log(`Gateway do WhatsApp ativo em http://${host}:${port}/whatsapp-webhook`);
    console.log('Somente a rota do webhook sera exposta pelo tunel.');
  });

  function closeServer() {
    pararWorker();
    server.close(() => {
      database.close();
      process.exit(0);
    });
  }

  process.on('SIGINT', closeServer);
  process.on('SIGTERM', closeServer);
}
