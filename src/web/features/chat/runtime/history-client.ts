import type { ThreadMessageLike } from "@assistant-ui/react";
import { obterAuthHeaders, originAtual } from "./auth-headers.js";
import { converterMensagensBackend } from "./message-converter.js";

/** Sessões ainda não promovidas pelo servidor (rascunho local) não têm histórico. */
export function sessaoTemHistorico(sessaoId?: string): sessaoId is string {
  const sid = sessaoId?.trim();
  return !!sid && !sid.startsWith("sessao-") && !sid.startsWith("draft-");
}

/**
 * Busca o histórico da sessão (mensagens + status das aprovações) no servidor.
 * Devolve null em erro de rede/HTTP para o chamador manter o que já tem.
 */
export async function buscarHistorico(
  sessaoId: string,
  workspaceId?: string,
  headersExtras: Record<string, string> = {},
): Promise<ThreadMessageLike[] | null> {
  try {
    const res = await fetch(`${originAtual()}/secretario/sessoes/${encodeURIComponent(sessaoId)}/mensagens`, {
      headers: {
        "Content-Type": "application/json",
        ...obterAuthHeaders(),
        ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        ...headersExtras,
      },
    });
    if (!res.ok) return null;
    return converterMensagensBackend(await res.json(), sessaoId);
  } catch {
    return null;
  }
}

export interface HistoricoComMeta {
  mensagens: ThreadMessageLike[];
  /** Mensagens como o servidor devolveu (campos `content`/`pensamento`/`acoes`/`aprovacoes`). */
  brutas: any[];
  /** `x-oc-log-entradas`: ponto de partida (`desde`) da reassinatura. Ausente em servidor antigo. */
  logEntradas?: number;
  /** `x-oc-em-execucao: 1`: há turno vivo no servidor. Ausente/0 = comportamento atual. */
  emExecucao: boolean;
}

/** Como `buscarHistorico`, mas também devolve os cabeçalhos do CONTRATO REATTACH. */
export async function buscarHistoricoComMeta(
  sessaoId: string,
  workspaceId?: string,
  headersExtras: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<HistoricoComMeta | null> {
  try {
    const res = await fetch(`${originAtual()}/secretario/sessoes/${encodeURIComponent(sessaoId)}/mensagens`, {
      signal,
      headers: {
        "Content-Type": "application/json",
        ...obterAuthHeaders(),
        ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        ...headersExtras,
      },
    });
    if (!res.ok) return null;
    const brutas = await res.json();
    const bruto = res.headers.get("x-oc-log-entradas");
    const n = Number(bruto);
    return {
      mensagens: converterMensagensBackend(brutas, sessaoId),
      brutas: Array.isArray(brutas) ? brutas : [],
      logEntradas: bruto !== null && Number.isInteger(n) && n >= 0 ? n : undefined,
      emExecucao: res.headers.get("x-oc-em-execucao") === "1",
    };
  } catch {
    return null;
  }
}
