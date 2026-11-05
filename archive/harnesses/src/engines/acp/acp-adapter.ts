/**
 * Adaptador de motor sobre ACP (Etapa 12, D5).
 *
 * Toda a lógica de protocolo vive em `AcpAgentClient`; cada fornecedor é só
 * uma configuração (`AcpVendorConfig`): binário, argumentos para iniciar o
 * servidor ACP, manifesto e o driver legado usado para instalação/descoberta.
 *
 * - Conversa: um processo ACP residente por [motor, workspace] no
 *   ProcessRegistry (timeout ocioso D2), várias sessões por processo.
 * - One-shot: processo próprio por execução, encerrado ao final.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { opencorpHome } from "../../../utils/paths.js";
import type { AgentEvent } from "../events.js";
import type {
  AgentRunInput,
  AgentRunner,
  ConversationCreateInput,
  ConversationMessageInput,
  ConversationRef,
  ConversationRuntime,
  ConversationState,
  EngineAdapter,
  EngineAuthenticator,
  EngineAuthStatus,
  EngineInstaller,
  EngineInstallStatus,
} from "../ports.js";
import type { EngineDriver } from "../types.js";
import type { EngineCapabilityManifest } from "../manifests.js";
import { checkEngineAuthStatusAsync, probeCliLoginAsync } from "../credentials-bridge.js";
import { normalizeEngineError } from "../error-normalizer.js";
import { binaryOrPreflight } from "../installer/binary-resolver.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { formatProcessKey, ProcessRegistry } from "../../runtime/process-registry.js";
import { AcpAgentClient, type AcpSessionInfo } from "./acp-client.js";
import type { JsonRpcTransport } from "./json-rpc-connection.js";

const OPENCORP_VERSION = (createRequire(import.meta.url)("../../../../package.json") as { version: string }).version;

export interface AcpVendorConfig {
  engineId: string;
  name: string;
  /** Nome do executável para o registro de processos. */
  binaryName: string;
  /** Argumentos que colocam o CLI em modo servidor ACP via stdio. */
  acpArgs: string[];
  /**
   * Argumentos de modelo aplicados na inicialização do processo one-shot,
   * para agentes que não expõem seleção de modelo em `configOptions`.
   */
  launchModelArgs?: (model: string) => string[];
  manifest: EngineCapabilityManifest;
}

export interface AcpLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export type AcpLauncher = (opts: AcpLaunchOptions) => Promise<JsonRpcTransport & { pid: number }>;

export interface AcpAdapterOptions {
  vendor: AcpVendorConfig;
  driver: EngineDriver;
  homeDir?: string;
  processRegistry?: ProcessRegistry;
  launcher?: AcpLauncher;
  installStatusProbe?: (homeDir: string) => Promise<EngineInstallStatus>;
  authStatusProbe?: (homeDir: string) => Promise<EngineAuthStatus>;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

interface AcpSession {
  id: string;
  workspaceId: string;
  workspacePath: string;
  model?: string;
  updatedAt: string;
}

/** Lança o processo com stdio em pipes e respeita backpressure na escrita. */
export const spawnAcpProcess: AcpLauncher = async (opts) => {
  const child: ChildProcess = spawn(opts.command, opts.args, { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"] });
  const exitCode = new Promise<number>((resolve) => {
    child.once("close", (code) => resolve(code ?? 1));
    child.once("error", () => resolve(1));
  });
  // EPIPE ao escrever num processo morto não pode derrubar o OpenCorp.
  child.stdin?.on("error", () => {});
  return {
    pid: child.pid ?? 0,
    stdout: child.stdout!,
    stderr: child.stderr ?? undefined,
    write: (data) => (child.stdin && !child.stdin.destroyed ? child.stdin.write(data) : true),
    waitDrain: () => new Promise<void>((resolve) => {
      if (!child.stdin || child.stdin.destroyed) return resolve();
      child.stdin.once("drain", () => resolve());
      child.once("close", () => resolve());
    }),
    exitCode,
    kill: (signal: NodeJS.Signals = "SIGTERM") => { if (child.exitCode === null && !child.killed) child.kill(signal); },
  };
};

export class AcpAdapter implements EngineAdapter {
  readonly engineId: string;
  readonly name: string;
  readonly manifest: EngineCapabilityManifest;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner;
  readonly conversationRuntime: ConversationRuntime;

  private readonly vendor: AcpVendorConfig;
  private readonly homeDir: string;
  private readonly registry: ProcessRegistry;
  private readonly launcher: AcpLauncher;
  private readonly requestTimeoutMs?: number;
  private readonly approvalTimeoutMs?: number;
  private readonly clients = new Map<string, AcpAgentClient>();
  private readonly starting = new Map<string, Promise<AcpAgentClient>>();
  private readonly sessions = new Map<string, AcpSession>();

  constructor(options: AcpAdapterOptions) {
    this.vendor = options.vendor;
    this.engineId = options.vendor.engineId;
    this.name = options.vendor.name;
    this.manifest = options.vendor.manifest;
    this.homeDir = options.homeDir ?? opencorpHome();
    this.registry = options.processRegistry ?? ProcessRegistry.getInstance();
    this.launcher = options.launcher ?? spawnAcpProcess;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.approvalTimeoutMs = options.approvalTimeoutMs;
    const driver = options.driver;

    this.installer = {
      engineId: this.engineId,
      status: options.installStatusProbe ?? ((home) => driver.isInstalled(home)),
      install: (home, onProgress) => driver.install(home, onProgress),
    };
    this.authenticator = {
      engineId: this.engineId,
      status: options.authStatusProbe ?? ((home) => checkEngineAuthStatusAsync(this.engineId, home)),
      isLoggedIn: async (home) => (await probeCliLoginAsync(this.engineId, home))?.loggedIn,
      fetchTokens: (home, creds) => driver.fetchLiveTokens(home, creds),
    };
    this.runner = { engineId: this.engineId, run: (input, signal) => this.runOneShot(input, signal) };
    this.conversationRuntime = {
      engineId: this.engineId,
      create: (input) => this.createConversation(input),
      send: (ref, input, signal) => this.send(ref, input, signal),
      resume: (ref) => this.resume(ref),
      fork: (ref) => this.fork(ref),
      respondApproval: async (id, decision, scope) => this.clients.get(this.key(scope.workspaceId))?.respondApproval(id, decision) ?? false,
      close: (ref) => this.closeConversation(ref),
    };
  }

  private key(workspaceId: string): string {
    return formatProcessKey({ engineId: this.engineId, workspaceId });
  }

  private async launch(workspaceId: string, workspacePath: string, homeDir: string, extraArgs: string[] = [], accountId?: string) {
    const home = homeDir || this.homeDir;
    const command = this.launcher === spawnAcpProcess
      ? binaryOrPreflight(this.engineId, await this.installer.status(home))
      : this.vendor.binaryName;
    const env = await resolveEngineSpawnEnv(this.engineId, { homeDir: home, workspaceId, workspacePath, accountId });
    const transport = await this.launcher({ command, args: [...this.vendor.acpArgs, ...extraArgs], cwd: workspacePath, env });
    const client = new AcpAgentClient({
      engineId: this.engineId,
      transport,
      clientVersion: OPENCORP_VERSION,
      requestTimeoutMs: this.requestTimeoutMs,
      approvalTimeoutMs: this.approvalTimeoutMs,
    });
    try {
      await client.initialize();
    } catch (error) {
      client.close();
      throw error;
    }
    return { client, pid: transport.pid };
  }

  private getClient(workspaceId: string, workspacePath: string, homeDir: string): Promise<AcpAgentClient> {
    const key = this.key(workspaceId);
    const existing = this.clients.get(key);
    if (existing && !existing.isClosed && this.registry.get(key)) {
      this.registry.touch(key);
      return Promise.resolve(existing);
    }
    // Deduplica inicializações concorrentes (evita processo órfão).
    const pending = this.starting.get(key);
    if (pending) return pending;
    const promise = this.startClient(key, workspaceId, workspacePath, homeDir).finally(() => this.starting.delete(key));
    this.starting.set(key, promise);
    return promise;
  }

  private async startClient(key: string, workspaceId: string, workspacePath: string, homeDir: string): Promise<AcpAgentClient> {
    this.clients.get(key)?.close();
    this.clients.delete(key);
    const { client, pid } = await this.launch(workspaceId, workspacePath, homeDir);
    try {
      this.registry.register({
        key: { engineId: this.engineId, workspaceId },
        pid,
        cwd: workspacePath,
        transport: "stdio_jsonrpc",
        expectedExecutableName: this.vendor.binaryName,
        authVerified: true,
        initialRefCount: 0,
        metadata: { interface: "acp", agent: client.agentInfo?.name, agentVersion: client.agentInfo?.version },
      });
    } catch (error) {
      client.close();
      throw error;
    }
    this.clients.set(key, client);
    void client.connection.finished.then(() => {
      if (this.clients.get(key) === client) this.clients.delete(key);
      this.registry.forget(key, pid);
    });
    return client;
  }

  private async withActivity<T>(workspaceId: string, op: () => Promise<T>): Promise<T> {
    const key = { engineId: this.engineId, workspaceId };
    this.registry.acquire(key);
    try {
      return await op();
    } finally {
      this.registry.release(key);
    }
  }

  private async createConversation(input: ConversationCreateInput): Promise<ConversationRef> {
    const model = input.model && input.model !== "default" ? input.model : undefined;
    const known = input.conversationId ? this.sessions.get(input.conversationId) : undefined;
    if (known && known.workspaceId === input.workspaceId) {
      known.updatedAt = new Date().toISOString();
      return { id: known.id, engineId: this.engineId, workspaceId: known.workspaceId };
    }
    const client = await this.getClient(input.workspaceId, input.workspacePath, input.homeDir);
    const session = await this.withActivity(input.workspaceId, async () => {
      let info: AcpSessionInfo;
      if (input.conversationId && (client.supports("resume") || client.supports("load"))) {
        info = await client.reopenSession(input.conversationId, input.workspacePath);
      } else {
        info = await client.newSession(input.workspacePath);
      }
      await client.selectModel(info, model);
      return info;
    });
    this.sessions.set(session.sessionId, { id: session.sessionId, workspaceId: input.workspaceId, workspacePath: input.workspacePath, model, updatedAt: new Date().toISOString() });
    return { id: session.sessionId, engineId: this.engineId, workspaceId: input.workspaceId };
  }

  private async *send(ref: ConversationRef, input: ConversationMessageInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = `acp-run-${randomUUID()}`;
    const session = this.sessions.get(ref.id);
    if (!session || session.workspaceId !== ref.workspaceId) {
      yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: this.engineId };
      yield { type: "run.failed", runId, error: normalizeEngineError(new Error(`Sessão ACP não encontrada: ${ref.id}`), { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: this.engineId };
    let client: AcpAgentClient;
    try {
      client = await this.getClient(session.workspaceId, session.workspacePath, this.homeDir);
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }
    const key = { engineId: this.engineId, workspaceId: session.workspaceId };
    this.registry.acquire(key);
    try {
      for await (const event of client.runTurn(ref.id, input.text, signal, runId)) yield event;
      session.updatedAt = new Date().toISOString();
    } finally {
      this.registry.release(key);
    }
  }

  private async resume(ref: ConversationRef): Promise<ConversationState> {
    const session = this.sessions.get(ref.id);
    return {
      ref,
      status: session ? "active" : "closed",
      lastActiveAt: session?.updatedAt ?? new Date().toISOString(),
      metadata: session ? { nativeSessionId: session.id, model: session.model ?? "default" } : undefined,
    };
  }

  private async fork(ref: ConversationRef): Promise<ConversationRef> {
    const source = this.sessions.get(ref.id);
    if (!source) throw new Error(`Sessão ACP não encontrada: ${ref.id}`);
    const client = await this.getClient(source.workspaceId, source.workspacePath, this.homeDir);
    const forked = await this.withActivity(source.workspaceId, () => client.forkSession(source.id, source.workspacePath));
    this.sessions.set(forked.sessionId, { ...source, id: forked.sessionId, updatedAt: new Date().toISOString() });
    return { id: forked.sessionId, engineId: this.engineId, workspaceId: source.workspaceId };
  }

  /** Libera a sessão no agente (`session/close`, se anunciado) sem apagar histórico. */
  private async closeConversation(ref: ConversationRef): Promise<void> {
    const session = this.sessions.get(ref.id);
    this.sessions.delete(ref.id);
    if (!session) return;
    const client = this.clients.get(this.key(session.workspaceId));
    if (client && !client.isClosed) await client.closeSession(ref.id);
  }

  /** One-shot: processo ACP próprio, sessão nova, um turno, encerramento. */
  private async *runOneShot(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = input.runId || `acp-run-${randomUUID()}`;
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: this.engineId };
    const model = input.model && input.model !== "default" ? input.model : undefined;
    const launchModel = model && this.vendor.launchModelArgs ? this.vendor.launchModelArgs(model) : [];
    let client: AcpAgentClient | undefined;
    const timeout = input.timeoutMs && input.timeoutMs > 0 ? AbortSignal.timeout(input.timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    try {
      client = (await this.launch(input.workspaceId, input.workspacePath, input.homeDir, launchModel, input.accountId)).client;
      const session = await client.newSession(input.workspacePath);
      if (!launchModel.length) await client.selectModel(session, model);
      for await (const event of client.runTurn(session.sessionId, input.prompt, combined, runId)) {
        // Sem operador para responder: one-shot recusa aprovações (nunca aprova por omissão).
        if (event.type === "approval.requested") client.respondApproval(event.approval.id, "reject");
        if (event.type === "run.completed" && timeout?.aborted && !signal?.aborted) {
          yield { ...event, result: { ...event.result, stopReason: "timeout" } };
          continue;
        }
        yield event;
      }
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId, modelId: input.model }), timestamp: new Date().toISOString() };
    } finally {
      client?.close();
    }
  }

  /** Diagnóstico e testes: nunca expõe dados sensíveis. */
  public getSessionMeta(sessionId: string): { workspaceId: string; model?: string } | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { workspaceId: s.workspaceId, model: s.model } : undefined;
  }
}
