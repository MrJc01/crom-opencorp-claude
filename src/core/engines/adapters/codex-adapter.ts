import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { opencorpHome } from "../../../utils/paths.js";
import { checkEngineAuthStatusAsync, probeCliLoginAsync } from "../credentials-bridge.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { binaryOrPreflight } from "../installer/binary-resolver.js";
import { CANONICAL_ENGINE_MANIFESTS, type EngineCapabilityManifest } from "../manifests.js";
import { normalizeEngineError } from "../error-normalizer.js";
import { CodexDriver } from "../drivers/codex-driver.js";
import { formatProcessKey, ProcessRegistry } from "../../runtime/process-registry.js";
import {
  CodexAppServerClient,
  type CodexAppServerLauncher,
} from "./codex-app-server-client.js";
import type { AgentEvent } from "../events.js";
import type {
  AgentRunInput, AgentRunner, ConversationCreateInput, ConversationMessageInput, ConversationRef,
  ConversationRuntime, ConversationState, EngineAdapter, EngineAuthenticator, EngineAuthStatus,
  EngineInstaller, EngineInstallResult, EngineInstallStatus,
} from "../ports.js";

export interface CodexProcessHandle {
  pid: number;
  stdout: AsyncIterable<string | Buffer>;
  stderr?: AsyncIterable<string | Buffer>;
  exitCode: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
}

export interface CodexLaunchOptions {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
}

export interface CodexAdapterOptions {
  homeDir?: string;
  binPath?: string;
  driver?: CodexDriver;
  installStatusProbe?: (homeDir: string) => Promise<EngineInstallStatus>;
  authStatusProbe?: (homeDir: string) => Promise<EngineAuthStatus>;
  customProcessLauncher?: (opts: CodexLaunchOptions) => Promise<CodexProcessHandle>;
  appServerLauncher?: CodexAppServerLauncher;
  processRegistry?: ProcessRegistry;
}

interface CodexSessionMeta {
  id: string;
  workspaceId: string;
  workspacePath: string;
  model?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface CodexJsonEvent {
  type?: string;
  thread_id?: string;
  message?: string;
  error?: { message?: string } | string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
  };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  text?: string;
  delta?: string;
}

/**
 * Metadados das conversas Codex persistidos em `~/.opencorp/codex-sessions.json`.
 * O histórico fica no próprio Codex (thread nativa); aqui só título, modelo,
 * workspace e datas, para sobreviverem a reinícios do OpenCorp.
 */
class CodexSessionStore {
  private readonly file: string;
  private cache: Map<string, CodexSessionMeta> | null = null;

  constructor(homeDir: string) {
    this.file = join(homeDir, ".opencorp", "codex-sessions.json");
  }

  private load(): Map<string, CodexSessionMeta> {
    if (this.cache) return this.cache;
    this.cache = new Map();
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, CodexSessionMeta>;
        for (const [id, meta] of Object.entries(data)) if (meta && meta.id === id && meta.workspaceId) this.cache.set(id, meta);
      }
    } catch {
      // arquivo corrompido: recomeça vazio (o histórico continua no Codex)
    }
    return this.cache;
  }

  private persist(): void {
    const data = Object.fromEntries(this.load());
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(id: string): CodexSessionMeta | undefined {
    return this.load().get(id);
  }

  set(id: string, meta: CodexSessionMeta): void {
    this.load().set(id, meta);
    this.persist();
  }

  touch(meta: CodexSessionMeta): void {
    meta.updatedAt = new Date().toISOString();
    this.set(meta.id, meta);
  }

  delete(id: string): void {
    if (this.load().delete(id)) this.persist();
  }
}

const OPENCORP_VERSION = (createRequire(import.meta.url)("../../../../package.json") as { version: string }).version;

type CodexInvocation =
  | { kind: "start" }
  | { kind: "resume"; threadId: string }
  | { kind: "fork"; threadId: string };

export class CodexAdapter implements EngineAdapter {
  readonly engineId = "codex";
  readonly name = "OpenAI Codex Engine";
  readonly manifest: EngineCapabilityManifest;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner;
  readonly conversationRuntime: ConversationRuntime;
  readonly modelCatalog = undefined;

  private readonly homeDir: string;
  private readonly binPath: string;
  private readonly driver: CodexDriver;
  private readonly customProcessLauncher?: CodexAdapterOptions["customProcessLauncher"];
  private readonly appServerLauncher?: CodexAppServerLauncher;
  private readonly processRegistry: ProcessRegistry;
  private readonly sessions: CodexSessionStore;
  private readonly appServers = new Map<string, CodexAppServerClient>();
  private readonly startingAppServers = new Map<string, Promise<CodexAppServerClient>>();

  constructor(options: CodexAdapterOptions = {}) {
    this.homeDir = options.homeDir ?? opencorpHome();
    this.sessions = new CodexSessionStore(this.homeDir);
    this.driver = options.driver ?? new CodexDriver();
    this.binPath = options.binPath ?? "codex";
    this.customProcessLauncher = options.customProcessLauncher;
    this.appServerLauncher = options.appServerLauncher;
    this.processRegistry = options.processRegistry ?? ProcessRegistry.getInstance();
    this.manifest = CANONICAL_ENGINE_MANIFESTS.codex;

    this.installer = {
      engineId: this.engineId,
      status: options.installStatusProbe ?? ((home: string): Promise<EngineInstallStatus> => this.driver.isInstalled(home)),
      install: (home: string, onProgress?: (msg: string) => void): Promise<EngineInstallResult> =>
        this.driver.install(home, onProgress),
    };
    this.authenticator = {
      engineId: this.engineId,
      status: options.authStatusProbe ?? ((home: string): Promise<EngineAuthStatus> => checkEngineAuthStatusAsync(this.engineId, home)),
      isLoggedIn: async (home: string) => (await probeCliLoginAsync(this.engineId, home))?.loggedIn,
      fetchTokens: (home: string, creds?: { tokenOuChave?: string; authType?: string }) =>
        this.driver.fetchLiveTokens(home, creds),
    };
    this.runner = { engineId: this.engineId, run: (input, signal) => this.execute(input, { kind: "start" }, signal) };
    this.conversationRuntime = {
      engineId: this.engineId,
      create: (input) => this.createConversation(input),
      send: (ref, input, signal) => this.sendConversationMessage(ref, input, signal),
      resume: (ref) => this.resumeConversation(ref),
      fork: (ref) => this.forkConversation(ref),
      respondApproval: (approvalId, decision, scope) => this.respondApproval(approvalId, decision, scope),
      close: (ref) => this.closeConversation(ref),
    };
  }

  private buildArgs(input: AgentRunInput, invocation: CodexInvocation): string[] {
    const common = ["--json", "--skip-git-repo-check"];
    if (input.model && input.model !== "default") common.push("--model", input.model);
    if (invocation.kind === "resume") return ["exec", "resume", ...common, invocation.threadId, input.prompt];
    if (invocation.kind === "fork") {
      return input.prompt
        ? ["exec", "fork", ...common, invocation.threadId, input.prompt]
        : ["exec", "fork", ...common, invocation.threadId];
    }
    return ["exec", "--sandbox", "workspace-write", ...common, input.prompt];
  }

  private async launch(input: AgentRunInput, invocation: CodexInvocation, signal?: AbortSignal) {
    let bin = this.binPath;
    if (!this.customProcessLauncher && (!bin || bin === "codex")) {
      bin = binaryOrPreflight(this.engineId, await this.installer.status(input.homeDir || this.homeDir));
    }
    const options: CodexLaunchOptions = {
      command: bin,
      args: this.buildArgs(input, invocation),
      cwd: input.workspacePath,
      signal,
      env: await resolveEngineSpawnEnv(
        this.engineId,
        { homeDir: input.homeDir || this.homeDir, workspaceId: input.workspaceId, workspacePath: input.workspacePath, accountId: input.accountId },
        { ...(input.envOverrides ?? {}) }
      ),
    };
    if (this.customProcessLauncher) return this.customProcessLauncher(options);

    const spawnOptions: SpawnOptions = { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] };
    const child: ChildProcess = spawn(options.command, options.args, spawnOptions);
    const exitCode = new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    return {
      pid: child.pid ?? 0,
      stdout: child.stdout!,
      stderr: child.stderr ?? undefined,
      exitCode,
      kill: (sig: NodeJS.Signals = "SIGTERM") => { if (!child.killed) child.kill(sig); },
    } satisfies CodexProcessHandle;
  }

  private async *execute(
    input: AgentRunInput,
    invocation: CodexInvocation,
    signal?: AbortSignal,
    onThreadId?: (threadId: string) => void
  ): AsyncIterable<AgentEvent> {
    const runId = input.runId || `codex-run-${Date.now()}-${randomUUID().slice(0, 6)}`;
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: this.engineId };

    let handle: CodexProcessHandle;
    try {
      handle = await this.launch(input, invocation, signal);
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId, modelId: input.model }), timestamp: new Date().toISOString() };
      return;
    }

    let aborted = signal?.aborted ?? false;
    let timedOut = false;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let output = "";
    let protocolError: string | undefined;
    const terminate = () => {
      handle.kill("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => handle.kill("SIGKILL"), 5_000);
    };
    const onAbort = () => { aborted = true; terminate(); };
    if (signal && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) terminate();
    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => { timedOut = true; terminate(); }, input.timeoutMs);
    }
    const stderrPromise = (async () => {
      let stderr = "";
      if (handle.stderr) for await (const chunk of handle.stderr) stderr += chunk.toString();
      return stderr.trim();
    })();

    let buffer = "";
    try {
      for await (const chunk of handle.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const event = this.parseJsonLine(line);
          if (!event) continue;
          if (event.type === "thread.started" && event.thread_id) onThreadId?.(event.thread_id);
          const text = this.extractAssistantText(event);
          if (text) {
            output += text;
            yield { type: "message.delta", runId, text, timestamp: new Date().toISOString() };
          }
          if (event.type === "item.started" && event.item?.type === "command_execution") {
            yield { type: "tool.requested", runId, call: { id: event.item.id || randomUUID(), name: "shell", arguments: { command: event.item.command || "" } }, timestamp: new Date().toISOString() };
          }
          if (event.type === "item.completed" && event.item?.type === "command_execution") {
            yield { type: "tool.completed", runId, result: { id: event.item.id || randomUUID(), name: "shell", result: event.item.aggregated_output || "", isError: typeof event.item.exit_code === "number" && event.item.exit_code !== 0 }, timestamp: new Date().toISOString() };
          }
          if (event.type === "turn.completed" && event.usage) {
            const promptTokens = event.usage.input_tokens;
            const completionTokens = event.usage.output_tokens;
            yield { type: "usage.updated", runId, usage: { promptTokens, completionTokens, totalTokens: typeof promptTokens === "number" && typeof completionTokens === "number" ? promptTokens + completionTokens : undefined }, timestamp: new Date().toISOString() };
          }
          if (event.type === "turn.failed" || event.type === "error") {
            protocolError = typeof event.error === "string" ? event.error : event.error?.message || event.message || "Falha no Codex";
          }
        }
      }
      if (buffer.trim()) {
        const event = this.parseJsonLine(buffer);
        if (event?.type === "thread.started" && event.thread_id) onThreadId?.(event.thread_id);
        const text = event ? this.extractAssistantText(event) : "";
        if (text) { output += text; yield { type: "message.delta", runId, text, timestamp: new Date().toISOString() }; }
      }

      const exitCode = await handle.exitCode;
      const stderr = await stderrPromise;
      if (!aborted && !timedOut && (exitCode !== 0 || protocolError)) {
        const message = protocolError || stderr || `Codex encerrou com código ${exitCode}`;
        yield { type: "run.failed", runId, error: normalizeEngineError(new Error(message), { engineId: this.engineId, modelId: input.model }), timestamp: new Date().toISOString() };
        return;
      }
      yield { type: "run.completed", runId, result: { output, stopReason: aborted ? "cancelled" : timedOut ? "timeout" : "completed" }, timestamp: new Date().toISOString() };
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId, modelId: input.model }), timestamp: new Date().toISOString() };
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private parseJsonLine(line: string): CodexJsonEvent | undefined {
    const trimmed = line.trim();
    if (!trimmed) return undefined;
    try { return JSON.parse(trimmed) as CodexJsonEvent; } catch { return undefined; }
  }

  private extractAssistantText(event: CodexJsonEvent): string {
    if (event.type === "item.completed" && event.item?.type === "agent_message") return event.item.text || "";
    if (event.type === "message.delta") return event.delta || event.text || "";
    if (event.type === "delta" || event.type === "text") return event.text || event.delta || "";
    return "";
  }

  private async createConversation(input: ConversationCreateInput): Promise<ConversationRef> {
    const model = input.model === "default" ? undefined : input.model;
    const existing = input.conversationId ? this.sessions.get(input.conversationId) : undefined;
    if (existing && existing.workspaceId === input.workspaceId && this.appServers.has(formatProcessKey({ engineId: this.engineId, workspaceId: input.workspaceId }))) {
      if (model) existing.model = model;
      this.sessions.touch(existing);
      return { id: existing.id, engineId: this.engineId, workspaceId: existing.workspaceId };
    }

    // Só IDs de thread nativos (UUID) são retomados. IDs gerados por outras
    // camadas (ex.: `sessao-<timestamp>` ou os antigos `codex-session-*`)
    // nunca existiram no Codex e abrem uma thread nova.
    const resumeId = input.conversationId && isNativeThreadId(input.conversationId) ? input.conversationId : undefined;
    const client = await this.getAppServer(input.workspaceId, input.workspacePath, input.homeDir);
    const id = await this.withAppServerActivity(input.workspaceId, async () =>
      resumeId
        ? client.resumeThread(resumeId, { cwd: input.workspacePath, model })
        : client.startThread({ cwd: input.workspacePath, model })
    );
    const now = new Date().toISOString();
    // Retomada após reinício: título, modelo e criação vêm dos metadados persistidos.
    const previous = existing && existing.id === id && existing.workspaceId === input.workspaceId ? existing : undefined;
    this.sessions.set(id, {
      id,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      model: model ?? previous?.model,
      title: input.title || previous?.title || "Conversa com Codex",
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    });
    return { id, engineId: this.engineId, workspaceId: input.workspaceId };
  }

  private async *sendConversationMessage(ref: ConversationRef, input: ConversationMessageInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const session = this.sessions.get(ref.id);
    if (!session || session.workspaceId !== ref.workspaceId) {
      yield { type: "run.failed", runId: `codex-run-${randomUUID()}`, error: normalizeEngineError(new Error(`Sessão Codex não encontrada: ${ref.id}`), { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }
    let client: CodexAppServerClient;
    try {
      const running = this.appServers.has(formatProcessKey({ engineId: this.engineId, workspaceId: session.workspaceId }));
      client = await this.getAppServer(session.workspaceId, session.workspacePath, this.homeDir);
      // App-server novo (reinício/ocioso): a thread precisa ser retomada antes do turno.
      if (!running) {
        await this.withAppServerActivity(session.workspaceId, () =>
          client.resumeThread(session.id, { cwd: session.workspacePath, model: session.model })
        );
      }
    } catch (error) {
      yield { type: "run.failed", runId: `codex-run-${randomUUID()}`, error: normalizeEngineError(error, { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }
    const key = { engineId: this.engineId, workspaceId: session.workspaceId };
    this.processRegistry.acquire(key);
    try {
      for await (const event of client.runTurn(ref.id, input.text, signal)) yield event;
      this.sessions.touch(session);
    } finally {
      this.processRegistry.release(key);
    }
  }

  private async resumeConversation(ref: ConversationRef): Promise<ConversationState> {
    const session = this.sessions.get(ref.id);
    return {
      ref,
      status: session ? "active" : "closed",
      lastActiveAt: session?.updatedAt || new Date().toISOString(),
      metadata: session ? { nativeThreadId: session.id, model: session.model || "default", title: session.title } : undefined,
    };
  }

  private async forkConversation(ref: ConversationRef): Promise<ConversationRef> {
    const source = this.sessions.get(ref.id);
    if (!source) throw new Error("Conversa Codex não encontrada.");
    const client = await this.getAppServer(source.workspaceId, source.workspacePath, this.homeDir);
    const id = await this.withAppServerActivity(source.workspaceId, () =>
      client.forkThread(source.id, { cwd: source.workspacePath, model: source.model })
    );
    const now = new Date().toISOString();
    this.sessions.set(id, { ...source, id, title: `${source.title} (Fork)`, createdAt: now, updatedAt: now });
    return { id, engineId: this.engineId, workspaceId: source.workspaceId };
  }

  private async closeConversation(ref: ConversationRef): Promise<void> {
    this.sessions.delete(ref.id);
  }

  private async respondApproval(approvalId: string, decision: "approve" | "reject", scope: { workspaceId: string }): Promise<boolean> {
    const client = this.appServers.get(formatProcessKey({ engineId: this.engineId, workspaceId: scope.workspaceId }));
    if (!client) return false;
    return client.respondApproval(approvalId, decision);
  }

  private getAppServer(workspaceId: string, workspacePath: string, homeDir: string): Promise<CodexAppServerClient> {
    const key = formatProcessKey({ engineId: this.engineId, workspaceId });
    const existing = this.appServers.get(key);
    if (existing && !existing.isClosed && this.processRegistry.get(key)?.pid === existing.pid) {
      this.processRegistry.touch(key);
      return Promise.resolve(existing);
    }
    // Deduplica inicializações concorrentes do mesmo workspace: sem isso, duas
    // primeiras mensagens simultâneas iniciariam dois processos e o segundo
    // ficaria órfão após a recusa do ProcessRegistry.
    const starting = this.startingAppServers.get(key);
    if (starting) return starting;
    const promise = this.startAppServer(key, workspaceId, workspacePath, homeDir).finally(() => {
      this.startingAppServers.delete(key);
    });
    this.startingAppServers.set(key, promise);
    return promise;
  }

  private async startAppServer(key: string, workspaceId: string, workspacePath: string, homeDir: string): Promise<CodexAppServerClient> {
    const previous = this.appServers.get(key);
    if (previous) {
      previous.close();
      this.appServers.delete(key);
    }

    const home = homeDir || this.homeDir;
    let command = this.binPath;
    if (!this.appServerLauncher && (!command || command === "codex")) {
      command = binaryOrPreflight(this.engineId, await this.installer.status(home));
    }
    const auth = await this.authenticator.status(home).catch(() => ({ authenticated: false }));
    const client = new CodexAppServerClient({
      command,
      cwd: workspacePath,
      env: await resolveEngineSpawnEnv(this.engineId, { homeDir: home, workspaceId, workspacePath }),
      launcher: this.appServerLauncher,
      clientVersion: OPENCORP_VERSION,
    });
    await client.start();
    try {
      this.processRegistry.register({
        key: { engineId: this.engineId, workspaceId },
        pid: client.pid,
        cwd: workspacePath,
        transport: "stdio_jsonrpc",
        expectedExecutableName: "codex",
        authVerified: Boolean(auth.authenticated),
        initialRefCount: 0,
        metadata: { interface: "app-server" },
      });
    } catch (error) {
      client.close();
      throw error;
    }
    this.appServers.set(key, client);
    const pid = client.pid;
    void client.exitCode.then(() => {
      if (this.appServers.get(key) === client) this.appServers.delete(key);
      this.processRegistry.forget(key, pid);
    });
    return client;
  }

  private async withAppServerActivity<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const key = { engineId: this.engineId, workspaceId };
    this.processRegistry.acquire(key);
    try {
      return await operation();
    } finally {
      this.processRegistry.release(key);
    }
  }
}

const NATIVE_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** IDs de thread do Codex são UUIDs (v7 nas versões atuais). */
export function isNativeThreadId(id: string): boolean {
  return NATIVE_THREAD_ID.test(id);
}
