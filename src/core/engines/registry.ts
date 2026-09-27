import type { EngineDriver, EngineInstallStatus, EngineHealth, EngineTokenUsage } from "./types.js";
import { AcpAdapter } from "./acp/acp-adapter.js";
import { COPILOT_ACP, MIMO_ACP } from "./acp/vendors.js";
import { OpencodeDriver } from "./drivers/opencode-driver.js";
import { CromAgenteDriver } from "./drivers/crom-agente-driver.js";
import { ClaudeCodeDriver } from "./drivers/claude-code-driver.js";
import { AntigravityDriver } from "./drivers/antigravity-driver.js";
import { CursorDriver } from "./drivers/cursor-driver.js";
import { CopilotDriver } from "./drivers/copilot-driver.js";
import { CodexDriver } from "./drivers/codex-driver.js";
import { AiderDriver } from "./drivers/aider-driver.js";
import { MimoDriver } from "./drivers/mimo-driver.js";
import { EngineNotFoundError } from "./errors.js";
import { LegacyDriverAdapter } from "./adapter-compat.js";
import { OpenCodeAdapter } from "./adapters/opencode-adapter.js";
import { CodexAdapter } from "./adapters/codex-adapter.js";
import type { EngineAdapter } from "./ports.js";
import {
  validateEngineCapabilityManifest,
  InvalidEngineManifestError,
  CANONICAL_ENGINE_MANIFESTS,
  type EngineCapabilityManifest,
  manifestSupportsConversation,
} from "./manifests.js";

export interface EngineSummary {
  id: string;
  name: string;
  description: string;
  category: "cli" | "daemon" | "hybrid";
  maintainer: string;
  supportedModelsHint: string[];
  installed: boolean;
  isManaged: boolean;
  path: string | null;
  version: string | null;
  health?: EngineHealth;
  /** Tem ConversationRuntime: pode ser o motor do Secretário. */
  supportsConversation: boolean;
}

export class EngineRegistry {
  private static instance: EngineRegistry | null = null;
  private drivers = new Map<string, EngineDriver>();
  private adapters = new Map<string, EngineAdapter>();

  private constructor() {
    this.register(new OpencodeDriver());
    this.register(new CromAgenteDriver());
    this.register(new ClaudeCodeDriver());
    this.register(new AntigravityDriver());
    this.register(new CursorDriver());
    this.register(new CopilotDriver());
    this.register(new CodexDriver());
    this.register(new AiderDriver());
    this.register(new MimoDriver());

    // Registra adaptadores canônicos com AgentRunner e ConversationRuntime
    this.registerAdapter(new OpenCodeAdapter());
    this.registerAdapter(new CodexAdapter());
    // Copilot e MiMo via ACP (D5): mesma infraestrutura, diferença só na configuração.
    this.registerAdapter(new AcpAdapter({ vendor: COPILOT_ACP, driver: this.get("copilot")! }));
    this.registerAdapter(new AcpAdapter({ vendor: MIMO_ACP, driver: this.get("mimo")! }));
  }

  public static getInstance(): EngineRegistry {
    if (!EngineRegistry.instance) {
      EngineRegistry.instance = new EngineRegistry();
    }
    return EngineRegistry.instance;
  }

  public register(driver: EngineDriver, manifest?: EngineCapabilityManifest): void {
    this.drivers.set(driver.id, driver);
    this.adapters.set(driver.id, new LegacyDriverAdapter(driver, manifest));
  }

  public registerAdapter(adapter: EngineAdapter): void {
    if (!adapter.manifest) {
      throw new InvalidEngineManifestError(adapter.engineId || "unknown", "manifesto ausente");
    }
    validateEngineCapabilityManifest(adapter.manifest);
    this.adapters.set(adapter.engineId, adapter);
  }

  public get(id: string): EngineDriver | undefined {
    return this.drivers.get(id);
  }

  public getAdapter(id: string): EngineAdapter | undefined {
    return this.adapters.get(id);
  }

  public getManifest(id: string): EngineCapabilityManifest | undefined {
    const adapter = this.adapters.get(id);
    if (adapter) return adapter.manifest;
    return CANONICAL_ENGINE_MANIFESTS[id];
  }

  public listManifests(): EngineCapabilityManifest[] {
    return Array.from(this.adapters.values()).map((a) => a.manifest);
  }

  public list(): EngineDriver[] {
    return Array.from(this.drivers.values());
  }

  public listAdapters(): EngineAdapter[] {
    return Array.from(this.adapters.values());
  }

  public resolveDriver(harness?: string): EngineDriver {
    const id = (harness || "opencode").trim().toLowerCase();
    const driver = this.drivers.get(id);
    if (driver) return driver;

    // Aliases amigáveis
    if (id === "crom" || id === "cromagente") {
      const c = this.drivers.get("crom-agente");
      if (c) return c;
    }
    if (id === "claude" || id === "claudecode") {
      const cl = this.drivers.get("claude-code");
      if (cl) return cl;
    }
    if (id === "agy") {
      const ag = this.drivers.get("antigravity");
      if (ag) return ag;
    }
    if (id === "cursor-agent" || id === "cursorcli") {
      const cur = this.drivers.get("cursor");
      if (cur) return cur;
    }
    if (id === "github-copilot" || id === "gh-copilot" || id === "copilot-cli") {
      const cop = this.drivers.get("copilot");
      if (cop) return cop;
    }
    if (id === "openai-codex" || id === "openai") {
      const cd = this.drivers.get("codex");
      if (cd) return cd;
    }

    throw new EngineNotFoundError(id);
  }

  public resolveAdapter(harness?: string): EngineAdapter {
    const id = (harness || "opencode").trim().toLowerCase();
    const direct = this.adapters.get(id);
    if (direct) return direct;

    const driver = this.resolveDriver(harness);
    const adapter = this.adapters.get(driver.id);
    if (adapter) return adapter;
    const created = new LegacyDriverAdapter(driver);
    this.adapters.set(driver.id, created);
    return created;
  }

  public async listSummaries(homeDir: string, checkHealth = false): Promise<EngineSummary[]> {
    const promises = Array.from(this.drivers.values()).map(async (driver) => {
      const status: EngineInstallStatus = await driver.isInstalled(homeDir);
      let health: EngineHealth | undefined;
      if (checkHealth && status.installed) {
        health = await driver.checkHealth(homeDir).catch((e) => ({
          healthy: false,
          statusText: `Erro no health check: ${e?.message || e}`,
        }));
      }

      return {
        id: driver.id,
        name: driver.name,
        description: driver.description,
        category: driver.category,
        maintainer: driver.maintainer,
        supportedModelsHint: driver.supportedModelsHint,
        installed: status.installed,
        isManaged: status.isManaged,
        path: status.path,
        version: status.version,
        health,
        // Pode ser o motor do Secretário (tem ConversationRuntime).
        supportsConversation: (() => {
          const manifest = this.getManifest(driver.id);
          return manifest ? manifestSupportsConversation(manifest) : false;
        })(),
      };
    });

    return Promise.all(promises);
  }

  public async fetchLiveTokens(
    engineId: string,
    homeDir: string,
    accountCredentials?: { tokenOuChave?: string; authType?: string }
  ): Promise<EngineTokenUsage> {
    const driver = this.resolveDriver(engineId);
    return driver.fetchLiveTokens(homeDir, accountCredentials);
  }

  public async fetchAllLiveTokens(homeDir: string): Promise<Record<string, EngineTokenUsage>> {
    const results: Record<string, EngineTokenUsage> = {};
    const promises = Array.from(this.drivers.values()).map(async (driver) => {
      try {
        const usage = await driver.fetchLiveTokens(homeDir);
        results[driver.id] = usage;
      } catch (err: any) {
        results[driver.id] = {
          motorId: driver.id,
          motorName: driver.name,
          source: "error",
          provedor: driver.name,
          tokensDisponiveis: 0,
          statusCota: "desconhecido",
          mensagem: `Erro ao consultar tokens: ${err?.message || err}`,
          consultadoEm: new Date().toISOString(),
        };
      }
    });

    await Promise.all(promises);
    return results;
  }
}

export const engineRegistry = EngineRegistry.getInstance();
