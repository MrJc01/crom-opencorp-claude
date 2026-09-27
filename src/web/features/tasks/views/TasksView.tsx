import React, { useState, useEffect, useCallback, useMemo, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import {
  type Task,
  type AgentResumo,
  type CriarTaskInput,
} from "@opencorp/sdk";
import { showToast } from "../../../shared/ui/Toast.js";
import { TaskFilters } from "../components/TaskFilters.js";
import { TaskCard } from "../components/TaskCard.js";
import { TaskDetailsDrawer } from "../components/TaskDetailsDrawer.js";
import { TaskCreateModal } from "../components/TaskCreateModal.js";

interface ColunaDef {
  id: "backlog" | "fazendo" | "bloqueado" | "feito";
  nome: string;
  corBorda: string;
  badgeCor: string;
}

const COLUNAS: ColunaDef[] = [
  {
    id: "backlog",
    nome: "A Fazer",
    corBorda: "border-zinc-700 text-zinc-300",
    badgeCor: "bg-zinc-800 text-zinc-300",
  },
  {
    id: "fazendo",
    nome: "Em Progresso",
    corBorda: "border-blue-500 text-blue-400",
    badgeCor: "bg-blue-950/60 border border-blue-800/40 text-blue-300",
  },
  {
    id: "bloqueado",
    nome: "Revisão / Bloqueado",
    corBorda: "border-amber-500 text-amber-400",
    badgeCor: "bg-amber-950/60 border border-amber-800/40 text-amber-300",
  },
  {
    id: "feito",
    nome: "Concluído",
    corBorda: "border-emerald-500 text-emerald-400",
    badgeCor: "bg-emerald-950/60 border border-emerald-800/40 text-emerald-300",
  },
];

export const TasksView: FC = () => {
  const { client, tratarErro } = useOpenCorp();
  const [searchParams, setSearchParams] = useSearchParams();

  const [tasks, setTasks] = useState<Task[]>([]);
  const [agentes, setAgentes] = useState<AgentResumo[]>([]);
  const [carregando, setCarregando] = useState(true);

  // Filtros
  const [busca, setBusca] = useState("");
  const [filtroResponsavel, setFiltroResponsavel] = useState("todos");

  // Modais e Drawer
  const [modalCriarAberto, setModalCriarAberto] = useState(false);
  const [taskSelecionada, setTaskSelecionada] = useState<Task | null>(null);
  const [executandoIds, setExecutandoIds] = useState<Set<string>>(new Set());
  const [colunaArrastandoSobre, setColunaArrastandoSobre] = useState<string | null>(null);

  // Carregamento de Tarefas e Agentes
  const carregarDados = useCallback(async (silencioso = false) => {
    if (!silencioso) setCarregando(true);
    try {
      const [listaTasks, listaAgentes] = await Promise.all([
        client.tasks.listar(),
        client.agents.listar(),
      ]);
      setTasks(listaTasks || []);
      setAgentes(listaAgentes || []);
    } catch (err) {
      if (!silencioso) {
        tratarErro(err, "Falha ao carregar tarefas do Kanban");
      }
    } finally {
      if (!silencioso) setCarregando(false);
    }
  }, [client, tratarErro]);

  useEffect(() => {
    void carregarDados();
  }, [carregarDados]);

  // Polling inteligente de 4 segundos quando a janela estiver ativa
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && !document.hidden) {
        void carregarDados(true);
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [carregarDados]);

  // Sincronização com URL (?task=tsk-xxx)
  const taskIdUrl = searchParams.get("task");
  useEffect(() => {
    if (taskIdUrl) {
      const t = tasks.find((item) => item.id === taskIdUrl);
      if (t) {
        setTaskSelecionada(t);
      } else {
        void client.tasks
          .obter(taskIdUrl)
          .then((encontrada) => {
            if (encontrada) setTaskSelecionada(encontrada);
          })
          .catch((err) => {
            tratarErro(err, "Falha ao carregar detalhes da tarefa selecionada");
          });
      }
    } else {
      setTaskSelecionada(null);
    }
  }, [taskIdUrl, tasks, client.tasks, tratarErro]);

  const abrirDetalhes = (task: Task) => {
    setTaskSelecionada(task);
    setSearchParams({ task: task.id });
  };

  const fecharDetalhes = () => {
    setTaskSelecionada(null);
    setSearchParams({});
  };

  // Mutações de Tarefas com rollback em caso de falha
  const moverTask = async (task: Task, novaColuna: string) => {
    const colunaAnterior = task.coluna;

    // Atualização otimista
    setTasks((prev) =>
      prev.map((t) => (t.id === task.id ? { ...t, coluna: novaColuna } : t)),
    );
    if (taskSelecionada?.id === task.id) {
      setTaskSelecionada((prev) => (prev ? { ...prev, coluna: novaColuna } : null));
    }

    try {
      await client.tasks.mover(task.id, novaColuna);
      showToast(`Tarefa movida para "${novaColuna}"`, "info");
    } catch (err) {
      // Reversão em caso de erro no backend
      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, coluna: colunaAnterior } : t)),
      );
      if (taskSelecionada?.id === task.id) {
        setTaskSelecionada((prev) => (prev ? { ...prev, coluna: colunaAnterior } : null));
      }
      tratarErro(err, "Falha ao mover tarefa");
    }
  };

  const excluirTask = async (id: string) => {
    try {
      await client.tasks.deletar(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      if (taskSelecionada?.id === id) {
        fecharDetalhes();
      }
      showToast("Tarefa excluída com sucesso", "sucesso");
    } catch (err) {
      tratarErro(err, "Erro ao excluir tarefa");
    }
  };

  const executarTask = async (task: Task, instrucaoExtra?: string) => {
    const rawResp = task.responsavel || "";
    const semPrefixo = rawResp.replace(/^@/, "").replace(/^agente:/, "").trim();
    const agenteId = semPrefixo || agentes[0]?.id || "secretario-exec";

    setExecutandoIds((prev) => new Set(prev).add(task.id));

    try {
      let ordem = `Executar tarefa [${task.id}] "${task.titulo || ""}": ${task.descricao || ""}`.trim();
      if (instrucaoExtra && instrucaoExtra.trim()) {
        ordem = `${ordem}\n\n[Instrução do Operador]:\n${instrucaoExtra.trim()}`;
      }

      const disp = await client.agents.executar(agenteId, { ordem });
      const execId = disp?.exec_id;

      // Se estiver em backlog ou bloqueado, move automaticamente para fazendo
      if (task.coluna === "backlog" || task.coluna === "bloqueado") {
        try {
          await client.tasks.mover(task.id, "fazendo");
          setTasks((prev) =>
            prev.map((t) => (t.id === task.id ? { ...t, coluna: "fazendo" } : t)),
          );
          if (taskSelecionada?.id === task.id) {
            setTaskSelecionada((prev) => (prev ? { ...prev, coluna: "fazendo" } : null));
          }
        } catch (moveErr) {
          tratarErro(moveErr, "Falha ao atualizar coluna da tarefa para 'fazendo'");
        }
      }

      // Registra mensagem informativa no chat da task
      try {
        await client.tasks.adicionarMensagem(task.id, {
          corpo: `[EXECUÇÃO INICIADA] Disparado agente @${agenteId} para trabalhar nesta tarefa.${
            execId ? ` (exec ${execId})` : ""
          }`,
          autor: "sistema",
          tipo: "sistema",
          refs: execId ? [execId] : undefined,
        });
      } catch (msgErr) {
        tratarErro(msgErr, "Falha ao registrar histórico de execução na tarefa");
      }

      showToast(
        `Execução da tarefa iniciada com @${agenteId}!${execId ? ` (exec ${execId})` : ""}`,
        "sucesso",
      );
    } catch (err) {
      tratarErro(err, "Erro ao disparar execução da tarefa");
    } finally {
      setExecutandoIds((prev) => {
        const next = new Set(prev);
        next.delete(task.id);
        return next;
      });
    }
  };

  const desbloquearEAprovarTask = async (task: Task) => {
    try {
      await client.tasks.mover(task.id, "fazendo");
      try {
        await client.tasks.adicionarMensagem(task.id, {
          corpo: "[DESBLOQUEIO / APROVAÇÃO] Tarefa aprovada e desbloqueada pelo operador.",
          autor: "humano",
          tipo: "aprovacao",
        });
      } catch (msgErr) {
        tratarErro(msgErr, "Falha ao registrar aprovação no histórico da tarefa");
      }

      setTasks((prev) =>
        prev.map((t) => (t.id === task.id ? { ...t, coluna: "fazendo", bloqueada: false } : t)),
      );

      if (taskSelecionada?.id === task.id) {
        setTaskSelecionada((prev) =>
          prev ? { ...prev, coluna: "fazendo", bloqueada: false } : null,
        );
      }

      showToast("Tarefa aprovada e desbloqueada!", "sucesso");
      void executarTask({ ...task, coluna: "fazendo", bloqueada: false });
    } catch (err) {
      tratarErro(err, "Erro ao desbloquear tarefa");
    }
  };

  const criarTask = async (payload: CriarTaskInput) => {
    try {
      const criada = await client.tasks.criar(payload);
      setTasks((prev) => [...prev, criada]);
      showToast(`Tarefa "${criada.titulo || criada.id}" criada com sucesso!`, "sucesso");

      if (payload.executar_agora) {
        void executarTask(criada);
      }
    } catch (err) {
      tratarErro(err, "Erro ao criar tarefa");
    }
  };

  // Filtragem
  const semPrefixoAgente = (r?: string | null) =>
    String(r || "").replace(/^@/, "").replace(/^agente:/, "");

  const tasksFiltradas = useMemo(() => {
    return tasks.filter((t) => {
      const matchResp =
        filtroResponsavel === "todos" ||
        semPrefixoAgente(t.responsavel) === filtroResponsavel;

      const termo = busca.toLowerCase().trim();
      const matchBusca =
        !termo ||
        (t.titulo && t.titulo.toLowerCase().includes(termo)) ||
        (t.descricao && t.descricao.toLowerCase().includes(termo)) ||
        t.id.toLowerCase().includes(termo);

      return matchResp && matchBusca;
    });
  }, [tasks, busca, filtroResponsavel]);

  const handleDragOver = (e: React.DragEvent, colId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (colunaArrastandoSobre !== colId) {
      setColunaArrastandoSobre(colId);
    }
  };

  const handleDragLeave = (colId: string) => {
    if (colunaArrastandoSobre === colId) {
      setColunaArrastandoSobre(null);
    }
  };

  const handleDrop = async (e: React.DragEvent, colId: string) => {
    e.preventDefault();
    setColunaArrastandoSobre(null);
    const taskId = e.dataTransfer.getData("text/plain");
    if (!taskId) return;
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.coluna !== colId) {
      await moverTask(task, colId);
    }
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden p-6 space-y-4 bg-zinc-950">
      {/* Barra de Filtros e Ações */}
      <TaskFilters
        busca={busca}
        aoMudarBusca={setBusca}
        responsavel={filtroResponsavel}
        aoMudarResponsavel={setFiltroResponsavel}
        agentes={agentes}
        aoNovaTarefa={() => setModalCriarAberto(true)}
        aoAtualizar={() => void carregarDados()}
        carregando={carregando}
      />

      {/* Grid Kanban das 4 Colunas */}
      <div className="flex-1 flex gap-4 min-h-0 overflow-x-auto pb-4 scrollbar-thin">
        {COLUNAS.map((col) => {
          const itens = tasksFiltradas.filter((t) => (t.coluna || "backlog") === col.id);
          const isArrastando = colunaArrastandoSobre === col.id;

          return (
            <div
              key={col.id}
              data-testid={`kanban-coluna-${col.id}`}
              role="region"
              aria-label={`Coluna ${col.id}`}
              onDragOver={(e) => handleDragOver(e, col.id)}
              onDragLeave={() => handleDragLeave(col.id)}
              onDrop={(e) => void handleDrop(e, col.id)}
              className={`flex flex-col h-full rounded-2xl border p-3.5 flex-1 min-w-[280px] max-w-[360px] shrink-0 shadow-xs transition-all duration-150 ${
                isArrastando
                  ? "bg-zinc-850/80 border-emerald-500/80 ring-2 ring-emerald-500/30"
                  : "bg-zinc-900/40 border-zinc-800/80"
              }`}
            >
              {/* Header da Coluna */}
              <div className={`flex items-center justify-between pb-2.5 mb-2.5 border-b-2 ${col.corBorda}`}>
                <span className="text-xs font-bold tracking-tight text-zinc-100">
                  {col.nome}
                </span>
                <span className={`text-[11px] font-mono px-2 py-0.5 rounded-full ${col.badgeCor}`}>
                  {itens.length}
                </span>
              </div>

              {/* Cards da Coluna */}
              <div className="flex-1 overflow-y-auto space-y-2.5 scrollbar-thin pr-1">
                {itens.length === 0 && (
                  <div className="h-28 flex items-center justify-center text-xs text-zinc-600 border border-dashed border-zinc-800/80 rounded-xl">
                    Nenhuma tarefa
                  </div>
                )}

                {itens.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    selecionada={taskSelecionada?.id === task.id}
                    aoSelecionar={abrirDetalhes}
                    aoMover={moverTask}
                    aoExcluir={excluirTask}
                    aoExecutar={executarTask}
                    executando={executandoIds.has(task.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Drawer Lateral de Detalhes da Tarefa */}
      <TaskDetailsDrawer
        task={taskSelecionada}
        agentes={agentes}
        aoFechar={fecharDetalhes}
        aoMover={moverTask}
        aoExcluir={excluirTask}
        aoExecutar={executarTask}
        aoDesbloquearEAprovar={desbloquearEAprovarTask}
      />

      {/* Modal de Criação de Tarefa */}
      <TaskCreateModal
        aberto={modalCriarAberto}
        agentes={agentes}
        aoFechar={() => setModalCriarAberto(false)}
        aoCriar={criarTask}
      />
    </div>
  );
};
