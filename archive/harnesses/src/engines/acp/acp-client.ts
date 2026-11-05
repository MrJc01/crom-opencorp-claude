/**
 * Cliente ACP (Agent Client Protocol) v1 — lado "cliente" do protocolo.
 *
 * Contrato fixado no esquema oficial `@agentclientprotocol/sdk` 1.5.0
 * (`PROTOCOL_VERSION = 1`) e conferido em handshakes reais com
 * `copilot --acp` 1.0.88 e `mimo acp` 0.1.15.
 *
 * O OpenCorp se declara sem capacidades de cliente (`fs`/`terminal` falsos):
 * o agente opera sozinho no `cwd` da sessão e todo acesso sensível passa por
 * `session/request_permission`, traduzido em `approval.requested`.
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentUsage } from "../events.js";
import { EngineAuthRequiredError, EngineCapabilityUnavailableError, ModelIncompatibleError } from "../errors.js";
import { normalizeEngineError } from "../error-normalizer.js";
import { JsonRpcConnection, JsonRpcError, JSON_RPC_METHOD_NOT_FOUND, type JsonRpcTransport } from "./json-rpc-connection.js";

export const ACP_PROTOCOL_VERSION = 1;

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: { list?: unknown; fork?: unknown; resume?: unknown; close?: unknown; delete?: unknown };
}

export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string | null;
  type?: string;
  currentValue?: string;
  options?: Array<{ value: string; name?: string } | { group?: string; options?: Array<{ value: string; name?: string }> }>;
}

export interface AcpSessionInfo {
  sessionId: string;
  configOptions: AcpConfigOption[];
}

interface PermissionOption {
  optionId: string;
  name?: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

interface PendingPermission {
  sessionId: string;
  options: PermissionOption[];
  resolve: (outcome: unknown) => void;
  timer?: NodeJS.Timeout;
}

class EventQueue<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;
  push(item: T) {
    if (this.done) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end() {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as any, done: true });
  }
  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.items.length) { yield this.items.shift()!; continue; }
      if (this.done) return;
      const next = await new Promise<IteratorResult<T>>((r) => this.waiters.push(r));
      if (next.done) return;
      yield next.value;
    }
  }
}

interface ActiveTurn {
  runId: string;
  queue: EventQueue<AgentEvent>;
  output: string;
  toolsDone: Set<string>;
  toolsStarted: Set<string>;
}

export interface AcpAgentClientOptions {
  engineId: string;
  transport: JsonRpcTransport;
  clientVersion: string;
  requestTimeoutMs?: number;
  /** Aprovação não respondida neste prazo é rejeitada (HITL expirado). */
  approvalTimeoutMs?: number;
  maxFrameBytes?: number;
}

export class AcpAgentClient {
  readonly engineId: string;
  readonly connection: JsonRpcConnection;
  agentCapabilities: AcpAgentCapabilities = {};
  agentInfo?: { name?: string; version?: string };
  authMethods: Array<{ id: string; name?: string; description?: string }> = [];
  private readonly turns = new Map<string, ActiveTurn>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly approvalTimeoutMs: number;
  private readonly clientVersion: string;

  constructor(options: AcpAgentClientOptions) {
    this.engineId = options.engineId;
    this.clientVersion = options.clientVersion;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 10 * 60_000;
    this.connection = new JsonRpcConnection(options.transport, {
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      maxFrameBytes: options.maxFrameBytes,
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
    });
    void this.connection.finished.then(() => {
      // Processo morreu: turnos ativos terminam com falha, aprovações somem.
      for (const [sessionId, turn] of this.turns) {
        turn.queue.push({ type: "run.failed", runId: turn.runId, error: normalizeEngineError(new Error(this.connection.stderr ? `Agente ACP encerrou: ${this.connection.stderr.slice(-300)}` : "Agente ACP encerrou inesperadamente"), { engineId: this.engineId }), timestamp: new Date().toISOString() });
        turn.queue.end();
        this.turns.delete(sessionId);
      }
      for (const [id, p] of this.permissions) { if (p.timer) clearTimeout(p.timer); this.permissions.delete(id); }
    });
  }

  get isClosed(): boolean {
    return this.connection.isClosed;
  }

  get pendingApprovalIds(): string[] {
    return [...this.permissions.keys()];
  }

  async initialize(): Promise<void> {
    const result = await this.request<{ protocolVersion: number; agentCapabilities?: AcpAgentCapabilities; agentInfo?: { name?: string; version?: string }; authMethods?: Array<{ id: string; name?: string; description?: string }> }>("initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "opencorp", title: "OpenCorp", version: this.clientVersion },
    });
    if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
      this.close();
      throw new EngineCapabilityUnavailableError(this.engineId, `acp-v${ACP_PROTOCOL_VERSION}`, { details: { agentProtocolVersion: result.protocolVersion } });
    }
    this.agentCapabilities = result.agentCapabilities ?? {};
    this.agentInfo = result.agentInfo;
    this.authMethods = result.authMethods ?? [];
  }

  supports(capability: "load" | "resume" | "fork" | "close"): boolean {
    if (capability === "load") return this.agentCapabilities.loadSession === true;
    const caps = this.agentCapabilities.sessionCapabilities ?? {};
    return caps[capability] !== undefined && caps[capability] !== null;
  }

  async newSession(cwd: string): Promise<AcpSessionInfo> {
    const r = await this.request<{ sessionId: string; configOptions?: AcpConfigOption[] | null }>("session/new", { cwd, mcpServers: [] });
    return { sessionId: r.sessionId, configOptions: r.configOptions ?? [] };
  }

  /** Reabre uma sessão existente: `session/resume` se anunciado, senão `session/load`. */
  async reopenSession(sessionId: string, cwd: string): Promise<AcpSessionInfo> {
    if (this.supports("resume")) {
      const r = await this.request<{ configOptions?: AcpConfigOption[] | null }>("session/resume", { sessionId, cwd, mcpServers: [] });
      return { sessionId, configOptions: r?.configOptions ?? [] };
    }
    if (this.supports("load")) {
      // O agente reenvia o histórico em `session/update`; sem turno ativo, é ignorado.
      const r = await this.request<{ configOptions?: AcpConfigOption[] | null }>("session/load", { sessionId, cwd, mcpServers: [] }, 120_000);
      return { sessionId, configOptions: r?.configOptions ?? [] };
    }
    throw new EngineCapabilityUnavailableError(this.engineId, "continuation");
  }

  async forkSession(sessionId: string, cwd: string): Promise<AcpSessionInfo> {
    if (!this.supports("fork")) throw new EngineCapabilityUnavailableError(this.engineId, "fork");
    const r = await this.request<{ sessionId: string; configOptions?: AcpConfigOption[] | null }>("session/fork", { sessionId, cwd, mcpServers: [] });
    return { sessionId: r.sessionId, configOptions: r.configOptions ?? [] };
  }

  async closeSession(sessionId: string): Promise<void> {
    if (!this.supports("close")) return;
    await this.request("session/close", { sessionId }).catch(() => {});
  }

  /**
   * Seleciona o modelo pela opção de configuração `model` da sessão. Modelo
   * fora da lista anunciada, ou agente sem essa opção, falha explicitamente —
   * nunca usa outro modelo em silêncio.
   */
  async selectModel(session: AcpSessionInfo, model: string | undefined): Promise<void> {
    if (!model || model === "default") return;
    const option = session.configOptions.find((o) => o.category === "model" || o.id === "model");
    if (!option) {
      throw new ModelIncompatibleError(this.engineId, model, { details: { reason: "o agente não expõe seleção de modelo via ACP (configOptions)" } });
    }
    const values = flattenOptionValues(option);
    if (!values.includes(model)) {
      throw new ModelIncompatibleError(this.engineId, model, { details: { reason: "modelo fora da lista anunciada pelo agente", available: values.slice(0, 50) } });
    }
    if (option.currentValue === model) return;
    await this.request("session/set_config_option", { sessionId: session.sessionId, configId: option.id, value: model });
  }

  /** Executa um turno com streaming. Um turno ativo por sessão. */
  async *runTurn(sessionId: string, text: string, signal?: AbortSignal, runId = `acp-run-${randomUUID()}`): AsyncIterable<AgentEvent> {
    if (this.turns.has(sessionId)) {
      yield { type: "run.failed", runId, error: normalizeEngineError(new Error("Já existe um turno ativo nesta sessão ACP"), { engineId: this.engineId }), timestamp: new Date().toISOString() };
      return;
    }
    const turn: ActiveTurn = { runId, queue: new EventQueue(), output: "", toolsDone: new Set(), toolsStarted: new Set() };
    const stderrStart = this.connection.stderrOffset;
    this.turns.set(sessionId, turn);
    let cancelled = false;
    const onAbort = () => {
      cancelled = true;
      this.cancelSession(sessionId);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const prompt = this.connection
      // Turnos podem ser longos: sem tempo limite JSON-RPC; o chamador controla via `signal`.
      .request<{ stopReason: string; usage?: { inputTokens?: number; outputTokens?: number; thoughtTokens?: number | null; totalTokens?: number } | null }>("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 0)
      .then(async (result) => {
        // Alguns agentes (ex.: MiMo 0.1.15) encerram com `end_turn` vazio quando o
        // provedor falha e só registram o erro no stderr. Turno sem saída nem
        // ferramentas com `error:` no stderr é falha, não resposta vazia.
        if (!cancelled && turn.output === "" && turn.toolsStarted.size === 0) {
          await new Promise((r) => setTimeout(r, 50));
          const line = /^error:\s*(.+)$/im.exec(this.connection.stderrSince(stderrStart))?.[1]?.trim();
          if (line) {
            const error = /sign in|log ?in|auth|api key|credential/i.test(line)
              ? new EngineAuthRequiredError(this.engineId, { details: { agentError: line } })
              : normalizeEngineError(new Error(line), { engineId: this.engineId });
            turn.queue.push({ type: "run.failed", runId, error, timestamp: new Date().toISOString() });
            return;
          }
        }
        if (result?.usage) {
          const completion = (result.usage.outputTokens ?? 0) + (result.usage.thoughtTokens ?? 0);
          const usage: AgentUsage = { promptTokens: result.usage.inputTokens, completionTokens: completion, totalTokens: result.usage.totalTokens ?? (result.usage.inputTokens ?? 0) + completion };
          turn.queue.push({ type: "usage.updated", runId, usage, timestamp: new Date().toISOString() });
        }
        const stop = result?.stopReason === "end_turn" ? "completed" : result?.stopReason ?? "completed";
        turn.queue.push({ type: "run.completed", runId, result: { output: turn.output, stopReason: cancelled ? "cancelled" : stop }, timestamp: new Date().toISOString() });
      })
      .catch((error) => {
        if (cancelled) {
          turn.queue.push({ type: "run.completed", runId, result: { output: turn.output, stopReason: "cancelled" }, timestamp: new Date().toISOString() });
        } else {
          turn.queue.push({ type: "run.failed", runId, error: this.toEngineError(error), timestamp: new Date().toISOString() });
        }
      })
      .finally(() => turn.queue.end());

    try {
      for await (const event of turn.queue.iterate()) yield event;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await prompt.catch(() => {});
      if (this.turns.get(sessionId) === turn) this.turns.delete(sessionId);
    }
  }

  /** `session/cancel` e resposta `cancelled` a todas as aprovações pendentes da sessão (exigido pelo protocolo). */
  cancelSession(sessionId: string): void {
    void this.connection.notify("session/cancel", { sessionId });
    for (const [id, p] of this.permissions) {
      if (p.sessionId !== sessionId) continue;
      if (p.timer) clearTimeout(p.timer);
      this.permissions.delete(id);
      p.resolve({ outcome: { outcome: "cancelled" } });
    }
  }

  /** Responde uma aprovação pelo ID local. `false` se não estiver pendente. */
  respondApproval(approvalId: string, decision: "approve" | "reject"): boolean {
    const p = this.permissions.get(approvalId);
    if (!p) return false;
    if (p.timer) clearTimeout(p.timer);
    this.permissions.delete(approvalId);
    p.resolve(permissionOutcome(p.options, decision));
    return true;
  }

  close(): void {
    for (const [sessionId] of this.turns) this.cancelSession(sessionId);
    this.connection.close();
  }

  private request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    return this.connection.request<T>(method, params, timeoutMs).catch((error) => { throw this.toEngineError(error); });
  }

  private toEngineError(error: unknown) {
    if (error instanceof JsonRpcError && /auth/i.test(error.message)) {
      return new EngineAuthRequiredError(this.engineId, { cause: error, details: { rpcCode: error.code, authMethods: this.authMethods.map((m) => m.id) } });
    }
    return normalizeEngineError(error, { engineId: this.engineId });
  }

  private onNotification(method: string, params: any): void {
    if (method !== "session/update" || !params?.sessionId) return;
    const turn = this.turns.get(params.sessionId);
    if (!turn) return; // histórico reenviado por session/load ou atualização fora de turno
    for (const event of translateSessionUpdate(params.update, turn)) turn.queue.push(event);
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method !== "session/request_permission") {
      // Capacidades de cliente (fs/terminal) não foram anunciadas.
      throw new JsonRpcError({ code: JSON_RPC_METHOD_NOT_FOUND, message: `Método não suportado pelo OpenCorp: ${method}` });
    }
    const sessionId = String(params?.sessionId ?? "");
    const options: PermissionOption[] = Array.isArray(params?.options) ? params.options : [];
    const turn = this.turns.get(sessionId);
    if (!turn) return { outcome: { outcome: "cancelled" } };
    const id = randomUUID();
    const tool = params?.toolCall ?? {};
    return new Promise((resolve) => {
      const pending: PendingPermission = { sessionId, options, resolve };
      if (this.approvalTimeoutMs > 0) {
        pending.timer = setTimeout(() => {
          if (!this.permissions.delete(id)) return;
          // HITL expirado: rejeita — nunca aprova por omissão.
          resolve(permissionOutcome(options, "reject"));
        }, this.approvalTimeoutMs);
        pending.timer.unref?.();
      }
      this.permissions.set(id, pending);
      turn.queue.push({
        type: "approval.requested",
        runId: turn.runId,
        approval: {
          id,
          action: String(tool.kind ?? tool.name ?? "tool"),
          description: String(tool.title ?? tool.name ?? "Permissão solicitada pelo agente"),
          sensitiveData: { toolCallId: tool.toolCallId, rawInput: tool.rawInput, options: options.map((o) => o.kind) },
        },
        timestamp: new Date().toISOString(),
      });
    });
  }
}

function flattenOptionValues(option: AcpConfigOption): string[] {
  const out: string[] = [];
  for (const o of option.options ?? []) {
    if ("value" in o && typeof o.value === "string") out.push(o.value);
    else if ("options" in o && Array.isArray(o.options)) for (const inner of o.options) out.push(inner.value);
  }
  return out;
}

export function permissionOutcome(options: PermissionOption[], decision: "approve" | "reject"): unknown {
  const order = decision === "approve" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of order) {
    const option = options.find((o) => o.kind === kind);
    if (option) return { outcome: { outcome: "selected", optionId: option.optionId } };
  }
  // Nenhuma opção compatível: `cancelled` é a única resposta que não concede nada.
  return { outcome: { outcome: "cancelled" } };
}

function textOf(content: any): string {
  if (!content) return "";
  if (Array.isArray(content)) return content.map(textOf).join("");
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "content") return textOf(content.content);
  return "";
}

/** Traduz um `SessionUpdate` do ACP em eventos canônicos. Exportado para testes. */
export function translateSessionUpdate(update: any, turn: { runId: string; output: string; toolsStarted: Set<string>; toolsDone: Set<string> }): AgentEvent[] {
  const timestamp = new Date().toISOString();
  const runId = turn.runId;
  switch (update?.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update.content);
      if (!text) return [];
      turn.output += text;
      return [{ type: "message.delta", runId, text, timestamp }];
    }
    case "tool_call":
    case "tool_call_update": {
      const id = String(update.toolCallId ?? "");
      if (!id) return [];
      const out: AgentEvent[] = [];
      const name = String(update.name ?? update.kind ?? update.title ?? "tool");
      if (!turn.toolsStarted.has(id)) {
        turn.toolsStarted.add(id);
        out.push({ type: "tool.requested", runId, call: { id, name, arguments: (update.rawInput as Record<string, unknown>) ?? {} }, timestamp });
      }
      if ((update.status === "completed" || update.status === "failed") && !turn.toolsDone.has(id)) {
        turn.toolsDone.add(id);
        out.push({ type: "tool.completed", runId, result: { id, name, result: update.rawOutput ?? textOf(update.content), isError: update.status === "failed" }, timestamp });
      }
      return out;
    }
    case "usage_update":
      if (update.cost && update.cost.currency === "USD" && typeof update.cost.amount === "number") {
        return [{ type: "usage.updated", runId, usage: { costUsd: update.cost.amount }, timestamp }];
      }
      return [];
    default:
      // agent_thought_chunk, plan, available_commands_update etc.: sem evento canônico.
      return [];
  }
}
