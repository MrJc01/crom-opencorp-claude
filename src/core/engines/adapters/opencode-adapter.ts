import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { binaryOrPreflight } from "../installer/binary-resolver.js";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { join, dirname } from "node:path";
import { opencorpHome } from "../../../utils/paths.js";
import { checkEngineAuthStatusAsync } from "../credentials-bridge.js";
import { envOpencodeIsolado } from "../../contexts/execution/opencode-server.js";
import { CANONICAL_ENGINE_MANIFESTS, type EngineCapabilityManifest } from "../manifests.js";
import { formatProcessKey, ProcessRegistry } from "../../runtime/process-registry.js";
import { normalizeEngineError } from "../error-normalizer.js";
import { OpencodeDriver } from "../drivers/opencode-driver.js";
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
  EngineInstallResult,
  EngineInstallStatus,
  ModelCatalogSource,
  ModelDescriptor,
} from "../ports.js";

async function buscarPortaLivreLoopback(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close(() => {
        if (addr && typeof addr === "object") resolve(addr.port);
        else reject(new Error("Não foi possível obter porta livre em loopback"));
      });
    });
    server.on("error", reject);
  });
}

async function aguardarPortaPronta(port: number, timeoutMs = 25000): Promise<boolean> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok || res.status === 401 || res.status === 404) {
        return true;
      }
    } catch {
      // continua tentando até o timeout
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export interface OpenCodeAdapterOptions {
  homeDir?: string;
  binPath?: string;
  driver?: OpencodeDriver;
  processRegistry?: ProcessRegistry;
  customServerLauncher?: (opts: {
    port: number;
    authToken: string;
    workspaceDir: string;
    workspaceId: string;
  }) => Promise<{ pid: number; unref?: () => void; close?: () => Promise<void> }>;
}

interface OpenCodeServerHandle {
  pid: number;
  port: number;
  password: string;
  workspacePath: string;
  baseUrl: string;
}

interface OpenCodeSessionMeta {
  workspaceId: string;
  workspacePath: string;
  model?: { providerID: string; modelID: string };
}

export class OpenCodeAdapter implements EngineAdapter {
  readonly engineId = "opencode";
  readonly name = "OpenCode Engine";
  readonly manifest: EngineCapabilityManifest;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner;
  readonly conversationRuntime: ConversationRuntime;
  readonly modelCatalog?: ModelCatalogSource;

  private readonly homeDir: string;
  private readonly binPath: string;
  private readonly driver: OpencodeDriver;
  private readonly processRegistry: ProcessRegistry;
  private readonly customServerLauncher?: OpenCodeAdapterOptions["customServerLauncher"];
  private readonly servers = new Map<string, OpenCodeServerHandle>();
  private readonly startingServers = new Map<string, Promise<OpenCodeServerHandle>>();
  private readonly sessions = new Map<string, OpenCodeSessionMeta>();
  private readonly pendingPermissions = new Map<string, { workspaceId: string; sessionId: string }>();

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.homeDir = options.homeDir ?? opencorpHome();
    this.driver = options.driver ?? new OpencodeDriver();
    this.binPath = options.binPath ?? "opencode";
    this.processRegistry = options.processRegistry ?? ProcessRegistry.getInstance();
    this.customServerLauncher = options.customServerLauncher;
    this.manifest = CANONICAL_ENGINE_MANIFESTS["opencode"] ?? {
      engineId: "opencode",
      name: "OpenCode Engine",
      transport: "http_server",
      supportsConversation: true,
      features: {
        streaming: { level: "integrated" },
        continuation: { level: "integrated" },
        fork: { level: "integrated" },
        hitl: { level: "integrated" },
        tools: { level: "integrated" },
        mcp: { level: "integrated" },
        images: { level: "integrated" },
        cancellation: { level: "integrated" },
      },
    };

    // 1. Porta do Instalador
    this.installer = {
      engineId: this.engineId,
      status: async (home: string): Promise<EngineInstallStatus> => {
        return this.driver.isInstalled(home);
      },
      install: async (home: string, onProgress?: (msg: string) => void): Promise<EngineInstallResult> => {
        return this.driver.install(home, onProgress);
      },
    };

    // 2. Porta do Autenticador
    this.authenticator = {
      engineId: this.engineId,
      status: async (home: string): Promise<EngineAuthStatus> => {
        return checkEngineAuthStatusAsync(this.engineId, home);
      },
      // OpenCode usa chaves de provedor do OpenCorp; não há sessão OAuth nativa a verificar.
      isLoggedIn: async () => undefined,
      fetchTokens: async (home: string, creds?: { tokenOuChave?: string; authType?: string }) => {
        return this.driver.fetchLiveTokens(home, creds);
      },
    };

    // 3. Porta do Runner One-Shot (CLI estruturado)
    this.runner = {
      engineId: this.engineId,
      run: (input: AgentRunInput, signal?: AbortSignal) => this.executeOneShot(input, signal),
    };

    // 4. Porta do Runtime Conversacional (Sessões HTTP isoladas)
    this.conversationRuntime = {
      engineId: this.engineId,
      create: (input: ConversationCreateInput) => this.createConversation(input),
      send: (ref: ConversationRef, input: ConversationMessageInput, signal?: AbortSignal) =>
        this.sendConversationMessage(ref, input, signal),
      resume: (ref: ConversationRef) => this.resumeConversation(ref),
      fork: (ref: ConversationRef) => this.forkConversation(ref),
      respondApproval: (approvalId, decision, scope) => this.respondApproval(approvalId, decision, scope),
      close: (ref: ConversationRef) => this.closeConversation(ref),
    };

    // 5. Catálogo de Modelos
    this.modelCatalog = {
      engineId: this.engineId,
      listModels: async (): Promise<ModelDescriptor[]> => {
        return [
          {
            id: "opencode/nemotron-3-ultra-free",
            name: "Nemotron 3 Ultra (Gratuito)",
            provider: "opencode",
            contextWindow: 128000,
            isFree: true,
          },
          {
            id: "opencode/nemotron-3.5-lightning-free",
            name: "Nemotron 3.5 Lightning (Gratuito)",
            provider: "opencode",
            contextWindow: 128000,
            isFree: true,
          },
          {
            id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
            name: "Nemotron Ultra 550B (OpenRouter)",
            provider: "openrouter",
            contextWindow: 128000,
            isFree: true,
          },
        ];
      },
    };
  }

  /**
   * Executa tarefa one-shot via CLI estruturado do OpenCode
   */
  private async *executeOneShot(input: AgentRunInput, externalSignal?: AbortSignal): AsyncIterable<AgentEvent> {
    let bin: string;
    try {
      bin = this.binPath || binaryOrPreflight(this.engineId, await this.installer.status(this.homeDir));
    } catch (error) {
      yield { type: "run.failed", runId: input.runId || `run-${Date.now()}`, error: normalizeEngineError(error, { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }
    const args: string[] = ["run", "--format", "json"];

    if (input.model) {
      args.push("--model", input.model);
    }
    if (input.workspacePath) {
      args.push("--dir", input.workspacePath);
    }
    if (input.sessionId) {
      args.push("--session", input.sessionId);
    }
    args.push(input.prompt);

    const env = await resolveEngineSpawnEnv(
      this.engineId,
      { homeDir: this.homeDir, workspaceId: input.workspaceId, workspacePath: input.workspacePath, accountId: input.accountId },
      { ...(input.envOverrides || {}) },
      envOpencodeIsolado(this.homeDir, input.workspaceId, input.workspacePath)
    );

    const runId = input.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const timestamp = new Date().toISOString();

    yield {
      type: "run.started",
      runId,
      timestamp,
      engineId: this.engineId,
    };

    let child: ChildProcess | null = null;
    let timedOut = false;
    let aborted = false;

    try {
      child = spawn(bin, args, {
        cwd: input.workspacePath,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const normErr = normalizeEngineError(err, { engineId: this.engineId, modelId: input.model });
      yield {
        type: "run.failed",
        runId,
        error: normErr,
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const pid = child.pid ?? 0;

    const exitPromise = new Promise<void>((resolve, reject) => {
      if (!child) return resolve();
      child.on("close", (code) => {
        if (code === 0 || code === null) resolve();
        else reject(new Error(`Processo opencode finalizou com código ${code}`));
      });
      child.on("error", reject);
    });

    // Timeout e watchdog
    let timeoutTimer: NodeJS.Timeout | null = null;
    if (input.timeoutMs && input.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        if (child && !child.killed && pid > 0) {
          try {
            process.kill(pid, "SIGTERM");
            setTimeout(() => {
              try {
                if (child && !child.killed) process.kill(pid, "SIGKILL");
              } catch {}
            }, 5000);
          } catch {}
        }
      }, input.timeoutMs);
    }

    // Cancelamento
    const onAbort = () => {
      aborted = true;
      if (child && !child.killed && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
          setTimeout(() => {
            try {
              if (child && !child.killed) process.kill(pid, "SIGKILL");
            } catch {}
          }, 5000);
        } catch {}
      }
    };

    const activeSignal = externalSignal;
    if (activeSignal) {
      if (activeSignal.aborted) {
        onAbort();
      } else {
        activeSignal.addEventListener("abort", onAbort, { once: true });
      }
    }

    let buffer = "";
    let fullOutput = "";
    let protocolError: string | undefined;

    try {
      if (child.stdout) {
        for await (const chunk of child.stdout) {
          const text = chunk.toString("utf8");
          buffer += text;

          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // `opencode run --format json`: um evento por linha {type, sessionID, part|error}.
            let parsed: OpenCodeRunEvent | undefined;
            try {
              parsed = JSON.parse(trimmed) as OpenCodeRunEvent;
            } catch {
              parsed = undefined;
            }
            if (!parsed || typeof parsed.type !== "string") continue;
            const mapped = mapOpenCodeRunEvent(parsed, runId);
            if (mapped.text) fullOutput += mapped.text;
            if (mapped.error) protocolError = mapped.error;
            for (const ev of mapped.events) yield ev;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const mapped = mapOpenCodeRunEvent(JSON.parse(buffer.trim()) as OpenCodeRunEvent, runId);
          if (mapped.text) fullOutput += mapped.text;
          if (mapped.error) protocolError = mapped.error;
          for (const ev of mapped.events) yield ev;
        } catch {
          // linha final incompleta: ignorada
        }
      }

      await exitPromise;
      if (protocolError && !aborted && !timedOut) throw new Error(protocolError);

      yield {
        type: "run.completed",
        runId,
        result: {
          output: fullOutput,
          stopReason: "completed",
        },
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (!aborted && !timedOut) {
        const norm = normalizeEngineError(err, { engineId: this.engineId, modelId: input.model });
        yield {
          type: "run.failed",
          runId,
          error: norm,
          timestamp: new Date().toISOString(),
        };
      } else if (aborted) {
        yield {
          type: "run.completed",
          runId,
          result: {
            output: fullOutput,
            stopReason: "cancelled",
          },
          timestamp: new Date().toISOString(),
        };
      } else if (timedOut) {
        yield {
          type: "run.completed",
          runId,
          result: {
            output: fullOutput,
            stopReason: "timeout",
          },
          timestamp: new Date().toISOString(),
        };
      }
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (activeSignal) {
        activeSignal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * Servidor `opencode serve` do workspace, iniciado sob demanda (D2). A senha
   * HTTP Basic fica só em memória — nunca no ProcessRegistry nem em disco.
   */
  private async ensureServer(workspaceId: string, workspacePath: string): Promise<OpenCodeServerHandle> {
    const key = formatProcessKey({ engineId: this.engineId, workspaceId });
    const existing = this.servers.get(key);
    const record = this.processRegistry.get(key);
    if (existing && record && record.pid === existing.pid) {
      this.processRegistry.touch(key);
      return existing;
    }
    const starting = this.startingServers.get(key);
    if (starting) return starting;
    const promise = this.startServer(key, workspaceId, workspacePath).finally(() => this.startingServers.delete(key));
    this.startingServers.set(key, promise);
    return promise;
  }

  private async startServer(key: string, workspaceId: string, workspacePath: string): Promise<OpenCodeServerHandle> {
    // Registro sem credencial conhecida (ex.: após reinício do OpenCorp) não pode
    // ser usado com segurança: é encerrado antes de iniciar um novo.
    const stale = this.processRegistry.get(key);
    if (stale) await this.processRegistry.terminate(stale.key, "credencial_desconhecida");
    this.servers.delete(key);

    const port = await buscarPortaLivreLoopback();
    const password = randomUUID();
    let pid: number;
    if (this.customServerLauncher) {
      const custom = await this.customServerLauncher({ port, authToken: password, workspaceDir: workspacePath, workspaceId });
      pid = custom.pid;
    } else {
      const bin = this.binPath || binaryOrPreflight(this.engineId, await this.installer.status(this.homeDir));
      const logPath = join(this.homeDir, "logs", `opencode-${workspaceId}.log`);
      if (!existsSync(dirname(logPath))) mkdirSync(dirname(logPath), { recursive: true });
      const env = await resolveEngineSpawnEnv(
        this.engineId,
        { homeDir: this.homeDir, workspaceId, workspacePath },
        { OPENCODE_SERVER_USERNAME: OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_PASSWORD: password },
        envOpencodeIsolado(this.homeDir, workspaceId, workspacePath)
      );
      const child = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        cwd: workspacePath,
        env,
        detached: true,
        stdio: ["ignore", openSync(logPath, "a"), openSync(logPath, "a")],
      } satisfies SpawnOptions);
      pid = child.pid ?? 0;
      child.unref();
      if (!(await aguardarPortaPronta(port, 15000))) {
        try { if (pid > 0) process.kill(pid, "SIGKILL"); } catch {}
        throw new Error(`OpenCode server não iniciou na porta ${port} para o workspace ${workspaceId}`);
      }
    }
    this.processRegistry.register({
      key: { engineId: this.engineId, workspaceId },
      pid,
      cwd: workspacePath,
      transport: "http_server",
      port,
      expectedExecutableName: "opencode",
      authVerified: true,
      initialRefCount: 0,
      metadata: { port, workspaceDir: workspacePath },
    });
    const handle: OpenCodeServerHandle = { pid, port, password, workspacePath, baseUrl: `http://127.0.0.1:${port}` };
    this.servers.set(key, handle);
    return handle;
  }

  private headers(handle: OpenCodeServerHandle, json = false): Record<string, string> {
    return { ...(json ? { "Content-Type": "application/json" } : {}), ...openCodeServerAuthHeader(handle.password) };
  }

  private async withActivity<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const key = { engineId: this.engineId, workspaceId };
    this.processRegistry.acquire(key);
    try {
      return await operation();
    } finally {
      this.processRegistry.release(key);
    }
  }

  /**
   * Cria uma sessão ou retoma uma existente (`conversationId` nativo `ses_…`).
   * Não mantém referência no ProcessRegistry: cada operação adquire e libera,
   * para que o timeout ocioso (D2) funcione entre mensagens.
   */
  private async createConversation(input: ConversationCreateInput): Promise<ConversationRef> {
    const handle = await this.ensureServer(input.workspaceId, input.workspacePath);
    const model = parseOpenCodeModel(input.model);
    const id = await this.withActivity(input.workspaceId, async () => {
      if (input.conversationId && input.conversationId.startsWith("ses")) {
        const res = await fetch(`${handle.baseUrl}/session/${encodeURIComponent(input.conversationId)}`, {
          headers: this.headers(handle),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) return input.conversationId;
        if (res.status !== 404) throw new Error(`Falha ao consultar sessão OpenCode: HTTP ${res.status}`);
      }
      const res = await fetch(`${handle.baseUrl}/session`, {
        method: "POST",
        headers: this.headers(handle, true),
        body: JSON.stringify({ title: input.title || "Nova conversa" }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Falha ao criar sessão no servidor OpenCode: HTTP ${res.status}`);
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("O servidor OpenCode não retornou o ID da sessão");
      return data.id;
    });
    this.sessions.set(id, { workspaceId: input.workspaceId, workspacePath: input.workspacePath, model });
    return { id, engineId: this.engineId, workspaceId: input.workspaceId };
  }

  /**
   * Envia uma mensagem com streaming real: assina `GET /event` (SSE) antes de
   * `POST /session/:id/prompt_async` e traduz os eventos da sessão até
   * `session.idle`. Contrato conferido na OpenAPI do opencode 1.18.32.
   */
  private async *sendConversationMessage(
    ref: ConversationRef,
    input: ConversationMessageInput,
    signal?: AbortSignal
  ): AsyncIterable<AgentEvent> {
    const runId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: this.engineId };
    const session = this.sessions.get(ref.id);
    if (!session || session.workspaceId !== ref.workspaceId) {
      yield { type: "run.failed", runId, error: normalizeEngineError(new Error(`Sessão OpenCode não encontrada: ${ref.id}`), { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }

    let handle: OpenCodeServerHandle;
    try {
      handle = await this.ensureServer(session.workspaceId, session.workspacePath);
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }

    const processKey = { engineId: this.engineId, workspaceId: session.workspaceId };
    this.processRegistry.acquire(processKey);
    const sse = new AbortController();
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void fetch(`${handle.baseUrl}/session/${encodeURIComponent(ref.id)}/abort`, { method: "POST", headers: this.headers(handle) }).catch(() => {});
      // Encerra a espera caso o servidor não emita `session.idle`.
      setTimeout(() => sse.abort(), 5000).unref?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const state = new OpenCodeTurnState(ref.id, runId);
    try {
      const events = await fetch(`${handle.baseUrl}/event`, { headers: { ...this.headers(handle), Accept: "text/event-stream" }, signal: sse.signal });
      if (!events.ok || !events.body) throw new Error(`Falha ao assinar eventos do OpenCode: HTTP ${events.status}`);

      const prompt = await fetch(`${handle.baseUrl}/session/${encodeURIComponent(ref.id)}/prompt_async`, {
        method: "POST",
        headers: this.headers(handle, true),
        body: JSON.stringify({ parts: [{ type: "text", text: input.text }], ...(session.model ? { model: session.model } : {}) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!prompt.ok) {
        const detail = await prompt.text().catch(() => "");
        throw new Error(`Servidor OpenCode recusou a mensagem: HTTP ${prompt.status} ${detail.slice(0, 200)}`);
      }
      if (signal?.aborted) onAbort();

      for await (const event of readServerSentEvents(events.body)) {
        for (const out of state.accept(event)) {
          if (out.type === "approval.requested") this.pendingPermissions.set(out.approval.id, { workspaceId: session.workspaceId, sessionId: ref.id });
          yield out;
        }
        if (state.idle) break;
      }
    } catch (error) {
      if (!aborted) {
        yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: this.engineId, modelId: session.model?.modelID }), timestamp: new Date().toISOString() };
        return;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      sse.abort();
      for (const [id, p] of this.pendingPermissions) if (p.sessionId === ref.id) this.pendingPermissions.delete(id);
      this.processRegistry.release(processKey);
    }

    if (state.error && !aborted) {
      yield { type: "run.failed", runId, error: normalizeEngineError(new Error(state.error), { engineId: this.engineId, modelId: session.model?.modelID }), timestamp: new Date().toISOString() };
      return;
    }
    if (state.usage) yield { type: "usage.updated", runId, usage: state.usage, timestamp: new Date().toISOString() };
    yield {
      type: "run.completed",
      runId,
      result: { output: state.output, stopReason: aborted ? "cancelled" : "completed" },
      timestamp: new Date().toISOString(),
    };
  }

  private async respondApproval(approvalId: string, decision: "approve" | "reject", scope: { workspaceId: string }): Promise<boolean> {
    const pending = this.pendingPermissions.get(approvalId);
    if (!pending || pending.workspaceId !== scope.workspaceId) return false;
    const handle = this.servers.get(formatProcessKey({ engineId: this.engineId, workspaceId: scope.workspaceId }));
    if (!handle) return false;
    const res = await fetch(`${handle.baseUrl}/session/${encodeURIComponent(pending.sessionId)}/permissions/${encodeURIComponent(approvalId)}`, {
      method: "POST",
      headers: this.headers(handle, true),
      body: JSON.stringify({ response: decision === "approve" ? "once" : "reject" }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return false;
    this.pendingPermissions.delete(approvalId);
    return true;
  }

  private async resumeConversation(ref: ConversationRef): Promise<ConversationState> {
    const session = this.sessions.get(ref.id);
    const handle = session ? this.servers.get(formatProcessKey({ engineId: this.engineId, workspaceId: session.workspaceId })) : undefined;
    if (!session || !handle) return { ref, status: "closed", lastActiveAt: new Date().toISOString() };
    try {
      const res = await fetch(`${handle.baseUrl}/session/${encodeURIComponent(ref.id)}`, { headers: this.headers(handle), signal: AbortSignal.timeout(5000) });
      return {
        ref,
        status: res.ok ? "idle" : "closed",
        lastActiveAt: new Date().toISOString(),
        metadata: { nativeSessionId: ref.id, port: handle.port, workspaceDir: session.workspacePath },
      };
    } catch {
      return { ref, status: "error", lastActiveAt: new Date().toISOString() };
    }
  }

  private async forkConversation(ref: ConversationRef): Promise<ConversationRef> {
    const session = this.sessions.get(ref.id);
    if (!session) throw new Error(`Sessão OpenCode não encontrada: ${ref.id}`);
    const handle = await this.ensureServer(session.workspaceId, session.workspacePath);
    const forkedId = await this.withActivity(session.workspaceId, async () => {
      const res = await fetch(`${handle.baseUrl}/session/${encodeURIComponent(ref.id)}/fork`, {
        method: "POST",
        headers: this.headers(handle, true),
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`Falha ao bifurcar sessão ${ref.id} no OpenCode: HTTP ${res.status}`);
      const data = (await res.json()) as { id?: string };
      if (!data.id) throw new Error("O servidor OpenCode não retornou o ID do fork");
      return data.id;
    });
    this.sessions.set(forkedId, { ...session });
    return { id: forkedId, engineId: this.engineId, workspaceId: session.workspaceId };
  }

  /**
   * Libera a referência local. O histórico da sessão no OpenCode é preservado:
   * fechar uma conversa no OpenCorp nunca apaga dados do motor.
   */
  private async closeConversation(ref: ConversationRef): Promise<void> {
    this.sessions.delete(ref.id);
  }

  /** Inspeção para testes e diagnóstico; nunca expõe a senha do servidor. */
  public getSessionMeta(sessionId: string): { port: number; workspaceDir: string; url: string } | undefined {
    const session = this.sessions.get(sessionId);
    const handle = session ? this.servers.get(formatProcessKey({ engineId: this.engineId, workspaceId: session.workspaceId })) : undefined;
    return handle && session ? { port: handle.port, workspaceDir: session.workspacePath, url: handle.baseUrl } : undefined;
  }
}

/**
 * O `opencode serve` protege a API com HTTP Basic quando recebe
 * `OPENCODE_SERVER_PASSWORD` (usuário padrão `opencode`). Verificado em
 * opencode 1.18.32: sem credencial → 401, Bearer → 401, Basic → 200.
 */
export const OPENCODE_SERVER_USERNAME = "opencode";

export function openCodeServerAuthHeader(password: string | undefined): Record<string, string> {
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString("base64")}` };
}

/** Evento emitido por `opencode run --format json` (conferido no opencode 1.18.32). */
export interface OpenCodeRunEvent {
  type: string;
  sessionID?: string;
  part?: {
    id?: string;
    type?: string;
    text?: string;
    tool?: string;
    callID?: string;
    state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string };
    tokens?: { input?: number; output?: number; reasoning?: number };
    cost?: number;
  };
  error?: { name?: string; data?: { message?: string } };
}

/** Traduz um evento do `opencode run --format json` para eventos canônicos. */
export function mapOpenCodeRunEvent(event: OpenCodeRunEvent, runId: string): { events: AgentEvent[]; text?: string; error?: string } {
  const timestamp = new Date().toISOString();
  const part = event.part;
  switch (event.type) {
    case "text": {
      const text = part?.text ?? "";
      return text ? { events: [{ type: "message.delta", runId, text, timestamp }], text } : { events: [] };
    }
    case "tool_use": {
      const id = part?.callID || part?.id || `call-${Date.now()}`;
      const name = part?.tool || "tool";
      const failed = part?.state?.status === "error";
      return {
        events: [
          { type: "tool.requested", runId, call: { id, name, arguments: part?.state?.input ?? {} }, timestamp },
          { type: "tool.completed", runId, result: { id, name, result: failed ? part?.state?.error : part?.state?.output, isError: failed }, timestamp },
        ],
      };
    }
    case "step_finish": {
      const t = part?.tokens;
      if (!t) return { events: [] };
      const promptTokens = t.input;
      const completionTokens = (t.output ?? 0) + (t.reasoning ?? 0);
      return {
        events: [{ type: "usage.updated", runId, usage: { promptTokens, completionTokens, totalTokens: (promptTokens ?? 0) + completionTokens, costUsd: part?.cost }, timestamp }],
      };
    }
    case "error":
      return { events: [], error: event.error?.data?.message || event.error?.name || "Erro do OpenCode" };
    default:
      return { events: [] };
  }
}

/** `provider/model` → corpo `model` do OpenCode; `default` usa o padrão do servidor. */
export function parseOpenCodeModel(model?: string): { providerID: string; modelID: string } | undefined {
  const value = model?.trim();
  if (!value || value === "default" || !value.includes("/")) return undefined;
  const [providerID, ...rest] = value.split("/");
  return providerID && rest.length > 0 ? { providerID, modelID: rest.join("/") } : undefined;
}

/** Lê um stream SSE e devolve o JSON de cada evento `data:`. */
export async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<Record<string, any>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          yield JSON.parse(data) as Record<string, any>;
        } catch {
          // evento malformado: ignorado
        }
      }
    }
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") return;
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Estado de um turno: traduz eventos do barramento do OpenCode (apenas os da
 * sessão do turno e de mensagens do assistente) em eventos canônicos.
 */
export class OpenCodeTurnState {
  output = "";
  error?: string;
  idle = false;
  /** Só aceita `session.idle` depois de ver o turno começar. */
  private active = false;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number };
  private readonly assistantMessages = new Set<string>();
  private readonly partTypes = new Map<string, string>();
  private readonly emittedText = new Map<string, number>();
  private readonly toolsStarted = new Set<string>();
  private readonly toolsDone = new Set<string>();

  constructor(private readonly sessionId: string, private readonly runId: string) {}

  accept(event: Record<string, any>): AgentEvent[] {
    const props = event?.properties ?? {};
    if (props.sessionID !== this.sessionId) return [];
    const timestamp = new Date().toISOString();
    switch (event.type) {
      case "message.updated": {
        const info = props.info ?? {};
        if (info.role === "assistant" && info.id) {
          this.active = true;
          this.assistantMessages.add(info.id);
          if (info.tokens) {
            const completion = (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0);
            this.usage = { promptTokens: info.tokens.input, completionTokens: completion, totalTokens: (info.tokens.input ?? 0) + completion, costUsd: info.cost };
          }
          if (info.error && info.error.name !== "MessageAbortedError") this.error = info.error.data?.message || info.error.name;
        }
        return [];
      }
      case "message.part.updated": {
        const part = props.part ?? {};
        if (!part.id) return [];
        this.partTypes.set(part.id, part.type);
        if (!this.assistantMessages.has(part.messageID)) return [];
        if (part.type === "text" && typeof part.text === "string") return this.emitTextUpTo(part.id, part.text, timestamp);
        if (part.type === "tool") return this.toolEvents(part, timestamp);
        return [];
      }
      case "message.part.delta": {
        if (props.field !== "text" || this.partTypes.get(props.partID) !== "text" || !this.assistantMessages.has(props.messageID)) return [];
        const delta = String(props.delta ?? "");
        if (!delta) return [];
        this.emittedText.set(props.partID, (this.emittedText.get(props.partID) ?? 0) + delta.length);
        this.output += delta;
        return [{ type: "message.delta", runId: this.runId, text: delta, timestamp }];
      }
      case "permission.asked":
        return [{
          type: "approval.requested",
          runId: this.runId,
          approval: {
            id: String(props.id),
            action: String(props.permission ?? "permission"),
            description: Array.isArray(props.patterns) && props.patterns.length > 0 ? props.patterns.join(", ") : String(props.permission ?? "Permissão solicitada pelo OpenCode"),
            sensitiveData: { tool: props.tool },
          },
          timestamp,
        }];
      case "session.status":
        if (props.status?.type === "busy" || props.status?.type === "retry") this.active = true;
        return [];
      case "session.error": {
        this.active = true;
        const err = props.error;
        if (err && err.name !== "MessageAbortedError") this.error = err.data?.message || err.name || "Erro do OpenCode";
        return [];
      }
      case "session.idle":
        if (this.active) this.idle = true;
        return [];
      default:
        return [];
    }
  }

  private emitTextUpTo(partId: string, text: string, timestamp: string): AgentEvent[] {
    const already = this.emittedText.get(partId) ?? 0;
    if (text.length <= already) return [];
    const delta = text.slice(already);
    this.emittedText.set(partId, text.length);
    this.output += delta;
    return [{ type: "message.delta", runId: this.runId, text: delta, timestamp }];
  }

  private toolEvents(part: Record<string, any>, timestamp: string): AgentEvent[] {
    const id = String(part.callID ?? part.id);
    const name = String(part.tool ?? "tool");
    const status = part.state?.status;
    const out: AgentEvent[] = [];
    if (!this.toolsStarted.has(id)) {
      this.toolsStarted.add(id);
      out.push({ type: "tool.requested", runId: this.runId, call: { id, name, arguments: part.state?.input ?? {} }, timestamp });
    }
    if ((status === "completed" || status === "error") && !this.toolsDone.has(id)) {
      this.toolsDone.add(id);
      out.push({ type: "tool.completed", runId: this.runId, result: { id, name, result: status === "error" ? part.state?.error : part.state?.output, isError: status === "error" }, timestamp });
    }
    return out;
  }
}
