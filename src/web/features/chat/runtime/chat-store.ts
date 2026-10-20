import type { ThreadMessageLike } from "@assistant-ui/react";
import type { StatusAprovacao } from "./message-converter.js";

/**
 * Operações puras sobre a lista de mensagens do store do chat. Cada função devolve
 * uma nova lista e preserva a identidade das mensagens que não mudaram (o
 * Assistant UI usa isso para não reconverter/renderizar a thread inteira).
 */

export function criarMensagemUsuario(id: string, texto: string): ThreadMessageLike {
  return { id, role: "user", content: [{ type: "text", text: texto }], createdAt: new Date() };
}

export function criarMensagemAssistente(id: string): ThreadMessageLike {
  return { id, role: "assistant", content: [], createdAt: new Date(), status: { type: "running" } };
}

export function atualizarMensagem(
  msgs: readonly ThreadMessageLike[],
  id: string,
  mudanca: Partial<ThreadMessageLike>,
): ThreadMessageLike[] {
  return msgs.map((m) => (m.id === id ? ({ ...m, ...mudanca } as ThreadMessageLike) : m));
}

/** Define o status de uma aprovação do motor (parte `aprovacao_<id>`) em qualquer mensagem. */
export function marcarAprovacao(
  msgs: readonly ThreadMessageLike[],
  aprovacaoId: string,
  status: StatusAprovacao,
): ThreadMessageLike[] {
  const alvo = `aprovacao_${aprovacaoId}`;
  return msgs.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    let mudou = false;
    const content = (m.content as any[]).map((p) => {
      if (p?.type !== "tool-call" || p.toolCallId !== alvo || p.args?.status === status) return p;
      mudou = true;
      return { ...p, args: { ...p.args, status } };
    });
    return mudou ? ({ ...m, content } as ThreadMessageLike) : m;
  });
}

function tamanhoTexto(m?: ThreadMessageLike): number {
  if (!m || !Array.isArray(m.content)) return typeof m?.content === "string" ? m.content.length : 0;
  return (m.content as any[]).reduce((n, p) => n + (typeof p?.text === "string" ? p.text.length : 0), 0);
}

function ultimoAssistente(msgs: readonly ThreadMessageLike[]): ThreadMessageLike | undefined {
  return [...msgs].reverse().find((m) => m.role === "assistant");
}

/**
 * Decide se o histórico recarregado do servidor substitui o estado local: só quando
 * não há turno em curso, o servidor não tem menos mensagens (log incompleto) e a última
 * resposta dele não está mais curta que a local (motor que ainda não persistiu o texto).
 */
export function podeSubstituirPeloServidor(
  locais: readonly ThreadMessageLike[],
  servidor: readonly ThreadMessageLike[],
  emExecucao: boolean,
): boolean {
  if (emExecucao || servidor.length === 0 || servidor.length < locais.length) return false;
  return tamanhoTexto(ultimoAssistente(servidor)) >= tamanhoTexto(ultimoAssistente(locais));
}
