import { emTransacao } from './lotes.mjs';

const JANELA_MS = 24 * 60 * 60 * 1000;
const LIMITE_TEXTO = 4096;

function iso(agora) {
  return (agora instanceof Date ? agora : new Date(agora)).toISOString();
}

function truncar(valor) {
  return String(valor ?? '').slice(0, 500);
}

export function maxTentativasEnvio(env = process.env) {
  const valor = Number(env.ENVIO_MAX_TENTATIVAS ?? 30);
  return Number.isInteger(valor) && valor > 0 ? valor : 30;
}

export function atrasoEnvioMs(tentativas) {
  return Math.min(300, 2 ** Number(tentativas)) * 1000;
}

export function marcarEnviosIncertos(database, agora = new Date()) {
  const momento = iso(agora);
  const resultado = database.prepare(`
    UPDATE mensagens_saida
    SET status = 'envio_incerto', atualizado_em = ?
    WHERE status = 'enviando' AND (wamid_saida IS NULL OR wamid_saida = '')
  `).run(momento);
  return { incertos: Number(resultado.changes) };
}

function detalheHttp(resposta) {
  const texto = `${resposta?.codigo ?? ''} ${resposta?.mensagem ?? ''}`.trim();
  return truncar(texto || `HTTP ${resposta?.status ?? 0}`);
}

function marcarFalhou(database, id, erro, agora, tentativas = null) {
  const momento = iso(agora);
  if (tentativas == null) {
    database.prepare(`
      UPDATE mensagens_saida
      SET status = 'falhou', ultimo_erro = ?, atualizado_em = ?
      WHERE id = ?
    `).run(truncar(erro), momento, id);
    return;
  }
  database.prepare(`
    UPDATE mensagens_saida
    SET status = 'falhou', tentativas = ?, ultimo_erro = ?, atualizado_em = ?
    WHERE id = ?
  `).run(tentativas, truncar(erro), momento, id);
}

function marcarIncerto(database, id, erro, agora) {
  const momento = iso(agora);
  database.prepare(`
    UPDATE mensagens_saida
    SET status = 'envio_incerto', ultimo_erro = ?, atualizado_em = ?
    WHERE id = ?
  `).run(truncar(erro), momento, id);
}

const sqlProxima = `
  SELECT s.id
  FROM mensagens_saida s
  JOIN mensagens_entrada e ON e.wamid = s.wamid
  WHERE s.status = 'pendente_envio'
    AND (s.proxima_tentativa_em IS NULL OR s.proxima_tentativa_em <= ?)
    AND NOT EXISTS (
      SELECT 1
      FROM mensagens_saida anterior
      JOIN mensagens_entrada ea ON ea.wamid = anterior.wamid
      WHERE ea.telefone = e.telefone
        AND anterior.id < s.id
        AND anterior.status IN ('pendente_envio', 'enviando', 'envio_incerto')
    )
  ORDER BY s.id
  LIMIT 1
`;

function reivindicar(database, agora) {
  const momento = iso(agora);
  return emTransacao(database, () => {
    const escolhida = database.prepare(sqlProxima).get(momento);
    if (!escolhida) return null;
    const entrada = database.prepare(`
      SELECT e.telefone
      FROM mensagens_saida s
      JOIN mensagens_entrada e ON e.wamid = s.wamid
      WHERE s.id = ?
    `).get(escolhida.id);
    const ultima = database.prepare(`
      SELECT recebida_em FROM mensagens_entrada
      WHERE telefone = ?
      ORDER BY recebida_em DESC, wamid DESC
      LIMIT 1
    `).get(entrada.telefone);
    const recebida = new Date(ultima?.recebida_em || 0).getTime();
    if (!Number.isFinite(recebida) || agora.getTime() - recebida >= JANELA_MS) {
      const mudou = database.prepare(`
        UPDATE mensagens_saida
        SET status = 'fora_da_janela', ultimo_erro = 'janela de 24h', atualizado_em = ?
        WHERE id = ? AND status = 'pendente_envio'
      `).run(momento, escolhida.id);
      if (Number(mudou.changes) !== 1) return null;
      return { fora: true, id: escolhida.id };
    }
    const mudou = database.prepare(`
      UPDATE mensagens_saida
      SET status = 'enviando', atualizado_em = ?
      WHERE id = ? AND status = 'pendente_envio'
    `).run(momento, escolhida.id);
    if (Number(mudou.changes) !== 1) return null;
    return database.prepare(`
      SELECT s.id, s.texto, s.tentativas, e.telefone
      FROM mensagens_saida s
      JOIN mensagens_entrada e ON e.wamid = s.wamid
      WHERE s.id = ?
    `).get(escolhida.id);
  });
}

export async function processarProximaSaida(database, {
  enviar,
  agora = new Date(),
  maximo = maxTentativasEnvio(),
} = {}) {
  const linha = reivindicar(database, agora);
  if (!linha) return { processou: false };
  if (linha.fora) return { processou: true, status: 'fora_da_janela', id: linha.id };
  if (String(linha.texto ?? '').length > LIMITE_TEXTO) {
    marcarFalhou(database, linha.id, 'texto acima de 4096 caracteres', agora);
    return { processou: true, status: 'falhou', id: linha.id };
  }
  let resposta;
  try {
    resposta = await enviar({
      para: linha.telefone,
      texto: linha.texto,
      callbackData: String(linha.id),
    });
  } catch (error) {
    marcarIncerto(database, linha.id, error.codigo === 'REDE' ? error.message : (error.message || 'rede'), agora);
    return { processou: true, status: 'envio_incerto', id: linha.id };
  }
  const status = Number(resposta?.status ?? 0);
  if (status >= 200 && status < 300) {
    if (!resposta.wamid) {
      marcarIncerto(database, linha.id, 'resposta sem wamid', agora);
      return { processou: true, status: 'envio_incerto', id: linha.id };
    }
    const momento = iso(agora);
    database.prepare(`
      UPDATE mensagens_saida
      SET status = 'enviada', wamid_saida = ?, enviada_em = ?, atualizado_em = ?, ultimo_erro = ''
      WHERE id = ?
    `).run(String(resposta.wamid), momento, momento, linha.id);
    return { processou: true, status: 'enviada', id: linha.id };
  }
  const detalhe = detalheHttp(resposta);
  if (status === 429 || status >= 500) {
    const tentativas = Number(linha.tentativas) + 1;
    if (tentativas >= maximo) {
      marcarFalhou(database, linha.id, detalhe, agora, tentativas);
      return { processou: true, status: 'falhou', id: linha.id };
    }
    const proxima = new Date(agora.getTime() + atrasoEnvioMs(tentativas)).toISOString();
    database.prepare(`
      UPDATE mensagens_saida
      SET status = 'pendente_envio', tentativas = ?, proxima_tentativa_em = ?, ultimo_erro = ?, atualizado_em = ?
      WHERE id = ?
    `).run(tentativas, proxima, detalhe, iso(agora), linha.id);
    return { processou: true, status: 'pendente_envio', id: linha.id };
  }
  if (status >= 400 && status < 500) {
    marcarFalhou(database, linha.id, detalhe, agora, Number(linha.tentativas) + 1);
    return { processou: true, status: 'falhou', id: linha.id };
  }
  marcarIncerto(database, linha.id, detalhe || 'sem resposta', agora);
  return { processou: true, status: 'envio_incerto', id: linha.id };
}

export function resumoSaidas(database) {
  const linha = database.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'pendente_envio' THEN 1 ELSE 0 END), 0) AS pendente_envio,
      COALESCE(SUM(CASE WHEN status = 'enviando' THEN 1 ELSE 0 END), 0) AS enviando,
      COALESCE(SUM(CASE WHEN status = 'envio_incerto' THEN 1 ELSE 0 END), 0) AS envio_incerto,
      COALESCE(SUM(CASE WHEN status = 'falhou' THEN 1 ELSE 0 END), 0) AS falhou,
      COALESCE(SUM(CASE WHEN status = 'fora_da_janela' THEN 1 ELSE 0 END), 0) AS fora_da_janela
    FROM mensagens_saida
  `).get();
  return {
    pendente_envio: Number(linha.pendente_envio),
    enviando: Number(linha.enviando),
    envio_incerto: Number(linha.envio_incerto),
    falhou: Number(linha.falhou),
    fora_da_janela: Number(linha.fora_da_janela),
  };
}

export function listarSaidasAlerta(database) {
  return database.prepare(`
    SELECT s.id, e.telefone, s.status, s.tentativas, s.ultimo_erro, s.status_meta, s.erro_meta, s.criada_em
    FROM mensagens_saida s
    JOIN mensagens_entrada e ON e.wamid = s.wamid
    WHERE s.status IN ('falhou', 'fora_da_janela', 'envio_incerto')
    ORDER BY s.id DESC
    LIMIT 100
  `).all();
}

export function reenviarSaida(database, id, { confirmar = false, agora = new Date() } = {}) {
  const linha = database.prepare('SELECT id, status FROM mensagens_saida WHERE id = ?').get(id);
  if (!linha) {
    const error = new Error('Mensagem de saida nao encontrada.');
    error.codigo = 'NAO_ENCONTRADA';
    throw error;
  }
  if (linha.status === 'fora_da_janela') {
    const error = new Error('Mensagem fora da janela nao pode ser reenviada.');
    error.codigo = 'ESTADO';
    throw error;
  }
  if (linha.status !== 'falhou' && linha.status !== 'envio_incerto') {
    const error = new Error('So uma saida que falhou ou ficou incerta pode ser reenviada.');
    error.codigo = 'ESTADO';
    throw error;
  }
  if (!confirmar) {
    const error = new Error('Reenviar pode duplicar a mensagem na tela do cliente. Envie confirmar=1 para reenviar.');
    error.codigo = 'CONFIRMAR';
    throw error;
  }
  const momento = iso(agora);
  database.prepare(`
    UPDATE mensagens_saida
    SET status = 'pendente_envio', tentativas = 0, proxima_tentativa_em = ?, ultimo_erro = '',
      wamid_saida = NULL, atualizado_em = ?
    WHERE id = ?
  `).run(momento, momento, id);
  return { id: Number(id), status: 'pendente_envio' };
}

export function iniciarEnvio(database, {
  enviar,
  env = process.env,
  intervaloMs = 1000,
  config,
} = {}) {
  marcarEnviosIncertos(database);
  if (!config?.ativo) return () => {};
  let parado = false;
  let timer = null;
  const ciclo = async () => {
    if (parado) return;
    let espera = intervaloMs;
    try {
      const resultado = await processarProximaSaida(database, {
        enviar,
        maximo: maxTentativasEnvio(env),
      });
      if (resultado.processou) espera = 0;
    } catch (error) {
      console.error(`Falha no envio: ${error.message}`);
    } finally {
      if (!parado) timer = setTimeout(ciclo, espera);
    }
  };
  timer = setTimeout(ciclo, 0);
  return () => {
    parado = true;
    clearTimeout(timer);
  };
}
