import type { AgentEvent } from "./events.js";
import type { MensagemHistorico } from "./event-log.js";
import type { EngineCapabilityManifest } from "./manifests.js";
import type { EngineInstallStatus, EngineTokenUsage } from "./types.js";
import type { EngineAuthStatus } from "./credentials-bridge.js";

export type { EngineAuthStatus, EngineInstallStatus, EngineTokenUsage };

export interface EngineInstallResult {
  success: boolean;
  path: string;
  version: string;
  log: string;
}

export interface EngineInstaller {
  readonly engineId: string;
  status(homeDir: string): Promise<EngineInstallStatus>;
  install(homeDir: string, onProgress?: (msg: string) => void): Promise<EngineInstallResult>;
  uninstall?(homeDir: string): Promise<void>;
}

export interface EngineLoginInput {
  accountId?: string;
  tokenOuChave?: string;
  authType?: string;
}

export interface EngineAuthenticator {
  readonly engineId: string;
  status(homeDir: string, accountId?: string): Promise<EngineAuthStatus>;
  /**
   * Sessão nativa do CLI verificada pelo comando oficial de status (ex.:
   * `codex login status`), nunca por leitura de arquivos internos. `undefined`
   * quando o motor não oferece verificação.
   */
  isLoggedIn?(homeDir: string): Promise<boolean | undefined>;
  login?(input: EngineLoginInput): Promise<{ success: boolean; message: string }>;
  logout?(accountId?: string): Promise<void>;
  fetchTokens?(
    homeDir: string,
    accountCredentials?: { tokenOuChave?: string; authType?: string }
  ): Promise<EngineTokenUsage>;
}

/**
 * Política de ferramentas/permissões pedida pelo núcleo. Cada adaptador traduz para o mecanismo do seu
 * motor (permissionMode do SDK, --permission-mode, ACP request_permission...) e ignora o que não suporta,
 * conforme `manifest.features.tools/hitl`.
 */
export interface ToolPolicy {
  /** `ask` = pedir aprovação (HITL); `auto-edits` = aceitar edições; `deny` = negar tudo; `allow-all` = sem perguntar. */
  mode?: "ask" | "auto-edits" | "deny" | "allow-all";
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface AgentRunInput {
  runId?: string;
  workspaceId: string;
  workspacePath: string;
  sessionId: string;
  agentId: string;
  model: string;
  prompt: string;
  homeDir: string;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
  /** Conta explícita; falha antes do spawn se não autorizada para o workspace. */
  accountId?: string;
  /** Política de ferramentas/permissões; ausente = padrão do motor. */
  toolPolicy?: ToolPolicy;
  /** Sessão nativa a retomar (valor de um `session.updated` anterior). Exige `features.continuation`. */
  resumeSessionId?: string;
  /** Texto acrescentado ao prompt de sistema (corpo do agente, skills, contexto do workspace). */
  systemPromptAppend?: string;
  /** Teto de turnos do agente, quando o motor suporta. */
  maxTurns?: number;
}

export interface AgentRunner {
  readonly engineId: string;
  run(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  cancel?(runId: string): Promise<void>;
}

export interface ConversationCreateInput {
  conversationId?: string;
  workspaceId: string;
  workspacePath: string;
  model: string;
  homeDir: string;
  title?: string;
}

export interface ConversationRef {
  id: string;
  engineId: string;
  workspaceId: string;
}

export interface ConversationMessageInput {
  text: string;
  role?: "user" | "system";
}

export interface ConversationState {
  ref: ConversationRef;
  status: "active" | "idle" | "closed" | "error";
  lastActiveAt: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationRuntime {
  readonly engineId: string;
  create(input: ConversationCreateInput): Promise<ConversationRef>;
  send(ref: ConversationRef, input: ConversationMessageInput, signal?: AbortSignal): AsyncIterable<AgentEvent>;
  resume(ref: ConversationRef): Promise<ConversationState>;
  fork?(ref: ConversationRef): Promise<ConversationRef>;
  /**
   * Responde a um `approval.requested` emitido por `send`. Retorna `false`
   * quando o ID não pertence ao workspace informado (ou não está pendente).
   */
  respondApproval?(
    approvalId: string,
    decision: "approve" | "reject",
    scope: { workspaceId: string }
  ): Promise<boolean>;
  /**
   * Histórico de conversas anteriores ao log de eventos do servidor (`event-log.ts`). Opcional: sem ele, a
   * conversa só tem histórico se foi gravada no log.
   */
  history?(ref: ConversationRef): Promise<MensagemHistorico[]>;
  close(ref: ConversationRef): Promise<void>;
}

export interface ModelDescriptor {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  isFree?: boolean;
}

export interface ModelProbeResult {
  available: boolean;
  latencyMs?: number;
  reason?: string;
}

export interface ModelCatalogSource {
  readonly engineId: string;
  listModels(accountId?: string): Promise<ModelDescriptor[]>;
  probe?(model: { provider: string; id: string }): Promise<ModelProbeResult>;
}

/**
 * Como encaixar um motor JSON-RPC por STDIO/WebSocket (ex.: openheinerss, em Go) — esqueleto, sem implementação:
 *
 * 1. `manifest`: `transport: "stdio_jsonrpc"`; declare `features` só com o que o servidor anuncia no handshake
 *    (`initialize`); preencha `limits`, `modelPrefixes` e `instructionFiles` do manifest (ver manifests.ts).
 * 2. `installer`/`authenticator`: verificam o binário e a sessão por comando oficial de status do motor.
 * 3. `runner.run(input)`: abre (ou reutiliza, via ProcessRegistry) o processo, envia `session/new`+`prompt`
 *    com `toolPolicy`/`systemPromptAppend`/`resumeSessionId` e traduz as notificações em AgentEvent:
 *    delta → `message.delta`; tool_call → `tool.requested`/`tool.completed`; pedido de permissão →
 *    `approval.requested` (resposta via `conversationRuntime.respondApproval`); arquivo gerado →
 *    `artifact.produced`; id de sessão → `session.updated`; fim → `run.completed`/`run.failed`.
 * 4. `cancel`: notificação `session/cancel` (ou fechar o socket). Veja `acp/` para um adaptador pronto desse formato.
 * 5. Registre com `engineRegistry.registerAdapter(...)`; o núcleo só consulta manifest e eventos, nunca o id.
 *    Teste com o mesmo contrato de `tests/engine-conformance.test.ts` e o fake de `tests/engine-fake-adapter.test.ts`.
 */
export interface EngineAdapter {
  readonly engineId: string;
  readonly name: string;
  readonly manifest: EngineCapabilityManifest;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner;
  readonly conversationRuntime?: ConversationRuntime;
  readonly modelCatalog?: ModelCatalogSource;
}
