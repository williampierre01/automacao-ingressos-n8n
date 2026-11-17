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
import { criarControleEnvio, respostaSaidas } from './envio-whatsapp.mjs';
import { montarPayloadEntrega, processarProxima } from './fila-whatsapp.mjs';
import { baixarMidia, caminhoDentroDaPasta, MidiaError } from './graph-whatsapp.mjs';
import { MARCA_COMPROVANTE_TARDIO, digitosTelefone, garantirEventoDemonstracao, migrar } from './lotes.mjs';
import { hashTokenEnvio, marcaPausa } from './pausa-envio.mjs';

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

test('wamid gravado durante o download apaga o arquivo e nao cria saida', async () => {
  const ctx = await bancoTemporario();
  const id = 'wamid-corrida';
  const saidas = ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_saida').get().n;
  const comprovantes = ctx.database.prepare('SELECT COUNT(*) AS n FROM comprovantes').get().n;
  try {
    const resultado = await processarEntrada(ctx.database, entradaImagem({ id, campos: { id_mensagem: id } }), {
      pastaComprovantes: ctx.pasta,
      baixar: async () => {
        ctx.database.prepare(`
          INSERT INTO mensagens_entrada (wamid, telefone, nome, tipo, texto, recebida_em, origem)
          VALUES (?, ?, 'Ana', 'imagem', '', ?, 'whatsapp')
        `).run(id, digitosTelefone('11988887777'), new Date().toISOString());
        writeFileSync(join(ctx.pasta, 'corrida.png'), png);
        return { nomeArquivo: 'corrida.png', mime: 'image/png', tamanho: png.length, sha256: hashPng };
      },
    });
    assert.deepEqual(resultado, { duplicada: true });
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 1);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_saida').get().n, saidas);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM comprovantes').get().n, comprovantes);
    assert.equal((await readdir(ctx.pasta)).length, 0);
  } finally {
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
    }), (error) => error instanceof MidiaError && error.codigo === 'transitorio' && error.pausa !== true && /META_ACCESS_TOKEN/.test(error.message));
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

function erroGraph(code, extra = {}) {
  return JSON.stringify({ error: { message: 'nao-usar', code, ...extra } });
}

async function pedidoIntacto(ctx) {
  const pedido = ctx.database.prepare('SELECT status FROM pedidos WHERE id = ?').get(ctx.pedidoId);
  assert.equal(pedido.status, 'aguardando_pagamento');
  assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 0);
  assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_saida').get().n, 0);
  assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM comprovantes').get().n, 0);
  assert.equal((await readdir(ctx.pasta)).length, 0);
}

test('token vazio nao consulta a Graph', async () => {
  let chamadas = 0;
  await assert.rejects(() => baixarMidia({
    base: new URL('http://127.0.0.1:9'),
    versao: 'v0.0',
    token: '   ',
    mediaId: 'midia-1',
    pasta: tmpdir(),
    fetchImpl: async () => {
      chamadas += 1;
      throw new Error('nao deveria consultar');
    },
  }), (error) => error instanceof MidiaError && error.codigo === 'transitorio' && error.pausa !== true);
  assert.equal(chamadas, 0);
});

test('GET do media id classifica token, retry e 404 sem gravar o recuperavel', async () => {
  const segredo = `segredo-midia-${'m'.repeat(24)}`;
  const casos = [
    {
      nome: '401 code 190',
      status: 401,
      corpo: JSON.stringify({ error: { message: segredo, code: 190, error_subcode: 463 } }),
      pausa: true,
      texto: 'token invalido (code 190)',
    },
    {
      nome: '403 sem code',
      status: 403,
      corpo: '',
      pausa: true,
      texto: 'token invalido',
    },
    {
      nome: 'code 130429',
      status: 400,
      corpo: erroGraph(130429),
      pausa: false,
      transitorio: true,
    },
    {
      nome: '404 sem code',
      status: 404,
      corpo: 'ausente',
      permanente: true,
    },
  ];
  for (const caso of casos) {
    const ctx = await bancoTemporario();
    const server = await escutar((request, response) => {
      response.writeHead(caso.status, { 'Content-Type': 'application/json' });
      response.end(caso.corpo);
    });
    try {
      const base = new URL(`http://127.0.0.1:${server.address().port}`);
      const promessa = processarEntrada(ctx.database, entradaImagem(), {
        pastaComprovantes: ctx.pasta,
        baixar: baixarLocal(base, ctx.pasta),
      });
      if (caso.permanente) {
        const resultado = await promessa;
        assert.equal(resultado.estado, 'comprovante_recusado', caso.nome);
        assert.match(resultado.resposta, /Nao encontrei/, caso.nome);
        assert.equal(resultado.resposta.includes(segredo), false, caso.nome);
        assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 1, caso.nome);
        assert.equal((await readdir(ctx.pasta)).length, 0, caso.nome);
      } else {
        await assert.rejects(promessa, (error) => {
          assert.equal(error instanceof MidiaError, true, caso.nome);
          assert.equal(error.codigo, 'transitorio', caso.nome);
          assert.equal(error.pausa === true, caso.pausa, caso.nome);
          assert.equal(String(error.message).includes(segredo), false, caso.nome);
          if (caso.texto) assert.equal(error.message, caso.texto, caso.nome);
          return true;
        });
        await pedidoIntacto(ctx);
      }
    } finally {
      await fechar(server);
      await encerrar(ctx);
    }
  }
});

test('GET da URL separa 403 sem JSON, 403 com code 368 e 401', async () => {
  const segredo = `segredo-url-${'u'.repeat(24)}`;
  const casos = [
    { nome: '403 sem json', status: 403, corpo: 'forbidden', json: false, pausa: false, transitorio: true },
    { nome: '403 code 368', status: 403, corpo: erroGraph(368), permanente: true },
    { nome: '401', status: 401, corpo: JSON.stringify({ error: { message: segredo, code: 190 } }), pausa: true },
  ];
  for (const caso of casos) {
    const ctx = await bancoTemporario();
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
      if (caso.json === false) {
        response.writeHead(caso.status, { 'Content-Type': 'text/plain' });
        response.end(caso.corpo);
        return;
      }
      response.writeHead(caso.status, { 'Content-Type': 'application/json' });
      response.end(caso.corpo);
    });
    try {
      const base = new URL(`http://127.0.0.1:${server.address().port}`);
      const promessa = processarEntrada(ctx.database, entradaImagem(), {
        pastaComprovantes: ctx.pasta,
        baixar: baixarLocal(base, ctx.pasta),
      });
      if (caso.permanente) {
        const resultado = await promessa;
        assert.equal(resultado.estado, 'comprovante_recusado', caso.nome);
        assert.match(resultado.resposta, /HTTP 403/, caso.nome);
        assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 1, caso.nome);
        assert.equal((await readdir(ctx.pasta)).length, 0, caso.nome);
      } else {
        await assert.rejects(promessa, (error) => {
          assert.equal(error instanceof MidiaError, true, caso.nome);
          assert.equal(error.codigo, 'transitorio', caso.nome);
          assert.equal(Boolean(error.pausa), Boolean(caso.pausa), caso.nome);
          assert.equal(String(error.message).includes(segredo), false, caso.nome);
          if (caso.pausa) assert.equal(error.message, 'token invalido (code 190)', caso.nome);
          if (caso.transitorio && !caso.pausa) assert.equal(error.pausa, undefined, caso.nome);
          return true;
        });
        await pedidoIntacto(ctx);
      }
    } finally {
      await fechar(server);
      await encerrar(ctx);
    }
  }
});

test('reentrega com token novo baixa uma vez e a segunda entrega e duplicada', async () => {
  const ctx = await bancoTemporario();
  let modo = '401';
  let arquivos = 0;
  const server = await escutar((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname.endsWith('/midia-1')) {
      if (modo === '401') {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'recusado', code: 190 } }));
        return;
      }
      response.end(JSON.stringify({
        url: `http://127.0.0.1:${server.address().port}/arquivo.png`,
        mime_type: 'image/png',
        file_size: png.length,
      }));
      return;
    }
    arquivos += 1;
    response.end(png);
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    const id = 'wamid-reentrega';
    const baixar = baixarLocal(base, ctx.pasta);
    await assert.rejects(processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: id } }), {
      pastaComprovantes: ctx.pasta,
      baixar,
    }), (error) => error instanceof MidiaError && error.pausa === true);
    await pedidoIntacto(ctx);
    modo = '200';
    const resultado = await processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: id } }), {
      pastaComprovantes: ctx.pasta,
      baixar,
    });
    assert.equal(resultado.estado, 'pagamento_em_analise');
    assert.equal(arquivos, 1);
    const pedido = ctx.database.prepare('SELECT status FROM pedidos WHERE id = ?').get(ctx.pedidoId);
    assert.equal(pedido.status, 'pagamento_em_analise');
    const repetida = await processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: id } }), {
      pastaComprovantes: ctx.pasta,
      baixar,
    });
    assert.equal(repetida.duplicada, true);
    assert.equal(arquivos, 1);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 1);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

const tokenDownload = `comprovante-download-${'d'.repeat(16)}`;

function envDownload(extra = {}) {
  return {
    META_ACCESS_TOKEN: tokenDownload,
    META_GRAPH_VERSION: 'v0.0',
    META_GRAPH_BASE_URL: 'http://127.0.0.1:9',
    ...extra,
  };
}

function gravarPendente(ctx, { ultimo = '', tentativas = 2, proxima = '2099-01-01T00:00:00.000Z' } = {}) {
  const momento = '2026-10-21T12:00:00.000Z';
  const wamid = `wamid-pendente-${randomUUID()}`;
  ctx.database.prepare(`
    INSERT INTO mensagens_entrada (wamid, telefone, nome, tipo, texto, recebida_em, origem)
    VALUES (?, '5511999990000', 'Lia', 'texto', 'oi', ?, 'whatsapp')
  `).run(wamid, momento);
  const id = Number(ctx.database.prepare(`
    INSERT INTO mensagens_saida (
      wamid, texto, status, criada_em, tentativas, proxima_tentativa_em, ultimo_erro, atualizado_em
    ) VALUES (?, 'resposta pronta', 'pendente_envio', ?, ?, ?, ?, ?)
  `).run(wamid, momento, tentativas, proxima, ultimo, momento).lastInsertRowid);
  return { id, wamid, proxima, tentativas, ultimo, atualizadoEm: momento };
}

function semSegredo(texto) {
  const valor = String(texto ?? '');
  assert.equal(valor.includes(tokenDownload), false);
  assert.equal(valor.includes('pausa:'), false);
  assert.equal(valor.includes(hashTokenEnvio(tokenDownload)), false);
}

test('token ausente e versao vazia nao pausam nem gravam', async () => {
  const ctx = await bancoTemporario();
  const controle = criarControleEnvio();
  try {
    await assert.rejects(processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      controle,
      env: envDownload({ META_ACCESS_TOKEN: '   ' }),
    }), (error) => error instanceof MidiaError && error.codigo === 'transitorio' && error.pausa !== true);
    assert.equal(controle.pausado, false);
    await pedidoIntacto(ctx);
    const outro = criarControleEnvio();
    await assert.rejects(processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: 'wamid-sem-versao' } }), {
      pastaComprovantes: ctx.pasta,
      controle: outro,
      env: envDownload({ META_GRAPH_VERSION: '' }),
    }), (error) => error instanceof MidiaError && error.pausa !== true && /META_GRAPH_VERSION/.test(error.message));
    assert.equal(outro.pausado, false);
    await pedidoIntacto(ctx);
  } finally {
    await encerrar(ctx);
  }
});

test('pausa do download marca uma pendente e nao reescreve', async () => {
  const ctx = await bancoTemporario();
  const primeira = gravarPendente(ctx, { ultimo: 'antes' });
  const segunda = gravarPendente(ctx, { ultimo: 'vizinha', tentativas: 4 });
  const controle = criarControleEnvio();
  const agora1 = new Date('2026-11-17T10:00:00.000Z');
  const agora2 = new Date('2026-11-17T11:00:00.000Z');
  let mode = '401';
  const server = await escutar((request, response) => {
    if (mode === '200') {
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
      return;
    }
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: tokenDownload, code: 190 } }));
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    const baixar = baixarLocal(base, ctx.pasta);
    const id = 'wamid-pausa-download';
    await assert.rejects(processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: id } }), {
      agora: agora1,
      pastaComprovantes: ctx.pasta,
      baixar,
      env: envDownload(),
      controle,
    }), (error) => error instanceof MidiaError && error.pausa === true && error.message === 'token invalido (code 190)');
    assert.equal(ctx.database.prepare('SELECT status FROM pedidos WHERE id = ?').get(ctx.pedidoId).status, 'aguardando_pagamento');
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM comprovantes').get().n, 0);
    assert.equal((await readdir(ctx.pasta)).length, 0);
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_saida WHERE wamid = ?').get(id).n, 0);
    const marcada = ctx.database.prepare(`
      SELECT status, tentativas, proxima_tentativa_em, ultimo_erro, erro_meta, atualizado_em
      FROM mensagens_saida WHERE id = ?
    `).get(primeira.id);
    assert.equal(marcada.status, 'pendente_envio');
    assert.equal(marcada.tentativas, primeira.tentativas);
    assert.equal(marcada.proxima_tentativa_em, primeira.proxima);
    assert.equal(marcada.ultimo_erro, 'token invalido (code 190)');
    assert.equal(marcada.erro_meta, marcaPausa(tokenDownload));
    assert.equal(marcada.atualizado_em, agora1.toISOString());
    semSegredo(marcada.ultimo_erro);
    assert.equal(String(marcada.erro_meta).includes(tokenDownload), false);
    const vizinha = ctx.database.prepare('SELECT ultimo_erro, erro_meta, tentativas FROM mensagens_saida WHERE id = ?').get(segunda.id);
    assert.equal(vizinha.ultimo_erro, 'vizinha');
    assert.equal(vizinha.erro_meta, null);
    assert.equal(vizinha.tentativas, 4);
    assert.equal(controle.pausado, true);
    assert.equal(controle.codigo, 190);
    assert.equal(controle.desde, agora1.toISOString());

    await assert.rejects(processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: 'wamid-pausa-2' } }), {
      agora: agora2,
      pastaComprovantes: ctx.pasta,
      baixar,
      env: envDownload(),
      controle,
    }), (error) => error.pausa === true);
    const deNovo = ctx.database.prepare('SELECT tentativas, proxima_tentativa_em, ultimo_erro, erro_meta, atualizado_em FROM mensagens_saida WHERE id = ?').get(primeira.id);
    assert.equal(deNovo.atualizado_em, agora1.toISOString());
    assert.equal(deNovo.erro_meta, marcada.erro_meta);
    assert.equal(deNovo.tentativas, primeira.tentativas);
    assert.equal(deNovo.proxima_tentativa_em, primeira.proxima);
    assert.equal(controle.desde, agora1.toISOString());
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada').get().n, 2);

    mode = '200';
    const ok = await processarEntrada(ctx.database, entradaImagem({ campos: { id_mensagem: 'wamid-pausa-ok' } }), {
      agora: agora2,
      pastaComprovantes: ctx.pasta,
      baixar,
      env: envDownload(),
      controle,
    });
    assert.equal(ok.estado, 'pagamento_em_analise');
    assert.equal(ok.resposta, TEXTO_EM_ANALISE);
    const saidaNova = ctx.database.prepare('SELECT status, erro_meta FROM mensagens_saida WHERE wamid = ?').get('wamid-pausa-ok');
    assert.equal(saidaNova.status, 'pendente_envio');
    assert.equal(saidaNova.erro_meta, null);
    assert.equal(controle.pausado, true);
    assert.equal(controle.desde, agora1.toISOString());
    const pedido = ctx.database.prepare('SELECT status FROM pedidos WHERE id = ?').get(ctx.pedidoId);
    assert.equal(pedido.status, 'pagamento_em_analise');
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('sem saida pendente a pausa fica so em memoria', async () => {
  const ctx = await bancoTemporario();
  const controle = criarControleEnvio();
  const server = await escutar((request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'recusado', code: 190 } }));
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta),
      env: envDownload(),
      controle,
    }), (error) => error.pausa === true);
    assert.equal(controle.pausado, true);
    assert.equal(controle.codigo, 190);
    assert.equal(ctx.database.prepare(`SELECT COUNT(*) AS n FROM mensagens_saida WHERE COALESCE(erro_meta, '') LIKE 'pausa:%'`).get().n, 0);
    await pedidoIntacto(ctx);
    const corpo = respostaSaidas(ctx.database, { envioAtivo: true, controle });
    semSegredo(JSON.stringify(corpo));
    assert.equal(corpo.envio_pausado, true);
    assert.equal(corpo.codigo, 190);
    assert.equal(corpo.fila_token_invalido_pendentes, 0);
    assert.equal(corpo.fila_token_invalido_falhou, 0);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('403 da URL sem JSON nao pausa e a contagem da fila nao expoe a marca', async () => {
  const ctx = await bancoTemporario();
  const pendente = gravarPendente(ctx);
  const controle = criarControleEnvio();
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
    response.writeHead(403, { 'Content-Type': 'text/plain' });
    response.end('forbidden');
  });
  try {
    const base = new URL(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(processarEntrada(ctx.database, entradaImagem(), {
      pastaComprovantes: ctx.pasta,
      baixar: baixarLocal(base, ctx.pasta),
      env: envDownload(),
      controle,
    }), (error) => error instanceof MidiaError && error.codigo === 'transitorio' && error.pausa !== true);
    assert.equal(controle.pausado, false);
    const linha = ctx.database.prepare('SELECT erro_meta, ultimo_erro FROM mensagens_saida WHERE id = ?').get(pendente.id);
    assert.equal(linha.erro_meta, null);
    assert.equal(linha.ultimo_erro, '');
    assert.equal(ctx.database.prepare('SELECT status FROM pedidos WHERE id = ?').get(ctx.pedidoId).status, 'aguardando_pagamento');
    assert.equal(ctx.database.prepare('SELECT COUNT(*) AS n FROM comprovantes').get().n, 0);
    assert.equal((await readdir(ctx.pasta)).length, 0);
    const agora = new Date().toISOString();
    ctx.database.prepare(`
      INSERT INTO fila_webhook (
        wamid, telefone, nome, tipo, texto, timestamp_mensagem, origem, corpo, status,
        tentativas, proxima_tentativa_em, ultimo_erro, criado_em, atualizado_em
      ) VALUES (?, '11988887777', 'Ana', 'imagem', '', ?, 'whatsapp', '{}', 'pendente', 1, ?, 'token invalido (code 190)', ?, ?)
    `).run('wamid.fila.1', agora, agora, agora, agora);
    ctx.database.prepare(`
      INSERT INTO fila_webhook (
        wamid, telefone, nome, tipo, texto, timestamp_mensagem, origem, corpo, status,
        tentativas, proxima_tentativa_em, ultimo_erro, criado_em, atualizado_em
      ) VALUES (?, '11988887777', 'Ana', 'imagem', '', ?, 'whatsapp', '{}', 'falhou', 30, ?, 'token invalido', ?, ?)
    `).run('wamid.fila.2', agora, agora, agora, agora);
    ctx.database.prepare(`
      INSERT INTO fila_webhook (
        wamid, telefone, nome, tipo, texto, timestamp_mensagem, origem, corpo, status,
        tentativas, proxima_tentativa_em, ultimo_erro, criado_em, atualizado_em
      ) VALUES (?, '11988887777', 'Ana', 'imagem', '', ?, 'whatsapp', '{}', 'pendente', 1, ?, 'token invalido (code 190) extra', ?, ?)
    `).run('wamid.fila.3', agora, agora, agora, agora);
    const corpo = respostaSaidas(ctx.database, { envioAtivo: true, controle });
    semSegredo(JSON.stringify(corpo));
    assert.equal(corpo.fila_token_invalido_pendentes, 1);
    assert.equal(corpo.fila_token_invalido_falhou, 1);
    assert.equal(corpo.envio_pausado, false);
  } finally {
    await fechar(server);
    await encerrar(ctx);
  }
});

test('500 do comprovante grava o texto publico na fila e o admin nao expoe o token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'midia-pausa-'));
  const pasta = join(directory, 'comprovantes');
  mkdirSync(pasta);
  const port = 23000 + Math.floor(Math.random() * 20000);
  const graph = await escutar((request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: tokenDownload, type: 'OAuthException', code: 190 } }));
  });
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
      API_TLS_CERT_PATH: '',
      API_TLS_KEY_PATH: '',
      META_ACCESS_TOKEN: tokenDownload,
      META_PHONE_NUMBER_ID: '99',
      META_GRAPH_VERSION: 'v0.0',
      META_GRAPH_BASE_URL: `http://127.0.0.1:${graph.address().port}`,
      COMPROVANTES_DIR: pasta,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let database;
  try {
    const limite = Date.now() + 8000;
    while (Date.now() < limite && !stdout.includes(`http://127.0.0.1:${port}`)) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
    database = new DatabaseSync(join(directory, 'teste.sqlite'));
    database.exec('PRAGMA busy_timeout = 5000');
    const evento = database.prepare(`SELECT id FROM eventos WHERE codigo = 'evento-demonstracao'`).get();
    const lote = database.prepare('SELECT id FROM lotes WHERE evento_id = ? LIMIT 1').get(evento.id);
    const agora = new Date().toISOString();
    const telefone = digitosTelefone('11988887777');
    database.prepare(`
      INSERT INTO pedidos (
        protocolo, evento_id, lote_id, data_contato, origem, comprador_nome, comprador_telefone,
        quantidade, valor_unitario_centavos, valor_total_centavos, reserva_expira_em,
        status, status_pagamento, criado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, 'teste', 'Ana', ?, 1, 1000, 1000, ?, 'aguardando_pagamento', 'pendente', ?, ?)
    `).run(`P-${randomUUID()}`, evento.id, lote.id, agora, telefone, agora, agora, agora);
    database.prepare(`
      INSERT INTO mensagens_entrada (wamid, telefone, nome, tipo, texto, recebida_em, origem)
      VALUES ('wamid-texto-admin', ?, 'Lia', 'texto', 'oi', ?, 'whatsapp')
    `).run(telefone, agora);
    database.prepare(`
      INSERT INTO mensagens_saida (
        wamid, texto, status, criada_em, tentativas, proxima_tentativa_em, ultimo_erro, atualizado_em
      ) VALUES ('wamid-texto-admin', 'oi', 'pendente_envio', ?, 1, '2099-01-01T00:00:00.000Z', '', ?)
    `).run(agora, agora);
    const resposta = await fetch(`http://127.0.0.1:${port}/interno/mensagem`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        telefone: '11988887777',
        nome: 'Ana',
        tipo: 'imagem',
        id_mensagem: 'wamid-admin-img',
        evento_codigo: 'evento-demonstracao',
        midia_id: 'midia-1',
        midia_mime: 'image/png',
        midia_sha256: hashPng,
        midia_nome: 'pix.png',
      }),
    });
    const bruto = await resposta.text();
    assert.equal(resposta.status, 500);
    assert.equal(JSON.parse(bruto).erro, 'token invalido (code 190)');
    semSegredo(bruto);
    semSegredo(stderr);
    semSegredo(stdout);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM mensagens_entrada WHERE wamid = ?').get('wamid-admin-img').n, 0);
    assert.equal(database.prepare(`SELECT status FROM pedidos WHERE comprador_telefone = ?`).get(telefone).status, 'aguardando_pagamento');
    assert.equal((await readdir(pasta)).length, 0);
    const marcada = database.prepare(`SELECT erro_meta, ultimo_erro, status, tentativas FROM mensagens_saida WHERE wamid = 'wamid-texto-admin'`).get();
    assert.equal(marcada.status, 'pendente_envio');
    assert.equal(marcada.tentativas, 1);
    assert.equal(marcada.ultimo_erro, 'token invalido (code 190)');
    assert.equal(marcada.erro_meta, marcaPausa(tokenDownload));
    semSegredo(marcada.ultimo_erro);

    database.prepare(`
      INSERT INTO fila_webhook (
        wamid, telefone, nome, tipo, texto, timestamp_mensagem, origem, corpo, status,
        tentativas, proxima_tentativa_em, ultimo_erro, criado_em, atualizado_em
      ) VALUES ('wamid.fila.admin', ?, 'Ana', 'imagem', '', ?, 'whatsapp', '{}', 'pendente', 0, ?, '', ?, ?)
    `).run(telefone, agora, agora, agora, agora);
    const entrega = await processarProxima(database, {
      entregar: async () => ({ status: 500, erro: JSON.parse(bruto).erro }),
      agora: new Date(),
    });
    assert.equal(entrega.status, 'pendente');
    const guardado = database.prepare(`SELECT status, tentativas, ultimo_erro FROM fila_webhook WHERE wamid = 'wamid.fila.admin'`).get();
    assert.equal(guardado.status, 'pendente');
    assert.equal(guardado.tentativas, 1);
    assert.equal(guardado.ultimo_erro, 'token invalido (code 190)');
    semSegredo(guardado.ultimo_erro);
    database.prepare(`
      INSERT INTO fila_webhook (
        wamid, telefone, nome, tipo, texto, timestamp_mensagem, origem, corpo, status,
        tentativas, proxima_tentativa_em, ultimo_erro, criado_em, atualizado_em
      ) VALUES ('wamid.fila.falhou', ?, 'Ana', 'imagem', '', ?, 'whatsapp', '{}', 'falhou', 30, ?, 'token invalido', ?, ?)
    `).run(telefone, agora, agora, agora, agora);
    const headers = { Authorization: `Bearer ${adminToken}` };
    const saidas = await fetch(`http://127.0.0.1:${port}/admin/whatsapp/saidas`, { headers });
    const textoSaidas = await saidas.text();
    semSegredo(textoSaidas);
    const jsonSaidas = JSON.parse(textoSaidas);
    assert.equal(jsonSaidas.envio_pausado, true);
    assert.equal(jsonSaidas.codigo, 190);
    assert.equal(jsonSaidas.fila_token_invalido_pendentes, 1);
    assert.equal(jsonSaidas.fila_token_invalido_falhou, 1);
    const filaAdmin = await fetch(`http://127.0.0.1:${port}/admin/whatsapp/fila`, { headers });
    const textoFila = await filaAdmin.text();
    semSegredo(textoFila);
    assert.equal(textoFila.includes('token invalido'), true);
    const retomar = await fetch(`http://127.0.0.1:${port}/admin/whatsapp/envio/retomar`, {
      method: 'POST',
      headers,
    });
    const textoRetomar = await retomar.text();
    assert.equal(retomar.status, 409);
    semSegredo(textoRetomar);
    assert.equal(JSON.parse(textoRetomar).exige_confirmacao, true);
  } finally {
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    await fechar(graph);
    try { database?.close(); } catch { /* fechado */ }
    await rm(directory, { recursive: true, force: true });
  }
});
