import { existsSync } from "node:fs";
import { installManagedEngine } from "../installer/managed-installer.js";
import { binaryOrPreflight, resolveEngineBinary } from "../installer/binary-resolver.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";

import { delimiter, join } from "node:path";
import {
  safeExecFile as execFileAsync,
  type EngineDriver,
  type EngineExecutionOptions,
  type EngineHealth,
  type EngineInstallStatus,
  type EngineTokenUsage,
} from "../types.js";

export class MimoDriver implements EngineDriver {
  id = "mimo";
  name = "Xiaomi MiMo Code";
  description = "Assistente de código e agente de execução autônomo da Xiaomi com modelos multimodais de contexto ilimitado";
  category = "cli" as const;
  maintainer = "Xiaomi";
  supportedModelsHint = [
    "mimo/MiMo-V2-Free",
    "xiaomi/mimo-v2.5-free",
    "xiaomi/mimo-v2.5",
    "xiaomi/mimo-v2.5-pro",
    "xiaomi/mimo-v2.5-pro-ultraspeed",
    "xiaomi/mimo-v2.6-flash",
    "xiaomi/mimo-v2.6-pro",
    "xiaomi/mimo-v2.6-pro-ultraspeed",
  ];
  comandoPadrao = "mimo";

  private candidatePaths(homeDir: string): string[] {
    const pathCandidates = (process.env.PATH || "")
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, "mimo"));

    return [
      ...pathCandidates,
      join(homeDir, ".mimo", "bin", "mimo"),
      // O instalador oficial atual usa ~/.mimocode; mantemos também o caminho
      // solicitado/legado ~/.mimo para compatibilidade entre versões.
      join(homeDir, ".mimocode", "bin", "mimo"),
    ];
  }

  async isInstalled(homeDir: string): Promise<EngineInstallStatus> {
    // Precedência D3: settings.binary_path → PATH → gerenciada → detecção legada.
    return resolveEngineBinary(this.id, { homeDir, legacyDetect: () => this.detectarInstalacaoLegada(homeDir) });
  }

  private async detectarInstalacaoLegada(homeDir: string): Promise<EngineInstallStatus> {
    for (const candidate of [...new Set(this.candidatePaths(homeDir))]) {
      if (!existsSync(candidate)) continue;

      try {
        const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 3000 });
        return {
          installed: true,
          isManaged: candidate.startsWith(join(homeDir, ".mimo")) || candidate.startsWith(join(homeDir, ".mimocode")),
          path: candidate,
          version: stdout.trim() || "detectado",
        };
      } catch {
        return {
          installed: true,
          isManaged: candidate.startsWith(join(homeDir, ".mimo")) || candidate.startsWith(join(homeDir, ".mimocode")),
          path: candidate,
          version: "detectado",
        };
      }
    }

    return {
      installed: false,
      isManaged: false,
      path: null,
      version: null,
      details: "Binário mimo não encontrado no sistema",
    };
  }

  async install(
    homeDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ success: boolean; path: string; version: string; log: string }> {
    // Somente instalação gerenciada com artefato fixado e SHA-256 aprovado;
    // sem artefato aprovado, falha com instruções de instalação manual.
    return installManagedEngine(this.id, homeDir, onProgress);
  }

  async checkHealth(homeDir: string): Promise<EngineHealth & {
    installed: boolean;
    version?: string | null;
    message?: string;
  }> {
    const status = await this.isInstalled(homeDir);
    if (!status.installed || !status.path) {
      return {
        healthy: false,
        installed: false,
        version: null,
        message: "Binário mimo não encontrado no sistema",
        statusText: "Binário mimo não encontrado no sistema",
        details: { installed: false },
      };
    }

    const startedAt = Date.now();
    try {
      const { stdout } = await execFileAsync(status.path, ["--version"], { timeout: 3000 });
      const version = stdout.trim() || status.version || "detectado";
      return {
        healthy: true,
        installed: true,
        version,
        statusText: `OK — Xiaomi MiMo Code ${version}`,
        latencyMs: Date.now() - startedAt,
        details: { installed: true, path: status.path, version, isManaged: status.isManaged },
      };
    } catch (error: any) {
      return {
        healthy: false,
        installed: true,
        version: status.version,
        message: `Falha ao executar ${status.path}: ${error?.message || error}`,
        statusText: `Falha ao executar ${status.path}: ${error?.message || error}`,
        latencyMs: Date.now() - startedAt,
        details: { installed: true, path: status.path },
      };
    }
  }

  getAuthInstructions(): string {
    return "Instale o binário pelo método oficial em https://mimo.xiaomi.com e execute 'mimo auth login'. O tier gratuito sem login foi encerrado pela Xiaomi.";
  }

  async prepareExecution(opts: EngineExecutionOptions): Promise<{
    binary: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }> {
    const status = await this.isInstalled(opts.homeDir);
    const args = ["run", "--dangerously-skip-permissions"];
    if (opts.model?.trim()) args.push("--model", opts.model.trim());
    args.push(opts.prompt);
    return {
      binary: binaryOrPreflight(this.id, status),
      args,
      env: await resolveEngineSpawnEnv(this.id, opts, { ...(opts.envOverrides || {}) }),
      cwd: opts.workspacePath,
    };
  }

  async fetchLiveTokens(homeDir: string): Promise<EngineTokenUsage> {
    const status = await this.isInstalled(homeDir);
    return {
      motorId: this.id,
      motorName: this.name,
      source: status.installed ? "cli_live" : "unconfigured",
      provedor: "Xiaomi MiMo Code",
      tokensDisponiveis: 0,
      statusCota: "desconhecido",
      mensagem: status.installed
        ? `MiMo Code ${status.version || "detectado"} instalado; cota não consultável pelo CLI`
        : "Binário mimo não encontrado no sistema",
      consultadoEm: new Date().toISOString(),
      detalhes: { path: status.path, installed: status.installed },
    };
  }
}
