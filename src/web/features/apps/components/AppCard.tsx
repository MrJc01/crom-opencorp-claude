import React, { type FC } from "react";
import {
  Layout,
  ExternalLink,
  Sliders,
  Wrench,
  Trash2,
  BarChart2,
  Globe,
  Terminal,
  Database,
  CheckSquare,
  Calendar,
  Bot,
  Cpu,
  Sparkles,
  FolderCode,
  Play,
  Layers,
} from "lucide-react";
import type { MiniApp } from "../types.js";

export interface AppCardProps {
  app: MiniApp;
  onAbrir: (app: MiniApp, modo?: "app" | "chat" | "ambos") => void;
  onConfigurar: (app: MiniApp) => void;
  onInspecionarTools: (app: MiniApp) => void;
  onToggleAtivo?: (app: MiniApp, ativo: boolean) => void;
  onExcluir?: (app: MiniApp) => void;
}

export const getAppIcon = (icone?: string) => {
  const i = (icone || "").toLowerCase();
  if (i.includes("chart") || i.includes("grafico") || i.includes("metric")) return BarChart2;
  if (i.includes("globe") || i.includes("web") || i.includes("site") || i.includes("wp") || i.includes("word")) return Globe;
  if (i.includes("term") || i.includes("console") || i.includes("cli")) return Terminal;
  if (i.includes("data") || i.includes("banco") || i.includes("sql")) return Database;
  if (i.includes("task") || i.includes("check") || i.includes("tarefa") || i.includes("painel")) return CheckSquare;
  if (i.includes("cal") || i.includes("agenda") || i.includes("cron")) return Calendar;
  if (i.includes("bot") || i.includes("ia") || i.includes("agent")) return Bot;
  if (i.includes("cpu") || i.includes("eng")) return Cpu;
  if (i.includes("sparkle") || i.includes("pulso") || i.includes("monitor")) return Sparkles;
  return Layout;
};

export const AppCard: FC<AppCardProps> = ({
  app,
  onAbrir,
  onConfigurar,
  onInspecionarTools,
  onToggleAtivo,
  onExcluir,
}) => {
  const IconComponent = getAppIcon(app.icone || app.id);
  const ativo = app.ativo !== false;

  return (
    <div data-testid={`app-card-${app.id}`} className="p-4 sm:p-5 rounded-2xl border border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-900/80 hover:border-zinc-700 transition-all flex flex-col justify-between space-y-4 group shadow-xs">
      <div>
        {/* Topo do Card */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-10 w-10 rounded-xl bg-blue-500/10 border border-blue-500/25 flex items-center justify-center text-blue-400 shrink-0 group-hover:bg-blue-500/20 transition-colors">
              <IconComponent size={20} />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-sm text-zinc-100 truncate group-hover:text-blue-300 transition-colors">
                {app.titulo}
              </h3>
              <span className="text-[11px] font-mono text-zinc-500 block truncate mt-0.5">
                apps/{app.id}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <span
              className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase ${
                ativo
                  ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/60"
                  : "bg-zinc-800 text-zinc-500 border border-zinc-700"
              }`}
            >
              {ativo ? "Ativo" : "Inativo"}
            </span>
          </div>
        </div>

        {/* Descrição */}
        <p className="text-xs text-zinc-400 leading-relaxed mt-3 line-clamp-2">
          {app.descricao || "Aplicação integrada com o ecossistema OpenCorp e MCP."}
        </p>

        {/* Categoria e Capabilities */}
        <div className="mt-3 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-950 text-zinc-400 border border-zinc-800">
            {app.categoria || (app.mcpServer ? "Servidor MCP" : "Mini-App Web")}
          </span>
          {app.versao && (
            <span className="text-[10px] font-mono text-zinc-500">
              v{app.versao}
            </span>
          )}
        </div>
      </div>

      {/* Rodapé: Ações */}
      <div className="pt-3 border-t border-zinc-800/60 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onInspecionarTools(app)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-950 hover:bg-zinc-850 text-zinc-300 text-xs font-medium border border-zinc-800 transition-colors cursor-pointer"
            title="Inspecionar tools MCP expostas"
          >
            <Wrench size={12} className="text-orange-400" />
            <span className="hidden sm:inline">Tools</span>
          </button>

          <button
            type="button"
            onClick={() => onConfigurar(app)}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Configurar credenciais"
          >
            <Sliders size={13} />
          </button>

          {onExcluir && (
            <button
              type="button"
              onClick={() => onExcluir(app)}
              className="p-1.5 rounded-lg text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 transition-colors cursor-pointer"
              title="Excluir app"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => onAbrir(app, "ambos")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
        >
          <Play size={11} className="fill-current" />
          <span>Abrir App</span>
        </button>
      </div>
    </div>
  );
};
