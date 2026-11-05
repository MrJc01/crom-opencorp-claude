import React, { useState, useEffect, useCallback, useMemo, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Settings,
  Cpu,
  Key,
  Shield,
  CircleCheck,
  Bot,
  Activity,
  Layers,
  Coins,
  Clock,
  Folder,
  Users,
  Wrench,
  Stethoscope,
  Terminal,
  Sliders,
} from "lucide-react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import type { TabConfigId, EntradaSettingsRow } from "../types.js";
import {
  ScopeSelector,
  TabEngines,
  TabModels,
  TabSecrets,
  TabSecurityBudget,
  TabDoctor,
  TabRunner,
  TabSkillsTools,
  TabGeneral,
} from "../components/index.js";
import { ProvedoresGratisSecao } from "../components/ProvedoresGratisSecao.js";

export const ABAS_CONFIG: Array<{ id: TabConfigId; label: string; icon: any }> = [
  { id: "motores", label: "Motores & Provedores", icon: Bot },
  { id: "limites", label: "Limites dos Motores", icon: Activity },
  { id: "modelos", label: "Modelos", icon: Cpu },
  { id: "orcamento", label: "Orçamento", icon: Coins },
  { id: "seguranca", label: "Segurança", icon: Shield },
  { id: "scheduler", label: "Scheduler", icon: Clock },
  { id: "workspace", label: "Workspace", icon: Folder },
  { id: "testes", label: "Testes", icon: CircleCheck },
  { id: "reunioes", label: "Reuniões", icon: Users },
  { id: "chaves", label: "Chaves de API & Secrets", icon: Key },
  { id: "ferramentas", label: "Ferramentas", icon: Wrench },
  { id: "geral", label: "Geral", icon: Settings },
  { id: "doctor", label: "Doctor SRE", icon: Stethoscope },
  { id: "runner", label: "Runner Daemon", icon: Terminal },
];

export const ConfigView: FC = () => {
  const { client, workspaceId, tratarErro } = useOpenCorp();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = (searchParams.get("tab") as TabConfigId) || "motores";
  const [abaAtiva, setAbaAtivaState] = useState<TabConfigId>(tabParam);

  // Escopo de Configuração: Global vs Workspace
  const [escopoConfig, setEscopoConfig] = useState<"global" | "workspace">("global");
  const [todasEntradas, setTodasEntradas] = useState<EntradaSettingsRow[]>([]);
  const [salvando, setSalvando] = useState(false);

  // Workspace efetivo
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

  // Sincroniza tab com searchParams
  const setAbaAtiva = useCallback(
    (tab: TabConfigId) => {
      setAbaAtivaState(tab);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", tab);
        return next;
      });
    },
    [setSearchParams]
  );

  useEffect(() => {
    if (searchParams.get("tab") && searchParams.get("tab") !== abaAtiva) {
      setAbaAtivaState(searchParams.get("tab") as TabConfigId);
    }
  }, [searchParams, abaAtiva]);

  // Carrega configurações gerais do escopo ativo
  const carregarSettings = useCallback(async () => {
    try {
      const data = await client.http.get<any>(`/settings?escopo=${escopoConfig}`, {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      if (Array.isArray(data)) {
        setTodasEntradas(data);
      } else if (data && Array.isArray(data.dados)) {
        setTodasEntradas(data.dados);
      }
    } catch (err: unknown) {
      // Silencioso se settings iniciais vazios
    }
  }, [client, escopoConfig, wsEfetivo]);

  // Salva chave com persistência no backend via PUT /settings
  const salvarChaveConfig = async (chave: string, valor: unknown) => {
    setSalvando(true);
    try {
      const vFinal: string =
        typeof valor === "object" && valor !== null
          ? JSON.stringify(valor)
          : String(valor);

      await client.http.put(
        "/settings",
        {
          chave,
          valor: vFinal,
          scope: escopoConfig,
        },
        {
          headers: { "x-opencorp-workspace": wsEfetivo },
        }
      );

      showToast(`Configuração "${chave}" salva!`, "sucesso");
      await carregarSettings();
    } catch (err: unknown) {
      tratarErro(err, `Erro ao salvar configuração "${chave}"`);
    } finally {
      setSalvando(false);
    }
  };

  useEffect(() => {
    void carregarSettings();
  }, [carregarSettings]);

  return (
    <div className="flex flex-col h-full p-4 sm:p-6 md:p-8 space-y-5 overflow-y-auto overflow-x-hidden scrollbar-thin select-text">
      {/* CABEÇALHO DA CENTRAL & SELETOR DE ESCOPO */}
      <div className="pb-3 border-b border-zinc-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-zinc-100 tracking-tight flex items-center gap-2">
            <Settings className="text-orange-500" size={20} />
            <span>Configurações &amp; Governança do Sistema</span>
          </h1>
          <p className="text-xs text-zinc-400 mt-0.5">
            Governança de parâmetros xB, motores de agentes autônomos, inferência direta e catálogo de inteligência.
          </p>
        </div>

        {/* SELETOR DE ESCOPO DUAL */}
        <ScopeSelector
          escopo={escopoConfig}
          onMudarEscopo={(novo) => {
            setEscopoConfig(novo);
          }}
          workspaceId={wsEfetivo}
        />
      </div>

      {/* BARRA DE NAVEGAÇÃO DAS 14 ABAS */}
      <div className="flex items-center gap-1.5 border-b border-zinc-850 pb-2.5 shrink-0 overflow-x-auto scrollbar-none sm:flex-wrap">
        {ABAS_CONFIG.map((aba) => {
          const Icon = aba.icon;
          const ativa = abaAtiva === aba.id;

          return (
            <button
              key={aba.id}
              type="button"
              onClick={() => setAbaAtiva(aba.id)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-xl transition-all flex items-center gap-1.5 cursor-pointer shrink-0 whitespace-nowrap ${
                ativa
                  ? "text-orange-400 bg-zinc-850 border border-zinc-700 shadow-sm"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850/60"
              }`}
            >
              <Icon size={14} className={ativa ? "text-orange-400" : "text-zinc-500"} />
              <span>{aba.label}</span>
            </button>
          );
        })}
      </div>

      {/* CONTEÚDO DAS ABAS MODULARES */}
      <div className="w-full max-w-6xl space-y-6 flex-1 min-h-0">
        {(abaAtiva === "motores" || abaAtiva === "limites") && (
          <TabEngines
            abaAtiva={abaAtiva}
            escopoConfig={escopoConfig}
            wsAtivo={wsEfetivo}
            onGoToKeysTab={() => setAbaAtiva("chaves")}
          />
        )}

        {abaAtiva === "motores" && <ProvedoresGratisSecao />}

        {abaAtiva === "modelos" && (
          <TabModels
            todasEntradas={todasEntradas}
            onSalvarChave={salvarChaveConfig}
            salvando={salvando}
            escopoConfig={escopoConfig}
          />
        )}

        {(abaAtiva === "orcamento" || abaAtiva === "seguranca") && (
          <TabSecurityBudget
            abaAtiva={abaAtiva}
            todasEntradas={todasEntradas}
            onSalvarChave={salvarChaveConfig}
            salvando={salvando}
          />
        )}

        {abaAtiva === "chaves" && (
          <TabSecrets escopoConfig={escopoConfig} />
        )}

        {abaAtiva === "ferramentas" && <TabSkillsTools />}

        {["scheduler", "workspace", "testes", "reunioes", "geral"].includes(abaAtiva) && (
          <TabGeneral
            abaAtiva={abaAtiva}
            todasEntradas={todasEntradas}
            onSalvarChave={salvarChaveConfig}
            salvando={salvando}
          />
        )}

        {abaAtiva === "doctor" && <TabDoctor />}

        {abaAtiva === "runner" && <TabRunner />}
      </div>
    </div>
  );
};
