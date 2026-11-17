import { createHash } from 'node:crypto';

export const PREFIXO_PAUSA = 'pausa:';

export function hashTokenEnvio(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

export function marcaPausa(token) {
  return `${PREFIXO_PAUSA}${hashTokenEnvio(token)}`;
}

export function ehMarcaPausa(valor) {
  return typeof valor === 'string' && valor.startsWith(PREFIXO_PAUSA);
}

export function erroMetaPublico(valor) {
  return ehMarcaPausa(valor) ? '' : (valor ?? '');
}

export function codigoDoTextoPausa(texto) {
  const match = /^token invalido \(code (\d+)\)$/.exec(String(texto ?? ''));
  return match ? Number(match[1]) : null;
}

export function ehTextoTokenInvalido(texto) {
  const valor = String(texto ?? '');
  return valor === 'token invalido' || codigoDoTextoPausa(valor) != null;
}

function marcasPendentes(database) {
  return database.prepare(`
    SELECT id, erro_meta, ultimo_erro, atualizado_em
    FROM mensagens_saida
    WHERE status = 'pendente_envio'
      AND substr(COALESCE(erro_meta, ''), 1, length(?)) = ?
    ORDER BY atualizado_em ASC, id ASC
  `).all(PREFIXO_PAUSA, PREFIXO_PAUSA);
}

export function limparMarcasPausa(database) {
  const resultado = database.prepare(`
    UPDATE mensagens_saida
    SET erro_meta = NULL
    WHERE substr(COALESCE(erro_meta, ''), 1, length(?)) = ?
  `).run(PREFIXO_PAUSA, PREFIXO_PAUSA);
  return Number(resultado.changes);
}

export function marcarPausaDownload(database, controle, { token, texto, agora = new Date() } = {}) {
  if (!controle || controle.pausado) return { marcado: false };
  const momento = (agora instanceof Date ? agora : new Date(agora)).toISOString();
  const publico = ehTextoTokenInvalido(texto) ? String(texto) : 'token invalido';
  let marcado = false;
  if (database && token) {
    const resultado = database.prepare(`
      UPDATE mensagens_saida
      SET erro_meta = ?, ultimo_erro = ?, atualizado_em = ?
      WHERE id = (
        SELECT id FROM mensagens_saida
        WHERE status = 'pendente_envio'
        ORDER BY id ASC
        LIMIT 1
      )
    `).run(marcaPausa(token), publico, momento);
    marcado = Number(resultado.changes) === 1;
  }
  controle.pausado = true;
  controle.codigo = codigoDoTextoPausa(publico);
  controle.desde = momento;
  return { marcado };
}

export function restaurarPausa(database, controle, token) {
  const marcas = marcasPendentes(database);
  if (!marcas.length || !token || !controle) return { pausado: false };
  const esperada = marcaPausa(token);
  if (marcas.some((item) => item.erro_meta !== esperada)) {
    database.prepare(`
      UPDATE mensagens_saida
      SET erro_meta = NULL
      WHERE status = 'pendente_envio'
        AND substr(COALESCE(erro_meta, ''), 1, length(?)) = ?
        AND erro_meta != ?
    `).run(PREFIXO_PAUSA, PREFIXO_PAUSA, esperada);
  }
  const iguais = marcas.filter((item) => item.erro_meta === esperada);
  if (!iguais.length) {
    controle.pausado = false;
    controle.codigo = null;
    controle.desde = null;
    return { pausado: false };
  }
  controle.pausado = true;
  controle.desde = iguais[0].atualizado_em || null;
  controle.codigo = codigoDoTextoPausa(iguais[0].ultimo_erro);
  return { pausado: true };
}
