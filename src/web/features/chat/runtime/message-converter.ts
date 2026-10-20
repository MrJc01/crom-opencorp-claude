import type { ThreadMessageLike } from "@assistant-ui/react";

export type StatusAprovacao = "pendente" | "aprovado" | "rejeitado" | "expirada";

export interface AprovacaoMotor {
  id: string;
  acao?: string;
  descricao?: string;
  workspace?: string;
  motor?: string;
  status?: StatusAprovacao;
}

export interface AcaoMensagem {
  ferramenta: string;
  resumo: string;
  sucesso: boolean;
  status?: string;
  pergunta?: string;
  opcoes?: string[];
  perguntas?: Array<{ header?: string; pergunta: string; opcoes: string[] }>;
}

/**
 * Converte mensagens retornadas da API /secretario/sessoes/:id/mensagens
 * para o formato ThreadMessageLike do @assistant-ui/react.
 */
export function converterMensagensBackend(
  mensagens: any[],
  sessaoId: string,
): ThreadMessageLike[] {
  if (!Array.isArray(mensagens)) return [];

  return mensagens.map((m: any, idx: number) => {
    if (m.role === "user") {
      return {
        id: m.id || `user_${sessaoId}_${idx}`,
        role: "user",
        content: [{ type: "text", text: m.content || "" }],
        createdAt: m.criado_em ? new Date(m.criado_em) : new Date(),
      };
    }

    // Ações com pergunta (ask_question) guardam as opções em `passos`.
    const acoes: any[] = Array.isArray(m.acoes) ? m.acoes.map((a: any) => ({ ...a })) : [];
    for (const passo of Array.isArray(m.passos) ? m.passos : []) {
      if (passo?.tipo !== "acao" || !(passo.pergunta || passo.opcoes || passo.perguntas)) continue;
      const extra = { pergunta: passo.pergunta, opcoes: passo.opcoes, perguntas: passo.perguntas };
      const alvo = acoes.find((a) => (a.ferramenta || a.tool) === passo.ferramenta && a.resumo === passo.resumo);
      if (alvo) Object.assign(alvo, extra);
      else acoes.push({ ferramenta: passo.ferramenta, resumo: passo.resumo || "", sucesso: passo.sucesso !== false, status: passo.status, ...extra });
    }
    const partes = buildAssistantParts(
      m.pensamento || "",
      acoes,
      m.content || "",
      Array.isArray(m.aprovacoes) ? m.aprovacoes : [],
    );

    return {
      id: m.id || `asst_${sessaoId}_${idx}`,
      role: "assistant",
      content: partes,
      createdAt: m.criado_em ? new Date(m.criado_em) : new Date(),
    };
  });
}

/**
 * Constrói ordenadamente as partes internas da mensagem do assistente:
 * 1. Raciocínio (reasoning / think block)
 * 2. Chamadas de ferramentas (tool-calls)
 * 3. Texto visível (text response)
 */
export function buildAssistantParts(
  pensamento: string,
  ferramentas: AcaoMensagem[],
  texto: string,
  aprovacoes: AprovacaoMotor[] = [],
): any[] {
  const partes: any[] = [];

  if (pensamento && pensamento.trim().length > 0) {
    partes.push({
      type: "reasoning",
      text: pensamento,
    });
  }

  if (ferramentas && ferramentas.length > 0) {
    for (let i = 0; i < ferramentas.length; i++) {
      const item = ferramentas[i];
      partes.push({
        type: "tool-call",
        toolName: item.ferramenta || "ferramenta",
        toolCallId: `tool_${i}_${item.ferramenta}`,
        args: {
          resumo: item.resumo || "Executando inspeção de workspace...",
          statusOperacional: item.status || "completed",
          // Ferramentas de pergunta (ask_question/question) levam o conteúdo para o card.
          ...(item.perguntas?.length
            ? { questions: item.perguntas.map((q) => ({ header: q.header, question: q.pergunta, options: q.opcoes })) }
            : item.pergunta || item.opcoes?.length
              ? { question: item.pergunta, options: item.opcoes ?? [] }
              : {}),
        },
        result: item.resumo || "Concluído",
        isError: item.sucesso === false,
      });
    }
  }

  for (const aprovacao of aprovacoes) {
    partes.push({
      type: "tool-call",
      toolName: "aprovacao_motor",
      toolCallId: `aprovacao_${aprovacao.id}`,
      args: aprovacao,
    });
  }

  if (texto && texto.length > 0) {
    partes.push({
      type: "text",
      text: texto,
    });
  }

  return partes;
}
