import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TEXTO_EM_ANALISE, TEXTO_TARDIO, processarEntrada } from './entrada.mjs';
import { montarPayloadEntrega } from './fila-whatsapp.mjs';
import { baixarMidia, caminhoDentroDaPasta, MidiaError } from './graph-whatsapp.mjs';
import { MARCA_COMPROVANTE_TARDIO, digitosTelefone, garantirEventoDemonstracao, migrar } from './lotes.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const hashPng = createHash('sha256').update(png).digest('hex');
const adminToken = 'abcdefghijklmnopqrstuvwx';

function escutar(handler) {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error.message || 'erro'));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fechar(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function bancoTemporario() {
  const diretorio = await mkdtemp(join(tmpdir(), 'midia-comprovante-'));
  const pasta = join(diretorio, 'comprovantes');
  mkdirSync(pasta);
  const caminhoBanco = join(diretorio, 'teste.sqlite');
  const database = new DatabaseSync(caminhoBanco);
  database.exec(schema);
  migrar(database, { databasePath: caminhoBanco });
  garantirEventoDemonstracao(database);
  const evento = database.prepare(`SELECT * FROM eventos WHERE codigo = 'evento-demonstracao'`).get();
  const lote = database.prepare('SELECT id FROM lotes WHERE evento_id = ? LIMIT 1').get(evento.id);
  const agora = new Date().toISOString();
  const pedidoId = Number(database.prepare(`
    INSERT INTO pedidos (
      protocolo, evento_id, lote_id, data_contato, origem, comprador_nome, comprador_telefone,
      quantidade, valor_unitario_centavos, valor_total_centavos, reserva_expira_em,
      status, status_pagamento, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, 'teste', 'Ana', ?, 1, 1000, 1000, ?, 'aguardando_pagamento', 'pendente', ?, ?)
  `).run(`P-${randomUUID()}`, evento.id, lote.id, agora, digitosTelefone('11988887777'), agora, agora, agora).lastInsertRowid);
  return { diretorio, pasta, database, pedidoId };
}

async function encerrar(ctx) {
  try { ctx.database.close(); } catch { /* ja fechado */ }
  await rm(ctx.diretorio, { recursive: true, force: true });
}

function entradaImagem(extra = {}) {
  return {
    telefone: '11988887777',
    nome: 'Ana',
    tipo: 'imagem',
    texto: '',
    id_mensagem: extra.id || `wamid-${randomUUID()}`,
    evento_codigo: 'evento-demonstracao',
    midia_id: 'midia-1',
    midia_mime: 'image/png',
    midia_sha256: hashPng,
    midia_nome: 'pix.png',
    ...extra.campos,
  };
}

function baixarLocal(base, pasta, extra = {}) {
  return (pedido) => baixarMidia({
    base,
    versao: 'v0.0',
    token: 't'.repeat(24),
    pasta,
    timeoutMs: extra.timeoutMs ?? 4000,
    gravar: extra.gravar,
    mediaId: pedido.mediaId,
    mimeEsperado: pedido.mimeEsperado,
    sha256Esperado: pedido.sha256Esperado,
  });
}

test('payload da fila repassa o id da imagem', () => {
  const payload = montarPayloadEntrega({
    telefone: '11988887777',
    nome: 'Ana',
    tipo: 'imagem',
    texto: '',
    wamid: 'wamid-1',
    timestamp_mensagem: '2026-10-21T12:00:00.000Z',
    origem: 'whatsapp',
    evento_codigo: 'evento-demonstracao',
    corpo: JSON.stringify({
      image: { id: 'midia-1', mime_type: 'image/png', sha256: hashPng, filename: 'pix.png' },
    }),
  });
  assert.equal(payload.midia_id, 'midia-1');
  assert.equal(payload.midia_mime, 'image/png');
  assert.equal(payload.midia_sha256, hashPng);
  assert.equal(payload.midia_nome, 'pix.png');
});

test('caminho com .. nao sai da pasta de comprovantes', () => {
  const pasta = join(root, 'data', 'comprovantes');
  assert.equal(caminhoDentroDaPasta(pasta, '../segredo.txt'), null);
  assert.equal(caminhoDentroDaPasta(pasta, '..\\segredo.txt'), null);
  assert.equal(caminhoDentroDaPasta(pasta, 'ok/../../segredo.txt'), null);
  assert.equal(caminhoDentroDaPasta(pasta, 'nota.png'), join(pasta, 'nota.png'));
});

test('imagem valida grava arquivo relativo, pedido em analise e nao baixa o mesmo wamid de novo', async () => {
  const ctx = await bancoTemporario();
  let pedidos = 0;
  const server = await escutar((request, response) => {
    pedidos += 1;
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/midia-1')) {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/arquivo.png`,
        mime_type: 'image/png',
        file_size: png.length,
      }));
      return;
    }
    response.end(png);
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    const id = 'wamid-boa';
    const resultado = await processarEntrada(ctx.database, entradaImagem({ id, campos: { id_mensagem: id } }), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta),
    });
    assert.equal(resultado.estado, 'pagamento_em_analise');
    assert.equal(resultado.resposta, TEXTO_EM_ANALISE);
    const comprovante = ctx.database.prepare('SELECT * FROM comprovantes').get();
    assert.equal(comprovante.sha256, hashPng);
    assert.equal(comprovante.caminho.includes('..'), false);
    assert.equal(comprovante.caminho.includes('/') || comprovante.caminho.includes('\\'), false);
    assert.equal(existsSync(join(ctx.pasta, comprovante.caminho)), true);
    const pedido = ctx.database.prepare('SELECT status, status_pagamento, recebido_apos_expirar FROM pedidos WHERE id = ?').get(ctx.pedidoId);
    assert.equal(pedido.status, 'pagamento_em_analise');
    assert.equal(pedido.recebido_apos_expirar, 0);
    const repetida = await processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: id } }), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta),
    });
    assert.equal(repetida.duplicada, true);
    assert.equal(pedidos, 2);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 1);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('comprovante de pedido expirado usa a marca de atraso', async () => {
  const ctx = await bancoTemporario();
  ctx.database.prepare(`UPDATE pedidos SET status = 'expirado' WHERE id = ?`).run(ctx.pedidoId);
  const server = await escutar((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/midia-1')) {
      response.end(JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/arquivo.png`,
        mime_type: 'image/png',
        file_size: png.length,
      }));
      return;
    }
    response.end(png);
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    const resultado = await processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta),
    });
    assert.equal(resultado.resposta, TEXTO_TARDIO);
    assert.equal(resultado.recebido_apos_expirar, true);
    const pedido = ctx.database.prepare('SELECT observacoes, recebido_apos_expirar FROM pedidos WHERE id = ?').get(ctx.pedidoId);
    assert.equal(pedido.recebido_apos_expirar, 1);
    assert.match(pedido.observacoes, new RegExp(MARCA_COMPROVANTE_TARDIO));
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('midia recusada grava a entrada e nao deixa arquivo', async () => {
  const casos = [
    {
      nome: 'mime',
      meta: { mime_type: 'text/plain', file_size: 4 },
      corpo: Buffer.from('nada'),
      texto: /JPG, PNG ou PDF/,
    },
    {
      nome: 'tamanho',
      meta: { mime_type: 'image/png', file_size: 5_000_001 },
      corpo: png,
      texto: /5 MB/,
    },
    {
      nome: 'magic',
      meta: { mime_type: 'image/png', file_size: 8 },
      corpo: Buffer.from('%PDF-1.4'),
      texto: /nao confere com o tipo/,
    },
    {
      nome: 'hash',
      meta: { mime_type: 'image/png', file_size: png.length },
      corpo: png,
      sha: 'ab',
      texto: /nao confere com o enviado/,
    },
    {
      nome: '404',
      status: 404,
      texto: /Nao encontrei/,
    },
  ];
  for (const caso of casos) {
    const ctx = await bancoTemporario();
    const server = await escutar((request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (caso.status === 404 && url.pathname.endsWith('/midia-1')) {
        response.writeHead(404);
        response.end('ausente');
        return;
      }
      if (url.pathname.endsWith('/midia-1')) {
        response.end(JSON.stringify({
          ...caso.meta,
          url: `http://127.0.0.1:${server.address().port}/arquivo`,
        }));
        return;
      }
      response.end(caso.corpo);
    });
    try {
      const base = new URL(`http://127.0.0.1:${server.address().port}`);
      const resultado = await processarEntrada(ctx.database, entradaImagem({
        campos: { midia_sha256: caso.sha ?? hashPng },
      }), {
        pastaComprovantes: ctx.pasta,
        baixar: baixarLocal(base, ctx.pasta),
      });
      assert.match(resultado.resposta, caso.texto, caso.nome);
      assert.equal(resultado.estado, 'comprovante_recusado', caso.nome);
      assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 1, caso.nome);
      assert.equal((await readdir(ctx.pasta)).length, 0, caso.nome);
    } finally {
      await fechar(server);
      await encerrar(ctx);
    }
  }
});

test('redirect para outro host e corpo acima de 5 MB sao recusados sem arquivo', async () => {
  const ctx = await bancoTemporario();
  const server = await escutar((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/midia-1')) {
      response.end(JSON.stringify({
        mime_type: 'image/png',
        url: `http://127.0.0.1:${server.address().port}/pula`,
      }));
      return;
    }
    response.writeHead(302, { Location: 'https://example.com/arquivo' });
    response.end();
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    const resultado = await processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta),
    });
    assert.match(resultado.resposta, /outro host|nao e permitida/);
    assert.equal((await readdir(ctx.pasta)).length, 0);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }

  const grande = await bancoTemporario();
  const lento = await escutar((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/midia-1')) {
      response.end(JSON.stringify({
        mime_type: 'image/png',
        url: `http://127.0.0.1:${lento.address().port}/arquivo`,
      }));
      return;
    }
    response.end(Buffer.concat([png, Buffer.alloc(5_000_001)]));
  });
  try {
    const base = new URL(`http://127.0.0.1:${lento.address().port}`);
    const resultado = await processarEntrada(grande.database, entradaImagem(), {
      pastaComprovantes: grande.pasta,
      baixar: baixarLocal(base, grande.pasta),
    });
    assert.match(resultado.resposta, /5 MB/);
    assert.equal((await readdir(grande.pasta)).length, 0);
  } finally {
    await fechar(lento);
    await encerrar(grande);
  }
});

test('midia lenta nao grava entrada nem arquivo', async () => {
  const ctx = await bancoTemporario();
  const server = await escutar(async (request, response) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    response.end('{}');
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta, { timeoutMs: 100 }),
    }), (error) => error instanceof MidiaError && error.codigo === 'transitorio');
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 0);
    assert.equal((await readdir(ctx.pasta)).length, 0);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('token ausente nao grava entrada', async () => {
  const ctx = await bancoTemporario();
  try {
    await assert.rejects(processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      env: { META_GRAPH_VERSION: 'v0.0', META_ACCESS_TOKEN: '', META_GRAPH_BASE_URL: 'http://127.0.0.1:9' },
    }), (error) => error instanceof MidiaError && /META_ACCESS_TOKEN/.test(error.message));
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 0);
  } finally {
    await encerrar(ctx);
  }
});

test('ENOSPC apaga o parcial e a falha de transacao apaga o arquivo', async () => {
  const ctx = await bancoTemporario();
  const server = await escutar((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/midia-1')) {
      response.end(JSON.stringify({
        mime_type: 'image/png',
        file_size: png.length,
        url: `http://127.0.0.1:${server.address().port}/arquivo.png`,
      }));
      return;
    }
    response.end(png);
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta, {
        gravar(destino, dados) {
          writeFileSync(destino, dados);
          const error = new Error('sem espaco');
          error.code = 'ENOSPC';
          throw error;
        },
      }),
    }), (error) => error instanceof MidiaError && error.codigo === 'transitorio');
    assert.equal((await readdir(ctx.pasta)).length, 0);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 0);

    writeFileSync(join(ctx.pasta, 'orfao.png'), png);
    await assert.rejects(processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: 'wamid-orfao' } }), {
      pastaComprovantes: ctx.pasta,
      baixar: async () => {
        ctx.database.prepare(`UPDATE pedidos SET status = 'cancelado' WHERE id = ?`).run(ctx.pedidoId);
        return { nomeArquivo: 'orfao.png', mime: 'image/png', tamanho: png.length, sha256: hashPng };
      },
    }), /comprovante/);
    assert.equal(existsSync(join(ctx.pasta, 'orfao.png')), false);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 0);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('GET do admin nao le caminho com ..', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'midia-admin-'));
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
    },
  });
  const pasta = join(root, 'data', 'comprovantes');
  const idRuim = randomUUID();
  const idBom = randomUUID();
  const fora = join(root, 'data', `vazou-${idRuim}.txt`);
  const dentro = join(pasta, `${idBom}.png`);
  let database;
  try {
    const started = Date.now();
    while (Date.now() - started < 5000) {
      if (child.exitCode !== null) throw new Error('A API encerrou.');
      try {
        const saude = await fetch(`http://127.0.0.1:${port}/saude`);
        if (saude.status === 200) break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    database = new DatabaseSync(join(directory, 'teste.sqlite'));
    const evento = database.prepare(`SELECT id FROM eventos LIMIT 1`).get();
    const lote = database.prepare('SELECT id FROM lotes LIMIT 1').get();
    const agora = new Date().toISOString();
    const pedidoId = Number(database.prepare(`
      INSERT INTO pedidos (
        protocolo, evento_id, lote_id, data_contato, origem, comprador_nome, comprador_telefone,
        quantidade, valor_unitario_centavos, valor_total_centavos, status, status_pagamento, criado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, 'teste', 'Ana', '11988887777', 1, 1000, 1000, 'pagamento_em_analise', 'em_analise', ?, ?)
    `).run(`P-${randomUUID()}`, evento.id, lote.id, agora, agora, agora).lastInsertRowid);
    database.prepare(`
      INSERT INTO comprovantes (id, pedido_id, nome_original, tipo_mime, caminho, tamanho_bytes, recebido_em)
      VALUES (?, ?, 'nota.png', 'image/png', ?, 4, ?)
    `).run(idRuim, pedidoId, `../vazou-${idRuim}.txt`, agora);
    database.prepare(`
      INSERT INTO comprovantes (id, pedido_id, nome_original, tipo_mime, caminho, tamanho_bytes, recebido_em)
      VALUES (?, ?, 'nota.png', 'image/png', ?, ?, ?)
    `).run(idBom, pedidoId, `${idBom}.png`, png.length, agora);
    database.close();
    database = null;
    mkdirSync(pasta, { recursive: true });
    writeFileSync(fora, 'vazou-caminho');
    writeFileSync(dentro, png);
    const headers = { Authorization: `Bearer ${adminToken}` };
    const ruim = await fetch(`http://127.0.0.1:${port}/admin/comprovantes/${idRuim}`, { headers });
    assert.equal(ruim.status, 404);
    assert.equal((await ruim.text()).includes('vazou-caminho'), false);
    const bom = await fetch(`http://127.0.0.1:${port}/admin/comprovantes/${idBom}`, { headers });
    assert.equal(bom.status, 200);
    assert.equal(Buffer.from(await bom.arrayBuffer()).equals(png), true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    try { database?.close(); } catch { /* fechado */ }
    await rm(directory, { recursive: true, force: true });
    for (const arquivo of [fora, dentro]) {
      if (existsSync(arquivo)) {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(arquivo);
      }
    }
  }
});
