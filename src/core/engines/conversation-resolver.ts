import { opencorpHome } from "../../utils/paths.js";
import { SettingsStore, type Origem } from "../contexts/workspace/settings-store.js";
import { EngineRegistry } from "./registry.js";
import type { EngineAdapter } from "./ports.js";
import {
  manifestSupportsConversation,
  type EngineCapabilityManifest,
} from "./manifests.js";
import {
  EngineNotFoundError,
  EngineUnavailableError,
  EngineAuthRequiredError,
  PreflightBinaryMissingError,
  EngineCapabilityUnavailableError,
} from "./errors.js";
import { checkEngineAuthStatusAsync, type EngineAuthStatus } from "./credentials-bridge.js";

export type EngineConfigOrigin = "workspace_override" | "global_default" | "legacy_default";

export interface ConversationPreflightResult {
  ok: boolean;
  installed: boolean;
  binaryPath: string | null;
  authenticated: boolean;
  authMethod?: string;
  supportsConversation: boolean;
  issues: string[];
  recommendation?: string;
}

export interface ConversationResolutionResult {
  engineId: string;
  source: EngineConfigOrigin;
  adapter: EngineAdapter;
  manifest: EngineCapabilityManifest;
  authStatus: EngineAuthStatus;
  preflight: ConversationPreflightResult;
}

export interface ResolveConversationRuntimeOptions {
  workspaceId?: string;
  workspaceDir?: string;
  homeDir?: string;
  engineOverride?: string;
  strict?: boolean;
}

export class ConversationRuntimeResolver {
  private readonly settingsStore: SettingsStore;
  private readonly registry: EngineRegistry;
  private readonly defaultHomeDir: string;

  constructor(opts: {
    settingsStore?: SettingsStore;
    registry?: EngineRegistry;
    homeDir?: string;
  } = {}) {
    this.defaultHomeDir = opts.homeDir ?? opencorpHome();
    this.settingsStore = opts.settingsStore ?? new SettingsStore({ homeDir: this.defaultHomeDir });
    this.registry = opts.registry ?? EngineRegistry.getInstance();
  }

  /**
   * Resolve o motor conversacional respeitando estritamente a precedência:
   * 1. workspace.conversationEngineOverride (ou options.engineOverride)
   * 2. settings.default_conversation_engine
   * 3. EngineUnavailableError (proibido fallback silencioso)
   */
  async resolve(options: ResolveConversationRuntimeOptions = {}): Promise<ConversationResolutionResult> {
    const home = options.homeDir ?? this.defaultHomeDir;
    const strict = options.strict ?? true;

    let engineIdCandidate: string | undefined;
    let source: EngineConfigOrigin = "global_default";

    // 1. Override explícito fornecido nas opções da chamada
    if (options.engineOverride && options.engineOverride.trim()) {
      engineIdCandidate = options.engineOverride.trim();
      source = "workspace_override";
    } else {
      // Consulta SettingsStore (workspace e global)
      let settings;
      let origens: Map<string, Origem>;
      try {
        const resolucaoSettings = await this.settingsStore.resolve({
          workspaceId: options.workspaceId,
          workspaceDir: options.workspaceDir,
        });
        settings = resolucaoSettings.settings;
        origens = resolucaoSettings.origens;
      } catch (err) {
        throw new EngineUnavailableError(
          "unknown",
          `Falha ao resolver configurações do motor conversacional: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // 1.1 Override configurado no workspace
      if (settings.conversationEngineOverride && settings.conversationEngineOverride.trim()) {
        engineIdCandidate = settings.conversationEngineOverride.trim();
        source = "workspace_override";
      } else if (
        settings.default_conversation_engine &&
        origens.get("default_conversation_engine") === "workspace"
      ) {
        engineIdCandidate = settings.default_conversation_engine.trim();
        source = "workspace_override";
      } else if (settings.default_conversation_engine && settings.default_conversation_engine.trim()) {
        // 1.2 Default global
        engineIdCandidate = settings.default_conversation_engine.trim();
        source = "global_default";
      }
    }

    // 1.3 Se nenhum motor estiver configurado, erro explícito (sem fallback arbitrário)
    if (!engineIdCandidate || !engineIdCandidate.trim()) {
      throw new EngineUnavailableError(
        "unknown",
        "Nenhum motor conversacional configurado. Defina 'settings.default_conversation_engine' ou 'conversationEngineOverride' no workspace."
      );
    }

    const engineId = engineIdCandidate.trim().toLowerCase();

    // 2. Validação do registro do motor
    let adapter: EngineAdapter;
    try {
      adapter = this.registry.resolveAdapter(engineId);
    } catch (err) {
      if (err instanceof EngineNotFoundError) {
        const disponiveis = this.registry.list().map((d) => d.id);
        throw new EngineNotFoundError(engineId, disponiveis);
      }
      throw err;
    }

    const manifest = adapter.manifest;
    const issues: string[] = [];
    let recommendation: string | undefined;

    // 3. Validação de capacidade conversacional no manifesto / runtime
    const supportsConversation = Boolean(
      adapter.conversationRuntime || manifestSupportsConversation(manifest)
    );

    if (!supportsConversation) {
      issues.push(
        `O motor "${engineId}" não possui capacidade conversacional interativa declarada no manifesto.`
      );
      recommendation = `Selecione um motor conversacional compatível (como 'opencode' ou 'codex').`;
      if (strict) {
        throw new EngineCapabilityUnavailableError(engineId, "conversation", {
          details: {
            reason: issues[0],
            recommendation,
          },
        });
      }
    }

    // 4. Preflight de instalação do binário / ambiente
    let installed = false;
    let binaryPath: string | null = null;
    try {
      const installStatus = await adapter.installer.status(home);
      installed = Boolean(installStatus.installed);
      binaryPath = installStatus.path ?? null;
      if (!installed) {
        issues.push(`Binário do motor "${engineId}" não está instalado no ambiente.`);
        recommendation =
          recommendation ||
          `Instale o motor pela tela Configurações > Motores ou via POST /api/motores/${engineId}/install.`;
        if (strict) {
          throw new PreflightBinaryMissingError(engineId, {
            details: {
              path: binaryPath,
              recommendation,
            },
          });
        }
      }
    } catch (err) {
      if (err instanceof PreflightBinaryMissingError) {
        throw err;
      }
      issues.push(`Falha ao checar instalação do motor "${engineId}": ${err instanceof Error ? err.message : String(err)}`);
      if (strict) {
        throw new EngineUnavailableError(engineId, issues[issues.length - 1]);
      }
    }

    // 5. Preflight de autenticação não destrutiva
    let authStatus: EngineAuthStatus;
    try {
      if (adapter.authenticator && typeof adapter.authenticator.status === "function") {
        authStatus = await adapter.authenticator.status(home);
      } else {
        authStatus = await checkEngineAuthStatusAsync(engineId, home);
      }
      if (!authStatus.authenticated) {
        issues.push(
          `Motor "${engineId}" não está autenticado: ${authStatus.details || "credenciais ausentes"}`
        );
        recommendation = recommendation || authStatus.details || `Autentique o motor "${engineId}".`;
        if (strict) {
          throw new EngineAuthRequiredError(engineId, {
            details: {
              method: authStatus.method,
              details: authStatus.details,
              recommendation,
            },
          });
        }
      }
    } catch (err) {
      if (err instanceof EngineAuthRequiredError) {
        throw err;
      }
      authStatus = {
        authenticated: false,
        method: "preflight_error",
        details: err instanceof Error ? err.message : String(err),
      };
      issues.push(`Erro ao validar autenticação do motor "${engineId}": ${authStatus.details}`);
      if (strict) {
        throw new EngineAuthRequiredError(engineId, {
          details: {
            method: authStatus.method,
            details: authStatus.details,
          },
        });
      }
    }

    const ok = supportsConversation && installed && authStatus.authenticated && issues.length === 0;

    return {
      engineId,
      source,
      adapter,
      manifest,
      authStatus,
      preflight: {
        ok,
        installed,
        binaryPath,
        authenticated: authStatus.authenticated,
        authMethod: authStatus.method,
        supportsConversation,
        issues,
        recommendation,
      },
    };
  }
}

/**
 * Função utilitária standalone para resolução de runtime conversacional
 */
export async function resolveConversationRuntime(
  options: ResolveConversationRuntimeOptions = {}
): Promise<ConversationResolutionResult> {
  const resolver = new ConversationRuntimeResolver({ homeDir: options.homeDir });
  return resolver.resolve(options);
}
