import React, { type FC } from "react";
import {
  MessageSquare,
  Plus,
  X,
  Maximize2,
  Minimize2,
  Sparkles,
  History,
  GitBranch,
  Cpu,
  Clock,
  Settings2,
} from "lucide-react";

export interface ChatTab {
  id: string;
  tabKey?: string;
  titulo: string;
  criadoEm: number;
  ativa?: boolean;
}

export interface OpenCodeTabsHeaderProps {
  abas: ChatTab[];
  sessaoAtivaId: string | null;
  aoSelecionarAba: (id: string) => void;
  aoFecharAba: (id: string) => void;
  aoNovaAba: () => void;
  workspaceId: string;
  carregando?: boolean;
  tempoInferencia?: string;
  gitBranch?: string;
  modeloAtivo?: string;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  onAbrirHistorico?: () => void;
  onAbrirConfiguracoes?: () => void;
}

/**
 * Remove prefixos técnicos de workspace ou sessão do título da aba.
 */
export function formatarTituloAba(titulo?: string): string {
  if (!titulo || !titulo.trim()) return "Nova conversa";
  const limpo = titulo
    .replace(/^\[WORKSPACE[^\]]+\]\s*(?:\([^)]*\)\s*)?/i, "")
    .replace(/^\[SESS[ÃA]O[^\]]+\]\s*/i, "")
    .trim();
  return limpo || "Conversa";
}

/**
 * Cabeçalho de Abas de Conversas do Secretário Executivo com Telemetria e Governança
 */
export const OpenCodeTabsHeader: FC<OpenCodeTabsHeaderProps> = ({
  abas,
  sessaoAtivaId,
  aoSelecionarAba,
  aoFecharAba,
  aoNovaAba,
  workspaceId,
  carregando = false,
  tempoInferencia,
  gitBranch,
  modeloAtivo,
  onToggleFullscreen,
  isFullscreen = false,
  onAbrirHistorico,
  onAbrirConfiguracoes,
}) => {
  return (
    <header
      id="opencode-tabs-header"
      className="h-10 bg-zinc-950 border-b border-zinc-800/80 flex items-center px-2 gap-1.5 overflow-x-auto scrollbar-none shrink-0 z-20 select-none"
    >
      {/* Lista de Abas de Sessões */}
      <nav
        aria-label="Abas de conversas"
        className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto scrollbar-none py-1"
      >
        {abas.map((tab) => {
          const ativa = tab.id === sessaoAtivaId;
          const tituloExibido = formatarTituloAba(tab.titulo);

          return (
            <div key={tab.id} className="relative flex items-center shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={ativa}
                onClick={() => aoSelecionarAba(tab.id)}
                className={`group relative h-7 px-2.5 rounded-lg flex items-center gap-1.5 cursor-pointer transition-all text-xs select-none ${
                  ativa
                    ? "bg-zinc-850 text-zinc-100 font-medium shadow-xs border border-zinc-700/80"
                    : "bg-transparent hover:bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-transparent"
                }`}
                title={tab.titulo}
              >
                <MessageSquare
                  size={13}
                  className={`shrink-0 transition-colors ${
                    ativa
                      ? "text-emerald-400"
                      : "text-zinc-500 group-hover:text-zinc-400"
                  }`}
                />
                <span className="max-w-[110px] sm:max-w-[160px] truncate text-[11px] font-mono">
                  {tituloExibido}
                </span>

                {/* Botão de Fechar Aba */}
                <button
                  type="button"
                  data-testid="btn-fechar-aba"
                  onClick={(e) => {
                    e.stopPropagation();
                    aoFecharAba(tab.id);
                  }}
                  className="h-4 w-4 rounded flex items-center justify-center shrink-0 ml-1 cursor-pointer transition-colors text-zinc-500 hover:text-rose-400 hover:bg-zinc-750"
                  title="Fechar aba"
                  aria-label={`Fechar aba ${tituloExibido}`}
                >
                  <X size={11} strokeWidth={2.2} />
                </button>
              </button>
            </div>
          );
        })}

        {/* Botão + (Nova Sessão / Conversa) */}
        <button
          type="button"
          data-testid="btn-nova-conversa"
          onClick={aoNovaAba}
          className="h-7 w-7 shrink-0 rounded-lg hover:bg-zinc-850 text-zinc-400 hover:text-zinc-200 flex items-center justify-center transition-colors cursor-pointer border border-transparent hover:border-zinc-800 ml-0.5"
          title="Nova sessão (+)"
          aria-label="Nova sessão"
        >
          <Plus size={14} />
        </button>
      </nav>

      {/* Ações da Direita e Telemetria Operacional */}
      <div className="flex items-center gap-2 text-xs shrink-0 pl-2 border-l border-zinc-800/80">
        {/* Badge de Branch Git Ativa */}
        {gitBranch && (
          <div
            className="hidden md:flex items-center gap-1 font-mono text-[10px] text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded-md"
            title={`Branch git ativa: ${gitBranch}`}
          >
            <GitBranch size={11} className="text-emerald-400" />
            <span className="truncate max-w-[80px]">{gitBranch}</span>
          </div>
        )}

        {/* Badge do Modelo Ativo */}
        {modeloAtivo && (
          <div
            className="hidden lg:flex items-center gap-1 font-mono text-[10px] text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded-md"
            title={`Modelo em uso: ${modeloAtivo}`}
          >
            <Cpu size={11} className="text-emerald-400" />
            <span className="truncate max-w-[110px]">
              {modeloAtivo.split("/").pop()}
            </span>
          </div>
        )}

        {/* Cronômetro de Inferência / Status de Execução Ao Vivo */}
        {carregando ? (
          <div className="flex items-center gap-1.5 font-mono text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/50 px-2 py-0.5 rounded-full animate-pulse">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            <span>AO VIVO</span>
            {tempoInferencia && <span className="text-zinc-300">({tempoInferencia})</span>}
          </div>
        ) : null}

        {/* Identificador do Workspace e Título */}
        <span className="hidden sm:inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-400">
          <span className="text-zinc-300 font-semibold">Secretário</span>
          <span className="text-zinc-600">·</span>
          <span className="font-mono text-[10px] text-zinc-500">{workspaceId}</span>
        </span>

        {/* Botão Histórico de Sessões */}
        {onAbrirHistorico && (
          <button
            type="button"
            onClick={onAbrirHistorico}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
            title="Histórico de Sessões"
            aria-label="Histórico de Sessões"
          >
            <History size={13} />
          </button>
        )}

        {/* Botão Configurações do Secretário (Drawer Lateral) */}
        {onAbrirConfiguracoes && (
          <button
            type="button"
            onClick={onAbrirConfiguracoes}
            data-testid="btn-configurar-motor"
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
            title="Configurações do Secretário (Motor, Modelos e Agentes)"
            aria-label="Configurações do Secretário"
          >
            <Settings2 size={13} />
          </button>
        )}

        {/* Botão Tela Cheia / Restaurar */}
        {onToggleFullscreen && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
            title={isFullscreen ? "Restaurar visualização" : "Alternar tela cheia"}
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        )}
      </div>
    </header>
  );
};
