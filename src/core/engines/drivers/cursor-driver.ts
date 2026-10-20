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

export class CursorDriver implements EngineDriver {
  id = "cursor";
  name = "Cursor Agent CLI";
  description = "Agente autônomo do ecossistema Cursor com execução headless, MCP e edição direta de arquivos";
  category = "hybrid" as const;
  maintainer = "Anysphere (Cursor)";
  supportedModelsHint = [
    "claude-3.5-sonnet",
    "gpt-4o",
    "cursor-small",
    "o3-mini",
  ];

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    const managedBin = join(homeDir, ".opencorp", "bin", "cursor-agent");
    const managedBinAlt = join(homeDir, ".opencorp", "bin", "agent");
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
    if (existsSync(managedBinAlt)) {
      try {
        const { stdout } = await execFileAsync(managedBinAlt, ["--version"], { timeout: 3000 });
        return {
          installed: true,
          isManaged: true,
          path: managedBinAlt,
          version: stdout.trim() || "v1.x (isolado)",
        };
      } catch {
        return { installed: true, isManaged: true, path: managedBinAlt, version: "v1.x" };
      }
    }

    const candidatos = [
      join(homeDir, ".local", "bin", "agent"),
      "/usr/local/bin/agent",
      join(homeDir, ".cursor", "bin", "agent"),
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
      const { stdout } = await execFileAsync("which", ["agent"], { timeout: 2000 });
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
      return { healthy: false, statusText: "Cursor Agent CLI não instalado em ~/.opencorp/bin ou no sistema" };
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

    // Execução headless do Cursor Agent (-p não-interativo, --force para aplicar edições)
    const args: string[] = ["-p", "--force", opts.prompt];

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
    const apiKey = accountCredentials?.tokenOuChave || creds.CURSOR_API_KEY;
    const now = new Date().toISOString();

    if (apiKey) {
      return {
        motorId: this.id,
        motorName: this.name,
        source: "api_live",
        provedor: "Cursor API",
        tokensDisponiveis: "ilimitado",
        rateLimitRpm: 30,
        statusCota: "normal",
        mensagem: "Cursor Agent: Chave de API CURSOR_API_KEY ativa (Fast Requests ilimitadas)",
        consultadoEm: now,
      };
    }

    const status = await this.isInstalled(homeDir);
    if (status.installed && status.path) {
      try {
        const { stdout } = await execFileAsync(status.path, ["status"], { timeout: 3000 });
        if (stdout && !stdout.toLowerCase().includes("not logged in")) {
          return {
            motorId: this.id,
            motorName: this.name,
            source: "cli_live",
            provedor: "Cursor Account (OAuth CLI)",
            tokensDisponiveis: "ilimitado",
            rateLimitRpm: 30,
            statusCota: "normal",
            mensagem: `Cursor Agent: Sessão ativa CLI (${stdout.trim().split("\n")[0] || "Autenticado"})`,
            consultadoEm: now,
          };
        }
      } catch {}
    }

    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "Cursor",
      tokensDisponiveis: 0,
      statusCota: "esgotado",
      mensagem: "Cursor Agent sem login. Execute 'agent login' ou defina CURSOR_API_KEY",
      consultadoEm: now,
    };
  }
}
