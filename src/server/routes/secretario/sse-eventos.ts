import type { AgentEvent } from "../../../core/engines/events.js";

export function resumirFerramenta(nome: string, args: Record<string, unknown>): string {
  if (typeof args.command === "string" && args.command) return `$ ${args.command}`;
  if (Array.isArray(args.files) && args.files.length > 0) return `Alterando ${args.files.join(", ")}`;
  return nome;
}

export interface OpcoesTradutorSse {
  workspaceId: string;
  motor: string;
  /** Escreve um evento SSE (`event: <nome>`). */
  sse: (evento: string, dados: unknown) => void;
  /** Só o `GET /secretario/sessoes/:id/eventos` quer `aprovacao_resolvida`; o stream do turno não a emite. */
  incluirResolucoes?: boolean;
}

/**
 * Tradução única AgentEvent → eventos SSE do Secretário (`delta`, `acao`, `aprovacao`, `fim`, `erro`),
 * usada por `POST /secretario/conversa/stream` e por `GET /secretario/sessoes/:id/eventos`.
 * `resumoLog` é o resumo já gravado no log (o replay não vê o `arguments` original de forma diferente, mas o log manda).
 */
export function criarTradutorSse(opcoes: OpcoesTradutorSse): (ev: AgentEvent, resumoLog?: string) => void {
  const { workspaceId, motor, sse, incluirResolucoes } = opcoes;
  let fullOutput = "";
  const resumosFerramentas = new Map<string, string>();

  return (ev, resumoLog) => {
    if (ev.type === "message.delta") {
      fullOutput += ev.text;
      sse("delta", { delta: ev.text });
    } else if (ev.type === "tool.requested") {
      const resumo = resumoLog ?? resumirFerramenta(ev.call.name, ev.call.arguments);
      resumosFerramentas.set(ev.call.id, resumo);
      sse("acao", { itens: [{ ferramenta: ev.call.name, resumo, status: "running" }] });
    } else if (ev.type === "tool.completed") {
      const resumo = resumosFerramentas.get(ev.result.id) ?? ev.result.name;
      sse("acao", {
        itens: [{
          ferramenta: ev.result.name,
          resumo,
          status: ev.result.isError ? "failed" : "completed",
          sucesso: !ev.result.isError,
        }],
      });
    } else if (ev.type === "approval.requested") {
      sse("aprovacao", {
        id: ev.approval.id,
        acao: ev.approval.action,
        descricao: ev.approval.description,
        workspace: workspaceId,
        motor,
      });
    } else if (ev.type === "approval.resolved" && incluirResolucoes) {
      sse("aprovacao_resolvida", {
        id: ev.approvalId,
        status: ev.decision === "approved" ? "aprovado" : ev.decision === "rejected" ? "rejeitado" : "expirada",
      });
    } else if (ev.type === "run.completed") {
      sse("fim", {
        content: fullOutput || ev.result.output,
        resposta: fullOutput || ev.result.output,
        stopReason: ev.result.stopReason,
      });
    } else if (ev.type === "run.failed") {
      sse("erro", { erro: ev.error.message });
    }
  };
}
