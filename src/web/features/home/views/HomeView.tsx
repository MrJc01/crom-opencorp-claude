import React, { useState, useEffect, useCallback, type FC } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { HomeZeroState } from "../components/HomeZeroState.js";
import { PendingApprovalsCard } from "../components/PendingApprovalsCard.js";
import type { WorkspaceResumo } from "@opencorp/sdk";
import {
  LayoutDashboard,
  Bot,
  Kanban,
  Users,
  Workflow,
  Sparkles,
  ArrowRight,
  Activity,
  CheckCircle2,
  Clock,
  Shield,
  Layers,
  Building2,
  RefreshCw,
  FolderSync,
} from "lucide-react";

export const HomeView: FC = () => {
  const navigate = useNavigate();
  const { client, workspaceId, tratarErro } = useOpenCorp();

  const [workspaces, setWorkspaces] = useState<WorkspaceResumo[]>([]);
  const [carregandoWs, setCarregandoWs] = useState(true);

  // Métricas do Workspace Ativo
  const [totalTarefas, setTotalTarefas] = useState(0);
  const [tarefasFazendo, setTarefasFazendo] = useState(0);
  const [totalAgentes, setTotalAgentes] = useState(0);
  const [totalFluxos, setTotalFluxos] = useState(0);
  const [daemonOnline, setDaemonOnline] = useState(true);
  const [tarefasRecentes, setTarefasRecentes] = useState<any[]>([]);
  const [agentesAtivos, setAgentesAtivos] = useState<any[]>([]);

  // Carregar Workspaces Disponíveis
  const carregarWorkspaces = useCallback(async () => {
    try {
      setCarregandoWs(true);
      const lista = await client.workspaces.listar();
      setWorkspaces(lista || []);
    } catch {
      // Falha silenciosa ou fallback
    } finally {
      setCarregandoWs(false);
    }
  }, [client]);

  // Carregar Métricas do Workspace Ativo
  const carregarMetricas = useCallback(async () => {
    if (!workspaceId) return;
    try {
      const [tasks, agents, flows, health] = await Promise.all([
        client.tasks.listar().catch(() => []),
        client.agents.listar().catch(() => []),
        client.flows.listar().catch(() => []),
        client.system.getHealth().catch(() => ({ ok: false })),
      ]);

      const listaTasks = Array.isArray(tasks) ? tasks : [];
      const listaAgentes = Array.isArray(agents) ? agents : [];

      setTotalTarefas(listaTasks.length);
      setTarefasFazendo(listaTasks.filter((t: any) => t.coluna === "fazendo").length);
      setTarefasRecentes(listaTasks.slice(0, 4));
      setTotalAgentes(listaAgentes.length);
      setAgentesAtivos(listaAgentes.slice(0, 4));
      setTotalFluxos(Array.isArray(flows) ? flows.length : 0);
      setDaemonOnline(health?.ok !== false);
    } catch (err) {
      tratarErro(err, "Falha ao compilar métricas do workspace");
    }
  }, [client, workspaceId, tratarErro]);

  useEffect(() => {
    void carregarWorkspaces();
  }, [carregarWorkspaces]);

  useEffect(() => {
    if (workspaceId) {
      void carregarMetricas();
    }
  }, [workspaceId, carregarMetricas]);

  // Se nenhum workspace estiver ativo ou selecionado, exibe HomeZeroState
  if (!workspaceId) {
    return (
      <HomeZeroState
        workspaces={workspaces}
        aoAtualizarWorkspaces={carregarWorkspaces}
      />
    );
  }

  return (
    <div className="flex flex-col h-full w-full p-4 sm:p-6 md:p-8 space-y-6 overflow-y-auto select-none">
      {/* Banner de Boas-vindas com Identificação da Empresa */}
      <div className="relative p-6 sm:p-8 rounded-3xl bg-gradient-to-r from-emerald-950/50 via-zinc-900/60 to-zinc-900/40 border border-emerald-800/40 shadow-xl overflow-hidden">
        <div className="max-w-2xl space-y-3 z-10 relative">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-950/80 border border-emerald-800/60 text-xs font-mono text-emerald-300">
            <Sparkles size={13} className="text-emerald-400" />
            <span>OpenCorp SO Autônomo · Empresa Ativa</span>
          </div>

          <h1 className="text-2xl sm:text-3xl font-bold text-zinc-100 tracking-tight">
            Governança da Empresa Autônoma
          </h1>

          <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed">
            Workspace ativo: <span className="font-mono font-semibold text-emerald-300">{workspaceId}</span>.
            O Secretário Executivo e os agentes operam de forma orquestrada via tarefas e fluxos.
          </p>

          <div className="pt-2 flex flex-wrap items-center gap-3">
            <Link
              to="/secretario"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-lg shadow-emerald-950/60 transition-all cursor-pointer"
            >
              <Bot size={15} />
              <span>Abrir Secretário</span>
              <ArrowRight size={13} />
            </Link>

            <Link
              to="/tasks"
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800/90 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700/60 transition-colors"
            >
              <Kanban size={14} className="text-emerald-400" />
              <span>Ver Kanban ({totalTarefas})</span>
            </Link>

            <button
              type="button"
              onClick={() => navigate("/workspaces")}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 text-xs border border-zinc-800 transition-colors cursor-pointer"
              title="Trocar para outro workspace ou cadastrar novo"
            >
              <FolderSync size={13} />
              <span>Trocar Workspace</span>
            </button>
          </div>
        </div>
      </div>

      {/* Grid de Métricas Principais */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 rounded-2xl bg-zinc-900/40 border border-zinc-850 space-y-2">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Tarefas em Andamento</span>
            <Clock size={16} className="text-emerald-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100 font-mono">{tarefasFazendo}</div>
          <span className="text-[11px] text-zinc-500">De {totalTarefas} tarefas registradas</span>
        </div>

        <div className="p-5 rounded-2xl bg-zinc-900/40 border border-zinc-850 space-y-2">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Quadro de Agentes</span>
            <Users size={16} className="text-purple-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100 font-mono">{totalAgentes}</div>
          <span className="text-[11px] text-zinc-500">Personas e especialistas ativos</span>
        </div>

        <div className="p-5 rounded-2xl bg-zinc-900/40 border border-zinc-850 space-y-2">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Pipelines de Fluxo</span>
            <Workflow size={16} className="text-blue-400" />
          </div>
          <div className="text-2xl font-bold text-zinc-100 font-mono">{totalFluxos}</div>
          <span className="text-[11px] text-zinc-500">Automações declarativas</span>
        </div>

        <div className="p-5 rounded-2xl bg-zinc-900/40 border border-zinc-850 space-y-2">
          <div className="flex items-center justify-between text-zinc-400">
            <span className="text-xs font-medium">Status do Daemon</span>
            <Activity size={16} className={daemonOnline ? "text-emerald-400" : "text-rose-400"} />
          </div>
          <div className="text-sm font-bold text-zinc-100 flex items-center gap-2 pt-1">
            <span
              className={`h-2.5 w-2.5 rounded-full ${
                daemonOnline ? "bg-emerald-500 animate-pulse" : "bg-rose-500"
              }`}
            />
            {daemonOnline ? "Operacional (WAL)" : "Indisponível"}
          </div>
          <span className="text-[11px] text-zinc-500">Supervisão pontual ativa</span>
        </div>
      </div>

      {/* Aprovações humanas (HITL) pendentes */}
      <PendingApprovalsCard />

      {/* Atalhos Rápidos Operacionais */}
      <div className="space-y-3">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Módulos Operacionais
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Link
            to="/tasks"
            className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 hover:border-emerald-500/40 hover:bg-zinc-900/70 transition-all flex flex-col items-center text-center gap-2 group cursor-pointer"
          >
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:scale-105 transition-transform">
              <Kanban size={18} />
            </div>
            <span className="text-xs font-medium text-zinc-200">Kanban</span>
          </Link>

          <Link
            to="/agentes"
            className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 hover:border-purple-500/40 hover:bg-zinc-900/70 transition-all flex flex-col items-center text-center gap-2 group cursor-pointer"
          >
            <div className="p-2.5 rounded-xl bg-purple-500/10 text-purple-400 group-hover:scale-105 transition-transform">
              <Users size={18} />
            </div>
            <span className="text-xs font-medium text-zinc-200">Agentes</span>
          </Link>

          <Link
            to="/fluxos"
            className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 hover:border-blue-500/40 hover:bg-zinc-900/70 transition-all flex flex-col items-center text-center gap-2 group cursor-pointer"
          >
            <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-400 group-hover:scale-105 transition-transform">
              <Workflow size={18} />
            </div>
            <span className="text-xs font-medium text-zinc-200">Fluxos</span>
          </Link>

          <Link
            to="/secretario"
            className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 hover:border-emerald-500/40 hover:bg-zinc-900/70 transition-all flex flex-col items-center text-center gap-2 group cursor-pointer"
          >
            <div className="p-2.5 rounded-xl bg-emerald-500/10 text-emerald-400 group-hover:scale-105 transition-transform">
              <Bot size={18} />
            </div>
            <span className="text-xs font-medium text-zinc-200">Secretário</span>
          </Link>

          <Link
            to="/apps"
            className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 hover:border-amber-500/40 hover:bg-zinc-900/70 transition-all flex flex-col items-center text-center gap-2 group cursor-pointer"
          >
            <div className="p-2.5 rounded-xl bg-amber-500/10 text-amber-400 group-hover:scale-105 transition-transform">
              <Layers size={18} />
            </div>
            <span className="text-xs font-medium text-zinc-200">Apps & MCPs</span>
          </Link>

          <Link
            to="/config"
            className="p-3.5 rounded-2xl bg-zinc-900/40 border border-zinc-800 hover:border-zinc-600 hover:bg-zinc-900/70 transition-all flex flex-col items-center text-center gap-2 group cursor-pointer"
          >
            <div className="p-2.5 rounded-xl bg-zinc-800 text-zinc-400 group-hover:scale-105 transition-transform">
              <Shield size={18} />
            </div>
            <span className="text-xs font-medium text-zinc-200">Configuração</span>
          </Link>
        </div>
      </div>

      {/* Resumo Operacional: Tarefas Recentes & Agentes */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bloco de Tarefas Recentes */}
        <div className="p-5 rounded-2xl bg-zinc-900/30 border border-zinc-850 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Kanban size={16} className="text-emerald-400" />
              <h3 className="text-sm font-bold text-zinc-200">Tarefas em Aberto</h3>
            </div>
            <Link
              to="/tasks"
              className="text-xs text-emerald-400 hover:text-emerald-300 font-medium"
            >
              Ver todas →
            </Link>
          </div>

          {tarefasRecentes.length === 0 ? (
            <div className="py-6 text-center text-xs text-zinc-500">
              Nenhuma tarefa pendente no momento.
            </div>
          ) : (
            <div className="space-y-2">
              {tarefasRecentes.map((t: any) => (
                <div
                  key={t.id}
                  className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-zinc-200 truncate">{t.titulo}</div>
                    <div className="text-[10px] text-zinc-500 font-mono mt-0.5">
                      Coluna: {t.coluna} · Prioridade: {t.prioridade || "média"}
                    </div>
                  </div>
                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono capitalize ${
                      t.coluna === "fazendo"
                        ? "bg-amber-950/60 text-amber-300 border border-amber-800/40"
                        : "bg-zinc-800 text-zinc-400"
                    }`}
                  >
                    {t.coluna}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Bloco de Agentes Governança */}
        <div className="p-5 rounded-2xl bg-zinc-900/30 border border-zinc-850 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users size={16} className="text-purple-400" />
              <h3 className="text-sm font-bold text-zinc-200">Especialistas e Agentes</h3>
            </div>
            <Link
              to="/agentes"
              className="text-xs text-purple-400 hover:text-purple-300 font-medium"
            >
              Ver todos →
            </Link>
          </div>

          {agentesAtivos.length === 0 ? (
            <div className="py-6 text-center text-xs text-zinc-500">
              Nenhum agente cadastrado no workspace.
            </div>
          ) : (
            <div className="space-y-2">
              {agentesAtivos.map((a: any) => (
                <div
                  key={a.id}
                  className="p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 flex items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-zinc-200 truncate">
                      {a.nome || a.id}
                    </div>
                    <div className="text-[10px] text-zinc-500 truncate mt-0.5">
                      {a.papel || a.descricao || "Agente Especialista"}
                    </div>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-950/60 border border-purple-800/40 text-purple-300">
                    {a.modelo || "default"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
