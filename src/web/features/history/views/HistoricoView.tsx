import React, { useState, useEffect, useCallback, useMemo, useRef, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import type { ItemHistorico, AcaoAgente, ResumoTelemetria, ArquivoDiff } from "../types.js";
import {
  HistoryMetricsHeader,
  HistoryFilterBar,
  HistoryTable,
  HistoryInspectionDrawer,
  HistoryTaskDrawer,
  HistoryRoutineDrawer,
  HistoryConversationDrawer,
} from "../components/index.js";

export const HistoricoView: FC = () => {
  const { client, workspaceId, tratarErro } = useOpenCorp();
  const [searchParams, setSearchParams] = useSearchParams();

  const runParam = searchParams.get("run");
  const taskParam = searchParams.get("task");
  const rotinaParam = searchParams.get("rotina");
  const conversaParam = searchParams.get("conversa");
  const tipoParam = searchParams.get("tipo") || "todos";
  const statusParam = searchParams.get("status") || "todos";
  const agenteParam = searchParams.get("agente") || "todos";

  const wsEfetivo = useMemo(() => {
    if (workspaceId) return workspaceId;
    if (typeof window !== "undefined") {
      const salvo = localStorage.getItem("opencorp_workspace_id");
      if (salvo) return salvo;
    }
    return "default";
  }, [workspaceId]);

  // Estados de Dados Principais
  const [itens, setItens] = useState<ItemHistorico[]>([]);
  const [resumoTelemetria, setResumoTelemetria] = useState<ResumoTelemetria | null>(null);
  const [carregando, setCarregando] = useState(true);

  // Filtros
  const [tipoFiltro, setTipoFiltro] = useState<string>(tipoParam);
  const [statusFiltro, setStatusFiltro] = useState<string>(statusParam);
  const [agenteFiltro, setAgenteFiltro] = useState<string>(agenteParam);
  const [busca, setBusca] = useState("");
  const [tempoReal, setTempoReal] = useState(false);

  // Estado do Item Selecionado e Detalhes da Gaveta Forense
  const [itemSelecionado, setItemSelecionado] = useState<ItemHistorico | null>(null);
  const [taskInspecaoId, setTaskInspecaoId] = useState<string | null>(null);
  const [routineInspecaoId, setRoutineInspecaoId] = useState<string | null>(null);
  const [conversaInspecaoId, setConversaInspecaoId] = useState<string | null>(null);
  const [logRun, setLogRun] = useState<string>("");
  const [acoesRun, setAcoesRun] = useState<AcaoAgente[]>([]);
  const [diffRun, setDiffRun] = useState<string>("");
  const [arquivosDiff, setArquivosDiff] = useState<ArquivoDiff[]>([]);
  const [commitHashDiff, setCommitHashDiff] = useState<string | null>(null);

  const [carregandoDetalhes, setCarregandoDetalhes] = useState(false);
  const [carregandoAcoes, setCarregandoAcoes] = useState(false);
  const [carregandoDiff, setCarregandoDiff] = useState(false);

  // ── Carregar Lista de Histórico Unificado ──────────────────────────────
  const carregarHistorico = useCallback(async (silencioso = false) => {
    if (!silencioso) setCarregando(true);
    try {
      const queryParams = new URLSearchParams();
      queryParams.set("limite", "300");
      if (tipoFiltro !== "todos") queryParams.set("tipo", tipoFiltro);
      if (agenteFiltro !== "todos") queryParams.set("agente", agenteFiltro);
      if (busca.trim()) queryParams.set("busca", busca.trim());

      const res = await client.http.get<ItemHistorico[]>(
        `/historico?${queryParams.toString()}`,
        {
          headers: { "x-opencorp-workspace": wsEfetivo },
        }
      );
      setItens(Array.isArray(res) ? res : []);
    } catch (err) {
      if (!silencioso) {
        tratarErro(err, "Falha ao carregar histórico unificado");
      }
    } finally {
      if (!silencioso) setCarregando(false);
    }
  }, [client, wsEfetivo, tipoFiltro, agenteFiltro, busca, tratarErro]);

  // ── Carregar Resumo de Telemetria e Finanças ───────────────────────────
  const carregarResumoTelemetria = useCallback(async () => {
    try {
      const res = await client.http.get<ResumoTelemetria>("/telemetria/resumo", {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      setResumoTelemetria(res || null);
    } catch {
      setResumoTelemetria(null);
    }
  }, [client, wsEfetivo]);

  useEffect(() => {
    void carregarHistorico();
    void carregarResumoTelemetria();
  }, [carregarHistorico, carregarResumoTelemetria]);

  // Polling em tempo real a cada 5 segundos se ativado
  useEffect(() => {
    if (!tempoReal) return;
    const timer = setInterval(() => {
      void carregarHistorico(true);
      void carregarResumoTelemetria();
    }, 5000);
    return () => clearInterval(timer);
  }, [tempoReal, carregarHistorico, carregarResumoTelemetria]);

  // ── Lista de Agentes Disponíveis para Filtro ───────────────────────────
  const agentesDisponiveis = useMemo(() => {
    const set = new Set<string>();
    itens.forEach((it) => {
      if (it.agente) set.add(it.agente.replace(/^@/, ""));
    });
    return Array.from(set).sort();
  }, [itens]);

  // ── Filtros Locais (Status e Busca rápida) ─────────────────────────────
  const itensFiltrados = useMemo(() => {
    return itens.filter((it) => {
      // Filtro de status
      if (statusFiltro !== "todos") {
        const s = (it.status || "").toLowerCase();
        if (statusFiltro === "sucesso" && !(s === "sucesso" || s === "concluido" || s === "ok")) {
          return false;
        }
        if (statusFiltro === "falhou" && !(s === "falhou" || s === "erro")) {
          return false;
        }
        if (statusFiltro === "executando" && s !== "executando") {
          return false;
        }
        if (statusFiltro === "cancelado" && !(s === "cancelado" || s === "abortado")) {
          return false;
        }
      }

      // Filtro de busca
      if (busca.trim()) {
        const q = busca.toLowerCase().trim();
        const matchId = it.id.toLowerCase().includes(q);
        const matchOrdem = it.ordem?.toLowerCase().includes(q);
        const matchTitulo = it.titulo?.toLowerCase().includes(q);
        const matchAgente = it.agente?.toLowerCase().includes(q);
        if (!matchId && !matchOrdem && !matchTitulo && !matchAgente) {
          return false;
        }
      }

      return true;
    });
  }, [itens, statusFiltro, busca]);

  // ── Inspecionar Execução / Item (Gaveta Forense) ───────────────────────
  const abrirInspecao = useCallback(
    async (execId: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("run", execId);
        return next;
      });

      // Busca o item no array local ou carrega da API
      let itemBase = itens.find((it) => it.id === execId) || null;
      if (!itemBase) {
        itemBase = { id: execId, tipo: "execucao" };
      }
      setItemSelecionado(itemBase);

      // Carregar Detalhes e Log
      setCarregandoDetalhes(true);
      try {
        const [detalhes, rawSessionLog] = await Promise.all([
          client.http.get<any>(`/execucoes/${encodeURIComponent(execId)}`, {
            headers: { "x-opencorp-workspace": wsEfetivo },
          }).catch(() => null),
          client.http.get<{ id: string; log: string } | string>(
            `/sessions/${encodeURIComponent(execId)}/log`,
            {
              headers: { "x-opencorp-workspace": wsEfetivo },
            }
          ).catch(async () => {
            return client.http.get<{ id: string; log: string } | string>(
              `/sessoes/${encodeURIComponent(execId)}/log`,
              {
                headers: { "x-opencorp-workspace": wsEfetivo },
              }
            ).catch(() => "");
          }),
        ]);

        let logTexto = "";
        if (rawSessionLog && typeof rawSessionLog === "object" && "log" in rawSessionLog) {
          logTexto = rawSessionLog.log || "";
        } else if (typeof rawSessionLog === "string") {
          logTexto = rawSessionLog;
        }

        // Fallback 1: tentar /registries/execucoes/:id
        if (!logTexto.trim()) {
          try {
            const reg = await client.http.get<{ conteudo?: string; meta?: { extras?: any } }>(
              `/registries/execucoes/${encodeURIComponent(execId)}`,
              { headers: { "x-opencorp-workspace": wsEfetivo } }
            );
            if (reg?.conteudo && reg.conteudo.trim()) {
              logTexto = reg.conteudo;
            } else if (typeof reg?.meta?.extras?.contexto_final === "string") {
              logTexto = reg.meta.extras.contexto_final;
            }
            if (reg?.meta?.extras?.nos && Array.isArray(reg.meta.extras.nos)) {
              itemBase = { ...itemBase, nos: reg.meta.extras.nos };
            }
          } catch {}
        }

        // Fallback 2: se for fluxo, carregar nós e contexto
        const flowId = detalhes?.flow || itemBase?.flow;
        if (flowId) {
          try {
            const execs = await client.http.get<Array<{ execId: string; status: string; nos: any[]; contextoFinal: string; entrada?: string }>>(
              `/flows/${encodeURIComponent(flowId)}/execucoes`,
              { headers: { "x-opencorp-workspace": wsEfetivo } }
            );
            const atual = (execs || []).find((e) => e.execId === execId) || (execs || [])[0];
            if (atual) {
              if (atual.nos) itemBase = { ...itemBase, nos: atual.nos };
              if (atual.contextoFinal) {
                itemBase = { ...itemBase, contexto_final: atual.contextoFinal };
                if (!logTexto.trim()) logTexto = atual.contextoFinal;
              }
              if (atual.entrada) itemBase = { ...itemBase, entrada: atual.entrada };
            }
          } catch {}
        }

        if (detalhes) {
          setItemSelecionado((prev) => ({
            ...(prev || itemBase!),
            ...detalhes,
            ...(itemBase?.nos ? { nos: itemBase.nos } : {}),
            ...(itemBase?.contexto_final ? { contexto_final: itemBase.contexto_final } : {}),
            ...(itemBase?.entrada ? { entrada: itemBase.entrada } : {}),
          }));
        } else {
          setItemSelecionado((prev) => ({
            ...(prev || itemBase!),
          }));
        }
        setLogRun(logTexto);
      } catch {
        setLogRun("");
      } finally {
        setCarregandoDetalhes(false);
      }

      // Carregar Spans de Telemetria
      setCarregandoAcoes(true);
      try {
        const spans = await client.http.get<AcaoAgente[]>(
          `/acoes/${encodeURIComponent(execId)}`,
          {
            headers: { "x-opencorp-workspace": wsEfetivo },
          }
        ).catch(() => []);
        setAcoesRun(Array.isArray(spans) ? spans : []);
      } catch {
        setAcoesRun([]);
      } finally {
        setCarregandoAcoes(false);
      }

      // Carregar Git Diff
      setCarregandoDiff(true);
      try {
        const resDiff = await client.http.get<{
          ok?: boolean;
          diff?: string;
          arquivos?: ArquivoDiff[];
          commitHash?: string;
        }>(`/execucoes/${encodeURIComponent(execId)}/diff`, {
          headers: { "x-opencorp-workspace": wsEfetivo },
        }).catch(() => null);

        setDiffRun(resDiff?.diff || "");
        setArquivosDiff(resDiff?.arquivos || []);
        setCommitHashDiff(resDiff?.commitHash || null);
      } catch {
        setDiffRun("");
        setArquivosDiff([]);
        setCommitHashDiff(null);
      } finally {
        setCarregandoDiff(false);
      }
    },
    [client, wsEfetivo, itens, setSearchParams]
  );

  // Execução recém-fechada: evita reabrir enquanto o ?run= ainda não saiu da URL.
  const runFechadoRef = useRef<string | null>(null);

  // Sincroniza deep-link ?run=<id>
  useEffect(() => {
    if (runParam !== runFechadoRef.current) runFechadoRef.current = null;
    if (runParam) {
      if (runFechadoRef.current === runParam) return;
      if (!itemSelecionado || itemSelecionado.id !== runParam) {
        void abrirInspecao(runParam);
      }
    } else {
      if (itemSelecionado) {
        setItemSelecionado(null);
        setLogRun("");
        setAcoesRun([]);
        setDiffRun("");
        setArquivosDiff([]);
      }
    }
  }, [runParam, itemSelecionado, abrirInspecao]);

  // Sincroniza deep-link ?task=<id>
  useEffect(() => {
    if (taskParam) {
      setTaskInspecaoId(taskParam.replace(/^task-/, ""));
    } else {
      setTaskInspecaoId(null);
    }
  }, [taskParam]);

  // Sincroniza deep-link ?rotina=<id>
  useEffect(() => {
    if (rotinaParam) {
      setRoutineInspecaoId(rotinaParam.replace(/^(job-|rotina-)/, ""));
    } else {
      setRoutineInspecaoId(null);
    }
  }, [rotinaParam]);

  // Sincroniza deep-link ?conversa=<id>
  useEffect(() => {
    if (conversaParam) {
      setConversaInspecaoId(conversaParam.replace(/^(conv-|conversa-|sessao-)/, ""));
    } else {
      setConversaInspecaoId(null);
    }
  }, [conversaParam]);

  const fecharInspecao = () => {
    runFechadoRef.current = runParam;
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("run");
      return next;
    });
    setItemSelecionado(null);
  };

  const fecharInspecaoTask = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("task");
      return next;
    });
    setTaskInspecaoId(null);
  };

  const fecharInspecaoRoutine = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("rotina");
      return next;
    });
    setRoutineInspecaoId(null);
  };

  const fecharInspecaoConversa = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("conversa");
      return next;
    });
    setConversaInspecaoId(null);
  };

  const fecharTodosDrawers = () => {
    setItemSelecionado(null);
    setTaskInspecaoId(null);
    setRoutineInspecaoId(null);
    setConversaInspecaoId(null);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("run");
      next.delete("task");
      next.delete("rotina");
      next.delete("conversa");
      return next;
    });
  };

  // ── Controles Operacionais Ativos ─────────────────────────────────────
  // Encerrar / Stop
  const handleAbortar = async (execId: string) => {
    try {
      await client.http.post(`/execucoes/${encodeURIComponent(execId)}/cancelar`, {}, {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      showToast(`Execução "${execId}" abortada com sucesso.`, "info");
      void abrirInspecao(execId);
      void carregarHistorico(true);
    } catch (err) {
      tratarErro(err, "Falha ao abortar execução");
    }
  };

  // Reenviar / Rerun
  const handleRerun = async (execId: string) => {
    try {
      const res = await client.http.post<any>(`/execucoes/${encodeURIComponent(execId)}/retry`, {}, {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      const novoId = res?.id || res?.exec_id;
      showToast(`Execução reenviada com sucesso! ${novoId ? `Novo ID: ${novoId}` : ""}`, "sucesso");
      if (novoId) {
        void abrirInspecao(novoId);
      }
      void carregarHistorico(true);
    } catch (err) {
      tratarErro(err, "Falha ao re-executar");
    }
  };

  // Retomar / Resume (para fluxos DAG)
  const handleResume = async (flowId: string) => {
    try {
      await client.http.post(`/flows/${encodeURIComponent(flowId)}/resume`, {}, {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      showToast(`Fluxo "${flowId}" retomado a partir do nó que falhou.`, "sucesso");
      void carregarHistorico(true);
    } catch (err) {
      tratarErro(err, "Falha ao retomar fluxo");
    }
  };

  // Restaurar Arquivo do Git Diff (Rollback)
  const handleRestaurarArquivo = async (caminho: string) => {
    try {
      await client.http.post("/workspaces/git/restore", { arquivo: caminho }, {
        headers: { "x-opencorp-workspace": wsEfetivo },
      });
      showToast(`Arquivo "${caminho}" revertido com sucesso via git checkout!`, "sucesso");
      if (itemSelecionado) {
        void abrirInspecao(itemSelecionado.id);
      }
    } catch (err) {
      tratarErro(err, `Falha ao reverter arquivo "${caminho}"`);
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-zinc-950 p-4 sm:p-6 md:p-8 space-y-4 overflow-hidden relative select-none">
      <h1 className="text-lg font-bold text-zinc-100 tracking-tight">Histórico de Execuções</h1>
      {/* Topo: Cards de Métricas e Telemetria */}
      <HistoryMetricsHeader
        resumo={resumoTelemetria}
        totalItens={itens.length}
      />

      {/* Barra de Filtros Multidimensional */}
      <HistoryFilterBar
        tipoFiltro={tipoFiltro}
        setTipoFiltro={setTipoFiltro}
        statusFiltro={statusFiltro}
        setStatusFiltro={setStatusFiltro}
        agenteFiltro={agenteFiltro}
        setAgenteFiltro={setAgenteFiltro}
        busca={busca}
        setBusca={setBusca}
        tempoReal={tempoReal}
        setTempoReal={setTempoReal}
        carregando={carregando}
        agentesDisponiveis={agentesDisponiveis}
        onRecarregar={() => {
          void carregarHistorico();
          void carregarResumoTelemetria();
        }}
      />

      {/* Tabela Unificada das 5 Entidades com Roteamento Polimórfico */}
      <HistoryTable
        itens={itensFiltrados}
        itemSelecionadoId={
          itemSelecionado?.id ||
          (taskInspecaoId ? `task-${taskInspecaoId}` : null) ||
          taskInspecaoId ||
          (routineInspecaoId ? `job-${routineInspecaoId}` : null) ||
          routineInspecaoId ||
          (conversaInspecaoId ? `conv-${conversaInspecaoId}` : null) ||
          conversaInspecaoId
        }
        onSelecionarItem={(it) => {
          if (it.tipo === "task") {
            fecharTodosDrawers();
            const idLimpo = it.id.replace(/^task-/, "");
            setTaskInspecaoId(idLimpo);
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("run");
              next.delete("rotina");
              next.delete("conversa");
              next.set("task", idLimpo);
              return next;
            });
          } else if (it.tipo === "rotina") {
            fecharTodosDrawers();
            const idLimpo = it.id.replace(/^(job-|rotina-)/, "");
            setRoutineInspecaoId(idLimpo);
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("run");
              next.delete("task");
              next.delete("conversa");
              next.set("rotina", idLimpo);
              return next;
            });
          } else if (it.tipo === "conversa") {
            fecharTodosDrawers();
            const idLimpo = it.id.replace(/^(conv-|conversa-|sessao-)/, "");
            setConversaInspecaoId(idLimpo);
            setSearchParams((prev) => {
              const next = new URLSearchParams(prev);
              next.delete("run");
              next.delete("task");
              next.delete("rotina");
              next.set("conversa", idLimpo);
              return next;
            });
          } else {
            fecharTodosDrawers();
            void abrirInspecao(it.id);
          }
        }}
        carregando={carregando}
      />

      {/* Gaveta Lateral Forense com as 6 Abas Analíticas (Execução / Fluxo) */}
      <HistoryInspectionDrawer
        item={itemSelecionado}
        log={logRun}
        acoes={acoesRun}
        diff={diffRun}
        arquivosDiff={arquivosDiff}
        commitHashDiff={commitHashDiff}
        carregandoDetalhes={carregandoDetalhes}
        carregandoAcoes={carregandoAcoes}
        carregandoDiff={carregandoDiff}
        onClose={fecharInspecao}
        onAbortar={handleAbortar}
        onRerun={handleRerun}
        onResume={handleResume}
        onRestaurarArquivo={handleRestaurarArquivo}
        onSelecionarSubExecucao={(execFilhaId) => void abrirInspecao(execFilhaId)}
      />

      {/* Gaveta Lateral de Inspeção de Tarefas (Kanban) */}
      <HistoryTaskDrawer
        aberto={Boolean(taskInspecaoId)}
        taskId={taskInspecaoId}
        aoFechar={fecharInspecaoTask}
        aoAbrirExecucao={(execId) => {
          fecharInspecaoTask();
          void abrirInspecao(execId);
        }}
      />

      {/* Gaveta Lateral de Inspeção de Rotinas (Scheduler) */}
      <HistoryRoutineDrawer
        aberto={Boolean(routineInspecaoId)}
        rotinaId={routineInspecaoId}
        aoFechar={fecharInspecaoRoutine}
        aoAbrirExecucao={(execId) => {
          fecharInspecaoRoutine();
          void abrirInspecao(execId);
        }}
      />

      {/* Gaveta Lateral de Conversas (Secretário) */}
      <HistoryConversationDrawer
        aberto={Boolean(conversaInspecaoId)}
        sessaoId={conversaInspecaoId}
        aoFechar={fecharInspecaoConversa}
      />
    </div>
  );
};
