import React, { useState, useEffect, type FC } from "react";
import {
  X,
  MessageSquare,
  Activity,
  Terminal,
  GitBranch,
  Workflow,
  CheckCircle2,
  StopCircle,
  RotateCcw,
  Play,
  Bot,
  Clock,
  ExternalLink,
} from "lucide-react";
import type { ItemHistorico, AcaoAgente, ArquivoDiff } from "../types.js";
import { HistoryChatTab } from "./tabs/HistoryChatTab.js";
import { HistoryTelemetryTab } from "./tabs/HistoryTelemetryTab.js";
import { HistoryTerminalTab } from "./tabs/HistoryTerminalTab.js";
import { HistoryDiffTab } from "./tabs/HistoryDiffTab.js";
import { HistoryFlowTab } from "./tabs/HistoryFlowTab.js";
import { HistoryResultTab } from "./tabs/HistoryResultTab.js";

export type ModoAbaHistorico = "chat" | "telemetria" | "terminal" | "diff" | "fluxo" | "resultado";

export interface HistoryInspectionDrawerProps {
  item: ItemHistorico | null;
  log: string;
  acoes: AcaoAgente[];
  diff: string;
  arquivosDiff: ArquivoDiff[];
  commitHashDiff: string | null;
  carregandoDetalhes: boolean;
  carregandoAcoes: boolean;
  carregandoDiff: boolean;
  onClose: () => void;
  onAbortar?: (id: string) => Promise<void>;
  onRerun?: (id: string) => Promise<void>;
  onResume?: (flowId: string) => Promise<void>;
  onRestaurarArquivo: (caminho: string) => Promise<void>;
  onSelecionarSubExecucao?: (execId: string) => void;
}

/**
 * Resposta final de uma execução de agente: o último bloco de texto do log,
 * sem cabeçalhos (#), comandos ($) nem marcadores de ferramenta (→/←).
 */
export function respostaFinalDoLog(log?: string): string | undefined {
  if (!log) return undefined;
  const linhas = log.split("\n");
  const bloco: string[] = [];
  for (let i = linhas.length - 1; i >= 0; i--) {
    const l = linhas[i]!.trim();
    if (!l) {
      if (bloco.length) break;
      continue;
    }
    if (/^(#|\$|→|←)/.test(l)) break;
    bloco.unshift(linhas[i]!);
  }
  const texto = bloco.join("\n").trim();
  return texto || undefined;
}

export const HistoryInspectionDrawer: FC<HistoryInspectionDrawerProps> = ({
  item,
  log,
  acoes,
  diff,
  arquivosDiff,
  commitHashDiff,
  carregandoDetalhes,
  carregandoAcoes,
  carregandoDiff,
  onClose,
  onAbortar,
  onRerun,
  onResume,
  onRestaurarArquivo,
  onSelecionarSubExecucao,
}) => {
  const [abaAtiva, setAbaAtiva] = useState<ModoAbaHistorico>("chat");

  // Esc fecha o painel (acessibilidade de teclado).
  useEffect(() => {
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onClose]);
  const [executandoAcao, setExecutandoAcao] = useState(false);

  // Define a aba inicial com base no tipo de item
  useEffect(() => {
    if (item?.tipo === "fluxo") {
      setAbaAtiva("fluxo");
    } else {
      setAbaAtiva("chat");
    }
  }, [item?.id, item?.tipo]);

  if (!item) return null;

  const isExecutando = item.status === "executando";
  const isFalhou = item.status === "falhou" || item.status === "erro";
  const isFluxo = item.tipo === "fluxo";

  const abas: Array<{ id: ModoAbaHistorico; label: string; icon: any; count?: number }> = [
    { id: "chat", label: "Chat", icon: MessageSquare },
    { id: "telemetria", label: "Telemetria", icon: Activity, count: acoes.length || undefined },
    { id: "terminal", label: "Terminal", icon: Terminal },
    { id: "diff", label: "Diff / Git", icon: GitBranch, count: arquivosDiff.length || undefined },
    {
      id: "fluxo",
      label: "Grafo DAG",
      icon: Workflow,
      count: (item.filhas?.length || (Array.isArray(item.nos) ? item.nos.length : undefined)) || undefined,
    },
    { id: "resultado", label: "Resultado", icon: CheckCircle2 },
  ];

  return (
    <>
      {/* Overlay escuro em mobile */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs z-40 lg:hidden"
        onClick={onClose}
      />

      {/* Drawer Lateral */}
      <aside className="fixed lg:absolute top-0 right-0 bottom-0 w-full sm:w-[580px] md:w-[620px] max-w-full z-50 bg-zinc-950/95 backdrop-blur-md border-l border-zinc-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Topo do Drawer */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-zinc-900/60">
          <div className="flex items-center gap-3 min-w-0">
            <div className="p-2 rounded-xl bg-zinc-850 border border-zinc-750 text-orange-400 shrink-0">
              {isFluxo ? <Workflow size={18} /> : <Bot size={18} />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-xs sm:text-sm font-bold text-zinc-100 font-mono truncate">
                  {item.id}
                </h3>
                <span
                  className={`px-1.5 py-0.2 rounded font-mono text-[9px] font-bold uppercase ${
                    isExecutando
                      ? "bg-amber-950/60 text-amber-400 border border-amber-800 animate-pulse"
                      : isFalhou
                      ? "bg-rose-950/60 text-rose-400 border border-rose-800"
                      : "bg-emerald-950/60 text-emerald-400 border border-emerald-800"
                  }`}
                >
                  {item.status || "ok"}
                </span>
              </div>
              <p className="text-[11px] text-zinc-400 font-mono truncate mt-0.5">
                {item.agente ? `@${item.agente}` : item.tipo} {item.modelo ? `· ${item.modelo}` : ""}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            {/* Botão de Abortar / Stop */}
            {isExecutando && onAbortar && (
              <button
                type="button"
                disabled={executandoAcao}
                onClick={async () => {
                  setExecutandoAcao(true);
                  try {
                    await onAbortar(item.id);
                  } finally {
                    setExecutandoAcao(false);
                  }
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 border border-rose-500/40 text-xs font-semibold transition-colors cursor-pointer"
                title="Encerrar execução em andamento"
              >
                <StopCircle size={13} />
                <span>Encerrar</span>
              </button>
            )}

            {/* Botão de Reenviar / Rerun */}
            {!isExecutando && onRerun && (
              <button
                type="button"
                disabled={executandoAcao}
                onClick={async () => {
                  setExecutandoAcao(true);
                  try {
                    await onRerun(item.id);
                  } finally {
                    setExecutandoAcao(false);
                  }
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-200 border border-zinc-750 text-xs font-semibold transition-colors cursor-pointer"
                title="Re-executar com mesmos parâmetros"
              >
                <RotateCcw size={12} />
                <span>Reenviar</span>
              </button>
            )}

            {/* Botão de Retomar / Resume */}
            {isFalhou && isFluxo && onResume && (
              <button
                type="button"
                disabled={executandoAcao}
                onClick={async () => {
                  setExecutandoAcao(true);
                  try {
                    await onResume(item.flow || item.id);
                  } finally {
                    setExecutandoAcao(false);
                  }
                }}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-600/20 hover:bg-amber-600/30 text-amber-400 border border-amber-500/40 text-xs font-semibold transition-colors cursor-pointer"
                title="Retomar DAG a partir do nó que falhou"
              >
                <Play size={12} />
                <span>Retomar</span>
              </button>
            )}

            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
              title="Fechar Gaveta"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Barra de Abas Analíticas */}
        <div className="flex gap-1 px-3 py-2 border-b border-zinc-800 bg-zinc-950 overflow-x-auto shrink-0 scrollbar-none">
          {abas.map((aba) => (
            <button
              key={aba.id}
              type="button"
              onClick={() => setAbaAtiva(aba.id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                abaAtiva === aba.id
                  ? "bg-zinc-800 text-orange-400 font-bold border border-zinc-700 shadow-xs"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850/60"
              }`}
            >
              <aba.icon size={13} />
              <span>{aba.label}</span>
              {aba.count !== undefined && (
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-zinc-900 border border-zinc-800 text-zinc-400">
                  {aba.count}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Conteúdo da Aba Ativa */}
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-zinc-950">
          {abaAtiva === "chat" && (
            <HistoryChatTab
              log={log}
              ordem={item.ordem}
              agente={item.agente}
              modelo={item.modelo}
              status={item.status}
            />
          )}

          {abaAtiva === "telemetria" && (
            <HistoryTelemetryTab
              acoes={acoes}
              carregando={carregandoAcoes}
              duracaoTotalMs={item.duracao_ms}
              custoTotalUsd={item.custo_usd}
            />
          )}

          {abaAtiva === "terminal" && (
            <HistoryTerminalTab log={log} execId={item.id} />
          )}

          {abaAtiva === "diff" && (
            <HistoryDiffTab
              diff={diff}
              arquivos={arquivosDiff}
              commitHash={commitHashDiff}
              carregando={carregandoDiff}
              onRestaurarArquivo={onRestaurarArquivo}
            />
          )}

          {abaAtiva === "fluxo" && (
            <HistoryFlowTab
              filhas={item.filhas || (Array.isArray(item.nos) ? (item.nos as any[]) : [])}
              flowId={item.flow || item.id}
              onSelecionarExecucao={onSelecionarSubExecucao}
            />
          )}

          {abaAtiva === "resultado" && (
            <HistoryResultTab
              contextoFinal={item.contexto_final}
              resultado={item.contexto_final ? undefined : respostaFinalDoLog(log)}
              status={item.status}
            />
          )}
        </div>
      </aside>
    </>
  );
};
