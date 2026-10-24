import React, { useState, useMemo, useEffect, type FC } from "react";
import { useNavigate } from "react-router-dom";
import {
  FolderPlus,
  Search,
  Settings,
  BookOpen,
  HelpCircle,
  Plus,
  Bot,
  ArrowRight,
  Sparkles,
  Building2,
  X,
  FileText,
  KeyRound,
  Shield,
  Layers,
  Activity,
  Pause,
  Play,
} from "lucide-react";
import { NovoWorkspaceModal } from "./NovoWorkspaceModal.js";
import type { WorkspaceResumo } from "@opencorp/sdk";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { workspacePath } from "../../../lib/routes.js";
import { formatarDataHoraCompleta, tempoDesde } from "../../../lib/format.js";

export interface HomeZeroStateProps {
  workspaces: WorkspaceResumo[];
  aoAtualizarWorkspaces?: () => void;
}

interface ItemPesquisa {
  tipo: "doc" | "config" | "workspace";
  titulo: string;
  subtitulo: string;
  link?: string;
  wsId?: string;
  icone: React.ComponentType<{ size?: number; className?: string }>;
}

export const HomeZeroState: FC<HomeZeroStateProps> = ({
  workspaces,
  aoAtualizarWorkspaces,
}) => {
  const navigate = useNavigate();
  const { client, tratarErro } = useOpenCorp();
  const [modalNovoWs, setModalNovoWs] = useState(false);
  const [modalAjuda, setModalAjuda] = useState(false);
  const [busca, setBusca] = useState("");
  // Relógio para o "pausado há X" andar sem recarregar a página.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    if (!workspaces.some((w) => w.pausado === true)) return;
    const timer = setInterval(() => setAgora(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [workspaces]);

  // Catálogo de pesquisa rápida
  const catalogoPesquisa = useMemo<ItemPesquisa[]>(
    () => [
      {
        tipo: "doc",
        titulo: "Arquitetura de SO Distribuído",
        subtitulo: "Filesystem como SSOT, SQLite WAL e isolamento",
        link: "/docs",
        icone: BookOpen,
      },
      {
        tipo: "doc",
        titulo: "Manual do Secretário Executivo",
        subtitulo: "Governança, despacho autônomo e hot-swap",
        link: "/docs",
        icone: Bot,
      },
      {
        tipo: "doc",
        titulo: "Blueprint Empresa Editorial WordPress",
        subtitulo: "Pipeline de redação, revisão e publicação",
        link: "/docs",
        icone: FileText,
      },
      {
        tipo: "config",
        titulo: "Configuração de Modelos & Rotação",
        subtitulo: "Ajustar modelos gratuitos e ordem de fallback",
        link: "/config",
        icone: Settings,
      },
      {
        tipo: "config",
        titulo: "Chaves de API & Provedores",
        subtitulo: "OpenRouter, OpenCode-Go e BYOK",
        link: "/secrets",
        icone: KeyRound,
      },
      {
        tipo: "config",
        titulo: "Políticas de Segurança (Security Guard)",
        subtitulo: "Allowlist estrita, blocklist e aprovação HITL",
        link: "/config",
        icone: Shield,
      },
    ],
    [],
  );

  const resultadosBusca = useMemo<ItemPesquisa[]>(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return [];
    const docsFiltrados = catalogoPesquisa.filter(
      (item) =>
        item.titulo.toLowerCase().includes(q) ||
        item.subtitulo.toLowerCase().includes(q),
    );
    const wsFiltrados: ItemPesquisa[] = workspaces
      .filter((w) => w.id.toLowerCase().includes(q))
      .map((w) => ({
        tipo: "workspace",
        titulo: `Empresa: ${w.id}`,
        subtitulo: `Ativar workspace ${w.id}`,
        wsId: w.id,
        link: "",
        icone: Building2,
      }));
    return [...wsFiltrados, ...docsFiltrados];
  }, [busca, catalogoPesquisa, workspaces]);

  const selecionarWorkspace = (id: string) => {
    navigate(workspacePath(id));
  };

  const alternarPausa = async (w: WorkspaceResumo) => {
    try {
      await client.workspaces.definirPausado(w.id, w.pausado !== true);
      aoAtualizarWorkspaces?.();
    } catch (erro: unknown) {
      tratarErro(erro, "Falha ao pausar/retomar o workspace");
    }
  };

  return (
    <div className="h-full w-full p-3 sm:p-4 md:p-6 flex flex-col bg-zinc-950 overflow-y-auto select-none">
      {/* Container Principal do Zero State */}
      <div className="flex-1 min-h-0 w-full max-w-[1140px] mx-auto rounded-2xl border border-zinc-800 bg-zinc-900/40 flex flex-col md:grid md:grid-cols-[240px_minmax(0,1fr)] gap-4 md:gap-6 p-4 sm:p-6 shadow-2xl justify-between">
        
        {/* Barra de Projetos para Mobile (< md) */}
        <div className="flex md:hidden items-center justify-between pb-3 border-b border-zinc-800/80 shrink-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-zinc-300">Empresas / Projetos</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700/50">
              {workspaces.length}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setModalNovoWs(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-emerald-300 bg-emerald-950/60 border border-emerald-800/60 hover:bg-emerald-900/60 transition-colors cursor-pointer"
          >
            <FolderPlus size={13} />
            <span>Adicionar projeto</span>
          </button>
        </div>

        {/* Lista Horizontal de Empresas em Mobile */}
        {workspaces.length > 0 && (
          <div className="flex md:hidden gap-1.5 overflow-x-auto py-1 shrink-0">
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => selecionarWorkspace(w.id)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700/60 text-xs text-zinc-300 shrink-0 active:scale-95"
              >
                <Building2 size={12} className="text-emerald-400" />
                <span>{w.id}</span>
              </button>
            ))}
          </div>
        )}

        {/* Painel Esquerdo Desktop (a partir de md: 768px) */}
        <aside className="hidden md:flex flex-col justify-between py-1 border-r border-zinc-800/60 pr-5 shrink-0">
          <div className="space-y-3">
            <div className="flex items-center justify-between pl-1">
              <span className="text-xs font-semibold text-zinc-400 tracking-wide uppercase">
                Projetos & Empresas
              </span>
              <button
                type="button"
                onClick={() => setModalNovoWs(true)}
                className="p-1 rounded-md text-zinc-500 hover:text-emerald-400 hover:bg-zinc-800/80 transition-colors cursor-pointer"
                title="Adicionar projeto"
              >
                <FolderPlus size={15} />
              </button>
            </div>

            {/* Ação Adicionar Projeto */}
            <button
              type="button"
              onClick={() => setModalNovoWs(true)}
              className="w-full flex items-center justify-start text-left gap-2.5 px-3 py-2 rounded-xl text-xs font-medium text-emerald-400 bg-emerald-950/30 border border-emerald-800/40 hover:bg-emerald-900/40 transition-all cursor-pointer"
            >
              <FolderPlus size={14} className="shrink-0" />
              <span>Adicionar projeto</span>
            </button>

            {/* Lista de Empresas Cadastradas */}
            {workspaces.length > 0 && (
              <div className="pt-2 space-y-1 max-h-56 overflow-y-auto">
                <div className="px-2 pb-1 text-[10px] font-semibold tracking-wider uppercase text-zinc-500">
                  Cadastrados ({workspaces.length})
                </div>
                {workspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => selecionarWorkspace(w.id)}
                    className="w-full flex items-center justify-start text-left gap-2 px-2.5 py-1.5 rounded-lg text-xs text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800/80 border border-transparent hover:border-zinc-700/60 transition-all cursor-pointer truncate group"
                  >
                    <div className="w-5 h-5 rounded-md bg-zinc-800 border border-zinc-700 flex items-center justify-center text-[10px] font-bold text-zinc-300 group-hover:border-emerald-500/50 group-hover:text-emerald-400 shrink-0">
                      {w.id.slice(0, 1).toUpperCase()}
                    </div>
                    <span className="truncate flex-1 text-left font-mono">{w.id}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Rodapé do Painel Esquerdo */}
          <div className="pt-4 border-t border-zinc-800/60 space-y-1">
            <button
              type="button"
              onClick={() => navigate("/config/global")}
              className="w-full flex items-center justify-start text-left gap-2.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-all cursor-pointer"
            >
              <Settings size={14} className="text-zinc-500 shrink-0" />
              <span>Configurações</span>
            </button>
            <button
              type="button"
              onClick={() => navigate("/docs")}
              className="w-full flex items-center justify-start text-left gap-2.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-all cursor-pointer"
            >
              <BookOpen size={14} className="text-zinc-500 shrink-0" />
              <span>Documentação</span>
            </button>
            <button
              type="button"
              onClick={() => setModalAjuda(true)}
              className="w-full flex items-center justify-start text-left gap-2.5 px-2.5 py-1.5 rounded-lg text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/60 transition-all cursor-pointer"
            >
              <HelpCircle size={14} className="text-zinc-500 shrink-0" />
              <span>Primeiros Passos</span>
            </button>
          </div>
        </aside>

        {/* Painel Central: Busca e Cartões de Onboarding */}
        <section className="flex-1 flex flex-col min-h-0 relative justify-between">
          {/* Campo de Busca Superior */}
          <div className="w-full max-w-xl mx-auto pt-1 pb-3 relative z-10 shrink-0">
            <div className="relative flex items-center bg-zinc-950/80 border border-zinc-800 rounded-xl px-3 py-2 text-sm shadow-xs focus-within:border-emerald-500/50">
              <Search size={14} className="text-zinc-500 mr-2.5 shrink-0" />
              <input
                type="text"
                value={busca}
                onChange={(e) => setBusca(e.target.value)}
                placeholder="Buscar empresas, tarefas ou documentação..."
                className="w-full bg-transparent text-xs sm:text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none"
              />
              {busca && (
                <button
                  type="button"
                  onClick={() => setBusca("")}
                  className="p-0.5 text-zinc-500 hover:text-zinc-300 cursor-pointer"
                >
                  <X size={14} />
                </button>
              )}
            </div>

            {/* Menu Popover com Resultados da Busca */}
            {resultadosBusca.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1.5 bg-zinc-900 border border-zinc-800 rounded-xl shadow-2xl p-1.5 z-30 max-h-56 overflow-y-auto space-y-1">
                {resultadosBusca.map((item, idx) => {
                  const Icone = item.icone;
                  return (
                    <div
                      key={idx}
                      onClick={() => {
                        if (item.wsId) {
                          selecionarWorkspace(item.wsId);
                        } else if (item.link) {
                          navigate(item.link);
                        }
                        setBusca("");
                      }}
                      className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-zinc-800/90 cursor-pointer transition-colors"
                    >
                      <Icone size={14} className="text-zinc-400 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium text-zinc-100 truncate">
                          {item.titulo}
                        </div>
                        <div className="text-[11px] text-zinc-500 truncate">
                          {item.subtitulo}
                        </div>
                      </div>
                      <ArrowRight size={12} className="text-zinc-600 shrink-0" />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Área Central: Boas-vindas e Ação Principal */}
          <div className="flex-1 flex flex-col items-center justify-center text-center px-2 py-4">
            <div className="h-12 w-12 rounded-2xl bg-emerald-950/60 border border-emerald-800/50 flex items-center justify-center text-emerald-400 mb-3 shadow-lg shadow-emerald-950/40">
              <Sparkles size={22} />
            </div>

            <div className="space-y-1.5">
              <h2 className="text-base sm:text-lg font-bold text-zinc-100 tracking-tight">
                {workspaces.length > 0
                  ? "Seus Workspaces & Empresas"
                  : "Nenhum Workspace Conectado"}
              </h2>
              <p className="text-xs text-zinc-400 max-w-sm px-2">
                {workspaces.length > 0
                  ? "Selecione um projeto para abrir ou adicione uma nova empresa autônoma."
                  : "Conecte-se a uma empresa autônoma existente ou inicie um novo projeto a partir de templates corporativos."}
              </p>
            </div>

            {workspaces.length > 0 ? (
              <div className="w-full max-w-2xl mt-4 flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-2.5 px-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] font-semibold text-zinc-300 uppercase tracking-wider">
                      Projetos Disponíveis
                    </span>
                    <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                      {workspaces.length}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setModalNovoWs(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-emerald-400 hover:text-emerald-300 hover:bg-emerald-950/40 border border-emerald-800/40 transition-colors cursor-pointer"
                  >
                    <Plus size={13} />
                    <span>Adicionar projeto</span>
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-56 overflow-y-auto p-1 scrollbar-thin">
                  {workspaces.map((w) => (
                    <div key={w.id} className="relative group">
                      <button
                        type="button"
                        onClick={() => selecionarWorkspace(w.id)}
                        className="w-full flex items-center justify-between p-3 pr-10 rounded-xl bg-zinc-900/80 border border-zinc-800 hover:border-emerald-500/50 hover:bg-zinc-850 text-left transition-all cursor-pointer shadow-xs"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="w-8 h-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300 group-hover:border-emerald-500/50 group-hover:text-emerald-400 shrink-0 font-mono">
                            {w.id.slice(0, 1).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <span className="text-xs font-semibold text-zinc-200 group-hover:text-emerald-300 truncate flex items-center gap-1.5 font-mono">
                              {w.id}
                              {w.pausado === true && (
                                <span
                                  title={
                                    w.pausado_em
                                      ? `Pausado em ${formatarDataHoraCompleta(w.pausado_em)}`
                                      : "Pausado (horário não registrado)"
                                  }
                                  className="text-[10px] px-1.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40 shrink-0 font-normal"
                                >
                                  {w.pausado_em ? `pausado ${tempoDesde(w.pausado_em, agora)}` : "pausado"}
                                </span>
                              )}
                            </span>
                            {w.path && (
                              <span className="text-[10px] text-zinc-500 truncate block">
                                {w.path}
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => void alternarPausa(w)}
                        title={
                          w.pausado === true
                            ? "Retomar: os fluxos deste workspace voltam a disparar"
                            : "Pausar: nenhum fluxo deste workspace dispara, mesmo com os fluxos ligados"
                        }
                        aria-label={w.pausado === true ? `Retomar ${w.id}` : `Pausar ${w.id}`}
                        className={`absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-lg flex items-center justify-center border border-transparent transition-all cursor-pointer ${
                          w.pausado === true
                            ? "text-emerald-400 hover:bg-emerald-950/40 hover:border-emerald-800/40"
                            : "text-amber-400 hover:bg-amber-950/40 hover:border-amber-800/40"
                        }`}
                      >
                        {w.pausado === true ? <Play size={13} /> : <Pause size={13} />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setModalNovoWs(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/60 transition-all cursor-pointer active:scale-95"
                >
                  <Plus size={14} />
                  <span>Adicionar projeto / empresa</span>
                </button>
              </div>
            )}

            {/* Cartões de Acesso Rápido */}
            <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3 max-w-2xl w-full text-left">
              {/* Card Documentação */}
              <div
                onClick={() => navigate("/docs")}
                className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850/80 transition-all cursor-pointer group flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="w-7 h-7 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 mb-2">
                    <BookOpen size={14} />
                  </div>
                  <h3 className="text-xs font-bold text-zinc-200 group-hover:text-zinc-100">
                    Documentação
                  </h3>
                  <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                    Arquitetura de SO, 18 agentes e blueprint.
                  </p>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-blue-400 font-medium">
                  <span>Ver guias</span>
                  <ArrowRight size={11} />
                </div>
              </div>

              {/* Card Configurações */}
              <div
                onClick={() => navigate("/config/global")}
                className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850/80 transition-all cursor-pointer group flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="w-7 h-7 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400 mb-2">
                    <Settings size={14} />
                  </div>
                  <h3 className="text-xs font-bold text-zinc-200 group-hover:text-zinc-100">
                    Configurações
                  </h3>
                  <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                    Chaves de API, modelos e rotação.
                  </p>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-amber-400 font-medium">
                  <span>Ajustar IA</span>
                  <ArrowRight size={11} />
                </div>
              </div>

              {/* Card Analytics (visão de todos os projetos) */}
              <div
                onClick={() => navigate("/analytics")}
                className="p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 hover:border-zinc-700 hover:bg-zinc-850/80 transition-all cursor-pointer group flex flex-col justify-between gap-3"
              >
                <div>
                  <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400 mb-2">
                    <Activity size={14} />
                  </div>
                  <h3 className="text-xs font-bold text-zinc-200 group-hover:text-zinc-100">
                    Analytics
                  </h3>
                  <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug">
                    Todos os projetos e serviços, ao vivo.
                  </p>
                </div>
                <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium">
                  <span>Ver analytics</span>
                  <ArrowRight size={11} />
                </div>
              </div>
            </div>
          </div>

          {/* Navegação Inferior Mobile */}
          <nav className="flex md:hidden items-center justify-around pt-3 border-t border-zinc-800/80 shrink-0">
            <button
              type="button"
              onClick={() => navigate("/config/global")}
              className="flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              <Settings size={15} />
              <span className="text-[10px]">Configurações</span>
            </button>
            <button
              type="button"
              onClick={() => navigate("/docs")}
              className="flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              <BookOpen size={15} />
              <span className="text-[10px]">Documentação</span>
            </button>
            <button
              type="button"
              onClick={() => setModalAjuda(true)}
              className="flex flex-col items-center gap-1 py-1 px-3 rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              <HelpCircle size={15} />
              <span className="text-[10px]">Ajuda</span>
            </button>
          </nav>
        </section>
      </div>

      {/* Modal de Novo Workspace */}
      <NovoWorkspaceModal
        aberto={modalNovoWs}
        aoFechar={() => setModalNovoWs(false)}
        aoWorkspaceCriado={(id) => {
          aoAtualizarWorkspaces?.();
          selecionarWorkspace(id);
        }}
      />

      {/* Modal de Ajuda / Primeiros Passos */}
      {modalAjuda && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-xs z-50 flex items-center justify-center p-4 animate-in fade-in duration-200 select-none">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-md w-full p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
              <div className="flex items-center gap-2 text-sm font-bold text-zinc-100">
                <Sparkles size={16} className="text-emerald-400" />
                <span>Primeiros Passos no OpenCorp</span>
              </div>
              <button
                type="button"
                onClick={() => setModalAjuda(false)}
                className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X size={15} />
              </button>
            </div>
            <div className="text-xs text-zinc-300 space-y-3 leading-relaxed">
              <p>
                <strong>1. Crie ou Selecione uma Empresa:</strong> Clique em "Adicionar projeto" para iniciar um novo workspace ou importar um pacote <code>.corp</code>.
              </p>
              <p>
                <strong>2. Configure seus Modelos:</strong> Acesse <em>Configurações</em> para gerenciar chaves de provedores e rotação de LLMs.
              </p>
              <p>
                <strong>3. Acompanhe e abra um projeto:</strong> Veja todos os projetos juntos em <em>Analytics</em>. Ao abrir um projeto, o Secretário Executivo (<code>Ctrl+J</code>) e o quadro de tarefas ficam disponíveis.
              </p>
            </div>
            <div className="flex justify-end pt-2 border-t border-zinc-800">
              <button
                type="button"
                onClick={() => {
                  setModalAjuda(false);
                  navigate("/docs");
                }}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 font-medium transition-colors cursor-pointer"
              >
                Abrir Documentação Completa
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
