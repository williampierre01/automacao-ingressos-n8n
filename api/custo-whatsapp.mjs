import { emTransacao } from './lotes.mjs';

const ORDEM = { sent: 1, delivered: 2, read: 3 };
const NOMES = new Set(['sent', 'delivered', 'read', 'failed']);

function iso(agora) {
  return (agora instanceof Date ? agora : new Date(agora)).toISOString();
}

function truncar(valor) {
  return String(valor ?? '').slice(0, 500);
}

function listaStatuses(body) {
  const lista = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const statuses = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
      for (const status of statuses) lista.push(status);
    }
  }
  return lista;
}

function erroDe(status) {
  const erro = Array.isArray(status?.errors) ? status.errors[0] : null;
  if (!erro) return '';
  return truncar(`${erro.code ?? ''} ${erro.title ?? erro.message ?? ''}`.trim());
}

function promover(database, saida, wamid, agora) {
  if (!saida) return null;
  const momento = iso(agora);
  if (saida.status === 'enviando' || saida.status === 'envio_incerto') {
    database.prepare(`
      UPDATE mensagens_saida
      SET status = 'enviada', wamid_saida = ?, enviada_em = COALESCE(enviada_em, ?), atualizado_em = ?
      WHERE id = ?
    `).run(wamid, momento, momento, saida.id);
    return { ...saida, status: 'enviada', wamid_saida: wamid };
  }
  if (!saida.wamid_saida) {
    database.prepare(`
      UPDATE mensagens_saida SET wamid_saida = ?, atualizado_em = ? WHERE id = ?
    `).run(wamid, momento, saida.id);
    return { ...saida, wamid_saida: wamid };
  }
  return saida;
}

function avancarStatusMeta(database, saida, nome, erro, agora) {
  if (!saida) return;
  const momento = iso(agora);
  if (nome === 'failed') {
    database.prepare(`
      UPDATE mensagens_saida
      SET status_meta = 'failed', erro_meta = ?, atualizado_em = ?
      WHERE id = ?
    `).run(erro, momento, saida.id);
    return;
  }
  const atual = saida.status_meta || '';
  if (atual === 'failed') return;
  if (ORDEM[nome] && (!ORDEM[atual] || ORDEM[nome] > ORDEM[atual])) {
    database.prepare(`
      UPDATE mensagens_saida SET status_meta = ?, atualizado_em = ? WHERE id = ?
    `).run(nome, momento, saida.id);
  }
}

function billableDe(pricing) {
  if (!pricing || pricing.billable === undefined || pricing.billable === null) return null;
  return pricing.billable ? 1 : 0;
}

function gravarCusto(database, status, agora) {
  const pricing = status?.pricing && typeof status.pricing === 'object' ? status.pricing : {};
  const erro = Array.isArray(status?.errors) ? status.errors[0] : null;
  database.prepare(`
    INSERT INTO mensagens_custo (
      wamid_saida, status, billable, pricing_model, pricing_type, category,
      timestamp_meta, erro_codigo, erro_titulo, recebido_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wamid_saida, status) DO UPDATE SET
      billable = COALESCE(mensagens_custo.billable, excluded.billable),
      pricing_model = COALESCE(mensagens_custo.pricing_model, excluded.pricing_model),
      pricing_type = COALESCE(mensagens_custo.pricing_type, excluded.pricing_type),
      category = COALESCE(mensagens_custo.category, excluded.category)
  `).run(
    String(status.id),
    String(status.status),
    billableDe(status?.pricing),
    pricing.pricing_model ?? null,
    pricing.type ?? null,
    pricing.category ?? null,
    status.timestamp == null ? null : String(status.timestamp),
    erro?.code == null ? null : String(erro.code),
    erro?.title == null ? null : truncar(erro.title),
    iso(agora),
  );
}

export function aplicarStatuses(database, body, agora = new Date()) {
  let gravados = 0;
  for (const status of listaStatuses(body)) {
    const wamid = String(status?.id ?? '').trim();
    const nome = String(status?.status ?? '').trim();
    if (!wamid || !NOMES.has(nome)) continue;
    const callback = String(status?.biz_opaque_callback_data ?? '').trim();
    let saida = null;
    if (/^\d+$/.test(callback)) {
      saida = database.prepare(`
        SELECT id, status, wamid_saida, status_meta FROM mensagens_saida WHERE id = ?
      `).get(Number(callback));
    }
    if (!saida) {
      saida = database.prepare(`
        SELECT id, status, wamid_saida, status_meta FROM mensagens_saida WHERE wamid_saida = ?
      `).get(wamid);
    }
    const promovida = promover(database, saida, wamid, agora);
    avancarStatusMeta(database, promovida || saida, nome, erroDe(status), agora);
    gravarCusto(database, status, agora);
    gravados += 1;
  }
  return { gravados };
}

export function aplicarStatusesNaTransacao(database, body, agora = new Date()) {
  return emTransacao(database, () => aplicarStatuses(database, body, agora));
}
