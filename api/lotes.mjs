import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

export const MENSAGEM_PAUSADA = 'As vendas estao pausadas neste lote. Quando voltarem, envie COMPRAR.';
export const MENSAGEM_ESGOTADO = 'Os ingressos deste evento estao esgotados.';
export const MARCA_COMPROVANTE_TARDIO = 'recebido após expirar';

export class RegraError extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'RegraError';
    this.codigo = codigo;
  }
}

export function digitosTelefone(valor) {
  return String(valor ?? '').replace(/\D/g, '');
}

export function mensagemLimitePessoa(limite, restante) {
  return `O limite deste evento e de ${limite} ingressos por telefone. Voce ainda pode comprar ${restante}.`;
}

export function mensagemTetoEvento(teto, restante) {
  return `Este evento aceita no maximo ${teto} ingressos, contando reservas e pagamentos em analise. Ainda cabem ${restante}.`;
}

// Total em centavos inteiros, meio centavo para cima:
// floor((valorUnitario * quantidade * (100 - percentual) + 50) / 100).
export function totalCentavos(valorUnitarioCentavos, quantidade, percentual = 0) {
  const numerador = Number(valorUnitarioCentavos) * Number(quantidade) * (100 - Number(percentual));
  return Math.floor((numerador + 50) / 100);
}

export function faixasDesconto(json) {
  if (!json || !String(json).trim()) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((faixa) => (
      Number.isInteger(faixa?.min)
      && faixa.min >= 1
      && Number.isInteger(faixa?.percentual)
      && faixa.percentual >= 0
      && faixa.percentual <= 100
    ));
  } catch {
    return [];
  }
}

export function percentualDesconto(json, quantidade) {
  const aplicaveis = faixasDesconto(json).filter((faixa) => quantidade >= faixa.min);
  if (aplicaveis.length === 0) return 0;
  return Math.max(...aplicaveis.map((faixa) => faixa.percentual));
}

export function descontosParaGravar(texto) {
  const valor = String(texto ?? '').trim();
  if (!valor) return '';
  let parsed;
  try {
    parsed = JSON.parse(valor);
  } catch {
    throw new RegraError('INVALIDO', 'Desconto por quantidade deve ser uma lista JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new RegraError('INVALIDO', 'Desconto por quantidade deve ser uma lista JSON.');
  }
  for (const faixa of parsed) {
    if (!Number.isInteger(faixa?.min) || faixa.min < 1
      || !Number.isInteger(faixa?.percentual) || faixa.percentual < 0 || faixa.percentual > 100) {
      throw new RegraError('INVALIDO', 'Cada desconto precisa de min inteiro e percentual inteiro entre 0 e 100.');
    }
  }
  return JSON.stringify(parsed);
}

export function lotePublico(lote) {
  const disponivel = Math.max(Number(lote.quantidade_total) - Number(lote.quantidade_vendida), 0);
  return {
    ...lote,
    disponivel,
    valor: (Number(lote.valor_centavos) / 100).toFixed(2).replace('.', ','),
  };
}

export function loteCatalogo(lote) {
  const publico = lotePublico(lote);
  const {
    quantidade_total,
    quantidade_reservada,
    quantidade_vendida,
    disponivel,
    ...resto
  } = publico;
  let vagas = 'esgotado';
  if (lote.status === 'futuro' || Number(lote.ativo ?? 1) === 0) vagas = 'fechado';
  else if (lote.status === 'disponivel') vagas = 'aberto';
  return { ...resto, vagas };
}

export function situacaoLotes(lotes) {
  const ordenados = [...lotes].sort((a, b) => (
    Number(a.ordem) - Number(b.ordem) || Number(a.id) - Number(b.id)
  ));
  const disponiveis = ordenados.filter((lote) => lote.status === 'disponivel');
  if (disponiveis.length > 0) {
    const lote = disponiveis[0];
    if (Number(lote.ativo ?? 1) === 0) return { tipo: 'pausado', lote };
    return { tipo: 'vigente', lote };
  }
  if (ordenados.some((lote) => lote.status === 'encerrado')) return { tipo: 'esgotado', lote: null };
  return { tipo: 'sem_lote', lote: null };
}

function iso(agora) {
  return (agora instanceof Date ? agora : new Date(agora)).toISOString();
}

const profundidadeTransacao = new WeakMap();

export function emTransacao(database, trabalho) {
  const nivel = profundidadeTransacao.get(database) || 0;
  const ponto = `nivel_${nivel}`;
  if (nivel === 0) database.exec('BEGIN IMMEDIATE');
  else database.exec(`SAVEPOINT ${ponto}`);
  profundidadeTransacao.set(database, nivel + 1);
  try {
    const resultado = trabalho();
    if (nivel === 0) database.exec('COMMIT');
    else database.exec(`RELEASE SAVEPOINT ${ponto}`);
    return resultado;
  } catch (error) {
    if (nivel === 0) {
      try { database.exec('ROLLBACK'); } catch { /* a transacao ja foi desfeita */ }
    } else {
      try { database.exec(`ROLLBACK TO SAVEPOINT ${ponto}`); } catch { /* a transacao ja foi desfeita */ }
      try { database.exec(`RELEASE SAVEPOINT ${ponto}`); } catch { /* o savepoint ja foi liberado */ }
    }
    throw error;
  } finally {
    profundidadeTransacao.set(database, nivel);
  }
}

export function listarLotes(database, eventoId) {
  return database.prepare(`
    SELECT * FROM lotes WHERE evento_id = ? ORDER BY ordem ASC, id ASC
  `).all(eventoId);
}

export function analisarEvento(database, eventoId) {
  return situacaoLotes(listarLotes(database, eventoId));
}

function eventoPorId(database, eventoId) {
  return database.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId);
}

function usoSql(database, eventoId, agoraIso, telefone) {
  const filtros = telefone
    ? 'evento_id = ? AND comprador_telefone = ?'
    : 'evento_id = ?';
  const params = telefone ? [eventoId, telefone, agoraIso] : [eventoId, agoraIso];
  return Number(database.prepare(`
    SELECT COALESCE(SUM(quantidade), 0) AS total
    FROM pedidos
    WHERE ${filtros}
      AND (
        status_pagamento = 'aprovado'
        OR status_pagamento = 'em_analise'
        OR (status = 'aguardando_pagamento' AND reserva_expira_em > ?)
      )
  `).get(...params).total);
}

export function usoTelefone(database, eventoId, telefone, agora = new Date()) {
  return usoSql(database, eventoId, iso(agora), digitosTelefone(telefone));
}

export function usoEvento(database, eventoId, agora = new Date()) {
  return usoSql(database, eventoId, iso(agora));
}

function exigirLimites(database, evento, telefone, quantidade, agoraIso) {
  const limite = evento.max_ingressos_por_pessoa == null ? null : Number(evento.max_ingressos_por_pessoa);
  if (limite != null) {
    const usado = usoSql(database, evento.id, agoraIso, telefone);
    if (usado + quantidade > limite) {
      throw new RegraError('LIMITE', mensagemLimitePessoa(limite, Math.max(limite - usado, 0)));
    }
  }
  const teto = evento.capacidade_maxima_evento == null ? null : Number(evento.capacidade_maxima_evento);
  if (teto != null) {
    const usado = usoSql(database, evento.id, agoraIso);
    if (usado + quantidade > teto) {
      throw new RegraError('TETO', mensagemTetoEvento(teto, Math.max(teto - usado, 0)));
    }
  }
}

export function reservar(database, {
  eventoId,
  telefone,
  nomeComprador,
  origem,
  quantidade,
  participantes,
  loteIdEsperado,
  valorUnitarioEsperado,
  totalEsperado,
  agora = new Date(),
}) {
  const telefoneDigitos = digitosTelefone(telefone);
  if (!telefoneDigitos) throw new RegraError('INVALIDO', 'Informe o telefone com numeros.');
  return emTransacao(database, () => {
    const evento = eventoPorId(database, eventoId);
    const situacao = analisarEvento(database, eventoId);
    if (situacao.tipo === 'pausado') throw new RegraError('PAUSADO', MENSAGEM_PAUSADA);
    if (situacao.tipo === 'esgotado') throw new RegraError('ESGOTADO', MENSAGEM_ESGOTADO);
    if (situacao.tipo !== 'vigente') {
      throw new RegraError('SEM_LOTE', 'Este evento nao possui lote disponivel no momento.');
    }
    const lote = situacao.lote;
    const percentual = percentualDesconto(evento.descontos_quantidade_json, quantidade);
    const total = totalCentavos(lote.valor_centavos, quantidade, percentual);
    if (Number(lote.id) !== Number(loteIdEsperado)
      || Number(lote.valor_centavos) !== Number(valorUnitarioEsperado)
      || total !== Number(totalEsperado)) {
      throw new RegraError('PRECO_MUDOU', 'O valor mudou.');
    }
    const momento = iso(agora);
    exigirLimites(database, evento, telefoneDigitos, quantidade, momento);
    const protocolo = `ING-${Date.now().toString(36).toUpperCase()}-${randomUUID().slice(0, 4).toUpperCase()}`;
    const expiraEm = new Date(agora.getTime() + Number(evento.prazo_reserva_minutos) * 60_000).toISOString();
    const pedido = database.prepare(`
      INSERT INTO pedidos (
        protocolo, evento_id, lote_id, data_contato, origem, comprador_nome,
        comprador_telefone, quantidade, valor_unitario_centavos, valor_total_centavos,
        reserva_expira_em, status, status_pagamento, criado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_pagamento', 'pendente', ?, ?)
    `).run(
      protocolo, evento.id, lote.id, momento, origem || '', nomeComprador,
      telefoneDigitos, quantidade, lote.valor_centavos, total,
      expiraEm, momento, momento,
    );
    const pedidoId = Number(pedido.lastInsertRowid);
    const inserirParticipante = database.prepare(`
      INSERT INTO participantes (
        pedido_id, evento_id, nome_completo, tipo_documento, numero_documento,
        status_ingresso, criado_em, atualizado_em
      ) VALUES (?, ?, ?, NULL, NULL, 'pendente', ?, ?)
    `);
    for (const participante of participantes) {
      inserirParticipante.run(pedidoId, evento.id, participante.nome, momento, momento);
    }
    return {
      pedidoId,
      protocolo,
      expiraEm,
      total,
      valorUnitario: Number(lote.valor_centavos),
      loteId: Number(lote.id),
      loteNome: lote.nome,
    };
  });
}

function virarLoteVigente(database, eventoId, pedidoId, agoraIso) {
  const situacao = analisarEvento(database, eventoId);
  if (situacao.tipo !== 'vigente' && situacao.tipo !== 'pausado') return null;
  const vigente = situacao.lote;
  if (Number(vigente.quantidade_vendida) < Number(vigente.quantidade_total)) return null;
  const encerrou = database.prepare(`
    UPDATE lotes
    SET status = 'encerrado', encerrado_em = ?, atualizado_em = ?
    WHERE id = ? AND status IN ('disponivel', 'futuro')
  `).run(agoraIso, agoraIso, vigente.id);
  if (Number(encerrou.changes) !== 1) return null;
  const proximo = listarLotes(database, eventoId).find((lote) => lote.status === 'futuro');
  if (proximo) {
    database.prepare(`
      UPDATE lotes SET status = 'disponivel', atualizado_em = ? WHERE id = ?
    `).run(agoraIso, proximo.id);
  }
  const tipo = proximo ? 'virada' : 'esgotado';
  const gravada = database.prepare(`
    INSERT INTO viradas_lote (
      evento_id, lote_anterior_id, lote_novo_id, pedido_id, tipo, criado_em
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(eventoId, vigente.id, proximo?.id ?? null, pedidoId, tipo, agoraIso);
  return {
    id: Number(gravada.lastInsertRowid),
    tipo,
    eventoId,
    loteAnterior: { id: Number(vigente.id), nome: vigente.nome },
    loteNovo: proximo ? { id: Number(proximo.id), nome: proximo.nome } : null,
    pedidoId,
    em: agoraIso,
  };
}

export function payloadVirada(virada, eventoCodigo) {
  return {
    tipo: virada.tipo,
    evento_codigo: eventoCodigo,
    lote_anterior_id: virada.loteAnterior.id,
    lote_anterior: virada.loteAnterior.nome,
    lote_novo_id: virada.loteNovo?.id ?? null,
    lote_novo: virada.loteNovo?.nome ?? null,
    pedido_id: virada.pedidoId,
    em: virada.em,
  };
}

async function avisarVirada(database, virada, webhookUrl, fetchImpl) {
  if (!virada || !webhookUrl) return;
  const evento = eventoPorId(database, virada.eventoId);
  const payload = payloadVirada(virada, evento.codigo);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const resposta = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    database.prepare('UPDATE viradas_lote SET enviado_em = ?, erro = NULL WHERE id = ?')
      .run(new Date().toISOString(), virada.id);
  } catch (error) {
    database.prepare('UPDATE viradas_lote SET erro = ? WHERE id = ?')
      .run(String(error.message || error).slice(0, 500), virada.id);
  } finally {
    clearTimeout(timer);
  }
}

export async function aprovarPagamento(database, {
  pedidoId,
  responsavel,
  observacao = '',
  agora = new Date(),
  webhookUrl = '',
  fetchImpl = globalThis.fetch,
}) {
  const momento = iso(agora);
  const virada = emTransacao(database, () => {
    const atualizado = database.prepare(`
      UPDATE pedidos
      SET status = 'concluido', status_pagamento = 'aprovado',
        aprovado_em = ?, aprovado_por = ?, observacoes = ?, atualizado_em = ?
      WHERE id = ? AND status_pagamento = 'em_analise'
    `).run(momento, responsavel || 'Administrador local', observacao, momento, pedidoId);
    if (Number(atualizado.changes) !== 1) {
      throw new RegraError('CONFLITO', 'O pedido nao esta aguardando analise.');
    }
    const pedido = database.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
    database.prepare(`
      UPDATE lotes
      SET quantidade_vendida = quantidade_vendida + ?, atualizado_em = ?
      WHERE id = ?
    `).run(pedido.quantidade, momento, pedido.lote_id);
    database.prepare(`
      UPDATE participantes SET status_ingresso = 'valido', atualizado_em = ? WHERE pedido_id = ?
    `).run(momento, pedidoId);
    database.prepare(`
      UPDATE conversas SET estado = 'concluido', atualizado_em = ? WHERE pedido_id = ?
    `).run(momento, pedidoId);
    return virarLoteVigente(database, pedido.evento_id, pedidoId, momento);
  });
  await avisarVirada(database, virada, webhookUrl, fetchImpl);
  return { atualizado: true, pedidoId, status_pagamento: 'aprovado', virada };
}

export function recusarPagamento(database, {
  pedidoId,
  responsavel,
  observacao = '',
  agora = new Date(),
}) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    const atualizado = database.prepare(`
      UPDATE pedidos
      SET status = 'pagamento_recusado', status_pagamento = 'recusado',
        aprovado_por = ?, observacoes = ?, atualizado_em = ?
      WHERE id = ? AND status_pagamento = 'em_analise'
    `).run(responsavel || 'Administrador local', observacao, momento, pedidoId);
    if (Number(atualizado.changes) !== 1) {
      throw new RegraError('CONFLITO', 'O pedido nao esta aguardando analise.');
    }
    database.prepare(`
      UPDATE participantes SET status_ingresso = 'cancelado', atualizado_em = ? WHERE pedido_id = ?
    `).run(momento, pedidoId);
    database.prepare(`
      UPDATE conversas SET estado = 'pagamento_recusado', atualizado_em = ? WHERE pedido_id = ?
    `).run(momento, pedidoId);
    return { atualizado: true, pedidoId, status_pagamento: 'recusado' };
  });
}

export function expirarReservas(database, agora = new Date()) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    const resultado = database.prepare(`
      UPDATE pedidos
      SET status = 'expirado', atualizado_em = ?
      WHERE status = 'aguardando_pagamento'
        AND reserva_expira_em IS NOT NULL
        AND reserva_expira_em <= ?
    `).run(momento, momento);
    database.prepare(`
      UPDATE conversas
      SET estado = 'expirado', atualizado_em = ?
      WHERE estado = 'aguardando_pagamento'
        AND pedido_id IN (SELECT id FROM pedidos WHERE status = 'expirado')
    `).run(momento);
    return { expirados: Number(resultado.changes) };
  });
}

export function cancelarPedidoPendente(database, pedidoId, agora = new Date()) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    const resultado = database.prepare(`
      UPDATE pedidos
      SET status = 'cancelado', atualizado_em = ?
      WHERE id = ? AND status = 'aguardando_pagamento'
    `).run(momento, pedidoId);
    if (Number(resultado.changes) === 1) {
      database.prepare(`
        UPDATE participantes SET status_ingresso = 'cancelado', atualizado_em = ? WHERE pedido_id = ?
      `).run(momento, pedidoId);
    }
    return { cancelados: Number(resultado.changes) };
  });
}

export function registrarComprovante(database, {
  pedidoId,
  telefone,
  eventoCodigo,
  comprovanteId,
  nomeOriginal,
  tipoMime,
  caminho,
  tamanhoBytes,
  sha256 = null,
  agora = new Date(),
}) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    const evento = database.prepare('SELECT * FROM eventos WHERE codigo = ?').get(eventoCodigo);
    const pedido = database.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
    const telefoneDigitos = digitosTelefone(telefone);
    if (!evento || !pedido || Number(pedido.evento_id) !== Number(evento.id)
      || digitosTelefone(pedido.comprador_telefone) !== telefoneDigitos) {
      throw new RegraError('PROIBIDO', 'O comprovante nao pertence a esta conversa.');
    }
    const noPrazo = database.prepare(`
      UPDATE pedidos
      SET comprovante_id = ?, status = 'pagamento_em_analise', status_pagamento = 'em_analise',
        recebido_apos_expirar = 0, atualizado_em = ?
      WHERE id = ? AND status = 'aguardando_pagamento' AND status_pagamento = 'pendente'
    `).run(comprovanteId, momento, pedidoId);
    let tardio = false;
    if (Number(noPrazo.changes) !== 1) {
      const observacao = pedido.observacoes?.includes(MARCA_COMPROVANTE_TARDIO)
        ? pedido.observacoes
        : [pedido.observacoes, MARCA_COMPROVANTE_TARDIO].filter(Boolean).join('\n');
      const depois = database.prepare(`
        UPDATE pedidos
        SET comprovante_id = ?, status = 'pagamento_em_analise', status_pagamento = 'em_analise',
          recebido_apos_expirar = 1, observacoes = ?, atualizado_em = ?
        WHERE id = ? AND status = 'expirado'
      `).run(comprovanteId, observacao, momento, pedidoId);
      if (Number(depois.changes) !== 1) {
        throw new RegraError('CONFLITO', 'Este pedido nao esta aguardando comprovante.');
      }
      tardio = true;
    }
    database.prepare(`
      INSERT INTO comprovantes (id, pedido_id, nome_original, tipo_mime, caminho, tamanho_bytes, sha256, recebido_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(comprovanteId, pedidoId, nomeOriginal, tipoMime, caminho, tamanhoBytes, sha256 ?? null, momento);
    database.prepare(`
      UPDATE conversas SET estado = 'pagamento_em_analise', atualizado_em = ? WHERE pedido_id = ?
    `).run(momento, pedidoId);
    const gravado = database.prepare('SELECT * FROM pedidos WHERE id = ?').get(pedidoId);
    return {
      comprovanteId,
      tardio,
      valorUnitario: Number(gravado.valor_unitario_centavos),
      valorTotal: Number(gravado.valor_total_centavos),
    };
  });
}

export function listarViradasPendentes(database) {
  return database.prepare(`
    SELECT
      v.id, v.evento_id, v.pedido_id, v.tipo, v.criado_em, v.enviado_em, v.erro, v.anunciada_em,
      e.codigo AS evento_codigo, e.nome AS evento_nome,
      la.nome AS lote_anterior, ln.nome AS lote_novo
    FROM viradas_lote v
    JOIN eventos e ON e.id = v.evento_id
    JOIN lotes la ON la.id = v.lote_anterior_id
    LEFT JOIN lotes ln ON ln.id = v.lote_novo_id
    WHERE v.anunciada_em IS NULL
    ORDER BY v.id ASC
  `).all();
}

export function marcarAnunciada(database, viradaId, agora = new Date()) {
  const momento = iso(agora);
  const resultado = database.prepare(`
    UPDATE viradas_lote SET anunciada_em = ? WHERE id = ? AND anunciada_em IS NULL
  `).run(momento, viradaId);
  if (Number(resultado.changes) === 1) return { id: Number(viradaId), anunciada_em: momento };
  const existente = database.prepare('SELECT id, anunciada_em FROM viradas_lote WHERE id = ?').get(viradaId);
  if (!existente) throw new RegraError('NAO_ENCONTRADA', 'Virada nao encontrada.');
  return { id: Number(existente.id), anunciada_em: existente.anunciada_em };
}

function colunaExiste(database, tabela, coluna) {
  return database.prepare(`PRAGMA table_info(${tabela})`).all().some((item) => item.name === coluna);
}

function adicionarColuna(database, tabela, coluna, definicao) {
  if (!colunaExiste(database, tabela, coluna)) {
    database.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
  }
}

function participantesExigeDocumento(database) {
  const tabela = database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'participantes'
  `).get();
  return Boolean(tabela?.sql && /tipo_documento TEXT NOT NULL/i.test(tabela.sql));
}

function backupBanco(database, databasePath, agora) {
  database.exec('PRAGMA wal_checkpoint(FULL)');
  const carimbo = iso(agora).replace(/[:.]/g, '-');
  const destino = join(dirname(databasePath), `backup-pre-migracao-${carimbo}`);
  const destinoSql = destino.replaceAll('\\', '/').replaceAll("'", "''");
  database.exec(`VACUUM INTO '${destinoSql}'`);
  return destino;
}

const COLUNAS_PARTICIPANTE = [
  'id', 'pedido_id', 'evento_id', 'nome_completo', 'tipo_documento', 'numero_documento',
  'status_ingresso', 'codigo_ingresso', 'entrada_em', 'criado_em', 'atualizado_em',
];

function recriarParticipantes(database, { falharCopia = false } = {}) {
  const reais = database.prepare('PRAGMA table_info(participantes)').all().map((coluna) => coluna.name);
  const extras = reais.filter((nome) => !COLUNAS_PARTICIPANTE.includes(nome));
  if (extras.length > 0) {
    throw new Error(`Migracao abortada: a tabela participantes tem coluna extra: ${extras.join(', ')}.`);
  }
  const lista = COLUNAS_PARTICIPANTE.join(', ');
  const antes = Number(database.prepare('SELECT COUNT(*) AS n FROM participantes').get().n);
  database.exec(`
    CREATE TABLE participantes_nova (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      evento_id INTEGER NOT NULL REFERENCES eventos(id),
      nome_completo TEXT NOT NULL,
      tipo_documento TEXT CHECK (tipo_documento IS NULL OR tipo_documento IN ('CPF', 'RG')),
      numero_documento TEXT,
      status_ingresso TEXT NOT NULL DEFAULT 'pendente' CHECK (
        status_ingresso IN ('pendente', 'valido', 'cancelado', 'utilizado')
      ),
      codigo_ingresso TEXT UNIQUE,
      entrada_em TEXT,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    )
  `);
  if (falharCopia) {
    database.exec(`
      INSERT INTO participantes_nova (${lista})
      SELECT ${lista} FROM participantes
      WHERE id <> (SELECT MIN(id) FROM participantes)
    `);
  } else {
    database.exec(`INSERT INTO participantes_nova (${lista}) SELECT ${lista} FROM participantes`);
  }
  const depois = Number(database.prepare('SELECT COUNT(*) AS n FROM participantes_nova').get().n);
  if (antes !== depois) {
    throw new Error(`Migracao abortada: a tabela participantes tinha ${antes} linhas e a copia ficou com ${depois}.`);
  }
  database.exec('DROP TABLE participantes');
  database.exec('ALTER TABLE participantes_nova RENAME TO participantes');
  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_participantes_documento
    ON participantes(evento_id, tipo_documento, numero_documento)
  `);
}

function normalizarTelefones(database) {
  const pedidos = database.prepare('SELECT id, comprador_telefone FROM pedidos').all();
  const atualizarPedido = database.prepare('UPDATE pedidos SET comprador_telefone = ? WHERE id = ?');
  for (const pedido of pedidos) {
    const digitos = digitosTelefone(pedido.comprador_telefone);
    if (digitos !== pedido.comprador_telefone) atualizarPedido.run(digitos, pedido.id);
  }
  const conversas = database.prepare('SELECT id, evento_id, telefone FROM conversas').all();
  const vistos = new Set();
  for (const conversa of conversas) {
    const chave = `${conversa.evento_id}:${digitosTelefone(conversa.telefone)}`;
    if (vistos.has(chave)) {
      throw new Error(`Migracao abortada: duas conversas do evento ${conversa.evento_id} ficam com o mesmo telefone.`);
    }
    vistos.add(chave);
  }
  const atualizarConversa = database.prepare('UPDATE conversas SET telefone = ? WHERE id = ?');
  for (const conversa of conversas) {
    const digitos = digitosTelefone(conversa.telefone);
    if (digitos !== conversa.telefone) atualizarConversa.run(digitos, conversa.id);
  }
}

function adicionarColunas(database) {
  adicionarColuna(database, 'eventos', 'capacidade_maxima_evento', 'INTEGER CHECK (capacidade_maxima_evento IS NULL OR capacidade_maxima_evento >= 0)');
  adicionarColuna(database, 'eventos', 'max_ingressos_por_pessoa', 'INTEGER DEFAULT 10 CHECK (max_ingressos_por_pessoa IS NULL OR max_ingressos_por_pessoa > 0)');
  adicionarColuna(database, 'eventos', 'descontos_quantidade_json', "TEXT NOT NULL DEFAULT ''");
  adicionarColuna(database, 'lotes', 'ativo', 'INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1))');
  adicionarColuna(database, 'lotes', 'ordem', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColuna(database, 'lotes', 'encerrado_em', 'TEXT');
  adicionarColuna(database, 'pedidos', 'recebido_apos_expirar', 'INTEGER NOT NULL DEFAULT 0 CHECK (recebido_apos_expirar IN (0, 1))');
  database.exec('UPDATE lotes SET ordem = id WHERE ordem IS NULL OR ordem = 0');
  database.exec(`
    CREATE TABLE IF NOT EXISTS viradas_lote (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento_id INTEGER NOT NULL REFERENCES eventos(id),
      lote_anterior_id INTEGER NOT NULL REFERENCES lotes(id),
      lote_novo_id INTEGER REFERENCES lotes(id),
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('virada', 'esgotado')),
      criado_em TEXT NOT NULL,
      enviado_em TEXT,
      erro TEXT,
      anunciada_em TEXT
    )
  `);
  database.exec('CREATE INDEX IF NOT EXISTS idx_viradas_pendentes ON viradas_lote(anunciada_em, id)');
}

function versaoBanco(database) {
  return Number(database.prepare('PRAGMA user_version').get().user_version);
}

function criarTabelasEntrada(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS mensagens_entrada (
      wamid TEXT PRIMARY KEY,
      telefone TEXT NOT NULL,
      nome TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL,
      texto TEXT NOT NULL DEFAULT '',
      recebida_em TEXT NOT NULL,
      origem TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS mensagens_saida (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wamid TEXT NOT NULL REFERENCES mensagens_entrada(wamid),
      texto TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pendente_envio',
      criada_em TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fila_webhook (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wamid TEXT NOT NULL UNIQUE,
      telefone TEXT NOT NULL,
      nome TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL,
      texto TEXT NOT NULL DEFAULT '',
      timestamp_mensagem TEXT NOT NULL,
      origem TEXT NOT NULL,
      evento_codigo TEXT NOT NULL DEFAULT '',
      corpo TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK (status IN ('pendente', 'processando', 'entregue', 'falhou')),
      tentativas INTEGER NOT NULL DEFAULT 0,
      proxima_tentativa_em TEXT NOT NULL,
      ultimo_erro TEXT NOT NULL DEFAULT '',
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_mensagens_saida_wamid ON mensagens_saida(wamid);
    CREATE INDEX IF NOT EXISTS idx_fila_telefone_status ON fila_webhook(telefone, status, id);
  `);
}

function contarTabelasMensagem(database) {
  const contar = (tabela) => Number(database.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n);
  return {
    entrada: contar('mensagens_entrada'),
    saida: contar('mensagens_saida'),
    fila: contar('fila_webhook'),
  };
}

function adicionarColunasEnvio(database) {
  adicionarColuna(database, 'mensagens_saida', 'wamid_saida', 'TEXT');
  adicionarColuna(database, 'mensagens_saida', 'tentativas', 'INTEGER NOT NULL DEFAULT 0');
  adicionarColuna(database, 'mensagens_saida', 'proxima_tentativa_em', 'TEXT');
  adicionarColuna(database, 'mensagens_saida', 'ultimo_erro', "TEXT NOT NULL DEFAULT ''");
  adicionarColuna(database, 'mensagens_saida', 'enviada_em', 'TEXT');
  adicionarColuna(database, 'mensagens_saida', 'atualizado_em', 'TEXT');
  adicionarColuna(database, 'mensagens_saida', 'status_meta', 'TEXT');
  adicionarColuna(database, 'mensagens_saida', 'erro_meta', 'TEXT');
  adicionarColuna(database, 'comprovantes', 'sha256', 'TEXT');
  adicionarColuna(database, 'comprovantes', 'apagado_em', 'TEXT');
  database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mensagens_saida_wamid_saida
      ON mensagens_saida(wamid_saida) WHERE wamid_saida IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mensagens_saida_status_proxima
      ON mensagens_saida(status, proxima_tentativa_em);
    CREATE TABLE IF NOT EXISTS mensagens_custo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wamid_saida TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
      billable INTEGER,
      pricing_model TEXT,
      pricing_type TEXT,
      category TEXT,
      timestamp_meta TEXT,
      erro_codigo TEXT,
      erro_titulo TEXT,
      recebido_em TEXT NOT NULL,
      UNIQUE (wamid_saida, status)
    );
  `);
}

export function migrar(database, { databasePath, agora = new Date(), falharCopia = false, falharContagem = false } = {}) {
  database.exec('PRAGMA busy_timeout = 5000');
  const versao = versaoBanco(database);
  if (versao >= 3) return { migrado: false, backup: null };
  let backup = null;
  let migrado = false;
  if (versao < 1) {
    if (!databasePath) {
      throw new Error('Migracao abortada: caminho do banco ausente para o backup.');
    }
    backup = backupBanco(database, databasePath, agora);
    const recriar = participantesExigeDocumento(database);

    if (recriar) database.exec('PRAGMA foreign_keys = OFF');
    try {
      emTransacao(database, () => {
        adicionarColunas(database);
        if (recriar) recriarParticipantes(database, { falharCopia });
        normalizarTelefones(database);
        database.exec('PRAGMA user_version = 1');
      });
    } catch (error) {
      const texto = String(error.message || error);
      const mensagem = texto.startsWith('Migracao abortada') ? texto : `Migracao abortada: ${texto}`;
      throw new Error(backup ? `${mensagem} Backup em ${backup}.` : mensagem);
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
    migrado = true;
  }
  if (versaoBanco(database) < 2) {
    emTransacao(database, () => {
      criarTabelasEntrada(database);
      database.exec('PRAGMA user_version = 2');
    });
    migrado = true;
  }
  if (versaoBanco(database) < 3) {
    if (!databasePath) {
      throw new Error('Migracao abortada: caminho do banco ausente para o backup.');
    }
    if (!backup) backup = backupBanco(database, databasePath, agora);
    const antes = contarTabelasMensagem(database);
    try {
      emTransacao(database, () => {
        adicionarColunasEnvio(database);
        if (falharContagem) {
          database.prepare('DELETE FROM mensagens_saida WHERE id = (SELECT MIN(id) FROM mensagens_saida)').run();
        }
        const depois = contarTabelasMensagem(database);
        if (antes.entrada !== depois.entrada || antes.saida !== depois.saida || antes.fila !== depois.fila) {
          throw new Error(`Migracao abortada: a contagem divergiu. mensagens_entrada ${antes.entrada}->${depois.entrada}, mensagens_saida ${antes.saida}->${depois.saida}, fila_webhook ${antes.fila}->${depois.fila}.`);
        }
        database.exec('PRAGMA user_version = 3');
      });
    } catch (error) {
      const texto = String(error.message || error);
      const mensagem = texto.startsWith('Migracao abortada') ? texto : `Migracao abortada: ${texto}`;
      throw new Error(backup ? `${mensagem} Backup em ${backup}.` : mensagem);
    }
    migrado = true;
  }
  return { migrado, backup };
}

export function garantirEventoDemonstracao(database, agora = new Date()) {
  const momento = iso(agora);
  const totalEventos = Number(database.prepare('SELECT COUNT(*) AS n FROM eventos').get().n);
  if (totalEventos === 0) {
    const evento = database.prepare(`
      INSERT INTO eventos (
        codigo, nome, descricao, organizador, data_evento, horario, local, endereco,
        inicio_vendas, fim_vendas, capacidade_total, capacidade_maxima_evento,
        limite_por_comprador, max_ingressos_por_pessoa, prazo_reserva_minutos,
        descontos_quantidade_json, mensagem_boas_vindas, orientacoes_entrada,
        texto_privacidade, documento_obrigatorio, status, criado_em, atualizado_em
      ) VALUES (
        'evento-demonstracao', 'Evento de demonstracao',
        'Evento criado para validar a automacao generica.',
        'Organizacao de demonstracao', '2026-12-31', '22:00', 'Local a definir', '',
        '2026-08-01T00:00:00-03:00', '2026-12-30T23:59:59-03:00', 300, NULL,
        10, 10, 60, '',
        'Ola! Vou ajudar voce a comprar seu ingresso.',
        'Apresente seu documento na entrada.',
        'Seus dados serao usados somente para a venda e validacao da entrada.',
        0, 'vendas_abertas', ?, ?
      )
    `).run(momento, momento);
    const eventoId = Number(evento.lastInsertRowid);
    const inserirLote = database.prepare(`
      INSERT INTO lotes (
        evento_id, nome, valor_centavos, inicio, fim, quantidade_total,
        ativo, ordem, status, criado_em, atualizado_em
      ) VALUES (?, ?, ?, NULL, NULL, ?, 1, ?, ?, ?, ?)
    `);
    inserirLote.run(eventoId, 'Primeiro lote', 3000, 20, 1, 'disponivel', momento, momento);
    inserirLote.run(eventoId, 'Segundo lote', 4000, 30, 2, 'futuro', momento, momento);
    inserirLote.run(eventoId, 'Terceiro lote', 5000, 50, 3, 'futuro', momento, momento);
  }

  const demonstracao = database.prepare(`SELECT * FROM eventos WHERE codigo = 'evento-demonstracao'`).get();
  if (!demonstracao) return;
  if (Number(demonstracao.prazo_reserva_minutos) !== 60) {
    database.prepare(`
      UPDATE eventos SET prazo_reserva_minutos = 60, atualizado_em = ? WHERE id = ?
    `).run(momento, demonstracao.id);
  }
  const terceiro = database.prepare(`
    SELECT id FROM lotes WHERE evento_id = ? AND nome = 'Terceiro lote'
  `).get(demonstracao.id);
  if (!terceiro) {
    const ordem = Number(database.prepare(`
      SELECT COALESCE(MAX(ordem), 0) AS ordem FROM lotes WHERE evento_id = ?
    `).get(demonstracao.id).ordem) + 1;
    database.prepare(`
      INSERT INTO lotes (
        evento_id, nome, valor_centavos, inicio, fim, quantidade_total,
        ativo, ordem, status, criado_em, atualizado_em
      ) VALUES (?, 'Terceiro lote', 5000, NULL, NULL, 50, 1, ?, 'futuro', ?, ?)
    `).run(demonstracao.id, ordem, momento, momento);
  }
  database.prepare(`
    UPDATE eventos
    SET pix_chave = 'PIX-DEMONSTRACAO-NAO-PAGAR', pix_tipo = 'demonstracao',
      pix_favorecido = 'Favorecido de demonstracao', atualizado_em = ?
    WHERE codigo = 'evento-demonstracao' AND pix_chave = ''
  `).run(momento);
}

if (workerData?.comando) {
  const banco = new DatabaseSync(workerData.databasePath);
  banco.exec('PRAGMA busy_timeout = 5000');
  banco.exec('PRAGMA foreign_keys = ON');
  try {
    let resultado;
    if (workerData.comando === 'aprovar') {
      resultado = await aprovarPagamento(banco, workerData);
    } else if (workerData.comando === 'expirar') {
      resultado = expirarReservas(banco, new Date(workerData.agora));
    } else if (workerData.comando === 'comprovante') {
      resultado = registrarComprovante(banco, { ...workerData, agora: new Date(workerData.agora) });
    } else {
      throw new Error(`Comando desconhecido: ${workerData.comando}`);
    }
    banco.close();
    parentPort.postMessage({ ok: true, resultado });
  } catch (error) {
    try { banco.close(); } catch { /* ja fechado */ }
    parentPort.postMessage({ ok: false, erro: error.message, codigo: error.codigo || '' });
  }
}
