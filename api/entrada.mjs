import { processarMensagem } from './conversa.mjs';
import { digitosTelefone, emTransacao } from './lotes.mjs';

export const TEXTO_ARQUIVO = 'Recebi seu arquivo. O envio de comprovante por aqui ainda nao esta disponivel.';
export const TEXTO_SO_TEXTO = 'Por enquanto so consigo ler mensagens de texto.';
export const TEXTO_SEM_EVENTO = 'A venda pelo WhatsApp nao esta disponivel neste momento.';
export const TEXTO_VENDAS_FECHADAS = 'As vendas deste evento nao estao abertas.';

const TIPOS_ARQUIVO = new Set(['imagem', 'documento']);
const TIPOS_NAO_LIDOS = new Set(['audio', 'figurinha', 'localizacao', 'desconhecido']);

function iso(agora) {
  return (agora instanceof Date ? agora : new Date(agora)).toISOString();
}

function textoDe(mensagem) {
  if (mensagem?.text?.body) return String(mensagem.text.body);
  if (mensagem?.button?.text) return String(mensagem.button.text);
  if (mensagem?.button?.payload) return String(mensagem.button.payload);
  const interativo = mensagem?.interactive ?? {};
  if (interativo.button_reply?.title) return String(interativo.button_reply.title);
  if (interativo.button_reply?.id) return String(interativo.button_reply.id);
  if (interativo.list_reply?.title) return String(interativo.list_reply.title);
  if (interativo.list_reply?.id) return String(interativo.list_reply.id);
  return '';
}

function tipoDe(mensagem) {
  const bruto = String(mensagem?.type ?? '');
  const interativo = mensagem?.interactive?.type;
  if (bruto === 'text') return 'texto';
  if (bruto === 'button' || mensagem?.button) return 'botao';
  if (interativo === 'button_reply' || mensagem?.interactive?.button_reply) return 'botao';
  if (interativo === 'list_reply' || mensagem?.interactive?.list_reply) return 'lista';
  if (bruto === 'image') return 'imagem';
  if (bruto === 'document') return 'documento';
  if (bruto === 'audio') return 'audio';
  if (bruto === 'sticker') return 'figurinha';
  if (bruto === 'location') return 'localizacao';
  return 'desconhecido';
}

function nomeDoContato(contatos, telefone) {
  const lista = Array.isArray(contatos) ? contatos : [];
  const contato = lista.find((item) => item?.wa_id === telefone) ?? lista[0] ?? {};
  return String(contato.profile?.name ?? '');
}

function timestampDe(mensagem, agora) {
  const segundos = Number(mensagem?.timestamp);
  if (Number.isFinite(segundos) && segundos > 0) return new Date(segundos * 1000).toISOString();
  return iso(agora);
}

export function normalizarWebhook(body, agora = new Date()) {
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  const mensagens = [];
  let temStatus = false;
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      if (Array.isArray(value.statuses) && value.statuses.length > 0) temStatus = true;
      const lista = Array.isArray(value.messages) ? value.messages : [];
      for (const mensagem of lista) {
        const telefone = String(mensagem?.from ?? '');
        mensagens.push({
          telefone: digitosTelefone(telefone),
          nome: nomeDoContato(value.contacts, telefone),
          tipo: tipoDe(mensagem),
          texto: textoDe(mensagem),
          id_mensagem: String(mensagem?.id ?? ''),
          timestamp: timestampDe(mensagem, agora),
          corpo: mensagem,
        });
      }
    }
  }
  return {
    mensagens: mensagens.filter((mensagem) => mensagem.id_mensagem),
    somenteStatus: temStatus && mensagens.length === 0,
  };
}

function recusar(statusCode, erro) {
  return { statusCode, erro };
}

function resolverEvento(database, codigo) {
  if (codigo) {
    const evento = database.prepare('SELECT * FROM eventos WHERE codigo = ?').get(codigo);
    if (!evento) {
      return recusar(422, `Evento ${codigo} nao encontrado. Verifique WHATSAPP_EVENTO_CODIGO.`);
    }
    if (evento.status !== 'vendas_abertas') {
      return { respostaPronta: TEXTO_VENDAS_FECHADAS, estado: 'vendas_fechadas' };
    }
    return { evento };
  }
  const abertos = database.prepare(`
    SELECT * FROM eventos WHERE status = 'vendas_abertas' ORDER BY id
  `).all();
  if (abertos.length === 1) return { evento: abertos[0] };
  return { respostaPronta: TEXTO_SEM_EVENTO, estado: 'sem_evento' };
}

function respostaPronta(tipo) {
  if (TIPOS_ARQUIVO.has(tipo)) return { resposta: TEXTO_ARQUIVO, estado: 'midia_pendente' };
  if (TIPOS_NAO_LIDOS.has(tipo)) return { resposta: TEXTO_SO_TEXTO, estado: 'nao_suportado' };
  return null;
}

export function processarEntrada(database, entrada, { agora = new Date(), antesDeConfirmar } = {}) {
  const wamid = String(entrada.id_mensagem ?? '').trim();
  const tipo = String(entrada.tipo ?? '').trim();
  if (!wamid || !tipo) return recusar(400, 'Informe id_mensagem e tipo.');

  const resolvido = respostaPronta(tipo) ? null : resolverEvento(database, String(entrada.evento_codigo ?? '').trim());
  if (resolvido?.statusCode) return resolvido;

  return emTransacao(database, () => {
    const existente = database.prepare('SELECT wamid FROM mensagens_entrada WHERE wamid = ?').get(wamid);
    if (existente) return { duplicada: true };

    const recebidaEm = entrada.timestamp || iso(agora);
    const telefone = digitosTelefone(entrada.telefone);
    database.prepare(`
      INSERT INTO mensagens_entrada (wamid, telefone, nome, tipo, texto, recebida_em, origem)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      wamid,
      telefone,
      String(entrada.nome ?? ''),
      tipo,
      String(entrada.texto ?? ''),
      recebidaEm,
      String(entrada.origem ?? 'whatsapp'),
    );

    const pronta = respostaPronta(tipo);
    let resultado;
    if (pronta) {
      resultado = pronta;
    } else if (resolvido.respostaPronta) {
      resultado = { resposta: resolvido.respostaPronta, estado: resolvido.estado };
    } else {
      resultado = processarMensagem(database, {
        evento: resolvido.evento,
        payload: {
          telefone,
          nome: entrada.nome,
          mensagem: entrada.texto,
          origem: entrada.origem,
        },
        agora,
      });
    }

    if (antesDeConfirmar) antesDeConfirmar();

    database.prepare(`
      INSERT INTO mensagens_saida (wamid, texto, status, criada_em)
      VALUES (?, ?, 'pendente_envio', ?)
    `).run(wamid, String(resultado.resposta ?? ''), iso(agora));

    return {
      duplicada: false,
      resposta: resultado.resposta ?? '',
      estado: resultado.estado ?? '',
      pedido_id: resultado.pedido_id ?? null,
      protocolo: resultado.protocolo ?? null,
    };
  });
}
