import {
  MENSAGEM_ESGOTADO,
  MENSAGEM_PAUSADA,
  RegraError,
  analisarEvento,
  cancelarPedidoPendente,
  digitosTelefone,
  mensagemLimitePessoa,
  mensagemTetoEvento,
  percentualDesconto,
  reservar,
  totalCentavos,
  usoEvento,
  usoTelefone,
} from './lotes.mjs';

function reais(centavos) {
  return (Number(centavos) / 100).toFixed(2).replace('.', ',');
}

function lerDados(conversa) {
  try {
    return JSON.parse(conversa?.dados_json || '{}');
  } catch {
    return {};
  }
}

function salvarConversa(database, conversa) {
  const momento = new Date().toISOString();
  database.prepare(`
    INSERT INTO conversas (
      evento_id, telefone, nome_comprador, estado, quantidade, lote_id,
      dados_json, pedido_id, origem, criado_em, atualizado_em
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(evento_id, telefone) DO UPDATE SET
      nome_comprador = excluded.nome_comprador,
      estado = excluded.estado,
      quantidade = excluded.quantidade,
      lote_id = excluded.lote_id,
      dados_json = excluded.dados_json,
      pedido_id = excluded.pedido_id,
      origem = excluded.origem,
      atualizado_em = excluded.atualizado_em
  `).run(
    conversa.evento_id,
    conversa.telefone,
    conversa.nome_comprador,
    conversa.estado,
    conversa.quantidade ?? null,
    conversa.lote_id ?? null,
    JSON.stringify(conversa.dados ?? {}),
    conversa.pedido_id ?? null,
    conversa.origem || '',
    conversa.criado_em || momento,
    momento,
  );
}

function carregarConversa(database, eventoId, telefone) {
  const linha = database.prepare('SELECT * FROM conversas WHERE evento_id = ? AND telefone = ?').get(eventoId, telefone);
  if (!linha) return null;
  return { ...linha, dados: lerDados(linha) };
}

function responder(conversa, resposta, extra = {}) {
  return { estado: conversa.estado, resposta, ...extra };
}

function mensagemPrecoNovo(lote, total) {
  return `O valor mudou. O lote vigente agora e ${lote.nome}, a R$ ${reais(lote.valor_centavos)} cada. Total: R$ ${reais(total)}. Responda CONFIRMAR para reservar ou CORRIGIR para recomecar.`;
}

function mensagemPix(evento, reserva) {
  const aviso = evento.pix_tipo === 'demonstracao' ? 'AMBIENTE DE TESTE — NAO REALIZE PAGAMENTO.\n' : '';
  return `${aviso}Reserva ${reserva.protocolo} criada.\nTotal: R$ ${reais(reserva.total)}\nPix: ${evento.pix_chave}\nFavorecido: ${evento.pix_favorecido}\nPrazo: ${evento.prazo_reserva_minutos} minutos.\nEnvie o comprovante para analise.`;
}

function cotacaoAtual(database, evento, quantidade) {
  const situacao = analisarEvento(database, evento.id);
  if (situacao.tipo !== 'vigente') return { situacao, lote: situacao.lote, total: null, percentual: 0 };
  const percentual = percentualDesconto(evento.descontos_quantidade_json, quantidade);
  const total = totalCentavos(situacao.lote.valor_centavos, quantidade, percentual);
  return { situacao, lote: situacao.lote, total, percentual };
}

function precoMudou(cotacao, calculo) {
  if (!cotacao || calculo.situacao.tipo !== 'vigente') return true;
  return Number(cotacao.lote_id) !== Number(calculo.lote.id)
    || Number(cotacao.valor_unitario_centavos) !== Number(calculo.lote.valor_centavos)
    || Number(cotacao.total_centavos) !== Number(calculo.total);
}

function gravarCotacao(conversa, calculo) {
  conversa.lote_id = calculo.lote.id;
  conversa.dados.cotacao = {
    lote_id: Number(calculo.lote.id),
    valor_unitario_centavos: Number(calculo.lote.valor_centavos),
    total_centavos: calculo.total,
    percentual: calculo.percentual,
  };
}

function respostaSituacao(situacao) {
  if (situacao.tipo === 'pausado') return MENSAGEM_PAUSADA;
  if (situacao.tipo === 'esgotado') return MENSAGEM_ESGOTADO;
  return 'Este evento nao possui lote disponivel no momento.';
}

function criarReservaDaConversa(database, evento, conversa, agora) {
  const calculo = cotacaoAtual(database, evento, conversa.quantidade);
  if (calculo.situacao.tipo !== 'vigente') {
    return responder(conversa, respostaSituacao(calculo.situacao));
  }
  if (precoMudou(conversa.dados.cotacao, calculo)) {
    gravarCotacao(conversa, calculo);
    conversa.estado = 'aguardando_confirmacao_preco';
    salvarConversa(database, conversa);
    return responder(conversa, mensagemPrecoNovo(calculo.lote, calculo.total));
  }
  if (!evento.pix_chave) {
    conversa.estado = 'atendimento_humano';
    salvarConversa(database, conversa);
    return responder(conversa, 'O pagamento deste evento ainda nao foi configurado. O atendimento sera encaminhado para uma pessoa.');
  }
  try {
    const reserva = reservar(database, {
      eventoId: evento.id,
      telefone: conversa.telefone,
      nomeComprador: conversa.nome_comprador,
      origem: conversa.origem,
      quantidade: conversa.quantidade,
      participantes: conversa.dados.participantes,
      loteIdEsperado: calculo.lote.id,
      valorUnitarioEsperado: calculo.lote.valor_centavos,
      totalEsperado: calculo.total,
      agora,
    });
    conversa.estado = 'aguardando_pagamento';
    conversa.pedido_id = reserva.pedidoId;
    conversa.lote_id = reserva.loteId;
    salvarConversa(database, conversa);
    return responder(conversa, mensagemPix(evento, reserva), {
      pedido_id: reserva.pedidoId,
      protocolo: reserva.protocolo,
    });
  } catch (error) {
    if (error instanceof RegraError && error.codigo === 'PRECO_MUDOU') {
      const deNovo = cotacaoAtual(database, eventoPorId(database, evento.id), conversa.quantidade);
      if (deNovo.situacao.tipo !== 'vigente') return responder(conversa, respostaSituacao(deNovo.situacao));
      gravarCotacao(conversa, deNovo);
      conversa.estado = 'aguardando_confirmacao_preco';
      salvarConversa(database, conversa);
      return responder(conversa, mensagemPrecoNovo(deNovo.lote, deNovo.total));
    }
    if (error instanceof RegraError && ['LIMITE', 'TETO', 'PAUSADO', 'ESGOTADO', 'SEM_LOTE'].includes(error.codigo)) {
      conversa.estado = 'aguardando_confirmacao_preco';
      salvarConversa(database, conversa);
      const complemento = error.codigo === 'LIMITE' || error.codigo === 'TETO'
        ? ' Responda CORRIGIR para informar outra quantidade.'
        : '';
      return responder(conversa, `${error.message}${complemento}`);
    }
    throw error;
  }
}

function eventoPorId(database, eventoId) {
  return database.prepare('SELECT * FROM eventos WHERE id = ?').get(eventoId);
}

function concluirNomes(database, evento, conversa, agora) {
  const atual = eventoPorId(database, evento.id);
  return criarReservaDaConversa(database, atual, conversa, agora);
}

export function processarMensagem(database, { evento, payload, agora = new Date() }) {
  const telefone = digitosTelefone(payload.telefone);
  if (!telefone) return { estado: 'invalido', resposta: 'Informe o telefone com numeros.' };
  const texto = String(payload.mensagem || '').trim();
  const normalizado = texto.toLocaleLowerCase('pt-BR');
  let armazenada = carregarConversa(database, evento.id, telefone);

  if (normalizado === 'cancelar') {
    if (armazenada?.pedido_id) {
      const pedido = database.prepare('SELECT * FROM pedidos WHERE id = ?').get(armazenada.pedido_id);
      if (pedido?.status === 'pagamento_em_analise' || pedido?.status_pagamento === 'em_analise') {
        return {
          estado: armazenada.estado,
          resposta: 'Seu comprovante ja esta em analise. Aguarde a confirmacao.',
        };
      }
      cancelarPedidoPendente(database, armazenada.pedido_id, agora);
    }
    const cancelada = {
      evento_id: evento.id,
      telefone,
      nome_comprador: payload.nome,
      estado: 'cancelado',
      quantidade: null,
      lote_id: null,
      dados: {},
      pedido_id: null,
      origem: payload.origem,
      criado_em: armazenada?.criado_em,
    };
    salvarConversa(database, cancelada);
    return { estado: 'cancelado', resposta: 'Atendimento cancelado. Quando quiser recomecar, envie COMPRAR.' };
  }

  if (normalizado === 'comprar' && armazenada?.pedido_id) {
    const pedido = database.prepare('SELECT * FROM pedidos WHERE id = ?').get(armazenada.pedido_id);
    if (pedido?.status === 'aguardando_pagamento' && pedido.reserva_expira_em > agora.toISOString()) {
      return {
        estado: 'aguardando_pagamento',
        pedido_id: pedido.id,
        protocolo: pedido.protocolo,
        resposta: `Voce ja tem a reserva ${pedido.protocolo} aguardando o comprovante. Total: R$ ${reais(pedido.valor_total_centavos)}.`,
      };
    }
  }

  const reiniciar = !armazenada || ['cancelado', 'concluido', 'expirado'].includes(armazenada.estado) || normalizado === 'comprar';
  if (reiniciar) {
    const situacao = analisarEvento(database, evento.id);
    if (situacao.tipo !== 'vigente') {
      return { estado: situacao.tipo, resposta: respostaSituacao(situacao) };
    }
    const nova = {
      evento_id: evento.id,
      telefone,
      nome_comprador: payload.nome,
      estado: 'aguardando_quantidade',
      quantidade: null,
      lote_id: situacao.lote.id,
      dados: { participantes: [], cotacao: null },
      pedido_id: null,
      origem: payload.origem,
    };
    salvarConversa(database, nova);
    return {
      estado: nova.estado,
      resposta: `O ${evento.nome} esta no ${situacao.lote.nome}, por R$ ${reais(situacao.lote.valor_centavos)}. Quantos ingressos voce deseja?`,
    };
  }

  const conversa = {
    ...armazenada,
    telefone,
    nome_comprador: payload.nome,
    dados: armazenada.dados,
  };
  conversa.dados.participantes ||= [];

  if (conversa.estado === 'aguardando_quantidade') {
    const quantidade = Number(texto.match(/\d+/)?.[0]);
    if (!Number.isInteger(quantidade) || quantidade < 1) {
      return responder(conversa, 'Informe quantos ingressos voce deseja.');
    }
    const atual = eventoPorId(database, evento.id);
    const limite = atual.max_ingressos_por_pessoa == null ? null : Number(atual.max_ingressos_por_pessoa);
    if (limite != null) {
      const usado = usoTelefone(database, atual.id, telefone, agora);
      if (usado + quantidade > limite) {
        return responder(conversa, mensagemLimitePessoa(limite, Math.max(limite - usado, 0)));
      }
    }
    const teto = atual.capacidade_maxima_evento == null ? null : Number(atual.capacidade_maxima_evento);
    if (teto != null) {
      const usado = usoEvento(database, atual.id, agora);
      if (usado + quantidade > teto) {
        return responder(conversa, mensagemTetoEvento(teto, Math.max(teto - usado, 0)));
      }
    }
    const calculo = cotacaoAtual(database, atual, quantidade);
    if (calculo.situacao.tipo !== 'vigente') return responder(conversa, respostaSituacao(calculo.situacao));
    conversa.quantidade = quantidade;
    gravarCotacao(conversa, calculo);
    conversa.estado = 'aguardando_participante_nome';
    salvarConversa(database, conversa);
    return responder(conversa, `Total: R$ ${reais(calculo.total)} no ${calculo.lote.nome}. Qual e o nome completo do participante 1 de ${quantidade}?`);
  }

  if (conversa.estado === 'aguardando_participante_documento_tipo' || conversa.estado === 'aguardando_participante_documento_numero') {
    if (conversa.dados.atual?.nome) conversa.dados.participantes.push({ nome: conversa.dados.atual.nome });
    conversa.dados.atual = {};
    if (conversa.dados.participantes.length < conversa.quantidade) {
      conversa.estado = 'aguardando_participante_nome';
      salvarConversa(database, conversa);
      return responder(conversa, `Qual e o nome completo do participante ${conversa.dados.participantes.length + 1} de ${conversa.quantidade}?`);
    }
    return concluirNomes(database, evento, conversa, agora);
  }

  if (conversa.estado === 'aguardando_participante_nome') {
    if (texto.length < 3) return responder(conversa, 'Informe o nome completo do participante.');
    conversa.dados.participantes.push({ nome: texto });
    if (conversa.dados.participantes.length < conversa.quantidade) {
      salvarConversa(database, conversa);
      return responder(conversa, `Qual e o nome completo do participante ${conversa.dados.participantes.length + 1} de ${conversa.quantidade}?`);
    }
    return concluirNomes(database, evento, conversa, agora);
  }

  if (conversa.estado === 'aguardando_confirmacao_preco' || conversa.estado === 'aguardando_confirmacao') {
    if (normalizado === 'corrigir') {
      conversa.estado = 'aguardando_quantidade';
      conversa.quantidade = null;
      conversa.dados = { participantes: [], cotacao: null };
      salvarConversa(database, conversa);
      return responder(conversa, 'Vamos recomecar. Quantos ingressos voce deseja?');
    }
    if (normalizado !== 'confirmar') return responder(conversa, 'Responda CONFIRMAR ou CORRIGIR.');
    return concluirNomes(database, evento, conversa, agora);
  }

  if (conversa.estado === 'aguardando_pagamento') {
    return responder(conversa, 'Sua reserva esta aguardando o comprovante e a validacao do pagamento.', {
      pedido_id: conversa.pedido_id,
    });
  }

  if (conversa.estado === 'pagamento_em_analise') {
    return responder(conversa, 'Seu comprovante esta em analise. Aguarde a confirmacao.');
  }

  return responder(conversa, 'Este atendimento precisa ser continuado por uma pessoa.');
}
