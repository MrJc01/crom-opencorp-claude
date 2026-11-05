import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpAdapter,
  AcpAgentClient,
  COPILOT_ACP,
  JsonRpcConnection,
  JsonRpcError,
  MIMO_ACP,
  engineRegistry,
  permissionOutcome,
  type AgentEvent,
  type JsonRpcTransport,
} from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";
import { createFakeAcpAgent, type FakeAcpOptions, type FakeAcpProcess } from "./fixtures/fake-acp-agent.js";

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** Transporte manual para testar a conexão JSON-RPC isoladamente. */
function manualTransport() {
  const lines: string[] = [];
  const written: any[] = [];
  let push!: (s: string | undefined) => void;
  const queue: Array<string | undefined> = [];
  const waiters: Array<(v: string | undefined) => void> = [];
  push = (s) => { const w = waiters.shift(); if (w) w(s); else queue.push(s); };
  let exit!: (c: number) => void;
  const exitCode = new Promise<number>((r) => { exit = r; });
  const transport: JsonRpcTransport = {
    stdout: (async function* () {
      while (true) {
        const next = queue.length ? queue.shift() : await new Promise<string | undefined>((r) => waiters.push(r));
        if (next === undefined) return;
        yield next;
      }
    })(),
    write: (d) => { for (const l of d.split("\n").filter(Boolean)) written.push(JSON.parse(l)); return true; },
    exitCode,
    kill: () => { push(undefined); exit(0); },
  };
  return { transport, written, send: (s: string) => push(s), end: (code = 0) => { push(undefined); exit(code); }, lines };
}

describe("ETAPA 12 — JsonRpcConnection", () => {
  it("correlaciona respostas fora de ordem e aceita frames partidos e múltiplos", async () => {
    const t = manualTransport();
    const conn = new JsonRpcConnection(t.transport);
    const a = conn.request("a");
    const b = conn.request("b");
    await new Promise((r) => setTimeout(r, 5));
    const [idA, idB] = t.written.map((m) => m.id);
    // Duas respostas no mesmo chunk, em ordem inversa, com a segunda partida em dois.
    const both = `${JSON.stringify({ jsonrpc: "2.0", id: idB, result: "B" })}\n${JSON.stringify({ jsonrpc: "2.0", id: idA, result: "A" })}\n`;
    t.send(both.slice(0, 40));
    t.send(both.slice(40));
    expect(await a).toBe("A");
    expect(await b).toBe("B");
    t.end();
  });

  it("erro JSON-RPC rejeita com código e mensagem; linha inválida é ignorada", async () => {
    const t = manualTransport();
    const conn = new JsonRpcConnection(t.transport);
    const p = conn.request("x");
    await new Promise((r) => setTimeout(r, 5));
    t.send("isto não é json\n");
    t.send(`${JSON.stringify({ jsonrpc: "2.0", id: t.written[0].id, error: { code: -32601, message: "nope" } })}\n`);
    await expect(p).rejects.toMatchObject({ code: -32601, message: "nope" });
    expect(conn.isClosed).toBe(false);
    t.end();
  });

  it("tempo limite por operação e encerramento do processo rejeitam pendentes", async () => {
    const t = manualTransport();
    const conn = new JsonRpcConnection(t.transport, { requestTimeoutMs: 20 });
    await expect(conn.request("demora")).rejects.toThrow(/Tempo limite de 20 ms/);
    const semTimeout = conn.request("eterna", undefined, 0);
    t.end(3);
    await expect(semTimeout).rejects.toThrow(/encerrou \(código 3\)/);
    await expect(conn.request("depois")).rejects.toThrow();
  });

  it("frame acima do limite encerra a conexão", async () => {
    const t = manualTransport();
    const conn = new JsonRpcConnection(t.transport, { maxFrameBytes: 100 });
    const p = conn.request("x", undefined, 0);
    t.send("a".repeat(500));
    await expect(p).rejects.toThrow(/excede 100 bytes/);
    expect(conn.isClosed).toBe(true);
  });

  it("requisição do agente sem handler recebe method not found", async () => {
    const t = manualTransport();
    new JsonRpcConnection(t.transport);
    t.send(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "fs/read_text_file", params: {} })}\n`);
    await new Promise((r) => setTimeout(r, 10));
    expect(t.written.at(-1)).toMatchObject({ id: 7, error: { code: -32601 } });
    t.end();
  });
});

describe("ETAPA 12 — AcpAgentClient", () => {
  const client = (opts: FakeAcpOptions = {}, extra: { approvalTimeoutMs?: number } = {}) => {
    const proc = createFakeAcpAgent([], opts);
    return { proc, c: new AcpAgentClient({ engineId: opts.profile ?? "mimo", transport: proc, clientVersion: "9.9.9", ...extra }) };
  };

  it("initialize negocia v1, anuncia cliente sem fs/terminal e lê capacidades", async () => {
    const { proc, c } = client({ profile: "copilot" });
    await c.initialize();
    expect(proc.received[0]).toMatchObject({
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "opencorp", version: "9.9.9" } },
    });
    expect(c.supports("load")).toBe(true);
    expect(c.supports("close")).toBe(true);
    expect(c.supports("fork")).toBe(false);
    expect(c.supports("resume")).toBe(false);
    c.close();
  });

  it("versão de protocolo diferente é recusada", async () => {
    const { c } = client({ protocolVersion: 2 });
    await expect(c.initialize()).rejects.toMatchObject({ code: "ENGINE_CAPABILITY_UNAVAILABLE" });
    expect(c.isClosed).toBe(true);
  });

  it("autenticação exigida vira ENGINE_AUTH_REQUIRED", async () => {
    const { c } = client({ profile: "copilot", requireAuth: true });
    await c.initialize();
    await expect(c.newSession("/tmp")).rejects.toMatchObject({ code: "ENGINE_AUTH_REQUIRED", details: { authMethods: ["copilot-login"] } });
    c.close();
  });

  it("streaming com frames partidos: deltas, ferramenta, uso; pensamento não vaza", async () => {
    const { c } = client({ chunkSize: 7 });
    await c.initialize();
    const s = await c.newSession("/tmp");
    const events = await collect(c.runTurn(s.sessionId, "oi"));
    expect(events.filter((e) => e.type === "message.delta").map((e: any) => e.text)).toEqual(["Olá, ", "resposta para: ", "oi"]);
    expect(events.find((e) => e.type === "tool.requested")).toMatchObject({ call: { id: "call_1", name: "read", arguments: { path: "a.txt" } } });
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ result: { id: "call_1", result: "conteúdo", isError: false } });
    expect(events.find((e) => e.type === "usage.updated")).toMatchObject({ usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 } });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { output: "Olá, resposta para: oi", stopReason: "completed" } });
    expect(JSON.stringify(events)).not.toContain("pensando");
    c.close();
  });

  it("múltiplos frames por chunk e notificação sem requisição não quebram a conexão", async () => {
    const { c } = client({ coalesce: true, unsolicitedNotification: true });
    await c.initialize();
    const s = await c.newSession("/tmp");
    const events = await collect(c.runTurn(s.sessionId, "oi"));
    expect(JSON.stringify(events)).not.toContain("RUÍDO");
    expect(events.at(-1)?.type).toBe("run.completed");
    c.close();
  });

  it("respostas fora de ordem do agente são correlacionadas", async () => {
    const { c } = client({ reverseResponses: true });
    await c.initialize();
    const [s1, s2] = await Promise.all([c.newSession("/a"), c.newSession("/b")]);
    expect(s1.sessionId).not.toBe(s2.sessionId);
    c.close();
  });

  it("erro JSON-RPC no prompt vira run.failed normalizado", async () => {
    const { c } = client();
    await c.initialize();
    const s = await c.newSession("/tmp");
    const events = await collect(c.runTurn(s.sessionId, "provoque erro"));
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
    expect((events.at(-1) as any).error.message).toContain("Model not found");
    c.close();
  });

  it("turno vazio com erro só no stderr (comportamento real do MiMo) vira falha de autenticação", async () => {
    const { c } = client();
    await c.initialize();
    const s = await c.newSession("/tmp");
    const events = await collect(c.runTurn(s.sessionId, "sem crédito"));
    expect(events.at(-1)).toMatchObject({ type: "run.failed", error: { code: "ENGINE_AUTH_REQUIRED", details: { agentError: expect.stringContaining("free API service has ended") } } });
    // Turno normal seguinte não herda o erro antigo do stderr.
    expect((await collect(c.runTurn(s.sessionId, "oi"))).at(-1)?.type).toBe("run.completed");
    c.close();
  });

  it("processo encerra no meio do turno: run.failed e conexão fechada", async () => {
    const { c } = client();
    await c.initialize();
    const s = await c.newSession("/tmp");
    const events = await collect(c.runTurn(s.sessionId, "vou morrer"));
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(c.isClosed).toBe(true);
  });

  it("cancelamento concorrente: dois aborts e cancel durante permissão respondem 'cancelled'", async () => {
    const { proc, c } = client();
    await c.initialize();
    const s = await c.newSession("/tmp");
    const ac = new AbortController();
    const turn = collect(c.runTurn(s.sessionId, "processo lento", ac.signal));
    setTimeout(() => { ac.abort(); ac.abort(); c.cancelSession(s.sessionId); }, 10);
    expect((await turn).at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "cancelled" } });

    const ac2 = new AbortController();
    const events: AgentEvent[] = [];
    for await (const e of c.runTurn(s.sessionId, "precisa de permissão", ac2.signal)) {
      events.push(e);
      if (e.type === "approval.requested") ac2.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "cancelled" } });
    expect(proc.permissionOutcomes.at(-1)).toEqual({ outcome: "cancelled" });
    expect(proc.received.filter((m) => m.method === "session/cancel").length).toBeGreaterThanOrEqual(1);
    c.close();
  });

  it("HITL aceito, rejeitado e expirado", async () => {
    const { proc, c } = client({}, { approvalTimeoutMs: 30 });
    await c.initialize();
    const s = await c.newSession("/tmp");
    const run = async (decision?: "approve" | "reject") => {
      const events: AgentEvent[] = [];
      for await (const e of c.runTurn(s.sessionId, "precisa de permissão")) {
        events.push(e);
        if (e.type === "approval.requested" && decision) expect(c.respondApproval(e.approval.id, decision)).toBe(true);
      }
      return events;
    };
    const aceito = await run("approve");
    expect(aceito.find((e) => e.type === "approval.requested")).toMatchObject({ approval: { action: "execute", description: "git push origin main" } });
    expect(proc.permissionOutcomes.at(-1)).toEqual({ outcome: "selected", optionId: "opt-allow" });
    expect(aceito.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "completed" } });

    await run("reject");
    expect(proc.permissionOutcomes.at(-1)).toEqual({ outcome: "selected", optionId: "opt-reject" });

    await run(); // ninguém responde: expira e rejeita
    expect(proc.permissionOutcomes.at(-1)).toEqual({ outcome: "selected", optionId: "opt-reject" });
    expect(c.respondApproval("inexistente", "approve")).toBe(false);
    c.close();
  });

  it("permissionOutcome nunca aprova sem opção de aprovação", () => {
    expect(permissionOutcome([{ optionId: "r", kind: "reject_always" }], "approve")).toEqual({ outcome: { outcome: "cancelled" } });
    expect(permissionOutcome([{ optionId: "a", kind: "allow_always" }], "approve")).toEqual({ outcome: { outcome: "selected", optionId: "a" } });
  });

  it("seleção de modelo: válida via set_config_option, inválida ou sem seletor falha explicitamente", async () => {
    const { proc, c } = client({ profile: "mimo" });
    await c.initialize();
    const s = await c.newSession("/tmp");
    await c.selectModel(s, "xiaomi/mimo-v2.6-pro");
    expect(proc.received.at(-1)).toMatchObject({ method: "session/set_config_option", params: { configId: "model", value: "xiaomi/mimo-v2.6-pro" } });
    await expect(c.selectModel(s, "openrouter/outro")).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    await c.selectModel(s, "default");
    c.close();

    const cop = client({ profile: "copilot" });
    await cop.c.initialize();
    const s2 = await cop.c.newSession("/tmp");
    await expect(cop.c.selectModel(s2, "gpt-x")).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
    cop.c.close();
  });

  it("session/load: histórico reenviado não vaza para o próximo turno", async () => {
    const { c } = client({ profile: "copilot" });
    await c.initialize();
    const s = await c.newSession("/tmp");
    await c.reopenSession(s.sessionId, "/tmp");
    const events = await collect(c.runTurn(s.sessionId, "oi"));
    expect(JSON.stringify(events)).not.toContain("HISTÓRICO");
    c.close();
  });
});

describe("ETAPA 12 — AcpAdapter (Copilot e MiMo pela mesma infraestrutura)", () => {
  let home: string;
  let ws: string;
  let registry: ProcessRegistry;
  let dead: Set<number>;
  let procs: FakeAcpProcess[];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-acp-"));
    ws = join(home, "ws");
    await mkdir(ws, { recursive: true });
    dead = new Set();
    registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); procs.find((p) => p.pid === pid)?.kill(); }, isPidRunning: (pid) => !dead.has(pid) });
    procs = [];
  });

  afterEach(async () => {
    await registry.shutdownAll();
    await rm(home, { recursive: true, force: true });
  });

  const adapter = (vendor = MIMO_ACP, opts: FakeAcpOptions = {}) =>
    new AcpAdapter({
      vendor,
      driver: engineRegistry.get(vendor.engineId)!,
      homeDir: home,
      processRegistry: registry,
      launcher: async ({ args }) => {
        const p = createFakeAcpAgent(args, { profile: vendor.engineId as "copilot" | "mimo", ...opts });
        procs.push(p);
        return p;
      },
      installStatusProbe: async () => ({ installed: true, isManaged: false, path: `/fake/${vendor.binaryName}`, version: "fake" }),
      authStatusProbe: async () => ({ authenticated: true, method: "teste" }),
    });

  it("registry expõe Copilot e MiMo como adaptadores ACP", () => {
    for (const id of ["copilot", "mimo"]) {
      const a = engineRegistry.getAdapter(id)!;
      expect(a).toBeInstanceOf(AcpAdapter);
      expect(a.manifest.transport).toBe("stdio_jsonrpc");
      expect(a.conversationRuntime).toBeDefined();
    }
  });

  it("usa os argumentos ACP de cada fornecedor", async () => {
    await adapter(COPILOT_ACP).conversationRuntime.create({ workspaceId: "w", workspacePath: ws, model: "default", homeDir: home });
    await adapter(MIMO_ACP).conversationRuntime.create({ workspaceId: "w2", workspacePath: ws, model: "default", homeDir: home });
    expect(procs.map((p) => p.args)).toEqual([["--acp"], ["acp"]]);
  });

  it("modelo explícito no MiMo é aplicado; modelo desconhecido falha antes do turno", async () => {
    const a = adapter();
    const ref = await a.conversationRuntime.create({ workspaceId: "w", workspacePath: ws, model: "xiaomi/mimo-v2.6-pro", homeDir: home });
    expect(a.getSessionMeta(ref.id)?.model).toBe("xiaomi/mimo-v2.6-pro");
    await expect(a.conversationRuntime.create({ workspaceId: "w", workspacePath: ws, model: "openrouter/x", homeDir: home })).rejects.toMatchObject({ code: "MODEL_INCOMPATIBLE" });
  });

  it("retomada após reinício do processo reabre a sessão nativa (resume no MiMo, load no Copilot)", async () => {
    for (const vendor of [MIMO_ACP, COPILOT_ACP]) {
      const first = adapter(vendor);
      const ref = await first.conversationRuntime.create({ workspaceId: `w-${vendor.engineId}`, workspacePath: ws, model: "default", homeDir: home });
      // Mesmo processo falso sobrevive: novo adaptador (sem sessões em memória) reabre pelo ID.
      const second = adapter(vendor);
      (second as any).clients.set(`${vendor.engineId}::w-${vendor.engineId}`, (first as any).clients.get(`${vendor.engineId}::w-${vendor.engineId}`));
      const again = await second.conversationRuntime.create({ conversationId: ref.id, workspaceId: `w-${vendor.engineId}`, workspacePath: ws, model: "default", homeDir: home });
      expect(again.id).toBe(ref.id);
      const method = vendor.engineId === "mimo" ? "session/resume" : "session/load";
      expect(procs.at(-1)!.received.some((m) => m.method === method)).toBe(true);
    }
  });

  it("close no Copilot chama session/close; no MiMo só libera a referência", async () => {
    const cop = adapter(COPILOT_ACP);
    const r1 = await cop.conversationRuntime.create({ workspaceId: "w", workspacePath: ws, model: "default", homeDir: home });
    await cop.conversationRuntime.close(r1);
    expect(procs[0]!.received.some((m) => m.method === "session/close")).toBe(true);
    const mimo = adapter(MIMO_ACP);
    const r2 = await mimo.conversationRuntime.create({ workspaceId: "w2", workspacePath: ws, model: "default", homeDir: home });
    await mimo.conversationRuntime.close(r2);
    expect(procs[1]!.received.some((m) => m.method === "session/close")).toBe(false);
  });

  it("inicializações concorrentes do mesmo workspace não geram processo extra", async () => {
    const a = adapter();
    await Promise.all([1, 2, 3].map(() => a.conversationRuntime.create({ workspaceId: "w", workspacePath: ws, model: "default", homeDir: home })));
    expect(procs).toHaveLength(1);
  });

  it("one-shot do Copilot passa --model na inicialização e recusa aprovações", async () => {
    const events = await collect(adapter(COPILOT_ACP).runner.run({
      workspaceId: "w", workspacePath: ws, sessionId: "s", agentId: "a", model: "gpt-x", prompt: "precisa de permissão", homeDir: home,
    }));
    expect(procs[0]!.args).toEqual(["--acp", "--model", "gpt-x"]);
    expect(procs[0]!.permissionOutcomes).toEqual([{ outcome: "selected", optionId: "opt-reject" }]);
    expect(events.at(-1)?.type).toBe("run.completed");
    expect(procs[0]!.alive).toBe(false);
  });

  it("one-shot com timeout marca stopReason timeout e encerra o processo", async () => {
    const events = await collect(adapter().runner.run({
      workspaceId: "w", workspacePath: ws, sessionId: "s", agentId: "a", model: "default", prompt: "processo lento", homeDir: home, timeoutMs: 30,
    }));
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "timeout" } });
    expect(procs[0]!.alive).toBe(false);
  });
});
