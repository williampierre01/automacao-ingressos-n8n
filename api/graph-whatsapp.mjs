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
