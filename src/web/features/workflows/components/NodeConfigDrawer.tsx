import React, { useState, useEffect, useMemo, type FC } from "react";
import {
  X,
  Trash2,
  Check,
  Code,
  Sliders,
  Cpu,
  Clock,
  Terminal,
  Layers,
  HelpCircle,
  Copy,
  AlertCircle,
  Sparkles,
  Webhook,
  RefreshCw,
  Hourglass,
  Globe,
  Code2,
  FileText,
  CheckCircle,
  Users,
  Play,
  Loader2,
  Search,
  FlaskConical,
  CheckCircle2,
  XCircle,
  GitBranch,
  ArrowRight,
  ArrowLeft,
  Plus,
} from "lucide-react";
import type { NoGrafo, FluxoCompleto } from "../types.js";
import { obterItemCatalogo } from "../catalog.js";
import { showToast } from "../../../shared/ui/Toast.js";
import { CronBuilder } from "./CronBuilder.js";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";

export interface NodeConfigDrawerProps {
  no: NoGrafo | null;
  fluxo: FluxoCompleto | null;
  agentes: any[];
  fluxosExistentes: FluxoCompleto[];
  arestas?: Array<{ id?: string; source?: string; target?: string; de?: string; para?: string; label?: string; condicao?: string }>;
  nosDisponiveis?: Array<{ id: string; nome?: string; tipo: string }>;
  aoRemoverAresta?: (origemOuId: string, destino?: string) => void;
  aoAdicionarAresta?: (origem: string, destino: string, label?: string) => void;
  onClose: () => void;
  onSalvarNo: (noAtualizado: NoGrafo) => void;
  onExcluirNo: (noId: string) => void;
}

export const NodeConfigDrawer: FC<NodeConfigDrawerProps> = ({
  no,
  fluxo,
  agentes,
  fluxosExistentes,
  arestas,
  nosDisponiveis,
  aoRemoverAresta,
  aoAdicionarAresta,
  onClose,
  onSalvarNo,
  onExcluirNo,
}) => {
  const [modo, setModo] = useState<"form" | "json">("form");
  const [noEditado, setNoEditado] = useState<NoGrafo | null>(null);
  const [jsonText, setJsonText] = useState("");
  const [jsonErro, setJsonErro] = useState<string | null>(null);

  // Contexto OpenCorp (opcional, com fallback seguro)
  let contextClient: any = null;
  let contextWs: string = "default";
  try {
    const ctx = useOpenCorp();
    if (ctx) {
      contextClient = ctx.client;
      contextWs = ctx.workspaceId || "default";
    }
  } catch {
    // Isolamento para testes unitários ou render sem provider
  }

  // Componentes do Workspace
  const [componentes, setComponentes] = useState<any[]>([]);
  const [carregandoComponentes, setCarregandoComponentes] = useState(false);

  // Teste Unitário Isolado do Componente
  const [entradaTesteComp, setEntradaTesteComp] = useState('{"parametro": "valor"}');
  const [testandoComp, setTestandoComp] = useState(false);
  const [resultadoTesteComp, setResultadoTesteComp] = useState<{
    ok: boolean;
    saida?: any;
    json?: any;
    erro?: string;
    duracao_ms?: number;
  } | null>(null);

  // Tarefas Kanban (para task_create)
  const [tasksExistentes, setTasksExistentes] = useState<any[]>([]);
  const [buscaTask, setBuscaTask] = useState("");

  // Sincroniza estado quando o nó selecionado muda
  useEffect(() => {
    if (no) {
      setNoEditado(JSON.parse(JSON.stringify(no)));
      setJsonText(JSON.stringify(no, null, 2));
      setJsonErro(null);
      setResultadoTesteComp(null);
    } else {
      setNoEditado(null);
    }
  }, [no]);

  // Efeito para carregar componentes quando nó for do tipo "componente"
  useEffect(() => {
    if (no?.tipo === "componente" && contextClient?.http) {
      setCarregandoComponentes(true);
      contextClient.http
        .get("/components", {
          headers: { "x-opencorp-workspace": contextWs },
        })
        .then((res: any) => {
          if (Array.isArray(res)) setComponentes(res);
          else if (res && Array.isArray(res.componentes)) setComponentes(res.componentes);
        })
        .catch(() => {})
        .finally(() => setCarregandoComponentes(false));
    }
  }, [no?.tipo, contextClient, contextWs]);

  // Efeito para carregar tasks quando nó for do tipo "task_create"
  useEffect(() => {
    if (no?.tipo === "task_create" && contextClient) {
      if (typeof contextClient.tasks?.listar === "function") {
        contextClient.tasks
          .listar({ workspaceId: contextWs })
          .then((res: any) => {
            if (Array.isArray(res)) setTasksExistentes(res);
          })
          .catch(() => {});
      } else if (contextClient.http) {
        contextClient.http
          .get("/tasks", { headers: { "x-opencorp-workspace": contextWs } })
          .then((res: any) => {
            if (Array.isArray(res)) setTasksExistentes(res);
          })
          .catch(() => {});
      }
    }
  }, [no?.tipo, contextClient, contextWs]);

  // Lista de antecessores para o session_from
  const antecessores = useMemo(() => {
    if (!fluxo || !no) return [];
    return (fluxo.arestas || [])
      .filter((a) => a.para === no.id)
      .map((a) => a.de);
  }, [fluxo, no]);

  // Estados para nova conexão rápida (n8n-style)
  const [novoDestinoLigacao, setNovoDestinoLigacao] = useState("");
  const [novaCondicaoLigacao, setNovaCondicaoLigacao] = useState("");

  // Arestas consolidadas
  const arestasConsolidadas = useMemo(() => {
    if (arestas && Array.isArray(arestas) && arestas.length > 0) return arestas;
    return fluxo?.arestas || [];
  }, [arestas, fluxo]);

  // Ligações de Entrada (target === no.id ou para === no.id)
  const entradasConexao = useMemo(() => {
    if (!no) return [];
    return arestasConsolidadas.filter(
      (a) => (a.target || a.para) === no.id
    );
  }, [arestasConsolidadas, no]);

  // Ligações de Saída (source === no.id ou de === no.id)
  const saidasConexao = useMemo(() => {
    if (!no) return [];
    return arestasConsolidadas.filter(
      (a) => (a.source || a.de) === no.id
    );
  }, [arestasConsolidadas, no]);

  // Lista de nós disponíveis para ligar
  const listaNosParaLigar = useMemo(() => {
    if (nosDisponiveis && Array.isArray(nosDisponiveis) && nosDisponiveis.length > 0) {
      return nosDisponiveis.filter((n) => n.id !== no?.id);
    }
    return (fluxo?.nos || []).filter((n) => n.id !== no?.id);
  }, [nosDisponiveis, fluxo, no]);

  if (!no || !noEditado) return null;

  const catalogo = obterItemCatalogo(noEditado.tipo);
  const Icone = catalogo.icone;
  const config = noEditado.config || {};

  const atualizarConfig = (campo: string, valor: any) => {
    const novoNo = {
      ...noEditado,
      config: {
        ...(noEditado.config || {}),
        [campo]: valor,
      },
    };
    setNoEditado(novoNo);
    setJsonText(JSON.stringify(novoNo, null, 2));
  };

  const atualizarCampoRaiz = (campo: keyof NoGrafo, valor: any) => {
    const novoNo = {
      ...noEditado,
      [campo]: valor,
    };
    setNoEditado(novoNo);
    setJsonText(JSON.stringify(novoNo, null, 2));
  };

  const handleSalvar = () => {
    if (modo === "json") {
      try {
        const parsed = JSON.parse(jsonText);
        if (!parsed.id || !parsed.tipo) {
          setJsonErro("O nó precisa conter os campos obrigatórios 'id' e 'tipo'.");
          return;
        }
        onSalvarNo(parsed);
        showToast(`Nó "${parsed.id}" atualizado com sucesso!`, "sucesso");
      } catch (err: any) {
        setJsonErro(`Erro de sintaxe JSON: ${err.message}`);
        return;
      }
    } else {
      onSalvarNo(noEditado);
      showToast(`Nó "${noEditado.id}" atualizado com sucesso!`, "sucesso");
    }
  };

  const handleExecutarTesteComponente = async () => {
    if (!noEditado) return;
    const cfg = noEditado.config || {};
    const componenteId = cfg.componente_id;
    if (!componenteId && !cfg.codigo && !cfg.arquivo) {
      showToast("Selecione um componente ou forneça código/arquivo para testar", "aviso");
      return;
    }

    setTestandoComp(true);
    setResultadoTesteComp(null);
    const inicio = Date.now();

    try {
      let res: any;
      if (componenteId && contextClient?.http) {
        res = await contextClient.http.post(
          `/components/${encodeURIComponent(componenteId)}/test`,
          { entrada: entradaTesteComp },
          { headers: { "x-opencorp-workspace": contextWs } }
        );
      } else if (typeof window !== "undefined") {
        const url = componenteId
          ? `/components/${encodeURIComponent(componenteId)}/test`
          : `/components/test`;
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-opencorp-workspace": contextWs,
          },
          body: JSON.stringify({
            entrada: entradaTesteComp,
            runtime: cfg.runtime || "node",
            codigo: cfg.codigo,
            arquivo: cfg.arquivo,
          }),
        });
        res = await resp.json();
      }

      const duracao = res?.duracao_ms ?? (Date.now() - inicio);
      const ok = res?.ok !== false && !res?.erro;
      setResultadoTesteComp({
        ok,
        saida: res?.saida,
        json: res?.json,
        erro: res?.erro || (!ok ? "Falha na execução do componente" : undefined),
        duracao_ms: duracao,
      });

      if (ok) {
        showToast("Teste unitário executado com sucesso!", "sucesso");
      } else {
        showToast(res?.erro || "Falha na execução do teste", "erro");
      }
    } catch (err: any) {
      const duracao = Date.now() - inicio;
      setResultadoTesteComp({
        ok: false,
        erro: err?.message || "Erro de rede ao executar teste",
        duracao_ms: duracao,
      });
      showToast(err?.message || "Erro ao conectar com o serviço de teste", "erro");
    } finally {
      setTestandoComp(false);
    }
  };

  return (
    <aside
      data-testid="ndv-panel"
      aria-label={`Configuração do nó ${noEditado.id}`}
      className="ndv-panel absolute top-0 right-0 bottom-0 w-full sm:w-[420px] md:w-[440px] max-w-full z-40 bg-zinc-950/95 backdrop-blur-md border-l border-zinc-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-150">
        {/* Topo da Gaveta */}
        <div className="p-4 border-b border-zinc-800 flex items-center justify-between shrink-0 bg-zinc-900/60">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`p-2 rounded-lg border ${catalogo.bg} ${catalogo.borderCor} ${catalogo.cor} shrink-0`}>
              <Icone size={16} />
            </div>
            <div className="min-w-0">
              <h3 className="text-xs font-bold text-zinc-100 font-mono truncate">
                {noEditado.id}
              </h3>
              <p className="text-[10px] text-zinc-400 font-mono">
                Tipo: <span className="text-orange-400 uppercase font-bold">{noEditado.tipo}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Alternador Form vs JSON */}
            <div className="flex items-center bg-zinc-900 border border-zinc-800 rounded-lg p-0.5 text-xs font-mono">
              <button
                type="button"
                onClick={() => setModo("form")}
                className={`px-2.5 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
                  modo === "form" ? "bg-zinc-800 text-white font-bold shadow-xs" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Sliders size={12} />
                <span>Form</span>
              </button>
              <button
                type="button"
                onClick={() => setModo("json")}
                className={`px-2.5 py-1 rounded transition-colors cursor-pointer flex items-center gap-1 ${
                  modo === "json" ? "bg-zinc-800 text-white font-bold shadow-xs" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Code size={12} />
                <span>JSON</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
              title="Fechar Gaveta"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Conteúdo Principal */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin text-xs">
          {modo === "json" ? (
            /* Modo RAW JSON */
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-zinc-300 font-semibold flex items-center gap-1.5">
                  <Code size={14} className="text-orange-400" />
                  Estrutura JSON do Nó
                </label>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(jsonText);
                    showToast("JSON copiado para a área de transferência", "info");
                  }}
                  className="flex items-center gap-1 text-[11px] text-zinc-400 hover:text-zinc-200 cursor-pointer"
                >
                  <Copy size={12} />
                  <span>Copiar</span>
                </button>
              </div>

              {jsonErro && (
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-300 text-xs font-mono">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <span>{jsonErro}</span>
                </div>
              )}

              <textarea
                value={jsonText}
                onChange={(e) => {
                  setJsonText(e.target.value);
                  setJsonErro(null);
                }}
                rows={18}
                className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-3 font-mono text-[11px] text-zinc-200 focus:outline-none focus:border-orange-500 leading-relaxed scrollbar-thin resize-none"
                spellCheck={false}
              />
            </div>
          ) : (
            /* Modo Formulário Tipado */
            <div className="space-y-4">
              {/* Identificação Geral */}
              <div className="space-y-3 p-3 rounded-xl bg-zinc-900/40 border border-zinc-850">
                <h4 className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                  Identificação do Nó
                </h4>
                <div>
                  <label className="block text-zinc-300 font-medium mb-1">
                    ID do Nó (kebab-case)
                  </label>
                  <input
                    type="text"
                    value={noEditado.id}
                    onChange={(e) =>
                      atualizarCampoRaiz(
                        "id",
                        e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-")
                      )
                    }
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono focus:outline-none focus:border-orange-500"
                  />
                </div>

                {/* Barreira de Junção Join */}
                <div>
                  <label className="block text-zinc-300 font-medium mb-1">
                    Barreira de Junção (Join)
                  </label>
                  <select
                    value={noEditado.join || "all"}
                    onChange={(e) =>
                      atualizarCampoRaiz("join", e.target.value as "all" | "any")
                    }
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-orange-500"
                  >
                    <option value="all">all — Aguardar todas as entradas antes de disparar</option>
                    <option value="any">any — Executar imediatamente a cada entrada</option>
                  </select>
                </div>
              </div>

              {/* Campos Contextuais por Tipo */}
              {/* GATILHO CRON */}
              {noEditado.tipo === "cron" && (
                <div className="space-y-3 p-3.5 rounded-xl bg-sky-950/20 border border-sky-800/40">
                  <h4 className="text-[11px] font-bold text-sky-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Clock size={13} />
                    Configuração de Agendamento Cron
                  </h4>

                  <CronBuilder
                    value={config.cron || config.expressao || config.expressao_cron || "*/15 * * * *"}
                    onChange={(cron) => {
                      atualizarConfig("cron", cron);
                      atualizarConfig("expressao_cron", cron);
                    }}
                  />

                  {/* Fuso Horário */}
                  <div className="pt-2 border-t border-sky-900/30">
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Fuso Horário
                    </label>
                    <input
                      type="text"
                      placeholder="America/Sao_Paulo"
                      value={config.timezone || config.fuso || "America/Sao_Paulo"}
                      onChange={(e) => atualizarConfig("timezone", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-sky-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      Referência de fuso horário avaliada pelo scheduler.
                    </span>
                  </div>
                </div>
              )}

              {/* GATILHO WEBHOOK */}
              {noEditado.tipo === "webhook" && (
                <div className="space-y-3 p-3.5 rounded-xl bg-amber-950/20 border border-amber-800/40">
                  <h4 className="text-[11px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Webhook size={13} />
                    Gatilho Webhook (Entrada HTTP)
                  </h4>

                  {/* URL de Disparo */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      URL de Disparo do Webhook
                    </label>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        readOnly
                        value={
                          typeof window !== "undefined" && fluxo?.id
                            ? `${window.location.origin}/flows/${fluxo.id}/webhook`
                            : `/flows/${fluxo?.id || "fluxo"}/webhook`
                        }
                        className="w-full bg-zinc-900/90 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-emerald-400 font-mono text-[11px] select-all focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          if (typeof window !== "undefined" && fluxo?.id) {
                            const url = `${window.location.origin}/flows/${fluxo.id}/webhook`;
                            navigator.clipboard.writeText(url);
                            showToast("URL do webhook copiada para a área de transferência!", "sucesso");
                          }
                        }}
                        className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors cursor-pointer shrink-0"
                        title="Copiar URL do Webhook"
                      >
                        <Copy size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Chave Secreta de Validação */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Chave Secreta / Token de Validação</span>
                      <span className="text-[10px] text-zinc-500 font-mono">opcional</span>
                    </label>
                    <input
                      type="text"
                      placeholder="ex: segredo-super-protegido-123"
                      value={config.secret || config.token || ""}
                      onChange={(e) => {
                        atualizarConfig("secret", e.target.value);
                        atualizarConfig("token", e.target.value);
                      }}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-amber-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      Valida o cabeçalho <code>x-webhook-secret</code> ou parâmetro <code>?token=</code>.
                    </span>
                  </div>

                  {/* Método HTTP Permitido */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Método HTTP Permitido
                    </label>
                    <select
                      value={config.metodo || "POST"}
                      onChange={(e) => atualizarConfig("metodo", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-amber-500"
                    >
                      <option value="POST">POST (Padrão — aceita JSON)</option>
                      <option value="GET">GET (Query Parameters)</option>
                      <option value="ANY">ANY (Qualquer Método)</option>
                    </select>
                  </div>

                  {/* URL Destino opcional */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>URL Destino (para webhook reverso/saída)</span>
                      <span className="text-[10px] text-zinc-500 font-mono">opcional</span>
                    </label>
                    <input
                      type="text"
                      placeholder="ex: https://api.exemplo.com/webhook-callback"
                      value={config.url || ""}
                      onChange={(e) => atualizarConfig("url", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-amber-500"
                    />
                  </div>

                  {/* Box Explicativo */}
                  <div className="p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/40 text-[11px] text-amber-300/90 leading-relaxed">
                    💡 O corpo da requisição JSON recebida é injetado diretamente no fluxo como contexto inicial e fica acessível na variável <code>$OPENCORP_INPUT</code> e <code>{`{{entrada}}`}</code> para os nós seguintes.
                  </div>
                </div>
              )}

              {/* AGENTE IA */}
              {(noEditado.tipo === "agente" ||
                noEditado.tipo === "fanout" ||
                noEditado.tipo === "review" ||
                noEditado.tipo === "debate") && (
                <div className="space-y-3 p-3 rounded-xl bg-emerald-950/20 border border-emerald-800/40">
                  <h4 className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Cpu size={13} />
                    Configuração do Agente IA
                  </h4>

                  {/* Seleção do Agente */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Agente Especializado
                    </label>
                    <select
                      value={config.agente || config.agent || ""}
                      onChange={(e) => atualizarConfig("agente", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-emerald-500"
                    >
                      <option value="">Selecione um agente...</option>
                      {agentes.map((ag) => (
                        <option key={ag.id} value={ag.id}>
                          {ag.nome || ag.id} (@{ag.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Modelo */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Modelo LLM
                    </label>
                    <input
                      type="text"
                      placeholder="ex: nvidia/nemotron-3-super-120b ou gemini-2.5-pro"
                      value={config.modelo || config.model || "nemotron-3-super-120b"}
                      onChange={(e) => atualizarConfig("modelo", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-[11px] focus:outline-none focus:border-emerald-500"
                    />
                  </div>

                  {/* Ordem / Prompt */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Instrução / Ordem da Tarefa
                    </label>
                    <textarea
                      rows={4}
                      placeholder="Descreva detalhadamente o objetivo e contexto que o agente deve executar..."
                      value={config.ordem || config.prompt || config.instrucao || ""}
                      onChange={(e) => atualizarConfig("ordem", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-zinc-200 focus:outline-none focus:border-emerald-500 resize-none leading-relaxed"
                    />
                  </div>

                  {/* Herança de Sessão (session_from) */}
                  {antecessores.length > 0 && (
                    <div>
                      <label className="block text-zinc-300 font-medium mb-1">
                        Herdar Sessão do Nó Antecessor (session_from)
                      </label>
                      <select
                        value={config.session_from || ""}
                        onChange={(e) =>
                          atualizarConfig("session_from", e.target.value || undefined)
                        }
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-emerald-500"
                      >
                        <option value="">Nova sessão independente</option>
                        {antecessores.map((antId) => (
                          <option key={antId} value={antId}>
                            Herdar de: {antId}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {/* LÓGICA / CONDIÇÃO / DECISÃO */}
              {(noEditado.tipo === "condicao" || noEditado.tipo === "decisao") && (
                <div className="space-y-3 p-3 rounded-xl bg-amber-950/20 border border-amber-800/40">
                  <h4 className="text-[11px] font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5">
                    <HelpCircle size={13} />
                    Regra Condicional (Se-Então)
                  </h4>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Expressão Booleana
                    </label>
                    <input
                      type="text"
                      placeholder="ex: ctx.total > 0 ou ctx.status === 'aprovado'"
                      value={config.expressao || config.condicao || ""}
                      onChange={(e) => atualizarConfig("expressao", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-amber-300 font-mono focus:outline-none focus:border-amber-500"
                    />
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    Se a expressão for verdadeira, o fluxo seguirá pela saída verde <span className="text-emerald-400 font-bold">então</span>; senão, pela saída vermelha <span className="text-rose-400 font-bold">senão</span>.
                  </p>
                </div>
              )}

              {/* CONTROLE DE LOOP / ITERAÇÃO */}
              {noEditado.tipo === "loop" && (
                <div className="space-y-3 p-3.5 rounded-xl bg-orange-950/20 border border-orange-800/40">
                  <h4 className="text-[11px] font-bold text-orange-400 uppercase tracking-wider flex items-center gap-1.5">
                    <RefreshCw size={13} />
                    Controle de Loop &amp; Iterador (Ciclo)
                  </h4>

                  {/* Teto Máximo de Segurança */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Teto Máximo de Iterações (Segurança) *</span>
                      <span className="text-[10px] text-orange-400 font-mono">1 a 50 voltas</span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={config.max_iteracoes ?? 3}
                      onChange={(e) =>
                        atualizarConfig(
                          "max_iteracoes",
                          Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), 50)
                        )
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-orange-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      Proteção essencial contra loops infinitos de agentes e consumo descontrolado de tokens.
                    </span>
                  </div>

                  {/* Condição de Parada */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Condição de Parada (Texto ou Expressão)
                    </label>
                    <input
                      type="text"
                      placeholder="ex: SUCESSO ou CONCLUIDO ou resultado.aprovado === true"
                      value={config.condicao_parada || ""}
                      onChange={(e) => atualizarConfig("condicao_parada", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-orange-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      O ciclo é encerrado se o contexto contiver este texto ou satisfizer a condição.
                    </span>
                  </div>

                  {/* Nó de Retorno */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Nó de Retorno do Loop (Próxima Volta)
                    </label>
                    <select
                      value={config.retornar_para || ""}
                      onChange={(e) => atualizarConfig("retornar_para", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-orange-500 font-mono"
                    >
                      <option value="">Selecione o nó para onde retornar...</option>
                      {(fluxo?.nos || [])
                        .filter((n) => n.id !== noEditado.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.id} ({n.tipo})
                          </option>
                        ))}
                    </select>
                  </div>

                  {/* Nó de Saída Final */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Nó de Saída Final (Após o Encerramento do Loop)
                    </label>
                    <select
                      value={config.saida_final || ""}
                      onChange={(e) => atualizarConfig("saida_final", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-orange-500 font-mono"
                    >
                      <option value="">Selecione o nó para saída...</option>
                      {(fluxo?.nos || [])
                        .filter((n) => n.id !== noEditado.id)
                        .map((n) => (
                          <option key={n.id} value={n.id}>
                            {n.id} ({n.tipo})
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              )}

              {/* PAUSA / DELAY */}
              {noEditado.tipo === "delay" && (
                <div className="space-y-3 p-3.5 rounded-xl bg-yellow-950/20 border border-yellow-800/40">
                  <h4 className="text-[11px] font-bold text-yellow-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Hourglass size={13} />
                    Pausa Programada (Delay)
                  </h4>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Tempo de Espera (segundos) *</span>
                      <span className="text-[10px] text-yellow-400 font-mono">
                        {config.segundos ?? 30}s
                        {Number(config.segundos ?? 30) >= 60 &&
                          ` (${(Number(config.segundos ?? 30) / 60).toFixed(1)} min)`}
                      </span>
                    </label>
                    <input
                      type="number"
                      min={1}
                      max={3600}
                      value={config.segundos ?? 30}
                      onChange={(e) =>
                        atualizarConfig(
                          "segundos",
                          Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), 3600)
                        )
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-yellow-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      Aguarda o tempo especificado de forma não-bloqueante antes de propagar o contexto para o próximo nó.
                    </span>
                  </div>

                  {/* Presets Rápidos de Pausa */}
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {[
                      { label: "10 seg", seg: 10 },
                      { label: "30 seg", seg: 30 },
                      { label: "1 min", seg: 60 },
                      { label: "2 min", seg: 120 },
                      { label: "5 min", seg: 300 },
                    ].map((p) => (
                      <button
                        key={p.seg}
                        type="button"
                        onClick={() => atualizarConfig("segundos", p.seg)}
                        className={`px-2 py-1 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                          (config.segundos ?? 30) === p.seg
                            ? "bg-yellow-950 border-yellow-500 text-yellow-300 font-bold"
                            : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* SCRIPT / INTEGRAÇÃO */}
              {noEditado.tipo === "script" && (
                <div className="space-y-3 p-3 rounded-xl bg-cyan-950/20 border border-cyan-800/40">
                  <h4 className="text-[11px] font-bold text-cyan-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Terminal size={13} />
                    Execução de Script Local
                  </h4>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Runtime
                    </label>
                    <select
                      value={config.runtime || "python"}
                      onChange={(e) => atualizarConfig("runtime", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-cyan-500"
                    >
                      <option value="python">Python (python3)</option>
                      <option value="bash">Bash / Shell (/bin/bash)</option>
                      <option value="node">Node.js (node)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Comando ou Caminho do Script
                    </label>
                    <input
                      type="text"
                      placeholder="ex: scripts/analisar_pautas.py ou curl -s ..."
                      value={config.comando || config.script || ""}
                      onChange={(e) => atualizarConfig("comando", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Timeout (ms)
                    </label>
                    <input
                      type="number"
                      value={config.timeout_ms || 30000}
                      onChange={(e) =>
                        atualizarConfig("timeout_ms", parseInt(e.target.value, 10) || 30000)
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono focus:outline-none focus:border-cyan-500"
                    />
                  </div>
                </div>
              )}

              {/* REQUISIÇÃO HTTP / API */}
              {noEditado.tipo === "http_request" && (
                <div className="space-y-3.5 p-3.5 rounded-xl bg-blue-950/20 border border-blue-800/40">
                  <h4 className="text-[11px] font-bold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Globe size={13} />
                    Requisição HTTP / API REST
                  </h4>

                  {/* Método HTTP */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1.5 text-xs">
                      Método HTTP
                    </label>
                    <div className="flex flex-wrap gap-1.5">
                      {[
                        { m: "GET", cor: "bg-sky-500/10 border-sky-500/30 text-sky-400 hover:bg-sky-500/20", ativo: "bg-sky-600 text-white font-bold border-sky-500 shadow-xs" },
                        { m: "POST", cor: "bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20", ativo: "bg-emerald-600 text-white font-bold border-emerald-500 shadow-xs" },
                        { m: "PUT", cor: "bg-amber-500/10 border-amber-500/30 text-amber-400 hover:bg-amber-500/20", ativo: "bg-amber-600 text-white font-bold border-amber-500 shadow-xs" },
                        { m: "PATCH", cor: "bg-purple-500/10 border-purple-500/30 text-purple-400 hover:bg-purple-500/20", ativo: "bg-purple-600 text-white font-bold border-purple-500 shadow-xs" },
                        { m: "DELETE", cor: "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20", ativo: "bg-rose-600 text-white font-bold border-rose-500 shadow-xs" },
                      ].map(({ m, cor, ativo }) => {
                        const selecionado = (config.metodo || "GET").toUpperCase() === m;
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => atualizarConfig("metodo", m)}
                            className={`px-2.5 py-1 rounded text-[11px] font-mono border transition-all cursor-pointer ${
                              selecionado ? ativo : cor
                            }`}
                          >
                            {m}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* URL do Endpoint */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      URL do Endpoint *
                    </label>
                    <input
                      type="text"
                      placeholder="https://api.exemplo.com/v1/resource"
                      value={config.url || ""}
                      onChange={(e) => atualizarConfig("url", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-blue-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      Suporta interpolação com <code>{`{{entrada}}`}</code>, <code>{`{{id}}`}</code> ou <code>{`{{secret.TOKEN}}`}</code>.
                    </span>
                  </div>

                  {/* Timeout (ms) */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Timeout da Requisição (ms)</span>
                      <span className="text-[10px] text-blue-400 font-mono">
                        {((config.timeout_ms ?? 10000) / 1000).toFixed(1)}s
                      </span>
                    </label>
                    <input
                      type="number"
                      min={1000}
                      max={120000}
                      step={1000}
                      value={config.timeout_ms ?? 10000}
                      onChange={(e) =>
                        atualizarConfig(
                          "timeout_ms",
                          Math.max(parseInt(e.target.value, 10) || 10000, 1000)
                        )
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>

                  {/* Headers */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Cabeçalhos / Headers (JSON)</span>
                      <span className="text-[10px] text-zinc-500 font-mono">opcional</span>
                    </label>
                    <textarea
                      rows={2}
                      placeholder='{"Authorization": "Bearer {{secret.API_KEY}}", "Content-Type": "application/json"}'
                      value={
                        typeof config.headers === "object"
                          ? JSON.stringify(config.headers, null, 2)
                          : config.headers || ""
                      }
                      onChange={(e) => atualizarConfig("headers", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-blue-500 resize-none leading-relaxed"
                    />
                  </div>

                  {/* Body / Corpo da Requisição */}
                  {["POST", "PUT", "PATCH"].includes((config.metodo || "GET").toUpperCase()) && (
                    <div>
                      <label className="block text-zinc-300 font-medium mb-1 text-xs">
                        Corpo da Requisição (Body JSON)
                      </label>
                      <textarea
                        rows={4}
                        placeholder='{\n  "payload": "{{entrada}}",\n  "origem": "opencorp"\n}'
                        value={
                          typeof config.body === "object"
                            ? JSON.stringify(config.body, null, 2)
                            : config.body || ""
                        }
                        onChange={(e) => atualizarConfig("body", e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-blue-500 resize-none leading-relaxed"
                      />
                      <span className="text-[10px] text-zinc-500 mt-1 block">
                        💡 Dica: Use <code>{`{{entrada}}`}</code> para injetar a saída produzida pelo nó antecessor.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* COMPONENTE MODULAR + TESTE UNITÁRIO ISOLADO */}
              {noEditado.tipo === "componente" && (
                <div className="space-y-3.5 p-3.5 rounded-xl bg-teal-950/20 border border-teal-800/40">
                  <h4 className="text-[11px] font-bold text-teal-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Code2 size={13} />
                    Componente Modular Reutilizável
                  </h4>

                  {/* Seleção de Componente */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Componente do Marketplace / Workspace</span>
                      <span className="text-[10px] text-teal-400 font-mono">
                        {carregandoComponentes ? "carregando..." : `${componentes.length} disponíveis`}
                      </span>
                    </label>
                    <select
                      value={config.componente_id || ""}
                      onChange={(e) => {
                        const val = e.target.value;
                        atualizarConfig("componente_id", val || undefined);
                        const selecionado = componentes.find((c) => c.id === val);
                        if (selecionado) {
                          if (selecionado.runtime) atualizarConfig("runtime", selecionado.runtime);
                          if (selecionado.nome) atualizarConfig("nome", selecionado.nome);
                        }
                      }}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-teal-500"
                    >
                      <option value="">— Personalizado (Arquivo ou Código Inline) —</option>
                      {componentes.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.builtin ? "📦 " : "🧩 "}
                          {c.nome || c.id} (v{c.versao || "1.0.0"} · {c.runtime})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Metadados do Componente Selecionado */}
                  {(() => {
                    const cSel = componentes.find((c) => c.id === config.componente_id);
                    if (!cSel) return null;
                    return (
                      <div className="p-2.5 rounded-lg bg-zinc-900/80 border border-zinc-850 text-xs space-y-1.5">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-zinc-200">{cSel.nome || cSel.id}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-400 font-mono border border-teal-500/20">
                            v{cSel.versao || "1.0.0"} · {cSel.runtime}
                          </span>
                        </div>
                        {cSel.descricao && (
                          <p className="text-[11px] text-zinc-400 leading-relaxed">{cSel.descricao}</p>
                        )}
                      </div>
                    );
                  })()}

                  {/* Modo Personalizado se nenhum componente for selecionado */}
                  {!config.componente_id && (
                    <div className="space-y-2.5 pt-2 border-t border-teal-900/30">
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-zinc-300 font-medium mb-1 text-xs">Runtime</label>
                          <select
                            value={config.runtime || "node"}
                            onChange={(e) => atualizarConfig("runtime", e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-teal-500"
                          >
                            <option value="node">Node.js (JavaScript)</option>
                            <option value="python">Python 3</option>
                            <option value="bash">Bash Script</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-zinc-300 font-medium mb-1 text-xs">Arquivo (Opcional)</label>
                          <input
                            type="text"
                            placeholder="scripts/conversor.mjs"
                            value={config.arquivo || ""}
                            onChange={(e) => atualizarConfig("arquivo", e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-teal-500"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="block text-zinc-300 font-medium mb-1 text-xs">
                          Código Inline (se não usar arquivo)
                        </label>
                        <textarea
                          rows={4}
                          placeholder="// export default async function(input) { return { ok: true, input }; }"
                          value={config.codigo || ""}
                          onChange={(e) => atualizarConfig("codigo", e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-teal-500 resize-none leading-relaxed"
                        />
                      </div>
                    </div>
                  )}

                  {/* PAINEL DE TESTE UNITÁRIO ISOLADO (ISOLATE NODE TEST) */}
                  <div className="mt-3 pt-3 border-t border-zinc-800/80 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-teal-300 flex items-center gap-1.5">
                        <FlaskConical size={13} className="text-teal-400" />
                        Teste Unitário do Nó
                      </span>
                      <span className="text-[10px] text-zinc-500 font-mono">I/O Isolado</span>
                    </div>

                    <div>
                      <label className="block text-zinc-400 font-medium mb-1 text-[11px]">
                        Entrada de Teste Simulada (JSON / Payload)
                      </label>
                      <textarea
                        rows={2}
                        value={entradaTesteComp}
                        onChange={(e) => setEntradaTesteComp(e.target.value)}
                        placeholder='{"parametro": "valor"}'
                        className="w-full bg-zinc-950 border border-zinc-800 rounded-lg p-2 text-zinc-200 font-mono text-xs focus:outline-none focus:border-teal-500 resize-none"
                      />
                    </div>

                    <div className="flex items-center justify-between pt-0.5">
                      <button
                        type="button"
                        disabled={testandoComp || (!config.componente_id && !config.codigo && !config.arquivo)}
                        onClick={handleExecutarTesteComponente}
                        className="px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                      >
                        {testandoComp ? (
                          <>
                            <Loader2 size={13} className="animate-spin" />
                            <span>Executando Teste...</span>
                          </>
                        ) : (
                          <>
                            <Play size={13} />
                            <span>Testar Nó Agora</span>
                          </>
                        )}
                      </button>

                      {resultadoTesteComp?.duracao_ms !== undefined && (
                        <span className="text-[10px] text-zinc-400 font-mono">
                          {resultadoTesteComp.duracao_ms}ms
                        </span>
                      )}
                    </div>

                    {/* Caixa com o Resultado do Teste */}
                    {resultadoTesteComp && (
                      <div
                        className={`p-2.5 rounded-lg border text-xs font-mono space-y-1.5 ${
                          resultadoTesteComp.ok
                            ? "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
                            : "bg-rose-950/20 border-rose-800/40 text-rose-300"
                        }`}
                      >
                        <div className="flex items-center justify-between text-[11px] font-bold">
                          <span className="flex items-center gap-1">
                            {resultadoTesteComp.ok ? (
                              <>
                                <CheckCircle2 size={13} className="text-emerald-400" />
                                <span>Sucesso</span>
                              </>
                            ) : (
                              <>
                                <XCircle size={13} className="text-rose-400" />
                                <span>Falha</span>
                              </>
                            )}
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const texto = resultadoTesteComp.ok
                                ? (resultadoTesteComp.json
                                    ? JSON.stringify(resultadoTesteComp.json, null, 2)
                                    : String(resultadoTesteComp.saida ?? ""))
                                : String(resultadoTesteComp.erro ?? "");
                              navigator.clipboard.writeText(texto);
                              showToast("Resultado copiado", "info");
                            }}
                            className="text-[10px] text-zinc-400 hover:text-zinc-200 cursor-pointer flex items-center gap-1"
                          >
                            <Copy size={11} />
                            <span>Copiar</span>
                          </button>
                        </div>
                        <pre className="whitespace-pre-wrap text-[11px] max-h-32 overflow-y-auto scrollbar-thin p-1.5 rounded bg-zinc-950/60 border border-zinc-850">
                          {resultadoTesteComp.ok
                            ? (resultadoTesteComp.json
                                ? JSON.stringify(resultadoTesteComp.json, null, 2)
                                : String(resultadoTesteComp.saida ?? ""))
                            : String(resultadoTesteComp.erro ?? "Erro desconhecido")}
                        </pre>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* REUNIÃO MULTI-AGENTE */}
              {noEditado.tipo === "reuniao" && (
                <div className="space-y-3.5 p-3.5 rounded-xl bg-indigo-950/20 border border-indigo-800/40">
                  <h4 className="text-[11px] font-bold text-indigo-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Users size={13} />
                    Reunião Deliberativa Multi-Agente
                  </h4>

                  {/* Pauta da Reunião */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Pauta da Reunião *
                    </label>
                    <textarea
                      rows={3}
                      placeholder="Tema central, objetivos e diretrizes da deliberação coletiva..."
                      value={config.pauta || ""}
                      onChange={(e) => atualizarConfig("pauta", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg p-2.5 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500 resize-none leading-relaxed"
                    />
                  </div>

                  {/* Moderador da Reunião */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Agente Moderador da Reunião
                    </label>
                    <select
                      value={config.moderador || ""}
                      onChange={(e) => atualizarConfig("moderador", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-indigo-500"
                    >
                      <option value="">— Selecione o Moderador —</option>
                      {agentes.map((ag) => (
                        <option key={ag.id} value={ag.id}>
                          👑 {ag.nome || ag.id} (@{ag.id})
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Participantes da Reunião */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Agentes Participantes</span>
                      <span className="text-[10px] text-indigo-400 font-mono">
                        {(config.participantes || []).length} selecionados
                      </span>
                    </label>
                    <div className="max-h-36 overflow-y-auto space-y-1 p-2 rounded-lg bg-zinc-900/60 border border-zinc-800 scrollbar-thin">
                      {agentes.length === 0 ? (
                        <div className="text-[11px] text-zinc-500 text-center py-2">
                          Nenhum agente cadastrado no workspace.
                        </div>
                      ) : (
                        agentes.map((ag) => {
                          const participantesAtuais: string[] = Array.isArray(config.participantes)
                            ? config.participantes
                            : [];
                          const ativo = participantesAtuais.includes(ag.id);
                          return (
                            <label
                              key={ag.id}
                              className="flex items-center gap-2 p-1.5 rounded hover:bg-zinc-850 cursor-pointer text-xs transition-colors"
                            >
                              <input
                                type="checkbox"
                                checked={ativo}
                                onChange={(e) => {
                                  if (e.target.checked) {
                                    atualizarConfig("participantes", [...participantesAtuais, ag.id]);
                                  } else {
                                    atualizarConfig(
                                      "participantes",
                                      participantesAtuais.filter((id) => id !== ag.id)
                                    );
                                  }
                                }}
                                className="rounded border-zinc-700 text-indigo-600 focus:ring-0"
                              />
                              <span className="text-zinc-200 font-medium">{ag.nome || ag.id}</span>
                              <span className="text-[10px] text-zinc-500 font-mono">(@{ag.id})</span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  {/* Duração Estimada */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Duração Estimada (minutos)</span>
                      <span className="text-[10px] text-indigo-400 font-mono">
                        {config.duracao_min ?? 15} min
                      </span>
                    </label>
                    <input
                      type="number"
                      min={5}
                      max={120}
                      value={config.duracao_min ?? 15}
                      onChange={(e) =>
                        atualizarConfig("duracao_min", Math.max(parseInt(e.target.value, 10) || 15, 5))
                      }
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 font-mono text-xs focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
              )}

              {/* CRIAR TAREFA KANBAN (COM VÍNCULO A TAREFA EXISTENTE) */}
              {noEditado.tipo === "task_create" && (
                <div className="space-y-3.5 p-3.5 rounded-xl bg-blue-950/20 border border-blue-800/40">
                  <h4 className="text-[11px] font-bold text-blue-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Layers size={13} />
                    Criação / Vinculação de Tarefa Kanban
                  </h4>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Título da Tarefa no Kanban *
                    </label>
                    <input
                      type="text"
                      placeholder="ex: Revisar Artigo e Publicar na Fila"
                      value={config.titulo || ""}
                      onChange={(e) => atualizarConfig("titulo", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-blue-500"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-zinc-300 font-medium mb-1 text-xs">
                        Coluna
                      </label>
                      <select
                        value={config.coluna || "backlog"}
                        onChange={(e) => atualizarConfig("coluna", e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-blue-500"
                      >
                        <option value="backlog">Backlog</option>
                        <option value="fazer">A Fazer</option>
                        <option value="andamento">Em Andamento</option>
                        <option value="revisao">Revisão</option>
                        <option value="concluido">Concluído</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-zinc-300 font-medium mb-1 text-xs">
                        Prioridade
                      </label>
                      <select
                        value={config.prioridade || "media"}
                        onChange={(e) => atualizarConfig("prioridade", e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-blue-500"
                      >
                        <option value="baixa">Baixa</option>
                        <option value="media">Média</option>
                        <option value="alta">Alta</option>
                        <option value="urgente">Urgente</option>
                      </select>
                    </div>
                  </div>

                  {/* Selecionar / Vincular Tarefa Existente */}
                  <div className="space-y-1.5 pt-2 border-t border-zinc-800">
                    <label className="text-[11px] font-medium text-zinc-300 flex items-center justify-between">
                      <span>ou Vincular a Tarefa Existente</span>
                      <Search size={12} className="text-zinc-500" />
                    </label>
                    <input
                      type="text"
                      placeholder="Buscar por título ou ID..."
                      value={buscaTask}
                      onChange={(e) => setBuscaTask(e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-blue-500 font-mono"
                    />
                    {buscaTask.trim().length >= 2 && (
                      <div className="max-h-32 overflow-y-auto space-y-1 scrollbar-thin p-1 rounded-lg bg-zinc-950 border border-zinc-800">
                        {tasksExistentes
                          .filter((t) => {
                            const q = buscaTask.toLowerCase();
                            return (
                              (t.titulo && t.titulo.toLowerCase().includes(q)) ||
                              (t.id && t.id.toLowerCase().includes(q))
                            );
                          })
                          .slice(0, 6)
                          .map((t) => (
                            <div
                              key={t.id}
                              onClick={() => {
                                atualizarConfig("titulo", t.titulo || t.id);
                                atualizarConfig("task_id", t.id);
                                if (t.coluna) atualizarConfig("coluna", t.coluna);
                                if (t.prioridade) atualizarConfig("prioridade", t.prioridade);
                                setBuscaTask("");
                                showToast(`Tarefa "${t.titulo || t.id}" selecionada!`, "sucesso");
                              }}
                              className="px-2.5 py-1.5 rounded bg-zinc-900 hover:bg-zinc-850 cursor-pointer text-xs flex items-center justify-between gap-2 transition-colors border border-zinc-800/60"
                            >
                              <span className="font-medium text-zinc-200 truncate">{t.titulo || t.id}</span>
                              <span className="text-[10px] text-zinc-400 font-mono shrink-0">{t.coluna || "backlog"}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* REGISTRO OU SAÍDA DOCUMENTAL */}
              {(noEditado.tipo === "registro" || noEditado.tipo === "saida") && (
                <div className="space-y-3.5 p-3.5 rounded-xl bg-purple-950/20 border border-purple-800/40">
                  <h4 className="text-[11px] font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
                    <FileText size={13} />
                    {noEditado.tipo === "saida" ? "Saída do Fluxo (Resultado Final)" : "Registro / Artefato Documental"}
                  </h4>

                  {/* Categoria do Registro */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1.5 text-xs">
                      Categoria do Registro
                    </label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {[
                        { id: "documentos", label: "Documentos", icone: "📄" },
                        { id: "atas", label: "Atas de Reunião", icone: "📝" },
                        { id: "relatorios", label: "Relatórios", icone: "📊" },
                        { id: "metricas", label: "Métricas", icone: "📈" },
                        { id: "custom", label: "Personalizado", icone: "⚙️" },
                      ].map((cat) => {
                        const selecionado = (config.categoria || "documentos") === cat.id;
                        return (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => atualizarConfig("categoria", cat.id)}
                            className={`px-2.5 py-1.5 rounded-lg border text-left text-xs flex items-center gap-2 transition-all cursor-pointer ${
                              selecionado
                                ? "bg-purple-950/80 border-purple-500 text-purple-200 font-bold"
                                : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                            }`}
                          >
                            <span>{cat.icone}</span>
                            <span>{cat.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Título / Nome do Artefato */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Título do Artefato / Documento
                    </label>
                    <input
                      type="text"
                      placeholder="ex: Relatório Final de Performance"
                      value={config.titulo || config.nome || ""}
                      onChange={(e) => {
                        atualizarConfig("titulo", e.target.value);
                        atualizarConfig("nome", e.target.value);
                      }}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-purple-500"
                    />
                  </div>

                  {/* Formato do Arquivo */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs">
                      Formato do Artefato
                    </label>
                    <select
                      value={config.formato || "markdown"}
                      onChange={(e) => atualizarConfig("formato", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 text-xs focus:outline-none focus:border-purple-500"
                    >
                      <option value="markdown">Markdown (.md)</option>
                      <option value="json">JSON (.json)</option>
                      <option value="html">HTML (.html)</option>
                      <option value="txt">Texto Puro (.txt)</option>
                    </select>
                  </div>

                  {/* Chave de Saída no Contexto */}
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1 text-xs flex items-center justify-between">
                      <span>Chave de Saída no Contexto</span>
                      <span className="text-[10px] text-zinc-500 font-mono">variável</span>
                    </label>
                    <input
                      type="text"
                      placeholder="relatorio_final"
                      value={config.chave_saida || "relatorio_final"}
                      onChange={(e) => atualizarConfig("chave_saida", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-purple-300 font-mono text-xs focus:outline-none focus:border-purple-500"
                    />
                    <span className="text-[10px] text-zinc-500 mt-1 block">
                      O resultado produzido será indexado sob esta chave no contexto final de execução.
                    </span>
                  </div>
                </div>
              )}

              {/* SUBFLOW */}
              {noEditado.tipo === "subflow" && (
                <div className="space-y-3 p-3 rounded-xl bg-purple-950/20 border border-purple-800/40">
                  <h4 className="text-[11px] font-bold text-purple-400 uppercase tracking-wider flex items-center gap-1.5">
                    <Sparkles size={13} />
                    Invocação de Sub-Fluxo
                  </h4>
                  <div>
                    <label className="block text-zinc-300 font-medium mb-1">
                      Fluxo a Invocar
                    </label>
                    <select
                      value={config.flow || config.fluxo_id || ""}
                      onChange={(e) => atualizarConfig("flow", e.target.value)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-zinc-200 focus:outline-none focus:border-purple-500"
                    >
                      <option value="">Selecione um fluxo...</option>
                      {fluxosExistentes
                        .filter((f) => f.id !== fluxo?.id)
                        .map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.nome || f.id} ({f.id})
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              )}

              {/* ─────────────────────────────────────────────────────────
                  SEÇÃO N8N: CONEXÕES DO NÓ (LIGAÇÕES DE ENTRADA & SAÍDA)
                 ───────────────────────────────────────────────────────── */}
              <div className="pt-3.5 border-t border-zinc-800 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                    <GitBranch size={13} className="text-orange-400" />
                    Conexões &amp; Fluxo (n8n-style)
                  </span>
                  <span className="text-[10px] text-zinc-500 font-mono">
                    {entradasConexao.length} in · {saidasConexao.length} out
                  </span>
                </div>

                {/* Ligações de Entrada */}
                <div className="space-y-1.5">
                  <span className="text-[10px] text-zinc-400 font-semibold flex items-center gap-1">
                    <ArrowLeft size={11} className="text-sky-400" />
                    Entradas (ativado após):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {entradasConexao.length === 0 ? (
                      <span className="text-[10px] text-zinc-600 italic">
                        Gatilho inicial ou sem nós predecessores
                      </span>
                    ) : (
                      entradasConexao.map((aresta, idx) => {
                        const origemId = aresta.source || aresta.de || "";
                        const arestaId = aresta.id || `e-${origemId}-${noEditado.id}-${idx}`;
                        return (
                          <span
                            key={arestaId}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300 hover:border-zinc-700 transition-colors"
                          >
                            <span className="text-sky-400">←</span>
                            <span className="font-semibold">{origemId}</span>
                            {aresta.label && (
                              <span className="text-[9px] px-1 py-0.2 rounded bg-zinc-800 text-zinc-400">
                                {aresta.label}
                              </span>
                            )}
                            {aoRemoverAresta && (
                              <button
                                type="button"
                                onClick={() => aoRemoverAresta(aresta.id || origemId, noEditado.id)}
                                className="text-zinc-500 hover:text-rose-400 ml-0.5 cursor-pointer font-bold transition-colors p-0.5"
                                title="Remover conexão"
                              >
                                <X size={11} />
                              </button>
                            )}
                          </span>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Ligações de Saída */}
                <div className="space-y-1.5">
                  <span className="text-[10px] text-zinc-400 font-semibold flex items-center gap-1">
                    <ArrowRight size={11} className="text-emerald-400" />
                    Saídas (dispara em seguida):
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {saidasConexao.length === 0 ? (
                      <span className="text-[10px] text-zinc-600 italic">
                        Fim da esteira ou sem ramificações
                      </span>
                    ) : (
                      saidasConexao.map((aresta, idx) => {
                        const destinoId = aresta.target || aresta.para || "";
                        const arestaId = aresta.id || `e-${noEditado.id}-${destinoId}-${idx}`;
                        const condicao = aresta.label || aresta.condicao;
                        return (
                          <span
                            key={arestaId}
                            className="inline-flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-[11px] font-mono text-zinc-300 hover:border-zinc-700 transition-colors"
                          >
                            <span className="text-emerald-400">→</span>
                            <span className="font-semibold">{destinoId}</span>
                            {condicao && (
                              <span
                                className={`text-[9px] px-1.5 py-0.2 rounded font-bold uppercase ${
                                  condicao === "entao" || condicao === "sim"
                                    ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800"
                                    : condicao === "senao" || condicao === "nao"
                                    ? "bg-rose-950/80 text-rose-400 border border-rose-800"
                                    : "bg-zinc-800 text-zinc-300"
                                }`}
                              >
                                {condicao}
                              </span>
                            )}
                            {aoRemoverAresta && (
                              <button
                                type="button"
                                onClick={() => aoRemoverAresta(aresta.id || noEditado.id, destinoId)}
                                className="text-zinc-500 hover:text-rose-400 ml-0.5 cursor-pointer font-bold transition-colors p-0.5"
                                title="Remover conexão"
                              >
                                <X size={11} />
                              </button>
                            )}
                          </span>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Conectar a Outro Nó (Atalho Rápido) */}
                <div className="space-y-1.5 pt-1">
                  <span className="text-[10px] text-zinc-400 font-semibold block">
                    Conectar a Outro Nó (Atalho Rápido):
                  </span>
                  <div className="flex items-center gap-1.5">
                    <select
                      value={novoDestinoLigacao}
                      onChange={(e) => setNovoDestinoLigacao(e.target.value)}
                      className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-orange-500 font-mono"
                    >
                      <option value="">Ligar este nó para...</option>
                      {listaNosParaLigar.map((outro) => (
                        <option key={outro.id} value={outro.id}>
                          → {outro.id} ({outro.tipo})
                        </option>
                      ))}
                    </select>

                    {(noEditado.tipo === "condicao" || noEditado.tipo === "decisao") && (
                      <select
                        value={novaCondicaoLigacao}
                        onChange={(e) => setNovaCondicaoLigacao(e.target.value)}
                        className="w-24 bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-orange-500 font-mono"
                      >
                        <option value="">(Padrão)</option>
                        <option value="entao">então</option>
                        <option value="senao">senão</option>
                      </select>
                    )}

                    <button
                      type="button"
                      disabled={!novoDestinoLigacao}
                      onClick={() => {
                        if (!novoDestinoLigacao) {
                          showToast("Selecione um nó de destino", "aviso");
                          return;
                        }
                        if (aoAdicionarAresta) {
                          aoAdicionarAresta(
                            noEditado.id,
                            novoDestinoLigacao,
                            novaCondicaoLigacao || undefined
                          );
                        }
                        setNovoDestinoLigacao("");
                        setNovaCondicaoLigacao("");
                      }}
                      className="px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shrink-0"
                    >
                      <Plus size={13} />
                      <span>Ligar</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* ─────────────────────────────────────────────────────────
                  SEÇÃO N8N: CONTEXTO DO NÓ ANTERIOR & VARIÁVEIS DE ENTRADA
                 ───────────────────────────────────────────────────────── */}
              <div className="pt-3 border-t border-zinc-800 space-y-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                  <Terminal size={13} className="text-cyan-400" />
                  Dados Anteriores &amp; Variáveis (n8n)
                </span>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Clique na variável para copiar ou injetar diretamente no contexto de instrução deste nó.
                </p>

                <div className="flex flex-wrap gap-1.5 text-[10px] font-mono">
                  {[
                    { tag: "{{entrada}}", desc: "Saída direta do nó anterior" },
                    { tag: "{{$input}}", desc: "Payload de entrada do nó" },
                    { tag: "{{json}}", desc: "Objeto serializado" },
                    { tag: "$OPENCORP_INPUT", desc: "Carga do webhook / inicial" },
                  ].map(({ tag, desc }) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => {
                        navigator.clipboard.writeText(tag);
                        showToast(`"${tag}" copiado para a área de transferência!`, "info");
                        if (config.ordem !== undefined) {
                          atualizarConfig("ordem", `${config.ordem} ${tag}`.trim());
                        } else if (config.prompt !== undefined) {
                          atualizarConfig("prompt", `${config.prompt} ${tag}`.trim());
                        } else if (config.body !== undefined && typeof config.body === "string") {
                          atualizarConfig("body", `${config.body} ${tag}`.trim());
                        }
                      }}
                      className="px-2 py-1 rounded bg-zinc-900 border border-zinc-800 hover:border-cyan-500 text-cyan-400 hover:text-cyan-300 transition-colors cursor-pointer flex items-center gap-1"
                      title={desc}
                    >
                      <span>{tag}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Rodapé com Ações */}
        <div className="p-4 border-t border-zinc-800 flex items-center justify-between shrink-0 bg-zinc-900/60">
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`Deseja realmente remover o nó "${noEditado.id}"?`)) {
                onExcluirNo(noEditado.id);
                onClose();
              }
            }}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-rose-400 hover:text-rose-300 hover:bg-rose-950/40 border border-rose-900/60 text-xs transition-colors cursor-pointer"
          >
            <Trash2 size={13} />
            <span>Excluir Nó</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 text-xs transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSalvar}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white font-semibold text-xs shadow-md transition-colors cursor-pointer"
            >
              <Check size={14} />
              <span>Salvar Alterações</span>
            </button>
          </div>
        </div>
      </aside>
  );
};
