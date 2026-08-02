/**
 * AGENTE FINANCEIRO — função serverless da Vercel
 * ===============================================
 * O navegador manda: { texto, contexto }.
 * Esta função conversa com o Gemini e devolve UMA ação proposta
 * ou uma resposta em texto. Ela NUNCA grava nada — quem grava é o
 * navegador, depois que você confirma, usando o seu PIN.
 *
 * A chave da API fica aqui, no servidor, na variável de ambiente
 * GEMINI_API_KEY. Nunca no código que vai para o navegador.
 */

const MODELO = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const ENDPOINT = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const FERRAMENTAS = [{
  function_declarations: [
    {
      name: 'lancar',
      description: 'Registra um gasto ou uma entrada de dinheiro que JÁ aconteceu.',
      parameters: {
        type: 'object',
        properties: {
          valor: { type: 'number', description: 'Valor em reais, sempre positivo.' },
          tipo: { type: 'string', enum: ['saida', 'entrada'] },
          categoria: { type: 'string', description: 'Precisa ser exatamente uma das categorias existentes.' },
          conta: { type: 'string', description: 'O id da conta, ex.: BB, NU, MP, IFOOD.' },
          descricao: { type: 'string', description: 'Descrição curta, ex.: "almoço", "uber".' }
        },
        required: ['valor', 'tipo', 'categoria', 'conta']
      }
    },
    {
      name: 'quitar',
      description: 'Marca como paga uma conta que estava prevista no mês.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'O id exato da conta prevista, vindo do contexto.' }
        },
        required: ['id']
      }
    },
    {
      name: 'atualizar',
      description: 'Corrige um dado da base: saldo ou juros de uma dívida, cota de uma categoria, ' +
                   'alvo ou valor atual de uma meta, saldo de uma conta, piso de um filtro, habilidade em foco.',
      parameters: {
        type: 'object',
        properties: {
          aba: { type: 'string', enum: ['dividas','categorias','metas','contas','filtros','habilidades'] },
          chave_valor: { type: 'string', description: 'Nome ou id da linha, exatamente como está no contexto.' },
          campos: { type: 'string', description: 'JSON com as colunas a mudar. Ex.: {"taxa_juros_mensal":9.5}' }
        },
        required: ['aba', 'chave_valor', 'campos']
      }
    },
    {
      name: 'responder',
      description: 'Responde uma pergunta sobre os números, sem alterar nada.',
      parameters: {
        type: 'object',
        properties: { texto: { type: 'string' } },
        required: ['texto']
      }
    }
  ]
}];

const INSTRUCAO = `Você é o assistente financeiro da Central do Arquiteto Soberano, de Marco.
Tom: grave, calmo, direto, sem floreio de autoajuda. Português do Brasil. Valores em reais.

REGRAS INEGOCIÁVEIS
- Sempre chame exatamente UMA ferramenta. Nunca responda em texto solto.
- Nunca invente valor, categoria, conta ou id. Use só o que está no CONTEXTO.
- Se a categoria dita não existir, escolha a mais próxima entre as existentes e diga isso na explicação.
- Se faltar informação essencial (valor, ou conta quando houver mais de uma plausível), use "responder"
  para perguntar exatamente o que falta, em uma frase.
- "Paguei o aluguel" e afins = quitar, usando o id da conta prevista no contexto. Só use "lancar"
  se não existir conta prevista correspondente.
- Gasto com o vale/benefício iFood vai na conta IFOOD. Gasto normal vai na conta do dia a dia,
  a não ser que Marco diga outra.
- Ao responder perguntas, seja curto e cite o número. Não dê conselho de investimento.
- Números com vírgula decimal no português falado: "quarenta e cinco e cinquenta" = 45.50.`;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ erro: 'use POST' });

  const chave = process.env.GEMINI_API_KEY;
  if (!chave) {
    return res.status(500).json({
      erro: 'GEMINI_API_KEY não configurada na Vercel. Settings → Environment Variables.'
    });
  }

  let corpo = req.body;
  if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch { corpo = {}; } }
  const texto = (corpo && corpo.texto || '').trim();
  const contexto = (corpo && corpo.contexto) || {};
  if (!texto) return res.status(400).json({ erro: 'texto vazio' });

  const prompt = `CONTEXTO DE HOJE (${contexto.hoje || ''}):\n` +
    JSON.stringify(contexto, null, 0) +
    `\n\nMARCO DISSE: "${texto}"`;

  try {
    const r = await fetch(ENDPOINT(MODELO), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: INSTRUCAO }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: FERRAMENTAS,
        generationConfig: { temperature: 0 }
      })
    });

    const dado = await r.json();
    if (!r.ok) {
      const msg = (dado && dado.error && dado.error.message) || ('HTTP ' + r.status);
      return res.status(502).json({ erro: 'Gemini: ' + msg });
    }

    const partes = (dado.candidates && dado.candidates[0] &&
                    dado.candidates[0].content && dado.candidates[0].content.parts) || [];
    const chamada = partes.find(p => p.functionCall);

    if (!chamada) {
      const txt = partes.map(p => p.text).filter(Boolean).join(' ').trim();
      return res.status(200).json({ acao: 'responder', args: { texto: txt || 'Não entendi. Repete?' } });
    }
    return res.status(200).json({
      acao: chamada.functionCall.name,
      args: chamada.functionCall.args || {}
    });
  } catch (e) {
    return res.status(500).json({ erro: 'falha ao falar com o Gemini: ' + e.message });
  }
};
