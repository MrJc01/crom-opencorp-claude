import { EngineError } from "./errors.js";

export type CapabilitySupportLevel = "unsupported" | "declared" | "integrated" | "verified";

export type EngineTransport = "spawn_cli" | "http_server" | "stdio_jsonrpc" | "embedded";

export interface FeatureCapability {
  level: CapabilitySupportLevel;
  notes?: string;
  flags?: string[];
}

export type FeatureKey =
  | "streaming"
  | "continuation"
  | "fork"
  | "hitl"
  | "tools"
  | "mcp"
  | "images"
  | "cancellation";

export interface EngineCapabilityManifest {
  engineId: string;
  name: string;
  transport: EngineTransport;
  features: Record<FeatureKey, FeatureCapability>;
  supportsConversation?: boolean;
  /** Limites padrão de execução (ms); o núcleo usa isto em vez de conhecer o id do motor. */
  limits?: { tetoMs?: number; inatividadeMs?: number };
  /** Prefixos de modelo que o motor executa (ex.: ["claude-"]); ausente = qualquer modelo. */
  modelPrefixes?: string[];
  /** Arquivos de instrução do workspace que o motor lê sozinho (ex.: ["CLAUDE.md"], ["AGENTS.md"]). */
  instructionFiles?: string[];
  /** Variáveis de ambiente de credencial que o motor aceita. */
  credentialEnvVars?: string[];
  /** Provedor implícito das contas do motor, para mapear conta → variável de ambiente. */
  credentialDefaultProvider?: string;
  /** Valores aceitos em `AgentRunInput.toolPolicy.mode`; ausente = o motor ignora a política. */
  toolPolicyModes?: Array<"ask" | "auto-edits" | "deny" | "allow-all">;
  /** Tipos de evento opcionais que o motor emite (`artifact.produced`, `session.updated`...). */
  emits?: string[];
  details?: Record<string, unknown>;
}

export function isCapabilityAvailable(
  manifest: EngineCapabilityManifest,
  feature: FeatureKey
): boolean {
  const cap = manifest?.features?.[feature];
  if (!cap) return false;
  return cap.level === "integrated" || cap.level === "verified";
}

/** Teto/inatividade padrão declarados pelo manifest; `undefined` = usar o padrão global. */
export function manifestLimits(manifest: EngineCapabilityManifest): { tetoMs?: number; inatividadeMs?: number } {
  return manifest.limits ?? {};
}

/** O motor executa este modelo? Sem `modelPrefixes` aceita qualquer um. */
export function manifestAcceptsModel(manifest: EngineCapabilityManifest, modelId: string): boolean {
  const p = manifest.modelPrefixes;
  return !p || p.length === 0 || p.some((x) => modelId.startsWith(x));
}

export function manifestSupportsConversation(manifest: EngineCapabilityManifest): boolean {
  if (typeof manifest.supportsConversation === "boolean") {
    return manifest.supportsConversation;
  }
  return manifest.features?.continuation?.level !== "unsupported";
}

export class InvalidEngineManifestError extends EngineError {
  constructor(engineId: string, reason: string) {
    super("ENGINE_CAPABILITY_UNAVAILABLE", `Manifesto do motor "${engineId}" é inválido: ${reason}`, {
      engineId,
    });
  }
}

export function validateEngineCapabilityManifest(raw: unknown): EngineCapabilityManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new InvalidEngineManifestError("unknown", "esperava um objeto de manifesto");
  }

  const m = raw as Partial<EngineCapabilityManifest>;
  if (!m.engineId || typeof m.engineId !== "string" || !m.engineId.trim()) {
    throw new InvalidEngineManifestError("unknown", "campo 'engineId' é obrigatório");
  }

  const engineId = m.engineId.trim().toLowerCase();

  const validTransports: EngineTransport[] = ["spawn_cli", "http_server", "stdio_jsonrpc", "embedded"];
  if (!m.transport || !validTransports.includes(m.transport)) {
    throw new InvalidEngineManifestError(
      engineId,
      `campo 'transport' deve ser um dos: ${validTransports.join(", ")}`
    );
  }

  const requiredFeatures: FeatureKey[] = [
    "streaming",
    "continuation",
    "fork",
    "hitl",
    "tools",
    "mcp",
    "images",
    "cancellation",
  ];

  if (!m.features || typeof m.features !== "object") {
    throw new InvalidEngineManifestError(engineId, "campo 'features' é obrigatório");
  }

  const validLevels: CapabilitySupportLevel[] = ["unsupported", "declared", "integrated", "verified"];

  for (const feat of requiredFeatures) {
    const f = m.features[feat];
    if (!f || typeof f !== "object" || !validLevels.includes(f.level)) {
      throw new InvalidEngineManifestError(
        engineId,
        `feature '${feat}' deve possuir nível válido: ${validLevels.join(", ")}`
      );
    }
  }

  return raw as EngineCapabilityManifest;
}

export const CANONICAL_ENGINE_MANIFESTS: Record<string, EngineCapabilityManifest> = {
  "opencode": {
    engineId: "opencode",
    name: "OpenCode Engine",
    transport: "http_server",
    supportsConversation: true,
    features: {
      streaming: { level: "integrated", notes: "Via SSE do servidor HTTP" },
      continuation: { level: "integrated", flags: ["--session", "--continue"] },
      fork: { level: "integrated", flags: ["--fork"] },
      hitl: { level: "integrated", notes: "Suportado via rotas de aprovação" },
      tools: { level: "integrated", notes: "Ferramentas nativas e customizadas" },
      mcp: { level: "integrated", notes: "Integração MCP do OpenCode" },
      images: { level: "integrated", notes: "Modelos multimodais suportados" },
      cancellation: { level: "integrated", notes: "AbortSignal e DELETE em sessões" },
    },
  },
  "codex": {
    engineId: "codex",
    name: "OpenAI Codex CLI",
    transport: "stdio_jsonrpc",
    supportsConversation: true,
    features: {
      streaming: { level: "integrated", flags: ["item/agentMessage/delta"] },
      continuation: { level: "integrated", flags: ["thread/resume"] },
      fork: { level: "integrated", flags: ["thread/fork"] },
      hitl: { level: "integrated", notes: "Solicitações JSON-RPC encaminhadas ao HITL do Secretário" },
      tools: { level: "integrated", notes: "commandExecution e fileChange do app-server/exec traduzidos em tool.requested/tool.completed" },
      mcp: { level: "declared", notes: "Suporte MCP do Codex" },
      images: { level: "declared", notes: "Multimodal via modelos OpenAI" },
      cancellation: { level: "integrated", flags: ["turn/interrupt"], notes: "Interrupção do turno via JSON-RPC" },
    },
  },
  "claude-code": {
    engineId: "claude-code",
    name: "Anthropic Claude Code",
    transport: "spawn_cli",
    supportsConversation: false, // sem ConversationRuntime integrado (só execução one-shot via driver)
    features: {
      streaming: { level: "declared", flags: ["--verbose"] },
      continuation: { level: "declared", flags: ["--resume", "--continue"] },
      fork: { level: "declared", flags: ["--fork-session"] },
      hitl: { level: "declared", notes: "Confirmações manuais do CLI" },
      tools: { level: "declared", notes: "Ferramentas nativas do Claude Code" },
      mcp: { level: "declared", notes: "Configuração MCP em .claude.json" },
      images: { level: "declared", notes: "Suporte multimodal Anthropic" },
      cancellation: { level: "integrated", notes: "SIGTERM do subprocesso" },
    },
  },
  "antigravity": {
    engineId: "antigravity",
    name: "Google Antigravity (AGY)",
    transport: "spawn_cli",
    supportsConversation: false, // sem ConversationRuntime integrado (só execução one-shot via driver)
    features: {
      streaming: { level: "declared" },
      continuation: { level: "declared", flags: ["--conversation", "--continue"] },
      fork: { level: "unsupported", notes: "Sem suporte nativo a fork no CLI" },
      hitl: { level: "declared", notes: "Políticas de permissão skip-permissions/prompt" },
      tools: { level: "declared" },
      mcp: { level: "declared" },
      images: { level: "declared", notes: "Gemini Vision" },
      cancellation: { level: "integrated" },
    },
  },
  "copilot": {
    engineId: "copilot",
    name: "GitHub Copilot CLI",
    transport: "stdio_jsonrpc",
    supportsConversation: true,
    details: { protocol: "acp", protocolVersion: 1, command: "copilot --acp", verifiedHandshake: "1.0.88" },
    features: {
      streaming: { level: "integrated", notes: "ACP session/update agent_message_chunk" },
      continuation: { level: "integrated", notes: "ACP session/load (loadSession: true)" },
      fork: { level: "unsupported", notes: "Não anuncia sessionCapabilities.fork (1.0.88)" },
      hitl: { level: "integrated", notes: "ACP session/request_permission" },
      tools: { level: "integrated", notes: "ACP tool_call/tool_call_update" },
      mcp: { level: "declared", notes: "mcpCapabilities http/sse anunciadas; OpenCorp ainda não repassa servidores" },
      images: { level: "declared", notes: "promptCapabilities.image anunciada; OpenCorp envia só texto" },
      cancellation: { level: "integrated", notes: "ACP session/cancel" },
    },
  },
  "cursor": {
    engineId: "cursor",
    name: "Cursor Agent CLI",
    transport: "spawn_cli",
    supportsConversation: false, // sem ConversationRuntime integrado (só execução one-shot via driver)
    features: {
      streaming: { level: "declared" },
      continuation: { level: "declared", flags: ["--resume", "--continue"] },
      fork: { level: "unsupported" },
      hitl: { level: "declared" },
      tools: { level: "declared" },
      mcp: { level: "unsupported" },
      images: { level: "unsupported" },
      cancellation: { level: "integrated" },
    },
  },
  "crom-agente": {
    engineId: "crom-agente",
    name: "Crom-Agente (Go)",
    transport: "spawn_cli",
    supportsConversation: false, // sem ConversationRuntime integrado (só execução one-shot via driver)
    features: {
      streaming: { level: "integrated", notes: "Streaming de chunks no stdout" },
      continuation: { level: "integrated", flags: ["--session"] },
      fork: { level: "unsupported", notes: "Sem fork nativo" },
      hitl: { level: "integrated", notes: "Controle de permissão via --permission-mode" },
      tools: { level: "integrated", notes: "Tools integradas pelo binário Crom" },
      mcp: { level: "unsupported" },
      images: { level: "unsupported" },
      cancellation: { level: "integrated", notes: "SIGTERM/SIGKILL do subprocesso" },
    },
  },
  "aider": {
    engineId: "aider",
    name: "Aider CLI",
    transport: "spawn_cli",
    supportsConversation: false,
    features: {
      streaming: { level: "unsupported" },
      continuation: { level: "unsupported", notes: "Sem resume/continue nativo por flag" },
      fork: { level: "unsupported" },
      hitl: { level: "unsupported" },
      tools: { level: "declared" },
      mcp: { level: "unsupported" },
      images: { level: "unsupported" },
      cancellation: { level: "integrated" },
    },
  },
  "mimo": {
    engineId: "mimo",
    name: "Xiaomi MiMo Code",
    transport: "stdio_jsonrpc",
    supportsConversation: true,
    details: { protocol: "acp", protocolVersion: 1, command: "mimo acp", verifiedHandshake: "0.1.15" },
    features: {
      streaming: { level: "integrated", notes: "ACP session/update agent_message_chunk" },
      continuation: { level: "integrated", notes: "ACP session/resume (sessionCapabilities.resume)" },
      fork: { level: "integrated", notes: "ACP session/fork (sessionCapabilities.fork, instável na spec)" },
      hitl: { level: "integrated", notes: "ACP session/request_permission" },
      tools: { level: "integrated", notes: "ACP tool_call/tool_call_update" },
      mcp: { level: "declared", notes: "mcpCapabilities http/sse anunciadas; OpenCorp ainda não repassa servidores" },
      images: { level: "declared", notes: "Modelos multimodais MiMo; OpenCorp envia só texto" },
      cancellation: { level: "integrated", notes: "ACP session/cancel" },
    },
  },
};
