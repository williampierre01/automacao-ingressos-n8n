import { emTransacao } from './lotes.mjs';
import { erroMetaPublico, limparMarcasPausa, marcaPausa, restaurarPausa } from './pausa-envio.mjs';

const JANELA_MS = 24 * 60 * 60 * 1000;
const LIMITE_TEXTO = 4096;
const CODIGOS_PAUSA = new Set([190, 0, 102, 104, 10, 3, 131005]);
const SUBCODES_PAUSA = new Set([458, 460, 463, 467]);
const CODIGOS_RETRY = new Set([4, 17, 341, 80007, 130429, 131056]);

function inteiro(valor) {
  if (typeof valor === 'number' && Number.isInteger(valor)) return valor;
  if (typeof valor === 'string' && /^-?\d+$/.test(valor.trim())) return Number(valor.trim());
  return null;
}

export function criarControleEnvio() {
  return { pausado: false, codigo: null, desde: null, drenar: false };
}

export function textoErroPausa(codigo) {
  if (Number.isInteger(codigo)) return `token invalido (code ${codigo})`;
  return 'token invalido';
}

export function classificarFalhaEnvio(resposta) {
  const status = Number(resposta?.status ?? 0);
  const code = inteiro(resposta?.codigo);
  const sub = inteiro(resposta?.error_subcode);
  if (status === 429 || status >= 500) return 'retry';
  if (status < 400 || status >= 500) return 'incerto';
  if (status === 401) return 'pausa';
  if (code != null && (CODIGOS_PAUSA.has(code) || (code >= 200 && code <= 299))) return 'pausa';
  if (sub != null && SUBCODES_PAUSA.has(sub)) return 'pausa';
  if (status === 403 && code == null) return 'pausa';
  if (code != null && CODIGOS_RETRY.has(code)) return 'retry';
  return 'falhou';
}

export function esperaDoCiclo(processou, controle, intervaloMs) {
  if (controle?.drenar) {
    if (!processou) controle.drenar = false;
    return intervaloMs;
  }
  return processou ? 0 : intervaloMs;
}

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

function marcarIncerto(database, id, erro, agora, tentativas = null) {
  const momento = iso(agora);
  if (tentativas == null) {
    database.prepare(`
      UPDATE mensagens_saida
      SET status = 'envio_incerto', ultimo_erro = ?, atualizado_em = ?
      WHERE id = ?
    `).run(truncar(erro), momento, id);
    return;
  }
  database.prepare(`
    UPDATE mensagens_saida
    SET status = 'envio_incerto', tentativas = ?, ultimo_erro = ?, atualizado_em = ?
    WHERE id = ?
  `).run(tentativas, truncar(erro), momento, id);
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
    const previa = database.prepare('SELECT tentativas FROM mensagens_saida WHERE id = ?').get(escolhida.id);
    const mudou = database.prepare(`
      UPDATE mensagens_saida
      SET status = 'enviando', tentativas = tentativas + 1, atualizado_em = ?
      WHERE id = ? AND status = 'pendente_envio'
    `).run(momento, escolhida.id);
    if (Number(mudou.changes) !== 1) return null;
    const linha = database.prepare(`
      SELECT s.id, s.texto, s.tentativas, e.telefone
      FROM mensagens_saida s
      JOIN mensagens_entrada e ON e.wamid = s.wamid
      WHERE s.id = ?
    `).get(escolhida.id);
    linha.tentativasAntes = Number(previa?.tentativas ?? 0);
    return linha;
  });
}

function soltarClaim(database, linha, agora) {
  database.prepare(`
    UPDATE mensagens_saida
    SET status = 'pendente_envio', tentativas = ?, atualizado_em = ?
    WHERE id = ? AND status = 'enviando'
  `).run(Number(linha.tentativasAntes), iso(agora), linha.id);
}

function pausarSaida(database, linha, codigo, agora, token) {
  const momento = iso(agora);
  database.prepare(`
    UPDATE mensagens_saida
    SET status = 'pendente_envio', tentativas = ?, ultimo_erro = ?, erro_meta = ?, atualizado_em = ?
    WHERE id = ?
  `).run(
    Number(linha.tentativasAntes),
    textoErroPausa(codigo),
    token ? marcaPausa(token) : null,
    momento,
    linha.id,
  );
  return momento;
}

export async function processarProximaSaida(database, {
  enviar,
  agora = new Date(),
  maximo = maxTentativasEnvio(),
  controle,
  token = '',
} = {}) {
  if (controle?.pausado) return { processou: false, pausado: true };
  const linha = reivindicar(database, agora);
  if (!linha) return { processou: false };
  if (linha.fora) return { processou: true, status: 'fora_da_janela', id: linha.id };
  if (String(linha.texto ?? '').length > LIMITE_TEXTO) {
    marcarFalhou(database, linha.id, 'texto acima de 4096 caracteres', agora, Number(linha.tentativasAntes));
    return { processou: true, status: 'falhou', id: linha.id };
  }
  if (controle?.pausado) {
    soltarClaim(database, linha, agora);
    return { processou: false, pausado: true };
  }
  let resposta;
  try {
    resposta = await enviar({
      para: linha.telefone,
      texto: linha.texto,
      callbackData: String(linha.id),
    });
  } catch (error) {
    if (error?.codigo === 'PAUSA') {
      soltarClaim(database, linha, agora);
      return { processou: false, pausado: true };
    }
    marcarIncerto(database, linha.id, error.codigo === 'REDE' ? error.message : (error.message || 'rede'), agora, Number(linha.tentativasAntes));
    return { processou: true, status: 'envio_incerto', id: linha.id };
  }
  const status = Number(resposta?.status ?? 0);
  if (status >= 200 && status < 300) {
    if (!resposta.wamid) {
      marcarIncerto(database, linha.id, 'resposta sem wamid', agora, Number(linha.tentativasAntes));
      return { processou: true, status: 'envio_incerto', id: linha.id };
    }
    const momento = iso(agora);
    database.prepare(`
      UPDATE mensagens_saida
      SET status = 'enviada', wamid_saida = ?, enviada_em = ?, atualizado_em = ?, ultimo_erro = '', tentativas = ?
      WHERE id = ?
    `).run(String(resposta.wamid), momento, momento, Number(linha.tentativasAntes), linha.id);
    return { processou: true, status: 'enviada', id: linha.id };
  }
  const detalhe = detalheHttp(resposta);
  const classe = classificarFalhaEnvio(resposta);
  if (classe === 'pausa') {
    const codigo = inteiro(resposta?.codigo);
    const desde = pausarSaida(database, linha, codigo, agora, token);
    if (controle) {
      controle.pausado = true;
      controle.codigo = codigo;
      controle.desde = desde;
    }
    return { processou: true, status: 'pausado', id: linha.id, codigo };
  }
  if (classe === 'retry') {
    const tentativas = Number(linha.tentativasAntes) + 1;
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
  if (classe === 'falhou') {
    marcarFalhou(database, linha.id, detalhe, agora, Number(linha.tentativasAntes) + 1);
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
  `).all().map((item) => ({ ...item, erro_meta: erroMetaPublico(item.erro_meta) }));
}

export function respostaSaidas(database, { envioAtivo = false, controle } = {}) {
  const resumo = resumoSaidas(database);
  const pausado = Boolean(controle?.pausado);
  return {
    ...resumo,
    envio_ativo: Boolean(envioAtivo),
    envio_pausado: pausado,
    pausado_desde: pausado ? (controle.desde ?? null) : null,
    saidas_aguardando: resumo.pendente_envio,
    codigo: pausado ? (controle.codigo ?? null) : null,
    itens: listarSaidasAlerta(database),
  };
}

export function retomarEnvio(database, controle, { confirmar = false } = {}) {
  if (!controle?.pausado) return { mensagem: 'nada a retomar' };
  if (!confirmar) {
    const error = new Error('Retomar o envio volta a chamar a Meta. Envie confirmar=1 para retomar.');
    error.codigo = 'CONFIRMAR';
    throw error;
  }
  limparMarcasPausa(database);
  controle.pausado = false;
  controle.codigo = null;
  controle.desde = null;
  controle.drenar = true;
  return { retomado: true };
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
  controle,
} = {}) {
  const estado = controle || criarControleEnvio();
  marcarEnviosIncertos(database);
  if (config?.ativo && config.token) restaurarPausa(database, estado, config.token);
  if (!config?.ativo) return () => {};
  let parado = false;
  let timer = null;
  const enviarComPortao = (mensagem) => {
    if (estado.pausado) {
      const error = new Error('envio pausado');
      error.codigo = 'PAUSA';
      return Promise.reject(error);
    }
    return enviar(mensagem);
  };
  const ciclo = async () => {
    if (parado) return;
    let espera = intervaloMs;
    try {
      const resultado = await processarProximaSaida(database, {
        enviar: enviarComPortao,
        maximo: maxTentativasEnvio(env),
        controle: estado,
        token: config.token,
      });
      espera = esperaDoCiclo(resultado.processou, estado, intervaloMs);
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
