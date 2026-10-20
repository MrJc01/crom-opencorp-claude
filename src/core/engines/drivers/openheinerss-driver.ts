import { execFile } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { PreflightBinaryMissingError } from "../errors.js";
import type { EngineDriver, EngineExecutionOptions, EngineHealth, EngineInstallStatus, EngineTokenUsage } from "../types.js";

export const OPENHEINERSS_ENGINE_ID = "openheinerss";

/** Caminho padrão do binário Go do Open Harness neste PC; `OPENHEINERSS_BIN` ou `binPath` o substituem. */
export const OPENHEINERSS_DEFAULT_BIN = "/home/j/Documentos/GitHub/openheinerss/bin/openheinerss";

/** Harnesses embutidos no openheinerss (docs/03-harness-adapters.md). */
export const OPENHEINERSS_HARNESSES = ["mock", "claude-code", "opencode", "codex", "agy", "aider"] as const;

/** Harness usado quando o modelo não nomeia um (`OPENHEINERSS_HARNESS` muda o padrão). */
export function openheinerssDefaultHarness(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENHEINERSS_HARNESS?.trim() || "claude-code";
}

/**
 * O campo `model` do núcleo vira `harness` + `model` do openheinerss:
 * `claude-code:claude-sonnet-5-5` → harness claude-code, modelo claude-sonnet-5-5;
 * `mock` (nome de harness conhecido) → só harness; qualquer outro valor é modelo do harness padrão.
 * `default`/vazio = harness padrão e modelo do próprio harness.
 */
export function parseOpenheinerssModel(model: string | undefined, env: NodeJS.ProcessEnv = process.env): { harness: string; model?: string } {
  const raw = (model ?? "").trim();
  if (!raw || raw === "default") return { harness: openheinerssDefaultHarness(env) };
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const harness = raw.slice(0, colon);
    const rest = raw.slice(colon + 1).trim();
    return { harness, ...(rest ? { model: rest } : {}) };
  }
  if ((OPENHEINERSS_HARNESSES as readonly string[]).includes(raw)) return { harness: raw };
  return { harness: openheinerssDefaultHarness(env), model: raw };
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Caminho do binário: `explicit` > `OPENHEINERSS_BIN` > padrão do PC > `openheinerss` no PATH. `null` = ausente. */
export function resolveOpenheinerssBinary(explicit?: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [explicit, env.OPENHEINERSS_BIN, OPENHEINERSS_DEFAULT_BIN].filter((p): p is string => !!p?.trim());
  for (const c of candidates) if (existsSync(c) && executable(c)) return c;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, "openheinerss");
    if (existsSync(p) && executable(p)) return p;
  }
  return null;
}

function versionOf(path: string, timeoutMs = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ["version"], { timeout: timeoutMs, encoding: "utf8" }, (error, stdout) => {
      if (error) return resolve(null);
      resolve(stdout.trim().split("\n")[0]?.slice(0, 120) || null);
    });
  });
}

/** Instalação ausente é `installed:false` (motor indisponível), nunca exceção. */
export async function openheinerssInstallStatus(explicit?: string): Promise<EngineInstallStatus> {
  const path = resolveOpenheinerssBinary(explicit);
  if (!path) {
    return {
      installed: false,
      isManaged: false,
      path: null,
      version: null,
      details: `Binário do openheinerss não encontrado (procurado: OPENHEINERSS_BIN, ${OPENHEINERSS_DEFAULT_BIN}, PATH). Compile em openheinerss/ com "make" ou defina OPENHEINERSS_BIN.`,
    };
  }
  return { installed: true, isManaged: false, path, version: (await versionOf(path)) ?? "desconhecida" };
}

/**
 * Driver do motor "openheinerss". Existe para o motor aparecer na lista de motores (que é montada a partir de
 * drivers); a execução é do OpenheinerssAdapter. Binário ausente = `installed:false`, nunca erro.
 */
export class OpenheinerssDriver implements EngineDriver {
  id = OPENHEINERSS_ENGINE_ID;
  name = "Open Harness (openheinerss)";
  description = "Orquestrador Go de harnesses (claude-code, opencode, codex, agy, aider) por JSON-RPC/STDIO; modelo no formato harness:modelo";
  category = "cli" as const;
  maintainer = "Crom";
  supportedModelsHint = [...OPENHEINERSS_HARNESSES];
  timeoutDefaults = { tetoMs: 1_800_000, inatividadeMs: 300_000 };

  constructor(private readonly binPath?: string) {}

  isInstalled(_homeDir: string): Promise<EngineInstallStatus> {
    return openheinerssInstallStatus(this.binPath);
  }

  async install(homeDir: string) {
    const status = await this.isInstalled(homeDir);
    return {
      success: status.installed,
      path: status.path ?? "",
      version: status.version ?? "",
      log: status.installed ? "openheinerss já disponível" : status.details ?? "binário do openheinerss ausente",
    };
  }

  async checkHealth(homeDir: string): Promise<EngineHealth> {
    const status = await this.isInstalled(homeDir);
    return { healthy: status.installed, statusText: status.installed ? `openheinerss ${status.version}` : status.details ?? "ausente" };
  }

  // A execução não passa por spawn de CLI; o adaptador fala JSON-RPC com `serve --stdio`.
  async prepareExecution(opts: EngineExecutionOptions) {
    const status = await this.isInstalled(opts.homeDir);
    if (!status.installed || !status.path) throw new PreflightBinaryMissingError(this.id);
    const { harness, model } = parseOpenheinerssModel(opts.model);
    return {
      binary: status.path,
      args: ["run", "--harness", harness, ...(model ? ["--model", model] : []), opts.prompt],
      env: { ...(opts.envOverrides ?? {}) },
      cwd: opts.workspacePath,
    };
  }

  async fetchLiveTokens(): Promise<EngineTokenUsage> {
    return {
      motorId: this.id,
      motorName: this.name,
      source: "unconfigured",
      provedor: "openheinerss",
      tokensDisponiveis: "indeterminado",
      statusCota: "desconhecido",
      mensagem: "Cota pertence ao harness escolhido (claude-code, codex...)",
      consultadoEm: new Date().toISOString(),
    };
  }
}
