/**
 * Suíte de contrato por adaptador (Etapa 11).
 *
 * O mesmo conjunto de verificações roda contra cada adaptador conversacional,
 * usando fakes que reproduzem o protocolo real do motor. Capacidades são
 * verificadas conforme o manifesto: uma feature `integrated` precisa passar;
 * `declared`/`unsupported` é pulada explicitamente (nunca aprovada por omissão).
 *
 * Vocabulário comum dos fakes: "lento" (só termina se interrompido),
 * "permissão" (pede aprovação), "erro" (turno falha).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AcpAdapter,
  COPILOT_ACP,
  MIMO_ACP,
  engineRegistry,
  type AcpVendorConfig,
  CodexAdapter,
  OpenCodeAdapter,
  isCapabilityAvailable,
  type AgentEvent,
  type EngineAdapter,
  type FeatureKey,
} from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";
import { startFakeOpenCode, type FakeOpenCode } from "./fixtures/fake-opencode-server.js";
import { createFakeCodex } from "./fixtures/fake-codex-app-server.js";
import { createFakeAcpAgent, type FakeAcpProcess } from "./fixtures/fake-acp-agent.js";

interface Workspace { id: string; path: string }

interface Harness {
  adapter: EngineAdapter;
  registry: ProcessRegistry;
  workspaces: [Workspace, Workspace];
  model: string;
  /** Processos falsos do motor ainda vivos. */
  liveProcesses(): number;
  /** Quantas vezes um processo residente foi iniciado. */
  launches(): number;
  teardown(): Promise<void>;
}

type HarnessFactory = (home: string, registry: ProcessRegistry, dead: Set<number>) => Promise<Harness>;

const KNOWN_EVENTS = new Set([
  "run.started", "message.delta", "tool.requested", "tool.completed", "approval.requested",
  "usage.updated", "run.completed", "run.failed", "approval.resolved", "artifact.produced", "session.updated",
]);

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of iterable) out.push(ev);
  return out;
}

async function workspaces(home: string): Promise<[Workspace, Workspace]> {
  const a = { id: "ws-a", path: join(home, "ws-a") };
  const b = { id: "ws-b", path: join(home, "ws-b") };
  await mkdir(a.path, { recursive: true });
  await mkdir(b.path, { recursive: true });
  return [a, b];
}

const openCodeHarness: HarnessFactory = async (home, registry, dead) => {
  const fakes: FakeOpenCode[] = [];
  const pids: number[] = [];
  let nextPid = 5000;
  // CLI one-shot falso no formato real de `opencode run --format json`.
  const cli = join(home, "fake-opencode-run.sh");
  await writeFile(cli, [
    "#!/bin/sh",
    'for last; do :; done',
    'printf \'{"type":"text","sessionID":"ses_cli","part":{"type":"text","text":"Olá, resposta para: %s"}}\\n\' "$last"',
    'printf \'{"type":"step_finish","sessionID":"ses_cli","part":{"type":"step-finish","tokens":{"input":10,"output":5,"reasoning":0}}}\\n\'',
  ].join("\n"));
  await chmod(cli, 0o755);
  const adapter = new OpenCodeAdapter({
    homeDir: home,
    binPath: cli,
    processRegistry: registry,
    customServerLauncher: async ({ port, authToken }) => {
      fakes.push(await startFakeOpenCode(port, authToken));
      const pid = ++nextPid;
      pids.push(pid);
      return { pid };
    },
  });
  return {
    adapter,
    registry,
    workspaces: await workspaces(home),
    model: "openrouter/vendor/modelo",
    liveProcesses: () => pids.filter((p) => !dead.has(p)).length,
    launches: () => pids.length,
    teardown: async () => { for (const f of fakes) await f.close(); },
  };
};

const codexHarness: HarnessFactory = async (home, registry, dead) => {
  const fake = createFakeCodex();
  const adapter = new CodexAdapter({
    homeDir: home,
    processRegistry: registry,
    appServerLauncher: fake.appServerLauncher,
    customProcessLauncher: fake.cliLauncher,
    installStatusProbe: async () => ({ installed: true, isManaged: false, path: "/fake/codex", version: "codex-cli 0.157.1" }),
    authStatusProbe: async () => ({ authenticated: true, method: "codex login status" }),
  });
  return {
    adapter,
    registry,
    workspaces: await workspaces(home),
    model: "gpt-fake",
    // Um app-server sinalizado pelo ProcessRegistry (killer) conta como encerrado.
    liveProcesses: () => fake.liveProcesses() - fake.servers.filter((s) => s.alive && dead.has(s.pid)).length,
    launches: () => fake.servers.length,
    teardown: async () => {},
  };
};

const acpHarness = (vendor: AcpVendorConfig): HarnessFactory => async (home, registry, dead) => {
  const procs: FakeAcpProcess[] = [];
  let residents = 0;
  const adapter = new AcpAdapter({
    vendor,
    driver: engineRegistry.get(vendor.engineId)!,
    homeDir: home,
    processRegistry: registry,
    launcher: async ({ args }) => {
      const p = createFakeAcpAgent(args, { profile: vendor.engineId as "copilot" | "mimo" });
      procs.push(p);
      return p;
    },
    installStatusProbe: async () => ({ installed: true, isManaged: false, path: `/fake/${vendor.binaryName}`, version: "fake 1.0" }),
    authStatusProbe: async () => ({ authenticated: true, method: "teste" }),
  });
  registry.addListener((event) => { if (event.type === "process.registered") residents += 1; });
  return {
    adapter,
    registry,
    workspaces: await workspaces(home),
    model: "default",
    liveProcesses: () => procs.filter((p) => p.alive && !dead.has(p.pid)).length,
    launches: () => residents,
    teardown: async () => { for (const p of procs) p.kill(); },
  };
};

const ADAPTERS: Array<[string, HarnessFactory]> = [
  ["copilot", acpHarness(COPILOT_ACP)],
  ["mimo", acpHarness(MIMO_ACP)],
  ["opencode", openCodeHarness],
  ["codex", codexHarness],
];

for (const [engineId, factory] of ADAPTERS) {
  describe(`Conformidade — ${engineId}`, () => {
    let home: string;
    let h: Harness;
    let registry: ProcessRegistry;
    let dead: Set<number>;

    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), `opencorp-conformance-${engineId}-`));
      await mkdir(join(home, ".opencorp"), { recursive: true });
      dead = new Set();
      registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); }, isPidRunning: (pid) => !dead.has(pid) });
      h = await factory(home, registry, dead);
    });

    afterEach(async () => {
      await registry.shutdownAll();
      await h.teardown();
      await rm(home, { recursive: true, force: true });
    });

    const declared = (feature: FeatureKey) => isCapabilityAvailable(h.adapter.manifest, feature);
    const [wsA, wsB] = [() => h.workspaces[0], () => h.workspaces[1]];
    const create = (ws = wsA(), conversationId?: string) =>
      h.adapter.conversationRuntime!.create({ conversationId, workspaceId: ws.id, workspacePath: ws.path, model: h.model, homeDir: home });

    it("manifesto válido e runtime conversacional presente", () => {
      expect(h.adapter.engineId).toBe(engineId);
      expect(h.adapter.manifest.engineId).toBe(engineId);
      expect(h.adapter.manifest.supportsConversation).toBe(true);
      expect(h.adapter.conversationRuntime).toBeDefined();
    });

    it("binário/versão e autenticação sem inferência", async () => {
      if (engineId === "opencode") {
        // O OpenCode resolve o binário pelo PATH (stubs de teste); só a forma do status é verificada aqui.
        const status = await h.adapter.installer.status(home);
        expect(typeof status.installed).toBe("boolean");
      } else {
        expect(await h.adapter.installer.status(home)).toMatchObject({ installed: true, version: expect.any(String) });
        expect(await h.adapter.authenticator.status(home)).toMatchObject({ authenticated: true });
      }
    });

    it("one-shot: inferência mínima e parsing estruturado em eventos canônicos", async () => {
      const events = await collect(h.adapter.runner.run({
        runId: "r1", sessionId: "s1", agentId: "a1", model: h.model, prompt: "MARCADOR-1",
        workspaceId: wsA().id, workspacePath: wsA().path, homeDir: home,
      }));
      expect(events.every((e) => KNOWN_EVENTS.has(e.type))).toBe(true);
      expect(events[0]?.type).toBe("run.started");
      const last = events.at(-1) as any;
      expect(last.type).toBe("run.completed");
      expect(last.result.output).toContain("MARCADOR-1");
    });

    it("streaming: deltas incrementais formam a saída final", async (ctx) => {
      if (!declared("streaming")) ctx.skip();
      const ref = await create();
      const events = await collect(h.adapter.conversationRuntime!.send(ref, { text: "MARCADOR-2" }));
      const deltas = events.filter((e) => e.type === "message.delta").map((e: any) => e.text);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.join("")).toContain("MARCADOR-2");
      expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "completed" } });
      expect(events.some((e) => e.type === "usage.updated")).toBe(true);
    });

    it("ferramentas: eventos de chamada e conclusão", async (ctx) => {
      if (!declared("tools")) ctx.skip();
      const ref = await create();
      const events = await collect(h.adapter.conversationRuntime!.send(ref, { text: "leia a.txt" }));
      const requested = events.find((e) => e.type === "tool.requested") as any;
      const completed = events.find((e) => e.type === "tool.completed") as any;
      expect(requested).toBeDefined();
      expect(completed?.result.id).toBe(requested.call.id);
      expect(completed?.result.isError).toBe(false);
    });

    it("continuação: turnos na mesma conversa e retomada pelo ID nativo, sem novo processo", async (ctx) => {
      if (!declared("continuation")) ctx.skip();
      const ref = await create();
      await collect(h.adapter.conversationRuntime!.send(ref, { text: "turno 1" }));
      const second = await collect(h.adapter.conversationRuntime!.send(ref, { text: "turno 2" }));
      expect(second.at(-1)?.type).toBe("run.completed");
      const resumed = await create(wsA(), ref.id);
      expect(resumed.id).toBe(ref.id);
      expect(h.launches()).toBe(1);
    });

    it("fork: nova conversa nativa no mesmo workspace", async (ctx) => {
      if (!declared("fork")) ctx.skip();
      const ref = await create();
      const forked = await h.adapter.conversationRuntime!.fork!(ref);
      expect(forked.id).not.toBe(ref.id);
      expect(forked.workspaceId).toBe(ref.workspaceId);
      const events = await collect(h.adapter.conversationRuntime!.send(forked, { text: "no fork" }));
      expect(events.at(-1)?.type).toBe("run.completed");
    });

    it("cancelamento: abort encerra o turno como cancelled", async (ctx) => {
      if (!declared("cancellation")) ctx.skip();
      const ref = await create();
      const ac = new AbortController();
      const pending = collect(h.adapter.conversationRuntime!.send(ref, { text: "processo lento" }, ac.signal));
      setTimeout(() => ac.abort(), 50);
      const events = await pending;
      expect(events.at(-1)).toMatchObject({ type: "run.completed" });
      expect(["cancelled", "interrupted"]).toContain((events.at(-1) as any).result.stopReason);
    });

    it("timeout: sinal com prazo interrompe um turno travado", async (ctx) => {
      if (!declared("cancellation")) ctx.skip();
      const ref = await create();
      const started = Date.now();
      const events = await collect(h.adapter.conversationRuntime!.send(ref, { text: "processo lento" }, AbortSignal.timeout(100)));
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(["run.completed", "run.failed"]).toContain(events.at(-1)?.type);
      expect((events.at(-1) as any).result?.stopReason ?? "failed").not.toBe("completed");
    });

    it("erro do motor vira run.failed normalizado", async () => {
      const ref = await create();
      const events = await collect(h.adapter.conversationRuntime!.send(ref, { text: "provoque erro" }));
      const last = events.at(-1) as any;
      expect(last.type).toBe("run.failed");
      expect(last.error.message).toContain("Model not found");
    });

    it("aprovação HITL: pedido do motor só é respondido pelo workspace dono", async (ctx) => {
      if (!declared("hitl")) ctx.skip();
      const ref = await create();
      const events: AgentEvent[] = [];
      for await (const ev of h.adapter.conversationRuntime!.send(ref, { text: "precisa de permissão" })) {
        events.push(ev);
        if (ev.type === "approval.requested") {
          expect(await h.adapter.conversationRuntime!.respondApproval!(ev.approval.id, "approve", { workspaceId: wsB().id })).toBe(false);
          expect(await h.adapter.conversationRuntime!.respondApproval!(ev.approval.id, "approve", { workspaceId: wsA().id })).toBe(true);
        }
      }
      expect(events.some((e) => e.type === "approval.requested")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "completed" } });
    });

    it("isolamento: um processo residente por workspace", async () => {
      await create(wsA());
      await create(wsB());
      expect(h.launches()).toBe(2);
      const a = registry.get(`${engineId}::${wsA().id}`);
      const b = registry.get(`${engineId}::${wsB().id}`);
      expect(a?.pid).toBeDefined();
      expect(a?.pid).not.toBe(b?.pid);
    });

    it("zero órfãos: encerramento libera todos os processos", async () => {
      const ref = await create(wsA());
      await create(wsB());
      await collect(h.adapter.conversationRuntime!.send(ref, { text: "oi" }));
      await h.adapter.conversationRuntime!.close(ref);
      await registry.shutdownAll();
      expect(registry.list()).toHaveLength(0);
      expect(h.liveProcesses()).toBe(0);
    });
  });
}
