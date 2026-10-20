import React, { useState, type FC } from "react";
import { ShieldAlert, Check, X, Loader2 } from "lucide-react";
import { obterAuthHeaders } from "../runtime/auth-headers.js";

export interface EngineApprovalArgs {
  id: string;
  acao?: string;
  descricao?: string;
  workspace?: string;
  motor?: string;
  /** Status gravado no servidor (histórico). Ausente em aprovações recém-recebidas pelo stream. */
  status?: "pendente" | "aprovado" | "rejeitado" | "expirada";
}

type Estado = "pendente" | "enviando" | "aprovado" | "rejeitado" | "expirada" | "erro";

/** Rótulo curto para o método de aprovação informado pelo motor. */
export function rotuloAcaoAprovacao(acao?: string): string {
  if (!acao) return "Ação do motor";
  if (acao.includes("commandExecution")) return "Executar comando";
  if (acao.includes("fileChange")) return "Alterar arquivos";
  if (acao.includes("permissions")) return "Permissões adicionais";
  return acao;
}

/**
 * Cartão de aprovação para solicitações HITL emitidas pelo motor
 * conversacional (evento SSE `aprovacao`). A decisão volta ao motor por
 * `POST /secretario/hitl/:id/(aprovar|rejeitar)`, escopada ao workspace.
 *
 * Único caminho de UI para aprovações do motor. `HitlApprovalToolUI`/`HitlOptionsView` são
 * outra coisa: perguntas de múltipla escolha respondidas como nova mensagem do usuário.
 */
export const EngineApprovalCard: FC<{
  args: EngineApprovalArgs;
  /** Grava a decisão no store do chat (a fonte da verdade); sem ele o card guarda só estado local. */
  onDecidido?: (id: string, status: "aprovado" | "rejeitado") => void;
}> = ({ args, onDecidido }) => {
  const [local, setEstado] = useState<Estado>("pendente");
  // Status vindo do store/histórico (decidido ou expirado) vale sobre o estado transitório local.
  const estado: Estado = args.status && args.status !== "pendente" ? args.status : local;
  const [erro, setErro] = useState<string>("");

  const decidir = async (decisao: "aprovar" | "rejeitar") => {
    setEstado("enviando");
    setErro("");
    try {
      const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4100";
      const query = args.workspace ? `?workspace=${encodeURIComponent(args.workspace)}` : "";
      const res = await fetch(
        `${origin}/secretario/hitl/${encodeURIComponent(args.id)}/${decisao}${query}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...obterAuthHeaders() },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        const corpo = await res.json().catch(() => ({}));
        throw new Error(corpo?.erro || corpo?.detail || `HTTP ${res.status}`);
      }
      const status = decisao === "aprovar" ? "aprovado" : "rejeitado";
      setEstado(status);
      onDecidido?.(args.id, status);
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setEstado("erro");
    }
  };

  const decidido = estado === "aprovado" || estado === "rejeitado" || estado === "expirada";
  const textoDecisao =
    estado === "aprovado" ? "Aprovado." : estado === "rejeitado" ? "Rejeitado." : "Expirada: a conversa seguiu sem resposta.";

  return (
    <div
      role="group"
      aria-label="Solicitação de aprovação do motor"
      className="my-3 p-3 rounded-xl bg-amber-950/20 border border-amber-900/50 text-xs shadow-md"
    >
      <div className="flex items-center gap-1.5 text-amber-300 font-semibold mb-1.5 text-[11px]">
        <ShieldAlert size={13} aria-hidden="true" />
        <span>
          {rotuloAcaoAprovacao(args.acao)}
          {args.motor ? ` · ${args.motor}` : ""}
        </span>
      </div>
      {args.descricao && (
        <pre className="font-mono text-[11px] text-zinc-200 bg-zinc-950/60 rounded-lg p-2 mb-2 whitespace-pre-wrap break-all">
          {args.descricao}
        </pre>
      )}
      {decidido ? (
        <p className="text-zinc-300" role="status">
          {textoDecisao}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={estado === "enviando"}
            onClick={() => void decidir("aprovar")}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-900/60 hover:bg-emerald-800/80 border border-emerald-700/60 text-emerald-100 disabled:opacity-50"
          >
            {estado === "enviando" ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Check size={12} aria-hidden="true" />}
            Aprovar
          </button>
          <button
            type="button"
            disabled={estado === "enviando"}
            onClick={() => void decidir("rejeitar")}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-700/60 text-zinc-200 disabled:opacity-50"
          >
            <X size={12} aria-hidden="true" />
            Rejeitar
          </button>
        </div>
      )}
      {estado === "erro" && (
        <p className="mt-2 text-red-300" role="alert">
          Não foi possível enviar a decisão: {erro}
        </p>
      )}
    </div>
  );
};
