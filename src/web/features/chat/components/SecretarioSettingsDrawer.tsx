import React, { useState, useEffect, type FC } from "react";
import {
  X,
  Cpu,
  Bot,
  RefreshCw,
  Check,
  AlertCircle,
  Play,
  Info,
} from "lucide-react";
import { obterAuthHeaders } from "../runtime/secretary-runtime-adapter.js";
import { ModelPicker } from "../../../shared/ui/ModelPicker.js";

export const MODELOS_PRESETS_POPULARES = [
  "opencode/nemotron-3.5-lightning-free",
  "opencode/nemotron-3-ultra-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/ling-3.0-flash-fin-free",
  "opencode/muse-spark-1.3-contributor-free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/qwen/qwen3.8-27b:free",
  "openrouter/google/gemma-4-31b-it:free",
  "openrouter/z-ai/glm-5.2:free",
  "openrouter/cohere/north-mini-code:free",
  "openrouter/thinkingmachines/inkling:free",
];

const ROTACAO_PADRAO = [...MODELOS_PRESETS_POPULARES];

export interface AgenteItem {
  id: string;
  role?: string;
  harness?: string;
  motor?: string;
}

export interface SecretarioSettingsDrawerProps {
  aberto: boolean;
  onFechar: () => void;
  workspaceId: string;
  modeloAtivo?: string;
  onAplicarModelo?: (modelo: string) => void;
  agenteAtivo?: string | null;
  onAplicarAgente?: (agente: string) => void;
}

export const SecretarioSettingsDrawer: FC<SecretarioSettingsDrawerProps> = ({
  aberto,
  onFechar,
  workspaceId,
  modeloAtivo = "opencode/nemotron-3.5-lightning-free",
  onAplicarModelo,
  agenteAtivo = "secretario",
  onAplicarAgente,
}) => {
  const [agentes, setAgentes] = useState<AgenteItem[]>([]);
  const [agenteSelecionado, setAgenteSelecionado] = useState<string>(agenteAtivo || "secretario");
  const [modeloPrincipal, setModeloPrincipal] = useState<string>(modeloAtivo);
  const [rotacaoModelos, setRotacaoModelos] = useState<string[]>(
    ROTACAO_PADRAO,
  );

  // Estados de teste de conectividade
  const [testando, setTestando] = useState<boolean>(false);
  const [motorInfo, setMotorInfo] = useState<{
    engineId: string;
    nome?: string;
    origem: string;
    suportaConversa: boolean;
    preflight?: {
      ok: boolean;
      installed: boolean;
      authenticated: boolean;
      issues: string[];
      recommendation?: string;
    };
  } | null>(null);
  const [resultadoTeste, setResultadoTeste] = useState<{
    ok: boolean;
    msg: string;
    latencyMs?: number;
  } | null>(null);

  // Estados de salvamento
  const [salvando, setSalvando] = useState<boolean>(false);
  const [salvoSucesso, setSalvoSucesso] = useState<boolean>(false);

  useEffect(() => {
    if (!aberto) return;
    const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4100";
    const headers = {
      "Content-Type": "application/json",
      ...obterAuthHeaders(),
      ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
    };

    // Carrega agentes do workspace
    fetch(`${origin}/agents?workspace=${encodeURIComponent(workspaceId)}`, { headers })
      .then((res) => (res.ok ? res.json() : []))
      .then((data) => {
        if (Array.isArray(data)) {
          setAgentes(data);
        }
      })
      .catch(() => {});

    // Carrega status e motor do Secretário
    fetch(`${origin}/secretario/status?workspace=${encodeURIComponent(workspaceId)}`, { headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.motor) {
          setMotorInfo(data.motor);
        }
      })
      .catch(() => {});

    fetch(`${origin}/settings/secretary.model?workspace=${encodeURIComponent(workspaceId)}`, { headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.valor === "string") setModeloPrincipal(data.valor);
      })
      .catch(() => {});
    fetch(`${origin}/settings/secretary.agent?workspace=${encodeURIComponent(workspaceId)}`, { headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (typeof data?.valor === "string") setAgenteSelecionado(data.valor);
      })
      .catch(() => {});
    fetch(`${origin}/settings/modelos?workspace=${encodeURIComponent(workspaceId)}`, { headers })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (Array.isArray(data?.rotation)) setRotacaoModelos(data.rotation);
      })
      .catch(() => {});
  }, [aberto, workspaceId]);

  if (!aberto) return null;

  const testarConexao = async () => {
    setTestando(true);
    setResultadoTeste(null);
    const inicio = Date.now();
    const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4100";

    try {
      const res = await fetch(`${origin}/secretario/status?workspace=${encodeURIComponent(workspaceId)}`, {
        headers: {
          ...obterAuthHeaders(),
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
      });
      const latencia = Date.now() - inicio;

      if (res.ok) {
        const data = await res.json().catch(() => null);
        const m = data?.motor;
        if (m) {
          setMotorInfo(m);
          const nomeMotor = m.nome || m.engineId || "padrão";
          const origemStr = m.origem === "workspace_override" ? "override do workspace" : "padrão global";
          if (m.preflight && !m.preflight.ok) {
            const motivos = m.preflight.issues?.join("; ") || "preflight reprovado";
            const dica = m.preflight.recommendation ? ` Dica: ${m.preflight.recommendation}` : "";
            setResultadoTeste({
              ok: false,
              msg: `Motor [${nomeMotor}] (${origemStr}): ${motivos}.${dica}`,
              latencyMs: latencia,
            });
          } else {
            setResultadoTeste({
              ok: true,
              msg: `Motor [${nomeMotor}] (${origemStr}) operacional e pronto para conversação.`,
              latencyMs: latencia,
            });
          }
        } else {
          setResultadoTeste({
            ok: true,
            msg: `Conexão estabelecida com sucesso. Motor operacional.`,
            latencyMs: latencia,
          });
        }
      } else {
        setResultadoTeste({
          ok: false,
          msg: `Servidor respondeu com código HTTP ${res.status}.`,
          latencyMs: latencia,
        });
      }
    } catch (err: any) {
      setResultadoTeste({
        ok: false,
        msg: `Falha na requisição de diagnóstico: ${err.message}`,
        latencyMs: Date.now() - inicio,
      });
    } finally {
      setTestando(false);
    }
  };

  const salvarNoWorkspace = async () => {
    setSalvando(true);
    setSalvoSucesso(false);
    const origin = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:4100";
    const listaRotacao = rotacaoModelos.map((modelo) => modelo.trim()).filter(Boolean);

    try {
      const opcoes = {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...obterAuthHeaders(),
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
      };
      const respostas = await Promise.all([
        fetch(`${origin}/settings?workspace=${encodeURIComponent(workspaceId)}`, {
          ...opcoes,
          body: JSON.stringify({ chave: "secretary.model", valor: modeloPrincipal, scope: "workspace" }),
        }),
        fetch(`${origin}/settings?workspace=${encodeURIComponent(workspaceId)}`, {
          ...opcoes,
          body: JSON.stringify({ chave: "secretary.agent", valor: agenteSelecionado, scope: "workspace" }),
        }),
        fetch(`${origin}/settings/modelos?workspace=${encodeURIComponent(workspaceId)}`, {
          ...opcoes,
          body: JSON.stringify({ rotation: listaRotacao, escopo: "workspace" }),
        }),
      ]);
      if (respostas.some((res) => !res.ok)) throw new Error("Falha ao persistir configurações do Secretário");

      onAplicarModelo?.(modeloPrincipal);
      onAplicarAgente?.(agenteSelecionado);
      setSalvoSucesso(true);
      setTimeout(() => {
        setSalvoSucesso(false);
        onFechar();
      }, 700);
    } catch (erro) {
      setResultadoTeste({ ok: false, msg: erro instanceof Error ? erro.message : "Falha ao salvar" });
    } finally {
      setSalvando(false);
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 bg-black/60 z-40 backdrop-blur-xs transition-opacity"
        onClick={onFechar}
      />
      <aside
        data-testid="drawer-lateral-config"
        className="fixed inset-y-0 right-0 w-84 sm:w-105 bg-zinc-950/95 border-l border-zinc-800/80 shadow-2xl z-50 flex flex-col backdrop-blur-md animate-in slide-in-from-right duration-200 text-zinc-100"
      >
        {/* Header do Drawer */}
        <div className="h-12 px-4 border-b border-zinc-800/80 flex items-center justify-between bg-zinc-900/40 select-none">
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-emerald-400" />
            <span className="font-semibold text-sm text-zinc-100">
              Configurações do Secretário
            </span>
          </div>
          <button
            type="button"
            onClick={onFechar}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Fechar painel"
          >
            <X size={15} />
          </button>
        </div>

        {/* Conteúdo rolável */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin text-xs">
          {/* Escolha do Agente Supervisor */}
          <div className="space-y-1.5">
            <label className="font-medium text-zinc-300 block">
              Agente Supervisor do Workspace
            </label>
            <select
              className="w-full bg-zinc-900 border border-zinc-700/80 rounded-lg px-3 py-2 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500/80 cursor-pointer font-sans"
              value={agenteSelecionado}
              onChange={(e) => setAgenteSelecionado(e.target.value)}
            >
              <option value="secretario">secretario — Supervisor Executivo</option>
              {agentes.map((ag) => (
                <option key={ag.id} value={ag.id}>
                  {ag.id} — {ag.role || ag.id}{ag.harness || ag.motor ? ` (${ag.harness || ag.motor})` : ""}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-zinc-500">
              Selecione o agente que lidera as tomadas de decisão e orquestração do workspace.
            </p>
          </div>

          {/* Modelo Principal */}
          <div className="space-y-1.5">
            <label className="font-medium text-zinc-300 block">Modelo Principal</label>
            <ModelPicker value={modeloPrincipal} onChange={setModeloPrincipal} />
          </div>

          {/* Rotação e Fallback de Modelos */}
          <div className="space-y-1.5">
            <label className="font-medium text-zinc-300 block">
              Cadeia de Rotação / Fallback Autônomo
            </label>
            <ModelPicker value={rotacaoModelos} onChange={setRotacaoModelos} multiple />

            <div className="p-2.5 rounded-lg bg-zinc-900/40 border border-zinc-800/80 space-y-1">
              <div className="flex items-center gap-1 text-zinc-300 font-medium">
                <Info size={12} className="text-emerald-400" />
                <span>Rotação Autônoma do Backend:</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-snug">
                Informe 1 modelo por linha na ordem de prioridade. Em caso de esgotamento de cotas, rate limit ou timeout, o motor rotaciona automaticamente.
              </p>
            </div>
          </div>

          {/* Motor Conversacional Efetivo */}
          <div className="space-y-1.5 pt-1 border-t border-zinc-800/80">
            <div className="flex items-center justify-between">
              <label className="font-medium text-zinc-300 block">Motor Conversacional Ativo</label>
              {motorInfo && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60 font-mono">
                  {motorInfo.origem === "workspace_override" ? "Override do Workspace" : "Padrão Global"}
                </span>
              )}
            </div>
            <div className="p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/90 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${motorInfo?.preflight?.ok ? "bg-emerald-400 animate-pulse" : motorInfo ? "bg-amber-400" : "bg-zinc-500"}`} />
                <div>
                  <span className="font-semibold text-zinc-200">
                    {motorInfo?.nome || motorInfo?.engineId || "OpenCode Engine"}
                  </span>
                  <p className="text-[10px] text-zinc-400">
                    {motorInfo?.suportaConversa
                      ? "Suporte nativo a sessões contínuas"
                      : "Sem suporte conversacional interativo"}
                  </p>
                </div>
              </div>
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded ${
                motorInfo?.preflight?.ok
                  ? "bg-emerald-950/40 text-emerald-300 border border-emerald-800/50"
                  : motorInfo
                  ? "bg-amber-950/40 text-amber-300 border border-amber-800/50"
                  : "bg-zinc-800 text-zinc-400"
              }`}>
                {motorInfo?.preflight?.ok ? "Pronto" : motorInfo ? "Atenção" : "Pendente"}
              </span>
            </div>
          </div>

          {/* Área de Diagnóstico de Conexão */}
          <div className="pt-2 border-t border-zinc-800/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-medium text-zinc-300">Diagnóstico de Conectividade</span>
              <button
                type="button"
                onClick={testarConexao}
                disabled={testando}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-200 border border-zinc-700/70 text-xs transition-colors cursor-pointer disabled:opacity-50"
              >
                {testando ? (
                  <RefreshCw size={12} className="animate-spin text-emerald-400" />
                ) : (
                  <Play size={12} className="text-emerald-400" />
                )}
                <span>{testando ? "Testando..." : "Testar Conexão"}</span>
              </button>
            </div>

            {resultadoTeste && (
              <div
                className={`p-2.5 rounded-lg border text-xs flex items-start gap-2 ${
                  resultadoTeste.ok
                    ? "bg-emerald-950/20 border-emerald-800/60 text-emerald-300"
                    : "bg-rose-950/20 border-rose-800/60 text-rose-300"
                }`}
              >
                {resultadoTeste.ok ? (
                  <Check size={15} className="shrink-0 mt-0.5 text-emerald-400" />
                ) : (
                  <AlertCircle size={15} className="shrink-0 mt-0.5 text-rose-400" />
                )}
                <div className="space-y-0.5">
                  <p className="font-medium">{resultadoTeste.msg}</p>
                  {resultadoTeste.latencyMs !== undefined && (
                    <p className="text-[10px] text-zinc-400 font-mono">
                      Latência: {resultadoTeste.latencyMs}ms
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Rodapé de Ações */}
        <div className="p-3 border-t border-zinc-800/80 flex items-center justify-between gap-2 bg-zinc-900/60">
          <button
            type="button"
            onClick={onFechar}
            className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer text-xs"
          >
            Cancelar
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                onAplicarModelo?.(modeloPrincipal);
                onAplicarAgente?.(agenteSelecionado);
                onFechar();
              }}
              className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700/60 transition-colors cursor-pointer text-xs font-medium"
              title="Apenas direciona o chat atual para este modelo e rotação em memória"
            >
              Aplicar ao Chat
            </button>
            <button
              type="button"
              onClick={salvarNoWorkspace}
              disabled={salvando}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors cursor-pointer text-xs font-medium shadow-md shadow-emerald-950/50 disabled:opacity-50"
              title="Grava o modelo e a lista de rotação permanentemente no workspace"
            >
              {salvando ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : salvoSucesso ? (
                <Check size={13} />
              ) : null}
              <span>{salvando ? "Salvando..." : salvoSucesso ? "Salvo!" : "Salvar no Workspace"}</span>
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};
