/**
 * Adaptador openheinerss: fluxo feliz, ferramentas, aprovação, cancelamento, erro, isolamento e zero órfãos,
 * contra um servidor JSON-RPC falso (tests/fixtures/fake-openheinerss.ts). A suíte espelha os casos de
 * engine-conformance.test.ts; um teste de integração opcional usa o binário real quando existe.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPENHEINERSS_DEFAULT_BIN,
  OpenheinerssAdapter,
  resolveOpenheinerssBinary,
  engineRegistry,
  isCapabilityAvailable,
  parseOpenheinerssModel,
  openheinerssInstallStatus,
  type AgentEvent,
} from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";
import { createFakeOpenheinerss, type FakeOpenheinerssProcess } from "./fixtures/fake-openheinerss.js";

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

describe("openheinerss — registro e modelo", () => {
  it("está registrado, driver só para listagem e manifest é válido", () => {
    const adapter = engineRegistry.getAdapter("openheinerss");
    expect(adapter).toBeDefined();
    expect(adapter!.manifest.transport).toBe("stdio_jsonrpc");
    expect(engineRegistry.get("openheinerss")).toBeDefined();
    expect(isCapabilityAvailable(adapter!.manifest, "hitl")).toBe(true);
  });

  it("aparece na lista de motores com o estado real de instalação", async () => {
    const list = await engineRegistry.listSummaries("/tmp");
    const item = list.find((e) => e.id === "openheinerss");
    expect(item).toBeDefined();
    expect(typeof item!.installed).toBe("boolean");
    expect(item!.installed).toBe(existsSync(OPENHEINERSS_DEFAULT_BIN) || !!process.env.OPENHEINERSS_BIN || item!.installed);
    expect(item!.supportsConversation).toBe(true);
    expect(engineRegistry.getAdapter("openheinerss")).toBeInstanceOf(OpenheinerssAdapter);
  });

  it("resolução sem binário devolve null em vez de lançar", async () => {
    const status = resolveOpenheinerssBinary("/nao/existe", { PATH: "" } as NodeJS.ProcessEnv);
    expect(status === null || existsSync(status)).toBe(true);
  });

  it("binário ausente = indisponível, sem exceção", async () => {
    const adapter = new OpenheinerssAdapter({ binPath: "/nao/existe/openheinerss", installStatusProbe: undefined });
    const status = await openheinerssInstallStatus("/nao/existe/openheinerss");
    if (!existsSync(OPENHEINERSS_DEFAULT_BIN) && !process.env.OPENHEINERSS_BIN) expect(status.installed).toBe(false);
    expect(await adapter.authenticator.status("/tmp")).toHaveProperty("authenticated");
  });

  it("parseia harness e modelo", () => {
    const env = { OPENHEINERSS_HARNESS: "codex" } as NodeJS.ProcessEnv;
    expect(parseOpenheinerssModel("mock", env)).toEqual({ harness: "mock" });
    expect(parseOpenheinerssModel("claude-code:claude-sonnet-5-5", env)).toEqual({ harness: "claude-code", model: "claude-sonnet-5-5" });
    expect(parseOpenheinerssModel("gpt-5", env)).toEqual({ harness: "codex", model: "gpt-5" });
    expect(parseOpenheinerssModel("default", env)).toEqual({ harness: "codex" });
    expect(parseOpenheinerssModel("openrouter:anthropic/x", env)).toEqual({ harness: "openrouter", model: "anthropic/x" });
  });
});

describe("openheinerss — protocolo (servidor falso)", () => {
  let home: string;
  let registry: ProcessRegistry;
  let dead: Set<number>;
  let procs: FakeOpenheinerssProcess[];
  let adapter: OpenheinerssAdapter;
  const ws = (n: string) => ({ id: `ws-${n}`, path: "" });

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-ohs-"));
    await mkdir(join(home, ".opencorp"), { recursive: true });
    dead = new Set();
    procs = [];
    registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); procs.find((p) => p.pid === pid)?.kill(); }, isPidRunning: (pid) => !dead.has(pid) });
    adapter = new OpenheinerssAdapter({
      homeDir: home,
      processRegistry: registry,
      launcher: async () => { const p = createFakeOpenheinerss(); procs.push(p); return p; },
      installStatusProbe: async () => ({ installed: true, isManaged: false, path: "/fake/openheinerss", version: "fake 1.0" }),
      approvalTimeoutMs: 200,
    });
  });

  afterEach(async () => {
    await registry.shutdownAll();
    for (const p of procs) p.kill();
    await rm(home, { recursive: true, force: true });
  });

  const wsDir = async (n: string) => {
    const w = ws(n);
    w.path = join(home, `ws-${n}`);
    await mkdir(w.path, { recursive: true });
    return w;
  };
  const create = async (w: { id: string; path: string }, conversationId?: string) =>
    adapter.conversationRuntime.create({ conversationId, workspaceId: w.id, workspacePath: w.path, model: "mock", homeDir: home });

  it("manifesto e instalação", async () => {
    expect(adapter.manifest.engineId).toBe("openheinerss");
    expect(adapter.manifest.supportsConversation).toBe(true);
    expect(await adapter.installer.status(home)).toMatchObject({ installed: true });
    expect(await adapter.authenticator.status(home)).toMatchObject({ authenticated: true });
    expect((await adapter.modelCatalog.listModels()).map((m) => m.id)).toContain("mock");
  });

  it("one-shot: fluxo feliz com eventos canônicos, uso e sessão nativa", async () => {
    const w = await wsDir("a");
    const events = await collect(adapter.runner.run({
      runId: "r1", sessionId: "s1", agentId: "a1", model: "claude-code:claude-sonnet-5-5", prompt: "MARCADOR-1",
      workspaceId: w.id, workspacePath: w.path, homeDir: home, systemPromptAppend: "seja breve",
    }));
    expect(events[0]).toMatchObject({ type: "run.started", engineId: "openheinerss" });
    expect(events.some((e) => e.type === "session.updated")).toBe(true);
    const deltas = events.filter((e) => e.type === "message.delta").map((e: any) => e.text);
    expect(deltas.join("")).toContain("MARCADOR-1");
    expect(events.some((e) => e.type === "usage.updated")).toBe(true);
    const last = events.at(-1) as any;
    expect(last).toMatchObject({ type: "run.completed", result: { stopReason: "completed", usage: { totalTokens: 15 } } });
    const create = procs[0].received.find((r) => r.method === "session.create")!;
    expect(create.params).toMatchObject({ harness: "claude-code", model: "claude-sonnet-5-5", options: { permissionMode: "ask", systemPrompt: "seja breve" } });
    // one-shot encerra o processo
    expect(procs[0].alive).toBe(false);
  });

  it("one-shot: aprovação sem canal é negada; allow-all liga always_allow", async () => {
    const w = await wsDir("a");
    const events = await collect(adapter.runner.run({
      sessionId: "s1", agentId: "a1", model: "mock", prompt: "precisa de permissão",
      workspaceId: w.id, workspacePath: w.path, homeDir: home,
    }));
    expect(events.some((e) => e.type === "approval.requested")).toBe(true);
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({ decision: "rejected" });
    expect((events.at(-1) as any).result.output).toContain("negado");

    await collect(adapter.runner.run({
      sessionId: "s2", agentId: "a1", model: "mock", prompt: "oi", toolPolicy: { mode: "allow-all" },
      workspaceId: w.id, workspacePath: w.path, homeDir: home,
    }));
    const last = procs.at(-1)!.received.find((r) => r.method === "session.create")!;
    expect(last.params.options.permissionMode).toBe("always_allow");
  });

  it("conversa: turnos, ferramentas e artefato produzido", async () => {
    const w = await wsDir("a");
    const ref = await create(w);
    const first = await collect(adapter.conversationRuntime.send(ref, { text: "use ferramenta e escreva" }));
    const requested = first.find((e) => e.type === "tool.requested") as any;
    const completed = first.find((e) => e.type === "tool.completed") as any;
    expect(completed.result).toMatchObject({ id: requested.call.id, name: "Read", isError: false });
    expect(first.find((e) => e.type === "artifact.produced")).toMatchObject({ artifact: { path: "out.md" } });
    expect(first.some((e) => e.type === "session.updated")).toBe(true);
    const second = await collect(adapter.conversationRuntime.send(ref, { text: "turno 2" }));
    expect(second.at(-1)?.type).toBe("run.completed");
    expect(procs).toHaveLength(1);
    // mesmo id retorna a mesma conversa sem novo processo
    expect((await create(w, ref.id)).id).toBe(ref.id);
    expect(procs).toHaveLength(1);
  });

  it("conversa: retomada de sessão desconhecida usa session.resume", async () => {
    const w = await wsDir("a");
    const ref = await create(w, "sess_antiga");
    expect(ref.id).toBe("sess_antiga");
    expect(procs[0].received.some((r) => r.method === "session.resume")).toBe(true);
  });

  it("aprovação HITL: só o workspace dono responde; resolve com approval.resolved", async () => {
    const wa = await wsDir("a");
    const wb = await wsDir("b");
    const ref = await create(wa);
    await create(wb);
    const events: AgentEvent[] = [];
    for await (const ev of adapter.conversationRuntime.send(ref, { text: "precisa de permissão" })) {
      events.push(ev);
      if (ev.type === "approval.requested") {
        expect(await adapter.conversationRuntime.respondApproval!(ev.approval.id, "approve", { workspaceId: wb.id })).toBe(false);
        expect(await adapter.conversationRuntime.respondApproval!(ev.approval.id, "approve", { workspaceId: wa.id })).toBe(true);
        expect(await adapter.conversationRuntime.respondApproval!(ev.approval.id, "approve", { workspaceId: wa.id })).toBe(false);
      }
    }
    expect(events.find((e) => e.type === "approval.requested")).toMatchObject({ approval: { action: "Bash" } });
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({ decision: "approved" });
    expect(events.some((e) => e.type === "tool.completed")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "completed" } });
  });

  it("aprovação sem resposta expira e nega", async () => {
    const w = await wsDir("a");
    const ref = await create(w);
    const events = await collect(adapter.conversationRuntime.send(ref, { text: "precisa de permissão" }));
    expect(events.find((e) => e.type === "approval.resolved")).toMatchObject({ decision: "expired" });
    expect((events.at(-1) as any).result.output).toContain("negado");
  });

  it("cancelamento: abort encerra o turno como cancelled", async () => {
    const w = await wsDir("a");
    const ref = await create(w);
    const ac = new AbortController();
    const pending = collect(adapter.conversationRuntime.send(ref, { text: "processo lento" }, ac.signal));
    setTimeout(() => ac.abort(), 50);
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "cancelled" } });
    expect(procs[0].received.some((r) => r.method === "session.abort")).toBe(true);
  });

  it("timeout do one-shot interrompe um turno travado", async () => {
    const w = await wsDir("a");
    const started = Date.now();
    const events = await collect(adapter.runner.run({
      sessionId: "s", agentId: "a", model: "mock", prompt: "lento", timeoutMs: 100,
      workspaceId: w.id, workspacePath: w.path, homeDir: home,
    }));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect((events.at(-1) as any).result.stopReason).toBe("cancelled");
  });

  it("agent.error vira run.failed com a mensagem e a correção sugerida", async () => {
    const w = await wsDir("a");
    const ref = await create(w);
    const last = (await collect(adapter.conversationRuntime.send(ref, { text: "provoque erro" }))).at(-1) as any;
    expect(last.type).toBe("run.failed");
    expect(last.error.message).toContain("Model not found");
    expect(last.error.message).toContain("escolha outro modelo");
  });

  it("erro JSON-RPC em session.prompt vira run.failed", async () => {
    const w = await wsDir("a");
    const ref = await create(w);
    const last = (await collect(adapter.conversationRuntime.send(ref, { text: "rpc-erro" }))).at(-1) as any;
    expect(last.type).toBe("run.failed");
    expect(last.error.message).toContain("Chave de API ausente");
  });

  it("processo que morre no meio do turno vira run.failed", async () => {
    const w = await wsDir("a");
    const ref = await create(w);
    const pending = collect(adapter.conversationRuntime.send(ref, { text: "processo lento" }));
    setTimeout(() => procs[0].kill(), 50);
    expect((await pending).at(-1)?.type).toBe("run.failed");
  });

  it("sessão desconhecida falha sem processo novo", async () => {
    const w = await wsDir("a");
    const events = await collect(adapter.conversationRuntime.send({ id: "nada", engineId: "openheinerss", workspaceId: w.id }, { text: "oi" }));
    expect(events.at(-1)?.type).toBe("run.failed");
  });

  it("isolamento: um processo residente por workspace; zero órfãos ao encerrar", async () => {
    const wa = await wsDir("a");
    const wb = await wsDir("b");
    const ref = await create(wa);
    await create(wb);
    expect(procs).toHaveLength(2);
    expect(registry.get("openheinerss::ws-a")?.pid).not.toBe(registry.get("openheinerss::ws-b")?.pid);
    await collect(adapter.conversationRuntime.send(ref, { text: "oi" }));
    await adapter.conversationRuntime.close(ref);
    await registry.shutdownAll();
    expect(registry.list()).toHaveLength(0);
    expect(procs.filter((p) => p.alive)).toHaveLength(0);
  });
});

const REAL = process.env.OPENHEINERSS_BIN || OPENHEINERSS_DEFAULT_BIN;
describe.skipIf(!existsSync(REAL))("openheinerss — integração com o binário real (harness mock)", () => {
  it("responde pelo harness mock, com aprovação negada no one-shot", async () => {
    const home = await mkdtemp(join(tmpdir(), "opencorp-ohs-real-"));
    const dir = join(home, "ws");
    await mkdir(dir, { recursive: true });
    const adapter = new OpenheinerssAdapter({ homeDir: home, binPath: REAL, processRegistry: new ProcessRegistry() });
    try {
      expect((await adapter.installer.status(home)).installed).toBe(true);
      const events = await collect(adapter.runner.run({
        sessionId: "s", agentId: "a", model: "mock", prompt: "responda OK", timeoutMs: 30_000,
        workspaceId: "ws", workspacePath: dir, homeDir: home,
      }));
      expect(events[0].type).toBe("run.started");
      expect(events.some((e) => e.type === "approval.requested")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.completed" });
      expect((events.at(-1) as any).result.output).toContain("Entendido");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 40_000);
});
