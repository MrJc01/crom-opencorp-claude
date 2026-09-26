import { accessSync, constants as fsConstants, existsSync, readFileSync, statSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { settingsSchema, type Settings } from "../../../schemas/settings.js";
import { parseSecurityPolicyTexto } from "../../../schemas/security-policy.js";
import { mkdirRecursive, writeFileAtomic } from "../../../utils/fs-safe.js";
import { expandTilde } from "../../../utils/paths.js";
import { ENGINE_BINARY_NAMES, findManagedBinary, findOnPath, readSettingsBinaryPath } from "../../engines/installer/binary-resolver.js";
import { canonicalEngineId, readRunEngineConfig } from "../../config/run-engine-config.js";
import { AppStore } from "./app-store.js";
import { TeamStore } from "../meetings/team-store.js";
import { FlowStore } from "../orchestration/flow-store.js";

export const MIN_NODE_MAJOR = 22;
export const DEFAULT_WORKSPACES_ROOT = "~/.opencorp/workspaces";

export type CheckStatus = "ok" | "fail" | "warn" | "info";

export interface DoctorCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
  items?: string[];
}

export interface DoctorResult {
  checks: DoctorCheck[];
  ok: boolean;
  exitCode: 0 | 1 | 2;
}

export interface DoctorOptions {
  nodeVersion?: string;
  pathEnv?: string;
  homeDir?: string;
  cwd?: string;
  settingsPath?: string;
  workspaceRoots?: string[];
  workspacePath?: string;
  securityPolicyPath?: string;
  budgetPath?: string;
  /**
   * Injetado para evitar dependência circular e facilitar testes.
   * Recebe um PID e devolve true se o processo estiver vivo.
   */
  pidVivo?: (pid: number) => boolean | Promise<boolean>;
  /** Função de fetch injetada para o check do secretário (testes podem mockar). */
  fetch?: typeof fetch;
}

export function errorMessage(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export function checkNodeVersion(
  version: string = process.version,
  minMajor: number = MIN_NODE_MAJOR,
): DoctorCheck {
  const base = { id: "node", label: "Node.js" } as const;
  const m = /^v(\d+)\./.exec(version);
  if (!m) {
    return {
      ...base,
      status: "fail",
      detail: `versão não reconhecida: "${version}" (esperado algo como v22.x)`,
    };
  }
  const major = Number(m[1]);
  if (major < minMajor) {
    return {
      ...base,
      status: "fail",
      detail: `Node.js ${version} encontrado, mas o opencorp requer >= ${minMajor}`,
    };
  }
  return { ...base, status: "ok", detail: `Node.js ${version} (requer >= ${minMajor})` };
}

export function lookupExecutable(
  comando: string,
  pathEnv: string = process.env.PATH ?? "",
  platform: string = process.platform,
): string | null {
  const separador = platform === "win32" ? ";" : ":";
  const extensoes = platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = pathEnv.split(separador).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const ext of extensoes) {
      const candidato = join(dir, comando + ext);
      try {
        accessSync(candidato, fsConstants.X_OK);
        if (statSync(candidato).isFile()) {
          return candidato;
        }
      } catch {
        // continua procurando no próximo candidato
      }
    }
  }
  return null;
}

/**
 * Motores efetivamente configurados: padrão das execuções (`run_engine.default`),
 * motor do Secretário (`default_conversation_engine`) e override do workspace.
 * Cada um precisa ser resolvido por `binary_path` → PATH → instalação gerenciada.
 */
export function checkConfiguredEngines(
  homeDir: string,
  pathEnv: string,
  opts: { conversationEngine?: string; workspacePath?: string } = {}
): DoctorCheck {
  const base = { id: "motores", label: "motores configurados" } as const;
  const usos = new Map<string, string[]>();
  const add = (id: string | undefined, uso: string) => {
    if (!id) return;
    const key = canonicalEngineId(id);
    usos.set(key, [...(usos.get(key) ?? []), uso]);
  };
  add(readRunEngineConfig(homeDir, { emitNotice: false }).engine, "execuções");
  add(opts.conversationEngine ?? "opencode", "Secretário");
  if (opts.workspacePath) {
    try {
      const cfg = JSON.parse(readFileSyncSafe(join(opts.workspacePath, ".opencorp", "config.json")) ?? "{}") as { conversationEngineOverride?: string };
      add(cfg.conversationEngineOverride, "Secretário do workspace");
    } catch {
      // config do workspace ilegível: coberto por outros checks
    }
  }
  const items: string[] = [];
  const faltando: string[] = [];
  for (const [id, lista] of usos) {
    const configurado = readSettingsBinaryPath(homeDir, id);
    const caminho =
      (configurado && ehExecutavel(configurado) ? configurado : undefined) ||
      findOnPath(ENGINE_BINARY_NAMES[id] ?? [id], pathEnv) ||
      findManagedBinary(homeDir, id)?.path;
    items.push(`${id} (${lista.join(", ")}): ${caminho ?? "NÃO ENCONTRADO"}`);
    if (!caminho) faltando.push(id);
  }
  if (faltando.length > 0) {
    return { ...base, status: "fail", detail: `binário não encontrado para: ${faltando.join(", ")} — instale ou ajuste settings.engines[id].binary_path`, items };
  }
  return { ...base, status: "ok", detail: `${usos.size} motor(es) resolvido(s)`, items };
}

function ehExecutavel(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readFileSyncSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

export interface LoadedSettings {
  check: DoctorCheck;
  settings?: Settings;
}

export async function loadSettings(settingsPath: string): Promise<LoadedSettings> {
  const base = { id: "settings", label: "settings global" } as const;
  if (!existsSync(settingsPath)) {
    return {
      check: {
        ...base,
        status: "info",
        detail: `${settingsPath} não encontrado (ok na primeira execução)`,
      },
    };
  }
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf8");
  } catch (erro) {
    return {
      check: {
        ...base,
        status: "fail",
        detail: `não foi possível ler ${settingsPath}: ${errorMessage(erro)}`,
      },
    };
  }
  let dados: unknown;
  try {
    dados = JSON.parse(raw);
  } catch (erro) {
    return {
      check: {
        ...base,
        status: "fail",
        detail: `JSON inválido em ${settingsPath}: ${errorMessage(erro)}`,
      },
    };
  }
  const parsed = settingsSchema.safeParse(dados);
  if (!parsed.success) {
    const problemas = parsed.error.issues
      .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(raiz)"}: ${i.message}`)
      .join("; ");
    return {
      check: {
        ...base,
        status: "fail",
        detail: `settings inválido em ${settingsPath} → ${problemas}`,
      },
    };
  }
  return {
    check: {
      ...base,
      status: "ok",
      detail: `${settingsPath} válido (versão ${parsed.data.version})`,
    },
    settings: parsed.data,
  };
}

export async function checkWritableDir(dir: string): Promise<DoctorCheck> {
  const base = { id: "escrita", label: `permissão de escrita em ${dir}` } as const;
  try {
    await mkdirRecursive(dir);
    const probe = join(dir, `.doctor-probe-${process.pid}-${Date.now()}`);
    await writeFileAtomic(probe, "opencorp-doctor");
    await rm(probe, { force: true });
    return {
      ...base,
      status: "ok",
      detail: `${dir} aceita escrita (arquivo de prova criado e removido)`,
    };
  } catch (erro) {
    return {
      ...base,
      status: "fail",
      detail: `não foi possível escrever em ${dir}: ${errorMessage(erro)}`,
    };
  }
}

export async function findSecretFiles(raizes: string[], maxDepth = 6): Promise<string[]> {
  const encontrados: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let entradas;
    try {
      entradas = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      const completo = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "node_modules" || entrada.name === ".git") continue;
        await walk(completo, depth + 1);
      } else if (entrada.isFile() && entrada.name.toLowerCase().startsWith("secrets")) {
        // .opencorp/secrets.json é o armazenamento isolado oficial suportado pelo OpenCorp
        if (completo.endsWith("/.opencorp/secrets.json") || completo.endsWith("/.opencorp/secrets")) continue;
        encontrados.push(completo);
      }
    }
  }
  for (const raiz of raizes) {
    const st = await stat(raiz).catch(() => null);
    if (st?.isDirectory()) await walk(raiz, 0);
  }
  return encontrados.sort();
}

export function checkSecrets(arquivos: string[], raizes: string[]): DoctorCheck {
  const base = { id: "segredos", label: "segredos nos workspaces" } as const;
  if (arquivos.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `${arquivos.length} arquivo(s) "secrets*" dentro de workspaces — segredos devem ficar em ~/.opencorp/ (fora de git e fora dos workspaces)`,
      items: arquivos,
    };
  }
  const algumExiste = raizes.some((r) => existsSync(r));
  return {
    ...base,
    status: "ok",
    detail: algumExiste
      ? 'nenhum arquivo "secrets*" dentro dos workspaces'
      : "nenhum diretório de workspaces encontrado (ok na primeira execução)",
  };
}

export function schedulerPidfilePath(homeDir: string): string {
  return join(homeDir, ".opencorp", "scheduler.pid");
}

export function schedulerDbPath(homeDir: string): string {
  return join(homeDir, ".opencorp", "scheduler.db");
}

export function hooksDir(wsPath: string): string {
  return join(wsPath, ".opencorp", "hooks");
}

export function appsDir(wsPath: string): string {
  return join(wsPath, ".opencorp", "apps");
}

export function teamsDir(wsPath: string): string {
  return join(wsPath, ".opencorp", "teams");
}

export function secretarioPidfilePath(homeDir: string): string {
  return join(homeDir, ".opencorp", "opencode-server.json");
}

export async function pidfileAlive(
  pidfile: string,
  pidVivoFn: (pid: number) => boolean | Promise<boolean>,
): Promise<{ vivo: boolean; pid: number | null }> {
  if (!existsSync(pidfile)) return { vivo: false, pid: null };
  try {
    const dados = JSON.parse(await readFile(pidfile, "utf8")) as { pid?: unknown };
    const pid = typeof dados.pid === "number" ? dados.pid : NaN;
    if (!Number.isFinite(pid)) return { vivo: false, pid: null };
    const vivo = await pidVivoFn(pid);
    return { vivo, pid };
  } catch {
    return { vivo: false, pid: null };
  }
}

async function contarJobsAtivos(dbPath: string): Promise<number> {
  if (!existsSync(dbPath)) return 0;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const linha = db.prepare("SELECT COUNT(*) as n FROM jobs WHERE ativo = 1").get() as { n: number };
    return Number(linha.n) || 0;
  } catch {
    return 0;
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* noop */
      }
    }
  }
}

export async function checkScheduler(
  homeDir: string,
  opcoes: { pidVivo?: (pid: number) => boolean | Promise<boolean> } = {},
): Promise<DoctorCheck> {
  const base = { id: "scheduler", label: "scheduler (daemon + jobs)" } as const;
  const pidfile = schedulerPidfilePath(homeDir);
  const dbPath = schedulerDbPath(homeDir);
  const pidVivoFn =
    opcoes.pidVivo ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  const existePidfile = existsSync(pidfile);
  const existeDb = existsSync(dbPath);
  if (!existePidfile && !existeDb) {
    return {
      ...base,
      status: "info",
      detail: "scheduler não configurado (sem pidfile nem scheduler.db) — ok na primeira execução",
    };
  }

  const estado = await pidfileAlive(pidfile, pidVivoFn);
  const jobs = await contarJobsAtivos(dbPath);
  const itens: string[] = [];

  if (existePidfile && estado.pid === null) {
    itens.push(`pidfile ${pidfile} ilegível (sem campo pid válido) — remova manualmente`);
    return {
      ...base,
      status: "warn",
      detail: `pidfile ilegível em ${pidfile} — scheduler pode estar rodando sem pidfile ou há resíduo`,
      items: itens,
    };
  }
  if (existePidfile && !estado.vivo && estado.pid !== null) {
    itens.push(
      `pidfile ${pidfile} aponta pid ${estado.pid} que NÃO está vivo — scheduler está morto`,
    );
  }

  if (jobs > 0 && (!estado.vivo || !existePidfile)) {
    itens.push(
      `${jobs} job(s) ativo(s) em ${dbPath} com scheduler ${existePidfile ? "morto" : "sem pidfile"} — não serão executados`,
    );
    return {
      ...base,
      status: "warn",
      detail: `scheduler morto (pidfile órfão) mas há ${jobs} job(s) ativo(s) — start com "opencorp scheduler start"`,
      items: itens,
    };
  }

  if (!estado.vivo && estado.pid !== null) {
    return {
      ...base,
      status: "warn",
      detail: `pidfile órfão em ${pidfile} (pid ${estado.pid} não está vivo) — remova com "opencorp scheduler stop"`,
      items: itens,
    };
  }

  if (estado.vivo && estado.pid !== null) {
    return {
      ...base,
      status: "ok",
      detail: `scheduler vivo (pid ${estado.pid}) — ${jobs} job(s) ativo(s)`,
    };
  }

  return {
    ...base,
    status: "info",
    detail: `scheduler parado — ${jobs} job(s) cadastrado(s) (sem execução até "opencorp scheduler start")`,
    items: itens,
  };
}

/**
 * 4.8 — detecta processos duplicados/órfãos (o cenário vivo da auditoria: 2 schedulers,
 * 4 opencode serve órfãos, N serve órfãos). Varre /proc — sem depender de `ps`.
 */
export async function checkDaemonsDuplicados(
  home: string,
  opcoes: { pidVivo?: (pid: number) => boolean | Promise<boolean> } = {},
): Promise<DoctorCheck> {
  const base = { id: "daemons", label: "processos (duplicados/órfãos)" } as const;
  const pidVivoFn =
    opcoes.pidVivo ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  // varre /proc contando processos por padrão de cmdline
  const grupos: Record<string, number[]> = {
    scheduler: [],
    "api/serve": [],
    "opencode serve": [],
    "daemon supervisor": [],
  };
  let pids: number[] = [];
  try {
    pids = (await readdir("/proc"))
      .filter((d) => /^\d+$/.test(d))
      .map(Number);
  } catch {
    return { ...base, status: "info", detail: "/proc indisponível — verificação ignorada" };
  }
  for (const pid of pids) {
    try {
      const cmd = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ");
      if (!cmd.includes("opencorp.mjs") && !/opencode serve/.test(cmd)) continue;
      if (/scheduler start/.test(cmd)) grupos["scheduler"]!.push(pid);
      else if (/opencorp\.mjs serve/.test(cmd)) grupos["api/serve"]!.push(pid);
      else if (/^opencode serve| opencode serve --port/.test(cmd)) grupos["opencode serve"]!.push(pid);
      else if (/daemon start --foreground/.test(cmd)) grupos["daemon supervisor"]!.push(pid);
    } catch {
      /* processo sumiu — ignora */
    }
  }

  // quantos de cada grupo são "legítimos" (registrados em pidfile)?
  const pidDePidfile = async (caminho: string): Promise<number | null> => {
    try {
      const dados = JSON.parse(await readFile(caminho, "utf8")) as { pid?: number };
      return typeof dados.pid === "number" ? dados.pid : null;
    } catch {
      return null;
    }
  };
  const pidScheduler = await pidDePidfile(join(home, ".opencorp", "scheduler.pid"));
  const pidApi = await pidDePidfile(join(home, ".opencorp", "api.pid"));
  const pidSecretario = await pidDePidfile(join(home, ".opencorp", "opencode-server.json"));

  const problemas: string[] = [];
  const schedulerVivos = (await Promise.all(grupos["scheduler"]!.map(async (p) => ((await pidVivoFn(p)) ? p : null)))).filter(
    (p): p is number => p !== null,
  );
  if (schedulerVivos.length > 1) {
    problemas.push(
      `${schedulerVivos.length} schedulers vivos (${schedulerVivos.join(", ")}) — pidfile registra ${
        pidScheduler ?? "nenhum"
      }; matar os excedentes ou usar "opencorp daemon install"`,
    );
  }
  const servesVivos = (await Promise.all(grupos["opencode serve"]!.map(async (p) => ((await pidVivoFn(p)) ? p : null)))).filter(
    (p): p is number => p !== null,
  );
  if (servesVivos.length > 1) {
    problemas.push(
      `${servesVivos.length} instâncias de opencode serve (${servesVivos.join(", ")}) — pidfile registra ${
        pidSecretario ?? "nenhuma"
      }; órfãs desperdiçam ~300MB cada — "opencorp secretario stop" e iniciar de novo`,
    );
  }
  const apiVivos = (await Promise.all(grupos["api/serve"]!.map(async (p) => ((await pidVivoFn(p)) ? p : null)))).filter(
    (p): p is number => p !== null,
  );
  if (apiVivos.length > 1) {
    problemas.push(
      `${apiVivos.length} servidores API (${apiVivos.join(", ")}) — pidfile registra ${pidApi ?? "nenhum"}`,
    );
  }

  if (problemas.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: problemas.join(" · "),
      items: problemas,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `sem duplicatas (scheduler ${schedulerVivos.length}, serve ${servesVivos.length}, api ${apiVivos.length})`,
  };
}

export async function checkHooks(wsPath: string): Promise<DoctorCheck> {
  const base = { id: "hooks", label: "hooks do workspace" } as const;
  const dir = hooksDir(wsPath);
  if (!existsSync(dir)) {
    return {
      ...base,
      status: "info",
      detail: `diretório ${dir} não existe — sem hooks configurados`,
    };
  }
  let entradas;
  try {
    entradas = await readdir(dir);
  } catch (erro) {
    return {
      ...base,
      status: "warn",
      detail: `não foi possível ler ${dir}: ${errorMessage(erro)}`,
    };
  }
  const arquivos = entradas.filter((f) => f.endsWith(".json"));
  if (arquivos.length === 0) {
    return {
      ...base,
      status: "info",
      detail: `${dir} vazio — sem hooks configurados`,
    };
  }
  const invalidos: string[] = [];
  for (const f of arquivos) {
    try {
      JSON.parse(await readFile(join(dir, f), "utf8"));
    } catch (erro) {
      invalidos.push(`${f}: ${errorMessage(erro)}`);
    }
  }
  if (invalidos.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `${invalidos.length} hook(s) com JSON inválido em ${dir}`,
      items: invalidos,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${arquivos.length} hook(s) válido(s) em ${dir}`,
  };
}

export async function checkApps(wsPath: string): Promise<DoctorCheck> {
  const base = { id: "apps", label: "apps do workspace" } as const;
  const store = new AppStore();
  const dir = appsDir(wsPath);
  if (!existsSync(dir)) {
    return {
      ...base,
      status: "info",
      detail: `diretório ${dir} não existe — sem apps configurados`,
    };
  }
  let entradas;
  try {
    entradas = await readdir(dir);
  } catch (erro) {
    return {
      ...base,
      status: "warn",
      detail: `não foi possível ler ${dir}: ${errorMessage(erro)}`,
    };
  }
  const arquivos = entradas.filter((f) => f.endsWith(".json"));
  if (arquivos.length === 0) {
    return {
      ...base,
      status: "info",
      detail: `${dir} vazio — sem apps configurados`,
    };
  }
  const invalidos: string[] = [];
  for (const f of arquivos) {
    try {
      store.validarTexto(await readFile(join(dir, f), "utf8"), f);
    } catch (erro) {
      invalidos.push(`${f}: ${errorMessage(erro)}`);
    }
  }
  if (invalidos.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `${invalidos.length} app(s) com spec inválida em ${dir}`,
      items: invalidos,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${arquivos.length} app(s) válido(s) em ${dir}`,
  };
}

/**
 * Ledger unificado (corp.db `execucoes`, PLANO-UNIFICACAO): detecta execuções
 * órfãs — presas em "executando" com fim em aberto há mais de 24h — que
 * indicam processo morto sem finalizar (anti-stale observável).
 */
export async function checkLedger(wsPath: string, agoraMs = Date.now()): Promise<DoctorCheck> {
  const base = { id: "ledger", label: "ledger de execuções (corp.db)" } as const;
  const dbPath = join(wsPath, ".opencorp", "corp.db");
  if (!existsSync(dbPath)) {
    return { ...base, status: "info", detail: "corp.db inexistente — ledger ainda sem execuções" };
  }
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (erro) {
    return { ...base, status: "fail", detail: `corp.db não abre: ${errorMessage(erro)}` };
  }
  try {
    const total = db.prepare("SELECT COUNT(*) AS n FROM execucoes").get() as { n: number };
    const limite = agoraMs - 24 * 3600_000;
    const orfas = db
      .prepare(
        "SELECT id, agente, inicio FROM execucoes WHERE status = 'executando' AND fim IS NULL AND inicio < ? ORDER BY inicio",
      )
      .all(new Date(limite).toISOString()) as Array<{ id: string; agente: string; inicio: string }>;
    if (orfas.length === 0) {
      return {
        ...base,
        status: "ok",
        detail: `${total.n} execução(ões) no ledger — nenhuma órfã (>24h em "executando")`,
      };
    }
    return {
      ...base,
      status: "warn",
      detail: `${orfas.length} execução(ões) presas em "executando" há >24h (processo morto sem finalizar?)`,
      items: orfas.slice(0, 5).map((o) => `${o.id} · ${o.agente} · início ${o.inicio.slice(0, 19).replace("T", " ")}`),
    };
  } catch (erro) {
    return { ...base, status: "fail", detail: `consulta ao ledger falhou: ${errorMessage(erro)}` };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export async function checkTeams(wsPath: string): Promise<DoctorCheck> {  const base = { id: "teams", label: "teams do workspace" } as const;
  const store = new TeamStore();
  const dir = teamsDir(wsPath);
  if (!existsSync(dir)) {
    return {
      ...base,
      status: "info",
      detail: `diretório ${dir} não existe — sem teams configurados`,
    };
  }
  let entradas;
  try {
    entradas = await readdir(dir);
  } catch (erro) {
    return {
      ...base,
      status: "warn",
      detail: `não foi possível ler ${dir}: ${errorMessage(erro)}`,
    };
  }
  const arquivos = entradas.filter((f) => f.endsWith(".json"));
  if (arquivos.length === 0) {
    return {
      ...base,
      status: "info",
      detail: `${dir} vazio — sem teams configurados`,
    };
  }
  const invalidos: string[] = [];
  for (const f of arquivos) {
    try {
      store.validarTexto(await readFile(join(dir, f), "utf8"), f);
    } catch (erro) {
      invalidos.push(`${f}: ${errorMessage(erro)}`);
    }
  }
  if (invalidos.length > 0) {
    return {
      ...base,
      status: "warn",
      detail: `${invalidos.length} team(s) com spec inválida em ${dir}`,
      items: invalidos,
    };
  }
  return {
    ...base,
    status: "ok",
    detail: `${arquivos.length} team(s) válido(s) em ${dir}`,
  };
}

/** Flows do workspace: todo .json precisa passar na validação de schema + semântica. */
export async function checkFlows(wsPath: string): Promise<DoctorCheck> {
  const base = { id: "flows", label: "flows do workspace" } as const;
  const store = new FlowStore();
  const dir = store.dir(wsPath);
  if (!existsSync(dir)) {
    return { ...base, status: "info", detail: `diretório ${dir} não existe — sem flows configurados` };
  }
  let entradas: string[];
  try {
    entradas = await readdir(dir);
  } catch (erro) {
    return { ...base, status: "warn", detail: `não foi possível ler ${dir}: ${errorMessage(erro)}` };
  }
  const arquivos = entradas.filter((f) => f.endsWith(".json"));
  if (arquivos.length === 0) {
    return { ...base, status: "info", detail: `${dir} vazio — sem flows configurados` };
  }
  const invalidos: string[] = [];
  for (const f of arquivos) {
    try {
      store.validarTexto(await readFile(join(dir, f), "utf8"), f);
    } catch (erro) {
      invalidos.push(`${f}: ${errorMessage(erro)}`);
    }
  }
  if (invalidos.length > 0) {
    return { ...base, status: "fail", detail: `${invalidos.length} flow(s) inválido(s) em ${dir} — não executam`, items: invalidos };
  }
  return { ...base, status: "ok", detail: `${arquivos.length} flow(s) válido(s) em ${dir}` };
}

/** Integridade agenda↔fluxo: todo job `flow run` (ativo ou pausado) precisa
 *  apontar para um flow que existe no workspace — job para flow fantasma
 *  falha para sempre a cada tick. */
export async function checkFlowsAgendados(homeDir: string): Promise<DoctorCheck> {
  const base = { id: "flows-agendados", label: "jobs flow run → flows existentes" } as const;
  const dbPath = join(homeDir, ".opencorp", "scheduler.db");
  if (!existsSync(dbPath)) {
    return { ...base, status: "info", detail: "scheduler.db inexistente — sem agendamentos" };
  }
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (erro) {
    return { ...base, status: "fail", detail: `scheduler.db não abre: ${errorMessage(erro)}` };
  }
  try {
    const jobs = db.prepare("SELECT id, workspace, args FROM jobs").all() as Array<{ id: string; workspace: string; args: string }>;
    const quebrados: string[] = [];
    let total = 0;
    for (const job of jobs) {
      let args: string[];
      try {
        args = JSON.parse(job.args);
      } catch {
        continue;
      }
      if (args[0] !== "flow" || args[1] !== "run") continue;
      total++;
      const flowId = String(args[2] ?? "");
      const wsDir = join(homeDir, ".opencorp", "workspaces", job.workspace || "");
      const flowPath = join(wsDir, ".opencorp", "flows", `${flowId}.json`);
      if (!flowId || !existsSync(flowPath)) {
        quebrados.push(`${job.id} → flow "${flowId || "?"}" inexistente em ${job.workspace || "?"}`);
      }
    }
    if (quebrados.length > 0) {
      return { ...base, status: "fail", detail: `${quebrados.length}/${total} job(s) flow run apontam para flows fantasmas`, items: quebrados };
    }
    return { ...base, status: "ok", detail: `${total} job(s) flow run com destino existente` };
  } catch (erro) {
    return { ...base, status: "fail", detail: `consulta ao scheduler falhou: ${errorMessage(erro)}` };
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

export async function checkSecretario(
  homeDir: string,
  opcoes: { fetch?: typeof fetch; pidVivo?: (pid: number) => boolean | Promise<boolean> } = {},
): Promise<DoctorCheck> {
  const base = { id: "secretario", label: "secretário (opencode-server)" } as const;
  const pidfile = secretarioPidfilePath(homeDir);
  const pidVivoFn =
    opcoes.pidVivo ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const fetchFn: typeof fetch | undefined = opcoes.fetch ?? (typeof fetch === "function" ? fetch : undefined);

  if (!existsSync(pidfile)) {
    return {
      ...base,
      status: "ok",
      detail: `secretário parado (sem pidfile ${pidfile}) — ok, será iniciado por "opencorp serve"`,
    };
  }

  let info: { pid?: unknown; porta?: unknown };
  try {
    info = JSON.parse(await readFile(pidfile, "utf8")) as { pid?: unknown; porta?: unknown };
  } catch {
    return {
      ...base,
      status: "warn",
      detail: `pidfile ${pidfile} ilegível — remova manualmente`,
    };
  }
  const pid = typeof info.pid === "number" ? info.pid : NaN;
  const porta = typeof info.porta === "number" ? info.porta : NaN;
  if (!Number.isFinite(pid) || !Number.isFinite(porta)) {
    return {
      ...base,
      status: "warn",
      detail: `pidfile ${pidfile} sem pid/porta válidos — remova manualmente`,
    };
  }
  const vivo = await pidVivoFn(pid);
  if (!vivo) {
    return {
      ...base,
      status: "warn",
      detail: `pidfile ${pidfile} órfão (pid ${pid} não está vivo) — remova manualmente`,
    };
  }

  if (!fetchFn) {
    return {
      ...base,
      status: "info",
      detail: `secretário vivo (pid ${pid}, porta ${porta}) — sem fetch disponível, porta não testada`,
    };
  }
  try {
    const resp = await fetchFn(`http://127.0.0.1:${porta}/health`, { signal: AbortSignal.timeout(2000) });
    if (resp.ok || resp.status === 401 || resp.status === 404) {
      return {
        ...base,
        status: "ok",
        detail: `secretário vivo (pid ${pid}, porta ${porta}) — /health respondeu HTTP ${resp.status}`,
      };
    }
    return {
      ...base,
      status: "warn",
      detail: `secretário vivo (pid ${pid}) mas porta ${porta} respondeu ${resp.status}`,
    };
  } catch {
    return {
      ...base,
      status: "warn",
      detail: `secretário vivo (pid ${pid}) mas porta ${porta} não respondeu em 2s`,
    };
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const home = options.homeDir ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const nodeVersion = options.nodeVersion ?? process.version;
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const settingsPath = options.settingsPath ?? join(home, ".opencorp", "settings.json");

  const checks: DoctorCheck[] = [];
  checks.push(checkNodeVersion(nodeVersion));
  const loaded = await loadSettings(settingsPath);
  checks.push(checkConfiguredEngines(home, pathEnv, { conversationEngine: loaded.settings?.default_conversation_engine, workspacePath: options.workspacePath }));
  checks.push(loaded.check);

  let raizes = options.workspaceRoots;
  if (!raizes) {
    const candidatos = [expandTilde(DEFAULT_WORKSPACES_ROOT, home), join(cwd, "workspaces")];
    if (loaded.settings) {
      candidatos.unshift(expandTilde(loaded.settings.paths.workspaces_root, home));
    }
    raizes = [...new Set(candidatos)];
  }

  const arquivosSecretos = await findSecretFiles(raizes);
  checks.push(checkSecrets(arquivosSecretos, raizes));

  checks.push(await checkWritableDir(join(home, ".opencorp")));

  if (options.securityPolicyPath !== undefined) {
    checks.push(await checarPolicy(options.securityPolicyPath));
  } else {
    checks.push({
      id: "policy",
      label: "security_policy.json",
      status: "info",
      detail: "nenhum workspace ativo — policy não verificada",
    });
  }
  if (options.budgetPath !== undefined) {
    checks.push(await checarBudget(options.budgetPath));
  } else {
    checks.push({
      id: "budget",
      label: "budget.json",
      status: "info",
      detail: "nenhum workspace ativo — budget não verificado",
    });
  }

  checks.push(await checkScheduler(home, { pidVivo: options.pidVivo }));
  checks.push(await checkFlowsAgendados(home));
  checks.push(await checkSecretario(home, { pidVivo: options.pidVivo, fetch: options.fetch }));
  checks.push(await checkDaemonsDuplicados(home, { pidVivo: options.pidVivo }));

  if (options.workspacePath !== undefined) {
    const wsPath = options.workspacePath;
    checks.push(await checkHooks(wsPath));
    checks.push(await checkApps(wsPath));
    checks.push(await checkTeams(wsPath));
    checks.push(await checkFlows(wsPath));
    checks.push(await checkLedger(wsPath));
  } else {
    checks.push({
      id: "hooks",
      label: "hooks do workspace",
      status: "info",
      detail: "nenhum workspace ativo — hooks não verificados",
    });
    checks.push({
      id: "apps",
      label: "apps do workspace",
      status: "info",
      detail: "nenhum workspace ativo — apps não verificados",
    });
    checks.push({
      id: "teams",
      label: "teams do workspace",
      status: "info",
      detail: "nenhum workspace ativo — teams não verificados",
    });
    checks.push({
      id: "flows",
      label: "flows do workspace",
      status: "info",
      detail: "nenhum workspace ativo — flows não verificados",
    });
    checks.push({
      id: "ledger",
      label: "ledger de execuções (corp.db)",
      status: "info",
      detail: "nenhum workspace ativo — ledger não verificado",
    });
  }

  const falhas = checks.filter((c) => c.status === "fail");
  const ok = falhas.length === 0;
  const exitCode: 0 | 1 | 2 = ok
    ? 0
    : falhas.some((c) => ["settings", "policy", "budget"].includes(c.id))
      ? 2
      : 1;

  return { checks, ok, exitCode };
}

export async function checarPolicy(path: string): Promise<DoctorCheck> {
  const base = { id: "policy", label: "security_policy.json" } as const;
  if (!existsSync(path)) {
    return {
      ...base,
      status: "info",
      detail: `${path} não encontrado (ok — sem policy, guard usa policy vazia)`,
    };
  }
  try {
    parseSecurityPolicyTexto(await readFile(path, "utf8"), path);
  } catch (erro) {
    return {
      ...base,
      status: "fail",
      detail: erro instanceof Error ? erro.message : String(erro),
    };
  }
  return { ...base, status: "ok", detail: `${path} válido` };
}

export async function checarBudget(path: string): Promise<DoctorCheck> {
  const base = { id: "budget", label: "budget.json" } as const;
  if (!existsSync(path)) {
    return {
      ...base,
      status: "info",
      detail: `${path} não encontrado (ok — sem consumo registrado)`,
    };
  }
  try {
    const dados = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const diaOk = dados.dia === null || typeof dados.dia === "string";
    if (!diaOk || typeof dados.workspace_usd_hoje !== "number") {
      return {
        ...base,
        status: "fail",
        detail: `budget.json inválido em ${path} → campos obrigatórios "dia" (string|null) e "workspace_usd_hoje" (number)`,
      };
    }
    const semConsumo = dados.dia === null ? " (sem consumo)" : ` (dia ${dados.dia})`;
    return { ...base, status: "ok", detail: `${path} válido${semConsumo}` };
  } catch (erro) {
    return {
      ...base,
      status: "fail",
      detail: `budget.json inválido em ${path}: ${erro instanceof Error ? erro.message : String(erro)}`,
    };
  }
}
