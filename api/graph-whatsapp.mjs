import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export function baseGraph(env = process.env) {
  const bruta = String(env.META_GRAPH_BASE_URL ?? '').trim() || 'https://graph.facebook.com';
  let url;
  try {
    url = new URL(bruta);
  } catch {
    throw new Error('META_GRAPH_BASE_URL invalida.');
  }
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') return url;
  if (url.protocol !== 'https:') {
    throw new Error('META_GRAPH_BASE_URL precisa ser https.');
  }
  return url;
}

export function versaoGraph(env = process.env) {
  const valor = String(env.META_GRAPH_VERSION ?? '').trim();
  if (!valor) {
    const error = new Error('META_GRAPH_VERSION nao definida.');
    error.codigo = 'SEM_VERSAO';
    throw error;
  }
  if (!/^v\d+\.\d+$/.test(valor)) {
    throw new Error('META_GRAPH_VERSION invalida.');
  }
  return valor;
}

export function configEnvio(env = process.env) {
  const token = String(env.META_ACCESS_TOKEN ?? '').trim();
  if (!token) return { ativo: false };
  if (token.length < 24) {
    throw new Error('META_ACCESS_TOKEN precisa ter pelo menos 24 caracteres.');
  }
  const phoneNumberId = String(env.META_PHONE_NUMBER_ID ?? '').trim();
  if (!phoneNumberId) throw new Error('META_PHONE_NUMBER_ID nao definido.');
  let versao = '';
  try {
    versao = versaoGraph(env);
  } catch (error) {
    if (error.codigo === 'SEM_VERSAO') return { ativo: false, motivo: error.message };
    throw error;
  }
  return {
    ativo: true,
    token,
    phoneNumberId,
    versao,
    base: baseGraph(env),
  };
}

export async function enviarTexto({
  base,
  versao,
  phoneNumberId,
  token,
  para,
  texto,
  callbackData,
  timeoutMs = 20_000,
  fetchImpl = fetch,
}) {
  const url = new URL(`/${versao}/${phoneNumberId}/messages`, base);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: String(para),
        type: 'text',
        text: { preview_url: false, body: String(texto) },
        biz_opaque_callback_data: String(callbackData),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const falha = new Error(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'timeout' : 'rede');
    falha.codigo = 'REDE';
    throw falha;
  }
  const bruto = await response.text();
  let json = {};
  try {
    json = bruto ? JSON.parse(bruto) : {};
  } catch {
    json = {};
  }
  if (response.status >= 200 && response.status < 300) {
    return { status: response.status, wamid: String(json?.messages?.[0]?.id ?? '') };
  }
  return {
    status: response.status,
    codigo: json?.error?.code ?? '',
    mensagem: String(json?.error?.message ?? '').slice(0, 500),
  };
}

const MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'application/pdf': 'pdf' };
const LIMITE_MIDIA = 5_000_000;

export class MidiaError extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'MidiaError';
    this.codigo = codigo;
  }
}

function magicConfere(arquivo, mime) {
  if (mime === 'image/jpeg') return arquivo.length >= 3 && arquivo[0] === 0xff && arquivo[1] === 0xd8 && arquivo[2] === 0xff;
  if (mime === 'image/png') return arquivo.length >= 4 && arquivo[0] === 0x89 && arquivo[1] === 0x50 && arquivo[2] === 0x4e && arquivo[3] === 0x47;
  if (mime === 'application/pdf') return arquivo.length >= 4 && arquivo.subarray(0, 4).toString('ascii') === '%PDF';
  return false;
}

function hostPermitido(url, base) {
  if (url.protocol === 'http:') {
    if (url.hostname !== '127.0.0.1') throw new MidiaError('permanente', 'A URL da midia nao e permitida.');
    return;
  }
  if (url.protocol !== 'https:') throw new MidiaError('permanente', 'A URL da midia nao e permitida.');
  if (url.hostname === base.hostname || url.hostname === 'lookaside.fbsbx.com') return;
  throw new MidiaError('permanente', 'A URL da midia nao e permitida.');
}

async function lerLimitado(response) {
  if (!response.body) throw new MidiaError('transitorio', 'resposta sem corpo');
  const reader = response.body.getReader();
  const partes = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITE_MIDIA) {
        await reader.cancel();
        throw new MidiaError('permanente', 'O arquivo passa de 5 MB.');
      }
      partes.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof MidiaError) throw error;
    throw new MidiaError('transitorio', 'rede');
  }
  return Buffer.concat(partes);
}

export async function baixarMidia({
  base,
  versao,
  token,
  mediaId,
  mimeEsperado = '',
  sha256Esperado = '',
  pasta,
  timeoutMs = 20_000,
  fetchImpl = fetch,
  gravar,
}) {
  if (!String(token ?? '').trim()) throw new MidiaError('transitorio', 'META_ACCESS_TOKEN nao definido.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let caminho = '';
  try {
    const metaResposta = await fetchImpl(new URL(`/${versao}/${mediaId}`, base), {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      redirect: 'manual',
    });
    if (metaResposta.status === 404) throw new MidiaError('permanente', 'Nao encontrei esse arquivo na Meta.');
    if (metaResposta.status === 429 || metaResposta.status >= 500) {
      throw new MidiaError('transitorio', `HTTP ${metaResposta.status}`);
    }
    if (metaResposta.status !== 200) throw new MidiaError('permanente', `HTTP ${metaResposta.status}`);
    const meta = await metaResposta.json();
    const mime = String(meta.mime_type || mimeEsperado || '');
    if (!MIMES[mime] || (mimeEsperado && mime !== mimeEsperado)) {
      throw new MidiaError('permanente', 'Este arquivo nao e JPG, PNG ou PDF.');
    }
    if (meta.file_size != null && Number(meta.file_size) > LIMITE_MIDIA) {
      throw new MidiaError('permanente', 'O arquivo passa de 5 MB.');
    }
    if (!meta.url) throw new MidiaError('permanente', 'A URL da midia nao e permitida.');
    let atual;
    try {
      atual = new URL(meta.url);
    } catch {
      throw new MidiaError('permanente', 'A URL da midia nao e permitida.');
    }
    hostPermitido(atual, base);
    let resposta;
    for (let salto = 0; salto < 3; salto += 1) {
      resposta = await fetchImpl(atual, {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (![301, 302, 303, 307, 308].includes(resposta.status)) break;
      const destino = new URL(resposta.headers.get('location') || '', atual);
      if (destino.host !== atual.host) throw new MidiaError('permanente', 'Redirecionamento para outro host.');
      hostPermitido(destino, base);
      atual = destino;
    }
    if (resposta.status === 429 || resposta.status >= 500) throw new MidiaError('transitorio', `HTTP ${resposta.status}`);
    if (resposta.status !== 200) throw new MidiaError('permanente', `HTTP ${resposta.status}`);
    const arquivo = await lerLimitado(resposta);
    if (!magicConfere(arquivo, mime)) throw new MidiaError('permanente', 'O conteudo nao confere com o tipo do arquivo.');
    const hash = createHash('sha256').update(arquivo).digest('hex');
    if (sha256Esperado && hash !== String(sha256Esperado).toLowerCase()) {
      throw new MidiaError('permanente', 'O arquivo nao confere com o enviado no WhatsApp.');
    }
    const nomeArquivo = `${randomUUID()}.${MIMES[mime]}`;
    caminho = join(pasta, nomeArquivo);
    const escrever = gravar || ((destino, dados) => writeFileSync(destino, dados, { flag: 'wx' }));
    try {
      escrever(caminho, arquivo);
    } catch (error) {
      if (error.code === 'ENOSPC') {
        try { unlinkSync(caminho); } catch { /* parcial ausente */ }
        throw new MidiaError('transitorio', 'sem espaco em disco');
      }
      throw error;
    }
    return { nomeArquivo, mime, tamanho: arquivo.length, sha256: hash };
  } catch (error) {
    if (error instanceof MidiaError) throw error;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      throw new MidiaError('transitorio', 'timeout');
    }
    throw new MidiaError('transitorio', 'rede');
  } finally {
    clearTimeout(timer);
  }
}

export function caminhoDentroDaPasta(pasta, caminho) {
  if (typeof caminho !== 'string' || !caminho || caminho.includes('\0')) return null;
  const base = resolve(pasta);
  const alvo = resolve(base, caminho);
  const rel = relative(base, alvo);
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  if (!alvo.startsWith(`${base}${sep}`)) return null;
  return alvo;
}
