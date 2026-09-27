import React, { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Bot, Maximize2, X, Sparkles } from "lucide-react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { workspacePath } from "../../../lib/routes.js";
import { SecretarioChat } from "./SecretarioChat.js";
import { OpenCodeTabsHeader, type ChatTab } from "./OpenCodeTabsHeader.js";
import { HistoricoModal } from "./HistoricoModal.js";
import { SecretarioSettingsDrawer } from "./SecretarioSettingsDrawer.js";
import {
  atualizarAbaAtiva,
  carregarAbasWorkspace,
  gerarTabKey,
  salvarAbasWorkspace,
} from "../views/SecretarioView.js";

export interface SecretarioDockProps {
  aberto: boolean;
  aoFechar: () => void;
}

export const SecretarioDock: FC<SecretarioDockProps> = ({ aberto, aoFechar }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { workspaceId } = useOpenCorp();
  const wsId = workspaceId || "default";

  const [abas, setAbas] = useState<ChatTab[]>(() => {
    const salvas = carregarAbasWorkspace(wsId);
    if (salvas.length > 0) return salvas;
    const iniciais = [{ id: `sessao-${Date.now()}`, tabKey: gerarTabKey(), titulo: "Nova conversa", criadoEm: Date.now() }];
    salvarAbasWorkspace(wsId, iniciais);
    return iniciais;
  });
  const [sessaoAtivaId, setSessaoAtivaId] = useState<string>(() =>
    (typeof window !== "undefined" && localStorage.getItem(`oc-secretario-sessao-ativa:${wsId}`)) || abas[0]!.id,
  );
  const [historicoAberto, setHistoricoAberto] = useState(false);
  const [configLateralAberta, setConfigLateralAberta] = useState(false);
  const [modeloAtivo, setModeloAtivo] = useState("opencode/nemotron-3.5-lightning-free");

  useEffect(() => {
    let proximas = carregarAbasWorkspace(wsId);
    if (proximas.length === 0) {
      proximas = [{ id: `sessao-${Date.now()}`, tabKey: gerarTabKey(), titulo: "Nova conversa", criadoEm: Date.now() }];
      salvarAbasWorkspace(wsId, proximas);
    }
    setAbas(proximas);
    setSessaoAtivaId(localStorage.getItem(`oc-secretario-sessao-ativa:${wsId}`) || proximas[0]!.id);
  }, [wsId]);

  const selecionarAba = useCallback((id: string) => {
    setSessaoAtivaId(id);
    localStorage.setItem(`oc-secretario-sessao-ativa:${wsId}`, id);
  }, [wsId]);

  const novaAba = useCallback(() => {
    const nova = { id: `sessao-${Date.now()}`, tabKey: gerarTabKey(), titulo: "Nova conversa", criadoEm: Date.now() };
    setAbas((atuais) => {
      const proximas = [...atuais, nova];
      salvarAbasWorkspace(wsId, proximas);
      return proximas;
    });
    selecionarAba(nova.id);
  }, [selecionarAba, wsId]);

  const fecharAba = useCallback((id: string) => {
    setAbas((atuais) => {
      let restantes = atuais.filter((aba) => aba.id !== id);
      if (restantes.length === 0) {
        restantes = [{ id: `sessao-${Date.now()}`, tabKey: gerarTabKey(), titulo: "Nova conversa", criadoEm: Date.now() }];
      }
      if (sessaoAtivaId === id) selecionarAba(restantes[0]!.id);
      salvarAbasWorkspace(wsId, restantes);
      return restantes;
    });
  }, [selecionarAba, sessaoAtivaId, wsId]);

  const contextoInicial = useMemo(() => {
    if (!location.pathname.endsWith("/fluxos")) return [];
    const fluxoId = new URLSearchParams(location.search).get("fluxo")?.trim();
    return fluxoId ? [{ id: `flow:${fluxoId}`, tipo: "flow" as const, rotulo: `#flow:${fluxoId}`, detalhe: "Fluxo aberto no Studio" }] : [];
  }, [location.pathname, location.search]);

  if (!aberto) return null;

  return (
    <div
      data-testid="secretario-dock"
      role="dialog"
      aria-label="Secretário Executivo"
      className="fixed inset-y-0 right-0 z-50 flex flex-col w-full sm:w-[480px] lg:w-[540px] bg-zinc-950 border-l border-zinc-800 shadow-2xl animate-in slide-in-from-right duration-200">
      {/* Header do Dock */}
      <div className="flex items-center justify-between h-14 px-4 bg-zinc-900/80 border-b border-zinc-800 shrink-0 backdrop-blur-xs">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-950/60 shrink-0">
            <Bot size={17} />
          </div>

          <div className="flex flex-col">
            <div className="flex items-center gap-2">
              <span className="font-bold text-xs text-zinc-100">Secretário Executivo</span>
              <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-emerald-950 border border-emerald-800/60 text-emerald-400 font-bold">
                Ctrl+J
              </span>
            </div>
            <span className="text-[10px] text-zinc-500 font-mono">Assistente Operacional Residente</span>
          </div>
        </div>

        <div className="flex items-center gap-1">
          {/* Botão Tela Cheia com preservação de sessão */}
          <button
            type="button"
            onClick={() => {
              aoFechar();
              navigate(
                workspacePath(
                  wsId,
                  "secretario",
                  sessaoAtivaId ? { sessao: sessaoAtivaId } : undefined,
                ),
              );
            }}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Expandir para tela cheia (/secretario)"
          >
            <Maximize2 size={15} />
          </button>

          {/* Botão Fechar */}
          <button
            type="button"
            onClick={aoFechar}
            data-testid="secretario-dock-fechar"
            aria-label="Fechar Secretário"
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Fechar (Esc ou Ctrl+J)"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      <OpenCodeTabsHeader
        abas={abas}
        sessaoAtivaId={sessaoAtivaId}
        aoSelecionarAba={selecionarAba}
        aoFecharAba={fecharAba}
        aoNovaAba={novaAba}
        workspaceId={wsId}
        modeloAtivo={modeloAtivo}
        onAbrirHistorico={() => setHistoricoAberto(true)}
        onAbrirConfiguracoes={() => setConfigLateralAberta(true)}
      />

      {/* Conteúdo: Chat do Secretário com sessão ativa */}
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <SecretarioChat
          key={sessaoAtivaId}
          emDock
          sessaoId={sessaoAtivaId}
          contextoInicial={contextoInicial}
          aoAtualizarTitulo={(sid, titulo) => setAbas((atuais) => {
            const proximas = atualizarAbaAtiva(atuais, sid, { titulo });
            salvarAbasWorkspace(wsId, proximas);
            return proximas;
          })}
          aoSessaoCriada={(sid) => {
            setAbas((atuais) => {
              const proximas = atualizarAbaAtiva(atuais, sessaoAtivaId, { id: sid });
              salvarAbasWorkspace(wsId, proximas);
              return proximas;
            });
            selecionarAba(sid);
          }}
        />
      </div>
      <HistoricoModal
        open={historicoAberto}
        onOpenChange={setHistoricoAberto}
        sessoes={abas.map((aba) => ({ id: aba.id, titulo: aba.titulo, criado_em: aba.criadoEm }))}
        sessaoAtivaId={sessaoAtivaId}
        onSelecionarSessao={selecionarAba}
        onNovaConversa={novaAba}
        onExcluirSessao={fecharAba}
      />
      <SecretarioSettingsDrawer
        aberto={configLateralAberta}
        onFechar={() => setConfigLateralAberta(false)}
        workspaceId={wsId}
        modeloAtivo={modeloAtivo}
        onAplicarModelo={setModeloAtivo}
      />
    </div>
  );
};
