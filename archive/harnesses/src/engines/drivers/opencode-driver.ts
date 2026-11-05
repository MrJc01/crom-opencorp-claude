import { existsSync } from "node:fs";
import { installManagedEngine } from "../installer/managed-installer.js";
import { binaryOrPreflight, resolveEngineBinary } from "../installer/binary-resolver.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { join } from "node:path";
import { envOpencodeIsolado } from "../../contexts/execution/opencode-server.js";
import {
  safeExecFile as execFileAsync,
  type EngineDriver,
  type EngineInstallStatus,
  type EngineHealth,
  type EngineExecutionOptions,
  type EngineTokenUsage,
} from "../types.js";
import { checkEngineAuthStatusAsync, resolveEngineCredentials } from "../credentials-bridge.js";

export class OpencodeDriver implements EngineDriver {
  id = "opencode";
  name = "OpenCode Engine";
  description = "Motor autônomo baseado em terminal, compatível com OpenRouter, Anthropic, Gemini e BYOK";
  category = "hybrid" as const;
  nativeSessionPassthrough = true;
  maintainer = "OpenCode";
  supportedModelsHint = [
    "openrouter/google/gemini-3.8-flash",
    "openrouter/nvidia/nemotron-3.5-lightning:free",
    "openrouter/minimax/minimax-m3:free",
    "opencode/grok-code",
  ];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "opencode");
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

    // Fallback: verificar caminhos conhecidos do sistema
    const candidatos = [
      join(homeDir, ".opencode", "bin", "opencode"),
      "/usr/local/bin/opencode",
      "/usr/bin/opencode",
    ];

    for (const cand of candidatos) {
      if (existsSync(cand)) {
        try {
          const { stdout } = await execFileAsync(cand, ["--version"], { timeout: 3000 });
          return {
            installed: true,
            isManaged: false,
            path: cand,
            version: stdout.trim() || "v1.x (sistema)",
          };
        } catch {
          return { installed: true, isManaged: false, path: cand, version: "v1.x" };
        }
      }
    }

    try {
      const { stdout } = await execFileAsync("which", ["opencode"], { timeout: 2000 });
      const p = stdout.trim();
      if (p && existsSync(p)) {
        return { installed: true, isManaged: false, path: p, version: "v1.x" };
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
      return { healthy: false, statusText: "OpenCode não instalado no sistema ou no diretório isolado" };
    }

    const t0 = Date.now();
    const auth = await checkEngineAuthStatusAsync(this.id, homeDir);

    try {
      const { stdout } = await execFileAsync(status.path, ["--version"], { timeout: 3000 });
      const statusMsg = auth.authenticated
        ? `OK — Versão ${stdout.trim() || status.version} (${status.isManaged ? "Isolado" : "Sistema"}) · ${auth.method}`
        : `Requer Chave: ${auth.details}`;

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
    const args: string[] = ["run"];

    if (opts.auto !== false) {
      args.push("--auto");
    }
    if (opts.agentId) {
      args.push("--agent", opts.agentId);
    }
    if (opts.model) {
      args.push("--model", opts.model);
    }
    if (opts.workspacePath) {
      args.push("--dir", opts.workspacePath);
    }
    if (opts.sessionId) {
      args.push("--session", opts.sessionId);
    }
    if (opts.title) {
      args.push("--title", opts.title);
    }
    if (opts.extraArgs && opts.extraArgs.length > 0) {
      args.push(...opts.extraArgs);
    }
    args.push(opts.prompt);

    // Base isolada (XDG por workspace) sem segredos herdados + chaves permitidas ao OpenCode.
    const env = await resolveEngineSpawnEnv(
      this.id,
      opts,
      { ...(opts.envOverrides || {}) },
      envOpencodeIsolado(opts.homeDir, opts.workspaceId, opts.workspacePath)
    );

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
    const orKey = accountCredentials?.tokenOuChave || creds.OPENROUTER_API_KEY;
    const now = new Date().toISOString();

    if (orKey) {
      try {
        const [authRes, credRes] = await Promise.all([
          fetch("https://openrouter.ai/api/v1/auth/key", {
            headers: { Authorization: `Bearer ${orKey}` },
            signal: AbortSignal.timeout(4000),
          }).catch(() => null),
          fetch("https://openrouter.ai/api/v1/credits", {
            headers: { Authorization: `Bearer ${orKey}` },
            signal: AbortSignal.timeout(4000),
          }).catch(() => null),
        ]);

        if (authRes && authRes.ok) {
          const authData = (await authRes.json()) as any;
          const credData = credRes && credRes.ok ? ((await credRes.json()) as any) : null;
          const keyData = authData?.data || {};
          const credits = credData?.data || {};

          const totalCredits = credits.total_credits != null ? Number(credits.total_credits) : null;
          const totalUsage = credits.total_usage != null ? Number(credits.total_usage) : (keyData.usage != null ? Number(keyData.usage) : 0);
          const limit = keyData.limit != null ? Number(keyData.limit) : null;
          const saldo = totalCredits != null ? Math.max(0, totalCredits - totalUsage) : (limit != null ? Math.max(0, limit - totalUsage) : undefined);

          const isFree = keyData.is_free_tier || false;
          const isExhausted = saldo !== undefined && saldo <= 0 && !isFree;

          return {
            motorId: this.id,
            motorName: this.name,
            source: "api_live",
            provedor: "OpenRouter",
            tokensDisponiveis: saldo !== undefined ? Math.round(saldo * 100_000) : (isFree ? "ilimitado" : "indeterminado"),
            tokensUsados: Math.round(totalUsage * 100_000),
            saldoUsd: saldo !== undefined ? Number(saldo.toFixed(4)) : undefined,
            consumoUsd: Number(totalUsage.toFixed(4)),
            limiteUsd: limit != null ? Number(limit.toFixed(2)) : (totalCredits != null ? Number(totalCredits.toFixed(2)) : undefined),
            rateLimitRpm: keyData.rate_limit?.requests && keyData.rate_limit.requests > 0 ? keyData.rate_limit.requests * 6 : undefined,
            statusCota: isExhausted ? "esgotado" : (saldo !== undefined && saldo < 1.0 ? "alerta_80" : "normal"),
            mensagem: `OpenRouter: Saldo restante ${saldo !== undefined ? `$${saldo.toFixed(2)}` : "Ativo"} · Consumo: $${totalUsage.toFixed(2)}`,
            consultadoEm: now,
            detalhes: {
              label: keyData.label,
              is_free_tier: isFree,
              byok_usage: keyData.byok_usage,
            },
          };
        }
      } catch {}
    }

    const antKey = accountCredentials?.tokenOuChave || creds.ANTHROPIC_API_KEY;
    if (antKey) {
      try {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: { "x-api-key": antKey, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(3500),
        });
        const reqRemaining = res.headers.get("anthropic-ratelimit-requests-remaining");
        const tokRemaining = res.headers.get("anthropic-ratelimit-tokens-remaining");
        const reqLimit = res.headers.get("anthropic-ratelimit-requests-limit");
        const tokLimit = res.headers.get("anthropic-ratelimit-tokens-limit");

        return {
          motorId: this.id,
          motorName: this.name,
          source: "api_live",
          provedor: "Anthropic Direto",
          tokensDisponiveis: tokRemaining ? Number(tokRemaining) : "ilimitado",
          limiteTokens: tokLimit ? Number(tokLimit) : undefined,
          requestsRestantes: reqRemaining ? Number(reqRemaining) : undefined,
          requestsLimite: reqLimit ? Number(reqLimit) : undefined,
          statusCota: res.ok ? "normal" : "alerta_80",
          mensagem: `Anthropic API: ${tokRemaining ? `${Number(tokRemaining).toLocaleString()} tokens restantes` : "Conexão ativa"}`,
          consultadoEm: now,
        };
      } catch {}
    }

    const gemKey = accountCredentials?.tokenOuChave || creds.GEMINI_API_KEY;
    if (gemKey) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${gemKey}`, {
          signal: AbortSignal.timeout(3500),
        });
        if (res.ok) {
          return {
            motorId: this.id,
            motorName: this.name,
            source: "api_live",
            provedor: "Google AI Studio",
            tokensDisponiveis: 1_048_576,
            rateLimitRpm: 15,
            statusCota: "normal",
            mensagem: "Google AI Studio: Cota ativa (1.000.000 TPM / 15 RPM)",
            consultadoEm: now,
          };
        }
      } catch {}
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "Nenhum",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "Nenhuma chave ou credencial configurada no motor",
      consultadoEm: now,
    };
  }
}
