import { digitosTelefone, emTransacao } from './lotes.mjs';

function iso(agora) {
  return (agora instanceof Date ? agora : new Date(agora)).toISOString();
}

export function maxTentativas(env = process.env) {
  const valor = Number(env.FILA_MAX_TENTATIVAS ?? 30);
  return Number.isInteger(valor) && valor > 0 ? valor : 30;
}

export function retencaoDias(env = process.env) {
  const valor = Number(env.FILA_RETENCAO_DIAS ?? 7);
  return Number.isInteger(valor) && valor > 0 ? valor : 7;
}

export function atrasoMs(tentativas) {
  const segundos = Math.min(300, 2 ** Number(tentativas));
  return segundos * 1000;
}

export function exigirBancoPronto(database) {
  const versao = Number(database.prepare('PRAGMA user_version').get().user_version);
  if (versao < 2) {
    throw new Error('suba a API primeiro');
  }
}

export function enfileirar(database, mensagens, { origem = 'whatsapp', eventoCodigo = '', agora = new Date() } = {}) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    let novas = 0;
    const inserir = database.prepare(`
      INSERT INTO fila_webhook (
        wamid, telefone, nome, tipo, texto, timestamp_mensagem, origem, evento_codigo,
        corpo, status, tentativas, proxima_tentativa_em, ultimo_erro, criado_em, atualizado_em
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', 0, ?, '', ?, ?)
    `);
    for (const mensagem of mensagens) {
      const wamid = String(mensagem.id_mensagem ?? '').trim();
      if (!wamid) continue;
      const existe = database.prepare('SELECT id FROM fila_webhook WHERE wamid = ?').get(wamid);
      if (existe) continue;
      inserir.run(
        wamid,
        digitosTelefone(mensagem.telefone),
        String(mensagem.nome ?? ''),
        String(mensagem.tipo ?? 'desconhecido'),
        String(mensagem.texto ?? ''),
        String(mensagem.timestamp ?? momento),
        origem,
        String(eventoCodigo ?? ''),
        JSON.stringify(mensagem.corpo ?? {}),
        momento,
        momento,
        momento,
      );
      novas += 1;
    }
    return { novas };
  });
}

const sqlProxima = `
  SELECT f.id
  FROM fila_webhook f
  WHERE f.status = 'pendente'
    AND f.proxima_tentativa_em <= ?
    AND NOT EXISTS (
      SELECT 1 FROM fila_webhook anterior
      WHERE anterior.telefone = f.telefone
        AND anterior.id < f.id
        AND anterior.status IN ('pendente', 'processando')
    )
  ORDER BY f.id
  LIMIT 1
`;

function reivindicar(database, agora) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    const escolhida = database.prepare(sqlProxima).get(momento);
    if (!escolhida) return null;
    const mudou = database.prepare(`
      UPDATE fila_webhook
      SET status = 'processando', tentativas = tentativas + 1, atualizado_em = ?
      WHERE id = ? AND status = 'pendente'
    `).run(momento, escolhida.id);
    if (Number(mudou.changes) !== 1) return null;
    return database.prepare('SELECT * FROM fila_webhook WHERE id = ?').get(escolhida.id);
  });
}

function marcarEntregue(database, id, agora) {
  const momento = iso(agora);
  database.prepare(`
    UPDATE fila_webhook
    SET status = 'entregue', corpo = '', ultimo_erro = '', atualizado_em = ?
    WHERE id = ?
  `).run(momento, id);
}

function marcarFalhou(database, id, erro, agora) {
  const momento = iso(agora);
  database.prepare(`
    UPDATE fila_webhook
    SET status = 'falhou', ultimo_erro = ?, atualizado_em = ?
    WHERE id = ?
  `).run(String(erro ?? '').slice(0, 500), momento, id);
}

function statusTransitorio(status) {
  return status === 404 || status === 408 || status === 425 || status === 429;
}

function textoDeErro(status, erro) {
  const texto = String(erro ?? '').trim();
  if (texto) return texto.slice(0, 500);
  return status ? `HTTP ${status}` : 'sem resposta';
}

function agendar(database, linha, erro, agora, limite) {
  if (Number(linha.tentativas) >= limite) {
    marcarFalhou(database, linha.id, erro, agora);
    return { processou: true, status: 'falhou', id: linha.id };
  }
  const proxima = new Date(agora.getTime() + atrasoMs(linha.tentativas)).toISOString();
  database.prepare(`
    UPDATE fila_webhook
    SET status = 'pendente', proxima_tentativa_em = ?, ultimo_erro = ?, atualizado_em = ?
    WHERE id = ?
  `).run(proxima, String(erro ?? '').slice(0, 500), iso(agora), linha.id);
  return { processou: true, status: 'pendente', id: linha.id };
}

export function retomarProcessando(database, agora = new Date()) {
  const momento = iso(agora);
  const result = database.prepare(`
    UPDATE fila_webhook
    SET status = 'pendente', proxima_tentativa_em = ?, atualizado_em = ?
    WHERE status = 'processando'
  `).run(momento, momento);
  return { retomadas: Number(result.changes) };
}

export function apagarEntregues(database, dias = retencaoDias(), agora = new Date()) {
  const limite = new Date(agora.getTime() - Number(dias) * 24 * 60 * 60 * 1000).toISOString();
  const result = database.prepare(`
    DELETE FROM fila_webhook
    WHERE status = 'entregue' AND atualizado_em < ?
  `).run(limite);
  return { apagados: Number(result.changes) };
}

export function reterCorpos(database, dias = retencaoDias(), agora = new Date()) {
  const limite = new Date(agora.getTime() - Number(dias) * 24 * 60 * 60 * 1000).toISOString();
  const result = database.prepare(`
    UPDATE fila_webhook
    SET corpo = ''
    WHERE status = 'falhou' AND corpo != '' AND atualizado_em < ?
  `).run(limite);
  return { apagados: Number(result.changes) };
}

export function resumoFila(database, agora = new Date()) {
  const contagem = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pendente' THEN 1 ELSE 0 END), 0) AS pendentes,
      COALESCE(SUM(CASE WHEN status = 'processando' THEN 1 ELSE 0 END), 0) AS processando
    FROM fila_webhook
  `).get();
  const antigo = database.prepare(`
    SELECT criado_em FROM fila_webhook
    WHERE status = 'pendente'
    ORDER BY criado_em ASC, id ASC
    LIMIT 1
  `).get();
  const momento = agora instanceof Date ? agora : new Date(agora);
  let idade = null;
  if (antigo?.criado_em) {
    idade = Math.max(0, Math.floor((momento.getTime() - new Date(antigo.criado_em).getTime()) / 1000));
  }
  return {
    pendentes: Number(contagem.pendentes),
    processando: Number(contagem.processando),
    idade_pendente_mais_antigo_segundos: idade,
  };
}

export function listarFalhas(database) {
  return database.prepare(`
    SELECT id, telefone, tipo, tentativas, ultimo_erro, criado_em, atualizado_em,
      CASE WHEN corpo = '' THEN 0 ELSE 1 END AS tem_corpo
    FROM fila_webhook
    WHERE status = 'falhou'
    ORDER BY id DESC
    LIMIT 100
  `).all();
}

export function reenfileirar(database, id, agoraOuOpcoes = new Date()) {
  const opcoes = agoraOuOpcoes instanceof Date
    ? { agora: agoraOuOpcoes, confirmar: false }
    : {
      agora: agoraOuOpcoes?.agora instanceof Date ? agoraOuOpcoes.agora : new Date(),
      confirmar: Boolean(agoraOuOpcoes?.confirmar),
    };
  const agora = opcoes.agora;
  const linha = database.prepare('SELECT * FROM fila_webhook WHERE id = ?').get(id);
  if (!linha) {
    const error = new Error('Item da fila nao encontrado.');
    error.codigo = 'NAO_ENCONTRADA';
    throw error;
  }
  if (linha.status !== 'falhou') {
    const error = new Error('So um item que falhou pode ser reenfileirado.');
    error.codigo = 'ESTADO';
    throw error;
  }
  if (!linha.corpo) {
    const error = new Error('O corpo deste evento ja expirou.');
    error.codigo = 'EXPIRADO';
    throw error;
  }
  const maisNova = database.prepare(`
    SELECT id FROM fila_webhook
    WHERE telefone = ? AND id > ? AND status = 'entregue'
    LIMIT 1
  `).get(linha.telefone, linha.id);
  if (maisNova && !opcoes.confirmar) {
    const error = new Error('Ja existe uma mensagem mais nova deste telefone entregue. Envie confirmar=1 para reenfileirar.');
    error.codigo = 'CONFIRMAR';
    throw error;
  }
  const momento = iso(agora);
  database.prepare(`
    UPDATE fila_webhook
    SET status = 'pendente', tentativas = 0, proxima_tentativa_em = ?, ultimo_erro = '', atualizado_em = ?
    WHERE id = ?
  `).run(momento, momento, id);
  return { id: Number(id), status: 'pendente' };
}

export async function processarProxima(database, {
  entregar,
  maximo = maxTentativas(),
  agora = new Date(),
  portaApi = '8000',
} = {}) {
  const linha = reivindicar(database, agora);
  if (!linha) return { processou: false };
  const payload = {
    telefone: linha.telefone,
    nome: linha.nome,
    tipo: linha.tipo,
    texto: linha.texto,
    id_mensagem: linha.wamid,
    timestamp: linha.timestamp_mensagem,
    origem: linha.origem,
    evento_codigo: linha.evento_codigo,
    porta_api: String(portaApi),
  };
  try {
    const resposta = await entregar(payload);
    const status = Number(resposta?.status ?? 0);
    const detalhe = textoDeErro(status, resposta?.erro);
    if (status >= 200 && status < 300) {
      marcarEntregue(database, linha.id, agora);
      return { processou: true, status: 'entregue', id: linha.id };
    }
    if (status >= 400 && status < 500 && !statusTransitorio(status)) {
      marcarFalhou(database, linha.id, detalhe, agora);
      return { processou: true, status: 'falhou', id: linha.id };
    }
    return agendar(database, linha, status ? detalhe : 'sem resposta', agora, maximo);
  } catch (error) {
    return agendar(database, linha, error.message || 'falha de rede', agora, maximo);
  }
}
