import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { readBody, requestBodyError } from './body.mjs';
import { verifyHubSignature } from './meta-signature.mjs';

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}/whatsapp-webhook`,
  };
}

test('corpo acima de 1 MB responde 413 e nao chega ao HMAC', async () => {
  let signatureChecked = false;
  const { server, url } = await listen(async (request, response) => {
    try {
      const rawBody = await readBody(request);
      signatureChecked = true;
      verifyHubSignature(rawBody, request.headers['x-hub-signature-256'], 'segredo-de-teste');
      response.writeHead(200);
      response.end('ok');
    } catch (error) {
      const failure = requestBodyError(error);
      response.writeHead(failure.statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(failure.message);
    }
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.alloc(1_000_001, 1),
    });
    assert.equal(response.status, 413);
    assert.equal(await response.text(), 'Corpo da requisicao muito grande.');
    assert.equal(signatureChecked, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('corpo de exatamente 1 MB segue para o HMAC', async () => {
  let receivedLength = 0;
  const { server, url } = await listen(async (request, response) => {
    try {
      const rawBody = await readBody(request);
      receivedLength = rawBody.length;
      verifyHubSignature(rawBody, request.headers['x-hub-signature-256'], 'segredo-de-teste');
      response.writeHead(200);
      response.end('ok');
    } catch (error) {
      const failure = requestBodyError(error);
      response.writeHead(failure.statusCode);
      response.end(failure.message);
    }
  });

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: Buffer.alloc(1_000_000, 1),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedLength, 1_000_000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
