import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireSecret, tokensMatch } from './auth.mjs';
import { readBody, requestBodyError } from './body.mjs';
import { verifyHubSignature } from './meta-signature.mjs';

const appSecret = requireSecret('META_APP_SECRET');
const apiFolder = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(apiFolder);
const tokenFile = join(projectRoot, 'work', 'whatsapp', 'verify-token.txt');
const verifyToken = readFileSync(tokenFile, 'utf8').trim();
const host = '127.0.0.1';
const port = 8001;
const n8nWebhook = 'http://127.0.0.1:5678/webhook/whatsapp-mensagens';

if (!verifyToken) {
  throw new Error('O token de verificacao do WhatsApp esta vazio.');
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  const startedAt = Date.now();
  response.on('finish', () => {
    const duration = Date.now() - startedAt;
    console.log(`${request.method} ${request.url?.split('?')[0]} -> ${response.statusCode} (${duration} ms)`);
  });

  const url = new URL(request.url || '/', `http://${request.headers.host || `${host}:${port}`}`);

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

  if (request.method === 'POST') {
    try {
      const rawBody = await readBody(request);
      if (!verifyHubSignature(rawBody, request.headers['x-hub-signature-256'], appSecret)) {
        sendText(response, 401, 'Assinatura invalida.');
        return;
      }
      JSON.parse(rawBody.toString('utf8'));

      const n8nResponse = await fetch(n8nWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: rawBody,
      });
      const responseBody = await n8nResponse.text();

      response.writeHead(n8nResponse.status, {
        'Content-Type': n8nResponse.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.end(responseBody);
    } catch (error) {
      const failure = requestBodyError(error);
      const message = failure.statusCode === 413
        ? failure.message
        : `Requisicao invalida: ${failure.message}`;
      sendText(response, failure.statusCode, message);
    }
    return;
  }

  response.writeHead(405, { Allow: 'GET, POST' });
  response.end();
});

server.listen(port, host, () => {
  console.log(`Gateway do WhatsApp ativo em http://${host}:${port}/whatsapp-webhook`);
  console.log('Somente a rota do webhook sera exposta pelo tunel.');
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', closeServer);
process.on('SIGTERM', closeServer);
