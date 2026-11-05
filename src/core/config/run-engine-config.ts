/**
 * Configuração de execução one-shot (motor padrão, timeout, cadeia de motores
 * e limites por motor) — Etapa 14.
 *
 * Formato novo em `~/.opencorp/settings.json`:
 *   run_engine: { default, timeout_min, fallback: [] }
 *   engines: { <id>: { binary_path, limits } }
 *
 * `~/.opencorp/runner.json` continua lido como fallback até a remoção aprovada
 * (nunca antes de 2026-11-24 e da versão 2.0.0), com aviso de depreciação
 * único por processo. Escritas vão sempre para o formato novo.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "../../utils/fs-safe.js";
import {
  CANONICAL_ENGINE_ALIASES,
  createDeprecationNotice,
  defaultDeprecationEmitter,
  type DeprecationNotice,
} from "../engines/legacy-config-translator.js";

export interface EngineLimits {
  timeout_min?: number;
  max_turns?: number;
  rate_limit_rpm?: number;
  daily_cost_usd?: number;
  status_cota?: "normal" | "alerta_80" | "esgotado";
  fallback_action?: "rotate" | "stop";
}

export interface RunEngineConfig {
  engine: string;
  timeoutMin?: number;
  /** Cadeia explícita de motores autorizada pelo usuário (vazia = nunca trocar). */
  fallbackEngines: string[];
  limits: Record<string, EngineLimits>;
  binaryPaths: Record<string, string>;
  source: "settings" | "runner.json" | "default";
}

export function canonicalEngineId(id: string): string {
  const key = id.trim().toLowerCase();
  return CANONICAL_ENGINE_ALIASES[key] ?? key;
}

export function settingsPath(homeDir: string): string {
  return join(homeDir, ".opencorp", "settings.json");
}

export function runnerPath(homeDir: string): string {
  return join(homeDir, ".opencorp", "runner.json");
}

function readJson(path: string): Record<string, any> | null {
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

const FIRST_NOTICE_FILE = "deprecation-state.json";

/** Registra a data do primeiro aviso de depreciação observado nesta instalação. */
export async function recordFirstDeprecationNotice(homeDir: string, now = new Date()): Promise<string> {
  const path = join(homeDir, ".opencorp", FIRST_NOTICE_FILE);
  const current = readJson(path);
  if (typeof current?.firstNoticeAt === "string") return current.firstNoticeAt;
  mkdirSync(dirname(path), { recursive: true });
  const firstNoticeAt = now.toISOString();
  await writeFileAtomic(path, `${JSON.stringify({ firstNoticeAt }, null, 2)}\n`);
  return firstNoticeAt;
}

export function readFirstDeprecationNotice(homeDir: string): string | undefined {
  const at = readJson(join(homeDir, ".opencorp", FIRST_NOTICE_FILE))?.firstNoticeAt;
  return typeof at === "string" ? at : undefined;
}

/**
 * Converte o conteúdo de `runner.json` para os campos novos do settings.
 * Puro: sem leitura/escrita em disco.
 */
export function translateRunnerJson(runner: Record<string, any>): { settingsPatch: Record<string, any>; notices: DeprecationNotice[]; warnings: string[] } {
  const notices: DeprecationNotice[] = [];
  const warnings: string[] = [];
  const notice = (field: string, message: string) => notices.push(createDeprecationNotice({ source: "runner.json", field, message }));
  const runEngine: Record<string, any> = {};
  const engines: Record<string, any> = {};

  if (typeof runner.engine === "string" && runner.engine.trim()) {
    runEngine.default = canonicalEngineId(runner.engine);
    notice("engine", "runner.json 'engine' → settings.run_engine.default.");
  }
  if (typeof runner.timeout_min === "number" && runner.timeout_min > 0) {
    runEngine.timeout_min = runner.timeout_min;
    notice("timeout_min", "runner.json 'timeout_min' → settings.run_engine.timeout_min.");
  }
  if (Array.isArray(runner.harness_fallback)) {
    runEngine.fallback = [...new Set(runner.harness_fallback.map((e: unknown) => canonicalEngineId(String(e))).filter(Boolean))];
    notice("harness_fallback", "runner.json 'harness_fallback' → settings.run_engine.fallback (cadeia explícita de motores).");
  }
  if (typeof runner.binary_path === "string" && runner.binary_path.trim()) {
    const engine = runEngine.default;
    const path = runner.binary_path.trim();
    // Nome solto igual ao binário padrão não é um caminho: a resolução por PATH já cobre.
    if (engine && path.includes("/")) engines[engine] = { ...(engines[engine] ?? {}), binary_path: path };
    else warnings.push(`binary_path "${path}" não é um caminho absoluto; descartado (resolução por PATH já cobre).`);
    notice("binary_path", "runner.json 'binary_path' → settings.engines[<motor>].binary_path.");
  }
  if (runner.limits && typeof runner.limits === "object") {
    for (const [id, limits] of Object.entries(runner.limits as Record<string, unknown>)) {
      if (limits && typeof limits === "object") engines[canonicalEngineId(id)] = { ...(engines[canonicalEngineId(id)] ?? {}), limits };
    }
    notice("limits", "runner.json 'limits' → settings.engines[<motor>].limits.");
  }
  const known = new Set(["engine", "timeout_min", "harness_fallback", "binary_path", "limits"]);
  for (const key of Object.keys(runner)) if (!known.has(key)) warnings.push(`campo desconhecido "${key}" em runner.json não foi migrado.`);

  const settingsPatch: Record<string, any> = {};
  if (Object.keys(runEngine).length) settingsPatch.run_engine = runEngine;
  if (Object.keys(engines).length) settingsPatch.engines = engines;
  return { settingsPatch, notices, warnings };
}

/** Mescla o patch no settings existente sem apagar campos não relacionados. */
export function mergeSettings(current: Record<string, any>, patch: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...current };
  if (patch.run_engine) out.run_engine = { ...(current.run_engine ?? {}), ...patch.run_engine };
  if (patch.engines) {
    const engines: Record<string, any> = { ...(current.engines ?? {}) };
    for (const [id, cfg] of Object.entries(patch.engines as Record<string, any>)) {
      engines[id] = { ...(engines[id] ?? {}), ...cfg, ...(cfg.limits ? { limits: { ...(engines[id]?.limits ?? {}), ...cfg.limits } } : {}) };
    }
    out.engines = engines;
  }
  return out;
}

/**
 * Lê a configuração efetiva: settings novo; senão `runner.json` legado (com
 * aviso de depreciação único e registro da data do primeiro aviso); senão padrão.
 */
export function readRunEngineConfig(homeDir: string, opts: { emitNotice?: boolean } = {}): RunEngineConfig {
  const settings = readJson(settingsPath(homeDir)) ?? {};
  const engines = (settings.engines ?? {}) as Record<string, { binary_path?: string; limits?: EngineLimits }>;
  const limits: Record<string, EngineLimits> = {};
  const binaryPaths: Record<string, string> = {};
  for (const [id, cfg] of Object.entries(engines)) {
    if (cfg?.limits) limits[id] = cfg.limits;
    if (cfg?.binary_path) binaryPaths[id] = cfg.binary_path;
  }
  if (settings.run_engine && typeof settings.run_engine === "object" && settings.run_engine.default) {
    return {
      engine: canonicalEngineId(String(settings.run_engine.default)),
      timeoutMin: typeof settings.run_engine.timeout_min === "number" ? settings.run_engine.timeout_min : undefined,
      fallbackEngines: Array.isArray(settings.run_engine.fallback) ? settings.run_engine.fallback.map(String) : [],
      limits,
      binaryPaths,
      source: "settings",
    };
  }
  const runner = readJson(runnerPath(homeDir));
  if (runner) {
    const { settingsPatch, notices } = translateRunnerJson(runner);
    if (opts.emitNotice !== false && notices.length) {
      defaultDeprecationEmitter.emitAll(notices);
      void recordFirstDeprecationNotice(homeDir).catch(() => {});
    }
    const legacyEngines = (settingsPatch.engines ?? {}) as Record<string, { binary_path?: string; limits?: EngineLimits }>;
    for (const [id, cfg] of Object.entries(legacyEngines)) {
      if (cfg.limits && !limits[id]) limits[id] = cfg.limits;
      if (cfg.binary_path && !binaryPaths[id]) binaryPaths[id] = cfg.binary_path;
    }
    return {
      engine: settingsPatch.run_engine?.default ?? "claude-sdk",
      timeoutMin: settingsPatch.run_engine?.timeout_min,
      fallbackEngines: settingsPatch.run_engine?.fallback ?? [],
      limits,
      binaryPaths,
      source: "runner.json",
    };
  }
  return { engine: "claude-sdk", fallbackEngines: [], limits, binaryPaths, source: "default" };
}

/** Grava campos de execução no formato novo (nunca em `runner.json`). */
export async function writeRunEngineConfig(
  homeDir: string,
  patch: { engine?: string; timeoutMin?: number; fallbackEngines?: string[]; limits?: Record<string, EngineLimits> }
): Promise<void> {
  const path = settingsPath(homeDir);
  let current = readJson(path) ?? {};
  // Primeira escrita com runner.json ainda presente: preserva o que ele definia.
  if (!current.run_engine?.default) {
    const runner = readJson(runnerPath(homeDir));
    if (runner) current = mergeSettings(current, translateRunnerJson(runner).settingsPatch);
  }
  const settingsPatch: Record<string, any> = {};
  const runEngine: Record<string, any> = {};
  if (patch.engine) runEngine.default = canonicalEngineId(patch.engine);
  if (patch.timeoutMin !== undefined) runEngine.timeout_min = patch.timeoutMin;
  if (patch.fallbackEngines) runEngine.fallback = patch.fallbackEngines.map(canonicalEngineId);
  if (Object.keys(runEngine).length) settingsPatch.run_engine = runEngine;
  if (patch.limits) {
    settingsPatch.engines = Object.fromEntries(Object.entries(patch.limits).map(([id, l]) => [canonicalEngineId(id), { limits: l }]));
  }
  const next = mergeSettings(current, settingsPatch);
  if (!next.run_engine?.default) next.run_engine = { ...(next.run_engine ?? {}), default: "claude-sdk" };
  mkdirSync(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}
