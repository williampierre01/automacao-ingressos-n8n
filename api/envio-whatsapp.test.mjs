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
import { aplicarStatuses } from './custo-whatsapp.mjs';
import {
  criarControleEnvio,
  esperaDoCiclo,
  iniciarEnvio,
  marcarEnviosIncertos,
  processarProximaSaida,
  reenviarSaida,
  respostaSaidas,
  retomarEnvio,
} from './envio-whatsapp.mjs';
import { hashTokenEnvio, limparMarcasPausa, marcaPausa } from './pausa-envio.mjs';
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
    assert.equal(resposta.error_subcode, undefined);
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

test('enviarTexto devolve error_subcode sem precisar da rede', async () => {
  const token = 's'.repeat(24);
  const resposta = await enviarTexto({
    base: new URL('http://127.0.0.1'),
    versao: 'v0.0',
    phoneNumberId: '99',
    token,
    para: '5511999999999',
    texto: 'ola',
    callbackData: '7',
    fetchImpl: async () => ({
      status: 400,
      text: async () => JSON.stringify({
        error: { code: 190, error_subcode: 463, message: token, type: 'OAuthException' },
      }),
    }),
  });
  assert.equal(resposta.status, 400);
  assert.equal(resposta.codigo, 190);
  assert.equal(resposta.error_subcode, 463);
  assert.equal(String(resposta.mensagem).includes(token), true);
});

test('token invalido pausa sem gastar tentativa e sem outro POST', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-21T15:00:00.000Z');
  const token = 'k'.repeat(24);
  const controle = criarControleEnvio();
  try {
    const id = gravarSaida(database, {
      wamid: 'wamid.pausa', telefone: '5511666660001', texto: 'ola', recebidaEm: agora.toISOString(),
    });
    database.prepare(`
      UPDATE mensagens_saida
      SET tentativas = 4, proxima_tentativa_em = ?
      WHERE id = ?
    `).run('2026-10-21T14:00:00.000Z', id);
    let durante = null;
    const pausa = await processarProximaSaida(database, {
      agora,
      controle,
      token,
      enviar: async () => {
        durante = database.prepare('SELECT status, tentativas FROM mensagens_saida WHERE id = ?').get(id);
        return { status: 401, codigo: 190, mensagem: token, error_subcode: 463 };
      },
    });
    assert.equal(pausa.status, 'pausado');
    assert.equal(durante.status, 'enviando');
    assert.equal(durante.tentativas, 5);
    const linha = database.prepare(`
      SELECT status, tentativas, proxima_tentativa_em, ultimo_erro FROM mensagens_saida WHERE id = ?
    `).get(id);
    assert.equal(linha.status, 'pendente_envio');
    assert.equal(linha.tentativas, 4);
    assert.equal(linha.proxima_tentativa_em, '2026-10-21T14:00:00.000Z');
    assert.equal(linha.ultimo_erro, 'token invalido (code 190)');
    assert.equal(linha.ultimo_erro.includes(token), false);
    const marca = database.prepare('SELECT erro_meta FROM mensagens_saida WHERE id = ?').get(id).erro_meta;
    assert.equal(marca === marcaPausa(token), true);
    assert.equal(String(marca).includes(token), false);
    assert.equal(controle.pausado, true);
    assert.equal(controle.codigo, 190);

    const outro = gravarSaida(database, {
      wamid: 'wamid.outro', telefone: '5511666660002', texto: 'oi', recebidaEm: agora.toISOString(),
    });
    let posts = 0;
    const segurou = await processarProximaSaida(database, {
      agora,
      controle,
      enviar: async () => { posts += 1; return { status: 200, wamid: 'wamid.nao' }; },
    });
    assert.equal(segurou.processou, false);
    assert.equal(posts, 0);
    const outroLinha = database.prepare('SELECT status, erro_meta, ultimo_erro FROM mensagens_saida WHERE id = ?').get(outro);
    assert.equal(outroLinha.status, 'pendente_envio');
    assert.equal(outroLinha.erro_meta, null);
    assert.equal(outroLinha.ultimo_erro, '');

    const idFalhou = gravarSaida(database, {
      wamid: 'wamid.ja-falhou', telefone: '5511666660003', texto: 'x', recebidaEm: agora.toISOString(),
    });
    database.prepare(`UPDATE mensagens_saida SET status = 'falhou' WHERE id = ?`).run(idFalhou);
    assert.equal(reenviarSaida(database, idFalhou, { confirmar: true, agora }).status, 'pendente_envio');
    const manual = await processarProximaSaida(database, {
      agora,
      controle,
      enviar: async () => { posts += 1; return { status: 200, wamid: 'wamid.nao' }; },
    });
    assert.equal(manual.processou, false);
    assert.equal(posts, 0);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('status abaixo de 400 e fora de 2xx fica incerto com as tentativas de antes do claim', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-21T15:00:00.000Z');
  try {
    const id = gravarSaida(database, {
      wamid: 'wamid.302', telefone: '5511500000302', texto: 'x', recebidaEm: agora.toISOString(),
    });
    database.prepare('UPDATE mensagens_saida SET tentativas = 4 WHERE id = ?').run(id);
    const incerto = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 302 }),
    });
    assert.equal(incerto.status, 'envio_incerto');
    const linha = database.prepare('SELECT status, tentativas, ultimo_erro FROM mensagens_saida WHERE id = ?').get(id);
    assert.equal(linha.status, 'envio_incerto');
    assert.equal(linha.tentativas, 4);
    assert.equal(linha.ultimo_erro, 'HTTP 302');
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('400 com code 130429 reagenda contando tentativa e code 100 continua falhou', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-21T15:00:00.000Z');
  const recebidaEm = agora.toISOString();
  try {
    const idLimite = gravarSaida(database, {
      wamid: 'wamid.130429', telefone: '5511600000001', texto: 'x', recebidaEm,
    });
    const limite = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 400, codigo: 130429, mensagem: 'throughput' }),
    });
    assert.equal(limite.status, 'pendente_envio');
    const reagendada = database.prepare(`
      SELECT status, tentativas, proxima_tentativa_em FROM mensagens_saida WHERE id = ?
    `).get(idLimite);
    assert.equal(reagendada.status, 'pendente_envio');
    assert.equal(reagendada.tentativas, 1);
    assert.ok(reagendada.proxima_tentativa_em > recebidaEm);

    const id100 = gravarSaida(database, {
      wamid: 'wamid.100b', telefone: '5511600000002', texto: 'y', recebidaEm,
    });
    const falha = await processarProximaSaida(database, {
      agora,
      enviar: async () => ({ status: 400, codigo: 100, mensagem: 'parametro' }),
    });
    assert.equal(falha.id, id100);
    assert.equal(falha.status, 'falhou');
    const erro = database.prepare('SELECT status, tentativas FROM mensagens_saida WHERE id = ?').get(id100);
    assert.equal(erro.status, 'falhou');
    assert.equal(erro.tentativas, 1);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('codes de token pausam e o 4xx comum continua falhou', async () => {
  const { database, diretorio } = await banco();
  const agora = new Date('2026-10-21T15:00:00.000Z');
  const recebidaEm = agora.toISOString();
  try {
    const casos = [
      ['wamid.190', { status: 400, codigo: 190, mensagem: 'segredo-190' }],
      ['wamid.100', { status: 400, codigo: 100, mensagem: 'parametro' }],
      ['wamid.10', { status: 403, codigo: 10, mensagem: 'permissao' }],
      ['wamid.403', { status: 403 }],
      ['wamid.368', { status: 403, codigo: 368, mensagem: 'bloqueio' }],
    ];
    const telefones = ['5511700000001', '5511700000002', '5511700000003', '5511700000004', '5511700000005'];
    const ids = casos.map((item, indice) => gravarSaida(database, {
      wamid: item[0], telefone: telefones[indice], texto: 'x', recebidaEm,
    }));
    const adiar = (id) => {
      database.prepare(`UPDATE mensagens_saida SET proxima_tentativa_em = ? WHERE id = ?`).run('2099-01-01T00:00:00.000Z', id);
    };
    const controle = criarControleEnvio();
    const primeiro = await processarProximaSaida(database, {
      agora, controle, enviar: async () => casos[0][1],
    });
    assert.equal(primeiro.status, 'pausado');
    adiar(ids[0]);
    controle.pausado = false;
    const falha100 = await processarProximaSaida(database, {
      agora, controle, enviar: async () => casos[1][1],
    });
    assert.equal(falha100.status, 'falhou');
    assert.match(database.prepare('SELECT ultimo_erro FROM mensagens_saida WHERE id = ?').get(ids[1]).ultimo_erro, /^100 /);
    const pausa10 = await processarProximaSaida(database, {
      agora, controle, enviar: async () => casos[2][1],
    });
    assert.equal(pausa10.status, 'pausado');
    assert.equal(controle.codigo, 10);
    adiar(ids[2]);
    controle.pausado = false;
    const semJson = await processarProximaSaida(database, {
      agora, controle, enviar: async () => casos[3][1],
    });
    assert.equal(semJson.status, 'pausado');
    assert.equal(database.prepare('SELECT ultimo_erro FROM mensagens_saida WHERE id = ?').get(ids[3]).ultimo_erro, 'token invalido');
    adiar(ids[3]);
    controle.pausado = false;
    let postsDepois = 0;
    const bloqueio = await processarProximaSaida(database, {
      agora, controle, enviar: async () => casos[4][1],
    });
    assert.equal(bloqueio.status, 'falhou');
    assert.equal(controle.pausado, false);
    const seguinte = gravarSaida(database, {
      wamid: 'wamid.segue', telefone: '5511700000006', texto: 'y', recebidaEm,
    });
    const seguiu = await processarProximaSaida(database, {
      agora,
      controle,
      enviar: async (pedido) => {
        postsDepois += 1;
        assert.equal(pedido.callbackData, String(seguinte));
        return { status: 200, wamid: 'wamid.ok' };
      },
    });
    assert.equal(seguiu.status, 'enviada');
    assert.equal(postsDepois, 1);
    assert.equal(database.prepare(`SELECT COUNT(*) AS n FROM mensagens_saida WHERE status = 'falhou'`).get().n, 2);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

function esperar(predicado, ms = 1500) {
  const limite = Date.now() + ms;
  return new Promise((resolve) => {
    const passo = () => {
      if (predicado() || Date.now() >= limite) {
        resolve(Boolean(predicado()));
        return;
      }
      setTimeout(passo, 20);
    };
    passo();
  });
}

test('boot com o mesmo hash nao chama a Graph; outro hash limpa a marca e envia', async () => {
  const token = 'm'.repeat(24);
  const outroToken = 'n'.repeat(24);
  const agora = new Date().toISOString();
  const primeiro = await banco();
  const controle = criarControleEnvio();
  let posts = 0;
  let parar = () => {};
  try {
    const id = gravarSaida(primeiro.database, {
      wamid: 'wamid.marca', telefone: '5511555550001', texto: 'ola', recebidaEm: agora,
    });
    const vizinho = gravarSaida(primeiro.database, {
      wamid: 'wamid.vizinho', telefone: '5511555550002', texto: 'oi', recebidaEm: agora,
    });
    primeiro.database.prepare(`
      UPDATE mensagens_saida
      SET ultimo_erro = 'token invalido (code 190)', erro_meta = ?, atualizado_em = '2026-10-21T12:00:00.000Z'
      WHERE id = ?
    `).run(marcaPausa(token), id);
    primeiro.database.prepare(`
      UPDATE mensagens_saida SET status = 'falhou', erro_meta = '131026 undeliverable' WHERE id = ?
    `).run(vizinho);
    const livre = gravarSaida(primeiro.database, {
      wamid: 'wamid.livre', telefone: '5511555550003', texto: 'ei', recebidaEm: agora,
    });
    parar = iniciarEnvio(primeiro.database, {
      config: { ativo: true, token },
      controle,
      intervaloMs: 20,
      enviar: async () => {
        posts += 1;
        return { status: 200, wamid: `wamid.boot.${posts}` };
      },
    });
    assert.equal(controle.pausado, true);
    assert.equal(controle.codigo, 190);
    assert.equal(controle.desde, '2026-10-21T12:00:00.000Z');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(posts, 0);
    assert.equal(primeiro.database.prepare('SELECT status FROM mensagens_saida WHERE id = ?').get(livre).status, 'pendente_envio');
    assert.equal(primeiro.database.prepare('SELECT erro_meta FROM mensagens_saida WHERE id = ?').get(vizinho).erro_meta, '131026 undeliverable');
    parar();
    parar = () => {};
    const desligado = criarControleEnvio();
    iniciarEnvio(primeiro.database, {
      config: { ativo: false },
      controle: desligado,
      enviar: async () => { posts += 1; return { status: 200, wamid: 'wamid.nao' }; },
    });
    assert.equal(desligado.pausado, false);
    assert.equal(primeiro.database.prepare('SELECT erro_meta FROM mensagens_saida WHERE id = ?').get(id).erro_meta === marcaPausa(token), true);
  } finally {
    parar();
    primeiro.database.close();
    await rm(primeiro.diretorio, { recursive: true, force: true });
  }

  const segundo = await banco();
  const controleNovo = criarControleEnvio();
  let postsNovos = 0;
  let pararNovo = () => {};
  try {
    const id = gravarSaida(segundo.database, {
      wamid: 'wamid.troca', telefone: '5511555550004', texto: 'ola', recebidaEm: agora,
    });
    segundo.database.prepare(`
      UPDATE mensagens_saida
      SET ultimo_erro = 'token invalido (code 190)', erro_meta = ?, atualizado_em = '2026-10-21T12:00:00.000Z'
      WHERE id = ?
    `).run(marcaPausa(token), id);
    pararNovo = iniciarEnvio(segundo.database, {
      config: { ativo: true, token: outroToken },
      controle: controleNovo,
      intervaloMs: 20,
      enviar: async () => {
        postsNovos += 1;
        return { status: 200, wamid: 'wamid.trocado' };
      },
    });
    assert.equal(controleNovo.pausado, false);
    assert.equal(segundo.database.prepare('SELECT erro_meta FROM mensagens_saida WHERE id = ?').get(id).erro_meta, null);
    assert.equal(await esperar(() => postsNovos === 1), true);
    assert.equal(segundo.database.prepare('SELECT status FROM mensagens_saida WHERE id = ?').get(id).status, 'enviada');
  } finally {
    pararNovo();
    segundo.database.close();
    await rm(segundo.diretorio, { recursive: true, force: true });
  }
});

test('statuses nao apaga a marca de pausa', async () => {
  const { database, diretorio } = await banco();
  const token = 'p'.repeat(24);
  try {
    const id = gravarSaida(database, {
      wamid: 'wamid.marca-status', telefone: '5511444440001', texto: 'ola', recebidaEm: '2026-10-21T15:00:00.000Z',
    });
    const marca = marcaPausa(token);
    database.prepare(`UPDATE mensagens_saida SET erro_meta = ?, ultimo_erro = ? WHERE id = ?`).run(marca, 'token invalido (code 190)', id);
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out',
        status: 'failed',
        biz_opaque_callback_data: String(id),
        errors: [{ code: 131026, title: token }],
      }] } }] }],
    });
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out',
        status: 'sent',
        biz_opaque_callback_data: String(id),
      }] } }] }],
    });
    const linha = database.prepare('SELECT status, erro_meta, ultimo_erro FROM mensagens_saida WHERE id = ?').get(id);
    assert.equal(linha.status, 'pendente_envio');
    assert.equal(linha.erro_meta === marca, true);
    assert.equal(String(linha.erro_meta).includes(token), false);
    assert.equal(linha.ultimo_erro, 'token invalido (code 190)');
    assert.equal(limparMarcasPausa(database), 1);
    assert.equal(database.prepare('SELECT erro_meta FROM mensagens_saida WHERE id = ?').get(id).erro_meta, null);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('retomar exige confirmacao, nao antecipa a fila e sem pausa nao erra', async () => {
  const { database, diretorio } = await banco();
  const token = 'r'.repeat(24);
  const agora = new Date('2026-10-21T15:00:00.000Z');
  const controle = criarControleEnvio();
  try {
    const id = gravarSaida(database, {
      wamid: 'wamid.retomar', telefone: '5511333330001', texto: 'ola', recebidaEm: agora.toISOString(),
    });
    const proxima = '2099-01-01T00:00:00.000Z';
    database.prepare(`
      UPDATE mensagens_saida
      SET tentativas = 3, proxima_tentativa_em = ?, ultimo_erro = 'token invalido (code 10)',
        erro_meta = ?, atualizado_em = '2026-10-21T12:00:00.000Z'
      WHERE id = ?
    `).run(proxima, marcaPausa(token), id);
    const alerta = gravarSaida(database, {
      wamid: 'wamid.alerta', telefone: '5511333330002', texto: 'x', recebidaEm: agora.toISOString(),
    });
    database.prepare(`
      UPDATE mensagens_saida SET status = 'falhou', ultimo_erro = 'bloqueio', erro_meta = ? WHERE id = ?
    `).run(marcaPausa(token), alerta);
    controle.pausado = true;
    controle.codigo = 10;
    controle.desde = '2026-10-21T12:00:00.000Z';
    const antes = database.prepare(`
      SELECT status, tentativas, proxima_tentativa_em, ultimo_erro, erro_meta, atualizado_em
      FROM mensagens_saida WHERE id = ?
    `).get(id);
    assert.throws(() => retomarEnvio(database, controle), (error) => error.codigo === 'CONFIRMAR');
    const depois = database.prepare(`
      SELECT status, tentativas, proxima_tentativa_em, ultimo_erro, erro_meta, atualizado_em
      FROM mensagens_saida WHERE id = ?
    `).get(id);
    assert.equal(depois.status, antes.status);
    assert.equal(depois.tentativas, 3);
    assert.equal(depois.proxima_tentativa_em, proxima);
    assert.equal(depois.atualizado_em, antes.atualizado_em);
    assert.equal(depois.erro_meta === antes.erro_meta, true);
    assert.equal(controle.pausado, true);

    const corpo = respostaSaidas(database, { envioAtivo: true, controle });
    const texto = JSON.stringify(corpo);
    assert.equal(texto.includes(token), false);
    assert.equal(texto.includes('pausa:'), false);
    assert.equal(texto.includes(hashTokenEnvio(token)), false);
    assert.equal(texto.includes('token invalido'), false);
    assert.equal(corpo.envio_pausado, true);
    assert.equal(corpo.codigo, 10);
    assert.equal(corpo.pausado_desde, '2026-10-21T12:00:00.000Z');
    assert.equal(corpo.saidas_aguardando, 1);
    assert.equal(corpo.itens.length, 1);
    assert.equal(corpo.itens[0].id, alerta);
    assert.equal(corpo.itens[0].erro_meta, '');
    assert.equal(corpo.itens[0].ultimo_erro, 'bloqueio');

    const retomado = retomarEnvio(database, controle, { confirmar: true });
    const textoRetomado = JSON.stringify(retomado);
    assert.equal(textoRetomado.includes('pausa:'), false);
    assert.equal(textoRetomado.includes(token), false);
    assert.equal(textoRetomado.includes(hashTokenEnvio(token)), false);
    assert.equal(retomado.retomado, true);
    assert.equal(controle.pausado, false);
    assert.equal(controle.drenar, true);
    const fila = database.prepare(`
      SELECT status, tentativas, proxima_tentativa_em, erro_meta FROM mensagens_saida WHERE id = ?
    `).get(id);
    assert.equal(fila.status, 'pendente_envio');
    assert.equal(fila.tentativas, 3);
    assert.equal(fila.proxima_tentativa_em, proxima);
    assert.equal(fila.erro_meta, null);
    assert.equal(database.prepare('SELECT erro_meta FROM mensagens_saida WHERE id = ?').get(alerta).erro_meta, null);
    assert.deepEqual(retomarEnvio(database, controle), { mensagem: 'nada a retomar' });
    assert.equal(esperaDoCiclo(true, controle, 1000), 1000);
    assert.equal(controle.drenar, true);
    assert.equal(esperaDoCiclo(false, controle, 1000), 1000);
    assert.equal(controle.drenar, false);
    assert.equal(esperaDoCiclo(true, controle, 1000), 0);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('GET /admin/whatsapp/saidas e o retomar nao devolvem a marca', async () => {
  const { database, diretorio, caminho } = await banco();
  const token = 'q'.repeat(24);
  const admin = 'abcdefghijklmnopqrstuvwx';
  const agora = new Date().toISOString();
  const id = gravarSaida(database, {
    wamid: 'wamid.http', telefone: '5511222220001', texto: 'ola', recebidaEm: agora,
  });
  database.prepare(`
    UPDATE mensagens_saida
    SET tentativas = 2, proxima_tentativa_em = '2099-01-01T00:00:00.000Z',
      ultimo_erro = 'token invalido (code 190)', erro_meta = ?, atualizado_em = '2026-10-21T12:00:00.000Z'
    WHERE id = ?
  `).run(marcaPausa(token), id);
  database.close();
  let posts = 0;
  const graph = createServer((req, res) => {
    posts += 1;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'recusado', code: 190 } }));
  });
  await new Promise((resolve) => graph.listen(0, '127.0.0.1', resolve));
  const porta = 22000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ['api/server.mjs'], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      ADMIN_TOKEN: admin,
      API_INTERNAL_TOKEN: admin,
      API_HOST: '127.0.0.1',
      API_PORT: String(porta),
      API_DATABASE_PATH: caminho,
      META_ACCESS_TOKEN: token,
      META_PHONE_NUMBER_ID: '99',
      META_GRAPH_VERSION: 'v0.0',
      META_GRAPH_BASE_URL: `http://127.0.0.1:${graph.address().port}`,
      API_TLS_CERT_PATH: '',
      API_TLS_KEY_PATH: '',
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const base = `http://127.0.0.1:${porta}`;
  try {
    const limite = Date.now() + 8000;
    while (Date.now() < limite && !stdout.includes(`http://127.0.0.1:${porta}`)) {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(stderr.includes(token), false);
    assert.match(stdout, new RegExp(`http://127\\.0\\.0\\.1:${porta}`));
    const lido = await fetch(`${base}/admin/whatsapp/saidas`, { headers: { Authorization: `Bearer ${admin}` } });
    const texto = await lido.text();
    assert.equal(texto.includes(token), false);
    assert.equal(texto.includes('pausa:'), false);
    assert.equal(texto.includes(hashTokenEnvio(token)), false);
    assert.equal(texto.includes('token invalido'), false);
    const json = JSON.parse(texto);
    assert.equal(json.envio_pausado, true);
    assert.equal(json.codigo, 190);
    assert.equal(json.saidas_aguardando, 1);
    assert.equal(json.itens.some((item) => item.id === id), false);
    const semConfirmar = await fetch(`${base}/admin/whatsapp/envio/retomar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
    });
    assert.equal(semConfirmar.status, 409);
    const corpo409 = await semConfirmar.text();
    assert.equal(corpo409.includes(token), false);
    assert.equal(corpo409.includes('pausa:'), false);
    assert.equal(JSON.parse(corpo409).exige_confirmacao, true);
    const conferido = new DatabaseSync(caminho);
    conferido.exec('PRAGMA busy_timeout = 5000');
    const meio = conferido.prepare('SELECT status, tentativas, erro_meta FROM mensagens_saida WHERE id = ?').get(id);
    conferido.close();
    assert.equal(meio.status, 'pendente_envio');
    assert.equal(meio.tentativas, 2);
    assert.equal(meio.erro_meta === marcaPausa(token), true);
    const confirmado = await fetch(`${base}/admin/whatsapp/envio/retomar?confirmar=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
    });
    const textoConfirmado = await confirmado.text();
    assert.equal(confirmado.status, 200);
    assert.equal(textoConfirmado.includes(token), false);
    assert.equal(textoConfirmado.includes('pausa:'), false);
    assert.equal(textoConfirmado.includes(hashTokenEnvio(token)), false);
    assert.equal(JSON.parse(textoConfirmado).retomado, true);
    const deNovo = await fetch(`${base}/admin/whatsapp/envio/retomar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${admin}` },
    });
    const textoDeNovo = await deNovo.text();
    assert.equal(deNovo.status, 200);
    assert.equal(JSON.parse(textoDeNovo).mensagem, 'nada a retomar');
    assert.equal(posts, 0);
  } finally {
    child.kill();
    await new Promise((resolve) => child.on('exit', resolve));
    await new Promise((resolve) => graph.close(resolve));
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
