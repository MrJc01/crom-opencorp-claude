import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { spawnAsync } from "../../../utils/spawn-async.js";
import { z } from "zod";
import { OpencorpError } from "../../shared/errors.js";
import { FlowStore } from "../orchestration/flow-store.js";
import { TaskStore, type MensagemTask } from "./task-store.js";
import { OpencorpDb } from "../../db/opencorp-db.js";
import { writeFileAtomic } from "../../../utils/fs-safe.js";
import { opencorpHome } from "../../../utils/paths.js";

export class AssetError extends OpencorpError {}

export const KINDS_ASSET = [
  "agente",
  "skill",
  "prompt",
  "task",
  "flow",
  "pack",
  "workspace-parcial",
] as const;

export type KindAsset = (typeof KINDS_ASSET)[number];

/** Tipos que um workspace-parcial pode filtrar via --somente. */
export const KINDS_FILTRAVEIS: readonly KindAsset[] = ["agente", "skill", "prompt", "task", "flow"];

/** Aceita sinônimos plural/inglês do --somente (ex.: "tasks" → "task"). */
export function normalizarTipoFiltravel(bruto: string): KindAsset | undefined {
  const t = bruto.trim().toLowerCase();
  if (["task", "tasks"].includes(t)) return "task";
  if (["flow", "flows"].includes(t)) return "flow";
  if (["agente", "agentes", "agents"].includes(t)) return "agente";
  if (["skill", "skills"].includes(t)) return "skill";
  if (["prompt", "prompts"].includes(t)) return "prompt";
  return undefined;
}

/** Versão atual do esquema de cada kind (migração pura pré-zod). */
export const KIND_VERSION_ATUAL = 1;

export interface DependenciaAsset {
  kind: string;
  nome: string;
  versaoMin?: string;
}

export interface AssetManifest {
  kind: KindAsset;
  kindVersion: number;
  nome: string;
  versao: string;
  dependeDe: DependenciaAsset[];
  autor?: string;
}

const dependenciaSchema = z.object({
  kind: z.string().min(1),
  nome: z.string().min(1),
  versaoMin: z.string().optional(),
});

const manifestSchema = z.object({
  kind: z.enum(KINDS_ASSET),
  kindVersion: z.number().int().positive(),
  nome: z.string().min(1),
  versao: z.string().regex(/^\d+\.\d+\.\d+$/, "use semver (ex.: 1.2.3)"),
  dependeDe: z.array(dependenciaSchema).default([]),
  autor: z.string().optional(),
});

const SEMVER_RE = /^\d+\.\d+\.\d+$/;

function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

// ── DENYLIST de segredos (nunca entra no pack) ─────────────────────────────
// Estende a denylist do template: secrets/, *.pem, .env, *.key, corp.db,
// corp.db-* (+ nomes *secret*/ *key* herdados do template).
export function ehSegredo(relativo: string): boolean {
  const normalizado = relativo.replace(/\\/g, "/");
  const segs = normalizado.split("/").filter(Boolean);
  const nome = segs[segs.length - 1] ?? normalizado;
  if (segs.some((s) => s.toLowerCase() === "secrets")) return true;
  if (nome.endsWith(".pem")) return true;
  if (nome.endsWith(".key")) return true;
  if (nome === ".env" || nome.startsWith(".env.")) return true;
  if (nome === "corp.db" || nome.startsWith("corp.db-")) return true;
  return /(^|[^a-z0-9])(secrets?|keys?)([^a-z0-9]|$)|\.env/i.test(nome);
}

function copyComDenylist(origem: string, destino: string, excluidos: string[] = []): void {
  cpSync(origem, destino, {
    recursive: true,
    filter: (src: string) => {
      if (src === origem) return true;
      const rel = relative(origem, src);
      if (ehSegredo(rel)) {
        excluidos.push(src);
        return false;
      }
      return true;
    },
  });
}

function scanExcluidos(dir: string, base: string, excluidos: string[]): void {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const completo = join(dir, entrada.name);
    const rel = relative(base, completo);
    if (ehSegredo(rel)) {
      excluidos.push(completo);
      continue;
    }
    if (entrada.isDirectory()) scanExcluidos(completo, base, excluidos);
  }
}

function listarArquivos(dirBase: string): string[] {
  const saida: string[] = [];
  const percorrer = (dir: string): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const completo = join(dir, entrada.name);
      const rel = relative(dirBase, completo);
      if (entrada.isDirectory()) percorrer(completo);
      else if (!ehSegredo(rel)) saida.push(rel);
    }
  };
  percorrer(dirBase);
  return saida.sort();
}

// ── Tasks: serialização via TaskStore (banco unificado opencorp.db) ──────
interface PacoteTasks {
  tasks: Record<string, unknown>[];
  mensagens: Record<string, unknown>[];
}

async function lerTasks(wsPath: string): Promise<PacoteTasks | null> {
  const store = new TaskStore();
  const tasks = await store.listar(wsPath);
  if (tasks.length === 0) return null;
  const mensagens: Record<string, unknown>[] = [];
  for (const t of tasks) mensagens.push(...((await store.listarMensagens(wsPath, t.id, 10_000)) as unknown as Record<string, unknown>[]));
  return { tasks: tasks as unknown as Record<string, unknown>[], mensagens };
}

/**
 * Importa tasks preservando os ids. Sem `sobrescrever`, tasks já existentes são
 * mantidas; mensagens só entram para tasks criadas/sobrescritas nesta importação.
 */
async function gravarTasks(wsPath: string, dados: PacoteTasks, sobrescrever: boolean): Promise<void> {
  const store = new TaskStore();
  const db = OpencorpDb.obter(wsPath);
  const importadas = new Set<string>();
  for (const t of dados.tasks) {
    const id = String(t.id ?? "");
    if (!id) continue;
    if (db.obterTask(id)) {
      if (!sobrescrever) continue;
      db.deletarTask(id);
    }
    const lista = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    const prioridade = String(t.prioridade ?? "media");
    db.criarTask({
      id,
      titulo: String(t.titulo ?? ""),
      descricao: String(t.descricao ?? ""),
      coluna: String(t.coluna ?? "backlog"),
      posicao: Number(t.pos ?? 0),
      prioridade: (["baixa", "media", "alta"].includes(prioridade) ? prioridade : "media") as "baixa" | "media" | "alta",
      responsavel: String(t.responsavel ?? ""),
      due: t.due == null ? null : String(t.due),
      criado_por: String(t.criado_por ?? "importacao"),
      labels: lista(t.labels),
    });
    importadas.add(id);
  }
  // Dependências e pai só depois que todas as tasks existem.
  for (const t of dados.tasks) {
    const id = String(t.id ?? "");
    if (!importadas.has(id)) continue;
    const deps = Array.isArray(t.bloqueado_por) ? t.bloqueado_por.map(String) : String(t.bloqueado_por ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const validas = deps.filter((d) => db.obterTask(d));
    if (validas.length > 0) await store.definirDependencias(wsPath, id, validas);
  }
  for (const m of dados.mensagens) {
    const taskId = String(m.task_id ?? "");
    const corpo = String(m.corpo ?? "").trim();
    if (!importadas.has(taskId) || !corpo) continue;
    const tipo = String(m.tipo ?? "comentario") as MensagemTask["tipo"];
    await store.mensagem(wsPath, taskId, { autor: String(m.autor ?? "importacao") || "importacao", corpo, tipo });
  }
}

// ── Migração pura pré-zod (funções migrarVX→VY encadeadas por kind) ───────
type MigracaoManifest = (payload: Record<string, unknown>) => Record<string, unknown>;

// Sem migrações até aqui (kindVersion 1). Para evoluir: adicione MIGRACOES[kind][v].
const MIGRACOES: Partial<Record<KindAsset, Record<number, MigracaoManifest>>> = {};

export function migrarManifestParaAtual(bruto: Record<string, unknown>): Record<string, unknown> {
  const versao = typeof bruto.kindVersion === "number" ? bruto.kindVersion : 1;
  if (versao > KIND_VERSION_ATUAL) {
    throw new AssetError(
      `manifest com kindVersion ${versao} maior que o suportado (${KIND_VERSION_ATUAL}) — atualize o opencorp`,
    );
  }
  if (versao === KIND_VERSION_ATUAL) return bruto;
  const kind = String(bruto.kind ?? "");
  const migracoes = (MIGRACOES as Record<string, Record<number, MigracaoManifest>>)[kind] ?? {};
  let atual = bruto;
  for (let v = versao; v < KIND_VERSION_ATUAL; v++) {
    const fn = migracoes[v];
    if (fn) atual = fn(atual);
  }
  atual.kindVersion = KIND_VERSION_ATUAL;
  return atual;
}

// ── Opções e resultados ────────────────────────────────────────────────────
export interface OpcoesExportar {
  somente?: string[];
  nome?: string;
  versao?: string;
  autor?: string;
}

export interface ResultadoExportar {
  destino: string;
  manifest: AssetManifest;
  excluidos: string[];
}

export interface OpcoesImportar {
  dryRun?: boolean;
  paraWorkspace: string;
  como?: string;
  sobrescrever?: boolean;
}

export interface ItemImportado {
  kind: KindAsset;
  id: string;
  acao: "criado" | "sobrescrito" | "seria-criado";
}

export interface ResultadoImportar {
  manifest: AssetManifest;
  dryRun: boolean;
  itens: ItemImportado[];
  arquivos: string[];
  dependencias: DependenciaAsset[];
}

export interface AssetStoreOptions {
  homeDir?: string;
}

export class AssetStore {
  private readonly homeDir: string;

  constructor(opts: AssetStoreOptions = {}) {
    this.homeDir = opts.homeDir ?? opencorpHome();
  }

  // ── caminhos ─────────────────────────────────────────────────────────────
  private dirAgentes(wsPath: string): string {
    return join(wsPath, ".opencorp", "agents");
  }

  private dirSkills(wsPath: string): string {
    return join(wsPath, ".opencorp", "skills");
  }

  private dirFlows(wsPath: string): string {
    return join(wsPath, ".opencorp", "flows");
  }

  // ── exportar ─────────────────────────────────────────────────────────────
  async exportar(wsPath: string, kind: KindAsset, destino: string, opts: OpcoesExportar = {}): Promise<ResultadoExportar> {
    const pkg = await mkdtemp(join(tmpdir(), "opencorp-asset-"));
    try {
      const excluidos: string[] = [];
      const manifest = await this.montarPack(wsPath, kind, opts, pkg, excluidos);
      await writeFileAtomic(join(pkg, "asset.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      let destinoFinal: string;
      if (destino.endsWith(".corp")) {
        const destinoAbs = resolve(destino);
        mkdirSync(dirname(destinoAbs), { recursive: true });
        const membros = readdirSync(pkg).filter((m) => !ehSegredo(m));
        const tar = await spawnAsync("tar", ["-czf", destinoAbs, "-C", pkg, ...membros]);
        if (tar.status !== 0) {
          throw new AssetError(`falha ao empacotar .corp: ${tar.stderr || "tar indisponível"}`);
        }
        destinoFinal = destinoAbs;
      } else {
        const destinoAbs = resolve(destino);
        if (existsSync(destinoAbs)) {
          throw new AssetError(`destino já existe: ${destinoAbs} — escolha outro caminho`);
        }
        mkdirSync(dirname(destinoAbs), { recursive: true });
        cpSync(pkg, destinoAbs, { recursive: true });
        destinoFinal = destinoAbs;
      }
      return { destino: destinoFinal, manifest, excluidos };
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }

  private async montarPack(
    wsPath: string,
    kind: KindAsset,
    opts: OpcoesExportar,
    pkg: string,
    excluidos: string[],
  ): Promise<AssetManifest> {
    const somente = (opts.somente ?? []).filter((s) => s.length > 0);
    const dependeDe: DependenciaAsset[] = [];
    const versao = opts.versao?.trim() && SEMVER_RE.test(opts.versao.trim()) ? opts.versao.trim() : "1.0.0";
    let nome = opts.nome?.trim();

    if (kind === "agente") {
      if (somente.length === 0) throw new AssetError('exportar agente exige --somente <id>');
      const ids = await this.copiarAgentes(wsPath, somente, pkg, dependeDe);
      nome = nome || ids[0]!;
    } else if (kind === "skill") {
      if (somente.length === 0) throw new AssetError('exportar skill exige --somente <nome>');
      this.copiarSkills(wsPath, somente, pkg, dependeDe, excluidos);
      nome = nome || somente[0]!;
    } else if (kind === "flow") {
      if (somente.length === 0) throw new AssetError('exportar flow exige --somente <id>');
      const ids = await this.copiarFlows(wsPath, somente, pkg, dependeDe);
      nome = nome || ids[0]!;
    } else if (kind === "task") {
      const dados = await lerTasks(wsPath);
      if (!dados || dados.tasks.length === 0) throw new AssetError('nenhuma task para exportar neste workspace');
      await writeFileAtomic(join(pkg, "tasks.json"), `${JSON.stringify(dados, null, 2)}\n`);
      nome = nome || "tasks";
    } else if (kind === "prompt") {
      const origem = join(wsPath, ".opencorp", "prompts.json");
      if (!existsSync(origem)) throw new AssetError(`nenhum prompts.json em ${join(wsPath, ".opencorp")}`);
      mkdirSync(pkg, { recursive: true });
      cpSync(origem, join(pkg, "prompts.json"));
      nome = nome || "prompts";
    } else if (kind === "pack") {
      if (somente.length === 0) throw new AssetError('exportar pack exige --somente <kind:id,...> (ex.: agente:auditor,skill:seo)');
      for (const item of somente) {
        const [k, id] = this.dividirPar(item);
        await this.incluirUnico(wsPath, k, id, pkg, dependeDe, excluidos);
      }
      nome = nome || "pack";
    } else {
      // workspace-parcial: --somente filtra TIPOS (default: todos).
      const tipos = new Set<KindAsset>();
      for (const bruto of somente.length > 0 ? somente : [...KINDS_FILTRAVEIS]) {
        const t = normalizarTipoFiltravel(bruto);
        if (!t) {
          throw new AssetError(`tipo desconhecido para workspace-parcial: "${bruto}" (use agente|skill|prompt|task|flow)`);
        }
        tipos.add(t);
      }
      for (const t of tipos) {
        await this.incluirTodos(wsPath, t, pkg, dependeDe, excluidos);
      }
      nome = nome || basename(wsPath);
    }

    return {
      kind,
      kindVersion: KIND_VERSION_ATUAL,
      nome: nome || "asset",
      versao,
      dependeDe,
      ...(opts.autor ? { autor: opts.autor } : {}),
    };
  }

  private dividirPar(item: string): [KindAsset, string] {
    const idx = item.indexOf(":");
    if (idx <= 0 || idx === item.length - 1) {
      throw new AssetError(`item inválido para pack: "${item}" — use kind:id (ex.: agente:auditor)`);
    }
    const k = item.slice(0, idx);
    const id = item.slice(idx + 1);
    if (!KINDS_ASSET.includes(k as KindAsset) || !KINDS_FILTRAVEIS.includes(k as KindAsset)) {
      throw new AssetError(`kind inválido para pack: "${k}" (use agente|skill|prompt|task|flow)`);
    }
    return [k as KindAsset, id];
  }

  private async incluirUnico(
    wsPath: string,
    kind: KindAsset,
    id: string,
    pkg: string,
    dependeDe: DependenciaAsset[],
    excluidos: string[],
  ): Promise<void> {
    if (kind === "agente") await this.copiarAgentes(wsPath, [id], pkg, dependeDe);
    else if (kind === "skill") this.copiarSkills(wsPath, [id], pkg, dependeDe, excluidos);
    else if (kind === "flow") await this.copiarFlows(wsPath, [id], pkg, dependeDe);
    else if (kind === "task") {
      const dados = await lerTasks(wsPath);
      if (dados && dados.tasks.length > 0) await writeFileAtomic(join(pkg, "tasks.json"), `${JSON.stringify(dados, null, 2)}\n`);
      dependeDe.push({ kind: "task", nome: id });
    } else if (kind === "prompt") {
      const origem = join(wsPath, ".opencorp", "prompts.json");
      if (existsSync(origem)) cpSync(origem, join(pkg, "prompts.json"));
      dependeDe.push({ kind: "prompt", nome: id });
    }
  }

  private async incluirTodos(
    wsPath: string,
    kind: KindAsset,
    pkg: string,
    dependeDe: DependenciaAsset[],
    excluidos: string[],
  ): Promise<void> {
    if (kind === "agente") {
      const ids = this.listarAgentes(wsPath);
      if (ids.length > 0) await this.copiarAgentes(wsPath, ids, pkg, dependeDe);
    } else if (kind === "skill") {
      const nomes = this.listarSkills(wsPath);
      if (nomes.length > 0) this.copiarSkills(wsPath, nomes, pkg, dependeDe, excluidos);
    } else if (kind === "flow") {
      const ids = this.listarFlows(wsPath);
      if (ids.length > 0) await this.copiarFlows(wsPath, ids, pkg, dependeDe);
    } else if (kind === "task") {
      const dados = await lerTasks(wsPath);
      if (dados && dados.tasks.length > 0) await writeFileAtomic(join(pkg, "tasks.json"), `${JSON.stringify(dados, null, 2)}\n`);
    } else if (kind === "prompt") {
      const origem = join(wsPath, ".opencorp", "prompts.json");
      if (existsSync(origem)) cpSync(origem, join(pkg, "prompts.json"));
    }
  }

  private listarAgentes(wsPath: string): string[] {
    const dir = this.dirAgentes(wsPath);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
  }

  private listarSkills(wsPath: string): string[] {
    const dir = this.dirSkills(wsPath);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => !f.startsWith(".") && existsSync(join(dir, f, "SKILL.md")))
      .sort();
  }

  private listarFlows(wsPath: string): string[] {
    const dir = this.dirFlows(wsPath);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
  }

  private async copiarAgentes(
    wsPath: string,
    ids: string[],
    pkg: string,
    dependeDe: DependenciaAsset[],
  ): Promise<string[]> {
    const origemDir = this.dirAgentes(wsPath);
    for (const id of ids) {
      const origem = join(origemDir, `${id}.md`);
      if (!existsSync(origem)) {
        throw new AssetError(`agente "${id}" não encontrado em ${origemDir} — veja "oc agent list"`);
      }
      mkdirSync(join(pkg, "agents"), { recursive: true });
      cpSync(origem, join(pkg, "agents", `${id}.md`));
      dependeDe.push({ kind: "agente", nome: id });
    }
    return ids;
  }

  private copiarSkills(
    wsPath: string,
    nomes: string[],
    pkg: string,
    dependeDe: DependenciaAsset[],
    excluidos: string[],
  ): void {
    const origemDir = this.dirSkills(wsPath);
    for (const nome of nomes) {
      const origem = join(origemDir, nome);
      if (!existsSync(join(origem, "SKILL.md"))) {
        throw new AssetError(`skill "${nome}" não encontrada em ${origemDir} — veja "oc skill listar"`);
      }
      scanExcluidos(origem, origemDir, excluidos);
      mkdirSync(join(pkg, "skills"), { recursive: true });
      copyComDenylist(origem, join(pkg, "skills", nome), excluidos);
      dependeDe.push({ kind: "skill", nome });
    }
  }

  private async copiarFlows(
    wsPath: string,
    ids: string[],
    pkg: string,
    dependeDe: DependenciaAsset[],
  ): Promise<string[]> {
    const flowStore = new FlowStore({ homeDir: this.homeDir });
    for (const id of ids) {
      const json = await flowStore.exportarJson(wsPath, id);
      mkdirSync(join(pkg, "flows"), { recursive: true });
      await writeFileAtomic(join(pkg, "flows", `${id}.json`), json);
      dependeDe.push({ kind: "flow", nome: id });
    }
    return ids;
  }

  // ── importar ─────────────────────────────────────────────────────────────
  async importar(fonte: string, opts: OpcoesImportar): Promise<ResultadoImportar> {
    let extraido: string | null = null;
    let dirFonte: string;
    try {
      if (/^(git\+|https?:\/\/|git@|ssh:\/\/)/.test(fonte) || fonte.endsWith(".git")) {
        extraido = await mkdtemp(join(tmpdir(), "opencorp-asset-clone-"));
        const git = await spawnAsync("git", ["clone", "--depth", "1", fonte, extraido]);
        if (git.status !== 0) {
          throw new AssetError(`não foi possível clonar "${fonte}": ${git.stderr.trim() || "git indisponível"}`);
        }
        dirFonte = extraido;
      } else if (fonte.endsWith(".corp") || (existsSync(fonte) && statSync(fonte).isFile())) {
        if (!existsSync(fonte)) throw new AssetError(`arquivo não encontrado: ${fonte}`);
        extraido = await mkdtemp(join(tmpdir(), "opencorp-asset-corp-"));
        const tar = await spawnAsync("tar", ["-xzf", fonte, "-C", extraido]);
        if (tar.status !== 0) {
          throw new AssetError(`falha ao extrair "${fonte}": ${tar.stderr || "tar indisponível"}`);
        }
        dirFonte = extraido;
      } else {
        if (!existsSync(fonte) || !statSync(fonte).isDirectory()) {
          throw new AssetError(`fonte não encontrada: ${fonte}`);
        }
        dirFonte = resolve(fonte);
      }

      const manifest = this.carregarManifest(dirFonte);
      const arquivos = listarArquivos(dirFonte).filter((f) => f !== "asset.json");
      const assets = this.enumerarAssets(dirFonte);

      if (opts.dryRun) {
        const itens: ItemImportado[] = assets.map((a) => ({
          kind: a.kind,
          id: a.id,
          acao: "seria-criado",
        }));
        return { manifest, dryRun: true, itens, arquivos, dependencias: manifest.dependeDe };
      }

      // --como renomeia um único asset renomeável (agente|skill|flow)
      const renomeaveis = assets.filter((a) => a.kind === "agente" || a.kind === "skill" || a.kind === "flow");
      const comoId = opts.como?.trim();
      if (comoId && renomeaveis.length > 1) {
        throw new AssetError('--como só pode ser usado quando o pack tem um único asset renomeável (agente|skill|flow)');
      }

      const itens: ItemImportado[] = [];
      for (const a of assets) {
        const novoId = comoId && renomeaveis.length === 1 && a.kind === renomeaveis[0]!.kind ? comoId : a.id;
        itens.push(await this.gravarAsset(dirFonte, opts.paraWorkspace, a, novoId, opts.sobrescrever ?? false));
      }
      return { manifest, dryRun: false, itens, arquivos, dependencias: manifest.dependeDe };
    } finally {
      if (extraido) rmSync(extraido, { recursive: true, force: true });
    }
  }

  private carregarManifest(dirFonte: string): AssetManifest {
    const caminho = join(dirFonte, "asset.json");
    if (!existsSync(caminho)) {
      throw new AssetError(`"${dirFonte}" não é um asset opencorp — falta asset.json`);
    }
    let bruto: unknown;
    try {
      bruto = JSON.parse(readFileSync(caminho, "utf8"));
    } catch (erro) {
      throw new AssetError(`asset.json inválido em ${caminho}: ${msg(erro)}`);
    }
    if (!bruto || typeof bruto !== "object") {
      throw new AssetError(`asset.json inválido: esperado um objeto`);
    }
    const migrado = migrarManifestParaAtual(bruto as Record<string, unknown>);
    const parsed = manifestSchema.safeParse(migrado);
    if (!parsed.success) {
      const iss = parsed.error.issues[0]!;
      const campo = iss.path.join(".") || "(raiz)";
      throw new AssetError(`manifest inválido → campo "${campo}": ${iss.message}`);
    }
    return parsed.data as AssetManifest;
  }

  private enumerarAssets(dirFonte: string): Array<{ kind: KindAsset; id: string }> {
    const saida: Array<{ kind: KindAsset; id: string }> = [];
    const agentsDir = join(dirFonte, "agents");
    if (existsSync(agentsDir)) {
      for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".md"))) {
        saida.push({ kind: "agente", id: f.replace(/\.md$/, "") });
      }
    }
    const skillsDir = join(dirFonte, "skills");
    if (existsSync(skillsDir)) {
      for (const nome of readdirSync(skillsDir).filter((f) => !f.startsWith("."))) {
        if (existsSync(join(skillsDir, nome, "SKILL.md"))) saida.push({ kind: "skill", id: nome });
      }
    }
    const flowsDir = join(dirFonte, "flows");
    if (existsSync(flowsDir)) {
      for (const f of readdirSync(flowsDir).filter((f) => f.endsWith(".json"))) {
        saida.push({ kind: "flow", id: f.replace(/\.json$/, "") });
      }
    }
    if (existsSync(join(dirFonte, "tasks.json"))) saida.push({ kind: "task", id: "tasks" });
    if (existsSync(join(dirFonte, "prompts.json"))) saida.push({ kind: "prompt", id: "prompts" });
    return saida;
  }

  private async gravarAsset(
    dirFonte: string,
    wsPath: string,
    asset: { kind: KindAsset; id: string },
    novoId: string,
    sobrescrever: boolean,
  ): Promise<ItemImportado> {
    if (asset.kind === "agente") {
      const origem = join(dirFonte, "agents", `${asset.id}.md`);
      const destino = join(wsPath, ".opencorp", "agents", `${novoId}.md`);
      const jaExistia = existsSync(destino);
      if (jaExistia && !sobrescrever) {
        throw new AssetError(`agente "${novoId}" já existe — use --como <novo-id> ou --sobrescrever`);
      }
      mkdirSync(dirname(destino), { recursive: true });
      cpSync(origem, destino);
      return { kind: "agente", id: novoId, acao: jaExistia ? "sobrescrito" : "criado" };
    }
    if (asset.kind === "skill") {
      const origem = join(dirFonte, "skills", asset.id);
      const destino = join(wsPath, ".opencorp", "skills", novoId);
      const jaExistia = existsSync(destino);
      if (jaExistia && !sobrescrever) {
        throw new AssetError(`skill "${novoId}" já existe — use --como <novo-nome> ou --sobrescrever`);
      }
      mkdirSync(dirname(destino), { recursive: true });
      if (jaExistia) rmSync(destino, { recursive: true, force: true });
      cpSync(origem, destino, { recursive: true });
      return { kind: "skill", id: novoId, acao: jaExistia ? "sobrescrito" : "criado" };
    }
    if (asset.kind === "flow") {
      const flowStore = new FlowStore({ homeDir: this.homeDir });
      const json = readFileSync(join(dirFonte, "flows", `${asset.id}.json`), "utf8");
      const jaExistia = existsSync(flowStore.caminho(wsPath, novoId));
      const flow = await flowStore.importar(wsPath, json, { sobrescrever, novoId: novoId !== asset.id ? novoId : undefined });
      return { kind: "flow", id: flow.id, acao: jaExistia ? "sobrescrito" : "criado" };
    }
    if (asset.kind === "task") {
      const dados = JSON.parse(readFileSync(join(dirFonte, "tasks.json"), "utf8")) as PacoteTasks;
      await gravarTasks(wsPath, dados, sobrescrever);
      return { kind: "task", id: "tasks", acao: "criado" };
    }
    // prompt
    const origem = join(dirFonte, "prompts.json");
    const destino = join(wsPath, ".opencorp", "prompts.json");
    const jaExistia = existsSync(destino);
    if (jaExistia && !sobrescrever) {
      throw new AssetError(`prompts.json já existe — use --sobrescrever`);
    }
    mkdirSync(dirname(destino), { recursive: true });
    cpSync(origem, destino);
    return { kind: "prompt", id: "prompts", acao: jaExistia ? "sobrescrito" : "criado" };
  }
}
