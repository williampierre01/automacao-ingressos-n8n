import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adminToken = 'abcdefghijklmnopqrstuvwx';

async function startApi(extraEnv) {
  const directory = await mkdtemp(join(tmpdir(), 'ingressos-api-'));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: adminToken,
      API_INTERNAL_TOKEN: adminToken,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      API_DATABASE_PATH: join(directory, 'teste.sqlite'),
      ...extraEnv,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) {
      throw new Error(stderr || 'A API encerrou antes de responder.');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/saude`);
      if (response.status === 200) {
        return { child, port, directory };
      }
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

test('simulador desligado responde 404', async () => {
  const api = await startApi({});
  try {
    const home = await fetch(`http://127.0.0.1:${api.port}/`);
    const page = await fetch(`http://127.0.0.1:${api.port}/simulador`);
    const post = await fetch(`http://127.0.0.1:${api.port}/simular-mensagem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const health = await fetch(`http://127.0.0.1:${api.port}/saude`);
    assert.equal(home.status, 404);
    assert.equal(page.status, 404);
    assert.equal(post.status, 404);
    assert.equal(health.status, 200);
  } finally {
    await stopApi(api);
  }
});

test('simulador ligado abre as rotas', async () => {
  const api = await startApi({ SIMULADOR_ATIVO: '1' });
  try {
    const page = await fetch(`http://127.0.0.1:${api.port}/simulador`);
    const post = await fetch(`http://127.0.0.1:${api.port}/simular-mensagem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(page.status, 200);
    assert.equal(post.status, 400);
  } finally {
    await stopApi(api);
  }
});
