import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adminAuthorized, requireSecret } from './auth.mjs';

const expectedToken = 'segredo-de-teste';

test('sem token nao autoriza', () => {
  assert.equal(adminAuthorized(undefined, expectedToken), false);
  assert.equal(adminAuthorized('', expectedToken), false);
  assert.equal(adminAuthorized('Bearer', expectedToken), false);
  assert.equal(adminAuthorized('Basic segredo-de-teste', expectedToken), false);
});

test('token errado nao autoriza', () => {
  assert.equal(adminAuthorized('Bearer outro-valor', expectedToken), false);
  assert.equal(adminAuthorized('Bearer segredo-de-test', expectedToken), false);
});

test('token certo autoriza', () => {
  assert.equal(adminAuthorized('Bearer segredo-de-teste', expectedToken), true);
  assert.equal(adminAuthorized('bearer segredo-de-teste', expectedToken), true);
});

test('token vazio contra segredo vazio nao autoriza', () => {
  assert.equal(adminAuthorized(undefined, ''), false);
  assert.equal(adminAuthorized('', ''), false);
  assert.equal(adminAuthorized('Bearer', '   '), false);
});

test('segredo vazio ou curto impede a inicializacao', () => {
  const adminToken = 'abcdefghijklmnopqrstuvwx';
  assert.equal(adminToken.length, 24);
  assert.throws(() => requireSecret('ADMIN_TOKEN', {}), /ADMIN_TOKEN nao definido/);
  assert.throws(() => requireSecret('ADMIN_TOKEN', { ADMIN_TOKEN: '   ' }), /ADMIN_TOKEN nao definido/);
  assert.throws(() => requireSecret('ADMIN_TOKEN', { ADMIN_TOKEN: 'abc' }), /pelo menos 24 caracteres/);
  assert.throws(() => requireSecret('ADMIN_TOKEN', { ADMIN_TOKEN: 'a'.repeat(23) }), /pelo menos 24 caracteres/);
  assert.equal(requireSecret('ADMIN_TOKEN', { ADMIN_TOKEN: ` ${adminToken} ` }), adminToken);
  assert.equal(requireSecret('META_APP_SECRET', { META_APP_SECRET: 'abc' }), 'abc');
  assert.throws(() => requireSecret('API_INTERNAL_TOKEN', {}), /API_INTERNAL_TOKEN nao definido/);
  assert.throws(() => requireSecret('API_INTERNAL_TOKEN', { API_INTERNAL_TOKEN: 'a'.repeat(23) }), /pelo menos 24 caracteres/);
  assert.equal(requireSecret('API_INTERNAL_TOKEN', { API_INTERNAL_TOKEN: adminToken }), adminToken);
});

test('rotas protegidas respondem 401 ou 200', async () => {
  const server = createServer((request, response) => {
    if (!adminAuthorized(request.headers.authorization, expectedToken)) {
      response.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Nao autorizado.');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('ok');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/admin/pedidos`;

  try {
    const missing = await fetch(url);
    const wrong = await fetch(url, { headers: { Authorization: 'Bearer outro-valor' } });
    const right = await fetch(url, { headers: { Authorization: 'Bearer segredo-de-teste' } });
    assert.equal(missing.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(right.status, 200);
    assert.equal(await right.text(), 'ok');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a API nao sobe sem ADMIN_TOKEN', async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: '',
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /ADMIN_TOKEN nao definido/);
});
