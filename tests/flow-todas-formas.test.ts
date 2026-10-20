import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FlowStore, type SessaoFlow } from "../src/core/contexts/orchestration/flow-store.js";
import { type OpcoesRun, type ResultadoRun } from "../src/core/contexts/execution/session-manager.js";
import { TaskStore } from "../src/core/contexts/storage/task-store.js";
import { RegistryStore } from "../src/core/contexts/storage/registry-store.js";

describe("Bateria Completa de Execução de Fluxos — Todas as Formas de Uso", () => {
  let wsDir: string;
  let homeDir: string;
  let store: FlowStore;
  let runsMock: OpcoesRun[];

  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), "opencorp-allforms-ws-"));
    homeDir = mkdtempSync(join(tmpdir(), "opencorp-allforms-home-"));
    runsMock = [];

    const fakeSessoes: SessaoFlow = {
      rodar: async (opts: OpcoesRun): Promise<ResultadoRun> => {
        runsMock.push(opts);
        return {
          id: `run-${runsMock.length}`,
          exit_code: 0,
          captura: `Opção: Aprovado. Resposta para: ${opts.ordem}`,
        };
      },
    };

    store = new FlowStore({
      homeDir,
      sessoes: fakeSessoes,
      agora: () => new Date("2026-09-10T15:00:00.000Z"),
    });
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("Forma 1: Sub-fluxo — executa fluxo aninhado com propagação de contexto e retorno", async () => {
    // 1. Cria o sub-fluxo filho
    const subflow = {
      id: "filho-calculo",
      nome: "Sub-fluxo de Cálculo",
      nos: [
        { id: "inicio", tipo: "manual", config: {} },
        { id: "script_soma", tipo: "script", config: { comando: "echo '42'" } },
      ],
      arestas: [{ de: "inicio", para: "script_soma" }],
    };
    await store.salvar(wsDir, subflow as any);

    // 2. Cria o fluxo pai que invoca o sub-fluxo via flow_id
    const fluxoPai = {
      id: "pai-orquestrador",
      nome: "Fluxo Pai",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        { id: "chama_filho", tipo: "subflow", config: { flow_id: "filho-calculo", entrada: "dados-iniciais" } },
      ],
      arestas: [{ de: "gatilho", para: "chama_filho" }],
    };
    await store.salvar(wsDir, fluxoPai as any);

    const res = await store.executar(wsDir, "pai-orquestrador", { entrada: "iniciar" });
    expect(res.status).toBe("concluido");
    const nosPorId = Object.fromEntries(res.nos.map((n) => [n.id, n.status]));
    expect(nosPorId["chama_filho"]).toBe("ok");
  });

  it("Forma 2: Delay — executa pausa temporizada não-bloqueante no fluxo", async () => {
    const fluxoDelay = {
      id: "fluxo-delay-teste",
      nome: "Fluxo com Delay",
      nos: [
        { id: "start", tipo: "manual", config: {} },
        { id: "pausa", tipo: "delay", config: { segundos: 1 } },
        { id: "fim", tipo: "script", config: { comando: "echo 'delay_passou'" } },
      ],
      arestas: [
        { de: "start", para: "pausa" },
        { de: "pausa", para: "fim" },
      ],
    };
    await store.salvar(wsDir, fluxoDelay as any);

    const inicio = Date.now();
    const res = await store.executar(wsDir, "fluxo-delay-teste");
    const duracao = Date.now() - inicio;

    expect(res.status).toBe("concluido");
    const nosPorId = Object.fromEntries(res.nos.map((n) => [n.id, n.status]));
    expect(nosPorId["start"]).toBe("ok");
    expect(nosPorId["pausa"]).toBe("ok");
    expect(nosPorId["fim"]).toBe("ok");
    expect(duracao).toBeGreaterThanOrEqual(900);
  });

  it("Forma 3: HTTP Request — simula chamada HTTP em nó de integração", async () => {
    const originalFetch = global.fetch;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({ mensagem: "webhook recebido com sucesso", id: 99 }),
    });
    global.fetch = fetchMock;

    try {
      const fluxoHttp = {
        id: "fluxo-http-teste",
        nome: "Fluxo com HTTP Request",
        nos: [
          { id: "trigger", tipo: "manual", config: {} },
          {
            id: "requisicao_api",
            tipo: "http_request",
            config: {
              url: "https://api.empresa.com/webhook",
              metodo: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ evento: "notificacao", valor: "{{entrada}}" }),
            },
          },
        ],
        arestas: [{ de: "trigger", para: "requisicao_api" }],
      };
      await store.salvar(wsDir, fluxoHttp as any);

      const res = await store.executar(wsDir, "fluxo-http-teste", { entrada: "param-123" });
      expect(res.status).toBe("concluido");
      expect(fetchMock).toHaveBeenCalled();
      const nosPorId = Object.fromEntries(res.nos.map((n) => [n.id, n.status]));
      expect(nosPorId["requisicao_api"]).toBe("ok");
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("Forma 4: Criação de Tarefa Kanban (task_create) automática pelo fluxo", async () => {
    const fluxoTask = {
      id: "fluxo-gerar-task",
      nome: "Fluxo Gerador de Task",
      nos: [
        { id: "inicio", tipo: "manual", config: {} },
        {
          id: "criar_card",
          tipo: "task_create",
          config: {
            titulo: "Revisar relatório de faturamento #{{entrada}}",
            descricao: "Tarefa criada automaticamente pela esteira de fluxos.",
            coluna: "backlog",
            prioridade: "alta",
          },
        },
      ],
      arestas: [{ de: "inicio", para: "criar_card" }],
    };
    await store.salvar(wsDir, fluxoTask as any);

    const res = await store.executar(wsDir, "fluxo-gerar-task", { entrada: "1024" });
    expect(res.status).toBe("concluido");

    const taskStore = new TaskStore({ homeDir });
    const tasks = await taskStore.listar(wsDir);
    const criada = tasks.find((t) => t.titulo.includes("Revisar relatório de faturamento #1024"));
    expect(criada).toBeDefined();
    expect(criada?.coluna).toBe("backlog");
    expect(criada?.prioridade).toBe("alta");
  });

  it("Forma 5: Registro / Ata (registro) — persistência de documento corporativo", async () => {
    const fluxoRegistro = {
      id: "fluxo-salvar-registro",
      nome: "Fluxo com Registro",
      nos: [
        { id: "inicio", tipo: "manual", config: {} },
        {
          id: "gravar_doc",
          tipo: "registro",
          config: {
            categoria: "relatorios",
            titulo: "Parecer Técnico Automático",
            conteudo: "Conteúdo do relatório aprovado via fluxo autônomo.",
          },
        },
      ],
      arestas: [{ de: "inicio", para: "gravar_doc" }],
    };
    await store.salvar(wsDir, fluxoRegistro as any);

    const res = await store.executar(wsDir, "fluxo-salvar-registro");
    expect(res.status).toBe("concluido");

    const regStore = new RegistryStore({ homeDir });
    const docs = await regStore.listar(wsDir, "relatorios");
    const docCriado = docs.find((d) => d.descricao?.includes("Parecer Técnico") || d.id.includes("fluxo-salvar-registro"));
    expect(docCriado).toBeDefined();
  });

  it("Forma 6: Decisão Condicional (decisao/branching) — roteamento de caminho com opções", async () => {
    const fluxoDecisao = {
      id: "fluxo-decisao-ramo",
      nome: "Fluxo com Decisão",
      nos: [
        { id: "inicio", tipo: "manual", config: {} },
        {
          id: "decidir",
          tipo: "decisao",
          config: {
            agente: "agente-decisor",
            pergunta: "Aprovar requisição: {{entrada}}?",
            opcoes: [
              { rotulo: "Aprovado", proximo: "acao_aprovado" },
              { rotulo: "Rejeitado", proximo: "acao_rejeitado" },
            ],
          },
        },
        { id: "acao_aprovado", tipo: "script", config: { comando: "echo 'APROVADO'" } },
        { id: "acao_rejeitado", tipo: "script", config: { comando: "echo 'REJEITADO'" } },
      ],
      arestas: [
        { de: "inicio", para: "decidir" },
        { de: "decidir", para: "acao_aprovado" },
        { de: "decidir", para: "acao_rejeitado" },
      ],
    };
    await store.salvar(wsDir, fluxoDecisao as any);

    const res = await store.executar(wsDir, "fluxo-decisao-ramo", { entrada: "solicitacao-1" });
    expect(res.status).toBe("concluido");
    const nosPorId = Object.fromEntries(res.nos.map((n) => [n.id, n.status]));
    expect(nosPorId["decidir"]).toBe("ok");
  });

  it("Forma 7: Script que falha logando só no stdout — o motivo aparece no erro do fluxo", async () => {
    const fluxo = {
      id: "fluxo-script-falha",
      nome: "Script com erro no stdout",
      nos: [
        { id: "start", tipo: "manual", config: {} },
        { id: "quebra", tipo: "script", config: { comando: "echo 'arquivo pautas.json nao encontrado'; exit 3" } },
      ],
      arestas: [{ de: "start", para: "quebra" }],
    };
    await store.salvar(wsDir, fluxo as any);

    await expect(store.executar(wsDir, "fluxo-script-falha")).rejects.toThrow(/últimas linhas do stdout:\narquivo pautas\.json nao encontrado/);
  });

  it("Forma 8: Trava — o mesmo flow não roda duas vezes ao mesmo tempo; trava de processo morto é ignorada", async () => {
    const fluxo = {
      id: "fluxo-longo",
      nome: "Fluxo demorado",
      nos: [
        { id: "start", tipo: "manual", config: {} },
        { id: "pausa", tipo: "delay", config: { segundos: 1 } },
      ],
      arestas: [{ de: "start", para: "pausa" }],
    };
    await store.salvar(wsDir, fluxo as any);

    const primeira = store.executar(wsDir, "fluxo-longo");
    await new Promise((r) => setTimeout(r, 100));
    await expect(store.executar(wsDir, "fluxo-longo")).rejects.toThrow(/já está em execução/);
    expect((await primeira).status).toBe("concluido");
    expect(existsSync(join(wsDir, ".opencorp", "locks", "executando-fluxo-longo.json"))).toBe(false);

    // trava esquecida por um processo que morreu (pid inexistente) não bloqueia
    mkdirSync(join(wsDir, ".opencorp", "locks"), { recursive: true });
    writeFileSync(join(wsDir, ".opencorp", "locks", "executando-fluxo-longo.json"), JSON.stringify({ pid: 2 ** 22 + 12345, inicio: "x" }));
    expect((await store.executar(wsDir, "fluxo-longo")).status).toBe("concluido");
  });
});
