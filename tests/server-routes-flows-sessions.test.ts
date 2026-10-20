import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer, type SessaoApi } from "../src/server/index.js";
import { OpencorpDb } from "../src/core/db/opencorp-db.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-flows-sessions-"));
  raizes.push(dir);
  return dir;
}

function makeFetch(port: number, token: string) {
  const base = `http://127.0.0.1:${port}`;
  return async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...opts.headers,
      },
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
}

describe("Rotas Modulares de Flows e Sessões (Micro-Passo 11)", () => {
  let home: string;
  let token = "test-token-flows-sessions";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let execucoesDisparadas: Array<{ execId: string; ordem: string }> = [];

  const fakeSessoes: SessaoApi = {
    async rodar(opcoes) {
      execucoesDisparadas.push({ execId: opcoes.execId, ordem: opcoes.ordem });
      return {
        id: opcoes.execId,
        agente: opcoes.agente,
        modelo: opcoes.model ?? "model-mock",
        ordem: opcoes.ordem,
        inicio: new Date().toISOString(),
        fim: new Date().toISOString(),
        status: "concluido",
      };
    },
    async listarExecucoes() {
      return [
        {
          id: "exec-teste-1",
          agente: "pesquisador",
          modelo: "gpt-4o",
          ordem: "pesquisar algo",
          inicio: new Date().toISOString(),
          status: "concluido",
        },
      ];
    },
    async logDe(_ws, id) {
      return `[LOG-EXEC ${id}] execução realizada com sucesso`;
    },
    async cancelar(_ws, _id) {
      return true;
    },
  };

  let wsPath: string;

  beforeAll(async () => {
    home = await tmpDir();
    execucoesDisparadas = [];

    const inst = createApiServer({
      homeDir: home,
      cwd: home,
      token,
      sessoes: fakeSessoes,
      instalarMencoes: false,
    });
    server = inst.server;
    server.listen(0, "127.0.0.1");
    port = await inst.porta;
    fetchApi = makeFetch(port, token);

    const wsRes = await fetchApi("/workspaces", {
      method: "POST",
      body: JSON.stringify({ id: "ws-principal" }),
    });
    wsPath = (wsRes.json as { caminho: string }).caminho;

    // Pré-popula registros usando CorpDb (que delega ao OpencorpDb consolidado)
    const { CorpDb } = await import("../src/core/contexts/storage/corp-db.js");
    const corp = new CorpDb(CorpDb.caminho(wsPath));
    corp.upsertSessao({
      id: "sessao-mock-1",
      agente: "secretario",
      modelo: "gpt-4o",
      inicio: new Date().toISOString(),
      fim: null,
      custo_usd: 0.05,
      status: "executando",
    });
    corp.inserirMensagem({
      id: "msg-1",
      sessao_id: "sessao-mock-1",
      agente: "usuario",
      role: "user",
      conteudo: "Olá secretário, teste de rota",
      criado_em: new Date().toISOString(),
    });
    corp.upsertExecucao({
      id: "exec-db-1",
      sessao_id: "sessao-mock-1",
      agente: "pesquisador",
      gatilho_tipo: "manual",
      gatilho_origem: "teste",
      modelo: "gpt-4o",
      status: "concluida",
      inicio: new Date().toISOString(),
      fim: new Date().toISOString(),
      duracao_ms: 1200,
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      custo_estimado_usd: 0.002,
      checkpoint_git: null,
    });
    corp.inserirAcaoAgente({
      id: "acao-1",
      span_id: "span-1",
      sessao_id: "sessao-mock-1",
      trace_id: "trace-abc-123",
      agente: "pesquisador",
      ferramenta: "read_file",
      parametros: JSON.stringify({ file: "README.md" }),
      resultado: "conteudo",
      sucesso: true,
      duracao_ms: 45,
    });
  });

  afterAll(async () => {
    server.close();
    for (const d of raizes) {
      await rm(d, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  describe("Rotas de Fluxos (/flows e /fluxos)", () => {
    it("POST /flows cria um novo fluxo e GET /flows lista", async () => {
      const resPost = await fetchApi("/flows", {
        method: "POST",
        body: JSON.stringify({
          id: "meu-fluxo-1",
          nome: "Fluxo de Teste 1",
        }),
      });
      expect([200, 201]).toContain(resPost.status);

      const resList = await fetchApi("/flows");
      expect(resList.status).toBe(200);
      expect(Array.isArray(resList.json)).toBe(true);
      const lista = resList.json as Array<{ id: string; nome?: string }>;
      expect(lista.some((f) => f.id === "meu-fluxo-1")).toBe(true);
    });

    it("GET /fluxos suporta alias em português", async () => {
      const res = await fetchApi("/fluxos");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const lista = res.json as Array<{ id: string }>;
      expect(lista.some((f) => f.id === "meu-fluxo-1")).toBe(true);
    });

    it("GET /flows/:id obtém detalhes e nós do fluxo", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1");
      expect(res.status).toBe(200);
      const flow = res.json as { id: string; nome: string; nos?: unknown[] };
      expect(flow.id).toBe("meu-fluxo-1");
      expect(flow.nome).toBe("Fluxo de Teste 1");
    });

    it("PUT /flows/:id atualiza o grafo do fluxo", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1", {
        method: "PUT",
        body: JSON.stringify({
          id: "meu-fluxo-1",
          nome: "Fluxo Atualizado",
          nos: [{ id: "inicio", tipo: "manual", config: {} }],
          arestas: [],
        }),
      });
      expect(res.status).toBe(200);
      const flow = res.json as { id: string; nome: string; nos?: Array<{ id: string }> };
      expect(flow.nome).toBe("Fluxo Atualizado");
      expect(flow.nos?.length).toBe(1);
    });

    it("PUT /flows/:id aceita atualização parcial sem campo nos preservando os nós existentes", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1", {
        method: "PUT",
        body: JSON.stringify({
          id: "meu-fluxo-1",
          ativo: false,
        }),
      });
      expect(res.status).toBe(200);
      const flow = res.json as { id: string; ativo: boolean; nos?: Array<{ id: string }> };
      expect(flow.ativo).toBe(false);
      expect(flow.nos?.length).toBe(1);
    });

    it("PUT /flows/:id tolera nos/arestas como número (resumo da lista) sem disparar 'expected array, received number'", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1", {
        method: "PUT",
        body: JSON.stringify({
          id: "meu-fluxo-1",
          nos: 1, // formato resumo enviado por engano pela lista
          arestas: 0,
          ativo: true,
        }),
      });
      expect(res.status).toBe(200);
      const flow = res.json as { id: string; ativo: boolean; nos?: Array<{ id: string }> };
      expect(flow.ativo).toBe(true);
      expect(Array.isArray(flow.nos)).toBe(true);
      expect(flow.nos?.length).toBe(1);
    });

    it("GET /flows/:id/runs retorna 200 com a lista de execuções", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1/runs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
    });

    it("GET /flows/:id/export exporta o fluxo em formato JSON", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1/export");
      expect(res.status).toBe(200);
      const data = res.json as { id?: string; flow?: { id: string; nome: string } };
      const flowExportado = data.flow ?? (data as { id: string; nome: string });
      expect(flowExportado.id).toBe("meu-fluxo-1");
      expect(flowExportado.nome).toBe("Fluxo Atualizado");
    });

    it("POST /flows/:id/run e /fluxos/:id/run dispara a execução do fluxo retornando 202", async () => {
      const res = await fetchApi("/flows/meu-fluxo-1/run", {
        method: "POST",
        body: JSON.stringify({ entrada: "dado de teste" }),
      });
      expect(res.status).toBe(202);
      const j = res.json as { status: string; flow: string; exec_id: string };
      expect(j.status).toBe("iniciado");
      expect(j.flow).toBe("meu-fluxo-1");
      expect(typeof j.exec_id).toBe("string");

      // Alias em português (outro flow: o mesmo flow ainda pode estar rodando e a trava recusa o 2º disparo)
      const resPt = await fetchApi("/fluxos/outro-fluxo/run", {
        method: "POST",
        body: JSON.stringify({ entrada: "teste alias" }),
      });
      expect(resPt.status).toBe(202);
    });

    it("POST /flows/:id/run responde 409 (sem exec_id) quando o flow já está em execução", async () => {
      const dirTravas = join(wsPath, ".opencorp", "locks");
      await mkdir(dirTravas, { recursive: true });
      await writeFile(join(dirTravas, "executando-flow-ocupado.json"), JSON.stringify({ pid: process.pid, inicio: "agora" }));
      const res = await fetchApi("/flows/flow-ocupado/run", { method: "POST", body: JSON.stringify({}) });
      expect(res.status).toBe(409);
      expect((res.json as { exec_id?: string }).exec_id).toBeUndefined();
      expect((res.json as { erro: string }).erro).toContain("já está em execução");
    });

    it("POST /flows/:id/webhook responde 202 'ignorado' (sem exec_id falso) quando o flow já está em execução", async () => {
      const dirTravas = join(wsPath, ".opencorp", "locks");
      await mkdir(dirTravas, { recursive: true });
      await writeFile(join(dirTravas, "executando-flow-webhook-ocupado.json"), JSON.stringify({ pid: process.pid, inicio: "agora" }));
      const res = await fetchApi("/flows/flow-webhook-ocupado/webhook", { method: "POST", body: JSON.stringify({ x: 1 }) });
      expect(res.status).toBe(202);
      expect(res.json).toMatchObject({ ok: true, status: "ignorado_em_execucao", exec_id: null });
    });

    it("GET /audit/flows retorna histórico de auditoria de fluxos", async () => {
      const res = await fetchApi("/audit/flows");
      expect(res.status).toBe(200);
      const j = res.json as { total: number; eventos: unknown[] };
      expect(typeof j.total).toBe("number");
      expect(Array.isArray(j.eventos)).toBe(true);
    });

    it("DELETE /flows/:id remove o fluxo", async () => {
      const resDel = await fetchApi("/flows/meu-fluxo-1", { method: "DELETE" });
      expect(resDel.status).toBe(200);

      const resGet = await fetchApi("/flows/meu-fluxo-1");
      expect(resGet.status).toBe(404);
    });
  });

  describe("Rotas de Sessões e Execuções (/sessions, /sessoes, /execucoes)", () => {

    it("GET /sessions e GET /sessoes listam sessões/execuções", async () => {
      const resEn = await fetchApi("/sessions");
      expect(resEn.status).toBe(200);
      expect(Array.isArray(resEn.json)).toBe(true);

      const resPt = await fetchApi("/sessoes");
      expect(resPt.status).toBe(200);
      expect(Array.isArray(resPt.json)).toBe(true);
    });

    it("GET /sessions/:id/log retorna o log da execução", async () => {
      const res = await fetchApi("/sessions/exec-teste-1/log");
      expect(res.status).toBe(200);
      const j = res.json as { id: string; log: string };
      expect(j.id).toBe("exec-teste-1");
      expect(j.log).toContain("[LOG-EXEC exec-teste-1]");
    });

    it("GET /execucoes lista execuções do ledger unificado", async () => {
      const res = await fetchApi("/execucoes");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const lista = res.json as Array<{ id: string; agente: string }>;
      expect(lista.some((e) => e.id === "exec-db-1")).toBe(true);
    });

    it("GET /telemetria/resumo retorna métricas agregadas", async () => {
      const res = await fetchApi("/telemetria/resumo");
      expect(res.status).toBe(200);
      const j = res.json as { total_acoes?: number };
      expect(j).toBeDefined();
    });

    it("GET /telemetria/trace/:trace_id retorna spans do trace", async () => {
      const res = await fetchApi("/telemetria/trace/trace-abc-123");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const acoes = res.json as Array<{ trace_id: string; ferramenta: string }>;
      expect(acoes.length).toBeGreaterThan(0);
      expect(acoes[0].trace_id).toBe("trace-abc-123");
      expect(acoes[0].ferramenta).toBe("read_file");
    });

    it("GET /acoes lista ações de agentes", async () => {
      const res = await fetchApi("/acoes");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const acoes = res.json as Array<{ ferramenta: string }>;
      expect(acoes.some((a) => a.ferramenta === "read_file")).toBe(true);
    });

    it("GET /acoes/:sessao_id lista ações de uma sessão específica", async () => {
      const res = await fetchApi("/acoes/sessao-mock-1");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
    });

    it("GET /sessoes/:id/mensagens retorna histórico de mensagens da sessão", async () => {
      const res = await fetchApi("/sessoes/sessao-mock-1/mensagens");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const msgs = res.json as Array<{ id: string; conteudo: string }>;
      expect(msgs.some((m) => m.conteudo.includes("Olá secretário"))).toBe(true);
    });

    it("POST /execucoes/:id/cancelar encerra execução com sucesso", async () => {
      const res = await fetchApi("/execucoes/exec-db-1/cancelar", { method: "POST" });
      expect(res.status).toBe(200);
      const j = res.json as { ok: boolean; status: string; cancelado: boolean };
      expect(j.ok).toBe(true);
      expect(j.status).toBe("cancelado");
      expect(j.cancelado).toBe(true);
    });
  });
});
