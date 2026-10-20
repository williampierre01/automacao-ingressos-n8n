import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  enfileirar,
  exigirBancoPronto,
  processarProxima,
  reenfileirar,
  reterCorpos,
  retomarProcessando,
} from './fila-whatsapp.mjs';
import { garantirEventoDemonstracao, migrar } from './lotes.mjs';
import { entregarAoN8n, receberEvento } from './whatsapp-gateway.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(join(root, 'api', 'schema.sql'), 'utf8');
const segredo = 'app-secret-de-teste';

function assinar(body) {
  return `sha256=${createHmac('sha256', segredo).update(body).digest('hex')}`;
}

async function banco() {
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-fila-'));
  const caminho = join(diretorio, 'teste.sqlite');
  const database = new DatabaseSync(caminho);
  database.exec(schema);
  migrar(database, { databasePath: caminho });
  garantirEventoDemonstracao(database);
  return { database, diretorio, caminho };
}

function mensagem(id, telefone = '5511999990000') {
  return {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: 'Ana' }, wa_id: telefone }],
          messages: [{
            from: telefone,
            id,
            timestamp: '1760000000',
            type: 'text',
            text: { body: 'COMPRAR' },
          }],
        },
      }],
    }],
  };
}

test('assinatura invalida nao entra na fila', async () => {
  const { database, diretorio } = await banco();
  try {
    const raw = Buffer.from(JSON.stringify(mensagem('wamid.assinatura')));
    const invalida = receberEvento(database, raw, { signature: 'sha256=00', appSecret: segredo });
    assert.equal(invalida.status, 401);
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS n FROM fila_webhook').get().n), 0);
    const valida = receberEvento(database, raw, { signature: assinar(raw), appSecret: segredo });
    assert.equal(valida.status, 200);
    assert.equal(valida.json.enfileiradas, 1);
    const status = Buffer.from(JSON.stringify({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.out', status: 'sent' }] } }] }],
    }));
    const ignorado = receberEvento(database, status, { signature: assinar(status), appSecret: segredo });
    assert.equal(ignorado.json.ignorado, true);
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS n FROM fila_webhook').get().n), 1);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('falha da primeira mensagem segura a segunda do mesmo telefone', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-15T12:00:00.000Z');
  try {
    enfileirar(database, [
      { id_mensagem: 'wamid.1', telefone: '5511911111111', nome: 'Ana', tipo: 'texto', texto: 'COMPRAR', timestamp: agora.toISOString(), corpo: { id: 'wamid.1' } },
      { id_mensagem: 'wamid.2', telefone: '5511911111111', nome: 'Ana', tipo: 'texto', texto: '2', timestamp: agora.toISOString(), corpo: { id: 'wamid.2' } },
    ], { agora });
    const vistas = [];
    const primeira = await processarProxima(database, {
      agora,
      maximo: 30,
      entregar: async (payload) => {
        vistas.push(payload.id_mensagem);
        return { status: 500 };
      },
    });
    assert.equal(primeira.status, 'pendente');
    assert.deepEqual(vistas, ['wamid.1']);
    await processarProxima(database, {
      agora,
      entregar: async (payload) => {
        vistas.push(payload.id_mensagem);
        return { status: 200 };
      },
    });
    assert.deepEqual(vistas, ['wamid.1']);
    const permanente = await processarProxima(database, {
      agora: new Date(agora.getTime() + 3000),
      entregar: async () => ({ status: 400 }),
    });
    assert.equal(permanente.status, 'falhou');
    assert.equal(database.prepare(`SELECT status FROM fila_webhook WHERE wamid = 'wamid.1'`).get().status, 'falhou');
    const segunda = await processarProxima(database, {
      agora: new Date(agora.getTime() + 3000),
      entregar: async (payload) => {
        vistas.push(payload.id_mensagem);
        return { status: 200 };
      },
    });
    assert.equal(segunda.status, 'entregue');
    assert.deepEqual(vistas, ['wamid.1', 'wamid.2']);
    const idFalhou = database.prepare(`SELECT id FROM fila_webhook WHERE wamid = 'wamid.1'`).get().id;
    assert.equal(reenfileirar(database, idFalhou).status, 'pendente');
    assert.equal(database.prepare(`SELECT tentativas FROM fila_webhook WHERE id = ?`).get(idFalhou).tentativas, 0);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('reinicio retoma pendentes e n8n fora do ar reentrega', async () => {
  const { database, diretorio, caminho } = await banco();
  const agora = new Date('2026-10-15T12:00:00.000Z');
  try {
    enfileirar(database, [
      { id_mensagem: 'wamid.rede', telefone: '5511922222222', nome: 'Ana', tipo: 'texto', texto: 'COMPRAR', timestamp: agora.toISOString(), corpo: { id: 'wamid.rede' } },
    ], { agora });
    database.prepare(`UPDATE fila_webhook SET status = 'processando' WHERE wamid = 'wamid.rede'`).run();
    database.close();
    const reaberto = new DatabaseSync(caminho);
    reaberto.exec('PRAGMA busy_timeout = 5000');
    assert.equal(retomarProcessando(reaberto, agora).retomadas, 1);
    assert.equal(reaberto.prepare(`SELECT status FROM fila_webhook WHERE wamid = 'wamid.rede'`).get().status, 'pendente');
    const fora = await processarProxima(reaberto, {
      agora,
      entregar: async () => { throw new Error('fetch failed'); },
    });
    assert.equal(fora.status, 'pendente');
    const cedo = await processarProxima(reaberto, {
      agora,
      entregar: async () => ({ status: 200 }),
    });
    assert.equal(cedo.processou, false);
    const depois = await processarProxima(reaberto, {
      agora: new Date(agora.getTime() + 3000),
      entregar: async () => ({ status: 200 }),
    });
    assert.equal(depois.status, 'entregue');
    assert.equal(reaberto.prepare(`SELECT corpo FROM fila_webhook WHERE wamid = 'wamid.rede'`).get().corpo, '');
    reaberto.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('corpo de falha antiga sai e o banco antigo impede o gateway', async () => {
  const { database, diretorio, caminho } = await banco();
  const agora = new Date('2026-10-15T12:00:00.000Z');
  try {
    enfileirar(database, [
      { id_mensagem: 'wamid.velha', telefone: '5511933333333', nome: 'Ana', tipo: 'texto', texto: 'oi', timestamp: agora.toISOString(), corpo: { segredo: 'bruto' } },
      { id_mensagem: 'wamid.nova', telefone: '5511944444444', nome: 'Bia', tipo: 'texto', texto: 'oi', timestamp: agora.toISOString(), corpo: { segredo: 'recente' } },
    ], { agora });
    const antiga = new Date(agora.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    database.prepare(`UPDATE fila_webhook SET status = 'falhou', atualizado_em = ?`).run(antiga);
    database.prepare(`UPDATE fila_webhook SET atualizado_em = ? WHERE wamid = 'wamid.nova'`).run(agora.toISOString());
    assert.equal(reterCorpos(database, 7, agora).apagados, 1);
    assert.equal(database.prepare(`SELECT corpo FROM fila_webhook WHERE wamid = 'wamid.velha'`).get().corpo, '');
    assert.match(database.prepare(`SELECT corpo FROM fila_webhook WHERE wamid = 'wamid.nova'`).get().corpo, /recente/);
    assert.equal(database.prepare(`SELECT telefone FROM fila_webhook WHERE wamid = 'wamid.velha'`).get().telefone, '5511933333333');
    database.close();

    const antigo = new DatabaseSync(join(diretorio, 'antigo.sqlite'));
    antigo.exec('PRAGMA user_version = 1');
    assert.throws(() => exigirBancoPronto(antigo), /suba a API primeiro/);
    antigo.close();

    const child = spawn(process.execPath, ['api/whatsapp-gateway.mjs'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        META_APP_SECRET: segredo,
        API_INTERNAL_TOKEN: 'token-interno-de-teste-24',
        API_DATABASE_PATH: join(diretorio, 'antigo.sqlite'),
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, /suba a API primeiro/);
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('404 e 429 reagendam, 400 e 401 falham e o limite esgota', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-15T12:00:00.000Z');
  const casos = [
    ['wamid.404', 404, 'pendente', ''],
    ['wamid.429', 429, 'pendente', ''],
    ['wamid.408', 408, 'pendente', ''],
    ['wamid.425', 425, 'pendente', ''],
    ['wamid.400', 400, 'falhou', ''],
    ['wamid.401', 401, 'falhou', 'Nao autorizado.'],
  ];
  try {
    enfileirar(database, casos.map(([id], indice) => ({
      id_mensagem: id,
      telefone: `551190000${indice}`,
      nome: 'Ana',
      tipo: 'texto',
      texto: 'COMPRAR',
      timestamp: agora.toISOString(),
      corpo: { id },
    })), { agora });
    for (const [id, http, esperado, erro] of casos) {
      const resultado = await processarProxima(database, {
        agora,
        entregar: async () => ({ status: http, erro }),
      });
      assert.equal(resultado.status, esperado, id);
      const linha = database.prepare('SELECT status, ultimo_erro, proxima_tentativa_em FROM fila_webhook WHERE wamid = ?').get(id);
      assert.equal(linha.status, esperado);
      if (esperado === 'pendente') {
        assert.equal(linha.ultimo_erro, `HTTP ${http}`);
        assert.ok(linha.proxima_tentativa_em > agora.toISOString());
      } else {
        assert.equal(linha.ultimo_erro, erro || `HTTP ${http}`);
      }
    }
    enfileirar(database, [{
      id_mensagem: 'wamid.limite',
      telefone: '551190000999',
      nome: 'Ana',
      tipo: 'texto',
      texto: 'COMPRAR',
      timestamp: agora.toISOString(),
      corpo: { id: 'wamid.limite' },
    }], { agora });
    const esgotou = await processarProxima(database, {
      agora,
      maximo: 1,
      entregar: async () => ({ status: 429 }),
    });
    assert.equal(esgotou.status, 'falhou');
    assert.equal(database.prepare(`SELECT status FROM fila_webhook WHERE wamid = 'wamid.limite'`).get().status, 'falhou');
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('entrega ao n8n envia o bearer e o gateway exige o token', async () => {
  const token = 'token-interno-de-teste-24';
  let recebido = '';
  const server = createServer((req, res) => {
    recebido = req.headers.authorization || '';
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const endereco = server.address();
  try {
    const resposta = await entregarAoN8n(
      { id_mensagem: 'wamid.bearer' },
      `http://127.0.0.1:${endereco.port}/webhook`,
      token,
    );
    assert.equal(resposta.status, 204);
    assert.equal(recebido, `Bearer ${token}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const child = spawn(process.execPath, ['api/whatsapp-gateway.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      META_APP_SECRET: segredo,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /API_INTERNAL_TOKEN nao definido/);
});
