import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApiServer } from "../src/server/index.js";
import {
  CodexAdapter,
  ConversationRuntimeResolver,
  EngineRegistry,
  type CodexAppServerHandle,
} from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";

const raizes: string[] = [];

class JsonLineQueue {
  private values: string[] = [];
  private waiters: Array<(value: string) => void> = [];
  push(value: unknown) {
    const line = `${JSON.stringify(value)}\n`;
    const waiter = this.waiters.shift();
    if (waiter) waiter(line);
    else this.values.push(line);
  }
  async *iterate() {
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else yield await new Promise<string>((resolve) => this.waiters.push(resolve));
    }
  }
}

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-secretario-codex-"));
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

describe("ETAPA 8 — Prova de Independência do Secretário com Codex Runtime", () => {
  let home: string;
  let token = "test-token-sec-codex";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let processRegistry: ProcessRegistry;
  const decisoesRecebidas: string[] = [];

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });

    // Workspace 1: Configurado para utilizar Codex
    const wsCodexDir = join(home, "workspaces", "ws-codex");
    await mkdir(join(wsCodexDir, ".opencorp"), { recursive: true });
    await writeFile(
      join(wsCodexDir, ".opencorp", "config.json"),
      JSON.stringify({
        conversationEngineOverride: "codex",
        default_conversation_engine: "codex",
      })
    );

    // Workspace 2: Configurado para utilizar OpenCode
    const wsOpencodeDir = join(home, "workspaces", "ws-opencode");
    await mkdir(join(wsOpencodeDir, ".opencorp"), { recursive: true });
    await writeFile(
      join(wsOpencodeDir, ".opencorp", "config.json"),
      JSON.stringify({
        conversationEngineOverride: "opencode",
        default_conversation_engine: "opencode",
      })
    );

    // Registra workspaces
    await writeFile(
      join(home, ".opencorp", "workspaces.json"),
      JSON.stringify({
        version: 1,
        ativo: "ws-codex",
        workspaces: [
          { id: "ws-codex", path: wsCodexDir, criado_em: new Date().toISOString() },
          { id: "ws-opencode", path: wsOpencodeDir, criado_em: new Date().toISOString() },
        ],
      })
    );

    // Settings global com fallback explícito
    await writeFile(
      join(home, ".opencorp", "settings.json"),
      JSON.stringify({
        default_conversation_engine: "codex",
      })
    );

    const mortos = new Set<number>();
    processRegistry = new ProcessRegistry({
      idleTimeoutMs: 60_000,
      killer: (pid) => { mortos.add(pid); },
      isPidRunning: (pid) => !mortos.has(pid),
    });
    let nextThread = 0;
    let nextTurn = 0;
    const turnsByThread = new Map<string, number>();
    let turnoAguardandoAprovacao: { threadId: string; turnId: string } | undefined;

    // Registra adaptador customizado com app-server fake determinístico.
    const customCodexAdapter = new CodexAdapter({
      homeDir: home,
      processRegistry,
      installStatusProbe: async () => ({ installed: true, isManaged: false, path: "/fake/codex", version: "test" }),
      authStatusProbe: async () => ({ authenticated: true, method: "test" }),
      appServerLauncher: async (): Promise<CodexAppServerHandle> => {
        const queue = new JsonLineQueue();
        return {
          pid: 8888,
          stdout: queue.iterate(),
          exitCode: new Promise(() => {}),
          kill: () => {},
          write(line) {
            const message = JSON.parse(line);
            if (message.method === "initialize") {
              queue.push({ id: message.id, result: { userAgent: "fake", codexHome: home, platformFamily: "unix", platformOs: "linux" } });
            } else if (message.method === "thread/start") {
              nextThread += 1;
              queue.push({ id: message.id, result: { thread: { id: randomUUID() } } });
            } else if (message.method === "thread/resume") {
              queue.push({ id: message.id, result: { thread: { id: message.params.threadId } } });
            } else if (message.method === "turn/start") {
              const threadId = message.params.threadId;
              const count = (turnsByThread.get(threadId) || 0) + 1;
              turnsByThread.set(threadId, count);
              const turnId = `turn-secretario-${++nextTurn}`;
              if (String(message.params.input[0].text).includes("precisa de aprovação")) {
                turnoAguardandoAprovacao = { threadId, turnId };
                queue.push({ id: message.id, result: { turn: { id: turnId } } });
                queue.push({
                  method: "item/commandExecution/requestApproval",
                  id: 0,
                  params: { threadId, turnId, itemId: "cmd", command: "git push origin main", kind: "command" },
                });
                return;
              }
              const text = count > 1
                ? "Codex continuando o diálogo anterior..."
                : "Codex: resposta gerada com raciocínio profundo.";
              queue.push({ id: message.id, result: { turn: { id: turnId } } });
              queue.push({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg", delta: text } });
              queue.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
            } else if (message.id === 0 && !message.method && turnoAguardandoAprovacao) {
              decisoesRecebidas.push(message.result?.decision);
              const { threadId, turnId } = turnoAguardandoAprovacao;
              turnoAguardandoAprovacao = undefined;
              queue.push({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg", delta: `decisão:${message.result?.decision}` } });
              queue.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
            }
          },
        };
      },
    });

    const registry = new EngineRegistry();
    registry.registerAdapter(customCodexAdapter);

    const runtimeResolver = new ConversationRuntimeResolver({
      homeDir: home,
      registry,
    });

    const app = createApiServer({
      homeDir: home,
      porta: 0,
      token,
      conversationRuntimeResolver: runtimeResolver,
    });

    server = app.server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        port = addr.port;
        fetchApi = makeFetch(port, token);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await processRegistry.shutdownAll();
    for (const r of raizes) {
      await rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("1. GET /secretario/status: relata Codex como motor ativo do workspace ws-codex", async () => {
    const res = await fetchApi("/secretario/status?workspace=ws-codex");
    expect(res.status).toBe(200);

    const body = res.json as any;
    expect(body.motor).toBeDefined();
    expect(body.motor.engineId).toBe("codex");
    expect(body.motor.suportaConversa).toBe(true);
    expect(body.motor.preflight.supportsConversation).toBe(true);
  });

  it("2. POST /secretario/conversa: atende requisição usando o runtime conversacional do Codex", async () => {
    const res = await fetchApi("/secretario/conversa?workspace=ws-codex", {
      method: "POST",
      body: JSON.stringify({
        mensagem: "Olá Secretário, execute uma análise de código",
        modelo: "gpt-5.6-sol",
      }),
    });

    expect(res.status).toBe(200);
    const body = res.json as any;
    expect(body.ok).toBe(true);
    expect(body.sessao_id).toBeDefined();
    expect(body.motor).toBe("codex");
    expect(body.resposta).toContain("Codex: resposta gerada com raciocínio profundo.");
  });

  it("3. POST /secretario/conversa/stream: transmite eventos SSE estruturados gerados pelo Codex", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/secretario/conversa/stream?workspace=ws-codex`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        mensagem: "Streaming com Codex",
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: inicio");
    expect(text).toContain("event: delta");
    expect(text).toContain("event: fim");
    expect(text).toContain('"motor":"codex"');
  });

  it("4. Multi-turn conversacional: mantém sessão e continua diálogo no Codex", async () => {
    // Turno 1
    const res1 = await fetchApi("/secretario/conversa?workspace=ws-codex", {
      method: "POST",
      body: JSON.stringify({
        mensagem: "Primeira instrução",
      }),
    });
    expect(res1.status).toBe(200);
    const sId = (res1.json as any).sessao_id;

    // Turno 2 com o mesmo sessao_id
    const res2 = await fetchApi("/secretario/conversa?workspace=ws-codex", {
      method: "POST",
      body: JSON.stringify({
        sessao_id: sId,
        mensagem: "Segunda instrução subsequente",
      }),
    });
    expect(res2.status).toBe(200);
    const body2 = res2.json as any;
    expect(body2.sessao_id).toBe(sId);
    expect(body2.motor).toBe("codex");
    expect(body2.resposta).toContain("Codex continuando o diálogo anterior...");
  });

  it("5. Isolamento estrito entre workspaces: ws-codex (Codex) e ws-opencode (OpenCode) operam isoladamente", async () => {
    const stCodex = await fetchApi("/secretario/status?workspace=ws-codex");
    expect((stCodex.json as any).motor.engineId).toBe("codex");

    const stOpencode = await fetchApi("/secretario/status?workspace=ws-opencode");
    expect((stOpencode.json as any).motor.engineId).toBe("opencode");
  });

  it("6. Stream sem sessao_id abre thread nativa em vez de inventar um ID", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/secretario/conversa/stream?workspace=ws-codex`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ mensagem: "nova conversa" }),
    });
    const text = await res.text();
    const inicio = /event: inicio\ndata: (.*)\n/.exec(text);
    expect(inicio).not.toBeNull();
    expect(JSON.parse(inicio![1]!).sessao_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("7. HITL: aprovação do Codex chega por SSE e só é respondida pelo workspace dono", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/secretario/conversa/stream?workspace=ws-codex`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ mensagem: "isso precisa de aprovação" }),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let recebido = "";
    let aprovacao: any;
    while (!aprovacao) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream terminou sem aprovação: ${recebido}`);
      recebido += decoder.decode(value, { stream: true });
      const m = /event: aprovacao\ndata: (.*)\n/.exec(recebido);
      if (m) aprovacao = JSON.parse(m[1]!);
    }
    expect(aprovacao).toMatchObject({ descricao: "git push origin main", workspace: "ws-codex", motor: "codex" });
    expect(aprovacao.id).not.toBe("0");

    // Outro workspace não alcança a aprovação do runtime do ws-codex.
    const intruso = await fetchApi(`/secretario/hitl/${aprovacao.id}/aprovar?workspace=ws-opencode`, { method: "POST", body: "{}" });
    expect((intruso.json as any)?.runtime).not.toBe(true);
    expect(decisoesRecebidas).toEqual([]);

    const resposta = await fetchApi(`/secretario/hitl/${aprovacao.id}/aprovar?workspace=ws-codex`, { method: "POST", body: "{}" });
    expect(resposta.status, JSON.stringify(resposta.json)).toBe(200);
    expect(resposta.json).toMatchObject({ id: aprovacao.id, status: "aprovado", runtime: true });

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      recebido += decoder.decode(value, { stream: true });
    }
    expect(decisoesRecebidas).toEqual(["accept"]);
    expect(recebido).toContain("decisão:accept");
    expect(recebido).toContain("event: fim");
  });

  it("8. Modo síncrono recusa aprovações em vez de bloquear o turno", async () => {
    const res = await fetchApi("/secretario/conversa?workspace=ws-codex", {
      method: "POST",
      body: JSON.stringify({ mensagem: "isso precisa de aprovação" }),
    });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ resposta: "decisão:decline", aprovacoes_recusadas: ["git push origin main"] });
  });
});
