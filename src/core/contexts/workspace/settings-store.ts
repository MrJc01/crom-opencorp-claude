import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { settingsSchema, type Settings } from "../../../schemas/settings.js";
import { writeFileAtomic } from "../../../utils/fs-safe.js";
import { expandTilde } from "../../../utils/paths.js";

export type Scope = "global" | "workspace";
export type Origem = "cli" | "agente" | "workspace" | "global" | "default";

export interface StoreOptions {
  homeDir?: string;
  cwd?: string;
}

export interface ScopeOptions {
  scope?: Scope;
  workspaceId?: string;
  workspaceDir?: string;
}

export interface ResolveOptions extends ScopeOptions {
  overrides?: Record<string, unknown>;
}

export class SettingsError extends Error {
  readonly chave?: string;
  readonly exitCode: number;

  constructor(mensagem: string, opts: { chave?: string; exitCode?: number } = {}) {
    super(mensagem);
    this.name = "SettingsError";
    this.chave = opts.chave;
    this.exitCode = opts.exitCode ?? 2;
  }
}

export interface EntradaSettings {
  chave: string;
  valor: unknown;
  origem: Origem;
}

export interface Resolucao {
  settings: Settings;
  origens: Map<string, Origem>;
  globalPath: string;
  workspaceDir: string | null;
  workspacePath: string | null;
}

function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function ehObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor);
}

function mergeDeep(base: unknown, sobre: unknown): unknown {
  if (ehObjetoPlano(base) && ehObjetoPlano(sobre)) {
    const saida: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(sobre)) {
      saida[k] = k in saida ? mergeDeep(saida[k], v) : v;
    }
    return saida;
  }
  return sobre === undefined ? base : sobre;
}

function folhasDe(valor: unknown, prefixo = ""): string[] {
  if (ehObjetoPlano(valor)) {
    const chaves: string[] = [];
    for (const [k, v] of Object.entries(valor)) {
      const caminho = prefixo ? `${prefixo}.${k}` : k;
      if (ehObjetoPlano(v)) {
        chaves.push(...folhasDe(v, caminho));
      } else {
        chaves.push(caminho);
      }
    }
    return chaves;
  }
  return prefixo ? [prefixo] : [];
}

function deepGet(dados: unknown, segs: string[]): unknown {
  let atual: unknown = dados;
  for (const s of segs) {
    if (!ehObjetoPlano(atual) || !(s in atual)) return undefined;
    atual = atual[s];
  }
  return atual;
}

function deepHas(dados: unknown, segs: string[]): boolean {
  if (segs.length === 0) return false;
  let atual: unknown = dados;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    if (!ehObjetoPlano(atual) || !(s in atual)) return false;
    atual = atual[s];
  }
  const ultima = segs[segs.length - 1]!;
  return ehObjetoPlano(atual) && ultima in atual;
}

function deepSet(dados: Record<string, unknown>, segs: string[], valor: unknown): Record<string, unknown> {
  const copia = structuredClone(dados);
  let no: Record<string, unknown> = copia;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    const filho = no[s];
    no[s] = ehObjetoPlano(filho) ? filho : {};
    no = no[s] as Record<string, unknown>;
  }
  no[segs[segs.length - 1]!] = valor;
  return copia;
}

function deepDelete(dados: Record<string, unknown>, segs: string[]): Record<string, unknown> {
  const copia = structuredClone(dados);
  let no: Record<string, unknown> = copia;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    const filho = no[s];
    if (!ehObjetoPlano(filho)) return copia;
    no = filho as Record<string, unknown>;
  }
  delete no[segs[segs.length - 1]!];
  return copia;
}

function prefixoPresente(dados: Record<string, unknown>, segs: string[]): boolean {
  for (let i = 1; i <= segs.length; i++) {
    if (deepHas(dados, segs.slice(0, i))) return true;
  }
  return false;
}

function origemDe(
  segs: string[],
  overrides: Record<string, unknown> | undefined,
  workspace: Record<string, unknown> | undefined,
  global: Record<string, unknown>,
): Origem {
  if (overrides && prefixoPresente(overrides, segs)) return "cli";
  if (workspace && deepHas(workspace, segs)) return "workspace";
  if (deepHas(global, segs)) return "global";
  return "default";
}

export function parseValor(bruto: string): unknown {
  const t = bruto.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  const pareceJson =
    (t.startsWith("{") && t.endsWith("}")) ||
    (t.startsWith("[") && t.endsWith("]")) ||
    (t.startsWith('"') && t.endsWith('"'));
  if (pareceJson) {
    try {
      return JSON.parse(t);
    } catch {
      return bruto;
    }
  }
  return bruto;
}

export function formatarValor(valor: unknown): string {
  if (typeof valor === "string") return valor;
  return JSON.stringify(valor);
}

function dividirChave(chave: string): string[] {
  const segs = chave.split(".").filter((s) => s.length > 0);
  if (segs.length === 0) {
    throw new SettingsError("chave vazia — informe algo como budget.daily_usd", { exitCode: 1 });
  }
  return segs;
}

function desembrulharSchema(schema: unknown): Record<string, unknown> | null {
  let atual = schema as { shape?: Record<string, unknown>; unwrap?: () => unknown; def?: { innerType?: unknown } } | null;
  for (let i = 0; i < 8 && atual; i++) {
    if (atual.shape && typeof atual.shape === "object") return atual.shape;
    if (typeof atual.unwrap === "function") {
      atual = atual.unwrap() as typeof atual;
      continue;
    }
    if (atual.def && typeof atual.def === "object" && "innerType" in atual.def && atual.def.innerType) {
      atual = atual.def.innerType as typeof atual;
      continue;
    }
    break;
  }
  return null;
}

function chaveExisteNoSchema(segs: string[]): boolean {
  let atual: unknown = settingsSchema;
  for (const s of segs) {
    const shape = desembrulharSchema(atual);
    if (!shape || !(s in shape)) return false;
    atual = shape[s];
  }
  return segs.length > 0;
}

function origemAproximada(origens: Map<string, Origem>, chave: string): Origem {
  const direta = origens.get(chave);
  if (direta) return direta;
  for (const [k, v] of origens) {
    if (k.startsWith(`${chave}.`)) return v;
  }
  return "default";
}

const CONFIG_RELATIVO = join(".opencorp", "config.json");
const DEFAULT_WORKSPACES_ROOT = "~/.opencorp/workspaces";

interface Leitura {
  path: string;
  exists: boolean;
  dados: Record<string, unknown>;
  parsed?: Settings;
}

export class SettingsStore {
  private readonly homeDir: string;
  private readonly cwd: string;

  constructor(opts: StoreOptions = {}) {
    this.homeDir = opts.homeDir ?? homedir();
    this.cwd = opts.cwd ?? process.cwd();
  }

  globalPath(): string {
    return join(this.homeDir, ".opencorp", "settings.json");
  }

  async diretorioWorkspace(opts: ScopeOptions = {}): Promise<string | null> {
    if (opts.workspaceDir) return opts.workspaceDir;
    if (opts.workspaceId) {
      const g = await this.lerArquivo(this.globalPath(), "settings global");
      const raiz = expandTilde(g.parsed?.paths.workspaces_root ?? DEFAULT_WORKSPACES_ROOT, this.homeDir);
      return join(raiz, opts.workspaceId);
    }
    if (existsSync(join(this.cwd, CONFIG_RELATIVO))) return this.cwd;
    return null;
  }

  async caminhoWorkspace(opts: ScopeOptions = {}): Promise<string | null> {
    const dir = await this.diretorioWorkspace(opts);
    return dir ? join(dir, CONFIG_RELATIVO) : null;
  }

  async caminhoDoEscopo(opts: ScopeOptions = {}): Promise<{ path: string; rotulo: string }> {
    if (opts.scope === "workspace") {
      const caminho = await this.caminhoWorkspace(opts);
      if (!caminho) {
        throw new SettingsError(
          "nenhum workspace resolvido para --scope workspace — use --workspace <id> ou rode dentro de um workspace (pasta com .opencorp/config.json)",
          { exitCode: 1 },
        );
      }
      return { path: caminho, rotulo: "config do workspace" };
    }
    return { path: this.globalPath(), rotulo: "settings global" };
  }

  private async lerArquivo(path: string, rotulo: string): Promise<Leitura> {
    if (!existsSync(path)) return { path, exists: false, dados: {} };
    let bruto: string;
    try {
      bruto = await readFile(path, "utf8");
    } catch (erro) {
      throw new SettingsError(`não foi possível ler ${rotulo} (${path}): ${msg(erro)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(bruto);
    } catch (erro) {
      throw new SettingsError(`JSON inválido em ${rotulo} (${path}): ${msg(erro)}`);
    }
    const parsed = settingsSchema.safeParse(json);
    if (!parsed.success) {
      const iss = parsed.error.issues[0]!;
      const chave = iss.path.join(".");
      throw new SettingsError(
        `settings inválido em ${rotulo} (${path}) → ${chave || "(raiz)"}: ${iss.message}`,
        { chave: chave || undefined },
      );
    }
    return { path, exists: true, dados: json as Record<string, unknown>, parsed: parsed.data };
  }

  async resolve(opts: ResolveOptions = {}): Promise<Resolucao> {
    const g = await this.lerArquivo(this.globalPath(), "settings global");
    let w: { path: string; dados: Record<string, unknown> } | null = null;
    let workspaceDir: string | null = null;
    if (opts.scope !== "global") {
      const dir = await this.diretorioWorkspace(opts);
      if (dir) {
        const caminhoWs = join(dir, CONFIG_RELATIVO);
        const lido = await this.lerArquivo(caminhoWs, "config do workspace");
        w = { path: caminhoWs, dados: lido.dados };
        workspaceDir = dir;
      }
    }
    const base = w ? (mergeDeep(g.dados, w.dados) as Record<string, unknown>) : g.dados;
    const comCli = opts.overrides ? (mergeDeep(base, opts.overrides) as Record<string, unknown>) : base;
    const parsed = settingsSchema.safeParse(comCli);
    if (!parsed.success) {
      const iss = parsed.error.issues[0]!;
      const chave = iss.path.join(".");
      throw new SettingsError(
        `settings mesclados inválidos → ${chave || "(raiz)"}: ${iss.message}`,
        { chave: chave || undefined },
      );
    }
    const origens = new Map<string, Origem>();
    for (const chave of folhasDe(parsed.data)) {
      origens.set(chave, origemDe(chave.split("."), opts.overrides, w?.dados, g.dados));
    }
    return {
      settings: parsed.data,
      origens,
      globalPath: this.globalPath(),
      workspaceDir,
      workspacePath: w?.path ?? null,
    };
  }

  async get(chave: string, opts: ScopeOptions = {}): Promise<{ chave: string; valor: unknown; origem: Origem }> {
    const segs = dividirChave(chave);
    if (opts.scope) {
      const { path, rotulo } = await this.caminhoDoEscopo(opts);
      const lido = await this.lerArquivo(path, rotulo);
      const defaults = settingsSchema.parse({}) as unknown as Record<string, unknown>;
      const definida = deepHas(lido.dados, segs);
      const valor = definida ? deepGet(lido.dados, segs) : deepGet(defaults, segs);
      if (valor === undefined) {
        throw new SettingsError(
          `chave desconhecida: "${chave}" (use "opencorp settings list" para ver as chaves válidas)`,
          { chave, exitCode: 1 },
        );
      }
      return { chave, valor, origem: definida ? opts.scope : "default" };
    }
    const r = await this.resolve(opts);
    const valor = deepGet(r.settings as unknown as Record<string, unknown>, segs);
    if (valor === undefined) {
      throw new SettingsError(
        `chave desconhecida: "${chave}" (use "opencorp settings list" para ver as chaves válidas)`,
        { chave, exitCode: 1 },
      );
    }
    return { chave, valor, origem: origemAproximada(r.origens, chave) };
  }

  async set(
    chave: string,
    valorBruto: string,
    opts: ScopeOptions = {},
  ): Promise<{ path: string; antes: unknown; depois: unknown }> {
    const segs = dividirChave(chave);
    const valor = parseValor(valorBruto);
    const { path, rotulo } = await this.caminhoDoEscopo(opts);
    const lido = await this.lerArquivo(path, rotulo);
    const antes = deepGet(lido.dados, segs);
    const atualizado = deepSet(lido.dados, segs, valor);
    const parsed = settingsSchema.safeParse(atualizado);
    if (!parsed.success) {
      const iss = parsed.error.issues[0]!;
      const alvo = iss.path.join(".");
      throw new SettingsError(
        `valor inválido para "${chave}" → ${alvo || "(raiz)"}: ${iss.message} (nada foi salvo)`,
        { chave },
      );
    }
    const navegado = deepGet(parsed.data as unknown as Record<string, unknown>, segs);
    if (navegado === undefined) {
      throw new SettingsError(
        `chave desconhecida: "${chave}" (use "opencorp settings list" para ver as chaves válidas)`,
        { chave, exitCode: 1 },
      );
    }
    await writeFileAtomic(path, `${JSON.stringify(atualizado, null, 2)}\n`);
    return { path, antes, depois: valor };
  }

  async reset(
    chave: string,
    opts: ScopeOptions = {},
  ): Promise<{ path: string; changed: boolean; valor: unknown; origem: Origem }> {
    const segs = dividirChave(chave);
    const { path, rotulo } = await this.caminhoDoEscopo(opts);
    const lido = await this.lerArquivo(path, rotulo);
    if (!lido.exists || !deepHas(lido.dados, segs)) {
      const r = await this.resolve(opts);
      const valor = deepGet(r.settings as unknown as Record<string, unknown>, segs);
      if (valor === undefined && !chaveExisteNoSchema(segs)) {
        throw new SettingsError(`chave desconhecida: "${chave}" (use "opencorp settings list")`, {
          chave,
          exitCode: 1,
        });
      }
      return { path, changed: false, valor, origem: origemAproximada(r.origens, chave) };
    }
    const atualizado = deepDelete(lido.dados, segs);
    const parsed = settingsSchema.safeParse(atualizado);
    if (!parsed.success) {
      const iss = parsed.error.issues[0]!;
      throw new SettingsError(
        `settings resultantes inválidos → ${iss.path.join(".")}: ${iss.message} (nada foi salvo)`,
      );
    }
    await writeFileAtomic(path, `${JSON.stringify(atualizado, null, 2)}\n`);
    const r = await this.resolve(opts);
    return {
      path,
      changed: true,
      valor: deepGet(r.settings as unknown as Record<string, unknown>, segs),
      origem: origemAproximada(r.origens, chave),
    };
  }

  async list(opts: ScopeOptions = {}): Promise<EntradaSettings[]> {
    const r = await this.resolve(opts);
    const dados = r.settings as unknown as Record<string, unknown>;
    return folhasDe(r.settings)
      .map((chave) => ({
        chave,
        valor: deepGet(dados, chave.split(".")),
        origem: r.origens.get(chave) ?? "default",
      }))
      .sort((a, b) => a.chave.localeCompare(b.chave));
  }

  async paths(opts: ScopeOptions = {}): Promise<{ global: string; workspace: string | null }> {
    if (opts.scope === "global") {
      return { global: this.globalPath(), workspace: null };
    }
    const workspace = await this.caminhoWorkspace(opts);
    return { global: this.globalPath(), workspace };
  }

  async revalidar(opts: ScopeOptions = {}): Promise<void> {
    const { path, rotulo } = await this.caminhoDoEscopo(opts);
    await this.lerArquivo(path, rotulo);
  }
}
