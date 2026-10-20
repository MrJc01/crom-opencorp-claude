/**
 * Adaptador do Open Harness (openheinerss): binário Go que fala JSON-RPC 2.0 por STDIO e orquestra
 * harnesses (claude-code, opencode, codex, agy, aider, mock) por baixo.
 *
 * - O `model` do núcleo escolhe harness e modelo: `claude-code:claude-sonnet-5-5`, `mock`, ... (ver `parseOpenheinerssModel`).
 * - Conversa: um `openheinerss serve --stdio` residente por [motor, workspace] no ProcessRegistry (timeout ocioso D2);
 *   várias sessões por processo, retomadas por `session.resume`.
 * - One-shot: processo próprio, uma sessão, um turno, encerramento.
 * - Instalação ausente = `installed:false` (motor indisponível); nada do resto do sistema depende do binário.
 */
import { randomUUID } from "node:crypto";
import { opencorpHome } from "../../../utils/paths.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { formatProcessKey, ProcessRegistry } from "../../runtime/process-registry.js";
import { spawnAcpProcess, type AcpLauncher } from "../acp/acp-adapter.js";
import {
  OPENHEINERSS_ENGINE_ID,
  OPENHEINERSS_HARNESSES,
  openheinerssInstallStatus,
  parseOpenheinerssModel,
} from "../drivers/openheinerss-driver.js";
import { normalizeEngineError } from "../error-normalizer.js";
import type { AgentEvent } from "../events.js";
import type { EngineCapabilityManifest } from "../manifests.js";
import { binaryOrPreflight } from "../installer/binary-resolver.js";
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
  EngineInstaller,
  ModelCatalogSource,
  ModelDescriptor,
} from "../ports.js";
import type { EngineInstallStatus } from "../types.js";
import { OpenheinerssClient } from "./openheinerss-client.js";

export { OPENHEINERSS_ENGINE_ID };

export const OPENHEINERSS_MANIFEST: EngineCapabilityManifest = {
  engineId: OPENHEINERSS_ENGINE_ID,
  name: "Open Harness (openheinerss)",
  transport: "stdio_jsonrpc",
  supportsConversation: true,
  limits: { tetoMs: 1_800_000, inatividadeMs: 300_000 },
  instructionFiles: ["CLAUDE.md", "AGENTS.md"],
  toolPolicyModes: ["ask", "allow-all"],
  emits: ["artifact.produced", "session.updated", "approval.resolved"],
  details: {
    protocol: "jsonrpc-2.0-ndjson",
    command: "openheinerss serve --stdio",
    harnesses: [...OPENHEINERSS_HARNESSES],
    modelFormat: "<harness>[:<modelo>]",
  },
  features: {
    streaming: { level: "integrated", notes: "agent.text por delta" },
    continuation: { level: "integrated", flags: ["session.resume"], notes: "Sessões gravadas em .openheinerss/sessions; retomada pelo id da sessão" },
    fork: { level: "unsupported" },
    hitl: { level: "integrated", notes: "agent.permission_request ↔ session.permission_respond (só claude-code e mock pedem)" },
    tools: { level: "integrated", notes: "agent.tool_call/tool_result" },
    mcp: { level: "declared", notes: "mcp.json é entregue pelo próprio openheinerss" },
    images: { level: "declared", notes: "session.prompt aceita images; não ligado ao núcleo" },
    cancellation: { level: "integrated", notes: "session.abort; fecha o processo no timeout" },
  },
};

export interface OpenheinerssAdapterOptions {
  homeDir?: string;
  /** Caminho explícito do binário (padrão: OPENHEINERSS_BIN, caminho local do PC, PATH). */
  binPath?: string;
  processRegistry?: ProcessRegistry;
  /** Lançador do processo; testes injetam um servidor falso. */
  launcher?: AcpLauncher;
  installStatusProbe?: (homeDir: string) => Promise<EngineInstallStatus>;
  requestTimeoutMs?: number;
  approvalTimeoutMs?: number;
}

interface HarnessSession {
  id: string;
  workspaceId: string;
  workspacePath: string;
  model: string;
  updatedAt: string;
  active: boolean;
}

export class OpenheinerssAdapter implements EngineAdapter {
  readonly engineId = OPENHEINERSS_ENGINE_ID;
  readonly name = OPENHEINERSS_MANIFEST.name;
  readonly manifest = OPENHEINERSS_MANIFEST;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner;
  readonly conversationRuntime: ConversationRuntime;
  readonly modelCatalog: ModelCatalogSource;

  private readonly homeDir: string;
  private readonly registry: ProcessRegistry;
  private readonly launcher: AcpLauncher;
  private readonly installProbe: (homeDir: string) => Promise<EngineInstallStatus>;
  private readonly requestTimeoutMs?: number;
  private readonly approvalTimeoutMs?: number;
  private readonly clients = new Map<string, OpenheinerssClient>();
  private readonly starting = new Map<string, Promise<OpenheinerssClient>>();
  private readonly sessions = new Map<string, HarnessSession>();

  constructor(options: OpenheinerssAdapterOptions = {}) {
    this.homeDir = options.homeDir ?? opencorpHome();
    this.registry = options.processRegistry ?? ProcessRegistry.getInstance();
    this.launcher = options.launcher ?? spawnAcpProcess;
    this.installProbe = options.installStatusProbe ?? (() => openheinerssInstallStatus(options.binPath));
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.approvalTimeoutMs = options.approvalTimeoutMs;

    this.installer = {
      engineId: this.engineId,
      status: (home) => this.installProbe(home),
      // O binário é compilado a partir do repositório openheinerss; o OpenCorp não o instala.
      install: async (home) => {
        const status = await this.installProbe(home);
        return {
          success: status.installed,
          path: status.path ?? "",
          version: status.version ?? "",
          log: status.installed ? "openheinerss já disponível" : status.details ?? "binário do openheinerss ausente",
        };
      },
    };
    this.authenticator = {
      engineId: this.engineId,
      // O openheinerss não tem login próprio: cada harness usa a sessão dele (claude, codex...).
      status: async (home) => {
        const status = await this.installProbe(home);
        return status.installed
          ? { authenticated: true, method: "delegado ao harness", details: "login pertence ao harness escolhido (claude-code, codex...)" }
          : { authenticated: false, method: "delegado ao harness", details: status.details };
      },
    };
    this.runner = { engineId: this.engineId, run: (input, signal) => this.runOneShot(input, signal) };
    this.conversationRuntime = {
      engineId: this.engineId,
      create: (input) => this.createConversation(input),
      send: (ref, input, signal) => this.send(ref, input, signal),
      resume: (ref) => this.resume(ref),
      respondApproval: async (id, decision, scope) =>
        this.clients.get(this.key(scope.workspaceId))?.respondApproval(id, decision, scope.workspaceId) ?? false,
      close: (ref) => this.closeConversation(ref),
    };
    this.modelCatalog = {
      engineId: this.engineId,
      listModels: async (): Promise<ModelDescriptor[]> =>
        OPENHEINERSS_HARNESSES.map((h) => ({ id: h, name: `Open Harness · ${h}`, provider: "openheinerss", isFree: h === "mock" })),
    };
  }

  private key(workspaceId: string): string {
    return formatProcessKey({ engineId: this.engineId, workspaceId });
  }

  private async launch(workspaceId: string, workspacePath: string, homeDir: string, accountId?: string) {
    const home = homeDir || this.homeDir;
    const command = this.launcher === spawnAcpProcess
      ? binaryOrPreflight(this.engineId, await this.installProbe(home))
      : "openheinerss";
    let env: Record<string, string>;
    try {
      env = await resolveEngineSpawnEnv(this.engineId, { homeDir: home, workspaceId, workspacePath, accountId });
    } catch {
      env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"));
    }
    const transport = await this.launcher({ command, args: ["serve", "--stdio"], cwd: workspacePath, env });
    const client = new OpenheinerssClient({
      engineId: this.engineId,
      workspaceId,
      transport,
      requestTimeoutMs: this.requestTimeoutMs,
      approvalTimeoutMs: this.approvalTimeoutMs,
    });
    return { client, pid: transport.pid };
  }

  private getClient(workspaceId: string, workspacePath: string, homeDir: string): Promise<OpenheinerssClient> {
    const key = this.key(workspaceId);
    const existing = this.clients.get(key);
    if (existing && !existing.isClosed && this.registry.get(key)) {
      this.registry.touch(key);
      return Promise.resolve(existing);
    }
    const pending = this.starting.get(key);
    if (pending) return pending;
    const promise = this.startClient(key, workspaceId, workspacePath, homeDir).finally(() => this.starting.delete(key));
    this.starting.set(key, promise);
    return promise;
  }

  private async startClient(key: string, workspaceId: string, workspacePath: string, homeDir: string): Promise<OpenheinerssClient> {
    this.clients.get(key)?.close();
    this.clients.delete(key);
    const { client, pid } = await this.launch(workspaceId, workspacePath, homeDir);
    try {
      this.registry.register({
        key: { engineId: this.engineId, workspaceId },
        pid,
        cwd: workspacePath,
        transport: "stdio_jsonrpc",
        expectedExecutableName: "openheinerss",
        authVerified: true,
        initialRefCount: 0,
        metadata: { interface: "openheinerss-jsonrpc" },
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
    const known = input.conversationId ? this.sessions.get(input.conversationId) : undefined;
    if (known && known.workspaceId === input.workspaceId) {
      known.updatedAt = new Date().toISOString();
      return { id: known.id, engineId: this.engineId, workspaceId: known.workspaceId };
    }
    const client = await this.getClient(input.workspaceId, input.workspacePath, input.homeDir);
    const { harness, model } = parseOpenheinerssModel(input.model);
    const info = await this.withActivity(input.workspaceId, async () => {
      if (input.conversationId) return client.resumeSession(input.conversationId, input.workspacePath);
      return client.createSession({ harness, model, cwd: input.workspacePath, permissionMode: "ask" });
    });
    this.sessions.set(info.sessionId, {
      id: info.sessionId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      model: input.model,
      updatedAt: new Date().toISOString(),
      active: false,
    });
    return { id: info.sessionId, engineId: this.engineId, workspaceId: input.workspaceId };
  }

  private async *send(ref: ConversationRef, input: ConversationMessageInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = `ohs-run-${randomUUID()}`;
    const now = () => new Date().toISOString();
    yield { type: "run.started", runId, timestamp: now(), engineId: this.engineId };
    const session = this.sessions.get(ref.id);
    if (!session || session.workspaceId !== ref.workspaceId) {
      yield { type: "run.failed", runId, error: normalizeEngineError(new Error(`Sessão openheinerss não encontrada: ${ref.id}`), { engineId: this.engineId }), timestamp: now() };
      return;
    }
    let client: OpenheinerssClient;
    try {
      client = await this.getClient(session.workspaceId, session.workspacePath, this.homeDir);
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId }), timestamp: now() };
      return;
    }
    const key = { engineId: this.engineId, workspaceId: session.workspaceId };
    this.registry.acquire(key);
    session.active = true;
    try {
      for await (const event of client.runTurn(ref.id, input.text, runId, signal)) yield event;
      session.updatedAt = now();
    } finally {
      session.active = false;
      this.registry.release(key);
    }
  }

  private async resume(ref: ConversationRef): Promise<ConversationState> {
    const session = this.sessions.get(ref.id);
    return {
      ref,
      status: session ? (session.active ? "active" : "idle") : "closed",
      lastActiveAt: session?.updatedAt ?? new Date().toISOString(),
      metadata: session ? { nativeSessionId: session.id, model: session.model } : undefined,
    };
  }

  private async closeConversation(ref: ConversationRef): Promise<void> {
    const session = this.sessions.get(ref.id);
    this.sessions.delete(ref.id);
    if (!session) return;
    const client = this.clients.get(this.key(session.workspaceId));
    if (client && !client.isClosed && session.active) await client.abort(ref.id);
  }

  /** One-shot: processo próprio, sessão nova, um turno, encerramento. Aprovações sem canal de resposta são negadas. */
  private async *runOneShot(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = input.runId || `ohs-run-${randomUUID()}`;
    const now = () => new Date().toISOString();
    yield { type: "run.started", runId, timestamp: now(), engineId: this.engineId };
    const timeout = input.timeoutMs && input.timeoutMs > 0 ? AbortSignal.timeout(input.timeoutMs) : undefined;
    const combined = signal && timeout ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
    let client: OpenheinerssClient | undefined;
    try {
      client = (await this.launch(input.workspaceId, input.workspacePath, input.homeDir, input.accountId)).client;
      const { harness, model } = parseOpenheinerssModel(input.model);
      const permissionMode = input.toolPolicy?.mode === "allow-all" ? "always_allow" : "ask";
      const info = input.resumeSessionId
        ? await client.resumeSession(input.resumeSessionId, input.workspacePath)
        : await client.createSession({ harness, model, cwd: input.workspacePath, permissionMode, systemPrompt: input.systemPromptAppend });
      yield { type: "session.updated", runId, nativeSessionId: info.sessionId, resumed: !!input.resumeSessionId, timestamp: now() };
      for await (const event of client.runTurn(info.sessionId, input.prompt, runId, combined)) {
        yield event;
        if (event.type === "approval.requested") await client.respondApproval(event.approval.id, "reject", input.workspaceId);
      }
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId }), timestamp: now() };
    } finally {
      client?.close();
    }
  }
}
