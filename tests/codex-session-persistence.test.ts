/**
 * P-02: metadados das conversas Codex sobrevivem a reinícios do OpenCorp.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter, type AgentEvent } from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";
import { createFakeCodex } from "./fixtures/fake-codex-app-server.js";

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Codex — persistência de metadados de sessão", () => {
  let home: string;
  const registries: ProcessRegistry[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-codex-sess-"));
  });

  afterEach(async () => {
    for (const r of registries.splice(0)) await r.shutdownAll();
    await rm(home, { recursive: true, force: true });
  });

  // Cada chamada simula um processo novo do OpenCorp (memória vazia).
  const novoAdaptador = (fake = createFakeCodex()) => {
    const dead = new Set<number>();
    const registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); }, isPidRunning: (pid) => !dead.has(pid) });
    registries.push(registry);
    const adapter = new CodexAdapter({
      homeDir: home,
      processRegistry: registry,
      appServerLauncher: fake.appServerLauncher,
      installStatusProbe: async () => ({ installed: true, isManaged: false, path: "/fake/codex", version: "test" }),
      authStatusProbe: async () => ({ authenticated: true, method: "test" }),
    });
    return { adapter, fake };
  };

  it("título, modelo e criação sobrevivem ao reinício; a thread é retomada antes do turno", async () => {
    const primeiro = novoAdaptador();
    const ref = await primeiro.adapter.conversationRuntime!.create({ workspaceId: "ws-a", workspacePath: home, homeDir: home, model: "gpt-5-codex", title: "Plano do trimestre" });
    const antes = await primeiro.adapter.conversationRuntime!.resume(ref);

    const persistido = JSON.parse(await readFile(join(home, ".opencorp", "codex-sessions.json"), "utf8"));
    expect(persistido[ref.id]).toMatchObject({ title: "Plano do trimestre", model: "gpt-5-codex", workspaceId: "ws-a" });

    const segundo = novoAdaptador();
    const depois = await segundo.adapter.conversationRuntime!.resume(ref);
    expect(depois.status).toBe("active");
    expect(depois.metadata).toMatchObject({ title: "Plano do trimestre", model: "gpt-5-codex" });

    const eventos = await collect(segundo.adapter.conversationRuntime!.send(ref, { text: "oi" }));
    expect(eventos.some((e) => e.type === "run.completed")).toBe(true);
    const metodos = segundo.fake.servers[0]!.messages.map((m) => m.method);
    expect(metodos.indexOf("thread/resume")).toBeGreaterThan(-1);
    expect(metodos.indexOf("thread/resume")).toBeLessThan(metodos.indexOf("turn/start"));

    const atualizado = await segundo.adapter.conversationRuntime!.resume(ref);
    expect((atualizado.metadata as any).title).toBe("Plano do trimestre");
    expect(antes.lastActiveAt <= atualizado.lastActiveAt).toBe(true);
  });

  it("sessão de outro workspace não é entregue e close remove os metadados", async () => {
    const { adapter } = novoAdaptador();
    const ref = await adapter.conversationRuntime!.create({ workspaceId: "ws-a", workspacePath: home, homeDir: home, title: "Privada" });
    const vazado = await collect(adapter.conversationRuntime!.send({ ...ref, workspaceId: "ws-b" }, { text: "oi" }));
    expect(vazado.map((e) => e.type)).toEqual(["run.failed"]);

    await adapter.conversationRuntime!.close(ref);
    const { adapter: reiniciado } = novoAdaptador();
    expect((await reiniciado.conversationRuntime!.resume(ref)).status).toBe("closed");
  });
});
