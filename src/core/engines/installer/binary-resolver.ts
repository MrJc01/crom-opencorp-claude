/**
 * EngineBinaryResolver — descoberta determinística do executável de um motor.
 *
 * Precedência (D3):
 *   1. `settings.engines[id].binary_path` (explícito; se não existir, falha —
 *      nunca cai silenciosamente para outra fonte);
 *   2. executável no `PATH`;
 *   3. instalação gerenciada ativa (`~/.opencorp/engines/<id>/current/bin/`);
 *   4. detecção legada do driver (ex.: `~/.opencorp/bin`, diretórios comuns),
 *      mantida por compatibilidade com instalações anteriores.
 *
 * Nunca instala nada. Ausência resulta em `installed: false` e, via
 * `requireEngineBinary`, em `PreflightBinaryMissingError`.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import * as childProcess from "node:child_process";
import { promisify } from "node:util";
import type { EngineInstallStatus } from "../types.js";
import { PreflightBinaryMissingError } from "../errors.js";

// Acesso preguiçoso: módulos que mockam node:child_process não precisam expor execFile.
const execFileAsync = (file: string, args: string[], options: childProcess.ExecFileOptions): Promise<{ stdout: string; stderr: string }> =>
  (promisify(childProcess.execFile) as any)(file, args, { encoding: "utf8", ...options });

/** Nomes de executável aceitos por motor, em ordem de preferência. */
export const ENGINE_BINARY_NAMES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  opencode: ["opencode"],
  codex: ["codex"],
  "claude-code": ["claude"],
  "claude-sdk": ["claude"],
  cursor: ["agent", "cursor-agent"],
  copilot: ["copilot"],
  antigravity: ["agy"],
  "crom-agente": ["crom-agente"],
  aider: ["aider"],
  mimo: ["mimo"],
});

export type BinarySource = "settings" | "path" | "managed" | "legacy";

export interface ResolvedEngineBinary extends EngineInstallStatus {
  source?: BinarySource;
}

export interface BinaryResolverOptions {
  homeDir: string;
  /** PATH a pesquisar; padrão `process.env.PATH`. */
  pathEnv?: string;
  /** Caminho explícito; padrão lido de `~/.opencorp/settings.json`. */
  settingsBinaryPath?: string | null;
  /** Detecção legada do driver, usada como último recurso. */
  legacyDetect?: () => Promise<EngineInstallStatus>;
  /** Sonda de versão; padrão `<bin> --version` com timeout de 3 s. */
  versionProbe?: (path: string) => Promise<string | null>;
}

export function managedEngineRoot(homeDir: string, engineId: string): string {
  return join(homeDir, ".opencorp", "engines", engineId);
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function readSettingsBinaryPath(homeDir: string, engineId: string): string | undefined {
  const path = join(homeDir, ".opencorp", "settings.json");
  if (!existsSync(path)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(path, "utf8")) as { engines?: Record<string, { binary_path?: unknown }> };
    const value = settings.engines?.[engineId]?.binary_path;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function findOnPath(names: readonly string[], pathEnv: string | undefined = process.env.PATH): string | undefined {
  const dirs = (pathEnv ?? "").split(delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

export function findManagedBinary(homeDir: string, engineId: string): { path: string; version: string } | undefined {
  const root = managedEngineRoot(homeDir, engineId);
  const current = join(root, "current");
  for (const name of ENGINE_BINARY_NAMES[engineId] ?? [engineId]) {
    const candidate = join(current, "bin", name);
    if (isExecutableFile(candidate)) {
      let version = "gerenciada";
      try {
        const prov = JSON.parse(readFileSync(join(current, "provenance.json"), "utf8")) as { version?: string };
        if (prov.version) version = prov.version;
      } catch {
        // proveniência ausente: versão desconhecida
      }
      return { path: candidate, version };
    }
  }
  return undefined;
}

const versionCache = new Map<string, { mtimeMs: number; version: string | null }>();

async function defaultVersionProbe(path: string): Promise<string | null> {
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { return null; }
  const cached = versionCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) return cached.version;
  let version: string | null = null;
  try {
    const { stdout } = await execFileAsync(path, ["--version"], { timeout: 3000 });
    version = stdout.trim().split("\n")[0] || null;
  } catch {
    version = null;
  }
  versionCache.set(path, { mtimeMs, version });
  return version;
}

export async function resolveEngineBinary(engineId: string, opts: BinaryResolverOptions): Promise<ResolvedEngineBinary> {
  const probe = opts.versionProbe ?? defaultVersionProbe;
  const explicit = opts.settingsBinaryPath === undefined ? readSettingsBinaryPath(opts.homeDir, engineId) : opts.settingsBinaryPath ?? undefined;
  if (explicit) {
    if (!isExecutableFile(explicit)) {
      return {
        installed: false,
        isManaged: false,
        path: null,
        version: null,
        source: "settings",
        details: `settings.engines["${engineId}"].binary_path aponta para "${explicit}", que não existe ou não é executável.`,
      };
    }
    return { installed: true, isManaged: false, path: explicit, version: (await probe(explicit)) ?? "desconhecida", source: "settings" };
  }

  const onPath = findOnPath(ENGINE_BINARY_NAMES[engineId] ?? [engineId], opts.pathEnv);
  if (onPath) return { installed: true, isManaged: false, path: onPath, version: (await probe(onPath)) ?? "desconhecida", source: "path" };

  const managed = findManagedBinary(opts.homeDir, engineId);
  if (managed) return { installed: true, isManaged: true, path: managed.path, version: managed.version, source: "managed" };

  if (opts.legacyDetect) {
    const legacy = await opts.legacyDetect();
    if (legacy.installed) return { ...legacy, source: "legacy" };
    return { ...legacy, details: legacy.details ?? `Binário do motor "${engineId}" não encontrado.` };
  }
  return { installed: false, isManaged: false, path: null, version: null, details: `Binário do motor "${engineId}" não encontrado.` };
}

/** Preflight: devolve o caminho do binário ou lança `PREFLIGHT_BINARY_MISSING`. Nunca instala. */
export async function requireEngineBinary(engineId: string, opts: BinaryResolverOptions): Promise<string> {
  const resolved = await resolveEngineBinary(engineId, opts);
  if (!resolved.installed || !resolved.path) {
    throw new PreflightBinaryMissingError(engineId, { details: { reason: resolved.details, source: resolved.source } });
  }
  return resolved.path;
}

/** Caminho do binário de um status já resolvido, ou `PREFLIGHT_BINARY_MISSING`. */
export function binaryOrPreflight(engineId: string, status: EngineInstallStatus): string {
  if (!status.installed || !status.path) {
    throw new PreflightBinaryMissingError(engineId, { details: { reason: status.details } });
  }
  return status.path;
}
