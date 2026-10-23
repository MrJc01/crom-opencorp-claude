import { join } from "node:path";
import { SchedulerError } from "../../shared/errors.js";
import { SettingsStore } from "../workspace/settings-store.js";
import { opencorpHome } from "../../../utils/paths.js";
import { getDatabaseConnection, fecharConexao } from "../../db/connection.js";

// ── Tipos públicos (retrocompatibilidade com CLIs e rotas) ─────────

export type Agenda =
  | { tipo: "cron"; valor: string }
  | { tipo: "intervalo_min"; valor: number }
  | { tipo: "data_unica"; valor: string };

/** Representação de um agendamento baseado em fluxo (substitui o antigo Job SQLite). */
export interface FlowScheduleInfo {
  id: string;
  nome: string;
  workspace: string;
  wsPath: string;
  expressao_cron: string;
  ativo: boolean;
  proxima_exec: string | null;
  ultima_exec: string | null;
}

/** @deprecated Tipo legado mantido para retrocompatibilidade de assinatura — use FlowScheduleInfo. */
export interface Job {
  id: string;
  nome: string;
  agenda: Agenda;
  args: string[];
  workspace: string;
  ativo: boolean;
  graca_min: number;
  ultima_exec: string | null;
  proxima_exec: string | null;
  criado_em: string;
}

export interface OpcoesScheduler {
  homeDir?: string;
  agora?: () => Date;
  executar?: (job: Job) => Promise<string>;
  flowExecutar?: (
    wsPath: string,
    flowId: string,
    opts: {
      entrada?: string;
      model?: string;
      gatilho?: { tipo: string; origem: string };
    },
  ) => Promise<{ execId: string; status: string; contextoFinal: string }>;
  reconciliar?: () => Promise<string[]>;
}

// ── Motor cron e fusos horários (delegado ao domínio puro) ────────
import {
  validarExpressaoCron,
  compilarCampoCron,
  calcularProximoCron,
  calcularProximoCronEmTimezone,
  CronExpressionError,
  validarCron,
  proximoCron,
  proximoCronTz,
  fusoValido,
  FUSO_PADRAO,
} from "../../domain/scheduling/cron-evaluator.js";

export {
  validarExpressaoCron,
  compilarCampoCron,
  calcularProximoCron,
  calcularProximoCronEmTimezone,
  CronExpressionError,
  validarCron,
  proximoCron,
  proximoCronTz,
  fusoValido,
  FUSO_PADRAO,
};

/**
 * Fusão scheduler→fluxo (Etapa 12.1): job `flow run <id> [...]` roda in-process
 * via FlowStore.executar(). Retorna o flowId ou null (caminho legado/spawn).
 */
export function extrairFlowRunDeArgs(args: string[]): string | null {
  if (args[0] === "flow" && args[1] === "run" && typeof args[2] === "string" && args[2].length > 0) {
    return args[2];
  }
  return null;
}

export function parseQuandoDataUnica(quando: string, agora: Date = new Date()): string {
  const q = quando.trim();
  const mOffset = /^\+(\d+)([mhd])$/i.exec(q);
  if (mOffset) {
    const qtd = parseInt(mOffset[1]!, 10);
    const unidade = mOffset[2]!.toLowerCase();
    const mult = unidade === "m" ? 60_000 : unidade === "h" ? 3600_000 : 86400_000;
    return new Date(agora.getTime() + qtd * mult).toISOString();
  }

  const mHora = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(q);
  if (mHora) {
    const hora = parseInt(mHora[1]!, 10);
    const min = parseInt(mHora[2]!, 10);
    const seg = mHora[3] ? parseInt(mHora[3], 10) : 0;
    const alvo = new Date(agora);
    alvo.setHours(hora, min, seg, 0);
    if (alvo.getTime() <= agora.getTime()) {
      alvo.setDate(alvo.getDate() + 1);
    }
    return alvo.toISOString();
  }

  const mAmanha = /^amanh[aã]\s+(\d{1,2}):(\d{2})$/i.exec(q);
  if (mAmanha) {
    const hora = parseInt(mAmanha[1]!, 10);
    const min = parseInt(mAmanha[2]!, 10);
    const alvo = new Date(agora);
    alvo.setDate(alvo.getDate() + 1);
    alvo.setHours(hora, min, 0, 0);
    return alvo.toISOString();
  }

  const d = new Date(q);
  if (!isNaN(d.getTime())) return d.toISOString();
  throw new SchedulerError(`formato de agendamento não reconhecido: "${quando}". Use "14:30", "+30m", "+2h", "amanha 09:00", ou ISO`);
}

export function parseAgendaTask(opts: {
  quando?: string;
  at?: string;
  cron?: string;
  agendar?: string;
  repete?: string;
  repetir?: string;
  intervaloMin?: number;
}): { agenda: Agenda; descricao: string } | null {
  const cronExpr = (opts.cron || opts.agendar)?.trim();
  const repeteExpr = (opts.repete || opts.repetir)?.trim().toLowerCase();
  const quandoExpr = opts.quando || opts.at;

  if (cronExpr) {
    return {
      agenda: { tipo: "cron", valor: cronExpr },
      descricao: `Cron: "${cronExpr}"`,
    };
  }

  if (opts.intervaloMin && Number(opts.intervaloMin) > 0) {
    const min = Number(opts.intervaloMin);
    return {
      agenda: { tipo: "intervalo_min", valor: min },
      descricao: `A cada ${min} min`,
    };
  }

  if (repeteExpr) {
    if (repeteExpr === "diario" || repeteExpr === "diária" || repeteExpr === "daily") {
      let hora = 9;
      let min = 0;
      if (quandoExpr) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(quandoExpr.trim());
        if (m) {
          hora = parseInt(m[1]!, 10);
          min = parseInt(m[2]!, 10);
        }
      }
      return {
        agenda: { tipo: "cron", valor: `${min} ${hora} * * *` },
        descricao: `Diariamente às ${String(hora).padStart(2, "0")}:${String(min).padStart(2, "0")}`,
      };
    }
    if (repeteExpr === "horario" || repeteExpr === "hourly") {
      return {
        agenda: { tipo: "intervalo_min", valor: 60 },
        descricao: `A cada hora (60 min)`,
      };
    }
    if (repeteExpr === "semanal" || repeteExpr === "weekly") {
      return {
        agenda: { tipo: "cron", valor: "0 9 * * 1" },
        descricao: `Semanalmente (toda segunda às 09:00)`,
      };
    }
    const mMin = /^(\d+)m$/i.exec(repeteExpr);
    if (mMin) {
      const val = parseInt(mMin[1]!, 10);
      return {
        agenda: { tipo: "intervalo_min", valor: val },
        descricao: `A cada ${val} min`,
      };
    }
    const mHoraR = /^(\d+)h$/i.exec(repeteExpr);
    if (mHoraR) {
      const val = parseInt(mHoraR[1]!, 10) * 60;
      return {
        agenda: { tipo: "intervalo_min", valor: val },
        descricao: `A cada ${parseInt(mHoraR[1]!, 10)} hora(s)`,
      };
    }
    const num = parseInt(repeteExpr, 10);
    if (!isNaN(num) && num > 0) {
      return {
        agenda: { tipo: "intervalo_min", valor: num },
        descricao: `A cada ${num} min`,
      };
    }
    throw new SchedulerError(`formato de repetição inválido: "${repeteExpr}". Use "diario", "semanal", "30m", "2h" ou número de minutos`);
  }

  if (quandoExpr) {
    const iso = parseQuandoDataUnica(quandoExpr);
    return {
      agenda: { tipo: "data_unica", valor: iso },
      descricao: `Data única: ${iso.slice(0, 16).replace("T", " ")}`,
    };
  }

  return null;
}

// ── Motor Unificado (Padrão n8n) ─────────────────────────────────────
// O Scheduler varre diretamente os Fluxos de cada Workspace registrado.
// Fluxo com `ativo !== false` + nó `tipo === "cron"` = agendável.
// Sem banco intermediário. Sem quarentena. Sem disjuntor.

export class Scheduler {
  private readonly homeDir: string;
  private readonly agora: () => Date;
  private readonly executarFn?: (job: Job) => Promise<string>;
  private readonly flowExecutarFn: NonNullable<OpcoesScheduler["flowExecutar"]> | null;
  private readonly reconciliarFn: (() => Promise<string[]>) | null;
  private timer: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  // Estado e runs compartilhados por processo (garante consistência entre instâncias no mesmo processo/teste)
  private static readonly estadoGlobalFlows = new Map<string, { ultima_exec: string | null; proxima_exec: string | null }>();
  private static readonly runsMemoria = new Map<string, Array<{ id: string; resultado: string; pulado: number; erro: string | null; executado_em: string }>>();

  constructor(opcoes: OpcoesScheduler = {}) {
    this.homeDir = opcoes.homeDir ?? opencorpHome();
    this.agora = opcoes.agora ?? (() => new Date());
    this.executarFn = opcoes.executar;
    this.flowExecutarFn = opcoes.flowExecutar ?? null;
    this.reconciliarFn = opcoes.reconciliar ?? null;
  }

  // ── Workspaces Efetivos ─────────────────────────────────────────────

  private async listarWorkspacesEfetivos(): Promise<Array<{ id: string; path: string }>> {
    const { WorkspaceManager } = await import("../workspace/workspace-manager.js");
    const { join } = await import("node:path");
    const { existsSync, readdirSync } = await import("node:fs");

    const mapa = new Map<string, { id: string; path: string }>();

    try {
      const wm = new WorkspaceManager({ homeDir: this.homeDir });
      for (const w of await wm.listar()) {
        if (w.existe) {
          mapa.set(w.id, { id: w.id, path: w.path });
        }
      }
    } catch {}

    const wsDir = join(this.homeDir, "workspaces");
    if (existsSync(wsDir)) {
      try {
        const entradas = readdirSync(wsDir, { withFileTypes: true });
        for (const ent of entradas) {
          if (ent.isDirectory() && !mapa.has(ent.name)) {
            mapa.set(ent.name, {
              id: ent.name,
              path: join(wsDir, ent.name),
            });
          }
        }
      } catch {}
    }

    return Array.from(mapa.values());
  }

  /** Ids dos workspaces pausados (campo `pausado` de workspaces.json). */
  private async workspacesPausados(): Promise<Set<string>> {
    try {
      const { WorkspaceManager } = await import("../workspace/workspace-manager.js");
      const wm = new WorkspaceManager({ homeDir: this.homeDir });
      return new Set((await wm.listar()).filter((w) => w.pausado).map((w) => w.id));
    } catch {
      return new Set();
    }
  }

  private async resolverWorkspacePath(wsId?: string): Promise<{ id: string; path: string }> {
    const { join } = await import("node:path");
    const { mkdir } = await import("node:fs/promises");
    const targetId = wsId || "default";

    const workspaces = await this.listarWorkspacesEfetivos();
    const achado = workspaces.find((w) => w.id === targetId);
    if (achado) return achado;

    const p = join(this.homeDir, "workspaces", targetId);
    await mkdir(p, { recursive: true });
    return { id: targetId, path: p };
  }

  // ── Fuso horário do workspace ───────────────────────────────────────

  private async fusoDoWorkspace(workspaceId?: string): Promise<string> {
    try {
      const store = new SettingsStore({ homeDir: this.homeDir });
      const { settings } = await store.resolve();
      let tz = typeof settings.scheduler.timezone === "string" && settings.scheduler.timezone
        ? settings.scheduler.timezone
        : FUSO_PADRAO;
      if (workspaceId) {
        try {
          const { WorkspaceManager } = await import("../workspace/workspace-manager.js");
          const wm = new WorkspaceManager({ homeDir: this.homeDir });
          const ws = await wm.resolver(workspaceId);
          const rw = await store.resolve({ workspaceDir: ws.path });
          const tw = (rw.settings as unknown as { scheduler?: { timezone?: unknown } })?.scheduler?.timezone;
          if (typeof tw === "string" && tw) tz = tw;
        } catch {}
      }
      return fusoValido(tz) ? tz : FUSO_PADRAO;
    } catch {
      return FUSO_PADRAO;
    }
  }

  // ── Runs e Locks ────────────────────────────────────────────────────

  private adicionarRun(flowId: string, run: { resultado: string; pulado: number; erro: string | null }): void {
    const chave = `${this.homeDir}:${flowId}`;
    let lista = Scheduler.runsMemoria.get(chave);
    if (!lista) {
      lista = [];
      Scheduler.runsMemoria.set(chave, lista);
    }
    lista.unshift({
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      resultado: run.resultado,
      pulado: run.pulado,
      erro: run.erro,
      executado_em: this.agora().toISOString(),
    });
  }

  async listarRuns(id: string, _limite = 20): Promise<Array<{ id: string; resultado: string; pulado: number; erro: string | null; executado_em: string }>> {
    const chave = `${this.homeDir}:${id}`;
    return Scheduler.runsMemoria.get(chave) ?? [];
  }

  private async claimLock(wsPath: string, flowId: string, minutoEpoch: number): Promise<boolean> {
    const { join } = await import("node:path");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const lockDir = join(wsPath, ".opencorp", "locks");
    try {
      await mkdir(lockDir, { recursive: true });
      const lockFile = join(lockDir, `lock-${flowId}-${minutoEpoch}.lock`);
      await writeFile(lockFile, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }

  // ── Varredura de fluxos agendados ───────────────────────────────────

  async listarAgendamentos(): Promise<FlowScheduleInfo[]> {
    const agora = this.agora();
    const resultado: FlowScheduleInfo[] = [];
    try {
      const { FlowStore } = await import("../orchestration/flow-store.js");
      const flows = new FlowStore({ homeDir: this.homeDir });
      const workspaces = await this.listarWorkspacesEfetivos();

      for (const ws of workspaces) {
        try {
          const lista = await flows.listar(ws.path);
          for (const f of lista) {
            if (f.ativo === false) continue;
            const cronGatilho = f.gatilhos.find((g) => g.tipo === "cron");
            if (!cronGatilho?.detalhe) continue;
            const expressao = cronGatilho.detalhe;
            const chave = `${this.homeDir}:${ws.id}:${f.id}`;
            const estado = Scheduler.estadoGlobalFlows.get(chave);
            let proxima = estado?.proxima_exec ?? null;
            if (!proxima) {
              try {
                const tz = await this.fusoDoWorkspace(ws.id);
                proxima = proximoCronTz(expressao, agora, tz).toISOString();
              } catch { proxima = null; }
            }
            resultado.push({
              id: f.id,
              nome: f.nome,
              workspace: ws.id,
              wsPath: ws.path,
              expressao_cron: expressao,
              ativo: true,
              proxima_exec: proxima,
              ultima_exec: estado?.ultima_exec ?? null,
            });
          }
        } catch {}
      }
    } catch (erro) {
      console.error("[scheduler] erro ao listar agendamentos:", erro instanceof Error ? erro.message : erro);
    }
    return resultado;
  }

  async listar(somenteAtivos = false): Promise<Job[]> {
    const resultado: Job[] = [];
    const workspaces = await this.listarWorkspacesEfetivos();
    const { FlowStore } = await import("../orchestration/flow-store.js");
    const flowStore = new FlowStore({ homeDir: this.homeDir });

    for (const ws of workspaces) {
      let flows: any[] = [];
      try {
        flows = await flowStore.listar(ws.path);
      } catch {
        continue;
      }
      for (const f of flows) {
        if (somenteAtivos && f.ativo === false) continue;
        const cronGatilho = f.gatilhos.find((g: any) => g.tipo === "cron");
        if (!cronGatilho?.detalhe) continue;

        const chave = `${this.homeDir}:${ws.id}:${f.id}`;
        const estado = Scheduler.estadoGlobalFlows.get(chave);

        const fullFlow = await flowStore.obter(ws.path, f.id).catch(() => null);
        const nodeCron = fullFlow?.nos.find((n) => n.tipo === "cron");
        const cfg = (nodeCron?.config ?? {}) as Record<string, any>;
        const agendaOriginal = (cfg.agenda_original as Agenda) || { tipo: "cron", valor: cronGatilho.detalhe };
        const args = (cfg.args as string[]) || ["flow", "run", f.id];

        let proxima = estado?.proxima_exec ?? null;
        if (!proxima && f.ativo !== false) {
          try {
            const tz = await this.fusoDoWorkspace(ws.id);
            proxima = proximoCronTz(cronGatilho.detalhe, this.agora(), tz).toISOString();
          } catch {
            proxima = null;
          }
        }

        resultado.push({
          id: f.id,
          nome: f.nome,
          agenda: agendaOriginal,
          args,
          workspace: ws.id,
          ativo: f.ativo !== false,
          graca_min: (cfg.graca_min as number) ?? 5,
          ultima_exec: estado?.ultima_exec ?? null,
          proxima_exec: f.ativo !== false ? proxima : null,
          criado_em: "",
        });
      }
    }
    return resultado;
  }

  // ── CRUD de Agendamentos ────────────────────────────────────────────

  async criar(opts: {
    nome: string;
    agenda: Agenda;
    args: string[];
    workspace?: string;
    graca_min?: number;
  }): Promise<Job> {
    if (!opts.nome || typeof opts.nome !== "string" || opts.nome.trim().length === 0) {
      throw new SchedulerError("nome é obrigatório para criar agendamento");
    }
    if (!Array.isArray(opts.args) || opts.args.length === 0) {
      throw new SchedulerError("args deve ser um array não-vazio");
    }
    if (opts.args[0] === "agent" && opts.args.includes("--ordem")) {
      throw new SchedulerError("agent run não aceita --ordem (use argumento posicional)");
    }

    let expressaoCron = "* * * * *";
    if (opts.agenda.tipo === "cron") {
      validarCron(opts.agenda.valor);
      expressaoCron = opts.agenda.valor;
    } else if (opts.agenda.tipo === "intervalo_min") {
      if (typeof opts.agenda.valor !== "number" || opts.agenda.valor < 1) {
        throw new SchedulerError("intervalo_min deve ser >= 1");
      }
      expressaoCron = opts.agenda.valor < 60
        ? `*/${Math.round(opts.agenda.valor)} * * * *`
        : `0 */${Math.round(opts.agenda.valor / 60)} * * *`;
    } else if (opts.agenda.tipo === "data_unica") {
      const d = new Date(opts.agenda.valor);
      if (isNaN(d.getTime())) {
        throw new SchedulerError(`data_unica inválida: "${opts.agenda.valor}"`);
      }
      expressaoCron = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
    }

    const ws = await this.resolverWorkspacePath(opts.workspace);
    const { FlowStore } = await import("../orchestration/flow-store.js");
    const flowStore = new FlowStore({ homeDir: this.homeDir });
    const jobId = `sch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const fuso = await this.fusoDoWorkspace(ws.id);

    let proximaIso: string | null = null;
    try {
      if (opts.agenda.tipo === "data_unica") {
        proximaIso = new Date(opts.agenda.valor).toISOString();
      } else if (opts.agenda.tipo === "intervalo_min") {
        proximaIso = new Date(this.agora().getTime() + opts.agenda.valor * 60_000).toISOString();
      } else {
        proximaIso = proximoCronTz(expressaoCron, this.agora(), fuso).toISOString();
      }
    } catch {
      proximaIso = null;
    }

    const novoFlow = {
      id: jobId,
      nome: opts.nome,
      ativo: true,
      nos: [
        {
          id: "gatilho-cron",
          tipo: "cron" as const,
          config: {
            expressao_cron: expressaoCron,
            agenda_original: opts.agenda,
            args: opts.args,
            graca_min: opts.graca_min ?? 5,
          },
        },
        {
          id: "passo-script",
          tipo: "script" as const,
          config: {
            comando: opts.args.join(" "),
          },
        },
      ],
      arestas: [
        {
          de: "gatilho-cron",
          para: "passo-script",
        },
      ],
    };

    await flowStore.salvar(ws.path, novoFlow);

    const chave = `${this.homeDir}:${ws.id}:${jobId}`;
    Scheduler.estadoGlobalFlows.set(chave, {
      ultima_exec: null,
      proxima_exec: proximaIso,
    });

    return {
      id: jobId,
      nome: opts.nome,
      agenda: opts.agenda,
      args: opts.args,
      workspace: ws.id,
      ativo: true,
      graca_min: opts.graca_min ?? 5,
      ultima_exec: null,
      proxima_exec: proximaIso,
      criado_em: new Date().toISOString(),
    };
  }

  async obter(id: string): Promise<Job> {
    const { FlowStore } = await import("../orchestration/flow-store.js");
    const flowStore = new FlowStore({ homeDir: this.homeDir });
    const workspaces = await this.listarWorkspacesEfetivos();

    for (const ws of workspaces) {
      try {
        const flow = await flowStore.obter(ws.path, id);
        if (flow) {
          const cronGatilho = flow.nos.find((n) => n.tipo === "cron");
          const config = (cronGatilho?.config ?? {}) as Record<string, unknown>;
          const chave = `${this.homeDir}:${ws.id}:${flow.id}`;
          const estado = Scheduler.estadoGlobalFlows.get(chave);
          const agendaOriginal = (config.agenda_original as Agenda) || {
            tipo: "cron",
            valor: (config.expressao_cron as string) || "* * * * *",
          };
          const args = (config.args as string[]) || ["flow", "run", flow.id];
          return {
            id: flow.id,
            nome: flow.nome,
            agenda: agendaOriginal,
            args,
            workspace: ws.id,
            ativo: flow.ativo !== false,
            graca_min: (config.graca_min as number) ?? 5,
            ultima_exec: estado?.ultima_exec ?? null,
            proxima_exec: flow.ativo !== false ? (estado?.proxima_exec ?? null) : null,
            criado_em: "",
          };
        }
      } catch {}
    }

    const erro = new SchedulerError(`Job "${id}" não encontrado`) as unknown as Error & { status: number };
    erro.status = 404;
    throw erro;
  }

  async pausar(id: string): Promise<Job> {
    const job = await this.obter(id);
    const { FlowStore } = await import("../orchestration/flow-store.js");
    const flowStore = new FlowStore({ homeDir: this.homeDir });
    const ws = await this.resolverWorkspacePath(job.workspace);

    const flow = await flowStore.obter(ws.path, id);
    await flowStore.salvar(ws.path, { ...flow, ativo: false });
    const chave = `${this.homeDir}:${job.workspace}:${id}`;
    const estado = Scheduler.estadoGlobalFlows.get(chave);
    Scheduler.estadoGlobalFlows.set(chave, {
      ultima_exec: estado?.ultima_exec ?? null,
      proxima_exec: null,
    });
    job.ativo = false;
    job.proxima_exec = null;
    return job;
  }

  async retomar(id: string): Promise<Job> {
    const job = await this.obter(id);
    const { FlowStore } = await import("../orchestration/flow-store.js");
    const flowStore = new FlowStore({ homeDir: this.homeDir });
    const ws = await this.resolverWorkspacePath(job.workspace);

    const flow = await flowStore.obter(ws.path, id);
    await flowStore.salvar(ws.path, { ...flow, ativo: true });
    let novaProxima: string | null = null;
    if (job.agenda.tipo === "intervalo_min") {
      novaProxima = new Date(this.agora().getTime() + job.agenda.valor * 60_000).toISOString();
    } else if (job.agenda.tipo === "cron") {
      const fuso = await this.fusoDoWorkspace(job.workspace);
      novaProxima = proximoCronTz(job.agenda.valor, this.agora(), fuso).toISOString();
    }
    const chave = `${this.homeDir}:${job.workspace}:${id}`;
    const estado = Scheduler.estadoGlobalFlows.get(chave);
    Scheduler.estadoGlobalFlows.set(chave, {
      ultima_exec: estado?.ultima_exec ?? null,
      proxima_exec: novaProxima,
    });
    job.ativo = true;
    job.proxima_exec = novaProxima;
    return job;
  }

  async excluir(id: string): Promise<{ ok: boolean; id: string }> {
    const job = await this.obter(id);
    const { FlowStore } = await import("../orchestration/flow-store.js");
    const flowStore = new FlowStore({ homeDir: this.homeDir });
    const ws = await this.resolverWorkspacePath(job.workspace);
    await flowStore.deletar(ws.path, id).catch(() => {});
    Scheduler.estadoGlobalFlows.delete(`${this.homeDir}:${job.workspace}:${id}`);
    return { ok: true, id };
  }

  async runNow(id: string): Promise<{ resultado: string }> {
    const job = await this.obter(id);
    const agora = this.agora();
    const chave = `${this.homeDir}:${job.workspace}:${id}`;

    let resultado = "ok";
    if (this.executarFn) {
      resultado = await this.executarFn(job);
    } else if (this.flowExecutarFn) {
      const flowIdAlvo = extrairFlowRunDeArgs(job.args) || id;
      const ws = await this.resolverWorkspacePath(job.workspace);
      const res = await this.flowExecutarFn(ws.path, flowIdAlvo, {
        gatilho: { tipo: "cron", origem: id },
      });
      resultado = `flow ${flowIdAlvo} exec ${res.execId}`;
    }

    let proximaIso: string | null = null;
    if (job.agenda.tipo === "intervalo_min") {
      proximaIso = new Date(agora.getTime() + job.agenda.valor * 60_000).toISOString();
    } else if (job.agenda.tipo === "cron") {
      const fuso = await this.fusoDoWorkspace(job.workspace);
      proximaIso = proximoCronTz(job.agenda.valor, agora, fuso).toISOString();
    }

    Scheduler.estadoGlobalFlows.set(chave, {
      ultima_exec: agora.toISOString(),
      proxima_exec: proximaIso,
    });

    this.adicionarRun(id, {
      resultado,
      pulado: 0,
      erro: null,
    });

    return { resultado };
  }

  // ── Reaper de Zombies ───────────────────────────────────────────────

  private async reapearZombies(): Promise<string[]> {
    if (this.reconciliarFn) {
      try {
        return await this.reconciliarFn();
      } catch (erro) {
        console.error("[scheduler] reaper de zumbis falhou:", erro instanceof Error ? erro.message : erro);
        return [];
      }
    }
    try {
      const [{ SessionManager }] = await Promise.all([
        import("../execution/session-manager.js"),
      ]);
      const sessoes = new SessionManager({ homeDir: this.homeDir });
      const workspaces = await this.listarWorkspacesEfetivos();
      const reconciliados: string[] = [];
      for (const ws of workspaces) {
        try {
          reconciliados.push(...(await sessoes.reconciliarZombies(ws.path)));
        } catch {}
      }
      return reconciliados;
    } catch (erro) {
      console.error("[scheduler] reaper de zumbis falhou:", erro instanceof Error ? erro.message : erro);
      return [];
    }
  }

  // ── tick() — Motor Unificado ────────────────────────────────────────

  async tick(): Promise<{ executados: string[]; pulados: string[]; reconciliados: string[] }> {
    const reconciliados = await this.reapearZombies();
    const agora = this.agora();
    const minutoAtual = Math.floor(agora.getTime() / 60000);

    const executados: string[] = [];
    const pulados: string[] = [];

    try {
      const { FlowStore } = await import("../orchestration/flow-store.js");
      const flowStore = new FlowStore({ homeDir: this.homeDir });
      const workspaces = await this.listarWorkspacesEfetivos();

      // Config de catch-up global
      const store = new SettingsStore({ homeDir: this.homeDir });
      const { settings } = await store.resolve().catch(() => ({ settings: { scheduler: {} } } as any));
      const catchUp = settings.scheduler?.catch_up === true;
      const catchUpMaxMin = typeof settings.scheduler?.catch_up_max_min === "number" ? settings.scheduler.catch_up_max_min : 60;

      const pausados = await this.workspacesPausados();

      for (const ws of workspaces) {
        if (pausados.has(ws.id)) continue;
        let flowsList: Awaited<ReturnType<typeof flowStore.listar>>;
        try {
          flowsList = await flowStore.listar(ws.path);
        } catch {
          continue;
        }

        const tz = await this.fusoDoWorkspace(ws.id);

        for (const f of flowsList) {
          if (f.ativo === false) continue;
          const cronGatilho = f.gatilhos.find((g) => g.tipo === "cron");
          if (!cronGatilho?.detalhe) continue;

          const expressao = cronGatilho.detalhe;
          const chave = `${this.homeDir}:${ws.id}:${f.id}`;

          let jobObj: Job | null = null;
          try {
            jobObj = await this.obter(f.id);
          } catch {}

          const estado = Scheduler.estadoGlobalFlows.get(chave);
          let proxima: Date;
          try {
            if (estado?.proxima_exec) {
              proxima = new Date(estado.proxima_exec);
            } else if (jobObj?.agenda.tipo === "intervalo_min") {
              proxima = new Date(agora.getTime());
            } else {
              const ref = new Date(agora.getTime() - 120000);
              proxima = proximoCronTz(expressao, ref, tz);
            }
          } catch {
            continue;
          }

          const gracaMs = (jobObj?.graca_min ?? 5) * 60_000;
          const atrasoMs = agora.getTime() - proxima.getTime();

          // Atraso além da graça
          if (atrasoMs > gracaMs) {
            if (catchUp && atrasoMs <= catchUpMaxMin * 60_000) {
              // Catch-up: registra o run de catch-up antes da execução
              this.adicionarRun(f.id, {
                resultado: "catch-up: execução recuperada de janela atrasada",
                pulado: 0,
                erro: null,
              });
              // segue para execução
            } else {
              // Pula por atraso excessivo
              pulados.push(f.id);
              this.adicionarRun(f.id, {
                resultado: "pulado",
                pulado: 1,
                erro: "job pulado por atraso além da tolerância de graça",
              });
              let proximaAposPulo: string | null;
              try {
                if (jobObj?.agenda.tipo === "intervalo_min") {
                  proximaAposPulo = new Date(agora.getTime() + jobObj.agenda.valor * 60_000).toISOString();
                } else {
                  proximaAposPulo = proximoCronTz(expressao, agora, tz).toISOString();
                }
              } catch {
                proximaAposPulo = null;
              }
              Scheduler.estadoGlobalFlows.set(chave, {
                ultima_exec: estado?.ultima_exec ?? null,
                proxima_exec: proximaAposPulo,
              });
              continue;
            }
          }

          if (proxima.getTime() > agora.getTime()) {
            Scheduler.estadoGlobalFlows.set(chave, {
              ultima_exec: estado?.ultima_exec ?? null,
              proxima_exec: proxima.toISOString(),
            });
            continue;
          }

          // Lock atômico para claim em corrida entre múltiplos schedulers
          const temLock = await this.claimLock(ws.path, f.id, minutoAtual);
          if (!temLock) {
            continue;
          }

          let proximaAposExec: string | null;
          try {
            if (jobObj?.agenda.tipo === "intervalo_min") {
              proximaAposExec = new Date(agora.getTime() + jobObj.agenda.valor * 60_000).toISOString();
            } else if (jobObj?.agenda.tipo === "data_unica") {
              proximaAposExec = null;
            } else {
              proximaAposExec = proximoCronTz(expressao, agora, tz).toISOString();
            }
          } catch {
            proximaAposExec = null;
          }

          Scheduler.estadoGlobalFlows.set(chave, {
            ultima_exec: agora.toISOString(),
            proxima_exec: proximaAposExec,
          });

          let resExec = "ok";
          try {
            if (this.executarFn && jobObj) {
              resExec = await this.executarFn(jobObj);
            } else if (this.flowExecutarFn) {
              const res = await this.flowExecutarFn(ws.path, f.id, {
                gatilho: { tipo: "cron", origem: f.id },
              });
              resExec = `flow ${f.id} exec ${res.execId}`;
            } else {
              await flowStore.executar(ws.path, f.id, {
                gatilho: { tipo: "cron", origem: f.id },
              });
            }
            executados.push(f.id);
            this.adicionarRun(f.id, {
              resultado: resExec,
              pulado: 0,
              erro: null,
            });

            if (jobObj?.agenda.tipo === "data_unica") {
              const fl = await flowStore.obter(ws.path, f.id).catch(() => null);
              if (fl) await flowStore.salvar(ws.path, { ...fl, ativo: false }).catch(() => {});
            }
          } catch (erro) {
            const msgErro = erro instanceof Error ? erro.message : String(erro);
            console.error(`[scheduler] falha ao executar fluxo ${f.id} (ws: ${ws.id}): ${msgErro}`);
            pulados.push(f.id);
            this.adicionarRun(f.id, {
              resultado: "falhou",
              pulado: 0,
              erro: msgErro,
            });
          }

          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    } catch (erro) {
      console.error("[scheduler] erro crítico no tick:", erro instanceof Error ? erro.message : erro);
    }

    return { executados, pulados, reconciliados };
  }

  // ── Controle do daemon ──────────────────────────────────────────────

  iniciar(intervaloSeg = 30, manterVivo = false): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((erro) => {
        console.error("[scheduler] erro no tick:", erro instanceof Error ? erro.message : erro);
      });
    }, intervaloSeg * 1000);
    if (manterVivo) {
      this.keepAlive = setInterval(() => undefined, 60_000);
    } else {
      this.timer.unref?.();
    }
  }

  obterConexaoDb(caminho?: string): ReturnType<typeof getDatabaseConnection> {
    const dbPath = caminho ?? join(this.homeDir, ".opencorp", "scheduler.db");
    return getDatabaseConnection(dbPath);
  }

  parar(): void {
    try {
      const dbPath = join(this.homeDir, ".opencorp", "scheduler.db");
      fecharConexao(dbPath);
    } catch {}
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.keepAlive) {
      clearInterval(this.keepAlive);
      this.keepAlive = null;
    }
  }
}

/** Obtém conexão SQLite gerenciada com WAL para persistência de agendamento via Connection Factory */
export function getSchedulerDatabase(homeDir?: string): ReturnType<typeof getDatabaseConnection> {
  const dbPath = join(homeDir ?? opencorpHome(), ".opencorp", "scheduler.db");
  return getDatabaseConnection(dbPath);
}

export function argsComGatilhoCron(job: { id: string; args?: string[] }): string {
  const args = job.args ?? [];
  if ((args[0] === "agent" && args[1] === "run") || (args[0] === "flow" && args[1] === "run")) {
    return `cron:${job.id}`;
  }
  return "";
}


