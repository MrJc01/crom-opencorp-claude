import { cp as cpAsync, mkdir as mkdirAsync, rename as renameAsync, rm as rmAsync } from "node:fs/promises";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { AgentStore, type AgenteResumo } from "../agents/agent-store.js";
import { WorkspaceError } from "../../shared/errors.js";
import { PromptStore } from "../agents/prompt-store.js";
import { RegistryStore } from "../storage/registry-store.js";
import { SettingsStore } from "./settings-store.js";
import { writeFileAtomic } from "../../../utils/fs-safe.js";
import { expandTilde, opencorpHome, projectRoot } from "../../../utils/paths.js";

export { WorkspaceError };

export interface RegistroWorkspace {
  id: string;
  criado_em: string;
  /** Caminho absoluto customizado — se omitido, usa <raiz>/<id> */
  path?: string;
}

export interface EstadoWorkspaces {
  version: number;
  ativo: string | null;
  workspaces: RegistroWorkspace[];
}

export interface InfoWorkspace extends RegistroWorkspace {
  path: string;
  ativo: boolean;
  existe: boolean;
}

export interface OrigemValor {
  valor: unknown;
  origem: string;
}

export interface DetalhesWorkspace extends InfoWorkspace {
  agentes: AgenteResumo[];
  orcamento: { daily_usd: OrigemValor; per_agent_usd: OrigemValor };
  seguranca: string | null;
}

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const estadoSchema = z.union([
  z.object({
    version: z.number().int().default(1),
    ativo: z.string().nullable().default(null),
    workspaces: z
      .array(z.object({ id: z.string().min(1), criado_em: z.string().min(1), path: z.string().optional() }))
      .default([]),
  }),
  z.array(
    z.object({
      id: z.string().min(1),
      criado_em: z.string().optional(),
      path: z.string().optional(),
      padrao: z.boolean().optional(),
      nome: z.string().optional(),
    })
  ).transform((arr) => {
    const padrao = arr.find((a) => a.padrao)?.id ?? arr[0]?.id ?? null;
    return {
      version: 1,
      ativo: padrao,
      workspaces: arr.map((a) => ({
        id: a.id,
        criado_em: a.criado_em ?? new Date().toISOString(),
        path: a.path,
      })),
    };
  }),
]);


function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export interface ManagerOptions {
  homeDir?: string;
  cwd?: string;
  templatesDir?: string;
  workspacesRoot?: string;
}

export class WorkspaceManager {
  private readonly homeDir: string;
  private readonly cwd: string;
  private readonly templatesDir: string;
  private readonly workspacesRootOverride?: string;
  private readonly store: SettingsStore;
  private readonly agentes: AgentStore;
  private readonly registros = new RegistryStore();

  constructor(opts: ManagerOptions = {}) {
    this.homeDir = opts.homeDir ?? opencorpHome();
    this.cwd = opts.cwd ?? process.cwd();
    this.templatesDir =
      opts.templatesDir ??
      join(projectRoot(), "templates");
    this.workspacesRootOverride = opts.workspacesRoot;
    this.store = new SettingsStore({ homeDir: this.homeDir, cwd: this.cwd });
    this.agentes = new AgentStore({ templatesDir: this.templatesDir });
  }

  estadoPath(): string {
    return join(this.homeDir, ".opencorp", "workspaces.json");
  }

  private async raiz(): Promise<string> {
    if (this.workspacesRootOverride) return this.workspacesRootOverride;
    const r = await this.store.get("paths.workspaces_root");
    return expandTilde(String(r.valor), this.homeDir);
  }

  private async lerEstado(): Promise<EstadoWorkspaces> {
    const p = this.estadoPath();
    if (!existsSync(p)) return { version: 1, ativo: null, workspaces: [] };
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(p, "utf8"));
    } catch (erro) {
      throw new WorkspaceError(`JSON inválido em ${p}: ${msg(erro)}`, { exitCode: 2 });
    }
    const parsed = estadoSchema.safeParse(json);
    if (!parsed.success) {
      const iss = parsed.error.issues[0]!;
      const chave = iss.path.join(".");
      throw new WorkspaceError(
        `estado de workspaces inválido em ${p} → ${chave || "(raiz)"}: ${iss.message}`,
        { exitCode: 2 },
      );
    }
    return parsed.data as EstadoWorkspaces;
  }

  private async gravarEstado(estado: EstadoWorkspaces): Promise<void> {
    await writeFileAtomic(this.estadoPath(), `${JSON.stringify(estado, null, 2)}\n`);
  }

  private infoDe(estado: EstadoWorkspaces, registro: RegistroWorkspace, path: string): InfoWorkspace {
    return {
      ...registro,
      path,
      ativo: estado.ativo === registro.id,
      existe: existsSync(path),
    };
  }

  /** Resolve o caminho efetivo de um registro — usa path customizado se definido */
  private pathDe(raiz: string, w: RegistroWorkspace): string {
    return w.path ? resolve(expandTilde(w.path, this.homeDir)) : join(raiz, w.id);
  }

  async listar(): Promise<InfoWorkspace[]> {
    const estado = await this.lerEstado();
    const raiz = await this.raiz();
    return estado.workspaces
      .map((w) => this.infoDe(estado, w, this.pathDe(raiz, w)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async resolver(id?: string): Promise<InfoWorkspace> {
    const estado = await this.lerEstado();
    const raiz = await this.raiz();
    let registro: RegistroWorkspace | undefined;
    let idAlvo = (id !== undefined && id.length > 0)
      ? id
      : (process.env.OPENCORP_WORKSPACE && process.env.OPENCORP_WORKSPACE.trim() ? process.env.OPENCORP_WORKSPACE.trim() : undefined);

    // Detecção contextual automática a partir do diretório atual (cwd)
    if (!idAlvo) {
      const wsPeloCwd = estado.workspaces.find((w) => {
        const p = this.pathDe(raiz, w);
        return this.cwd === p || this.cwd.startsWith(p + "/") || this.cwd.startsWith(p + "\\");
      });
      if (wsPeloCwd) {
        idAlvo = wsPeloCwd.id;
      }
    }

    if (idAlvo !== undefined && idAlvo.length > 0) {
      registro =
        estado.workspaces.find((w) => w.id === idAlvo) ||
        estado.workspaces.find((w) => w.id.toLowerCase() === idAlvo.toLowerCase()) ||
        estado.workspaces.find((w) => w.id.toLowerCase().startsWith(idAlvo.toLowerCase())) ||
        estado.workspaces.find((w) => w.id.toLowerCase().includes(idAlvo.toLowerCase()));
      if (!registro) {
        throw new WorkspaceError(
          `workspace "${idAlvo}" não encontrado — veja "oc -t <id> status" ou "opencorp workspace list"`,
        );
      }
    } else if (estado.ativo) {
      registro = estado.workspaces.find((w) => w.id === estado.ativo);
      if (!registro) {
        throw new WorkspaceError(
          `workspace ativo "${estado.ativo}" não está mais registrado — use "opencorp use <id>"`,
        );
      }
    } else {
      throw new WorkspaceError(
        'nenhum workspace ativo ou detectado no diretório atual — navegue até a pasta do workspace ou use "oc -t <id> <comando>"',
      );
    }
    return this.infoDe(estado, registro, this.pathDe(raiz, registro));
  }

  async atual(): Promise<InfoWorkspace | null> {
    const estado = await this.lerEstado();
    const raiz = await this.raiz();
    let idAtivo = (process.env.OPENCORP_WORKSPACE && process.env.OPENCORP_WORKSPACE.trim())
      ? process.env.OPENCORP_WORKSPACE.trim()
      : undefined;

    if (!idAtivo) {
      const wsPeloCwd = estado.workspaces.find((w) => {
        const p = this.pathDe(raiz, w);
        return this.cwd === p || this.cwd.startsWith(p + "/") || this.cwd.startsWith(p + "\\");
      });
      if (wsPeloCwd) {
        idAtivo = wsPeloCwd.id;
      }
    }

    if (!idAtivo) idAtivo = estado.ativo ?? undefined;
    if (!idAtivo) return null;
    const registro = estado.workspaces.find((w) => w.id === idAtivo);
    if (!registro) return null;
    return this.infoDe(estado, registro, this.pathDe(raiz, registro));
  }

  async criar(id: string, opts: { template?: string; path?: string } = {}): Promise<InfoWorkspace> {
    if (!ID_RE.test(id) || id.length > 64) {
      throw new WorkspaceError(
        `id de workspace inválido: "${id}" — use kebab-case (letras minúsculas, números e hífens; ex.: corp-principal, no máximo 64 caracteres)`,
      );
    }
    const template = opts.template ?? "default";
    const templateDir = this.resolverTemplateDir(template);
    const temOpencorp = existsSync(join(templateDir, ".opencorp"));
    const ehPacote = !temOpencorp && (existsSync(join(templateDir, "template.json")) || existsSync(join(templateDir, "agents")));
    const skeletonDir = ehPacote ? join(this.templatesDir, "default") : templateDir;
    const estado = await this.lerEstado();
    if (estado.workspaces.some((w) => w.id === id)) {
      throw new WorkspaceError(
        `workspace "${id}" já existe — veja "opencorp workspace list" (ids precisam ser únicos)`,
      );
    }

    // Se opts.path foi fornecido, usa pasta customizada (qualquer dir do computador)
    const customPath = opts.path ? resolve(expandTilde(opts.path, this.homeDir)) : undefined;
    const raiz = await this.raiz();
    const destino = customPath ?? join(raiz, id);

    // As cópias são assíncronas de propósito: o esqueleto tem muitos arquivos e uma cópia síncrona bloqueava o servidor
    // inteiro (inclusive /health e SSE) enquanto o disco estivesse ocupado; o watchdog do event loop chegou a matar o
    // servidor por isso.
    if (customPath) {
      // Pasta customizada: cria se não existe, mas não sobrescreve conteúdo existente
      await mkdirAsync(destino, { recursive: true });
      // Se a pasta não tem .opencorp, aplica skeleton somente na estrutura .opencorp
      const opencorpDir = join(destino, ".opencorp");
      if (!existsSync(opencorpDir)) {
        // Copia o skeleton para um tmp e depois move apenas a estrutura .opencorp
        const tmp = join(raiz, `.${id}.tmp-${process.pid}-${randomUUID()}`);
        try {
          await mkdirAsync(raiz, { recursive: true });
          await cpAsync(skeletonDir, tmp, { recursive: true });
          // Move apenas o .opencorp e docs do skeleton para o destino
          const tmpOpencorp = join(tmp, ".opencorp");
          if (existsSync(tmpOpencorp)) {
            await cpAsync(tmpOpencorp, opencorpDir, { recursive: true });
          }
          const tmpDocs = join(tmp, "docs");
          const destDocs = join(destino, "docs");
          if (existsSync(tmpDocs) && !existsSync(destDocs)) {
            await cpAsync(tmpDocs, destDocs, { recursive: true });
          }
        } finally {
          await rmAsync(tmp, { recursive: true, force: true });
        }
      }
    } else {
      // Caminho padrão: comportamento original
      if (existsSync(destino)) {
        throw new WorkspaceError(
          `já existe uma pasta em ${destino} — escolha outro id ou remova a pasta antes`,
        );
      }
      const tmp = join(raiz, `.${id}.tmp-${process.pid}-${randomUUID()}`);
      try {
        await mkdirAsync(raiz, { recursive: true });
        await cpAsync(skeletonDir, tmp, { recursive: true });
        await renameAsync(tmp, destino);
      } catch (erro) {
        await rmAsync(tmp, { recursive: true, force: true });
        throw new WorkspaceError(`não foi possível criar o workspace "${id}": ${msg(erro)}`);
      }
    }

    const criado_em = new Date().toISOString();
    const ativo = estado.ativo ?? id;
    const registro: RegistroWorkspace = { id, criado_em, ...(customPath ? { path: customPath } : {}) };
    try {
      if (ehPacote) {
        await this.aplicarPacote(destino, templateDir);
      }

      // Garante resolução de dependências compartilhadas (ex: better-sqlite3) criando symlink para node_modules da raiz
      const repoNodeModules = join(projectRoot(), "node_modules");
      const destNodeModules = join(destino, "node_modules");
      if (existsSync(repoNodeModules) && !existsSync(destNodeModules)) {
        try {
          symlinkSync(repoNodeModules, destNodeModules, "junction");
        } catch {
          // Permissão ou filesystem não suporta symlink
        }
      }

      await this.registros.garantirCategorias(destino);
      await this.registros.reindexar(destino);

      // F3-T02 (D1): seed de prompts globais na CRIAÇÃO do workspace. Copia
      // ~/.opencorp/prompts.json para .opencorp/prompts.json se existir e o
      // workspace ainda não tiver prompts (não sobrescreve template/pacote).
      await new PromptStore({ homeDir: this.homeDir }).semear(destino);

      // Regra de Ouro 1: Sementeira de modelos, execution_driver e provedores a partir do global
      await this.semearConfiguracoesGlobais(destino);

      // Se houver tarefas_iniciais.json no destino, popula automaticamente no tasks.db
      const tarefasJsonPath = join(destino, "tarefas_iniciais.json");
      if (existsSync(tarefasJsonPath)) {
        try {
          const raw = readFileSync(tarefasJsonPath, "utf8");
          const tarefas = JSON.parse(raw);
          if (Array.isArray(tarefas) && tarefas.length > 0) {
            const dbDir = join(destino, ".opencorp");
            mkdirSync(dbDir, { recursive: true });
            const db = new Database(join(dbDir, "tasks.db"));
            db.pragma("journal_mode = WAL");
            db.exec(`
              CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                titulo TEXT NOT NULL,
                descricao TEXT NOT NULL DEFAULT '',
                coluna TEXT NOT NULL DEFAULT 'backlog',
                pos REAL NOT NULL DEFAULT 0,
                prioridade TEXT NOT NULL DEFAULT 'media',
                labels TEXT NOT NULL DEFAULT '',
                responsavel TEXT NOT NULL DEFAULT '',
                due TEXT,
                task_pai TEXT,
                bloqueado_por TEXT NOT NULL DEFAULT '',
                lock_por TEXT,
                lock_expira TEXT,
                criado_por TEXT NOT NULL DEFAULT 'sistema:template',
                criado_em TEXT NOT NULL,
                atualizado_em TEXT NOT NULL
              );
            `);
            const insert = db.prepare(`
              INSERT OR IGNORE INTO tasks (
                id, titulo, descricao, coluna, pos, prioridade, labels, responsavel,
                due, task_pai, bloqueado_por, lock_por, lock_expira, criado_por, criado_em, atualizado_em
              ) VALUES (
                @id, @titulo, @descricao, @coluna, @pos, @prioridade, @labels, @responsavel,
                @due, @task_pai, @bloqueado_por, @lock_por, @lock_expira, @criado_por, @criado_em, @atualizado_em
              )
            `);
            const agora = new Date().toISOString();
            for (const t of tarefas) {
              insert.run({
                id: t.id || `tsk-setup-${randomUUID()}`,
                titulo: t.titulo || "Tarefa Inicial de Setup",
                descricao: t.descricao || "",
                coluna: t.coluna || "backlog",
                pos: t.pos ?? 10,
                prioridade: t.prioridade || "alta",
                labels: Array.isArray(t.labels) ? t.labels.join(",") : (t.labels || "setup-inicial"),
                responsavel: t.responsavel || "agente:executor-padrao",
                due: t.due || null,
                task_pai: t.task_pai || null,
                bloqueado_por: Array.isArray(t.bloqueado_por) ? t.bloqueado_por.join(",") : "",
                lock_por: null,
                lock_expira: null,
                criado_por: "sistema:template",
                criado_em: agora,
                atualizado_em: agora,
              });
            }
            db.close();
          }
        } catch {
          // Não bloqueia a criação do workspace caso o json esteja corrompido
        }
      }

      await this.gravarEstado({
        version: 1,
        ativo,
        workspaces: [...estado.workspaces, registro],
      });
    } catch (erro) {
      if (!customPath) rmSync(destino, { recursive: true, force: true });
      throw erro;
    }
    return { id, criado_em, path: destino, ativo: ativo === id, existe: true };
  }

  private resolverTemplateDir(template: string): string {
    if (template.includes("/") || template.includes("\\")) {
      const abs = resolve(template);
      if (existsSync(abs) && statSync(abs).isDirectory()) return abs;
      throw new WorkspaceError(`template não encontrado no caminho "${template}" (${abs})`);
    }
    const usuario = join(this.homeDir, ".opencorp", "templates", template);
    const projeto = join(this.templatesDir, template);
    if (existsSync(projeto)) return projeto;
    if (existsSync(usuario)) return usuario;
    const disponiveis = new Set<string>();
    for (const dir of [this.templatesDir, join(this.homeDir, ".opencorp", "templates")]) {
      if (existsSync(dir)) {
        for (const d of readdirSync(dir, { withFileTypes: true })) {
          if (d.isDirectory()) disponiveis.add(d.name);
        }
      }
    }
    throw new WorkspaceError(
      `template "${template}" não encontrado (disponíveis: ${[...disponiveis].sort().join(", ") || "nenhum"})`,
    );
  }

  private async aplicarPacote(destino: string, pkgDir: string): Promise<void> {
    const origemAgents = join(pkgDir, "agents");
    const origemRegistries = join(pkgDir, "registries");
    const origemScripts = join(pkgDir, "scripts");
    const origemApps = join(pkgDir, "apps");
    const origemTarefas = join(pkgDir, "tarefas_iniciais.json");
    if (existsSync(origemAgents)) {
      cpSync(origemAgents, join(destino, ".opencorp", "agents"), { recursive: true });
    }
    if (existsSync(origemRegistries)) {
      cpSync(origemRegistries, join(destino, ".opencorp", "registries"), { recursive: true });
    }
    if (existsSync(origemScripts)) {
      cpSync(origemScripts, join(destino, "scripts"), { recursive: true });
    }
    if (existsSync(origemApps)) {
      cpSync(origemApps, join(destino, "apps"), { recursive: true });
    }
    if (existsSync(origemTarefas)) {
      copyFileSync(origemTarefas, join(destino, "tarefas_iniciais.json"));
    }
    for (const arquivo of ["config.json", "security_policy.json", "budget.json"]) {
      const origem = join(pkgDir, arquivo);
      if (existsSync(origem)) {
        copyFileSync(origem, join(destino, ".opencorp", arquivo));
      }
    }
    await this.agentes.sincronizarTodos(destino);
  }

  async usar(id: string): Promise<InfoWorkspace> {
    const estado = await this.lerEstado();
    const registro = estado.workspaces.find((w) => w.id === id);
    if (!registro) {
      throw new WorkspaceError(
        `workspace "${id}" não encontrado — veja "opencorp workspace list" ou crie com "opencorp workspace create ${id}"`,
      );
    }
    const raiz = await this.raiz();
    const path = this.pathDe(raiz, registro);
    if (!existsSync(path)) {
      throw new WorkspaceError(
        `a pasta do workspace "${id}" não foi encontrada em ${path} — ele pode ter sido movido ou apagado fora do opencorp; recrie ou remova o registro`,
      );
    }
    await this.gravarEstado({ ...estado, ativo: id });
    return this.infoDe({ ...estado, ativo: id }, registro, path);
  }

  async listarAgentes(id?: string): Promise<AgenteResumo[]> {
    const info = await this.resolver(id);
    return this.agentes.listar(info.path);
  }

  async detalhar(id?: string): Promise<DetalhesWorkspace> {
    const info = await this.resolver(id);
    const agentes = await this.listarAgentes(info.id);
    const daily = await this.store.get("budget.daily_usd", { workspaceDir: info.path });
    const perAgent = await this.store.get("budget.per_agent_usd", { workspaceDir: info.path });
    const policyPath = join(info.path, ".opencorp", "security_policy.json");
    let seguranca: string | null = null;
    if (existsSync(policyPath)) {
      try {
        const policy = JSON.parse(readFileSync(policyPath, "utf8")) as { level?: unknown };
        if (typeof policy.level === "string") seguranca = policy.level;
      } catch {
        seguranca = null;
      }
    }
    return {
      ...info,
      agentes,
      orcamento: {
        daily_usd: { valor: daily.valor, origem: daily.origem },
        per_agent_usd: { valor: perAgent.valor, origem: perAgent.origem },
      },
      seguranca,
    };
  }

  async deletar(id: string, opts: { sim?: boolean } = {}): Promise<{ path: string; removidoPasta: boolean; eraAtivo: boolean }> {
    if (!opts.sim) {
      throw new WorkspaceError(
        `exclusão de "${id}" precisa de confirmação — responda ao prompt ou passe -y/--force`,
      );
    }
    const estado = await this.lerEstado();
    const registro = estado.workspaces.find((w) => w.id === id);
    if (!registro) {
      throw new WorkspaceError(
        `workspace "${id}" não encontrado — veja "opencorp workspace list"`,
      );
    }
    const eraAtivo = estado.ativo === id;
    const raiz = await this.raiz();
    const path = this.pathDe(raiz, registro);
    let removidoPasta = false;
    if (existsSync(path)) {
      try {
        rmSync(path, { recursive: true, force: true });
        removidoPasta = true;
      } catch (erro) {
        throw new WorkspaceError(`não foi possível remover a pasta ${path}: ${msg(erro)}`);
      }
    }
    await this.gravarEstado({
      version: 1,
      ativo: eraAtivo ? null : estado.ativo,
      workspaces: estado.workspaces.filter((w) => w.id !== id),
    });
    return { path, removidoPasta, eraAtivo };
  }

  /**
   * Sementeia configurações iniciais do workspace a partir do global (~/.opencorp/settings.json).
   * Regra de Ouro 1: O global atua ÚNICA E EXCLUSIVAMENTE como semente na criação do workspace.
   */
  async semearConfiguracoesGlobais(destino: string): Promise<void> {
    const configPath = join(destino, ".opencorp", "config.json");
    let configWorkspace: Record<string, any> = {};
    if (existsSync(configPath)) {
      try {
        configWorkspace = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, any>;
      } catch {
        configWorkspace = {};
      }
    }

    let globalSettings: Record<string, any> = {};
    const globalSettingsPath = join(this.homeDir, ".opencorp", "settings.json");
    if (existsSync(globalSettingsPath)) {
      try {
        globalSettings = JSON.parse(readFileSync(globalSettingsPath, "utf8")) as Record<string, any>;
      } catch {}
    }

    let alterado = false;

    // Sementeira de modelos: { padrao, rotacao }
    // Regra de Ouro 1: globalSettings.modelos tem precedência sobre o esqueleto do template.
    if (globalSettings.modelos || !configWorkspace.modelos) {
      const padrao =
        globalSettings.modelos?.padrao ||
        globalSettings.default_model ||
        configWorkspace.modelos?.padrao ||
        "openrouter/google/gemini-2.5-flash";
      const rotacao =
        Array.isArray(globalSettings.modelos?.rotacao) && globalSettings.modelos.rotacao.length > 0
          ? globalSettings.modelos.rotacao
          : Array.isArray(globalSettings.tests?.rotation) && globalSettings.tests.rotation.length > 0
            ? globalSettings.tests.rotation
            : Array.isArray(configWorkspace.modelos?.rotacao) && configWorkspace.modelos.rotacao.length > 0
              ? configWorkspace.modelos.rotacao
              : [
                  padrao,
                  "openrouter/google/gemini-2.5-flash",
                  "opencode-go/glm-5.3-flash",
                  "openrouter/qwen/qwen3.8-27b:free",
                ];
      configWorkspace.modelos = { padrao, rotacao };
      alterado = true;
    }

    // Sementeira de execution_driver
    if (globalSettings.execution_driver || !configWorkspace.execution_driver) {
      const novoDriver = globalSettings.execution_driver || configWorkspace.execution_driver || "sandbox";
      if (configWorkspace.execution_driver !== novoDriver) {
        configWorkspace.execution_driver = novoDriver;
        alterado = true;
      }
    }

    // Sementeira de provedores
    if (!configWorkspace.provedores && globalSettings.provedores) {
      configWorkspace.provedores = globalSettings.provedores;
      alterado = true;
    }

    if (alterado) {
      const ocDir = join(destino, ".opencorp");
      if (!existsSync(ocDir)) {
        mkdirSync(ocDir, { recursive: true });
      }
      await writeFileAtomic(configPath, `${JSON.stringify(configWorkspace, null, 2)}\n`);
    }
  }
}


