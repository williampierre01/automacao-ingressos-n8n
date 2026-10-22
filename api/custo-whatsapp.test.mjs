import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aplicarStatuses } from './custo-whatsapp.mjs';
import { garantirEventoDemonstracao, migrar } from './lotes.mjs';
import { receberEvento } from './whatsapp-gateway.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const schema = readFileSync(join(root, 'api', 'schema.sql'), 'utf8');
const segredo = 'app-secret-de-teste';

function assinar(body) {
  return `sha256=${createHmac('sha256', segredo).update(body).digest('hex')}`;
}

async function banco() {
  const diretorio = await mkdtemp(join(tmpdir(), 'ingressos-custo-'));
  const caminho = join(diretorio, 'teste.sqlite');
  const database = new DatabaseSync(caminho);
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec(schema);
  migrar(database, { databasePath: caminho });
  garantirEventoDemonstracao(database);
  return { database, diretorio };
}

function saida(database, { idWamid, status, statusMeta = null, wamidSaida = null }) {
  const agora = '2026-10-21T15:00:00.000Z';
  database.prepare(`
    INSERT INTO mensagens_entrada (wamid, telefone, nome, tipo, texto, recebida_em, origem)
    VALUES (?, '5511999990001', 'Ana', 'texto', 'oi', ?, 'whatsapp')
  `).run(idWamid, agora);
  return Number(database.prepare(`
    INSERT INTO mensagens_saida (wamid, texto, status, criada_em, status_meta, wamid_saida)
    VALUES (?, 'resposta', ?, ?, ?, ?)
  `).run(idWamid, status, agora, statusMeta, wamidSaida).lastInsertRowid);
}

test('callback promove envio incerto, status_meta nao regride e preco ausente fica nulo', async () => {
  const { database, diretorio } = await banco();
  try {
    const id = saida(database, { idWamid: 'wamid.in', status: 'envio_incerto' });
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out',
        status: 'sent',
        timestamp: '100',
        recipient_id: '5511999990001',
        biz_opaque_callback_data: String(id),
      }] } }] }],
    });
    const promovida = database.prepare('SELECT status, wamid_saida, status_meta FROM mensagens_saida WHERE id = ?').get(id);
    assert.equal(promovida.status, 'enviada');
    assert.equal(promovida.wamid_saida, 'wamid.out');
    assert.equal(promovida.status_meta, 'sent');
    const custo = database.prepare('SELECT billable, pricing_type, category FROM mensagens_custo').get();
    assert.equal(custo.billable, null);
    assert.equal(custo.pricing_type, null);
    assert.equal(JSON.stringify(database.prepare('SELECT * FROM mensagens_custo').get()).includes('5511999990001'), false);

    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out', status: 'read', pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: 'service' },
      }] } }] }],
    });
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out', status: 'delivered', pricing: { billable: false, type: 'free_customer_service', category: 'utility' },
      }] } }] }],
    });
    const meta = database.prepare('SELECT status_meta FROM mensagens_saida WHERE id = ?').get(id);
    assert.equal(meta.status_meta, 'read');
    const sent = database.prepare(`SELECT billable FROM mensagens_custo WHERE status = 'sent'`).get();
    assert.equal(sent.billable, null);
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out', status: 'sent', pricing: { billable: true, pricing_model: 'PMP', type: 'regular', category: 'service' },
      }] } }] }],
    });
    const sentDepois = database.prepare(`SELECT billable, pricing_model FROM mensagens_custo WHERE status = 'sent'`).get();
    assert.equal(sentDepois.billable, 1);
    assert.equal(sentDepois.pricing_model, 'PMP');
    const delivered = database.prepare(`SELECT billable, pricing_type, category FROM mensagens_custo WHERE status = 'delivered'`).get();
    assert.equal(delivered.billable, 0);
    assert.equal(delivered.pricing_type, 'free_customer_service');
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out', status: 'delivered', pricing: { type: 'regular', category: 'service' },
      }] } }] }],
    });
    const repetido = database.prepare(`SELECT pricing_type, category FROM mensagens_custo WHERE status = 'delivered'`).get();
    assert.equal(repetido.pricing_type, 'free_customer_service');
    assert.equal(repetido.category, 'utility');

    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{
        id: 'wamid.out', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }],
      }] } }] }],
    });
    const falhou = database.prepare('SELECT status, status_meta, erro_meta FROM mensagens_saida WHERE id = ?').get(id);
    assert.equal(falhou.status, 'enviada');
    assert.equal(falhou.status_meta, 'failed');
    assert.match(falhou.erro_meta, /131026/);
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.out', status: 'delivered' }] } }] }],
    });
    assert.equal(database.prepare('SELECT status_meta FROM mensagens_saida WHERE id = ?').get(id).status_meta, 'failed');

    const antes = Number(database.prepare('SELECT COUNT(*) AS n FROM mensagens_saida').get().n);
    aplicarStatuses(database, {
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.desconhecido', status: 'sent' }] } }] }],
    });
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS n FROM mensagens_saida').get().n), antes);
    assert.equal(database.prepare(`SELECT wamid_saida FROM mensagens_custo WHERE wamid_saida = 'wamid.desconhecido'`).get().wamid_saida, 'wamid.desconhecido');
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});

test('webhook misto enfileira a mensagem e grava o custo; falha de banco responde 500', async () => {
  const { database, diretorio } = await banco();
  try {
    const corpo = Buffer.from(JSON.stringify({
      entry: [{ changes: [{ value: {
        contacts: [{ profile: { name: 'Ana' }, wa_id: '5511999990009' }],
        messages: [{ from: '5511999990009', id: 'wamid.msg', timestamp: '1', type: 'text', text: { body: 'oi' } }],
        statuses: [{ id: 'wamid.custo', status: 'delivered' }],
      } }] }],
    }));
    const ok = receberEvento(database, corpo, { signature: assinar(corpo), appSecret: segredo });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.enfileiradas, 1);
    assert.equal(ok.json.custos, 1);
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS n FROM fila_webhook WHERE wamid = 'wamid.custo'`).get().n), 0);
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS n FROM fila_webhook WHERE wamid = 'wamid.msg'`).get().n), 1);

    database.exec(`
      CREATE TRIGGER abortar_custo BEFORE INSERT ON mensagens_custo
      BEGIN
        SELECT RAISE(ABORT, 'falha proposital');
      END
    `);
    const outro = Buffer.from(JSON.stringify({
      entry: [{ changes: [{ value: {
        messages: [{ from: '5511999990008', id: 'wamid.outra', timestamp: '1', type: 'text', text: { body: 'oi' } }],
        statuses: [{ id: 'wamid.falha', status: 'sent' }],
      } }] }],
    }));
    const falha = receberEvento(database, outro, { signature: assinar(outro), appSecret: segredo });
    assert.equal(falha.status, 500);
    assert.equal(Number(database.prepare(`SELECT COUNT(*) AS n FROM fila_webhook WHERE wamid = 'wamid.outra'`).get().n), 0);
  } finally {
    database.close();
    await rm(diretorio, { recursive: true, force: true });
  }
});
