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
import { resolveEngineCredentials, checkEngineAuthStatusAsync } from "../credentials-bridge.js";

export class CopilotDriver implements EngineDriver {
  id = "copilot";
  name = "GitHub Copilot CLI";
  description = "Agente autônomo de terminal do GitHub/VSCode com suporte a execução headless via tokens PAT";
  category = "cli" as const;
  maintainer = "GitHub / Microsoft";
  supportedModelsHint = [
    "gpt-4o",
    "o3-mini",
    "claude-3.5-sonnet",
  ];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "copilot");
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
      "/usr/local/bin/copilot",
      "/usr/bin/copilot",
      join(homeDir, ".npm-global", "bin", "copilot"),
      join(homeDir, ".local", "bin", "copilot"),
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
      const { stdout } = await execFileAsync("which", ["copilot"], { timeout: 2000 });
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
      return { healthy: false, statusText: "GitHub Copilot CLI não instalado em ~/.opencorp/bin ou no sistema" };
    }

    const t0 = Date.now();
    const auth = await checkEngineAuthStatusAsync(this.id, homeDir);

    try {
      const { stdout } = await execFileAsync(status.path, ["--version"], { timeout: 3000 });
      const statusMsg = auth.authenticated
        ? `OK — Versão ${stdout.trim() || status.version} (${status.isManaged ? "Isolado" : "Sistema"}) · ${auth.method}`
        : `Requer Autenticação: ${auth.details}`;

      return {
        healthy: auth.authenticated,
        statusText: statusMsg,
        latencyMs: Date.now() - t0,
        details: { path: status.path, isManaged: status.isManaged, auth },
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

    // Execução headless do GitHub Copilot CLI
    const args: string[] = ["-p", opts.prompt, "--silent", "--allow-all"];
    if (opts.model && opts.model.trim()) {
      args.push("--model", opts.model.trim());
    }

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
    const token = accountCredentials?.tokenOuChave || creds.GITHUB_TOKEN || creds.COPILOT_GITHUB_TOKEN || creds.GH_TOKEN;
    const now = new Date().toISOString();

    if (token) {
      try {
        const [rateRes, userRes] = await Promise.all([
          fetch("https://api.github.com/rate_limit", {
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": "OpenCorp-Worker",
            },
            signal: AbortSignal.timeout(4000),
          }).catch(() => null),
          fetch("https://api.github.com/user", {
            headers: {
              Authorization: `Bearer ${token}`,
              "User-Agent": "OpenCorp-Worker",
            },
            signal: AbortSignal.timeout(4000),
          }).catch(() => null),
        ]);

        if (rateRes && rateRes.ok) {
          const rateData = (await rateRes.json()) as any;
          const userData = userRes && userRes.ok ? ((await userRes.json()) as any) : null;
          const rate = rateData?.rate || rateData?.resources?.core || {};
          const remaining = rate.remaining != null ? Number(rate.remaining) : 5000;
          const limit = rate.limit != null ? Number(rate.limit) : 5000;
          const used = rate.used != null ? Number(rate.used) : limit - remaining;
          const resetEpoch = rate.reset ? Number(rate.reset) : Math.floor(Date.now() / 1000) + 3600;
          const resetaEm = new Date(resetEpoch * 1000).toISOString();
          const minsToReset = Math.max(0, Math.round((resetEpoch * 1000 - Date.now()) / 60000));
          const login = userData?.login ? `@${userData.login}` : "autenticado";

          const isExhausted = remaining <= 0;

          return {
            motorId: this.id,
            motorName: this.name,
            source: "api_live",
            provedor: "GitHub Copilot API",
            tokensDisponiveis: remaining, // requisições autorizadas de API
            tokensUsados: used,
            limiteTokens: limit,
            requestsRestantes: remaining,
            requestsLimite: limit,
            rateLimitRpm: 40,
            resetaEm,
            statusCota: isExhausted ? "esgotado" : (remaining < 200 ? "alerta_80" : "normal"),
            mensagem: `GitHub Copilot: ${remaining.toLocaleString()}/${limit.toLocaleString()} requisições disponíveis para ${login} (reseta em ${minsToReset}m)`,
            consultadoEm: now,
            detalhes: {
              account: login,
              reset_epoch: resetEpoch,
              resources: rateData?.resources,
            },
          };
        }
      } catch {}
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "GitHub API",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "Token do GitHub ausente. Execute 'gh auth login' ou conecte uma conta",
      consultadoEm: now,
    };
  }
}
