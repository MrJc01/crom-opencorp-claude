import { existsSync, realpathSync } from "node:fs";
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

export class CodexDriver implements EngineDriver {
  id = "codex";
  name = "OpenAI Codex CLI";
  description = "Agente autônomo de terminal da OpenAI com raciocínio profundo, sandbox de SO e execução não-interativa";
  category = "cli" as const;
  maintainer = "OpenAI";
  supportedModelsHint = [
    "gpt-6-astra",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-reserve",
  ];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "codex");
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
      "/usr/local/bin/codex",
      "/usr/bin/codex",
      join(homeDir, ".npm-global", "bin", "codex"),
      join(homeDir, ".local", "bin", "codex"),
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
      const { stdout } = await execFileAsync("which", ["codex"], { timeout: 2000 });
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
      return { healthy: false, statusText: "OpenAI Codex CLI não instalado em ~/.opencorp/bin ou no sistema" };
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
    const resolvido = binaryOrPreflight(this.id, status);

    // O binário codex gerenciado é um script Node (shebang #!/usr/bin/env node).
    // Dentro do bwrap o `node` do host (~/.nvm) não é montado e o kernel falha
    // o exec do script com ENOENT. Invoca via node explícito (process.execPath,
    // absoluto — dirsDoBinario monta o dir dele no sandbox).
    let bin: string;
    let prefixo: string[];
    try {
      const script = realpathSync(resolvido);
      if (script.endsWith(".js") && existsSync(script) && process.execPath) {
        bin = process.execPath;
        prefixo = [script];
      } else {
        bin = resolvido;
        prefixo = [];
      }
    } catch {
      bin = resolvido;
      prefixo = [];
    }

    // Execução headless do Codex via subcomando 'exec' com sandbox de workspace
    // -m respeita codex/<modelo> (custo zero via plano); sem -m usa default do CLI
    // --skip-git-repo-check: workspaces .opencorp não são repos git confiáveis
    const args: string[] = [...prefixo, "exec", "--sandbox", "workspace-write", "--skip-git-repo-check"];
    const modelo = typeof opts.model === "string" ? opts.model.trim() : "";
    if (modelo.length > 0) args.push("-m", modelo);
    args.push(opts.prompt);

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
    const apiKey = accountCredentials?.tokenOuChave || creds.OPENAI_API_KEY;
    const now = new Date().toISOString();

    if (apiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(4000),
        });

        const tokRemaining = res.headers.get("x-ratelimit-remaining-tokens");
        const tokLimit = res.headers.get("x-ratelimit-limit-tokens");
        const reqRemaining = res.headers.get("x-ratelimit-remaining-requests");
        const reqLimit = res.headers.get("x-ratelimit-limit-requests");
        const resetHeader = res.headers.get("x-ratelimit-reset-tokens");

        const tokensRestantes = tokRemaining ? Number(tokRemaining) : "ilimitado";
        const isExhausted = tokRemaining ? Number(tokRemaining) <= 0 : !res.ok;

        return {
          motorId: this.id,
          motorName: this.name,
          source: "api_live",
          provedor: "OpenAI API",
          tokensDisponiveis: tokensRestantes,
          limiteTokens: tokLimit ? Number(tokLimit) : undefined,
          requestsRestantes: reqRemaining ? Number(reqRemaining) : undefined,
          requestsLimite: reqLimit ? Number(reqLimit) : undefined,
          rateLimitRpm: reqLimit ? Number(reqLimit) : 60,
          resetaEm: resetHeader || undefined,
          statusCota: isExhausted ? "esgotado" : "normal",
          mensagem: `OpenAI Codex: ${tokRemaining ? `${Number(tokRemaining).toLocaleString()} tokens restantes` : "API Key ativa"}`,
          consultadoEm: now,
          detalhes: {
            status_http: res.status,
            reset_tokens: resetHeader,
          },
        };
      } catch {}
    }

    const auth = await checkEngineAuthStatusAsync(this.id, homeDir);
    if (auth.authenticated) {
      return {
        motorId: this.id,
        motorName: this.name,
        source: "cli_live",
        provedor: auth.method,
        tokensDisponiveis: "ilimitado",
        rateLimitRpm: 40,
        statusCota: "normal",
        mensagem: `OpenAI Codex: Sessão ChatGPT ativa (${auth.details})`,
        consultadoEm: now,
      };
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "OpenAI",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "OpenAI Codex não configurado. Defina OPENAI_API_KEY ou execute 'codex login'",
      consultadoEm: now,
    };
  }
}
