import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { digitosTelefone, garantirEventoDemonstracao, migrar } from './lotes.mjs';
import { apagarComprovantesVencidos, diasRetencao, executarRetencao } from './retencao-comprovantes.mjs';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
const agora = new Date('2026-10-21T12:00:00.000Z');

function dia(diasAntes) {
  return new Date(agora.getTime() - diasAntes * 24 * 60 * 60 * 1000).toISOString();
}

async function preparar() {
  const diretorio = await mkdtemp(join(tmpdir(), 'retencao-comprovante-'));
  const pasta = join(diretorio, 'comprovantes');
  mkdirSync(pasta);
  const caminhoBanco = join(diretorio, 'teste.sqlite');
  const database = new DatabaseSync(caminhoBanco);
  database.exec(schema);
  migrar(database, { databasePath: caminhoBanco });
  garantirEventoDemonstracao(database);
  return { diretorio, pasta, database };
}

function pedido(database, status, statusPagamento, atualizadoEm, dataEvento = '2026-12-31') {
  const momento = atualizadoEm || dia(0);
  const eventoId = Number(database.prepare(`
    INSERT INTO eventos (
      codigo, nome, data_evento, local, capacidade_total, status, criado_em, atualizado_em
    ) VALUES (?, 'Evento', ?, 'Local', 10, 'encerrado', ?, ?)
  `).run(`ev-${randomUUID()}`, dataEvento, momento, momento).lastInsertRowid);
  const lote = { id: Number(database.prepare(`
    INSERT INTO lotes (
      evento_id, nome, valor_centavos, quantidade_total, status, criado_em, atualizado_em
    ) VALUES (?, 'Lote', 1000, 10, 'encerrado', ?, ?)
  `).run(eventoId, momento, momento).lastInsertRowid) };
  const evento = { id: eventoId };
  return Number(database.prepare(`
    INSERT INTO pedidos (
      protocolo, evento_id, lote_id, data_contato, origem, comprador_nome, comprador_telefone,
      quantidade, valor_unitario_centavos, valor_total_centavos, status, status_pagamento,
      criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, 'teste', 'Ana', ?, 1, 1000, 1000, ?, ?, ?, ?)
  `).run(
    `P-${randomUUID()}`, evento.id, lote.id, momento, digitosTelefone('11988887777'),
    status, statusPagamento, momento, momento,
  ).lastInsertRowid);
}

function comprovante(database, pasta, pedidoId, { ausente = false, caminho } = {}) {
  const id = randomUUID();
  const nome = caminho || `${id}.png`;
  if (!ausente && !nome.includes('..')) writeFileSync(join(pasta, nome), 'png');
  database.prepare(`
    INSERT INTO comprovantes (id, pedido_id, nome_original, tipo_mime, caminho, tamanho_bytes, sha256, recebido_em)
    VALUES (?, ?, 'nota.png', 'image/png', ?, 3, 'abc123', ?)
  `).run(id, pedidoId, nome, dia(1));
  return { id, nome };
}

test('padrao de retencao e 30 dias apos o evento e 7 apos a recusa', () => {
  assert.deepEqual(diasRetencao({}), { aprovado: 30, recusado: 7 });
  assert.deepEqual(diasRetencao({
    COMPROVANTE_RETENCAO_DIAS_APROVADO: '10',
    COMPROVANTE_RETENCAO_DIAS_RECUSADO: '2',
  }), { aprovado: 10, recusado: 2 });
});

test('retencao apaga so os comprovantes vencidos e tolera arquivo ausente', async () => {
  const ctx = await preparar();
  try {
    const aprovadoVelho = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'concluido', 'aprovado', dia(1), dia(30).slice(0, 10),
    ));
    const aprovadoNovo = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'concluido', 'aprovado', dia(1), dia(29).slice(0, 10),
    ));
    const recusadoVelho = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'pagamento_recusado', 'recusado', dia(7),
    ));
    const recusadoNovo = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'pagamento_recusado', 'recusado', dia(6),
    ));
    const expirado = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'expirado', 'pendente', dia(8),
    ));
    const cancelado = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'cancelado', 'pendente', dia(7),
    ));
    const analise = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'pagamento_em_analise', 'em_analise', dia(40), dia(40).slice(0, 10),
    ));
    const aguardando = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'aguardando_pagamento', 'pendente', dia(40), dia(40).slice(0, 10),
    ));
    const sumido = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'expirado', 'pendente', dia(9),
    ), { ausente: true });
    const fora = join(ctx.diretorio, 'segredo.txt');
    writeFileSync(fora, 'fica');
    const escapou = comprovante(ctx.database, ctx.pasta, pedido(
      ctx.database, 'cancelado', 'pendente', dia(9),
    ), { caminho: '../segredo.txt' });

    const primeiro = apagarComprovantesVencidos(ctx.database, { pasta: ctx.pasta, agora });
    assert.equal(primeiro.apagados, 5);
    for (const item of [aprovadoVelho, recusadoVelho, expirado, cancelado, sumido]) {
      const linha = ctx.database.prepare('SELECT * FROM comprovantes WHERE id = ?').get(item.id);
      assert.equal(linha.apagado_em, agora.toISOString());
      assert.equal(linha.sha256, 'abc123');
      assert.equal(linha.tipo_mime, 'image/png');
      assert.equal(linha.tamanho_bytes, 3);
      assert.equal(existsSync(join(ctx.pasta, item.nome)), false);
    }
    for (const item of [aprovadoNovo, recusadoNovo, analise, aguardando]) {
      const linha = ctx.database.prepare('SELECT apagado_em FROM comprovantes WHERE id = ?').get(item.id);
      assert.equal(linha.apagado_em, null);
      assert.equal(existsSync(join(ctx.pasta, item.nome)), true);
    }
    assert.equal(existsSync(fora), true);
    assert.equal(ctx.database.prepare('SELECT apagado_em FROM comprovantes WHERE id = ?').get(escapou.id).apagado_em, null);
    assert.equal(apagarComprovantesVencidos(ctx.database, { pasta: ctx.pasta, agora }).apagados, 0);
  } finally {
    ctx.database.close();
    await rm(ctx.diretorio, { recursive: true, force: true });
  }
});

test('falha da retencao fica no try proprio', () => {
  const erros = [];
  const resultado = executarRetencao({
    prepare() {
      throw new Error('banco caiu');
    },
  }, { pasta: 'x' }, (error) => erros.push(error.message));
  assert.equal(resultado.falhou, true);
  assert.deepEqual(erros, ['banco caiu']);
});
