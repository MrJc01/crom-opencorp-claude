import type { EngineError } from "./errors.js";

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  name: string;
  result: unknown;
  isError?: boolean;
}

export interface ApprovalRequest {
  id: string;
  action: string;
  description: string;
  sensitiveData?: Record<string, unknown>;
}

export interface AgentUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface AgentResult {
  output: string;
  usage?: AgentUsage;
  stopReason?: "completed" | "cancelled" | "max_turns" | "timeout" | string;
}

/** Arquivo/artefato produzido pelo motor durante a execução (relatório, vídeo, patch). */
export interface ArtifactRef {
  id: string;
  /** Caminho relativo ao workspace ou URI; o motor decide, o núcleo só repassa. */
  path: string;
  kind?: "file" | "image" | "video" | "audio" | "patch" | "report" | string;
  mimeType?: string;
  description?: string;
}

export type AgentEvent =
  | { type: "run.started"; runId: string; timestamp: string; engineId: string }
  | { type: "message.delta"; runId: string; text: string; timestamp?: string }
  | { type: "tool.requested"; runId: string; call: ToolCall; timestamp?: string }
  | { type: "tool.completed"; runId: string; result: ToolResult; timestamp?: string }
  | { type: "approval.requested"; runId: string; approval: ApprovalRequest; timestamp?: string }
  | { type: "approval.resolved"; runId: string; approvalId: string; decision: "approved" | "rejected" | "expired"; timestamp?: string }
  | { type: "usage.updated"; runId: string; usage: AgentUsage; timestamp?: string }
  | { type: "run.completed"; runId: string; result: AgentResult; timestamp?: string }
  | { type: "run.failed"; runId: string; error: EngineError; timestamp?: string }
  | { type: "artifact.produced"; runId: string; artifact: ArtifactRef; timestamp?: string }
  /** O motor criou/retomou uma sessão nativa; o núcleo guarda `nativeSessionId` para o resume. */
  | { type: "session.updated"; runId: string; nativeSessionId: string; resumed?: boolean; timestamp?: string };
