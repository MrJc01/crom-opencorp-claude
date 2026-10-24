import React, { type FC } from "react";
import { Link, useLocation } from "react-router-dom";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";
import { Bot, Terminal, Bell, Menu, Radio } from "lucide-react";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher.js";

export interface TopbarProps {
  onToggleMenuMobile: () => void;
  aoAlternarSecretario?: () => void;
  secretarioAberto?: boolean;
}

export const Topbar: FC<TopbarProps> = ({
  onToggleMenuMobile,
  aoAlternarSecretario,
  secretarioAberto = false,
}) => {
  const { notificacoesNaoLidas, sseConectado, workspaceId } = useOpenCorp();
  // Sem workspace aberto não há Secretário, notificações nem stream do workspace: esconde o que não se aplica.
  const temWorkspace = Boolean(workspaceId);
  const location = useLocation();
  const estaNaRotaNotificacoes = /\/notificacoes\/?$/.test(location.pathname);

  return (
    <header className="h-14 bg-zinc-950 border-b border-zinc-850 px-4 md:px-6 flex items-center justify-between z-20 select-none">
      {/* Lado Esquerdo: Identificação do Workspace Ativo com Seletor Rápido */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleMenuMobile}
          className="md:hidden p-2 -ml-2 rounded-lg hover:bg-zinc-900 transition-colors cursor-pointer"
          aria-label="Abrir menu de navegação"
          title="Abrir menu de navegação"
        >
          <Menu className="w-5 h-5 text-zinc-400 hover:text-white" />
        </button>

        <WorkspaceSwitcher />

        <span className="hidden sm:inline-block text-xs text-zinc-600">|</span>
        <span className="hidden sm:flex items-center gap-1.5 text-xs text-zinc-400">
          <Terminal size={12} className="text-zinc-500" />
          <span>{temWorkspace ? "Sessão Operacional OpenCorp" : "Visão geral dos projetos"}</span>
        </span>
      </div>

      {/* Lado Direito: Status SSE + Central de Notificações com Badge + Botão / Badge do Secretário & Atalho Ctrl+J */}
      <div className="flex items-center gap-2.5">
        {temWorkspace && (
          <>
        {/* Indicador de Conexão SSE */}
        <div
          className={`hidden md:flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border transition-all select-none ${
            sseConectado
              ? "bg-emerald-950/30 border-emerald-800/50 text-emerald-300"
              : "bg-zinc-900/60 border-zinc-800/60 text-zinc-400"
          }`}
          title={
            sseConectado
              ? "Canal de eventos em tempo real conectado (SSE)"
              : "Canal de eventos offline (reconectando automaticamente)"
          }
        >
          <Radio
            size={12}
            className={sseConectado ? "text-emerald-400 animate-pulse" : "text-zinc-500"}
          />
          <span className="font-mono text-[10px]">
            {sseConectado ? "stream" : "offline"}
          </span>
        </div>

        {/* Central de Notificações com Badge */}
        <Link
          to="/notificacoes"
          data-view="notificacoes"
          id="btn-notificacoes-topbar"
          className={`relative p-2 rounded-lg border transition-all flex items-center justify-center cursor-pointer ${
            estaNaRotaNotificacoes
              ? "bg-zinc-800 border-zinc-700 text-zinc-100 shadow-xs"
              : "bg-zinc-900/60 border-zinc-800/80 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-850 hover:border-zinc-700"
          }`}
          title={
            notificacoesNaoLidas > 0
              ? `${notificacoesNaoLidas} notificação(ões) não lida(s)`
              : "Central de Notificações"
          }
        >
          <Bell className="w-4 h-4" />
          {notificacoesNaoLidas > 0 && (
            <span
              id="nav-badge-notificacoes"
              className="absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-bold text-zinc-950 ring-2 ring-zinc-950 animate-pulse"
            >
              {notificacoesNaoLidas > 99 ? "99+" : notificacoesNaoLidas}
            </span>
          )}
        </Link>

        {/* Botão do Secretário Executivo */}
        <button
          type="button"
          onClick={aoAlternarSecretario}
          data-testid="secretario-toggle"
          aria-expanded={secretarioAberto}
          aria-label="Abrir/Fechar Secretário Executivo"
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs transition-all cursor-pointer ${
            secretarioAberto
              ? "bg-emerald-600 text-white border-emerald-500 shadow-md shadow-emerald-950/60"
              : "bg-emerald-950/40 border-emerald-800/50 text-emerald-300 hover:bg-emerald-900/50 hover:border-emerald-700"
          }`}
          title="Abrir/Fechar Secretário Executivo (Ctrl+J)"
        >
          <Bot size={14} className={secretarioAberto ? "text-white" : "text-emerald-400"} />
          <span className="font-semibold hidden sm:inline">Secretário Executivo</span>
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
        </button>

        <kbd
          onClick={aoAlternarSecretario}
          className="hidden lg:flex items-center gap-1 text-[10px] font-mono text-zinc-400 bg-zinc-900 hover:bg-zinc-800 hover:text-zinc-200 px-2 py-1 rounded border border-zinc-800 cursor-pointer transition-colors"
          title="Atalho de teclado: Ctrl+J ou Cmd+J"
        >
          <span>Ctrl+J</span>
        </kbd>
          </>
        )}
      </div>
    </header>
  );
};
