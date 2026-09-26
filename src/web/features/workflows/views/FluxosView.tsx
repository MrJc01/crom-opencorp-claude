import React, { useState, useEffect, useCallback, useMemo, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import type { FluxoCompleto, NoGrafo, FlowRunLog } from "../types.js";
import {
  GraphCanvas,
  ComponentPalette,
  NodeConfigDrawer,
  WorkflowHeader,
  WorkflowList,
  ModalNovoWorkflow,
  ModalExecutarWorkflow,
  ExecutionLogsPanel,
} from "../components/index.js";

export const FluxosView: FC = () => {
  const { client, workspaceId, tratarErro } = useOpenCorp();
  const [searchParams, setSearchParams] = useSearchParams();
  const fluxoParam = searchParams.get("fluxo");

  // Estado da Lista de Fluxos
  const [fluxos, setFluxos] = useState<FluxoCompleto[]>([]);
  const [carregandoLista, setCarregandoLista] = useState(true);
  const [executandoId, setExecutandoId] = useState<string | null>(null);

  // Estado do Studio / Fluxo Ativo
  const [fluxoAtivo, setFluxoAtivo] = useState<FluxoCompleto | null>(null);
  const [carregandoFluxo, setCarregandoFluxo] = useState(false);
  const [salvandoGrafo, setSalvandoGrafo] = useState(false);
  const [noSelecionado, setNoSelecionado] = useState<NoGrafo | null>(null);

  // Catálogos auxiliares (Agentes, etc.)
  const [agentes, setAgentes] = useState<any[]>([]);

  // Gavetas e Painéis
  const [paletaAberta, setPaletaAberta] = useState(false);
  const [painelLogsAberto, setPainelLogsAberto] = useState(false);
  const [logsExecucoes, setLogsExecucoes] = useState<FlowRunLog[]>([]);
  const [carregandoLogs, setCarregandoLogs] = useState(false);

  // Modais
  const [modalNovoAberto, setModalNovoAberto] = useState(false);
  const [salvandoNovo, setSalvandoNovo] = useState(false);
  const [modalExecutarAberto, setModalExecutarAberto] = useState(false);

  const wsEfetivo = useMemo(() => {
    if (workspaceId) return workspaceId;
    if (typeof window !== "undefined") {
      const salvo = localStorage.getItem("opencorp_workspace_id");
      if (salvo) return salvo;
    }
    return "default";
  }, [workspaceId]);

  // ── Carregar Lista de Fluxos ──────────────────────────────────────────
  const carregarFluxos = useCallback(async () => {
    setCarregandoLista(true);
    try {
      const lista = await client.flows.listar({
        workspaceId: wsEfetivo,
      });
      setFluxos((lista as unknown as FluxoCompleto[]) || []);
    } catch (err) {
      tratarErro(err, "Falha ao carregar lista de fluxos");
    } finally {
      setCarregandoLista(false);
    }
  }, [client, wsEfetivo, tratarErro]);

  // Carregar Agentes para o NodeConfigDrawer
  const carregarAgentes = useCallback(async () => {
    try {
      const lista = await client.agents.listar({
        workspaceId: wsEfetivo,
      });
      setAgentes(lista || []);
    } catch {
      setAgentes([]);
    }
  }, [client, wsEfetivo]);

  useEffect(() => {
    void carregarFluxos();
    void carregarAgentes();
  }, [carregarFluxos, carregarAgentes]);

  // ── Carregar Logs do Fluxo Ativo ───────────────────────────────────────
  const carregarLogs = useCallback(
    async (id: string) => {
      setCarregandoLogs(true);
      try {
        const runs = await client.http.get<FlowRunLog[]>(
          `/flows/${encodeURIComponent(id)}/runs`,
          {
            headers: { "x-opencorp-workspace": wsEfetivo },
          }
        );
        setLogsExecucoes(Array.isArray(runs) ? runs : []);
      } catch {
        setLogsExecucoes([]);
      } finally {
        setCarregandoLogs(false);
      }
    },
    [client, wsEfetivo]
  );

  // ── Carregar Fluxo Específico (Studio) ──────────────────────────────────
  const carregarFluxoAtivo = useCallback(
    async (id: string) => {
      setCarregandoFluxo(true);
      try {
        const f = await client.flows.obter(id, {
          workspaceId: wsEfetivo,
        });
        setFluxoAtivo((f as unknown as FluxoCompleto) || null);
        setNoSelecionado(null);
        void carregarLogs(id);
      } catch (err) {
        tratarErro(err, `Falha ao carregar o fluxo "${id}"`);
        // Se não encontrar o fluxo, volta à lista
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("fluxo");
          return next;
        }, { replace: true });
        setFluxoAtivo(null);
      } finally {
        setCarregandoFluxo(false);
      }
    },
    [client, wsEfetivo, tratarErro, carregarLogs, setSearchParams]
  );

  // Sincroniza parâmetro da URL com o fluxo ativo
  useEffect(() => {
    if (fluxoParam) {
      if (!fluxoAtivo || fluxoAtivo.id !== fluxoParam) {
        void carregarFluxoAtivo(fluxoParam);
      }
    } else {
      if (fluxoAtivo) {
        setFluxoAtivo(null);
        setNoSelecionado(null);
        setLogsExecucoes([]);
        setPainelLogsAberto(false);
      }
    }
  }, [fluxoParam, fluxoAtivo, carregarFluxoAtivo]);

  // Mantém o Studio sincronizado quando o Secretário/API salva o fluxo aberto.
  useEffect(() => {
    if (!fluxoParam || typeof window === "undefined") return;
    const aoSalvarRemotamente = (evento: Event) => {
      const detail = (evento as CustomEvent<{ flow?: string }>).detail;
      if (detail?.flow === fluxoParam) void carregarFluxoAtivo(fluxoParam);
    };
    const aoExcluirRemotamente = (evento: Event) => {
      const detail = (evento as CustomEvent<{ flow?: string }>).detail;
      if (detail?.flow !== fluxoParam) return;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("fluxo");
        return next;
      }, { replace: true });
      setFluxoAtivo(null);
      void carregarFluxos();
    };
    const aoFinalizarSecretario = (evento: Event) => {
      const detail = (evento as CustomEvent<{ fase?: string; fluxos?: string[] }>).detail;
      if (detail?.fase === "fim" && detail.fluxos?.includes(fluxoParam)) {
        void carregarFluxoAtivo(fluxoParam);
      }
    };
    window.addEventListener("flow-salvo", aoSalvarRemotamente);
    window.addEventListener("flow-excluido", aoExcluirRemotamente);
    window.addEventListener("secretario:mensagem", aoFinalizarSecretario);
    return () => {
      window.removeEventListener("flow-salvo", aoSalvarRemotamente);
      window.removeEventListener("flow-excluido", aoExcluirRemotamente);
      window.removeEventListener("secretario:mensagem", aoFinalizarSecretario);
    };
  }, [fluxoParam, carregarFluxoAtivo, carregarFluxos, setSearchParams]);

  // ── Navegação: Abrir Studio vs Voltar para Lista ───────────────────────
  const handleAbrirStudio = (id: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("fluxo", id);
      return next;
    });
  };

  const handleVoltarParaLista = () => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("fluxo");
      return next;
    }, { replace: true });
    setFluxoAtivo(null);
    setNoSelecionado(null);
    setPainelLogsAberto(false);
    void carregarFluxos();
  };

  // ── Atualizações do Grafo ─────────────────────────────────────────────
  const handleAtualizarGrafo = useCallback(
    (novosNos: NoGrafo[], novasArestas: any[]) => {
      if (!fluxoAtivo) return;
      setFluxoAtivo({
        ...fluxoAtivo,
        nos: novosNos,
        arestas: novasArestas,
      });
    },
    [fluxoAtivo]
  );

  // Salvar Grafo no Servidor
  const handleSalvarGrafo = async () => {
    if (!fluxoAtivo) return;
    setSalvandoGrafo(true);
    try {
      const payload = {
        id: fluxoAtivo.id,
        nome: fluxoAtivo.nome,
        descricao: fluxoAtivo.descricao,
        ativo: fluxoAtivo.ativo ?? true,
        nos: fluxoAtivo.nos || [],
        arestas: fluxoAtivo.arestas || [],
      };

      await client.flows.atualizar(fluxoAtivo.id, payload as any, {
        workspaceId: wsEfetivo,
      });

      showToast(`Fluxo "${fluxoAtivo.nome || fluxoAtivo.id}" salvo com sucesso!`, "sucesso");
    } catch (err) {
      tratarErro(err, "Falha ao salvar grafo de fluxo");
    } finally {
      setSalvandoGrafo(false);
    }
  };

  // ── Operações de Nós (Adicionar, Configurar, Excluir) ───────────────────
  const handleAdicionarNodeTipo = (tipo: string, posicao?: { x: number; y: number }) => {
    if (!fluxoAtivo) return;

    // Gera ID único
    const countExistente = (fluxoAtivo.nos || []).filter((n) => n.tipo === tipo).length;
    const novoId = `${tipo}-${countExistente + 1}`;

    const pos = posicao || {
      x: 100 + (fluxoAtivo.nos?.length || 0) * 80,
      y: 120 + ((fluxoAtivo.nos?.length || 0) % 3) * 100,
    };

    const novoNo: NoGrafo = {
      id: novoId,
      tipo,
      config:
        tipo === "cron"
          ? { cron: "0 */3 * * *" }
          : tipo === "agente"
          ? { modelo: "nemotron-3-super-120b", ordem: "" }
          : tipo === "script"
          ? { runtime: "python", script: "", timeout_ms: 30000 }
          : tipo === "condicao"
          ? { expressao: "ctx.ok === true" }
          : {},
      pos,
    };

    const novosNos = [...(fluxoAtivo.nos || []), novoNo];
    setFluxoAtivo({
      ...fluxoAtivo,
      nos: novosNos,
    });

    setNoSelecionado(novoNo);
    setPaletaAberta(false);
    showToast(`Nó "${novoId}" adicionado ao canvas.`, "info");
  };

  const handleSalvarNoConfig = (noAtualizado: NoGrafo) => {
    if (!fluxoAtivo) return;

    const antigosNos = fluxoAtivo.nos || [];
    const idAntigo = noSelecionado?.id || noAtualizado.id;

    const novosNos = antigosNos.map((n) => (n.id === idAntigo ? noAtualizado : n));

    // Se o ID do nó mudou, atualiza referências nas arestas
    let novasArestas = fluxoAtivo.arestas || [];
    if (idAntigo !== noAtualizado.id) {
      novasArestas = novasArestas.map((a) => ({
        ...a,
        de: a.de === idAntigo ? noAtualizado.id : a.de,
        para: a.para === idAntigo ? noAtualizado.id : a.para,
      }));
    }

    setFluxoAtivo({
      ...fluxoAtivo,
      nos: novosNos,
      arestas: novasArestas,
    });
    setNoSelecionado(noAtualizado);
  };

  const handleExcluirNo = (noId: string) => {
    if (!fluxoAtivo) return;

    const novosNos = (fluxoAtivo.nos || []).filter((n) => n.id !== noId);
    const novasArestas = (fluxoAtivo.arestas || []).filter(
      (a) => a.de !== noId && a.para !== noId
    );

    setFluxoAtivo({
      ...fluxoAtivo,
      nos: novosNos,
      arestas: novasArestas,
    });
    setNoSelecionado(null);
    showToast(`Nó "${noId}" removido do fluxo.`, "info");
  };

  // ── Conexões n8n-style no Drawer ─────────────────────────────────────
  const handleAdicionarAresta = useCallback(
    (origem: string, destino: string, label?: string) => {
      if (!fluxoAtivo) return;
      const arestasAtuais = fluxoAtivo.arestas || [];
      const jaExiste = arestasAtuais.some(
        (a) =>
          (a.de === origem || a.source === origem) &&
          (a.para === destino || a.target === destino)
      );
      if (jaExiste) {
        showToast("Essa conexão já existe no fluxo.", "aviso");
        return;
      }
      const novaAresta = {
        id: `e-${origem}-${destino}-${Date.now()}`,
        de: origem,
        para: destino,
        source: origem,
        target: destino,
        condicao: label,
        label: label,
      };
      setFluxoAtivo({
        ...fluxoAtivo,
        arestas: [...arestasAtuais, novaAresta],
      });
      showToast(`Conexão de "${origem}" para "${destino}" criada!`, "sucesso");
    },
    [fluxoAtivo]
  );

  const handleRemoverAresta = useCallback(
    (origemOuId: string, destino?: string) => {
      if (!fluxoAtivo) return;
      const arestasAtuais = fluxoAtivo.arestas || [];
      let novasArestas: any[];
      if (destino) {
        novasArestas = arestasAtuais.filter(
          (a) =>
            !(
              (a.de === origemOuId || a.source === origemOuId) &&
              (a.para === destino || a.target === destino)
            )
        );
      } else {
        novasArestas = arestasAtuais.filter(
          (a) =>
            a.id !== origemOuId &&
            `${a.de}->${a.para}` !== origemOuId &&
            `${a.source}->${a.target}` !== origemOuId
        );
      }
      setFluxoAtivo({
        ...fluxoAtivo,
        arestas: novasArestas,
      });
      showToast("Conexão removida.", "info");
    },
    [fluxoAtivo]
  );

  // ── Auto-Layout DAG Simples ───────────────────────────────────────────
  const handleAutoLayout = () => {
    if (!fluxoAtivo) return;
    const nos = fluxoAtivo.nos || [];
    const arestas = fluxoAtivo.arestas || [];

    // Calcula níveis a partir dos nós sem entrada (raízes)
    const entradasCount = new Map<string, number>();
    nos.forEach((n) => entradasCount.set(n.id, 0));
    arestas.forEach((a) => {
      entradasCount.set(a.para, (entradasCount.get(a.para) || 0) + 1);
    });

    const niveis = new Map<string, number>();
    const fila: string[] = [];

    nos.forEach((n) => {
      if ((entradasCount.get(n.id) || 0) === 0) {
        niveis.set(n.id, 0);
        fila.push(n.id);
      }
    });

    while (fila.length > 0) {
      const atual = fila.shift()!;
      const nivelAtual = niveis.get(atual) || 0;
      const sucessores = arestas.filter((a) => a.de === atual).map((a) => a.para);

      sucessores.forEach((suc) => {
        const nivelExistente = niveis.get(suc) || 0;
        if (nivelAtual + 1 > nivelExistente) {
          niveis.set(suc, nivelAtual + 1);
          fila.push(suc);
        }
      });
    }

    // Agrupa nós por nível
    const nósPorNivel = new Map<number, string[]>();
    nos.forEach((n) => {
      const lvl = niveis.get(n.id) || 0;
      if (!nósPorNivel.has(lvl)) nósPorNivel.set(lvl, []);
      nósPorNivel.get(lvl)!.push(n.id);
    });

    const novosNos = nos.map((n) => {
      const lvl = niveis.get(n.id) || 0;
      const listaDoNivel = nósPorNivel.get(lvl) || [n.id];
      const indexNoNivel = listaDoNivel.indexOf(n.id);

      return {
        ...n,
        pos: {
          x: lvl * 320 + 80,
          y: indexNoNivel * 180 + 80,
        },
      };
    });

    setFluxoAtivo({
      ...fluxoAtivo,
      nos: novosNos,
    });
    showToast("Layout automático aplicado com sucesso.", "info");
  };

  // ── Execuções de Fluxo ────────────────────────────────────────────────
  const dispararExecucao = async (id: string, payload?: any, nome?: string) => {
    setExecutandoId(id);
    try {
      const exec = await client.flows.executar(id, payload, {
        workspaceId: wsEfetivo,
      });
      const execId = typeof exec?.exec_id === "string" ? exec.exec_id : undefined;
      showToast(`Fluxo "${nome || id}" iniciado com sucesso!${execId ? ` (exec_id ${execId})` : ""}`, "sucesso");
      if (fluxoAtivo && fluxoAtivo.id === id) {
        setPainelLogsAberto(true);
        void carregarLogs(id);
      }
    } catch (err) {
      tratarErro(err, `Falha ao executar fluxo "${nome || id}"`);
    } finally {
      setExecutandoId(null);
    }
  };

  // ── Criar Novo Fluxo (Templates) ──────────────────────────────────────
  const handleCriarFluxo = async ({
    id,
    nome,
    descricao,
    template,
  }: {
    id: string;
    nome: string;
    descricao: string;
    template: "pipeline" | "fanout" | "review" | "debate";
  }) => {
    setSalvandoNovo(true);
    try {
      let nos: NoGrafo[] = [];
      let arestas: any[] = [];

      if (template === "pipeline") {
        nos = [
          { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
          {
            id: "agente-executor",
            tipo: "agente",
            config: { modelo: "nemotron-3-super-120b", ordem: "Executar instrução" },
            pos: { x: 380, y: 140 },
          },
          { id: "saida", tipo: "saida", pos: { x: 680, y: 140 } },
        ];
        arestas = [
          { de: "gatilho-manual", para: "agente-executor" },
          { de: "agente-executor", para: "saida" },
        ];
      } else if (template === "fanout") {
        nos = [
          { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
          { id: "equipe-fanout", tipo: "fanout", pos: { x: 380, y: 140 } },
          { id: "saida", tipo: "saida", pos: { x: 680, y: 140 } },
        ];
        arestas = [
          { de: "gatilho-manual", para: "equipe-fanout" },
          { de: "equipe-fanout", para: "saida" },
        ];
      } else if (template === "review") {
        nos = [
          { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
          { id: "equipe-review", tipo: "review", pos: { x: 380, y: 140 } },
          { id: "saida", tipo: "saida", pos: { x: 680, y: 140 } },
        ];
        arestas = [
          { de: "gatilho-manual", para: "equipe-review" },
          { de: "equipe-review", para: "saida" },
        ];
      } else {
        nos = [
          { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
          { id: "equipe-debate", tipo: "debate", pos: { x: 380, y: 140 } },
          { id: "saida", tipo: "saida", pos: { x: 680, y: 140 } },
        ];
        arestas = [
          { de: "gatilho-manual", para: "equipe-debate" },
          { de: "equipe-debate", para: "saida" },
        ];
      }

      const novo = await client.flows.criar(
        {
          id,
          nome,
          descricao,
          nos: nos as any,
          arestas: arestas as any,
          ativo: true,
        },
        { workspaceId: wsEfetivo }
      );

      showToast(`Fluxo "${nome}" criado com sucesso!`, "sucesso");
      handleAbrirStudio(novo.id);
    } catch (err) {
      tratarErro(err, "Falha ao criar novo fluxo");
    } finally {
      setSalvandoNovo(false);
    }
  };

  // ── Importar Arquivo JSON ─────────────────────────────────────────────
  const handleImportarArquivo = async (conteudoJson: any) => {
    try {
      if (!conteudoJson || !conteudoJson.id) {
        showToast("O arquivo JSON de fluxo precisa conter a propriedade 'id'.", "erro");
        return;
      }

      await client.flows.criar(conteudoJson, {
        workspaceId: wsEfetivo,
      });

      showToast(`Fluxo "${conteudoJson.nome || conteudoJson.id}" importado com sucesso!`, "sucesso");
      await carregarFluxos();
      handleAbrirStudio(conteudoJson.id);
    } catch (err) {
      tratarErro(err, "Falha ao importar arquivo JSON de fluxo");
    }
  };

  // ── Toggle Ativo/Inativo ──────────────────────────────────────────────
  const handleToggleAtivo = async (fluxoId: string, novoAtivo: boolean) => {
    try {
      await client.flows.atualizar(
        fluxoId,
        { ativo: novoAtivo },
        { workspaceId: wsEfetivo }
      );

      if (fluxoAtivo && fluxoAtivo.id === fluxoId) {
        setFluxoAtivo({ ...fluxoAtivo, ativo: novoAtivo });
      }

      setFluxos((atuais) =>
        atuais.map((f) => (f.id === fluxoId ? { ...f, ativo: novoAtivo } : f))
      );

      showToast(`Fluxo "${fluxoId}" ${novoAtivo ? "ativado" : "pausado"}.`, "info");
    } catch (err) {
      tratarErro(err, "Falha ao alternar estado do fluxo");
    }
  };

  // ── Excluir Fluxo ─────────────────────────────────────────────────────
  const handleExcluirFluxo = async (fluxoId: string, nome?: string) => {
    if (!window.confirm(`Deseja realmente remover o fluxo "${nome || fluxoId}"?`)) {
      return;
    }

    try {
      await client.flows.deletar(fluxoId, {
        workspaceId: wsEfetivo,
      });

      showToast(`Fluxo "${nome || fluxoId}" excluído com sucesso.`, "sucesso");
      if (fluxoAtivo && fluxoAtivo.id === fluxoId) {
        handleVoltarParaLista();
      } else {
        await carregarFluxos();
      }
    } catch (err) {
      tratarErro(err, "Falha ao excluir fluxo");
    }
  };

  // Exportar JSON do fluxo ativo
  const handleExportarAtivo = () => {
    if (!fluxoAtivo) return;
    const blob = new Blob([JSON.stringify(fluxoAtivo, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fluxoAtivo.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`Arquivo ${fluxoAtivo.id}.json exportado!`, "sucesso");
  };

  // ── RENDERIZAÇÃO: Studio Canvas vs Lista de Fluxos ─────────────────────
  if (fluxoParam && fluxoAtivo) {
    return (
      <div className="flex flex-col h-full w-full bg-zinc-950 overflow-hidden relative select-none">
        {/* Header do Studio */}
        <WorkflowHeader
          fluxo={fluxoAtivo}
          logsCount={logsExecucoes.length}
          painelLogsAberto={painelLogsAberto}
          salvando={salvandoGrafo}
          executando={executandoId === fluxoAtivo.id}
          onVoltar={handleVoltarParaLista}
          onAbrirPaleta={() => setPaletaAberta(true)}
          onToggleLogs={() => setPainelLogsAberto(!painelLogsAberto)}
          onSalvarGrafo={handleSalvarGrafo}
          onExecutar={() => setModalExecutarAberto(true)}
          onToggleAtivo={(ativo) => handleToggleAtivo(fluxoAtivo.id, ativo)}
          onRenomearFluxo={(novoNome) =>
            setFluxoAtivo({ ...fluxoAtivo, nome: novoNome })
          }
          onExportarJson={handleExportarAtivo}
          onExcluirFluxo={() => handleExcluirFluxo(fluxoAtivo.id, fluxoAtivo.nome)}
          onResetLayout={handleAutoLayout}
        />

        {/* Canvas de Nós com React Flow */}
        <div className="flex-1 w-full h-full relative overflow-hidden">
          <GraphCanvas
            fluxo={fluxoAtivo}
            noSelecionadoId={noSelecionado?.id || null}
            onSelecionarNo={setNoSelecionado}
            onAtualizarGrafo={handleAtualizarGrafo}
            onAdicionarNodeTipo={handleAdicionarNodeTipo}
          />

          {/* Paleta Lateral Esquerda (Drawer Retrátil) */}
          <ComponentPalette
            aberto={paletaAberta}
            onClose={() => setPaletaAberta(false)}
            onAdicionarNode={(tipo) => handleAdicionarNodeTipo(tipo)}
          />

          {/* Gaveta Lateral Direita de Configuração do Nó (NDV) */}
          <NodeConfigDrawer
            no={noSelecionado}
            fluxo={fluxoAtivo}
            agentes={agentes}
            fluxosExistentes={fluxos}
            arestas={(fluxoAtivo.arestas || []).map((a, idx) => ({
              id: a.id || `aresta-${a.de || a.source}-${a.para || a.target}-${idx}`,
              source: a.de || a.source,
              target: a.para || a.target,
              de: a.de || a.source,
              para: a.para || a.target,
              label: a.condicao || a.label,
            }))}
            nosDisponiveis={(fluxoAtivo.nos || []).map((n) => ({
              id: n.id,
              nome: n.nome || n.id,
              tipo: n.tipo,
            }))}
            aoRemoverAresta={handleRemoverAresta}
            aoAdicionarAresta={handleAdicionarAresta}
            onClose={() => setNoSelecionado(null)}
            onSalvarNo={handleSalvarNoConfig}
            onExcluirNo={handleExcluirNo}
          />
        </div>

        {/* Painel Inferior de Logs de Execução & I/O */}
        <ExecutionLogsPanel
          fluxoId={fluxoAtivo.id}
          logs={logsExecucoes}
          aberto={painelLogsAberto}
          carregando={carregandoLogs}
          onToggleAberto={() => setPainelLogsAberto(!painelLogsAberto)}
          onRecarregar={() => carregarLogs(fluxoAtivo.id)}
        />

        {/* Modal de Disparo com Payload */}
        <ModalExecutarWorkflow
          aberto={modalExecutarAberto}
          fluxo={fluxoAtivo}
          executando={executandoId === fluxoAtivo.id}
          onClose={() => setModalExecutarAberto(false)}
          onConfirmar={async (payload) => {
            await dispararExecucao(fluxoAtivo.id, payload, fluxoAtivo.nome);
          }}
        />
      </div>
    );
  }

  // Visão de Lista de Fluxos (sem parâmetro na URL)
  return (
    <div className="flex flex-col h-full w-full bg-zinc-950 overflow-hidden">
      <WorkflowList
        fluxos={fluxos}
        carregando={carregandoLista}
        executandoId={executandoId}
        onAbrirStudio={handleAbrirStudio}
        onRecarregar={carregarFluxos}
        onNovoFluxo={() => setModalNovoAberto(true)}
        onExecutarFluxo={(id, nome) => dispararExecucao(id, undefined, nome)}
        onExcluirFluxo={handleExcluirFluxo}
        onImportarArquivo={handleImportarArquivo}
        onToggleAtivo={handleToggleAtivo}
      />

      {/* Modal de Novo Fluxo */}
      <ModalNovoWorkflow
        aberto={modalNovoAberto}
        salvando={salvandoNovo}
        onClose={() => setModalNovoAberto(false)}
        onCriarFluxo={handleCriarFluxo}
      />
    </div>
  );
};
