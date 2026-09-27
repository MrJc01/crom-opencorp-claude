import React, { useCallback, useEffect, useState, type FC } from "react";
import { Check, ShieldAlert, X } from "lucide-react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";

interface Pendencia {
  id: string;
  ordem: string;
  agente: string;
  padrao: string;
  motivo_guard: string;
  status: string;
  criado_em: string;
}

/**
 * Aprovações humanas (HITL) pendentes do workspace, com Aprovar/Rejeitar.
 * Sem este cartão, ordens bloqueadas pelo SecurityGuard só podiam ser
 * resolvidas pela CLI/API.
 */
export const PendingApprovalsCard: FC = () => {
  const { client, tratarErro } = useOpenCorp();
  const [pendencias, setPendencias] = useState<Pendencia[]>([]);
  const [resolvendo, setResolvendo] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    try {
      const lista = await client.http.get<Pendencia[]>("/approvals");
      setPendencias(Array.isArray(lista) ? lista.filter((p) => p.status === "pendente") : []);
    } catch {
      // sem permissão ou servidor indisponível: o cartão simplesmente não aparece
    }
  }, [client]);

  useEffect(() => {
    void carregar();
    const t = setInterval(() => void carregar(), 10_000);
    return () => clearInterval(t);
  }, [carregar]);

  const resolver = async (id: string, acao: "approve" | "reject") => {
    setResolvendo(id);
    try {
      await client.http.post(`/approvals/${encodeURIComponent(id)}/${acao}`, {});
      showToast(acao === "approve" ? "Ordem aprovada." : "Ordem rejeitada.", "sucesso");
      await carregar();
    } catch (err) {
      tratarErro(err, "Falha ao resolver aprovação");
    } finally {
      setResolvendo(null);
    }
  };

  if (pendencias.length === 0) return null;

  return (
    <section
      aria-labelledby="aprovacoes-pendentes-titulo"
      className="rounded-2xl border border-amber-800/50 bg-amber-950/20 p-4 space-y-3"
      data-testid="aprovacoes-pendentes"
    >
      <h2 id="aprovacoes-pendentes-titulo" className="flex items-center gap-2 text-sm font-bold text-amber-200">
        <ShieldAlert size={16} aria-hidden="true" />
        {pendencias.length} aprovação(ões) humana(s) pendente(s)
      </h2>
      <ul className="space-y-2">
        {pendencias.map((p) => (
          <li key={p.id} className="flex flex-col gap-2 rounded-xl border border-amber-900/40 bg-zinc-950/60 p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-xs">
              <p className="font-mono text-zinc-100 break-all">{p.ordem}</p>
              <p className="text-zinc-400">
                @{p.agente} · {p.motivo_guard || p.padrao}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                type="button"
                disabled={resolvendo === p.id}
                onClick={() => void resolver(p.id, "approve")}
                className="flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
              >
                <Check size={13} aria-hidden="true" /> Aprovar
              </button>
              <button
                type="button"
                disabled={resolvendo === p.id}
                onClick={() => void resolver(p.id, "reject")}
                className="flex items-center gap-1 rounded-lg border border-rose-800 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-950/50 disabled:opacity-50"
              >
                <X size={13} aria-hidden="true" /> Rejeitar
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
};
