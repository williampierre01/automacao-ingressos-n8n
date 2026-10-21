import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  marcarEnviosIncertos,
  processarProximaSaida,
  reenviarSaida,
} from './envio-whatsapp.mjs';
import { baseGraph, configEnvio, enviarTexto } from './graph-whatsapp.mjs';
import { garantirEventoDemonstracao, migrar } from './lotes.mjs';
import { readFileSync } from 'node:fs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(join(root, 'api', 'schema.sql'), 'utf8');

async function banco() {
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-envio-'));
  const caminho = join(diretorio, 'teste.sqlite');
  const database = new DatabaseSync(caminho);
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec(schema);
  migrar(database, { databasePath: caminho });
  garantirEventoDemonstracao(database);
  return { database, diretorio, caminho };
}

function gravarSaida(database, { wamid, telefone, texto, recebidaEm, status = 'pendente_envio' }) {
  database.prepare(`
    INSERT INTO mensagens_entrada (wamid, telefone, nome, tipo, texto, recebida_em, origem)
    VALUES (?, ?, 'Ana', 'texto', 'oi', ?, 'whatsapp')
  `).run(wamid, telefone, recebidaEm);
  const id = Number(database.prepare(`
    INSERT INTO mensagens_saida (wamid, texto, status, criada_em)
    VALUES (?, ?, ?, ?)
  `).run(wamid, texto, status, recebidaEm).lastInsertRowid);
  return id;
}

test('http da Graph so vale em 127.0.0.1 e o texto leva o id local', async () => {
  assert.equal(baseGraph({}).origin, 'https://graph.facebook.com');
  assert.throws(() => baseGraph({ META_GRAPH_BASE_URL: 'http://graph.facebook.com' }), /https/);
  assert.equal(baseGraph({ META_GRAPH_BASE_URL: 'http://127.0.0.1:9' }).hostname, '127.0.0.1');
  assert.equal(configEnvio({}).ativo, false);
  assert.throws(() => configEnvio({ META_ACCESS_TOKEN: 'curto' }), /META_ACCESS_TOKEN precisa ter pelo menos 24 caracteres/);
  const token = 't'.repeat(24);
  assert.equal(configEnvio({ META_ACCESS_TOKEN: token, META_PHONE_NUMBER_ID: '99' }).ativo, false);

  let corpo = '';
  let autorizacao = '';
  const server = createServer((req, res) => {
    autorizacao = req.headers.authorization || '';
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      corpo = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [{ id: 'wamid.saida' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    const resposta = await enviarTexto({
      base, versao: 'v0.0', phoneNumberId: '99', token, para: '5511999999999', texto: 'ola', callbackData: '7',
    });
    assert.equal(resposta.wamid, 'wamid.saida');
    assert.equal(autorizacao, `Bearer ${token}`);
    const json = JSON.parse(corpo);
    assert.equal(json.biz_opaque_callback_data, '7');
    assert.equal(json.text.body, 'ola');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('429 volta para a fila e o 200 seguinte grava o wamid; 400 falha; timeout fica incerto', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-21T15:00:00.000Z');
  try {
    const id = gravarSaida(database, {
      wamid: 'wamid.in', telefone: '5511999990001', texto: 'ola', recebidaEm: agora.toISOString(),
    });
    const primeira = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 429, codigo: 130, mensagem: 'limite' }),
    });
    assert.equal(primeira.status, 'pendente_envio');
    const meio = database.prepare('SELECT status, tentativas FROM mensagens_saida WHERE id = ?').get(id);
    assert.equal(meio.status, 'pendente_envio');
    assert.equal(meio.tentativas, 1);
    const cedo = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 200, wamid: 'nao' }),
    });
    assert.equal(cedo.processou, false);
    const segunda = await processarProximaSaida(database, {
      agora: new Date(agora.getTime() + 3000),
      enviar: async (pedido) => {
        assert.equal(pedido.callbackData, String(id));
        return { status: 200, wamid: 'wamid.out' };
      },
    });
    assert.equal(segunda.status, 'enviada');
    assert.equal(database.prepare('SELECT wamid_saida, status FROM mensagens_saida WHERE id = ?').get(id).wamid_saida, 'wamid.out');

    const id400 = gravarSaida(database, {
      wamid: 'wamid.400', telefone: '5511999990002', texto: 'x', recebidaEm: agora.toISOString(),
    });
    const longa = 'm'.repeat(800);
    const falha = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 400, codigo: 100, mensagem: longa }),
    });
    assert.equal(falha.status, 'falhou');
    const erro = database.prepare('SELECT ultimo_erro, status FROM mensagens_saida WHERE id = ?').get(id400);
    assert.equal(erro.status, 'falhou');
    assert.equal(erro.ultimo_erro.length, 500);
    assert.match(erro.ultimo_erro, /^100 /);

    const idTimeout = gravarSaida(database, {
      wamid: 'wamid.timeout', telefone: '5511999990003', texto: 'x', recebidaEm: agora.toISOString(),
    });
    let chamadas = 0;
    const incerto = await processarProximaSaida(database, {
      agora,
      enviar: async () => {
        chamadas += 1;
        const error = new Error('tempo');
        error.name = 'TimeoutError';
        error.codigo = 'REDE';
        throw error;
      },
    });
    assert.equal(incerto.status, 'envio_incerto');
    const gravado = database.prepare('SELECT status, tentativas FROM mensagens_saida WHERE id = ?').get(idTimeout);
    assert.equal(gravado.status, 'envio_incerto');
    assert.equal(gravado.tentativas, 0);
    const deNovo = await processarProximaSaida(database, {
      agora,
      enviar: async () => { chamadas += 1; return { status: 200, wamid: 'wamid.nao' }; },
    });
    assert.equal(deNovo.processou, false);
    assert.equal(chamadas, 1);
    assert.throws(() => reenviarSaida(database, idTimeout), /confirmar=1/);
    assert.equal(reenviarSaida(database, idTimeout, { confirmar: true, agora }).status, 'pendente_envio');
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('janela de 24h nao faz POST e a ordem por telefone segura a saida seguinte', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-21T15:00:00.000Z');
  try {
    gravarSaida(database, {
      wamid: 'wamid.velha',
      telefone: '5511888880001',
      texto: 'tarde',
      recebidaEm: new Date(agora.getTime() - 25 * 60 * 60 * 1000).toISOString(),
    });
    let posts = 0;
    const fora = await processarProximaSaida(database, {
      agora,
      enviar: async () => { posts += 1; return { status: 200, wamid: 'wamid.x' }; },
    });
    assert.equal(fora.status, 'fora_da_janela');
    assert.equal(posts, 0);
    assert.throws(() => reenviarSaida(database, fora.id, { confirmar: true }), /fora da janela/);

    const antiga = new Date(agora.getTime() - 60 * 60 * 1000).toISOString();
    const primeira = gravarSaida(database, {
      wamid: 'wamid.a', telefone: '5511888880002', texto: 'um', recebidaEm: antiga,
    });
    const segunda = gravarSaida(database, {
      wamid: 'wamid.b', telefone: '5511888880002', texto: 'dois', recebidaEm: antiga,
    });
    const segurou = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 429, codigo: 4, mensagem: 'calma' }),
    });
    assert.equal(segurou.id, primeira);
    const bloqueada = await processarProximaSaida(database, {
      agora,
      enviar: async () => { posts += 1; return { status: 200, wamid: 'wamid.nao' }; },
    });
    assert.equal(bloqueada.processou, false);
    database.prepare(`UPDATE mensagens_saida SET status = 'falhou' WHERE id = ?`).run(primeira);
    const liberada = await processarProximaSaida(database, {
      agora,
      enviar: async (pedido) => {
        assert.equal(pedido.callbackData, String(segunda));
        return { status: 200, wamid: 'wamid.dois' };
      },
    });
    assert.equal(liberada.status, 'enviada');

    database.prepare(`UPDATE mensagens_saida SET status = 'enviando', wamid_saida = NULL WHERE id = ?`).run(segunda);
    assert.equal(marcarEnviosIncertos(database, agora).incertos, 1);
    assert.equal(database.prepare('SELECT status FROM mensagens_saida WHERE id = ?').get(segunda).status, 'envio_incerto');
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('dois processos nao enviam a mesma saida', async () => {
  const { database, diretorio, caminho } = await banco();
  const agora = new Date().toISOString();
  gravarSaida(database, { wamid: 'wamid.unico', telefone: '5511777770001', texto: 'oi', recebidaEm: agora });
  database.close();
  const arquivo = join(diretorio, 'reivindicar.mjs');
  const modulo = pathToFileURL(join(root, 'api', 'envio-whatsapp.mjs')).href;
  writeFileSync(arquivo, `
import { DatabaseSync } from 'node:sqlite';
import { processarProximaSaida } from ${JSON.stringify(modulo)};
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA busy_timeout = 5000');
const resultado = await processarProximaSaida(db, {
  enviar: async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { status: 200, wamid: 'wamid.' + process.pid };
  },
});
process.stdout.write(JSON.stringify(resultado));
db.close();
`);
  const rodar = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [arquivo, caminho], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(stderr || `saida ${code}`));
      else resolve(JSON.parse(stdout));
    });
  });
  try {
    const [um, dois] = await Promise.all([rodar(), rodar()]);
    const enviadas = [um, dois].filter((item) => item.status === 'enviada');
    assert.equal(enviadas.length, 1);
    const conferido = new DatabaseSync(caminho);
    assert.equal(Number(conferido.prepare(`SELECT COUNT(*) AS n FROM mensagens_saida WHERE status = 'enviada'`).get().n), 1);
    conferido.close();
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('API nao sobe com META_ACCESS_TOKEN curto', async () => {
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-token-'));
  const curto = 'token-curto-meta';
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: 'abcdefghijklmnopqrstuvwx',
      API_INTERNAL_TOKEN: 'abcdefghijklmnopqrstuvwx',
      API_DATABASE_PATH: join(diretorio, 'teste.sqlite'),
      META_ACCESS_TOKEN: curto,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const code = await new Promise((resolve) => child.on('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(stderr, /META_ACCESS_TOKEN precisa ter pelo menos 24 caracteres/);
    assert.equal(stderr.includes(curto), false);
  } finally {
    await rm(diretorio, { recursive: true, force: true });
  }
});
