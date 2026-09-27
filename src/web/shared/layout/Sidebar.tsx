import React, { useState, useEffect, type FC } from "react";
import { NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Kanban,
  Bot,
  Workflow,
  Users2,
  FolderGit2,
  Cpu,
  Layers,
  Boxes,
  History,
  Bell,
  Settings,
  KeyRound,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Shield,
  Activity,
  X,
} from "lucide-react";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";
import { workspacePath } from "../../lib/routes.js";

interface ItemNav {
  to: string;
  rotulo: string;
  icone: React.ComponentType<{ size?: number; className?: string }>;
  badge?: string;
  badgeCor?: string;
}

interface GrupoNav {
  titulo: string;
  itens: ItemNav[];
}

const GRUPOS_NAV: GrupoNav[] = [
  {
    titulo: "OPERACIONAL",
    itens: [
      { to: "/home", rotulo: "Home Dashboard", icone: LayoutDashboard },
      { to: "/tasks", rotulo: "Tarefas & Kanban", icone: Kanban },
      { to: "/secretario", rotulo: "Secretário Executivo", icone: Bot, badge: "IA", badgeCor: "bg-emerald-950 border-emerald-800 text-emerald-400" },
      { to: "/fluxos", rotulo: "Fluxos de Automação", icone: Workflow },
      { to: "/reunioes", rotulo: "Reuniões & Deliberações", icone: Users2 },
    ],
  },
  {
    titulo: "DESENVOLVIMENTO",
    itens: [
      { to: "/workspace", rotulo: "Workspace IDE", icone: FolderGit2 },
      { to: "/agentes", rotulo: "Agentes & Teams", icone: Cpu },
      { to: "/apps", rotulo: "Apps & MCPs", icone: Layers },
      { to: "/ativos", rotulo: "Ativos & Skills", icone: Boxes },
    ],
  },
  {
    titulo: "GOVERNANÇA & SRE",
    itens: [
      { to: "/historico", rotulo: "Histórico de Auditoria", icone: History },
      { to: "/notificacoes", rotulo: "Notificações", icone: Bell },
      { to: "/config", rotulo: "Configurações", icone: Settings },
      { to: "/secrets", rotulo: "Segredos & Chaves", icone: KeyRound },
      { to: "/docs", rotulo: "Documentação", icone: BookOpen },
    ],
  },
];

export interface SidebarProps {
  mobileAberta: boolean;
  aoFecharMobile: () => void;
}

export const Sidebar: FC<SidebarProps> = ({ mobileAberta, aoFecharMobile }) => {
  const { workspaceId } = useOpenCorp();
  // Dentro de um workspace os links apontam direto para /w/<ws>/<módulo>
  // (sem passar pelo redirecionamento legado), e o item ativo fica destacado.
  const destino = (to: string): string => {
    if (!workspaceId || to === "/docs") return to;
    if (to === "/home") return workspacePath(workspaceId);
    if (to === "/secrets") return workspacePath(workspaceId, "config", { tab: "chaves" });
    return workspacePath(workspaceId, to.slice(1));
  };
  const [recolhida, setRecolhida] = useState<boolean>(() => {
    return typeof window !== "undefined" && localStorage.getItem("oc_sidebar_collapsed") === "1";
  });

  const alternarRecolhida = () => {
    setRecolhida((prev) => {
      const proximo = !prev;
      if (typeof window !== "undefined") {
        localStorage.setItem("oc_sidebar_collapsed", proximo ? "1" : "0");
      }
      return proximo;
    });
  };

  return (
    <>
      {mobileAberta && (
        <div
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-xs md:hidden"
          onClick={aoFecharMobile}
          aria-hidden="true"
        />
      )}

      <aside
        id="sidebar-principal"
        aria-label="Navegação principal"
        className={`fixed inset-y-0 left-0 z-50 flex w-72 shrink-0 flex-col bg-zinc-950 border-r border-zinc-850 select-none transition-[transform,width] duration-300 md:relative md:z-30 md:translate-x-0 ${
          mobileAberta ? "translate-x-0" : "-translate-x-full"
        } ${recolhida ? "md:w-16" : "md:w-60"}`}
      >
        {/* Topo com Logo e Versão */}
        <div className="flex items-center justify-between h-14 px-3.5 border-b border-zinc-850/80 bg-zinc-950/80">
          <div className="flex items-center gap-2.5 overflow-hidden">
            <div className="h-8 w-8 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-950/60 shrink-0">
              <Shield size={18} />
            </div>
            <div className={`flex flex-col min-w-0 ${recolhida ? "md:hidden" : ""}`}>
              <span className="font-bold text-sm tracking-tight text-zinc-100 flex items-center gap-1.5">
                OpenCorp
                <span className="text-[10px] font-mono px-1 py-0.2 rounded bg-emerald-950/60 border border-emerald-800/40 text-emerald-400">
                  v0.7
                </span>
              </span>
              <span className="text-[11px] text-zinc-500 truncate">Empresa Autônoma</span>
            </div>
          </div>

          <button
            type="button"
            onClick={aoFecharMobile}
            className="md:hidden p-2 -mr-2 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-900 transition-colors cursor-pointer"
            aria-label="Fechar menu de navegação"
            title="Fechar menu de navegação"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

      {/* Navegação por Grupos */}
      <nav className="flex-1 overflow-y-auto px-2 py-3 space-y-4 scrollbar-thin">
        {GRUPOS_NAV.map((grupo) => (
          <div key={grupo.titulo} className="space-y-1">
            <span
              className={`px-3 text-[10px] font-bold text-zinc-400 tracking-wider uppercase block ${
                recolhida ? "md:hidden" : ""
              }`}
            >
              {grupo.titulo}
            </span>

            <div className="space-y-0.5">
              {grupo.itens.map((item) => {
                const Icone = item.icone;

                return (
                  <NavLink
                    key={item.to}
                    to={destino(item.to)}
                    end={item.to === "/home"}
                    onClick={aoFecharMobile}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all group relative ${
                        isActive
                          ? "bg-emerald-500/10 text-emerald-400 border-r-2 border-emerald-500 font-semibold"
                          : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-900/60"
                      } ${recolhida ? "md:justify-center md:px-0 md:py-2" : ""}`
                    }
                    title={recolhida ? item.rotulo : undefined}
                  >
                    <Icone size={16} className="shrink-0" />

                    <span className={`truncate flex-1 ${recolhida ? "md:hidden" : ""}`}>
                      {item.rotulo}
                    </span>

                    {item.badge && (
                      <span
                        className={`text-[9px] font-mono px-1.5 py-0.2 rounded-full border font-bold ${
                          recolhida ? "md:hidden " : ""
                        }${
                          item.badgeCor || "bg-zinc-800 border-zinc-700 text-zinc-300"
                        }`}
                      >
                        {item.badge}
                      </span>
                    )}
                  </NavLink>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer com Toggle de Recolhimento e Status do Daemon */}
      <div className="p-2.5 border-t border-zinc-850/80 bg-zinc-950 space-y-2">
        <button
          type="button"
          onClick={alternarRecolhida}
          className="hidden md:flex w-full items-center justify-center gap-2 py-1.5 rounded-xl bg-zinc-900/60 hover:bg-zinc-850 text-zinc-400 hover:text-zinc-200 text-xs transition-colors cursor-pointer border border-zinc-850"
          title={recolhida ? "Expandir menu lateral" : "Recolher menu lateral"}
        >
          {recolhida ? (
            <ChevronRight size={15} />
          ) : (
            <>
              <ChevronLeft size={15} />
              <span>Recolher Menu</span>
            </>
          )}
        </button>

        <div
          className={`items-center justify-between px-2 text-[11px] text-zinc-500 font-mono ${
            recolhida ? "flex md:hidden" : "flex"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
            <span>{workspaceId || "daemon"}</span>
          </div>
          <Activity size={12} className="text-zinc-600" />
        </div>
        {recolhida && (
          <div className="hidden md:flex justify-center" title={`Workspace: ${workspaceId}`}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          </div>
        )}
      </div>
      </aside>
    </>
  );
};
