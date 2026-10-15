import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEXTO_ARQUIVO, TEXTO_SO_TEXTO, normalizarWebhook, processarEntrada } from './entrada.mjs';
import { garantirEventoDemonstracao, migrar } from './lotes.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(join(root, 'api', 'schema.sql'), 'utf8');
const token = 'abcdefghijklmnopqrstuvwx';

function envelope(mensagem, { statuses, nome = 'Ana' } = {}) {
  return {
    entry: [{
      changes: [{
        value: {
          contacts: [{ profile: { name: nome }, wa_id: mensagem?.from }],
          messages: mensagem ? [mensagem] : [],
          statuses,
        },
      }],
    }],
  };
}

async function banco() {
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-entrada-'));
  const caminho = join(diretorio, 'teste.sqlite');
  const database = new DatabaseSync(caminho);
  database.exec(schema);
  migrar(database, { databasePath: caminho });
  garantirEventoDemonstracao(database);
  return { database, diretorio };
}

function contar(database, tabela) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n);
}

test('normaliza texto, botao, lista, imagem e status', () => {
  const agora = new Date('2026-10-15T12:00:00.000Z');
  const texto = normalizarWebhook(envelope({
    from: '5511999998888',
    id: 'wamid.texto',
    timestamp: '1760000000',
    type: 'text',
    text: { body: 'COMPRAR' },
  }), agora);
  assert.equal(texto.somenteStatus, false);
  assert.equal(texto.mensagens[0].tipo, 'texto');
  assert.equal(texto.mensagens[0].texto, 'COMPRAR');
  assert.equal(texto.mensagens[0].nome, 'Ana');
  assert.equal(texto.mensagens[0].telefone, '5511999998888');
  assert.equal(texto.mensagens[0].id_mensagem, 'wamid.texto');

  const botao = normalizarWebhook(envelope({
    from: '5511999998888',
    id: 'wamid.botao',
    timestamp: '1760000001',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'comprar', title: 'Comprar' } },
  }));
  assert.equal(botao.mensagens[0].tipo, 'botao');
  assert.equal(botao.mensagens[0].texto, 'Comprar');

  const lista = normalizarWebhook(envelope({
    from: '5511999998888',
    id: 'wamid.lista',
    timestamp: '1760000002',
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: '1', title: 'Primeiro lote' } },
  }));
  assert.equal(lista.mensagens[0].tipo, 'lista');
  assert.equal(lista.mensagens[0].texto, 'Primeiro lote');

  const imagem = normalizarWebhook(envelope({
    from: '5511999998888',
    id: 'wamid.imagem',
    timestamp: '1760000003',
    type: 'image',
    image: { id: 'midia' },
  }));
  assert.equal(imagem.mensagens[0].tipo, 'imagem');

  const status = normalizarWebhook(envelope(null, { statuses: [{ id: 'wamid.saida', status: 'sent' }] }));
  assert.equal(status.somenteStatus, true);
  assert.equal(status.mensagens.length, 0);
});

test('audio, figurinha e localizacao nao entram na venda', async () => {
  const { database, diretorio } = await banco();
  try {
    for (const [tipo, id] of [['audio', 'wamid.audio'], ['figurinha', 'wamid.figurinha'], ['localizacao', 'wamid.local']]) {
      const resultado = processarEntrada(database, {
        telefone: '11988887777',
        nome: 'Ana',
        tipo,
        texto: '',
        id_mensagem: id,
        origem: 'teste',
      });
      assert.equal(resultado.resposta, TEXTO_SO_TEXTO);
    }
    const imagem = processarEntrada(database, {
      telefone: '11988887777',
      nome: 'Ana',
      tipo: 'imagem',
      texto: '',
      id_mensagem: 'wamid.img',
      origem: 'teste',
    });
    assert.equal(imagem.resposta, TEXTO_ARQUIVO);
    assert.equal(contar(database, 'pedidos'), 0);
    assert.equal(contar(database, 'mensagens_saida'), 4);
    assert.equal(database.prepare(`SELECT status FROM mensagens_saida LIMIT 1`).get().status, 'pendente_envio');
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('queda no meio nao grava e o retry processa uma unica vez', async () => {
  const { database, diretorio } = await banco();
  const entrada = {
    telefone: '11977776666',
    nome: 'Ana',
    tipo: 'texto',
    texto: 'COMPRAR',
    id_mensagem: 'wamid.queda',
    origem: 'teste',
    evento_codigo: 'evento-demonstracao',
  };
  try {
    assert.throws(() => processarEntrada(database, entrada, {
      antesDeConfirmar() { throw new Error('queda'); },
    }), /queda/);
    assert.equal(contar(database, 'mensagens_entrada'), 0);
    assert.equal(contar(database, 'mensagens_saida'), 0);
    assert.equal(contar(database, 'conversas'), 0);

    const primeira = processarEntrada(database, entrada);
    assert.equal(primeira.duplicada, false);
    assert.match(primeira.resposta, /Quantos ingressos/);
    assert.equal(contar(database, 'mensagens_entrada'), 1);
    assert.equal(contar(database, 'mensagens_saida'), 1);
    assert.equal(contar(database, 'conversas'), 1);

    const repetida = processarEntrada(database, entrada);
    assert.equal(repetida.duplicada, true);
    assert.equal(repetida.resposta, undefined);
    assert.equal(contar(database, 'mensagens_saida'), 1);
    assert.equal(contar(database, 'conversas'), 1);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('segredo interno invalido nao processa a mensagem', async () => {
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-interno-'));
  const caminho = join(diretorio, 'teste.sqlite');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: token,
      API_INTERNAL_TOKEN: token,
      API_HOST: '127.0.0.1',
      API_PORT: String(port),
      API_DATABASE_PATH: caminho,
    },
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${port}/interno/mensagem`;
  const corpo = JSON.stringify({
    telefone: '11966665555',
    nome: 'Ana',
    tipo: 'texto',
    texto: 'COMPRAR',
    id_mensagem: 'wamid.segredo',
    evento_codigo: 'evento-demonstracao',
  });
  try {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (child.exitCode !== null) throw new Error(stderr || 'A API encerrou.');
      try {
        const saude = await fetch(`http://127.0.0.1:${port}/saude`);
        if (saude.status === 200) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    const ausente = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: corpo });
    const errado = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer outro-token-interno-24' },
      body: corpo,
    });
    const certo = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: corpo,
    });
    assert.equal(ausente.status, 401);
    assert.equal(errado.status, 401);
    assert.equal(certo.status, 200);
    const json = await certo.json();
    assert.match(json.resposta, /Quantos ingressos/);
    const database = new DatabaseSync(caminho);
    assert.equal(contar(database, 'mensagens_entrada'), 1);
    database.close();
  } finally {
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    await rm(diretorio, { recursive: true, force: true });
  }
});
