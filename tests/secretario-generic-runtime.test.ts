import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer, type ApiServerOptions } from "../src/server/index.js";
import {
  engineRegistry,
  type EngineAdapter,
  type ConversationRef,
  type AgentEvent,
} from "../src/core/engines/index.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-secretario-generic-"));
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
    return { status: res.status, json, text, res };
  };
}

describe("ETAPA 7 — Secretário com Runtime Genérico e Multimotor", () => {
  let home: string;
  let token = "test-token-sec-generic";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];

  // Motor Mock Conversacional Genérico (ex: "mock-engine")
  const mockSessions = new Map<string, string[]>();
  const mockAdapter: EngineAdapter = {
    engineId: "mock-engine",
    name: "Mock Engine Genérico",
    manifest: {
      engineId: "mock-engine",
      name: "Mock Engine Genérico",
      transport: "embedded",
      supportsConversation: true,
      features: {
        streaming: { level: "integrated" },
        continuation: { level: "integrated" },
        fork: { level: "unsupported" },
        hitl: { level: "unsupported" },
        tools: { level: "integrated" },
        mcp: { level: "unsupported" },
        images: { level: "unsupported" },
        cancellation: { level: "integrated" },
      },
    },
    installer: {
      engineId: "mock-engine",
      status: async () => ({ installed: true, isManaged: false, path: "/usr/bin/mock", version: "1.0.0" }),
      install: async () => ({ success: true, path: "/usr/bin/mock", version: "1.0.0", log: "" }),
    },
    authenticator: {
      engineId: "mock-engine",
      status: async () => ({ authenticated: true, authType: "api_key" }),
    },
    runner: {
      engineId: "mock-engine",
      run: async function* () {
        yield { type: "run.started", runId: "r1", timestamp: new Date().toISOString(), engineId: "mock-engine" };
        yield { type: "message.delta", runId: "r1", text: "Executado" };
        yield { type: "run.completed", runId: "r1", result: { output: "Executado", stopReason: "completed" } };
      },
    },
    conversationRuntime: {
      engineId: "mock-engine",
      create: async (input) => {
        const id = input.conversationId || `mock-sess-${Date.now()}`;
        mockSessions.set(id, []);
        return {
          id,
          engineId: "mock-engine",
          workspaceId: input.workspaceId,
        };
      },
      send: async function* (ref: ConversationRef, input, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const history = mockSessions.get(ref.id) ?? [];
        history.push(input.text);
        mockSessions.set(ref.id, history);

        const runId = `run-${Date.now()}`;
        yield {
          type: "run.started",
          runId,
          timestamp: new Date().toISOString(),
          engineId: "mock-engine",
        };

        if (signal?.aborted) {
          yield {
            type: "run.completed",
            runId,
            result: { output: "", stopReason: "cancelled" },
          };
          return;
        }

        yield {
          type: "message.delta",
          runId,
          text: `Resposta do motor mock para: ${input.text}`,
        };

        yield {
          type: "tool.requested",
          runId,
          call: {
            id: "call-1",
            name: "ler_arquivo",
            arguments: { caminho: "README.md" },
          },
        };

        yield {
          type: "tool.completed",
          runId,
          result: {
            id: "call-1",
            name: "ler_arquivo",
            result: { sucesso: true },
          },
        };

        yield {
          type: "run.completed",
          runId,
          result: {
            output: `Resposta do motor mock para: ${input.text}`,
            stopReason: "completed",
          },
        };
      },
      resume: async (ref: ConversationRef) => ({
        ref,
        status: "idle",
        lastActiveAt: new Date().toISOString(),
      }),
      close: async (ref: ConversationRef) => {
        mockSessions.delete(ref.id);
      },
    },
  };

  beforeAll(async () => {
    engineRegistry.registerAdapter(mockAdapter);

    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await mkdir(join(home, "workspaces", "ws-mock", ".opencorp"), { recursive: true });
    await writeFile(
      join(home, "workspaces", "ws-mock", ".opencorp", "config.json"),
      JSON.stringify({
        conversationEngineOverride: "mock-engine",
      })
    );
    await writeFile(
      join(home, ".opencorp", "workspaces.json"),
      JSON.stringify({
        version: 1,
        ativo: "ws-mock",
        workspaces: [
          {
            id: "ws-mock",
            criado_em: new Date().toISOString(),
            path: join(home, "workspaces", "ws-mock"),
          },
          {
            id: "ws-outro",
            criado_em: new Date().toISOString(),
            path: join(home, "workspaces", "ws-outro"),
          },
          {
            id: "ws-incompativel",
            criado_em: new Date().toISOString(),
            path: join(home, "workspaces", "ws-incompativel"),
          },
        ],
      })
    );

    const { server: srv, token: tk, porta } = createApiServer({
      homeDir: home,
      token,
      instalarMencoes: false,
    } as ApiServerOptions);

    server = srv;
    token = tk;
    server.listen(0, "127.0.0.1");
    port = await porta;
    fetchApi = makeFetch(port, token);
  });

  afterAll(async () => {
    server?.close();
    for (const r of raizes) {
      await rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("GET /secretario/status: relata motor resolvido mock-engine com preflight ok", async () => {
    const { status, json } = await fetchApi("/secretario/status?workspace=ws-mock");
    expect(status).toBe(200);
    const body = json as any;
    expect(body.motor).toBeDefined();
    expect(body.motor.engineId).toBe("mock-engine");
    expect(body.motor.nome).toBe("Mock Engine Genérico");
    expect(body.motor.origem).toBe("workspace_override");
    expect(body.motor.suportaConversa).toBe(true);
    expect(body.configurado).toBe(true);
  });

  it("POST /secretario/start e /secretario/stop: opera de forma agnóstica sem falhar", async () => {
    const startRes = await fetchApi("/secretario/start?workspace=ws-mock", { method: "POST" });
    expect(startRes.status).toBe(200);
    const startBody = startRes.json as any;
    expect(startBody.motor).toBe("mock-engine");

    const stopRes = await fetchApi("/secretario/stop?workspace=ws-mock", { method: "POST" });
    expect(stopRes.status).toBe(200);
  });

  it("POST /secretario/conversa: executa mensagem via ConversationRuntime do motor configurado", async () => {
    const { status, json } = await fetchApi("/secretario/conversa?workspace=ws-mock", {
      method: "POST",
      body: JSON.stringify({
        mensagem: "Qual é o status das tarefas?",
      }),
    });

    expect(status).toBe(200);
    const body = json as any;
    expect(body.ok).toBe(true);
    expect(body.motor).toBe("mock-engine");
    expect(body.sessao_id).toBeDefined();
    expect(body.resposta).toContain("Resposta do motor mock para:");
    expect(body.resposta).toContain("Qual é o status das tarefas?");
  });

  it("POST /secretario/conversa/stream: transmite eventos SSE estruturados a partir do ConversationRuntime", async () => {
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/secretario/conversa/stream?workspace=ws-mock`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        mensagem: "Gere o resumo executivo",
      }),
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("content-type") || "";
    expect(contentType).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: inicio");
    expect(text).toContain('"motor":"mock-engine"');
    expect(text).toContain("event: delta");
    expect(text).toContain("event: acao");
    expect(text).toContain("event: fim");
  });

  it("Rejeição estrita: workspace configurado com motor sem suporte conversacional emite diagnóstico 409", async () => {
    // Configura workspace com motor sem suporte conversacional (ex: aider)
    await mkdir(join(home, "workspaces", "ws-incompativel", ".opencorp"), { recursive: true });
    await writeFile(
      join(home, "workspaces", "ws-incompativel", ".opencorp", "config.json"),
      JSON.stringify({
        conversationEngineOverride: "claude-code",
      })
    );

    const { status, json } = await fetchApi("/secretario/conversa?workspace=ws-incompativel", {
      method: "POST",
      body: JSON.stringify({
        mensagem: "Olá",
      }),
    });

    expect(status).toBe(409);
    const body = json as any;
    expect(body.erro).toContain("não oferece runtime conversacional");
  });

  it("Isolamento entre workspaces: ws-mock e ws-outro mantêm sessões e configurações dedicadas", async () => {
    await mkdir(join(home, "workspaces", "ws-outro", ".opencorp"), { recursive: true });
    await writeFile(
      join(home, "workspaces", "ws-outro", ".opencorp", "config.json"),
      JSON.stringify({
        conversationEngineOverride: "mock-engine",
      })
    );

    const res1 = await fetchApi("/secretario/conversa?workspace=ws-mock", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Msg 1 para ws-mock", sessao_id: "sess-ws-mock" }),
    });

    const res2 = await fetchApi("/secretario/conversa?workspace=ws-outro", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Msg 2 para ws-outro", sessao_id: "sess-ws-outro" }),
    });

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect((res1.json as any).sessao_id).toBe("sess-ws-mock");
    expect((res2.json as any).sessao_id).toBe("sess-ws-outro");
  });
});
