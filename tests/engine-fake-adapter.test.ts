/**
 * Prova de agnosticismo: um adaptador "fake", sem nada de Claude, registrado no EngineRegistry, passa pelas
 * mesmas verificações de contrato e o núcleo (catálogo, limites, sessão nativa) o consulta só pelo
 * manifest/driver, nunca pelo id do motor.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  engineRegistry,
  isCapabilityAvailable,
  manifestAcceptsModel,
  manifestLimits,
  validateEngineCapabilityManifest,
  type AgentEvent,
  type AgentRunInput,
  type EngineAdapter,
  type EngineCapabilityManifest,
  type EngineDriver,
} from "../src/core/engines/index.js";
import { checkModelEngineCompatibility } from "../src/core/models/catalog.js";
import { reduzirHistorico } from "../src/core/engines/event-log.js";

const ID = "fake-harness";

const manifest: EngineCapabilityManifest = {
  engineId: ID,
  name: "Fake Harness",
  transport: "stdio_jsonrpc",
  supportsConversation: true,
  limits: { tetoMs: 42_000, inatividadeMs: 7_000 },
  modelPrefixes: ["fake-"],
  instructionFiles: ["AGENTS.md"],
  toolPolicyModes: ["ask", "deny"],
  emits: ["artifact.produced", "session.updated"],
  features: {
    streaming: { level: "integrated" },
    continuation: { level: "integrated" },
    fork: { level: "unsupported" },
    hitl: { level: "integrated" },
    tools: { level: "integrated" },
    mcp: { level: "unsupported" },
    images: { level: "unsupported" },
    cancellation: { level: "integrated" },
  },
};

const fakeAdapter: EngineAdapter = {
  engineId: ID,
  name: manifest.name,
  manifest,
  installer: { engineId: ID, status: async () => ({ installed: true, isManaged: false, path: "/fake", version: "1" }), install: async () => ({ success: true, path: "/fake", version: "1", log: "" }) },
  authenticator: { engineId: ID, status: async () => ({ authenticated: true, method: "fake" }) },
  runner: {
    engineId: ID,
    async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
      const runId = input.runId ?? "r";
      yield { type: "run.started", runId, timestamp: "t", engineId: ID };
      yield { type: "session.updated", runId, nativeSessionId: input.resumeSessionId ?? "native-1", resumed: !!input.resumeSessionId };
      yield { type: "message.delta", runId, text: `eco:${input.prompt}` };
      yield { type: "artifact.produced", runId, artifact: { id: "a1", path: "out/report.md", kind: "report" } };
      yield { type: "run.completed", runId, result: { output: `eco:${input.prompt}`, stopReason: "completed" } };
    },
  },
};

const fakeDriver: EngineDriver = {
  id: ID,
  name: "Fake Harness",
  description: "driver de teste",
  category: "cli",
  maintainer: "teste",
  supportedModelsHint: ["fake-1"],
  timeoutDefaults: { tetoMs: 42_000, inatividadeMs: 7_000 },
  modelPrefixes: ["fake-"],
  nativeSessionPassthrough: true,
  fallbackModels: ["fake-2"],
  isInstalled: async () => ({ installed: true, isManaged: false, path: "/fake", version: "1" }),
  install: async () => ({ success: true, path: "/fake", version: "1", log: "" }),
  checkHealth: async () => ({ healthy: true, issues: [] }) as any,
  prepareExecution: async (o) => ({ binary: "/fake", args: [o.prompt], env: {}, cwd: o.workspacePath }),
} as EngineDriver;

async function collect(it: AsyncIterable<AgentEvent>) {
  const out: AgentEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("adaptador fake (sem Claude)", () => {
  it("manifest válido e registrável", () => {
    expect(() => validateEngineCapabilityManifest(manifest)).not.toThrow();
    engineRegistry.register(fakeDriver);
    engineRegistry.registerAdapter(fakeAdapter);
    expect(engineRegistry.getManifest(ID)?.limits?.tetoMs).toBe(42_000);
    expect(isCapabilityAvailable(manifest, "hitl")).toBe(true);
    expect(manifestLimits(manifest).inatividadeMs).toBe(7_000);
    expect(manifestAcceptsModel(manifest, "fake-9")).toBe(true);
    expect(manifestAcceptsModel(manifest, "claude-x")).toBe(false);
  });

  it("run emite eventos canônicos, inclusive sessão e artefato, e o resume passa adiante", async () => {
    const base = { workspaceId: "w", workspacePath: "/tmp", sessionId: "s", agentId: "a", model: "fake-1", prompt: "oi", homeDir: "/tmp" };
    const ev = await collect(fakeAdapter.runner.run(base));
    expect(ev[0]?.type).toBe("run.started");
    expect(ev.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "completed" } });
    expect(ev.find((e) => e.type === "artifact.produced")).toBeDefined();
    const retomado = await collect(fakeAdapter.runner.run({ ...base, resumeSessionId: "native-9", toolPolicy: { mode: "ask" } }));
    expect(retomado.find((e) => e.type === "session.updated")).toMatchObject({ nativeSessionId: "native-9", resumed: true });
  });

  it("o histórico ignora eventos novos sem quebrar", () => {
    const eventos: AgentEvent[] = [
      { type: "session.updated", runId: "r", nativeSessionId: "x" },
      { type: "artifact.produced", runId: "r", artifact: { id: "a", path: "p" } },
      { type: "message.delta", runId: "r", text: "oi" },
    ];
    expect(() => reduzirHistorico(eventos.map((ev) => ({ tipo: "evento", ev, ts: "t" }) as any))).not.toThrow();
  });

  it("o núcleo consulta o driver, não o id do motor", () => {
    engineRegistry.register(fakeDriver);
    expect(checkModelEngineCompatibility(ID, "gpt-5").compatible).toBe(false);
    expect(checkModelEngineCompatibility(ID, "fake-1").compatible).toBe(true);
    expect(engineRegistry.resolveDriver(ID).timeoutDefaults?.tetoMs).toBe(42_000);
  });
});

describe("núcleo sem nomes de motor Claude", () => {
  const raiz = new URL("../src/", import.meta.url);
  for (const arq of ["core/contexts/execution/execution-driver.ts", "utils/paths.ts"]) {
    it(`${arq} não cita claude`, () => {
      expect(readFileSync(new URL(arq, raiz), "utf8")).not.toMatch(/claude/i);
    });
  }
  it("session-manager não decide por id claude-sdk", () => {
    expect(readFileSync(new URL("core/contexts/execution/session-manager.ts", raiz), "utf8")).not.toMatch(/driver\.id === "claude/);
  });
  it("manifest do claude-sdk e limites do driver coincidem", () => {
    const m = engineRegistry.getManifest("claude-sdk")!;
    const d = engineRegistry.resolveDriver("claude-sdk");
    expect(d.timeoutDefaults).toEqual(m.limits);
    expect(d.modelPrefixes).toEqual(m.modelPrefixes);
  });
});
