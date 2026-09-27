import React, { type FC } from "react";
import { Search, RefreshCw, Radio, Bot, Workflow, ListTodo, Calendar, MessageSquare, Filter } from "lucide-react";

export interface HistoryFilterBarProps {
  tipoFiltro: string;
  setTipoFiltro: (tipo: string) => void;
  statusFiltro: string;
  setStatusFiltro: (status: string) => void;
  agenteFiltro: string;
  setAgenteFiltro: (agente: string) => void;
  busca: string;
  setBusca: (busca: string) => void;
  tempoReal: boolean;
  setTempoReal: (tr: boolean) => void;
  carregando: boolean;
  agentesDisponiveis: string[];
  onRecarregar: () => void;
}

export const HistoryFilterBar: FC<HistoryFilterBarProps> = ({
  tipoFiltro,
  setTipoFiltro,
  statusFiltro,
  setStatusFiltro,
  agenteFiltro,
  setAgenteFiltro,
  busca,
  setBusca,
  tempoReal,
  setTempoReal,
  carregando,
  agentesDisponiveis,
  onRecarregar,
}) => {
  const tipos = [
    { id: "todos", label: "Todos", icon: Filter },
    { id: "execucao", label: "Agentes", icon: Bot },
    { id: "fluxo", label: "Fluxos DAG", icon: Workflow },
    { id: "task", label: "Kanban", icon: ListTodo },
    { id: "rotina", label: "Rotinas", icon: Calendar },
    { id: "conversa", label: "Secretário", icon: MessageSquare },
  ];

  return (
    <div className="flex flex-col gap-2.5 p-3 rounded-xl bg-zinc-900/60 border border-zinc-850">
      {/* Linha 1: Tipos de Entidade (5 tipos) + Toggle Tempo Real */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {tipos.map((t) => {
            const Icone = t.icon;
            const isSel = tipoFiltro === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTipoFiltro(t.id)}
                aria-pressed={isSel}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap cursor-pointer transition-colors ${
                  isSel
                    ? "bg-zinc-800 text-orange-400 font-bold border border-zinc-700 shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850/60"
                }`}
              >
                <Icone size={13} />
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          {/* Toggle Tempo Real */}
          <button
            type="button"
            onClick={() => setTempoReal(!tempoReal)}
            aria-pressed={tempoReal}
            data-testid="historico-tempo-real"
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-mono transition-colors cursor-pointer border ${
              tempoReal
                ? "bg-emerald-950/40 border-emerald-800 text-emerald-400"
                : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:bg-zinc-850"
            }`}
            title="Atualização automática a cada 5 segundos"
          >
            <Radio size={11} className={tempoReal ? "animate-pulse text-emerald-400" : ""} />
            <span>Tempo Real</span>
          </button>

          {/* Botão de Atualizar Manual */}
          <button
            type="button"
            onClick={onRecarregar}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
            title="Recarregar histórico"
          >
            <RefreshCw size={13} className={carregando ? "animate-spin text-orange-400" : ""} />
          </button>
        </div>
      </div>

      {/* Linha 2: Busca por Texto + Filtros de Status e Agente */}
      <div className="flex flex-wrap items-center justify-between gap-2.5 pt-2 border-t border-zinc-850/80">
        {/* Campo de Busca */}
        <div className="relative flex-1 min-w-[220px]">
          <Search size={13} className="absolute left-3 top-2.5 text-zinc-500" />
          <input
            type="text"
            placeholder="Buscar por ID, ordem, título ou palavra-chave..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-orange-500 transition-colors font-mono"
          />
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Filtro de Status */}
          <select
            value={statusFiltro}
            onChange={(e) => setStatusFiltro(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-orange-500 font-mono"
          >
            <option value="todos">Status: Todos</option>
            <option value="sucesso">Sucesso / Concluído</option>
            <option value="falhou">Falhou / Erro</option>
            <option value="executando">Executando</option>
            <option value="cancelado">Cancelado / Abortado</option>
          </select>

          {/* Filtro de Agente */}
          {agentesDisponiveis.length > 0 && (
            <select
              value={agenteFiltro}
              onChange={(e) => setAgenteFiltro(e.target.value)}
              className="bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-300 focus:outline-none focus:border-orange-500 font-mono max-w-[160px]"
            >
              <option value="todos">Agente: Todos</option>
              {agentesDisponiveis.map((ag) => (
                <option key={ag} value={ag}>
                  @{ag}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </div>
  );
};
