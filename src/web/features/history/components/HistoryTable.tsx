import React, { useState, useMemo, type FC } from "react";
import {
  Bot,
  Workflow,
  ListTodo,
  Calendar,
  MessageSquare,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowRight,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Zap,
} from "lucide-react";
import type { ItemHistorico } from "../types.js";

export interface HistoryTableProps {
  itens: ItemHistorico[];
  itemSelecionadoId: string | null;
  onSelecionarItem: (item: ItemHistorico) => void;
  carregando: boolean;
}

export const HistoryTable: FC<HistoryTableProps> = ({
  itens,
  itemSelecionadoId,
  onSelecionarItem,
  carregando,
}) => {
  const [pagina, setPagina] = useState(1);
  const [itensPorPagina, setItensPorPagina] = useState(50);

  const totalPaginas = Math.max(1, Math.ceil(itens.length / itensPorPagina));
  const itensPaginados = useMemo(() => {
    const inicio = (pagina - 1) * itensPorPagina;
    return itens.slice(inicio, inicio + itensPorPagina);
  }, [itens, pagina, itensPorPagina]);

  const obterIconeTipo = (tipo: string) => {
    switch (tipo) {
      case "execucao":
        return <Bot size={14} className="text-emerald-400" />;
      case "fluxo":
        return <Workflow size={14} className="text-purple-400" />;
      case "task":
        return <ListTodo size={14} className="text-blue-400" />;
      case "rotina":
        return <Calendar size={14} className="text-sky-400" />;
      case "conversa":
        return <MessageSquare size={14} className="text-amber-400" />;
      default:
        return <Zap size={14} className="text-orange-400" />;
    }
  };

  const formatarData = (dataStr?: string | null) => {
    if (!dataStr) return "--:--";
    const d = new Date(dataStr);
    if (isNaN(d.getTime())) return dataStr;
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  if (carregando && itens.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-zinc-500 text-xs">
        <Clock size={24} className="animate-spin text-orange-400 mb-2" />
        <span>Carregando histórico do workspace...</span>
      </div>
    );
  }

  if (itens.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-zinc-500 bg-zinc-900/20 rounded-2xl border border-zinc-850 border-dashed">
        <Workflow size={32} className="text-zinc-600 mb-2" />
        <h4 className="text-sm font-semibold text-zinc-300">
          Nenhum registro encontrado
        </h4>
        <p className="text-xs text-zinc-500 max-w-sm mt-1">
          Não há execuções, fluxos ou eventos que correspondam aos filtros selecionados.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 rounded-xl bg-zinc-900/60 border border-zinc-850 shadow-md overflow-hidden">
      {/* Tabela de Itens */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <table className="w-full text-left text-xs font-sans">
          <thead className="bg-zinc-950/80 text-zinc-400 font-mono text-[10px] uppercase tracking-wider sticky top-0 z-10 border-b border-zinc-850 backdrop-blur-xs">
            <tr>
              <th className="p-3 w-10">Tipo</th>
              <th className="p-3">Identificador / Ordem</th>
              <th className="p-3">Agente / Origem</th>
              <th className="p-3">Timestamp</th>
              <th className="p-3">Duração</th>
              <th className="p-3">Custo USD</th>
              <th className="p-3">Status</th>
              <th className="p-3 w-12 text-right">Ação</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-850/60 text-zinc-300">
            {itensPaginados.map((item) => {
              const isSelected = itemSelecionadoId === item.id;
              const isOk = item.status === "concluido" || item.status === "ok" || item.status === "sucesso";
              const isFalhou = item.status === "falhou" || item.status === "erro";
              const isExecutando = item.status === "executando";

              const descricao = item.ordem || item.titulo || item.id;

              return (
                <tr
                  key={item.id}
                  data-testid={`historico-item-${item.id}`}
                  data-tipo={item.tipo}
                  onClick={() => onSelecionarItem(item)}
                  className={`group transition-colors cursor-pointer ${
                    isSelected
                      ? "bg-orange-600/15 border-l-2 border-orange-500"
                      : "hover:bg-zinc-850/60"
                  }`}
                >
                  {/* Tipo */}
                  <td className="p-3">
                    <div
                      className="p-1.5 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center shrink-0"
                      title={item.tipo}
                    >
                      {obterIconeTipo(item.tipo)}
                    </div>
                  </td>

                  {/* Identificador / Ordem */}
                  <td className="p-3 min-w-0 max-w-[280px]">
                    <div className="font-mono text-xs font-bold text-zinc-100 truncate group-hover:text-orange-400 transition-colors">
                      {item.id}
                    </div>
                    <div className="text-[11px] text-zinc-400 truncate mt-0.5" title={descricao}>
                      {descricao}
                    </div>
                  </td>

                  {/* Agente / Origem */}
                  <td className="p-3 font-mono text-[11px]">
                    {item.agente ? (
                      <span className="text-zinc-300 font-semibold">
                        @{item.agente}
                      </span>
                    ) : (
                      <span className="text-zinc-500 capitalize">{item.tipo}</span>
                    )}
                    {item.modelo && (
                      <div className="text-[10px] text-zinc-500 truncate max-w-[120px]">
                        {item.modelo}
                      </div>
                    )}
                  </td>

                  {/* Timestamp */}
                  <td className="p-3 font-mono text-[11px] text-zinc-400 whitespace-nowrap">
                    {formatarData(item.inicio || item.quando)}
                  </td>

                  {/* Duração */}
                  <td className="p-3 font-mono text-[11px] text-zinc-400 whitespace-nowrap">
                    {item.duracao_ms ? `${(item.duracao_ms / 1000).toFixed(2)}s` : "--"}
                  </td>

                  {/* Custo USD */}
                  <td className="p-3 font-mono text-[11px] text-emerald-400 whitespace-nowrap">
                    {item.custo_usd ? `$${item.custo_usd.toFixed(5)}` : "--"}
                  </td>

                  {/* Status */}
                  <td className="p-3 whitespace-nowrap">
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                        isExecutando
                          ? "bg-amber-950/70 text-amber-400 border border-amber-800 animate-pulse"
                          : isOk
                          ? "bg-emerald-950/70 text-emerald-400 border border-emerald-800"
                          : isFalhou
                          ? "bg-rose-950/70 text-rose-400 border border-rose-800"
                          : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                      }`}
                    >
                      {item.status || "ok"}
                    </span>
                  </td>

                  {/* Ação */}
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelecionarItem(item);
                      }}
                      className="p-1 rounded text-zinc-400 group-hover:text-orange-400 hover:bg-zinc-800 transition-colors"
                      title="Inspecionar execução"
                    >
                      <ArrowRight size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Barra de Paginação */}
      <div className="p-3 bg-zinc-950 border-t border-zinc-850 flex items-center justify-between gap-4 text-xs font-mono text-zinc-400 shrink-0">
        <div className="flex items-center gap-2">
          <span>Itens por página:</span>
          <select
            value={itensPorPagina}
            onChange={(e) => {
              setItensPorPagina(Number(e.target.value));
              setPagina(1);
            }}
            className="bg-zinc-900 border border-zinc-800 rounded px-2 py-0.5 text-zinc-300 focus:outline-none"
          >
            <option value={25}>25</option>
            <option value={50}>50</option>
            <option value={100}>100</option>
          </select>
          <span className="text-[11px] text-zinc-500">
            Total: {itens.length} registros
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span>
            Página {pagina} de {totalPaginas}
          </span>
          <button
            type="button"
            disabled={pagina <= 1}
            onClick={() => setPagina((p) => Math.max(1, p - 1))}
            className="p-1 rounded bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 disabled:opacity-30 cursor-pointer"
            title="Página anterior"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            disabled={pagina >= totalPaginas}
            onClick={() => setPagina((p) => Math.min(totalPaginas, p + 1))}
            className="p-1 rounded bg-zinc-900 hover:bg-zinc-850 border border-zinc-800 disabled:opacity-30 cursor-pointer"
            title="Próxima página"
          >
            <ChevronRight size={14} />
          </button>
        </div>
      </div>
    </div>
  );
};
