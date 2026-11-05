/**
 * Adaptador OpenCode contra um servidor falso que reproduz o contrato real do
 * `opencode serve` 1.18.32 (conferido na OpenAPI `/doc` e em servidor real):
 *
 *   - HTTP Basic `opencode:<OPENCODE_SERVER_PASSWORD>` em todas as rotas;
 *   - `POST /session/:id/message` exige `parts` (400 "Missing key parts" sem ele);
 *   - streaming via `POST /session/:id/prompt_async` (204) + SSE `GET /event`
 *     com `message.updated`, `message.part.updated`, `message.part.delta`,
 *     `permission.asked`, `session.status`, `session.error`, `session.idle`;
 *   - permissões respondidas em `POST /session/:id/permissions/:permissionID`
 *     com `{ response: "once" | "always" | "reject" }`.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { startFakeOpenCode as launchFakeOpenCode, type FakeOpenCode } from "./fixtures/fake-opencode-server.js";
import { mkdtemp, rm, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OpenCodeAdapter,
  OpenCodeTurnState,
  mapOpenCodeRunEvent,
  parseOpenCodeModel,
  type AgentEvent,
} from "../src/core/engines/index.js";
import { ProcessRegistry, formatProcessKey } from "../src/core/runtime/index.js";


describe("ETAPA 6/11 — Adaptador OpenCode (contrato real do opencode serve)", () => {
  let tempHome: string;
  let ws1: string;
  let ws2: string;
  let fakes: FakeOpenCode[];
  let registry: ProcessRegistry;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "opencorp-opencode-test-"));
    ws1 = join(tempHome, "workspaces", "ws-1");
    ws2 = join(tempHome, "workspaces", "ws-2");
    await mkdir(ws1, { recursive: true });
    await mkdir(ws2, { recursive: true });
    await mkdir(join(tempHome, ".opencorp"), { recursive: true });
    fakes = [];
    // PIDs falsos: "morrem" ao receber o sinal, sem esperar o período de graça.
    const dead = new Set<number>();
    registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); }, isPidRunning: (pid) => !dead.has(pid) });
  });

  afterEach(async () => {
    for (const f of fakes) await f.close();
    await registry.shutdownAll();
    await rm(tempHome, { recursive: true, force: true });
  });

  async function startFakeOpenCode(port: number, password: string): Promise<FakeOpenCode> {
    const fake = await launchFakeOpenCode(port, password);
    fakes.push(fake);
    return fake;
  }

  function adapterWithFake(onLaunch?: (password: string, port: number) => void) {
    let pid = 9000;
    return new OpenCodeAdapter({
      homeDir: tempHome,
      processRegistry: registry,
      customServerLauncher: async ({ port, authToken }) => {
        onLaunch?.(authToken, port);
        await startFakeOpenCode(port, authToken);
        return { pid: ++pid };
      },
    });
  }

  async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
    const out: AgentEvent[] = [];
    for await (const ev of iterable) out.push(ev);
    return out;
  }

  const create = (adapter: OpenCodeAdapter, workspaceId = "ws-1", workspacePath = ws1, extra: Record<string, unknown> = {}) =>
    adapter.conversationRuntime.create({ workspaceId, workspacePath, model: "openrouter/vendor/modelo", homeDir: tempHome, ...extra });

  it("manifesto declara conversa, streaming, continuação e fork", () => {
    const adapter = new OpenCodeAdapter({ homeDir: tempHome });
    expect(adapter.engineId).toBe("opencode");
    expect(adapter.manifest.supportsConversation).toBe(true);
    expect(adapter.manifest.features.streaming.level).toBe("integrated");
    expect(adapter.manifest.features.continuation.level).toBe("integrated");
    expect(adapter.manifest.features.fork.level).toBe("integrated");
  });

  it("sessão nova: senha aleatória, loopback, sessão nativa e registro sem referência presa", async () => {
    let password = "";
    let port = 0;
    const adapter = adapterWithFake((p, po) => { password = p; port = po; });
    const ref = await create(adapter, "ws-1", ws1, { title: "Olá Secretário" });

    expect(ref).toMatchObject({ engineId: "opencode", workspaceId: "ws-1" });
    expect(ref.id).toMatch(/^ses_/);
    expect(password.length).toBeGreaterThan(10);
    const meta = adapter.getSessionMeta(ref.id);
    expect(meta).toEqual({ port, workspaceDir: ws1, url: `http://127.0.0.1:${port}` });
    expect(JSON.stringify(meta)).not.toContain(password);

    const proc = registry.get(formatProcessKey({ engineId: "opencode", workspaceId: "ws-1" }));
    expect(proc?.pid).toBe(9001);
    // A senha nunca vai para o ProcessRegistry.
    expect(JSON.stringify(proc)).not.toContain(password);
    // Nenhuma referência presa: o timeout ocioso (D2) funciona entre mensagens.
    expect(proc?.referenceCount).toBe(0);
  });

  it("streaming real: prompt_async + SSE viram deltas, ferramenta, uso e conclusão", async () => {
    const adapter = adapterWithFake();
    const ref = await create(adapter);
    const events = await collect(adapter.conversationRuntime.send(ref, { text: "Liste os arquivos" }));

    expect(events[0]?.type).toBe("run.started");
    const deltas = events.filter((e) => e.type === "message.delta").map((e: any) => e.text);
    expect(deltas).toEqual(["Olá, ", "resposta para: ", "Liste os arquivos"]);
    expect(deltas.join("")).not.toContain("VAZOU");
    expect(events.find((e) => e.type === "tool.requested")).toMatchObject({ call: { id: "call_1", name: "read", arguments: { filePath: "a.txt" } } });
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ result: { id: "call_1", result: "conteúdo", isError: false } });
    expect(events.find((e) => e.type === "usage.updated")).toMatchObject({ usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125, costUsd: 0.001 } });
    const last = events.at(-1) as any;
    expect(last).toMatchObject({ type: "run.completed", result: { output: "Olá, resposta para: Liste os arquivos", stopReason: "completed" } });

    const fake = fakes[0]!;
    const prompt = fake.requests.find((r) => r.url.endsWith("/prompt_async"));
    expect(prompt?.body).toEqual({ parts: [{ type: "text", text: "Liste os arquivos" }], model: { providerID: "openrouter", modelID: "vendor/modelo" } });
    expect(registry.get("opencode::ws-1")?.referenceCount).toBe(0);
  });

  it("continuação: vários turnos reutilizam o mesmo servidor e retomada usa o ID nativo", async () => {
    let spawns = 0;
    const adapter = adapterWithFake(() => { spawns += 1; });
    const ref = await create(adapter);
    await collect(adapter.conversationRuntime.send(ref, { text: "Turno 1" }));
    await collect(adapter.conversationRuntime.send(ref, { text: "Turno 2" }));
    const resumed = await create(adapter, "ws-1", ws1, { conversationId: ref.id });
    expect(resumed.id).toBe(ref.id);
    expect(spawns).toBe(1);
    expect(fakes[0]!.requests.filter((r) => r.url === "/session" && r.method === "POST")).toHaveLength(1);
    expect(await adapter.conversationRuntime.resume(ref)).toMatchObject({ status: "idle" });
  });

  it("fork cria sessão nativa nova no mesmo servidor", async () => {
    const adapter = adapterWithFake();
    const ref = await create(adapter);
    const forked = await adapter.conversationRuntime.fork!(ref);
    expect(forked.id).toMatch(/^ses_fork/);
    expect(forked.id).not.toBe(ref.id);
    expect(forked.workspaceId).toBe("ws-1");
  });

  it("erro da sessão (SSE session.error) vira run.failed normalizado", async () => {
    const adapter = adapterWithFake();
    const ref = await create(adapter);
    const events = await collect(adapter.conversationRuntime.send(ref, { text: "provoque erro" }));
    const last = events.at(-1) as any;
    expect(last.type).toBe("run.failed");
    expect(last.error.message).toContain("Model not found");
  });

  it("cancelamento chama /abort e termina com stopReason cancelled", async () => {
    const adapter = adapterWithFake();
    const ref = await create(adapter);
    const ac = new AbortController();
    const pending = collect(adapter.conversationRuntime.send(ref, { text: "processo lento" }, ac.signal));
    setTimeout(() => ac.abort(), 100);
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "cancelled" } });
    expect(fakes[0]!.requests.some((r) => r.url.endsWith("/abort"))).toBe(true);
  });

  it("permissão: permission.asked vira approval e só o workspace dono responde", async () => {
    const adapter = adapterWithFake();
    const ref = await create(adapter);
    const events: AgentEvent[] = [];
    for await (const ev of adapter.conversationRuntime.send(ref, { text: "precisa de permissão" })) {
      events.push(ev);
      if (ev.type === "approval.requested") {
        expect(ev.approval).toMatchObject({ action: "bash", description: "git push origin main" });
        expect(await adapter.conversationRuntime.respondApproval!(ev.approval.id, "approve", { workspaceId: "ws-2" })).toBe(false);
        expect(await adapter.conversationRuntime.respondApproval!(ev.approval.id, "approve", { workspaceId: "ws-1" })).toBe(true);
      }
    }
    expect(fakes[0]!.permissionReplies).toEqual([{ id: expect.stringMatching(/^per_/), response: "once" }]);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "completed" } });
  });

  it("isolamento: cada workspace tem servidor, porta e senha próprios; fechar não apaga histórico", async () => {
    const launches: Array<{ password: string; port: number }> = [];
    const adapter = adapterWithFake((password, port) => launches.push({ password, port }));
    const ref1 = await create(adapter, "ws-1", ws1);
    const ref2 = await create(adapter, "ws-2", ws2);
    expect(launches).toHaveLength(2);
    expect(launches[0]!.port).not.toBe(launches[1]!.port);
    expect(launches[0]!.password).not.toBe(launches[1]!.password);
    expect(registry.get("opencode::ws-1")?.pid).not.toBe(registry.get("opencode::ws-2")?.pid);

    await adapter.conversationRuntime.close(ref1);
    expect(adapter.getSessionMeta(ref1.id)).toBeUndefined();
    expect(adapter.getSessionMeta(ref2.id)).toBeDefined();
    // Nenhum DELETE: o histórico da sessão no OpenCode é preservado.
    expect(fakes.flatMap((f) => f.requests).some((r) => r.method === "DELETE")).toBe(false);
  });

  it("sessão desconhecida falha sem tocar servidor algum", async () => {
    const adapter = adapterWithFake();
    const events = await collect(adapter.conversationRuntime.send({ id: "ses_inexistente", engineId: "opencode", workspaceId: "ws-1" }, { text: "oi" }));
    expect(events.at(-1)?.type).toBe("run.failed");
    expect(fakes).toHaveLength(0);
  });

  it("one-shot: traduz o formato real de `opencode run --format json`", async () => {
    const mockBin = join(tempHome, "fake-opencode-cli.sh");
    const lines = [
      { type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
      { type: "tool_use", sessionID: "ses_1", part: { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { filePath: "a" }, output: "ok" } } },
      { type: "text", sessionID: "ses_1", part: { type: "text", text: "Resultado da análise" } },
      { type: "step_finish", sessionID: "ses_1", part: { type: "step-finish", tokens: { input: 10, output: 3, reasoning: 1 }, cost: 0 } },
    ];
    await writeFile(mockBin, `#!/bin/sh\n${lines.map((l) => `echo '${JSON.stringify(l)}'`).join("\n")}\nexit 0\n`);
    await chmod(mockBin, 0o755);
    const adapter = new OpenCodeAdapter({ homeDir: tempHome, binPath: mockBin, processRegistry: registry });
    const events = await collect(adapter.runner.run({
      runId: "run-1", sessionId: "s1", agentId: "a1", model: "opencode/x", prompt: "tarefa",
      workspaceId: "ws-1", workspacePath: ws1, homeDir: tempHome,
    }));
    expect(events.filter((e) => e.type === "message.delta").map((e: any) => e.text)).toEqual(["Resultado da análise"]);
    expect(events.find((e) => e.type === "tool.completed")).toMatchObject({ result: { id: "c1", name: "read", result: "ok", isError: false } });
    expect(events.find((e) => e.type === "usage.updated")).toMatchObject({ usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } });
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { output: "Resultado da análise", stopReason: "completed" } });
  });

  it("one-shot: evento `error` do CLI vira run.failed mesmo com exit 0", async () => {
    const mockBin = join(tempHome, "fake-opencode-err.sh");
    const line = { type: "error", sessionID: "ses_1", error: { name: "UnknownError", data: { message: "Unexpected server error" } } };
    await writeFile(mockBin, `#!/bin/sh\necho '${JSON.stringify(line)}'\nexit 0\n`);
    await chmod(mockBin, 0o755);
    const adapter = new OpenCodeAdapter({ homeDir: tempHome, binPath: mockBin, processRegistry: registry });
    const events = await collect(adapter.runner.run({
      runId: "run-2", sessionId: "s1", agentId: "a1", model: "opencode/x", prompt: "tarefa",
      workspaceId: "ws-1", workspacePath: ws1, homeDir: tempHome,
    }));
    expect(events.at(-1)).toMatchObject({ type: "run.failed" });
    expect((events.at(-1) as any).error.message).toContain("Unexpected server error");
  });

  describe("tradutores puros", () => {
    it("parseOpenCodeModel", () => {
      expect(parseOpenCodeModel("openrouter/a/b:free")).toEqual({ providerID: "openrouter", modelID: "a/b:free" });
      expect(parseOpenCodeModel("default")).toBeUndefined();
      expect(parseOpenCodeModel("semprovedor")).toBeUndefined();
    });

    it("mapOpenCodeRunEvent ignora eventos desconhecidos", () => {
      expect(mapOpenCodeRunEvent({ type: "step_start" }, "r").events).toEqual([]);
      expect(mapOpenCodeRunEvent({ type: "text", part: { text: "" } }, "r").events).toEqual([]);
    });

    it("OpenCodeTurnState ignora session.idle antes do turno começar e texto de mensagens do usuário", () => {
      const state = new OpenCodeTurnState("ses_1", "r");
      state.accept({ type: "session.idle", properties: { sessionID: "ses_1" } });
      expect(state.idle).toBe(false);
      state.accept({ type: "message.part.updated", properties: { sessionID: "ses_1", part: { id: "p_user", messageID: "msg_user", type: "text", text: "prompt do usuário" } } });
      expect(state.output).toBe("");
      state.accept({ type: "session.status", properties: { sessionID: "ses_1", status: { type: "busy" } } });
      state.accept({ type: "session.idle", properties: { sessionID: "ses_1" } });
      expect(state.idle).toBe(true);
    });
  });
});
