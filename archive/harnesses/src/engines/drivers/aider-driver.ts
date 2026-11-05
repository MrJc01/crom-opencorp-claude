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

export class AiderDriver implements EngineDriver {
  id = "aider";
  name = "Aider AI Pair Programmer";
  description = "Agente de pair programming em terminal com edição multi-arquivos e commits git automáticos";
  category = "cli" as const;
  maintainer = "Paul Gauthier (Aider.chat)";
  supportedModelsHint = [
    "claude-3-5-sonnet",
    "gpt-4o",
    "deepseek-coder",
    "gemini-2.0-flash",
  ];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "aider");
    if (existsSync(managedBin)) {
      try {
        const { stdout } = await execFileAsync(managedBin, ["--version"], { timeout: 3000 });
        return {
          installed: true,
          isManaged: true,
          path: managedBin,
          version: stdout.trim() || "v1.x (isolado)",
        };
      } catch {
        return { installed: true, isManaged: true, path: managedBin, version: "v1.x" };
      }
    }

    const candidatos = [
      "/usr/local/bin/aider",
      "/usr/bin/aider",
      join(homeDir, ".local", "bin", "aider"),
    ];

    for (const cand of candidatos) {
      if (existsSync(cand)) {
        try {
          const { stdout } = await execFileAsync(cand, ["--version"], { timeout: 3000 });
          return {
            installed: true,
            isManaged: false,
            path: cand,
            version: stdout.trim(),
          };
        } catch {
          return { installed: true, isManaged: false, path: cand, version: "detectado" };
        }
      }
    }

    try {
      const { stdout } = await execFileAsync("which", ["aider"], { timeout: 2000 });
      const p = stdout.trim();
      if (p && existsSync(p)) {
        return { installed: true, isManaged: false, path: p, version: "detectado" };
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
      return { healthy: false, statusText: "Aider não instalado em ~/.opencorp/bin ou no sistema" };
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

    // Execução headless do Aider via --message e --yes-always (não-interativo)
    const args: string[] = ["--message", opts.prompt, "--yes-always", "--no-auto-commits"];

    const env: Record<string, string> = await resolveEngineSpawnEnv(this.id, opts, {
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
    const key = accountCredentials?.tokenOuChave || creds.OPENROUTER_API_KEY || creds.ANTHROPIC_API_KEY || creds.OPENAI_API_KEY;
    const now = new Date().toISOString();

    if (creds.OPENROUTER_API_KEY || accountCredentials?.tokenOuChave) {
      const orKey = accountCredentials?.tokenOuChave || creds.OPENROUTER_API_KEY;
      try {
        const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { Authorization: `Bearer ${orKey}` },
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          const authData = (await res.json()) as any;
          const keyData = authData?.data || {};
          const isFree = keyData.is_free_tier || false;
          return {
            motorId: this.id,
            motorName: this.name,
            source: "api_live",
            provedor: "Aider (via OpenRouter)",
            tokensDisponiveis: isFree ? "ilimitado" : "indeterminado",
            rateLimitRpm: 30,
            statusCota: "normal",
            mensagem: `Aider: Chave OpenRouter conectada (${keyData.label || "ativa"})`,
            consultadoEm: now,
          };
        }
      } catch {}
    }

    if (key) {
      return {
        motorId: this.id,
        motorName: this.name,
        source: "api_live",
        provedor: "Aider Provedor Direto",
        tokensDisponiveis: "ilimitado",
        rateLimitRpm: 30,
        statusCota: "normal",
        mensagem: "Aider: Credencial ativa para pair programming",
        consultadoEm: now,
      };
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "Aider",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "Aider sem chave de LLM configurada",
      consultadoEm: now,
    };
  }
}
