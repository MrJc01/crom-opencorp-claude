import React, { useState, useEffect, useCallback, useMemo, type FC, type FormEvent } from "react";
import {
  Layout,
  Plus,
  ArrowLeft,
  MessageSquare,
  Monitor,
  Columns2,
  X,
  FolderCode,
  Sparkles,
  RefreshCw,
  Search,
  Send,
  Loader2,
  RotateCw,
  Bot,
  User,
  Wrench,
  Info,
} from "lucide-react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import type { MiniApp, ModoVisualizacaoApp } from "../types.js";
import {
  AppCard,
  AppConfigModal,
  AppToolsList,
  getAppIcon,
} from "../components/index.js";

export const AppsView: FC = () => {
  const { client, workspaceId, tratarErro } = useOpenCorp();
  const [appsLista, setAppsLista] = useState<MiniApp[]>([]);
  const [carregandoApps, setCarregandoApps] = useState(false);
  const [busca, setBusca] = useState("");
  const [categoriaAtiva, setCategoriaAtiva] = useState("todos");

  // App aberto
  const [appSelecionado, setAppSelecionado] = useState<MiniApp | null>(null);
  const [modoVisualizacao, setModoVisualizacao] = useState<ModoVisualizacaoApp>("app");
  const [mensagensApp, setMensagensApp] = useState<Array<{ role: string; content: string }>>([]);
  const [inputChat, setInputChat] = useState("");
  const [iframeKey, setIframeKey] = useState(0);

  // Modais
  const [modalNovoApp, setModalNovoApp] = useState(false);
  const [novoId, setNovoId] = useState("");
  const [novoTitulo, setNovoTitulo] = useState("");
  const [novoDesc, setNovoDesc] = useState("");
  const [criandoApp, setCriandoApp] = useState(false);

  const [modalConfig, setModalConfig] = useState(false);
  const [appParaConfig, setAppParaConfig] = useState<MiniApp | null>(null);

  const [modalTools, setModalTools] = useState(false);
  const [appParaTools, setAppParaTools] = useState<MiniApp | null>(null);

  const wsEfetivo = useMemo(() => {
    if (workspaceId && workspaceId.trim().length > 0) return workspaceId.trim();
    if (typeof window !== "undefined") {
      const salvo =
        localStorage.getItem("oc-ws") ||
        localStorage.getItem("opencorp_workspace_id");
      if (salvo && salvo.trim().length > 0) return salvo.trim();
    }
    return "default";
  }, [workspaceId]);

  const carregarApps = useCallback(async () => {
    setCarregandoApps(true);
    try {
      const data = await client.http.get<MiniApp[]>("/api/apps", {
        headers: { "x-opencorp-workspace": wsEfetivo },
      }).catch(async () => {
        return client.http.get<MiniApp[]>("/apps", {
          headers: { "x-opencorp-workspace": wsEfetivo },
        }).catch(() => []);
      });

      setAppsLista(Array.isArray(data) ? data : []);
    } catch {
      setAppsLista([]);
    } finally {
      setCarregandoApps(false);
    }
  }, [client, wsEfetivo]);

  useEffect(() => {
    void carregarApps();
  }, [carregarApps]);

  const getIframeUrl = (appItem: MiniApp) => {
    let url = appItem.entryUrl || `/api/apps/${encodeURIComponent(appItem.id)}/view`;
    if (!url.includes("workspace=")) {
      url += (url.includes("?") ? "&" : "?") + "workspace=" + encodeURIComponent(wsEfetivo);
    }
    return url;
  };

  const abrirApp = (app: MiniApp, modo: ModoVisualizacaoApp = "app") => {
    setAppSelecionado(app);
    setModoVisualizacao(modo);
    const url = getIframeUrl(app);
    setMensagensApp([
      {
        role: "assistant",
        content: `👋 Aplicação: **${app.titulo}**\n\nCódigo-fonte: \`apps/${app.id}/index.html\`\nPreview: ${url}\n\nO assistente de customização de apps está em integração com o Secretário Executivo. Para modificar o código, utilize o Workspace IDE ou solicite ao Secretário.`,
      },
    ]);
  };

  const fecharApp = () => {
    setAppSelecionado(null);
    setMensagensApp([]);
    setInputChat("");
  };

  const enviarMensagemChat = async () => {
    const texto = inputChat.trim();
    if (!texto || !appSelecionado) return;

    setInputChat("");
    setMensagensApp((prev) => [
      ...prev,
      { role: "user", content: texto },
      {
        role: "assistant",
        content: `ℹ️ O assistente de customização de apps está em integração com o Secretário Executivo. Para editar \`apps/${appSelecionado.id}/index.html\`, utilize o Workspace IDE ou acione o Secretário Executivo.`,
      },
    ]);
  };

  const salvarNovoApp = async (e: FormEvent) => {
    e.preventDefault();
    const idLimpo = novoId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const titLimpo = novoTitulo.trim();
    if (!idLimpo || !titLimpo) {
      showToast("ID e Título são campos obrigatórios", "aviso");
      return;
    }

    setCriandoApp(true);
    try {
      const res = await client.http.post<any>(
        "/api/apps/novo",
        { id: idLimpo, titulo: titLimpo, descricao: novoDesc.trim() },
        { headers: { "x-opencorp-workspace": wsEfetivo } }
      );
      showToast(`Mini-App "${titLimpo}" criado com sucesso!`, "sucesso");
      setModalNovoApp(false);
      setNovoId("");
      setNovoTitulo("");
      setNovoDesc("");
      await carregarApps();
      if (res) {
        abrirApp(res, "ambos");
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao criar novo mini-app");
    } finally {
      setCriandoApp(false);
    }
  };

  const excluirApp = async (app: MiniApp) => {
    if (!confirm(`Deseja excluir permanentemente o mini-app "${app.titulo}"?`)) return;
    try {
      await client.http.delete(`/api/apps/${encodeURIComponent(app.id)}`, {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      showToast(`App "${app.titulo}" excluído`, "sucesso");
      await carregarApps();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao excluir app");
    }
  };

  const appsFiltrados = useMemo(() => {
    return appsLista.filter((a) => {
      const matchBusca =
        !busca.trim() ||
        a.titulo.toLowerCase().includes(busca.toLowerCase()) ||
        a.id.toLowerCase().includes(busca.toLowerCase()) ||
        a.descricao?.toLowerCase().includes(busca.toLowerCase());

      if (!matchBusca) return false;

      if (categoriaAtiva === "mcp") return Boolean(a.mcpServer);
      if (categoriaAtiva === "dashboards")
        return a.categoria?.includes("dash") || a.id.includes("dash") || a.id.includes("metric");
      return true;
    });
  }, [appsLista, busca, categoriaAtiva]);

  const IconeAppAberto = appSelecionado ? getAppIcon(appSelecionado.icone || appSelecionado.id) : Layout;

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-zinc-950 text-zinc-100">
      {/* ─────────────────────────────────────────────────────────────
          MODO 1: APP ABERTO (PREVIEW + AI CHAT)
         ───────────────────────────────────────────────────────────── */}
      {appSelecionado ? (
        <div className="flex flex-col h-full w-full overflow-hidden bg-zinc-950">
          {/* Topbar do App Aberto */}
          <div className="h-14 px-4 sm:px-6 border-b border-zinc-850 bg-zinc-900/60 backdrop-blur-md flex items-center justify-between text-xs select-none shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={fecharApp}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-850 hover:bg-zinc-800 text-zinc-200 font-semibold transition-colors cursor-pointer"
              >
                <ArrowLeft size={14} />
                <span>Voltar aos Apps</span>
              </button>

              <div className="h-4 w-px bg-zinc-800" />

              <div className="flex items-center gap-2 truncate">
                <div className="h-7 w-7 rounded-lg bg-blue-500/10 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
                  <IconeAppAberto size={14} />
                </div>
                <span className="font-bold text-sm text-zinc-100 truncate">
                  {appSelecionado.titulo}
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60 hidden sm:flex items-center gap-1">
                  <FolderCode size={10} className="text-zinc-500" />
                  apps/{appSelecionado.id}
                </span>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {/* Botão de Reload Iframe */}
              <button
                type="button"
                onClick={() => setIframeKey((k) => k + 1)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
                title="Recarregar preview"
              >
                <RotateCw size={14} />
              </button>

              {/* Seletor dos 3 Modos: Só App | Só Chat | Ambos */}
              <div className="flex items-center bg-zinc-950 border border-zinc-800 rounded-xl p-0.5 shadow-inner">
                <button
                  type="button"
                  onClick={() => setModoVisualizacao("app")}
                  aria-label="Só App"
                  aria-pressed={modoVisualizacao === "app"}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    modoVisualizacao === "app"
                      ? "bg-blue-600 text-white shadow-xs"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  }`}
                  title="Apenas a aplicação em tela cheia"
                >
                  <Monitor size={13} />
                  <span className="hidden sm:inline">Só App</span>
                </button>

                <button
                  type="button"
                  onClick={() => setModoVisualizacao("chat")}
                  aria-label="Só Chat"
                  aria-pressed={modoVisualizacao === "chat"}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    modoVisualizacao === "chat"
                      ? "bg-blue-600 text-white shadow-xs"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  }`}
                  title="Apenas o chat de customização por IA"
                >
                  <MessageSquare size={13} />
                  <span className="hidden sm:inline">Só Chat</span>
                </button>

                <button
                  type="button"
                  onClick={() => setModoVisualizacao("ambos")}
                  aria-label="Ambos"
                  aria-pressed={modoVisualizacao === "ambos"}
                  className={`px-3 py-1 rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer ${
                    modoVisualizacao === "ambos"
                      ? "bg-blue-600 text-white shadow-xs"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                  }`}
                  title="App e Chat lado a lado"
                >
                  <Columns2 size={13} />
                  <span className="hidden sm:inline">Ambos</span>
                </button>
              </div>
            </div>
          </div>

          {/* Área de Visualização com Split Responsivo */}
          <div className="flex-1 flex overflow-hidden">
            {/* Painel do Iframe da Aplicação */}
            {(modoVisualizacao === "app" || modoVisualizacao === "ambos") && (
              <div
                className={`flex-1 flex flex-col bg-zinc-950 overflow-hidden ${
                  modoVisualizacao === "ambos" ? "border-r border-zinc-850" : ""
                }`}
              >
                <iframe
                  key={iframeKey}
                  src={getIframeUrl(appSelecionado)}
                  title={appSelecionado.titulo}
                  className="w-full h-full border-none bg-zinc-950"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                />
              </div>
            )}

            {/* Painel de Chat AI com a Aplicação */}
            {(modoVisualizacao === "chat" || modoVisualizacao === "ambos") && (
              <div
                className={`flex flex-col bg-zinc-950 overflow-hidden ${
                  modoVisualizacao === "ambos"
                    ? "w-full sm:w-[420px] md:w-[460px] shrink-0"
                    : "flex-1"
                }`}
              >
                {/* Header do Chat */}
                <div className="p-3 border-b border-zinc-850 bg-zinc-900/40 flex items-center justify-between text-xs">
                  <span className="font-semibold text-zinc-200 flex items-center gap-1.5">
                    <Sparkles size={14} className="text-blue-400" />
                    <span>Engenharia por IA: {appSelecionado.titulo}</span>
                  </span>
                </div>

                {/* Banner Informativo de Integração */}
                <div className="px-3.5 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 text-xs text-amber-300">
                  <Info size={14} className="shrink-0 text-amber-400" />
                  <span className="leading-snug">
                    Assistente de customização de apps em integração com o Secretário Executivo
                  </span>
                </div>

                {/* Mensagens */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3.5 scrollbar-thin">
                  {mensagensApp.map((m, idx) => {
                    const isUser = m.role === "user";
                    return (
                      <div
                        key={idx}
                        className={`flex items-start gap-2.5 ${
                          isUser ? "flex-row-reverse" : "flex-row"
                        }`}
                      >
                        <div
                          className={`h-7 w-7 rounded-lg flex items-center justify-center shrink-0 text-xs ${
                            isUser
                              ? "bg-blue-600 text-white"
                              : "bg-zinc-900 border border-zinc-800 text-blue-400"
                          }`}
                        >
                          {isUser ? <User size={13} /> : <Bot size={13} />}
                        </div>

                        <div
                          className={`max-w-[85%] rounded-2xl p-3 text-xs leading-relaxed whitespace-pre-wrap ${
                            isUser
                              ? "bg-blue-950/60 border border-blue-800/50 text-blue-100 rounded-tr-xs"
                              : "bg-zinc-900/80 border border-zinc-850 text-zinc-200 rounded-tl-xs"
                          }`}
                        >
                          {m.content}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Composer do Chat (Desativado até conexão com Secretário Executivo) */}
                <div className="p-3 border-t border-zinc-850 bg-zinc-900/60 shrink-0">
                  <div className="flex items-end gap-2">
                    <textarea
                      rows={2}
                      disabled
                      placeholder="Assistente de customização em integração com o Secretário Executivo..."
                      value={inputChat}
                      onChange={(e) => setInputChat(e.target.value)}
                      className="flex-1 bg-zinc-950/60 border border-zinc-800/80 rounded-xl p-2.5 text-xs text-zinc-400 placeholder-zinc-500 focus:outline-none resize-none leading-relaxed cursor-not-allowed opacity-75"
                    />

                    <button
                      type="button"
                      disabled
                      className="p-3 rounded-xl bg-zinc-800 text-zinc-500 cursor-not-allowed opacity-40 shrink-0"
                      title="Assistente em integração com o Secretário Executivo"
                    >
                      <Send size={15} />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      ) : (
        /* ─────────────────────────────────────────────────────────────
            MODO 2: CATÁLOGO DE APPS & MCP SERVERS
           ───────────────────────────────────────────────────────────── */
        <div className="flex flex-col h-full w-full p-4 sm:p-6 md:p-8 space-y-6 overflow-y-auto scrollbar-thin">
          {/* Header */}
          <div className="pb-3 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h1 className="text-lg sm:text-xl font-bold text-zinc-100 tracking-tight flex items-center gap-2">
                <Layout className="text-blue-500" size={20} />
                <span>Catálogo de Mini-Apps &amp; Servidores MCP</span>
              </h1>
              <p className="text-xs text-zinc-400 mt-0.5">
                Aplicações integradas, servidores de contexto MCP e ferramentas estendidas para agentes autônomos.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                disabled={carregandoApps}
                onClick={carregarApps}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 text-xs font-medium transition-colors cursor-pointer"
              >
                <RefreshCw size={13} className={carregandoApps ? "animate-spin" : ""} />
                <span>Atualizar</span>
              </button>

              <button
                type="button"
                onClick={() => setModalNovoApp(true)}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
              >
                <Plus size={14} />
                <span>Novo Mini-App</span>
              </button>
            </div>
          </div>

          {/* Barra de Filtros e Busca */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none">
              <button
                type="button"
                onClick={() => setCategoriaAtiva("todos")}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer shrink-0 ${
                  categoriaAtiva === "todos"
                    ? "bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                }`}
              >
                Todos ({appsLista.length})
              </button>
              <button
                type="button"
                onClick={() => setCategoriaAtiva("mcp")}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer shrink-0 ${
                  categoriaAtiva === "mcp"
                    ? "bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                }`}
              >
                Servidores MCP
              </button>
              <button
                type="button"
                onClick={() => setCategoriaAtiva("dashboards")}
                className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-colors cursor-pointer shrink-0 ${
                  categoriaAtiva === "dashboards"
                    ? "bg-zinc-800 text-zinc-100 border border-zinc-700 shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900"
                }`}
              >
                Dashboards &amp; Web
              </button>
            </div>

            <div className="relative w-full sm:w-64">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
              />
              <input
                type="text"
                placeholder="Buscar app por nome ou ID..."
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                className="w-full pl-9 pr-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          {/* Grid de Apps */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {appsFiltrados.map((app) => (
              <AppCard
                key={app.id}
                app={app}
                onAbrir={(a, modo) => abrirApp(a, modo || "ambos")}
                onConfigurar={(a) => {
                  setAppParaConfig(a);
                  setModalConfig(true);
                }}
                onInspecionarTools={(a) => {
                  setAppParaTools(a);
                  setModalTools(true);
                }}
                onExcluir={excluirApp}
              />
            ))}

            {appsFiltrados.length === 0 && !carregandoApps && (
              <div className="col-span-full py-16 text-center text-xs text-zinc-500 border border-dashed border-zinc-850 rounded-2xl p-6">
                Nenhum mini-app ou servidor MCP encontrado para o filtro aplicado.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal Novo Mini-App */}
      {modalNovoApp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="w-full max-w-md rounded-2xl bg-zinc-950 border border-zinc-850 shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-4 border-b border-zinc-850 flex items-center justify-between shrink-0 bg-zinc-900/60">
              <div className="flex items-center gap-2.5">
                <div className="p-2 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
                  <Plus size={18} />
                </div>
                <h3 className="text-sm font-bold text-zinc-100">
                  Criar Novo Mini-App
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModalNovoApp(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={salvarNovoApp} className="p-5 space-y-4">
              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-zinc-200">
                  ID do App (diretório apps/&lt;id&gt;) *
                </label>
                <input
                  type="text"
                  placeholder="Ex: painel-metricas ou lead-tracker"
                  value={novoId}
                  onChange={(e) => setNovoId(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-mono text-zinc-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-zinc-200">
                  Título de Exibição *
                </label>
                <input
                  type="text"
                  placeholder="Ex: Painel de Métricas do YouTube"
                  value={novoTitulo}
                  onChange={(e) => setNovoTitulo(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="space-y-1.5">
                <label className="block text-xs font-semibold text-zinc-200">
                  Descrição
                </label>
                <textarea
                  rows={2}
                  placeholder="Objetivo do app e dados que ele consome..."
                  value={novoDesc}
                  onChange={(e) => setNovoDesc(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-xs text-zinc-100 focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="pt-3 border-t border-zinc-850 flex items-center justify-end gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setModalNovoApp(false)}
                  className="px-3 py-1.5 rounded-xl text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={criandoApp}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-md transition-colors cursor-pointer disabled:opacity-50"
                >
                  {criandoApp ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Plus size={13} />
                  )}
                  <span>Criar Aplicação</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal de Configuração do App */}
      <AppConfigModal
        aberto={modalConfig}
        app={appParaConfig}
        onClose={() => setModalConfig(false)}
        onSalvo={() => void carregarApps()}
      />

      {/* Modal de Inspeção de Tools MCP */}
      <AppToolsList
        aberto={modalTools}
        app={appParaTools}
        onClose={() => setModalTools(false)}
      />
    </div>
  );
};
