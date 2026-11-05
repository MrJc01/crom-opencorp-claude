import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../events.js";
import { normalizeEngineError } from "../error-normalizer.js";

/**
 * Cliente JSON-RPC (stdio, JSONL) para `codex app-server`.
 *
 * Contrato conferido contra o esquema gerado por `codex app-server generate-ts`
 * (protocolo v2): initialize/initialized, thread/start|resume|fork,
 * turn/start|interrupt, notificações item/* e turn/*, e solicitações de
 * aprovação iniciadas pelo servidor.
 */

export interface CodexAppServerLaunchOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface CodexAppServerHandle {
  pid: number;
  stdout: AsyncIterable<string | Buffer>;
  stderr?: AsyncIterable<string | Buffer>;
  write(message: string): void;
  kill(signal?: NodeJS.Signals): void;
  exitCode: Promise<number>;
}

export type CodexAppServerLauncher = (
  options: CodexAppServerLaunchOptions
) => Promise<CodexAppServerHandle>;

export type ApprovalDecision = "approve" | "reject";

type JsonRecord = Record<string, any>;

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);

/** Tempo padrão para respostas de controle (initialize, thread/*, turn/start). */
export const CODEX_APP_SERVER_REQUEST_TIMEOUT_MS = 60_000;
/** Quantidade máxima de stderr mantida para diagnóstico. */
const STDERR_TAIL_BYTES = 8 * 1024;

class AsyncEventQueue {
  private values: AgentEvent[] = [];
  private waiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private ended = false;

  get isEnded(): boolean {
    return this.ended;
  }

  push(value: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  async *iterate(): AsyncIterable<AgentEvent> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<AgentEvent>>((resolve) => this.waiters.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

interface PendingApproval {
  requestId: number | string;
  method: string;
  threadId: string;
  turnId: string;
  requestedPermissions?: unknown;
}

export class CodexAppServerClient {
  private handle?: CodexAppServerHandle;
  private nextRequestId = 1;
  private pending = new Map<number | string, { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private turnQueues = new Map<string, AsyncEventQueue>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private closed = false;
  private stderrTail = "";

  constructor(
    private readonly options: {
      command: string;
      cwd: string;
      env: Record<string, string>;
      launcher?: CodexAppServerLauncher;
      requestTimeoutMs?: number;
      clientVersion?: string;
    }
  ) {}

  get pid(): number {
    return this.handle?.pid ?? 0;
  }

  get exitCode(): Promise<number> {
    return this.handle?.exitCode ?? Promise.resolve(1);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Últimos bytes de stderr, para diagnóstico. Nunca contém a entrada do usuário. */
  get stderr(): string {
    return this.stderrTail;
  }

  /** IDs de aprovações aguardando decisão. */
  get pendingApprovalIds(): string[] {
    return [...this.pendingApprovals.keys()];
  }

  async start(): Promise<void> {
    if (this.handle) return;
    const args = ["app-server", "--listen", "stdio://"];
    this.handle = this.options.launcher
      ? await this.options.launcher({ command: this.options.command, args, cwd: this.options.cwd, env: this.options.env })
      : this.spawnDefault(args);
    void this.readLoop();
    void this.drainStderr();
    try {
      await this.request("initialize", {
        clientInfo: { name: "opencorp", title: "OpenCorp", version: this.options.clientVersion ?? "0.0.0" },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
          mcpServerOpenaiFormElicitation: false,
          optOutNotificationMethods: [],
          extensions: {},
        },
      });
      this.notify("initialized");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async startThread(input: { cwd: string; model?: string }): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: input.cwd,
      model: input.model || null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      ephemeral: false,
    });
    return String(result.thread.id);
  }

  async resumeThread(threadId: string, input: { cwd: string; model?: string }): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId,
      cwd: input.cwd,
      model: input.model || null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
    return String(result.thread.id);
  }

  async forkThread(threadId: string, input: { cwd: string; model?: string }): Promise<string> {
    const result = await this.request("thread/fork", {
      threadId,
      cwd: input.cwd,
      model: input.model || null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      excludeTurns: true,
    });
    return String(result.thread.id);
  }

  async *runTurn(threadId: string, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = `codex-app-${randomUUID()}`;
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: "codex" };
    let turnId = "";
    let aborted = false;
    let output = "";
    let terminal = false;
    const onAbort = () => {
      aborted = true;
      if (!turnId) return;
      this.cancelApprovalsForTurn(threadId, turnId);
      void this.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (signal?.aborted) {
        yield { type: "run.completed", runId, result: { output: "", stopReason: "cancelled" }, timestamp: new Date().toISOString() };
        return;
      }
      const response = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      turnId = String(response.turn.id);
      const queue = this.getTurnQueue(threadId, turnId);
      if (signal?.aborted) onAbort();
      for await (const event of queue.iterate()) {
        const normalized = { ...event, runId } as AgentEvent;
        if (normalized.type === "message.delta") output += normalized.text;
        if (normalized.type === "run.completed") {
          terminal = true;
          const status = normalized.result.stopReason;
          yield {
            ...normalized,
            result: {
              ...normalized.result,
              output: output || normalized.result.output,
              stopReason: aborted || status === "interrupted" ? "cancelled" : status,
            },
          };
        } else {
          if (normalized.type === "run.failed") terminal = true;
          yield normalized;
        }
      }
      if (!terminal) {
        const message = this.stderrTail.trim()
          ? `Codex app-server encerrou durante o turno: ${this.stderrTail.trim().split("\n").slice(-3).join(" ")}`
          : "Codex app-server encerrou durante o turno";
        yield { type: "run.failed", runId, error: normalizeEngineError(new Error(message), { engineId: "codex" }), timestamp: new Date().toISOString() };
      }
    } catch (error) {
      yield { type: "run.failed", runId, error: normalizeEngineError(error, { engineId: "codex" }), timestamp: new Date().toISOString() };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (turnId) {
        this.cancelApprovalsForTurn(threadId, turnId);
        this.turnQueues.delete(this.turnKey(threadId, turnId));
      }
    }
  }

  /**
   * Responde a uma aprovação pendente. Retorna `false` se o ID não pertence a
   * este processo — os IDs são UUIDs gerados localmente, nunca o ID JSON-RPC,
   * para que não colidam entre processos de workspaces diferentes.
   */
  async respondApproval(approvalId: string, decision: ApprovalDecision): Promise<boolean> {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval || !this.handle || this.closed) return false;
    this.pendingApprovals.delete(approvalId);
    this.write({ id: approval.requestId, result: this.approvalResult(approval, decision) });
    return true;
  }

  close(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.closed) return;
    this.closed = true;
    this.handle?.kill(signal);
    this.failAll(new Error("Codex app-server encerrado"));
  }

  private approvalResult(approval: PendingApproval, decision: ApprovalDecision | "cancel"): JsonRecord {
    if (approval.method === "item/permissions/requestApproval") {
      return decision === "approve"
        ? { permissions: approval.requestedPermissions ?? {}, scope: "turn" }
        : { permissions: {}, scope: "turn" };
    }
    if (decision === "cancel") return { decision: "cancel" };
    return { decision: decision === "approve" ? "accept" : "decline" };
  }

  private cancelApprovalsForTurn(threadId: string, turnId: string): void {
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.threadId !== threadId || approval.turnId !== turnId) continue;
      this.pendingApprovals.delete(id);
      try {
        this.write({ id: approval.requestId, result: this.approvalResult(approval, "cancel") });
      } catch {
        // processo já encerrado
      }
    }
  }

  private spawnDefault(args: string[]): CodexAppServerHandle {
    const child: ChildProcess = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Sem este listener, um EPIPE após a morte do filho derrubaria o processo OpenCorp.
    child.stdin?.on("error", () => {});
    const exitCode = new Promise<number>((resolve) => {
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", () => resolve(1));
    });
    return {
      pid: child.pid ?? 0,
      stdout: child.stdout!,
      stderr: child.stderr ?? undefined,
      write: (message) => {
        if (child.stdin && !child.stdin.destroyed && child.stdin.writable) child.stdin.write(message);
        else throw new Error("stdin do Codex app-server fechado");
      },
      kill: (signal = "SIGTERM") => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); },
      exitCode,
    };
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextRequestId++;
    const timeoutMs = this.options.requestTimeoutMs ?? CODEX_APP_SERVER_REQUEST_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const entry: { resolve: (value: any) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout } = { resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`Codex app-server não respondeu a ${method} em ${timeoutMs} ms`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      try {
        this.write({ method, id, params });
      } catch (error) {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(message: JsonRecord): void {
    if (!this.handle || this.closed) throw new Error("Codex app-server não está ativo");
    this.handle.write(`${JSON.stringify(message)}\n`);
  }

  private async drainStderr(): Promise<void> {
    const stderr = this.handle?.stderr;
    if (!stderr) return;
    try {
      for await (const chunk of stderr) {
        this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
      }
    } catch {
      // stream encerrado
    }
  }

  private async readLoop(): Promise<void> {
    let buffer = "";
    try {
      for await (const chunk of this.handle!.stdout) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) this.receive(line);
      }
    } catch {
      // stdout encerrado com erro; tratado abaixo como encerramento
    } finally {
      this.closed = true;
      this.failAll(new Error("Conexão com Codex app-server encerrada"));
    }
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    this.pendingApprovals.clear();
    for (const queue of this.turnQueues.values()) {
      queue.push({ type: "run.failed", runId: "pending", error: normalizeEngineError(error, { engineId: "codex" }), timestamp: new Date().toISOString() });
      queue.end();
    }
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let message: JsonRecord;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "Erro JSON-RPC do Codex"));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.receiveServerRequest(message);
      return;
    }
    if (message.method) this.receiveNotification(message.method, message.params || {});
  }

  private receiveServerRequest(message: JsonRecord): void {
    if (!APPROVAL_METHODS.has(message.method)) {
      this.write({ id: message.id, error: { code: -32601, message: `Solicitação não suportada pelo OpenCorp: ${message.method}` } });
      return;
    }
    const params = message.params || {};
    const threadId = String(params.threadId);
    const turnId = String(params.turnId);
    const approvalId = randomUUID();
    this.pendingApprovals.set(approvalId, {
      requestId: message.id,
      method: message.method,
      threadId,
      turnId,
      requestedPermissions: params.permissions,
    });
    const description =
      message.method === "item/commandExecution/requestApproval"
        ? params.command || params.reason || "Execução de comando solicitada pelo Codex"
        : message.method === "item/fileChange/requestApproval"
          ? params.reason || "Alteração de arquivos solicitada pelo Codex"
          : params.reason || "Permissões adicionais solicitadas pelo Codex";
    this.getTurnQueue(threadId, turnId).push({
      type: "approval.requested",
      runId: "pending",
      approval: {
        id: approvalId,
        action: message.method,
        description: String(description),
        sensitiveData: { itemId: params.itemId, cwd: params.cwd, kind: params.kind },
      },
      timestamp: new Date().toISOString(),
    });
  }

  private receiveNotification(method: string, params: JsonRecord): void {
    const threadId = params.threadId ? String(params.threadId) : "";
    const rawTurnId = params.turnId ?? params.turn?.id;
    const turnId = rawTurnId ? String(rawTurnId) : "";
    if (!threadId || !turnId) return;
    const queue = this.getTurnQueue(threadId, turnId);
    const timestamp = new Date().toISOString();
    if (method === "item/agentMessage/delta") {
      queue.push({ type: "message.delta", runId: "pending", text: String(params.delta || ""), timestamp });
    } else if (method === "item/started" && params.item?.type === "commandExecution") {
      queue.push({ type: "tool.requested", runId: "pending", call: { id: String(params.item.id), name: "shell", arguments: { command: params.item.command } }, timestamp });
    } else if (method === "item/completed" && params.item?.type === "commandExecution") {
      const exitCode = params.item.exitCode;
      queue.push({ type: "tool.completed", runId: "pending", result: { id: String(params.item.id), name: "shell", result: params.item.aggregatedOutput || "", isError: typeof exitCode === "number" && exitCode !== 0 }, timestamp });
    } else if (method === "item/started" && params.item?.type === "fileChange") {
      queue.push({ type: "tool.requested", runId: "pending", call: { id: String(params.item.id), name: "file_change", arguments: { files: (params.item.changes || []).map((c: JsonRecord) => c.path) } }, timestamp });
    } else if (method === "item/completed" && params.item?.type === "fileChange") {
      queue.push({ type: "tool.completed", runId: "pending", result: { id: String(params.item.id), name: "file_change", result: params.item.status, isError: params.item.status === "failed" || params.item.status === "declined" }, timestamp });
    } else if (method === "thread/tokenUsage/updated") {
      const last = params.tokenUsage?.last;
      if (last) {
        queue.push({ type: "usage.updated", runId: "pending", usage: { promptTokens: last.inputTokens, completionTokens: last.outputTokens, totalTokens: last.totalTokens }, timestamp });
      }
    } else if (method === "turn/completed") {
      if (params.turn?.status === "failed") {
        queue.push({ type: "run.failed", runId: "pending", error: normalizeEngineError(new Error(params.turn?.error?.message || "Turno Codex falhou"), { engineId: "codex" }), timestamp });
      } else {
        queue.push({ type: "run.completed", runId: "pending", result: { output: "", stopReason: params.turn?.status || "completed" }, timestamp });
      }
      queue.end();
    } else if (method === "error") {
      // `willRetry: true` significa que o próprio Codex tentará novamente; o turno continua.
      if (params.willRetry) return;
      queue.push({ type: "run.failed", runId: "pending", error: normalizeEngineError(new Error(params.error?.message || "Erro no Codex app-server"), { engineId: "codex" }), timestamp });
      queue.end();
    }
  }

  private turnKey(threadId: string, turnId: string): string {
    return `${threadId}::${turnId}`;
  }

  private getTurnQueue(threadId: string, turnId: string): AsyncEventQueue {
    const key = this.turnKey(threadId, turnId);
    let queue = this.turnQueues.get(key);
    if (!queue) {
      queue = new AsyncEventQueue();
      this.turnQueues.set(key, queue);
    }
    return queue;
  }
}
