/**
 * Cliente do protocolo Openheinerss (JSON-RPC 2.0 / NDJSON por STDIO) — docs/02-protocol-spec.md do openheinerss.
 *
 * Um processo `openheinerss serve --stdio` atende várias sessões; as notificações `agent.*` são roteadas
 * por `sessionId` para a fila do turno em andamento. `session.prompt` responde `accepted` na hora e o turno
 * termina em `agent.complete` ou `agent.error`.
 */
import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentUsage } from "../events.js";
import { normalizeEngineError } from "../error-normalizer.js";
import { JsonRpcConnection, JsonRpcError, type JsonRpcTransport } from "../acp/json-rpc-connection.js";

export interface OpenheinerssSessionInfo {
  sessionId: string;
  harness?: string;
  status?: string;
  /** Id nativo do motor (ex.: session_id do Claude Code), quando o servidor o informa. */
  nativeSessionId?: string;
}

export interface OpenheinerssSessionOptions {
  harness: string;
  model?: string;
  cwd: string;
  permissionMode?: "ask" | "always_allow" | "plan";
  systemPrompt?: string;
}

/** Item da fila de um turno: notificação do servidor ou aviso interno (resposta de aprovação, fechamento). */
type TurnItem =
  | { kind: "notification"; method: string; params: any }
  | { kind: "approval-resolved"; approvalId: string; decision: "approved" | "rejected" | "expired" }
  | { kind: "closed"; reason: string };

const EDIT_TOOLS = new Set(["write", "edit", "multiedit", "fileedit", "filewrite", "notebookedit", "create"]);

/** Aprovação pendente: dono (workspace) e sessão, para a resposta só valer para quem pediu. */
interface PendingApproval {
  sessionId: string;
  workspaceId: string;
  timer?: NodeJS.Timeout;
}

export interface OpenheinerssClientOptions {
  engineId: string;
  workspaceId: string;
  transport: JsonRpcTransport;
  requestTimeoutMs?: number;
  /** Sem resposta do usuário a aprovação expira como `rejected`. */
  approvalTimeoutMs?: number;
}

export class OpenheinerssClient {
  readonly connection: JsonRpcConnection;
  private readonly queues = new Map<string, { push: (item: TurnItem) => void }>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly engineId: string;
  private readonly workspaceId: string;
  private readonly approvalTimeoutMs: number;

  constructor(options: OpenheinerssClientOptions) {
    this.engineId = options.engineId;
    this.workspaceId = options.workspaceId;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 10 * 60_000;
    this.connection = new JsonRpcConnection(options.transport, {
      requestTimeoutMs: options.requestTimeoutMs ?? 60_000,
      onNotification: (method, params) => this.onNotification(method, params),
    });
    void this.connection.finished.then(() => {
      for (const q of this.queues.values()) q.push({ kind: "closed", reason: this.connection.stderr.slice(-300) || "processo openheinerss encerrou" });
      this.clearApprovals();
    });
  }

  get isClosed(): boolean {
    return this.connection.isClosed;
  }

  close(): void {
    this.clearApprovals();
    this.connection.close();
  }

  async createSession(opts: OpenheinerssSessionOptions): Promise<OpenheinerssSessionInfo> {
    const options: Record<string, unknown> = {};
    if (opts.permissionMode) options.permissionMode = opts.permissionMode;
    if (opts.systemPrompt) options.systemPrompt = opts.systemPrompt;
    return this.connection.request<OpenheinerssSessionInfo>("session.create", {
      harness: opts.harness,
      cwd: opts.cwd,
      ...(opts.model ? { model: opts.model } : {}),
      ...(Object.keys(options).length ? { options } : {}),
    });
  }

  resumeSession(sessionId: string, cwd: string): Promise<OpenheinerssSessionInfo> {
    return this.connection.request<OpenheinerssSessionInfo>("session.resume", { sessionId, cwd });
  }

  /** Aprovação pendente deste cliente; `false` se o id não existe ou é de outro workspace. */
  async respondApproval(approvalId: string, decision: "approve" | "reject", workspaceId: string): Promise<boolean> {
    const pending = this.approvals.get(approvalId);
    if (!pending || workspaceId !== this.workspaceId) return false;
    this.approvals.delete(approvalId);
    if (pending.timer) clearTimeout(pending.timer);
    // O aviso entra na fila antes do pedido: a resposta do servidor pode vir junto com o fim do turno.
    this.queues.get(pending.sessionId)?.push({
      kind: "approval-resolved",
      approvalId,
      decision: decision === "approve" ? "approved" : "rejected",
    });
    try {
      await this.connection.request("session.permission_respond", {
        sessionId: pending.sessionId,
        requestId: approvalId,
        decision: decision === "approve" ? "allow" : "deny",
      });
    } catch {
      return false;
    }
    return true;
  }

  async abort(sessionId: string): Promise<void> {
    try {
      await this.connection.request("session.abort", { sessionId }, 5_000);
    } catch {
      /* o turno é encerrado pelo cliente de qualquer forma */
    }
  }

  /**
   * Um turno: envia o prompt e traduz as notificações em `AgentEvent` até `agent.complete`/`agent.error`.
   * Não emite `run.started` (quem chama emite, para cobrir também falhas antes do prompt).
   */
  async *runTurn(sessionId: string, text: string, runId: string, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const now = () => new Date().toISOString();
    const items: TurnItem[] = [];
    let wake: (() => void) | undefined;
    this.queues.set(sessionId, {
      push: (item) => {
        items.push(item);
        wake?.();
      },
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      void this.abort(sessionId);
      wake?.();
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    let output = "";
    let usage: AgentUsage | undefined;
    let nativeSeen: string | undefined;
    const toolNames = new Map<string, string>();
    const toolInputs = new Map<string, Record<string, unknown>>();
    let graceTimer: NodeJS.Timeout | undefined;
    let graceExpired = false;

    try {
      try {
        await this.connection.request("session.prompt", { sessionId, text });
      } catch (error) {
        yield { type: "run.failed", runId, error: normalizeEngineError(this.rpcError(error), { engineId: this.engineId }), timestamp: now() };
        return;
      }

      while (true) {
        if (aborted && !graceTimer) {
          // O servidor deve responder com agent.complete; sem isso, encerra o turno após 2 s.
          graceTimer = setTimeout(() => {
            graceExpired = true;
            wake?.();
          }, 2_000);
          graceTimer.unref?.();
        }
        if (graceExpired) {
          yield { type: "run.completed", runId, result: { output, usage, stopReason: "cancelled" }, timestamp: now() };
          return;
        }
        const item = items.shift();
        if (!item) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            if (items.length > 0 || graceExpired) resolve();
          });
          wake = undefined;
          continue;
        }

        if (item.kind === "closed") {
          yield {
            type: "run.failed",
            runId,
            error: normalizeEngineError(new Error(`Conexão com o openheinerss perdida: ${item.reason}`), { engineId: this.engineId }),
            timestamp: now(),
          };
          return;
        }
        if (item.kind === "approval-resolved") {
          yield { type: "approval.resolved", runId, approvalId: item.approvalId, decision: item.decision, timestamp: now() };
          continue;
        }

        const { method, params } = item;
        const native = typeof params?.nativeSessionId === "string" ? params.nativeSessionId : undefined;
        if (native && native !== nativeSeen) {
          nativeSeen = native;
          yield { type: "session.updated", runId, nativeSessionId: native, timestamp: now() };
        }

        switch (method) {
          case "agent.text": {
            const delta = String(params?.delta ?? "");
            if (delta) {
              output += delta;
              yield { type: "message.delta", runId, text: delta, timestamp: now() };
            }
            break;
          }
          case "agent.tool_call": {
            const id = String(params?.callId ?? randomUUID());
            const name = String(params?.tool ?? "tool");
            const args = params?.input && typeof params.input === "object" && !Array.isArray(params.input) ? (params.input as Record<string, unknown>) : { input: params?.input };
            toolNames.set(id, name);
            toolInputs.set(id, args);
            yield { type: "tool.requested", runId, call: { id, name, arguments: args }, timestamp: now() };
            break;
          }
          case "agent.tool_result": {
            const id = String(params?.callId ?? "");
            const name = toolNames.get(id) ?? "tool";
            const isError = params?.status === "error";
            yield { type: "tool.completed", runId, result: { id, name, result: params?.output ?? "", isError }, timestamp: now() };
            const args = toolInputs.get(id);
            const path = args && (args.path ?? args.file_path ?? args.filePath);
            if (!isError && typeof path === "string" && EDIT_TOOLS.has(name.toLowerCase())) {
              yield { type: "artifact.produced", runId, artifact: { id, path, kind: "file", description: `${name} ${path}` }, timestamp: now() };
            }
            break;
          }
          case "agent.permission_request": {
            const approvalId = String(params?.requestId ?? randomUUID());
            const tool = String(params?.tool ?? "ferramenta");
            const command = typeof params?.command === "string" ? params.command : "";
            const pending: PendingApproval = { sessionId, workspaceId: this.workspaceId };
            pending.timer = setTimeout(() => {
              if (!this.approvals.delete(approvalId)) return;
              void this.connection.request("session.permission_respond", { sessionId, requestId: approvalId, decision: "deny" }, 5_000).catch(() => {});
              this.queues.get(sessionId)?.push({ kind: "approval-resolved", approvalId, decision: "expired" });
            }, this.approvalTimeoutMs);
            pending.timer.unref?.();
            this.approvals.set(approvalId, pending);
            yield {
              type: "approval.requested",
              runId,
              approval: {
                id: approvalId,
                action: tool,
                description: command ? `${tool}: ${command}` : `Permitir a ferramenta ${tool}`,
                sensitiveData: {
                  ...(command ? { command } : {}),
                  ...(params?.risk ? { risk: params.risk } : {}),
                  ...(params?.risco ? { risco: params.risco, motivoRisco: params.motivoRisco } : {}),
                },
              },
              timestamp: now(),
            };
            break;
          }
          case "agent.usage": {
            usage = usageFrom(params);
            yield { type: "usage.updated", runId, usage, timestamp: now() };
            break;
          }
          case "agent.complete": {
            const total = Number(params?.total_tokens) || 0;
            const input = Number(params?.input_tokens) || 0;
            const outTokens = Number(params?.output_tokens) || 0;
            if (!usage && (total || input || outTokens)) {
              usage = { promptTokens: input, completionTokens: outTokens, totalTokens: total || input + outTokens };
              yield { type: "usage.updated", runId, usage, timestamp: now() };
            }
            yield { type: "run.completed", runId, result: { output, usage, stopReason: aborted ? "cancelled" : stopReason(params?.reason) }, timestamp: now() };
            return;
          }
          case "agent.error": {
            if (aborted) {
              yield { type: "run.completed", runId, result: { output, usage, stopReason: "cancelled" }, timestamp: now() };
              return;
            }
            const fix = typeof params?.suggestedFix === "string" && params.suggestedFix ? ` (${params.suggestedFix})` : "";
            const err = Object.assign(new Error(`${String(params?.message ?? "Erro do openheinerss")}${fix}`), params?.code ? { code: params.code } : {});
            yield { type: "run.failed", runId, error: normalizeEngineError(err, { engineId: this.engineId }), timestamp: now() };
            return;
          }
          default:
            // agent.thinking e agent.raw não têm evento canônico.
            break;
        }
      }
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onAbort);
      this.queues.delete(sessionId);
      for (const [id, p] of this.approvals) {
        if (p.sessionId !== sessionId) continue;
        if (p.timer) clearTimeout(p.timer);
        this.approvals.delete(id);
      }
    }
  }

  private rpcError(error: unknown): Error {
    if (error instanceof JsonRpcError) {
      const data = error.data as { suggestedFix?: string } | undefined;
      return Object.assign(new Error(`${error.message}${data?.suggestedFix ? ` (${data.suggestedFix})` : ""}`), { code: error.code });
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private onNotification(method: string, params: any): void {
    if (!method.startsWith("agent.")) return;
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : "";
    this.queues.get(sessionId)?.push({ kind: "notification", method, params });
  }

  private clearApprovals(): void {
    for (const p of this.approvals.values()) if (p.timer) clearTimeout(p.timer);
    this.approvals.clear();
  }
}

function usageFrom(params: any): AgentUsage {
  const promptTokens = Number(params?.inputTokens) || 0;
  const completionTokens = Number(params?.outputTokens) || 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Number(params?.totalTokens) || promptTokens + completionTokens,
    ...(params?.costUsd ? { costUsd: Number(params.costUsd) } : {}),
  };
}

function stopReason(reason: unknown): string {
  const r = String(reason ?? "").toLowerCase();
  if (!r || r === "finished" || r === "completed" || r === "end_turn" || r === "stop") return "completed";
  if (r === "aborted" || r === "cancelled" || r === "canceled" || r === "interrupted") return "cancelled";
  return r;
}
