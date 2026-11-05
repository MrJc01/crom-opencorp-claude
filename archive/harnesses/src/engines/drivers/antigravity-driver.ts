import { existsSync } from "node:fs";
import { installManagedEngine } from "../installer/managed-installer.js";
import { binaryOrPreflight, resolveEngineBinary } from "../installer/binary-resolver.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { join } from "node:path";
import {
  safeExecFile as execFileAsync,
  type EngineDriver,
  type EngineInstallStatus,
  type EngineHealth,
  type EngineExecutionOptions,
  type EngineTokenUsage,
} from "../types.js";
import { resolveEngineCredentials } from "../credentials-bridge.js";

export class AntigravityDriver implements EngineDriver {
  id = "antigravity";
  name = "Google Antigravity Engine (AGY)";
  description = "Runtime avançado de agentes com suporte nativo a skills, MCP, subagentes e IDE DeepMind";
  category = "hybrid" as const;
  maintainer = "Google DeepMind";
  supportedModelsHint = [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.7-flash-high",
    "gemini-3.6-flash-high",
    "gemini-3.1-pro-high",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
  ];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "agy");
    if (existsSync(managedBin)) {
      try {
        const { stdout } = await execFileAsync(managedBin, ["--version"], { timeout: 3000 });
        return {
          installed: true,
          isManaged: true,
          path: managedBin,
          version: stdout.trim() || "v2.0 (isolado)",
        };
      } catch {
        return { installed: true, isManaged: true, path: managedBin, version: "v2.0" };
      }
    }

    const candidatos = [
      "/usr/local/bin/agy",
      "/usr/bin/agy",
      join(homeDir, ".local", "bin", "agy"),
      join(homeDir, ".antigravity", "bin", "agy"),
    ];

    for (const cand of candidatos) {
      if (existsSync(cand)) {
        try {
          const { stdout } = await execFileAsync(cand, ["--version"], { timeout: 3000 });
          return {
            installed: true,
            isManaged: false,
            path: cand,
            version: stdout.trim() || "v2.0 (sistema)",
          };
        } catch {
          return { installed: true, isManaged: false, path: cand, version: "v2.0" };
        }
      }
    }

    try {
      const { stdout } = await execFileAsync("which", ["agy"], { timeout: 2000 });
      const p = stdout.trim();
      if (p && existsSync(p)) {
        return { installed: true, isManaged: false, path: p, version: "v2.0" };
      }
    } catch {}

    return { installed: false, isManaged: false, path: null, version: null };
  }

  async install(
    homeDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ success: boolean; path: string; version: string; log: string }> {
    // Somente instalação gerenciada com artefato fixado e SHA-256 aprovado;
    // sem artefato aprovado, falha com instruções de instalação manual.
    return installManagedEngine(this.id, homeDir, onProgress);
  }

  async checkHealth(homeDir: string): Promise<EngineHealth> {
    const status = await this.isInstalled(homeDir);
    if (!status.installed || !status.path) {
      return { healthy: false, statusText: "Antigravity não instalado no sistema ou em ~/.opencorp/bin" };
    }

    const t0 = Date.now();
    try {
      const { stdout } = await execFileAsync(status.path, ["--version"], { timeout: 3000 });
      return {
        healthy: true,
        statusText: `OK — Versão ${stdout.trim() || status.version} (${status.isManaged ? "Isolado" : "Sistema"})`,
        latencyMs: Date.now() - t0,
        details: { path: status.path, isManaged: status.isManaged },
      };
    } catch (err: any) {
      return {
        healthy: false,
        statusText: `Falha ao executar ${status.path}: ${err?.message || err}`,
        latencyMs: Date.now() - t0,
      };
    }
  }

  async prepareExecution(opts: EngineExecutionOptions): Promise<{
    binary: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }> {
    const status = await this.isInstalled(opts.homeDir);
    const bin = binaryOrPreflight(this.id, status);

    const args: string[] = ["-p", opts.prompt, "--dangerously-skip-permissions"];
    if (opts.model && opts.model.trim()) {
      args.push("--model", opts.model.trim());
    }

    const env: Record<string, string> = await resolveEngineSpawnEnv(this.id, opts, {
      ANTIGRAVITY_WORKSPACE: opts.workspacePath,
      ...(opts.envOverrides || {}),
    });

    return {
      binary: bin,
      args,
      env,
      cwd: opts.workspacePath,
    };
  }

  async fetchLiveTokens(
    homeDir: string,
    accountCredentials?: { tokenOuChave?: string; authType?: string }
  ): Promise<EngineTokenUsage> {
    const creds = resolveEngineCredentials(homeDir);
    const key = accountCredentials?.tokenOuChave || creds.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
    const now = new Date().toISOString();

    if (key) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`, {
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const models = data?.models || [];
          const geminiFlash = models.find((m: any) => m.name?.includes("gemini-2.5-flash") || m.name?.includes("gemini-1.5-flash"));
          const inputLimit = geminiFlash?.inputTokenLimit || 1_048_576;
          const outputLimit = geminiFlash?.outputTokenLimit || 8_192;

          return {
            motorId: this.id,
            motorName: this.name,
            source: "api_live",
            provedor: "Google AI Studio",
            tokensDisponiveis: inputLimit,
            limiteTokens: inputLimit,
            rateLimitRpm: 15,
            statusCota: "normal",
            mensagem: `Google AI Studio: Cota ativa (${inputLimit.toLocaleString()} tokens/janela de contexto, 1.000.000 TPM, 15 RPM)`,
            consultadoEm: now,
            detalhes: {
              input_token_limit: inputLimit,
              output_token_limit: outputLimit,
              models_count: models.length,
            },
          };
        }
      } catch {}
    }

    const installStatus = await this.isInstalled(homeDir);
    if (installStatus.installed) {
      return {
        motorId: this.id,
        motorName: this.name,
        source: "cli_live",
        provedor: "Google Antigravity Runtime (DeepMind)",
        tokensDisponiveis: "ilimitado",
        rateLimitRpm: 60,
        statusCota: "normal",
        mensagem: `Google Antigravity: Runtime isolado ativo (${installStatus.version || "v2.0"})`,
        consultadoEm: now,
      };
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "Google AI Studio",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "Chave GEMINI_API_KEY ou binário agy não configurados",
      consultadoEm: now,
    };
  }
}
