import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
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

test('segredo vazio impede a inicializacao', () => {
  assert.throws(() => requireSecret('ADMIN_TOKEN', {}), /ADMIN_TOKEN nao definido/);
  assert.throws(() => requireSecret('ADMIN_TOKEN', { ADMIN_TOKEN: '   ' }), /ADMIN_TOKEN nao definido/);
  assert.equal(requireSecret('ADMIN_TOKEN', { ADMIN_TOKEN: ' abc ' }), 'abc');
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
