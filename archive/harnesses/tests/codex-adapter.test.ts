import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexAdapter,
  CodexAppServerClient,
  isNativeThreadId,
  type AgentEvent,
  type AgentRunInput,
  type CodexAppServerHandle,
  type CodexAppServerLaunchOptions,
  type CodexLaunchOptions,
  type CodexProcessHandle,
} from "../src/core/engines/index.js";
import { ProcessRegistry, formatProcessKey } from "../src/core/runtime/index.js";

class LineQueue {
  private values: string[] = [];
  private waiters: Array<(value: IteratorResult<string>) => void> = [];
  private closed = false;
  push(value: unknown) {
    const line = typeof value === "string" ? value : `${JSON.stringify(value)}\n`;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: line, done: false });
    else this.values.push(line);
  }
  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as any, done: true });
  }
  async *iterate() {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<IteratorResult<string>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

type TurnScript = (ctx: { threadId: string; turnId: string; text: string; out: LineQueue; exit: () => void }) => void;

interface FakeServer {
  pid: number;
  lastTurn?: { threadId: string; turnId: string };
  messages: any[];
  out: LineQueue;
  exit: () => void;
  killed: NodeJS.Signals[];
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timeout aguardando condição");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("ETAPA 8 — Adaptador Codex com app-server", () => {
  let home: string;
  let workspace: string;
  let cliLaunches: CodexLaunchOptions[];
  let servers: FakeServer[];
  let registry: ProcessRegistry;
  let turnCounter: number;
  let script: TurnScript;
  let launchDelayMs: number;
  let autoCompleteAfterApproval: boolean;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-codex-test-"));
    workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    cliLaunches = [];
    servers = [];
    turnCounter = 0;
    launchDelayMs = 0;
    autoCompleteAfterApproval = true;
    const dead = new Set<number>();
    registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); }, isPidRunning: (pid) => !dead.has(pid) });
    script = ({ threadId, turnId, text, out }) => {
      out.push({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "msg", delta: `resposta:${text}` } });
      out.push({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } } } });
      out.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    };
  });

  afterEach(async () => {
    await registry.shutdownAll();
    await rm(home, { recursive: true, force: true });
  });

  function cliLauncher(opts: CodexLaunchOptions): Promise<CodexProcessHandle> {
    cliLaunches.push(opts);
    async function* stdout() {
      yield `${JSON.stringify({ type: "thread.started", thread_id: "thread-cli" })}\n`;
      yield `${JSON.stringify({ type: "item.completed", item: { id: "msg", type: "agent_message", text: "resposta one-shot" } })}\n`;
      yield `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } })}\n`;
    }
    return Promise.resolve({ pid: 1234, stdout: stdout(), exitCode: Promise.resolve(0), kill: () => {} });
  }

  async function appLauncher(_opts: CodexAppServerLaunchOptions): Promise<CodexAppServerHandle> {
    if (launchDelayMs) await new Promise((resolve) => setTimeout(resolve, launchDelayMs));
    const out = new LineQueue();
    let resolveExit!: (code: number) => void;
    const exitCode = new Promise<number>((resolve) => { resolveExit = resolve; });
    const server: FakeServer = {
      pid: 4000 + servers.length,
      messages: [],
      out,
      exit: () => { out.close(); resolveExit(0); },
      killed: [],
    };
    servers.push(server);
    return {
      pid: server.pid,
      stdout: out.iterate(),
      exitCode,
      kill: (signal = "SIGTERM") => { server.killed.push(signal); server.exit(); },
      write(line) {
        const message = JSON.parse(line);
        server.messages.push(message);
        if (message.method === "initialize") out.push({ id: message.id, result: { userAgent: "fake" } });
        else if (message.method === "thread/start") out.push({ id: message.id, result: { thread: { id: randomUUID() } } });
        else if (message.method === "thread/resume") out.push({ id: message.id, result: { thread: { id: message.params.threadId } } });
        else if (message.method === "thread/fork") out.push({ id: message.id, result: { thread: { id: randomUUID() } } });
        else if (message.method === "turn/start") {
          const turnId = `turn-${++turnCounter}`;
          const threadId = message.params.threadId;
          out.push({ id: message.id, result: { turn: { id: turnId } } });
          server.lastTurn = { threadId, turnId };
          script({ threadId, turnId, text: message.params.input[0].text, out, exit: server.exit });
        } else if (message.id === 0 && !message.method && server.lastTurn && autoCompleteAfterApproval) {
          // Resposta do cliente a uma solicitação de aprovação: o turno termina.
          out.push({ method: "turn/completed", params: { threadId: server.lastTurn.threadId, turn: { id: server.lastTurn.turnId, status: "completed" } } });
        } else if (message.method === "turn/interrupt") {
          out.push({ id: message.id, result: {} });
          out.push({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: message.params.turnId, status: "interrupted" } } });
        }
      },
    };
  }

  function adapter() {
    return new CodexAdapter({
      homeDir: home,
      processRegistry: registry,
      customProcessLauncher: cliLauncher,
      appServerLauncher: appLauncher,
      installStatusProbe: async () => ({ installed: true, isManaged: false, path: "/fake/codex", version: "test" }),
      authStatusProbe: async () => ({ authenticated: true, method: "test" }),
    });
  }

  function runInput(): AgentRunInput {
    return { workspaceId: "ws-1", workspacePath: workspace, sessionId: "s1", agentId: "a1", model: "default", prompt: "analise", homeDir: home };
  }

  const create = (instance: CodexAdapter, workspaceId = "ws-1", conversationId?: string) =>
    instance.conversationRuntime.create({ conversationId, workspaceId, workspacePath: workspace, model: "default", homeDir: home });

  it("mantém codex exec para one-shot e declara app-server para conversas", async () => {
    const instance = adapter();
    expect(instance.manifest.transport).toBe("stdio_jsonrpc");
    expect(instance.manifest.features.hitl.level).toBe("integrated");
    expect(instance.manifest.features.continuation.flags).toEqual(["thread/resume"]);
    const events = await collect(instance.runner.run(runInput()));
    expect(cliLaunches[0].args).toContain("--json");
    expect(servers).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { output: "resposta one-shot" } });
  });

  it("inicializa app-server persistente, cria thread nativa e registra o processo", async () => {
    const ref = await create(adapter());
    expect(isNativeThreadId(ref.id)).toBe(true);
    expect(servers).toHaveLength(1);
    const methods = servers[0].messages.map((m) => m.method);
    expect(methods.slice(0, 3)).toEqual(["initialize", "initialized", "thread/start"]);
    expect(servers[0].messages[0].params.clientInfo.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(registry.get(formatProcessKey({ engineId: "codex", workspaceId: "ws-1" }))).toMatchObject({
      pid: servers[0].pid, transport: "stdio_jsonrpc", referenceCount: 0, authVerified: true,
    });
  });

  it("faz streaming multi-turn na mesma thread, com uso de tokens, sem novo processo", async () => {
    const instance = adapter();
    const ref = await create(instance);
    const first = await collect(instance.conversationRuntime.send(ref, { text: "um" }));
    const second = await collect(instance.conversationRuntime.send(ref, { text: "dois" }));
    expect(first.map((e) => e.type)).toEqual(["run.started", "message.delta", "usage.updated", "run.completed"]);
    expect(first.at(-1)).toMatchObject({ result: { output: "resposta:um", stopReason: "completed" } });
    expect(second.at(-1)).toMatchObject({ result: { output: "resposta:dois" } });
    expect(first.find((e) => e.type === "usage.updated")).toMatchObject({ usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 } });
    expect(servers).toHaveLength(1);
    expect(servers[0].messages.filter((m) => m.method === "turn/start")).toHaveLength(2);
    expect(registry.get("codex::ws-1")?.referenceCount).toBe(0);
  });

  it("retoma somente IDs nativos; IDs não nativos abrem thread nova", async () => {
    const persisted = randomUUID();
    const instance = adapter();
    const resumed = await create(instance, "ws-1", persisted);
    expect(resumed.id).toBe(persisted);
    expect(servers[0].messages.some((m) => m.method === "thread/resume" && m.params.threadId === persisted)).toBe(true);

    const legacy = await create(instance, "ws-1", "sessao-1727300000000");
    expect(legacy.id).not.toBe("sessao-1727300000000");
    expect(isNativeThreadId(legacy.id)).toBe(true);
    expect(servers[0].messages.filter((m) => m.method === "thread/resume")).toHaveLength(1);
  });

  it("cria fork persistente via thread/fork", async () => {
    const instance = adapter();
    const ref = await create(instance);
    const fork = await instance.conversationRuntime.fork!(ref);
    expect(fork.id).not.toBe(ref.id);
    expect(servers[0].messages.some((m) => m.method === "thread/fork" && m.params.threadId === ref.id)).toBe(true);
    expect(await instance.conversationRuntime.resume(fork)).toMatchObject({ status: "active", metadata: { nativeThreadId: fork.id } });
  });

  describe("aprovações", () => {
    beforeEach(() => {
      script = ({ threadId, turnId, text, out }) => {
        if (text === "comando") {
          out.push({ method: "item/commandExecution/requestApproval", id: 0, params: { threadId, turnId, itemId: "cmd", command: "git push", cwd: workspace, kind: "command" } });
        } else if (text === "permissao") {
          out.push({ method: "item/permissions/requestApproval", id: 0, params: { threadId, turnId, itemId: "perm", reason: "rede", permissions: { network: { enabled: true } } } });
        } else {
          out.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
        }
      };
    });

    const replyToServerRequest = (server: FakeServer) => server.messages.find((m) => m.id === 0 && !m.method);

    it("encaminha aprovação com ID local e devolve a decisão ao app-server", async () => {
      const instance = adapter();
      const ref = await create(instance);
      const events: AgentEvent[] = [];
      const consuming = (async () => {
        for await (const event of instance.conversationRuntime.send(ref, { text: "comando" })) events.push(event);
      })();
      await waitFor(() => events.some((e) => e.type === "approval.requested"));
      const approval = events.find((e): e is Extract<AgentEvent, { type: "approval.requested" }> => e.type === "approval.requested")!;
      expect(approval.approval.id).not.toBe("0");
      expect(approval.approval.description).toBe("git push");
      expect(await instance.conversationRuntime.respondApproval!(approval.approval.id, "approve", { workspaceId: "ws-1" })).toBe(true);
      expect(replyToServerRequest(servers[0])).toMatchObject({ id: 0, result: { decision: "accept" } });
      await consuming;
      expect(events.at(-1)?.type).toBe("run.completed");
      // Resposta repetida não é reenviada.
      expect(await instance.conversationRuntime.respondApproval!(approval.approval.id, "approve", { workspaceId: "ws-1" })).toBe(false);
    });

    it("não permite que um workspace responda aprovação de outro, mesmo com IDs JSON-RPC iguais", async () => {
      const instance = adapter();
      const refA = await create(instance, "ws-a");
      const refB = await create(instance, "ws-b");
      const eventsA: AgentEvent[] = [];
      const eventsB: AgentEvent[] = [];
      const a = (async () => { for await (const e of instance.conversationRuntime.send(refA, { text: "comando" })) eventsA.push(e); })();
      const b = (async () => { for await (const e of instance.conversationRuntime.send(refB, { text: "comando" })) eventsB.push(e); })();
      await waitFor(() => eventsA.some((e) => e.type === "approval.requested") && eventsB.some((e) => e.type === "approval.requested"));
      const idA = (eventsA.find((e) => e.type === "approval.requested") as any).approval.id;
      const idB = (eventsB.find((e) => e.type === "approval.requested") as any).approval.id;
      expect(idA).not.toBe(idB);

      expect(await instance.conversationRuntime.respondApproval!(idA, "approve", { workspaceId: "ws-b" })).toBe(false);
      expect(servers[1].messages.some((m) => m.id === 0 && !m.method)).toBe(false);

      expect(await instance.conversationRuntime.respondApproval!(idA, "approve", { workspaceId: "ws-a" })).toBe(true);
      expect(await instance.conversationRuntime.respondApproval!(idB, "reject", { workspaceId: "ws-b" })).toBe(true);
      expect(replyToServerRequest(servers[0])).toMatchObject({ result: { decision: "accept" } });
      expect(replyToServerRequest(servers[1])).toMatchObject({ result: { decision: "decline" } });
      await Promise.all([a, b]);
    });

    it("concede ou nega permissões no formato do protocolo", async () => {
      const instance = adapter();
      const ref = await create(instance);
      const events: AgentEvent[] = [];
      const consuming = (async () => { for await (const e of instance.conversationRuntime.send(ref, { text: "permissao" })) events.push(e); })();
      await waitFor(() => events.some((e) => e.type === "approval.requested"));
      const id = (events.find((e) => e.type === "approval.requested") as any).approval.id;
      await instance.conversationRuntime.respondApproval!(id, "reject", { workspaceId: "ws-1" });
      expect(replyToServerRequest(servers[0])).toMatchObject({ result: { permissions: {}, scope: "turn" } });
      await consuming;
    });

    it("cancela aprovações pendentes quando o turno é abortado", async () => {
      const instance = adapter();
      const ref = await create(instance);
      autoCompleteAfterApproval = false;
      const controller = new AbortController();
      const events: AgentEvent[] = [];
      const consuming = (async () => { for await (const e of instance.conversationRuntime.send(ref, { text: "comando" }, controller.signal)) events.push(e); })();
      await waitFor(() => events.some((e) => e.type === "approval.requested"));
      controller.abort();
      await consuming;
      expect(servers[0].messages.find((m) => m.id === 0 && !m.method)).toMatchObject({ result: { decision: "cancel" } });
      expect(servers[0].messages.some((m) => m.method === "turn/interrupt")).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", result: { stopReason: "cancelled" } });
    });
  });

  it("recusa explicitamente solicitações do servidor que o OpenCorp não suporta", async () => {
    script = ({ threadId, turnId, out }) => {
      out.push({ method: "item/tool/requestUserInput", id: 55, params: { threadId, turnId } });
      out.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    };
    const instance = adapter();
    const ref = await create(instance);
    await collect(instance.conversationRuntime.send(ref, { text: "x" }));
    expect(servers[0].messages.find((m) => m.id === 55)).toMatchObject({ error: { code: -32601 } });
  });

  it("não encerra o turno em erro com willRetry e falha em erro definitivo", async () => {
    script = ({ threadId, turnId, text, out }) => {
      out.push({ method: "error", params: { threadId, turnId, willRetry: true, error: { message: "rate limit, tentando de novo" } } });
      if (text === "definitivo") {
        out.push({ method: "error", params: { threadId, turnId, willRetry: false, error: { message: "cota esgotada" } } });
        return;
      }
      out.push({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m", delta: "ok" } });
      out.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    };
    const instance = adapter();
    const ref = await create(instance);
    const retried = await collect(instance.conversationRuntime.send(ref, { text: "retry" }));
    expect(retried.at(-1)).toMatchObject({ type: "run.completed", result: { output: "ok" } });
    const failed = await collect(instance.conversationRuntime.send(ref, { text: "definitivo" }));
    expect(failed.at(-1)).toMatchObject({ type: "run.failed" });
    expect((failed.at(-1) as any).error.message).toContain("cota esgotada");
  });

  it("emite run.failed se o app-server morrer no meio do turno e descarta o registro", async () => {
    script = ({ threadId, turnId, out, exit }) => {
      out.push({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m", delta: "parcial" } });
      setTimeout(exit, 5);
    };
    const instance = adapter();
    const ref = await create(instance);
    const events = await collect(instance.conversationRuntime.send(ref, { text: "x" }));
    expect(events.at(-1)?.type).toBe("run.failed");
    await waitFor(() => registry.get("codex::ws-1") === undefined);

    // A próxima conversa inicia um processo novo em vez de reutilizar o morto.
    script = ({ threadId, turnId, out }) => out.push({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
    const next = await create(instance);
    await collect(instance.conversationRuntime.send(next, { text: "y" }));
    expect(servers).toHaveLength(2);
  });

  it("deduplica inicializações concorrentes do mesmo workspace", async () => {
    launchDelayMs = 20;
    const instance = adapter();
    const [a, b] = await Promise.all([create(instance), create(instance)]);
    expect(servers).toHaveLength(1);
    expect(a.id).not.toBe(b.id);
    expect(servers[0].killed).toEqual([]);
  });

  it("isola um processo app-server por workspace", async () => {
    const instance = adapter();
    await create(instance, "ws-1");
    await create(instance, "ws-2");
    expect(servers).toHaveLength(2);
    expect(registry.get("codex::ws-1")?.pid).not.toBe(registry.get("codex::ws-2")?.pid);
  });

  it("rejeita sessão de outro workspace", async () => {
    const instance = adapter();
    const ref = await create(instance, "ws-1");
    const events = await collect(instance.conversationRuntime.send({ ...ref, workspaceId: "ws-2" }, { text: "x" }));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run.failed");
  });

  describe("CodexAppServerClient", () => {
    it("falha a requisição por timeout e encerra o processo que não inicializa", async () => {
      const out = new LineQueue();
      const killed: string[] = [];
      const client = new CodexAppServerClient({
        command: "codex",
        cwd: workspace,
        env: {},
        requestTimeoutMs: 20,
        launcher: async () => ({ pid: 1, stdout: out.iterate(), write: () => {}, kill: (s = "SIGTERM") => { killed.push(s); out.close(); }, exitCode: new Promise(() => {}) }),
      });
      await expect(client.start()).rejects.toThrow(/initialize/);
      expect(killed).toEqual(["SIGTERM"]);
      expect(client.isClosed).toBe(true);
    });

    it("drena stderr e preserva apenas o final para diagnóstico", async () => {
      const out = new LineQueue();
      async function* stderr() {
        yield "x".repeat(20_000);
        yield "\nfalha final";
      }
      const client = new CodexAppServerClient({
        command: "codex",
        cwd: workspace,
        env: {},
        launcher: async () => ({
          pid: 1,
          stdout: out.iterate(),
          stderr: stderr(),
          write: (line: string) => { const m = JSON.parse(line); if (m.method === "initialize") out.push({ id: m.id, result: {} }); },
          kill: () => out.close(),
          exitCode: new Promise(() => {}),
        }),
      });
      await client.start();
      await waitFor(() => client.stderr.endsWith("falha final"));
      expect(client.stderr.length).toBeLessThanOrEqual(8 * 1024);
      client.close();
    });

    it("não lança quando o processo já não aceita escrita", async () => {
      const out = new LineQueue();
      let writable = true;
      const client = new CodexAppServerClient({
        command: "codex",
        cwd: workspace,
        env: {},
        launcher: async () => ({
          pid: 1,
          stdout: out.iterate(),
          write: (line: string) => {
            if (!writable) throw new Error("EPIPE");
            const m = JSON.parse(line);
            if (m.method === "initialize") out.push({ id: m.id, result: {} });
          },
          kill: () => out.close(),
          exitCode: new Promise(() => {}),
        }),
      });
      await client.start();
      writable = false;
      await expect(client.startThread({ cwd: workspace })).rejects.toThrow("EPIPE");
      client.close();
    });
  });
});
