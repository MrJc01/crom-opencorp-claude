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
import { resolveEngineCredentials, checkEngineAuthStatusAsync, probeCliLoginAsync } from "../credentials-bridge.js";

export class ClaudeCodeDriver implements EngineDriver {
  id = "claude-code";
  name = "Claude Code";
  description = "Agente autônomo de código da Anthropic com suporte a tools, bash e raciocínio profundo";
  category = "cli" as const;
  maintainer = "Anthropic";
  supportedModelsHint = [
    "claude-3-7-sonnet",
    "claude-3-5-sonnet",
    "claude-3-5-haiku",
  ];
  fallbackModels = ["claude-3-7-sonnet-20250219", "claude-3-5-sonnet-20241022"];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "claude");
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
      "/usr/local/bin/claude",
      "/usr/bin/claude",
      join(homeDir, ".npm-global", "bin", "claude"),
      join(homeDir, ".nvm", "versions", "node", process.version, "bin", "claude"),
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
      const { stdout } = await execFileAsync("which", ["claude"], { timeout: 2000 });
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
      return { healthy: false, statusText: "Claude Code não instalado no sistema ou em ~/.opencorp/bin" };
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

    // Execução headless usando o modo print (-p) do Claude Code
    const args: string[] = ["-p", opts.prompt];

    const env: Record<string, string> = await resolveEngineSpawnEnv(this.id, opts, {
      ANTHROPIC_DISABLE_TELEMETRY: "1",
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
    const apiKey = accountCredentials?.tokenOuChave || creds.ANTHROPIC_API_KEY;
    const now = new Date().toISOString();

    if (apiKey) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          signal: AbortSignal.timeout(4000),
        });

        const reqRemaining = res.headers.get("anthropic-ratelimit-requests-remaining");
        const tokRemaining = res.headers.get("anthropic-ratelimit-tokens-remaining");
        const reqLimit = res.headers.get("anthropic-ratelimit-requests-limit");
        const tokLimit = res.headers.get("anthropic-ratelimit-tokens-limit");
        const resetHeader = res.headers.get("anthropic-ratelimit-requests-reset");

        const tokensRestantes = tokRemaining ? Number(tokRemaining) : "ilimitado";
        const isExhausted = tokRemaining ? Number(tokRemaining) <= 0 : !res.ok;

        return {
          motorId: this.id,
          motorName: this.name,
          source: "api_live",
          provedor: "Anthropic API Direta",
          tokensDisponiveis: tokensRestantes,
          limiteTokens: tokLimit ? Number(tokLimit) : undefined,
          requestsRestantes: reqRemaining ? Number(reqRemaining) : undefined,
          requestsLimite: reqLimit ? Number(reqLimit) : undefined,
          rateLimitRpm: reqLimit ? Number(reqLimit) : 50,
          resetaEm: resetHeader || undefined,
          statusCota: isExhausted ? "esgotado" : "normal",
          mensagem: `Claude Code (API Key): ${tokRemaining ? `${Number(tokRemaining).toLocaleString()} tokens restantes` : "Autenticado via ANTHROPIC_API_KEY"}`,
          consultadoEm: now,
          detalhes: {
            status_http: res.status,
            rate_limit_reset: resetHeader,
          },
        };
      } catch {}
    }

    // Sessão OAuth: verificada pelo comando oficial `claude auth status`,
    // nunca lendo ~/.claude/.credentials.json (D4).
    const sessao = await probeCliLoginAsync(this.id, homeDir);
    if (sessao?.loggedIn) {
      return {
        motorId: this.id,
        motorName: this.name,
        source: "oauth_session",
        provedor: "Claude (OAuth CLI)",
        tokensDisponiveis: "ilimitado",
        statusCota: "normal",
        mensagem: `Claude Code: sessão ativa via ${sessao.method}${sessao.details ? ` (${sessao.details})` : ""}`,
        consultadoEm: now,
      };
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "Anthropic",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "Claude Code sem autenticação. Execute 'claude login' ou configure ANTHROPIC_API_KEY",
      consultadoEm: now,
    };
  }
}
