import { unlinkSync } from 'node:fs';
import { caminhoDentroDaPasta } from './graph-whatsapp.mjs';

const DIA_MS = 24 * 60 * 60 * 1000;

function iso(agora) {
  return (agora instanceof Date ? agora : new Date(agora)).toISOString();
}

function inteiro(valor, padrao) {
  if (valor == null || String(valor).trim() === '') return padrao;
  const numero = Number(valor);
  return Number.isInteger(numero) && numero >= 0 ? numero : padrao;
}

export function diasRetencao(env = process.env) {
  return {
    aprovado: inteiro(env.COMPROVANTE_RETENCAO_DIAS_APROVADO, 30),
    recusado: inteiro(env.COMPROVANTE_RETENCAO_DIAS_RECUSADO, 7),
  };
}

function diaUtc(texto) {
  const match = String(texto ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function prazoCumprido(inicio, dias, agora) {
  const base = diaUtc(inicio);
  if (base == null) return false;
  return agora.getTime() >= base + dias * DIA_MS;
}

function venceu(linha, dias, agora) {
  if (linha.status_pagamento === 'aprovado' || linha.status === 'concluido') {
    return prazoCumprido(linha.data_evento, dias.aprovado, agora);
  }
  if (
    linha.status === 'pagamento_recusado'
    || linha.status_pagamento === 'recusado'
    || linha.status === 'expirado'
    || linha.status === 'cancelado'
  ) {
    return prazoCumprido(linha.atualizado_em, dias.recusado, agora);
  }
  return false;
}

export function apagarComprovantesVencidos(database, {
  pasta,
  agora = new Date(),
  env = process.env,
} = {}) {
  const dias = diasRetencao(env);
  const linhas = database.prepare(`
    SELECT
      c.id, c.caminho, c.tipo_mime, c.tamanho_bytes, c.sha256,
      p.status, p.status_pagamento, p.atualizado_em, e.data_evento
    FROM comprovantes c
    JOIN pedidos p ON p.id = c.pedido_id
    JOIN eventos e ON e.id = p.evento_id
    WHERE c.apagado_em IS NULL
  `).all();
  let apagados = 0;
  for (const linha of linhas) {
    if (!venceu(linha, dias, agora)) continue;
    const alvo = caminhoDentroDaPasta(pasta, linha.caminho);
    if (!alvo) continue;
    try {
      unlinkSync(alvo);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const mudou = database.prepare(`
      UPDATE comprovantes SET apagado_em = ? WHERE id = ? AND apagado_em IS NULL
    `).run(iso(agora), linha.id);
    apagados += Number(mudou.changes);
  }
  return { apagados };
}

export function executarRetencao(database, opcoes, aoFalhar = (error) => {
  console.error(`Falha na retencao de comprovantes: ${error.message}`);
}) {
  try {
    return apagarComprovantesVencidos(database, opcoes);
  } catch (error) {
    aoFalhar(error);
    return { apagados: 0, falhou: true };
  }
}

export function iniciarRetencao(database, opcoes = {}) {
  const timer = setInterval(() => executarRetencao(database, opcoes), opcoes.intervaloMs ?? 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
