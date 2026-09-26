import React, { useState, useMemo, useRef, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Workflow,
  Play,
  RefreshCw,
  Plus,
  Trash2,
  Calendar,
  Clock,
  Search,
  Download,
  Upload,
  Webhook,
  Copy,
  ArrowRight,
  Sparkles,
  GitBranch,
  Power,
  Layers,
} from "lucide-react";
import type { FluxoCompleto } from "../types.js";
import { showToast } from "../../../shared/ui/Toast.js";

export interface WorkflowListProps {
  fluxos: FluxoCompleto[];
  carregando: boolean;
  executandoId: string | null;
  onAbrirStudio: (fluxoId: string) => void;
  onRecarregar: () => void;
  onNovoFluxo: () => void;
  onExecutarFluxo: (fluxoId: string, nome?: string) => void;
  onExcluirFluxo: (fluxoId: string, nome?: string) => void;
  onImportarArquivo: (conteudoJson: any) => Promise<void>;
  onToggleAtivo: (fluxoId: string, novoAtivo: boolean) => void;
}

// Helper para extrair metadados com segurança tanto de fluxos detalhados quanto de resumos numéricos
function extrairDadosFluxo(fluxo: FluxoCompleto) {
  const nosArray = Array.isArray(fluxo.nos) ? fluxo.nos : [];
  const nosCount = typeof fluxo.nos === "number" ? fluxo.nos : nosArray.length;
  const arestasCount =
    typeof fluxo.arestas === "number"
      ? fluxo.arestas
      : Array.isArray(fluxo.arestas)
      ? fluxo.arestas.length
      : 0;

  const gatilhos = Array.isArray(fluxo.gatilhos) ? fluxo.gatilhos : [];
  const temCron =
    nosArray.some((n: any) => n.tipo === "cron") ||
    gatilhos.some((g: any) =>
      typeof g === "string" ? g === "cron" : g?.tipo === "cron"
    ) ||
    fluxo.gatilho === "cron";

  const temWebhook =
    nosArray.some((n: any) => n.tipo === "webhook") ||
    gatilhos.some((g: any) =>
      typeof g === "string" ? g === "webhook" : g?.tipo === "webhook"
    ) ||
    fluxo.gatilho === "webhook";

  const temManual =
    nosArray.some((n: any) => n.tipo === "manual") ||
    (!temCron && !temWebhook);

  let cronExpr: string | undefined = undefined;
  const noCron = nosArray.find((n: any) => n.tipo === "cron");
  if (noCron?.config) {
    cronExpr = noCron.config.expressao_cron || noCron.config.cron || noCron.config.expressao;
  }
  if (!cronExpr) {
    const gCron = gatilhos.find((g: any) => g?.tipo === "cron");
    if (gCron) cronExpr = gCron.expressao || gCron.detalhe || gCron.cron;
  }

  const noWebhook = nosArray.find((n: any) => n.tipo === "webhook");
  const webhookId = noWebhook?.id || fluxo.id;

  return {
    nosCount,
    arestasCount,
    temCron,
    temWebhook,
    temManual,
    cronExpr,
    webhookId,
  };
}

export const WorkflowList: FC<WorkflowListProps> = ({
  fluxos,
  carregando,
  executandoId,
  onAbrirStudio,
  onRecarregar,
  onNovoFluxo,
  onExecutarFluxo,
  onExcluirFluxo,
  onImportarArquivo,
  onToggleAtivo,
}) => {
  const [busca, setBusca] = useState("");
  // `?filtro=cron` (rota /agenda) abre a lista já filtrada pelos fluxos agendados.
  const [searchParams] = useSearchParams();
  const filtroInicial = searchParams.get("filtro");
  const [filtroTipo, setFiltroTipo] = useState<"todos" | "cron" | "webhook" | "manual">(
    filtroInicial === "cron" || filtroInicial === "webhook" || filtroInicial === "manual" ? filtroInicial : "todos"
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filtra fluxos por busca e por tipo de gatilho
  const fluxosFiltrados = useMemo(() => {
    const q = busca.toLowerCase().trim();
    return fluxos.filter((f) => {
      const matchBusca =
        !q ||
        f.id.toLowerCase().includes(q) ||
        (f.nome && f.nome.toLowerCase().includes(q)) ||
        (f.descricao && f.descricao.toLowerCase().includes(q));

      if (!matchBusca) return false;

      if (filtroTipo === "todos") return true;

      const dados = extrairDadosFluxo(f);
      if (filtroTipo === "cron") return dados.temCron;
      if (filtroTipo === "webhook") return dados.temWebhook;
      if (filtroTipo === "manual") return dados.temManual;

      return true;
    });
  }, [fluxos, busca, filtroTipo]);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        await onImportarArquivo(json);
      } catch (err: any) {
        showToast(`Arquivo JSON inválido: ${err.message}`, "erro");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const copiarJson = (fluxo: FluxoCompleto) => {
    navigator.clipboard.writeText(JSON.stringify(fluxo, null, 2));
    showToast(`JSON do fluxo "${fluxo.nome || fluxo.id}" copiado!`, "sucesso");
  };

  const exportarJson = (fluxo: FluxoCompleto) => {
    const blob = new Blob([JSON.stringify(fluxo, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fluxo.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Arquivo ${fluxo.id}.json exportado!`, "sucesso");
  };

  return (
    <div className="flex flex-col h-full w-full p-4 sm:p-6 md:p-8 space-y-6 overflow-y-auto select-none">
      {/* Header da Tela */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2">
            <Workflow className="text-orange-400" size={22} />
            Studio de Fluxos Declarativos (DAG)
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Pipelines autônomos orientados a eventos, gatilhos cron e agentes de IA estilo n8n.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Input oculto para importação de JSON */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleFileUpload}
            className="hidden"
          />

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-850 text-xs text-zinc-300 transition-colors cursor-pointer"
            title="Importar fluxo de arquivo JSON"
          >
            <Upload size={13} className="text-zinc-400" />
            <span className="hidden sm:inline">Importar</span>
          </button>

          <button
            type="button"
            onClick={onRecarregar}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 hover:bg-zinc-850 text-xs text-zinc-300 transition-colors cursor-pointer"
            title="Recarregar lista de fluxos"
          >
            <RefreshCw size={13} className={carregando ? "animate-spin text-orange-400" : "text-zinc-400"} />
            <span className="hidden sm:inline">Atualizar</span>
          </button>

          <button
            type="button"
            onClick={onNovoFluxo}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-orange-600 hover:bg-orange-500 text-xs font-semibold text-white shadow-md shadow-orange-600/20 transition-all cursor-pointer"
          >
            <Plus size={14} />
            <span>Novo Fluxo</span>
          </button>
        </div>
      </div>

      {/* Barra de Filtros e Busca */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-zinc-900/60 p-2 rounded-xl border border-zinc-850">
        {/* Campo de Busca */}
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-2.5 text-zinc-500" />
          <input
            type="text"
            placeholder="Buscar por nome, id ou descrição..."
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-orange-500 transition-colors"
          />
        </div>

        {/* Filtros por tipo de gatilho */}
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {[
            { id: "todos", label: "Todos", count: fluxos.length },
            {
              id: "cron",
              label: "Cron",
              count: fluxos.filter((f) => extrairDadosFluxo(f).temCron).length,
            },
            {
              id: "webhook",
              label: "Webhook",
              count: fluxos.filter((f) => extrairDadosFluxo(f).temWebhook).length,
            },
            {
              id: "manual",
              label: "Manual",
              count: fluxos.filter((f) => extrairDadosFluxo(f).temManual).length,
            },
          ].map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setFiltroTipo(cat.id as any)}
              aria-pressed={filtroTipo === cat.id}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                filtroTipo === cat.id
                  ? "bg-zinc-800 text-orange-400 font-bold border border-zinc-700"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850/60"
              }`}
            >
              <span>{cat.label}</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-950 text-zinc-400">
                {cat.count}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Grid de Cards de Fluxos */}
      {carregando && fluxos.length === 0 ? (
        <div className="p-12 text-center text-xs text-zinc-500 flex flex-col items-center justify-center space-y-2">
          <RefreshCw size={24} className="animate-spin text-orange-400" />
          <span>Carregando fluxos do workspace...</span>
        </div>
      ) : fluxosFiltrados.length === 0 ? (
        <div className="p-12 text-center text-xs text-zinc-500 flex flex-col items-center justify-center space-y-3 bg-zinc-900/30 rounded-2xl border border-zinc-850 border-dashed">
          <Workflow size={32} className="text-zinc-600" />
          <span>Nenhum fluxo encontrado com os filtros selecionados.</span>
          <button
            type="button"
            onClick={onNovoFluxo}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600/20 text-orange-400 border border-orange-500/30 hover:bg-orange-600/30 transition-colors"
          >
            <Plus size={13} />
            <span>Criar Novo Fluxo</span>
          </button>
        </div>
      ) : (
        <div
          className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
          data-testid={filtroTipo === "cron" ? "secao-fluxos-agendados" : "lista-fluxos"}
        >
          {fluxosFiltrados.map((fluxo) => {
            const dados = extrairDadosFluxo(fluxo);
            const isExecutando = executandoId === fluxo.id;
            const isAtivo = fluxo.ativo ?? true;

            return (
              <div
                key={fluxo.id}
                data-testid={`fluxo-card-${fluxo.id}`}
                className="group flex flex-col justify-between p-4 rounded-xl bg-zinc-900/60 hover:bg-zinc-900 border border-zinc-850 hover:border-zinc-700 transition-all duration-200 shadow-md hover:shadow-xl space-y-4"
              >
                {/* Topo do Card */}
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="p-2 rounded-lg bg-orange-500/10 border border-orange-500/30 text-orange-400 shrink-0 group-hover:scale-105 transition-transform">
                        <Workflow size={16} />
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-sm font-bold text-zinc-100 truncate group-hover:text-orange-400 transition-colors">
                          {fluxo.nome || fluxo.id}
                        </h3>
                        <p className="font-mono text-[10px] text-zinc-500 truncate">
                          {fluxo.id}
                        </p>
                      </div>
                    </div>

                    {/* Toggle Ativo */}
                    <button
                      type="button"
                      onClick={() => onToggleAtivo(fluxo.id, !isAtivo)}
                      role="switch"
                      aria-checked={isAtivo}
                      aria-label={isAtivo ? `Pausar fluxo ${fluxo.nome || fluxo.id}` : `Ativar fluxo ${fluxo.nome || fluxo.id}`}
                      data-testid={`toggle-ativo-${fluxo.id}`}
                      className={`p-1 rounded-lg border transition-colors cursor-pointer shrink-0 ${
                        isAtivo
                          ? "bg-emerald-950/40 border-emerald-800 text-emerald-400 hover:bg-emerald-950/70"
                          : "bg-zinc-950 border-zinc-800 text-zinc-500 hover:bg-zinc-800"
                      }`}
                      title={isAtivo ? "Fluxo Ativo — clique para pausar" : "Fluxo Pausado — clique para ativar"}
                    >
                      <Power size={13} />
                    </button>
                  </div>

                  {/* Descrição */}
                  <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">
                    {fluxo.descricao || "Pipeline de automação autônoma multi-agente."}
                  </p>
                </div>

                {/* Métricas e Gatilho */}
                <div className="space-y-2 pt-2 border-t border-zinc-850/80 text-xs">
                  {/* Informação do Gatilho */}
                  <div className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-400" data-testid={`trigger-${fluxo.id}`}>
                    {dados.temCron ? (
                      <>
                        <Clock size={12} className="text-sky-400 shrink-0" />
                        <span className="text-sky-300 font-semibold truncate">
                          Cron: {dados.cronExpr || "periódico"}
                        </span>
                      </>
                    ) : dados.temWebhook ? (
                      <>
                        <Webhook size={12} className="text-amber-400 shrink-0" />
                        <span className="text-amber-300 font-semibold truncate">
                          Webhook: /{dados.webhookId}
                        </span>
                      </>
                    ) : (
                      <>
                        <Play size={12} className="text-zinc-400 shrink-0" />
                        <span className="text-zinc-400">Disparo sob demanda</span>
                      </>
                    )}
                  </div>

                  {/* Contagem de Nós e Arestas */}
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500">
                    <span className="flex items-center gap-1">
                      <Layers size={11} />
                      {dados.nosCount} {dados.nosCount === 1 ? "nó" : "nós"}
                    </span>
                    <span className="flex items-center gap-1">
                      <GitBranch size={11} />
                      {dados.arestasCount} {dados.arestasCount === 1 ? "conexão" : "conexões"}
                    </span>
                  </div>
                </div>

                {/* Ações do Card */}
                <div className="flex items-center justify-between gap-2 pt-2 border-t border-zinc-850/80">
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => copiarJson(fluxo)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
                      title="Copiar JSON"
                      aria-label="Copiar JSON do fluxo"
                    >
                      <Copy size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => exportarJson(fluxo)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
                      title="Baixar JSON"
                      aria-label="Baixar JSON do fluxo"
                    >
                      <Download size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onExcluirFluxo(fluxo.id, fluxo.nome)}
                      className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-rose-950/30 transition-colors cursor-pointer"
                      title="Excluir fluxo"
                      aria-label="Excluir fluxo"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>

                  <div className="flex items-center gap-1.5">
                    {/* Botão de Disparo Rápido Play */}
                    <button
                      type="button"
                      onClick={() => onExecutarFluxo(fluxo.id, fluxo.nome)}
                      disabled={isExecutando}
                      aria-label={`Executar fluxo ${fluxo.nome || fluxo.id} agora`}
                      data-testid={`executar-agora-${fluxo.id}`}
                      className="flex items-center justify-center h-7 w-7 rounded-lg bg-orange-600/20 hover:bg-orange-600/30 border border-orange-500/30 text-orange-400 hover:text-orange-300 transition-all cursor-pointer disabled:opacity-50"
                      title="Executar fluxo agora"
                    >
                      <Play size={12} className={`fill-current ${isExecutando ? "animate-pulse" : ""}`} />
                    </button>

                    {/* Botão Abrir Studio */}
                    <button
                      type="button"
                      onClick={() => onAbrirStudio(fluxo.id)}
                      data-testid={`abrir-editor-${fluxo.id}`}
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-750 text-xs font-semibold text-zinc-200 hover:text-white transition-colors cursor-pointer"
                    >
                      <span>Studio</span>
                      <ArrowRight size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
