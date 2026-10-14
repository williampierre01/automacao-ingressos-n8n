import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { signHubBody, verifyHubSignature } from './meta-signature.mjs';

const secret = 'app-secret-de-teste';
const rawBody = Buffer.from('{"evento":"mensagem","texto":"ola"}');

function signatureFor(body, key = secret) {
  return `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
}

test('HMAC valido aceita o corpo bruto', () => {
  assert.equal(verifyHubSignature(rawBody, signatureFor(rawBody), secret), true);
  assert.equal(signHubBody(rawBody, secret), signatureFor(rawBody));
});

test('HMAC invalido rejeita outra chave', () => {
  assert.equal(verifyHubSignature(rawBody, signatureFor(rawBody, 'outra-chave'), secret), false);
  assert.equal(verifyHubSignature(rawBody, 'sha256=00', secret), false);
});

test('HMAC ausente rejeita', () => {
  assert.equal(verifyHubSignature(rawBody, undefined, secret), false);
  assert.equal(verifyHubSignature(rawBody, '', secret), false);
});

test('corpo adulterado nao confere com a assinatura original', () => {
  const header = signatureFor(rawBody);
  const tampered = Buffer.from(`${rawBody.toString('utf8')} `);
  assert.equal(verifyHubSignature(tampered, header, secret), false);
});

test('JSON reserializado nao substitui o corpo bruto', () => {
  const spaced = Buffer.from('{ "evento" : "mensagem" }');
  const header = signatureFor(spaced);
  const reserialized = Buffer.from(JSON.stringify(JSON.parse(spaced.toString('utf8'))));
  assert.equal(spaced.equals(reserialized), false);
  assert.equal(verifyHubSignature(reserialized, header, secret), false);
  assert.equal(verifyHubSignature(spaced, header, secret), true);
});

test('POST sem assinatura valida responde 401 e nao trata o JSON', async () => {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (!verifyHubSignature(body, request.headers['x-hub-signature-256'], secret)) {
      response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Assinatura invalida.');
      return;
    }
    JSON.parse(body.toString('utf8'));
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/whatsapp-webhook`;

  async function post(body, header) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(header ? { 'X-Hub-Signature-256': header } : {}),
      },
      body,
    });
  }

  try {
    const valid = await post(rawBody, signatureFor(rawBody));
    const invalid = await post(rawBody, signatureFor(rawBody, 'outra-chave'));
    const missing = await post(rawBody);
    const tampered = await post(Buffer.from(`${rawBody.toString('utf8')} `), signatureFor(rawBody));
    assert.equal(valid.status, 200);
    assert.equal(invalid.status, 401);
    assert.equal(missing.status, 401);
    assert.equal(tampered.status, 401);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('o gateway nao sobe sem META_APP_SECRET', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, ['api/whatsapp-gateway.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      META_APP_SECRET: '',
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /META_APP_SECRET nao definido/);
});
