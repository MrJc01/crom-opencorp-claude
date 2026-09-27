import React, { useState, type FC } from "react";
import {
  ArrowLeft,
  Workflow,
  Plus,
  Play,
  Save,
  History,
  Download,
  Trash2,
  Check,
  Edit2,
  Power,
  RotateCcw,
} from "lucide-react";
import type { FluxoCompleto } from "../types.js";

export interface WorkflowHeaderProps {
  fluxo: FluxoCompleto | null;
  logsCount: number;
  painelLogsAberto: boolean;
  salvando: boolean;
  executando: boolean;
  onVoltar: () => void;
  onAbrirPaleta: () => void;
  onToggleLogs: () => void;
  onSalvarGrafo: () => void;
  onExecutar: () => void;
  onToggleAtivo: (ativo: boolean) => void;
  onRenomearFluxo: (novoNome: string) => void;
  onExportarJson: () => void;
  onExcluirFluxo: () => void;
  onResetLayout?: () => void;
}

export const WorkflowHeader: FC<WorkflowHeaderProps> = ({
  fluxo,
  logsCount,
  painelLogsAberto,
  salvando,
  executando,
  onVoltar,
  onAbrirPaleta,
  onToggleLogs,
  onSalvarGrafo,
  onExecutar,
  onToggleAtivo,
  onRenomearFluxo,
  onExportarJson,
  onExcluirFluxo,
  onResetLayout,
}) => {
  const [editandoNome, setEditandoNome] = useState(false);
  const [nomeTemp, setNomeTemp] = useState(fluxo?.nome || fluxo?.id || "");

  if (!fluxo) return null;

  const handleSalvarNome = () => {
    if (nomeTemp.trim()) {
      onRenomearFluxo(nomeTemp.trim());
    }
    setEditandoNome(false);
  };

  return (
    <header className="min-h-14 h-auto py-2 border-b border-zinc-800 bg-zinc-950/90 backdrop-blur-md px-3 sm:px-4 flex flex-wrap items-center justify-between gap-3 z-30 shrink-0">
      {/* Lado Esquerdo: Voltar + Identificação do Fluxo */}
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <button
          type="button"
          onClick={onVoltar}
          id="btn-voltar-fluxos"
          aria-label="Voltar para Lista de Fluxos"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 hover:border-zinc-700 text-xs text-zinc-300 hover:text-white transition-colors cursor-pointer shrink-0"
          title="Voltar para Lista de Fluxos"
        >
          <ArrowLeft size={14} className="text-orange-400" />
          <span className="font-medium hidden sm:inline">Fluxos</span>
        </button>

        <div className="h-4 w-px bg-zinc-800 shrink-0" />

        <div className="flex items-center gap-2 min-w-0">
          <div className="p-1.5 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 shrink-0">
            <Workflow size={16} />
          </div>

          {editandoNome ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={nomeTemp}
                onChange={(e) => setNomeTemp(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSalvarNome();
                  if (e.key === "Escape") setEditandoNome(false);
                }}
                className="bg-zinc-900 border border-orange-500/60 rounded px-2 py-0.5 text-xs text-zinc-100 font-semibold focus:outline-none"
                autoFocus
              />
              <button
                type="button"
                onClick={handleSalvarNome}
                className="p-1 rounded text-emerald-400 hover:bg-zinc-850"
              >
                <Check size={14} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 min-w-0 group">
              <span
                className="font-bold text-xs sm:text-sm text-zinc-100 truncate max-w-[140px] sm:max-w-[240px] md:max-w-[360px]"
                title={fluxo.nome || fluxo.id}
              >
                {fluxo.nome || fluxo.id}
              </span>
              <button
                type="button"
                onClick={() => {
                  setNomeTemp(fluxo.nome || fluxo.id);
                  setEditandoNome(true);
                }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-zinc-400 hover:text-zinc-200 transition-opacity cursor-pointer"
                title="Editar nome do fluxo"
              >
                <Edit2 size={12} />
              </button>
            </div>
          )}

          <span className="hidden md:inline font-mono text-[10px] text-zinc-500 px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-850 truncate max-w-[140px]">
            {fluxo.id}
          </span>
        </div>
      </div>

      {/* Lado Direito: Ações Operacionais */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        {/* Adicionar Nó */}
        <button
          type="button"
          onClick={onAbrirPaleta}
          className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 hover:border-orange-500/50 text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
          title="Abrir paleta de nós"
        >
          <Plus size={14} className="text-orange-400" />
          <span className="hidden sm:inline">Adicionar Nó</span>
        </button>

        {/* Toggle Ativo/Inativo */}
        <button
          type="button"
          onClick={() => onToggleAtivo(!(fluxo.ativo ?? true))}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
            fluxo.ativo ?? true
              ? "bg-emerald-950/30 border-emerald-800 text-emerald-400 hover:bg-emerald-950/50"
              : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:bg-zinc-850"
          }`}
          title="Ativar/Desativar disparo de gatilhos"
        >
          <Power size={13} className={fluxo.ativo ?? true ? "text-emerald-400" : "text-zinc-500"} />
          <span className="hidden md:inline">{fluxo.ativo ?? true ? "Ativo" : "Pausado"}</span>
        </button>

        {/* Organizar Nós / Reset Layout */}
        {onResetLayout && (
          <button
            type="button"
            onClick={onResetLayout}
            className="hidden lg:flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-xs text-zinc-300 transition-colors cursor-pointer"
            title="Auto-organizar layout dos nós"
          >
            <RotateCcw size={13} className="text-zinc-400" />
            <span className="hidden xl:inline">Auto-layout</span>
          </button>
        )}

        {/* Histórico & Logs */}
        <button
          type="button"
          onClick={onToggleLogs}
          className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer ${
            painelLogsAberto
              ? "bg-orange-600/20 border-orange-500/50 text-orange-300"
              : "bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-850"
          }`}
          title="Visualizar execuções e dados I/O"
          id="btn-painel-logs"
        >
          <History size={13} className="text-zinc-400" />
          <span className="hidden md:inline">Logs & I/O</span>
          {logsCount > 0 && (
            <span className="px-1.5 py-0.2 rounded-full bg-orange-600/30 text-orange-300 text-[10px] font-bold">
              {logsCount}
            </span>
          )}
        </button>

        {/* Exportar JSON */}
        <button
          type="button"
          onClick={onExportarJson}
          className="hidden sm:flex items-center gap-1 px-2 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
          title="Exportar fluxo como JSON"
        >
          <Download size={13} />
        </button>

        {/* Salvar Grafo */}
        <button
          type="button"
          onClick={onSalvarGrafo}
          disabled={salvando}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-xs font-semibold text-zinc-100 transition-colors cursor-pointer disabled:opacity-50"
          title="Salvar alterações do grafo"
        >
          <Save size={13} className={salvando ? "animate-spin" : "text-emerald-400"} />
          <span className="hidden sm:inline">Salvar</span>
        </button>

        {/* Executar Agora */}
        <button
          type="button"
          onClick={onExecutar}
          disabled={executando}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-bold shadow-md shadow-orange-600/20 transition-all cursor-pointer disabled:opacity-50"
          title="Executar fluxo imediatamente"
        >
          <Play size={13} className={`fill-current ${executando ? "animate-pulse" : ""}`} />
          <span>{executando ? "Rodando..." : "Executar"}</span>
        </button>

        {/* Excluir Fluxo */}
        <button
          type="button"
          onClick={onExcluirFluxo}
          className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-950/40 border border-transparent hover:border-rose-900/60 transition-colors cursor-pointer"
          title="Excluir fluxo"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </header>
  );
};
