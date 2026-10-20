import React, { useState, useEffect, useMemo, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { OpenCodeTabsHeader } from "../components/OpenCodeTabsHeader.js";
import { useAbasSecretario } from "../hooks/useAbasSecretario.js";
import { HistoricoModal } from "../components/HistoricoModal.js";
import { SecretarioChat } from "../components/SecretarioChat.js";
import { SecretarioSettingsDrawer } from "../components/SecretarioSettingsDrawer.js";
import { obterAuthHeaders } from "../runtime/secretary-runtime-adapter.js";

export const SecretarioView: FC = () => {
  const { workspaceId } = useOpenCorp();
  const wsId = workspaceId || "default";

  const [searchParams, setSearchParams] = useSearchParams();
  const sessaoParam = searchParams.get("sessao");

  const adaptador = useMemo(
    () => ({
      ativaId: sessaoParam,
      definirAtiva: (id: string, { substituir }: { substituir: boolean }) =>
        setSearchParams(
          (prev) => {
            const next = new URLSearchParams(prev);
            next.set("sessao", id);
            return next;
          },
          { replace: substituir },
        ),
    }),
    [sessaoParam, setSearchParams],
  );
  const {
    abas,
    sessaoAtivaId,
    selecionar: aoSelecionarAba,
    nova: aoNovaAba,
    fechar: aoFecharAba,
    atualizarTitulo: aoAtualizarTitulo,
    aoSessaoCriada,
  } = useAbasSecretario(wsId, adaptador);

  const [historicoAberto, setHistoricoAberto] = useState<boolean>(false);
  const [configLateralAberta, setConfigLateralAberta] = useState<boolean>(false);
  const [gitBranch, setGitBranch] = useState<string>("main");
  const [modeloAtivo, setModeloAtivo] = useState<string>("opencode/nemotron-3.5-lightning-free");

  // Sincroniza branch git do workspace
  useEffect(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4100";
    fetch(`${origin}/workspaces/git/status?workspace=${encodeURIComponent(wsId)}`, {
      headers: {
        ...obterAuthHeaders(),
        ...(wsId ? { "x-opencorp-workspace": wsId } : {}),
      },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.branch) setGitBranch(data.branch);
      })
      .catch(() => {});
  }, [wsId]);

  const abaAtiva = abas.find((a) => a.id === sessaoAtivaId) || abas[0];
  const chatKey = abaAtiva?.tabKey || abaAtiva?.id || "default";

  return (
    <div className="flex flex-col h-full w-full bg-zinc-950 overflow-hidden relative">
      <OpenCodeTabsHeader
        abas={abas}
        sessaoAtivaId={sessaoAtivaId}
        aoSelecionarAba={aoSelecionarAba}
        aoFecharAba={aoFecharAba}
        aoNovaAba={aoNovaAba}
        workspaceId={wsId}
        gitBranch={gitBranch}
        modeloAtivo={modeloAtivo}
        onAbrirHistorico={() => setHistoricoAberto(true)}
        onAbrirConfiguracoes={() => setConfigLateralAberta(true)}
      />
      <div className="flex-1 min-h-0 overflow-hidden relative">
        <SecretarioChat
          key={chatKey}
          sessaoId={sessaoAtivaId || undefined}
          aoAtualizarTitulo={aoAtualizarTitulo}
          aoSessaoCriada={aoSessaoCriada}
        />
      </div>
      <HistoricoModal
        open={historicoAberto}
        onOpenChange={setHistoricoAberto}
        sessoes={abas.map((a) => ({
          id: a.id,
          titulo: a.titulo,
          criado_em: a.criadoEm,
        }))}
        sessaoAtivaId={sessaoAtivaId}
        onSelecionarSessao={aoSelecionarAba}
        onNovaConversa={aoNovaAba}
        onExcluirSessao={aoFecharAba}
      />
      <SecretarioSettingsDrawer
        aberto={configLateralAberta}
        onFechar={() => setConfigLateralAberta(false)}
        workspaceId={wsId}
        modeloAtivo={modeloAtivo}
        onAplicarModelo={(m) => setModeloAtivo(m)}
      />
    </div>
  );
};
