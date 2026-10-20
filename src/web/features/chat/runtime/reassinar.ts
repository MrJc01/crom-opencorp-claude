import type { SecretaryRuntimeOptions } from "../types.js";
import { obterAuthHeaders, originAtual } from "./auth-headers.js";
import { lerEventosSse } from "./sse-consumidor.js";
import { aplicarEventoSse, criarEstadoTurno, type EstadoTurno } from "./sse-reducer.js";

/**
 * Reassinatura de um turno vivo (CONTRATO REATTACH): depois de hidratar o histórico, se o
 * servidor responde `x-oc-em-execucao: 1`, o front abre `GET /secretario/sessoes/:id/eventos`
 * e alimenta o mesmo pipeline do stream normal (`lerEventosSse` + `aplicarEventoSse`).
 */

/** Estado do turno semeado a partir da mensagem do assistente que o histórico já tem (formato do servidor). */
export function estadoDaMensagemBackend(m?: any): EstadoTurno {
  const estado = criarEstadoTurno();
  if (!m || m.role === "user") return estado;
  estado.texto = typeof m.content === "string" ? m.content : "";
  estado.pensamento = typeof m.pensamento === "string" ? m.pensamento : "";
  if (Array.isArray(m.acoes)) {
    estado.acoes = m.acoes.map((a: any) => ({
      ferramenta: a.ferramenta || a.tool || "ferramenta",
      resumo: a.resumo || "",
      sucesso: a.sucesso !== false,
      status: a.status,
    }));
  }
  if (Array.isArray(m.aprovacoes)) estado.aprovacoes = m.aprovacoes.map((a: any) => ({ ...a }));
  return estado;
}

export interface ReassinaturaTurno {
  sessaoId: string;
  opcoes: SecretaryRuntimeOptions;
  /** Índice do log (`x-oc-log-entradas`) a partir do qual o servidor reenvia. */
  desde: number;
  /** Fábrica do estado inicial: cada tentativa recomeça dele para a repetição não duplicar texto. */
  estadoInicial: () => EstadoTurno;
  signal: AbortSignal;
  /** Chamado a cada novo estado (útil para o chamador manter uma referência ao estado vivo). */
  aoEstado?: (estado: EstadoTurno) => void;
}

function urlEventos(r: ReassinaturaTurno): string {
  const q = new URLSearchParams({ workspace: r.opcoes.workspaceId || "default", desde: String(r.desde) });
  return `${originAtual()}/secretario/sessoes/${encodeURIComponent(r.sessaoId)}/eventos?${q.toString()}`;
}

/**
 * Emite o estado acumulado do turno reassinado. Termina em `fim`/`erro`/`inativo` ou quando o
 * servidor fecha o stream. Uma única repetição em erro de rede (recomeçando do mesmo `desde`
 * e do estado inicial, para não duplicar); sem loop. `signal` abortado encerra sem emitir.
 */
export async function* reassinarTurno(r: ReassinaturaTurno): AsyncGenerator<EstadoTurno> {
  const wsId = r.opcoes.workspaceId || "default";
  const headers = { Accept: "text/event-stream", ...obterAuthHeaders(), ...(r.opcoes.headers ?? {}) };

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const estado = r.estadoInicial();
    try {
      const resp = await fetch(urlEventos(r), { headers, signal: r.signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      for await (const { evento, dados } of lerEventosSse(resp, r.signal)) {
        const { terminou } = aplicarEventoSse(estado, evento, dados ?? {}, wsId);
        r.aoEstado?.(estado);
        yield estado;
        if (terminou) return;
      }
      return;
    } catch {
      if (r.signal.aborted) return;
      // Segunda falha: desiste em silêncio; o chamador recarrega o histórico do servidor.
    }
  }
}
