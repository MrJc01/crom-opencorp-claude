import { processoOpencorpVivo } from "../../../utils/processo.js";
import { existsSync, openSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { SessionManager } from "../execution/session-manager.js";
import { ApprovalsStore } from "./approvals-store.js";
import { BudgetManager } from "./budget-manager.js";
import { TaskStore } from "../storage/task-store.js";
import { RegistryStore, type MetaRegistro } from "../storage/registry-store.js";
import { SettingsStore } from "../workspace/settings-store.js";
import { opencorpHome } from "../../../utils/paths.js";
import { mkdirRecursive, writeFileAtomic } from "../../../utils/fs-safe.js";

const LIMITE_APROVACAO_MIN = 30;
const MODELO_ORDEM_CEGA = "opencode/hy3-free";
const MAX_CHAVES = 500;

export interface SessaoSupervisor {
  rodar(opcoes: {
    agente: string;
    ordem?: string;
    model?: string;
    workspaceDir?: string;
    pularGuard?: boolean;
    tags?: string[];
  }): Promise<{ id: string; status: string; exit_code: number | null }>;
  reconciliarZombies?(wsPath: string): Promise<string[]>;
}

export interface SupervisorOptions {
  homeDir?: string;
  cwd?: string;
  sessoes?: SessaoSupervisor;
  budget?: BudgetManager;
  agora?: () => Date;
}

export type TipoProblema = "execucao_falha" | "approval_pendente" | "budget_80" | "tarefa_delegada";

export interface Problema {
  tipo: TipoProblema;
  chave: string;
  detalhe: string;
  acao: "ordem" | "registrar" | "escalar";
  agente?: string;
  ordem?: string;
  healing?: { execOriginal: string };
}

export interface Checks {
  execucoes_falhas: number;
  approvals_pendentes: number;
  approvals_antigas: number;
  budget_80: number;
  tarefas_delegadas: number;
}

export interface OrdemEmitida {
  problema: string;
  agente: string;
  ordem: string;
  exec_id: string;
}

export interface Recusa {
  problema: string;
  motivo: string;
}

export interface ResultadoTick {
  em: string;
  duracao_ms: number;
  checks: Checks;
  ordens: OrdemEmitida[];
  recusas: Recusa[];
  escalacoes: { problema: string; detalhe: string }[];
  ignorados: string[];
  locks_liberados: string[];
  zombies_reconciliados: string[];
}

export interface EstadoSupervisor {
  ultimo_tick: string | null;
  chaves_tratadas: string[];
}

export interface PidInfo {
  pid: number;
  workspace_id: string;
  workspace_path: string;
  intervalo_minutes: number;
  iniciado_em: string;
  ultimo_tick: string | null;
}

function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export async function spawnDaemon(argv: string[], logPath: string): Promise<number> {
  await mkdirRecursive(dirname(logPath));
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid ?? 0;
}

export function pidPath(wsPath: string): string {
  return join(wsPath, ".opencorp", "supervisor.pid");
}

export async function lerPidfile(wsPath: string): Promise<PidInfo | null> {
  const path = pidPath(wsPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as PidInfo;
  } catch {
    return null;
  }
}

export async function pidVivo(pid: number): Promise<boolean> {
  return processoOpencorpVivo(pid);
}

export async function estaRodando(wsPath: string): Promise<boolean> {
  const pid = await lerPidfile(wsPath);
  return pid !== null && (await pidVivo(pid.pid));
}

export async function gravarPidfile(wsPath: string, info: PidInfo): Promise<void> {
  await writeFileAtomic(pidPath(wsPath), `${JSON.stringify(info, null, 2)}\n`);
}

export async function removerPidfile(wsPath: string): Promise<void> {
  const path = pidPath(wsPath);
  if (existsSync(path)) {
    const { rm } = await import("node:fs/promises");
    await rm(path, { force: true });
  }
}

function extrairFalhas(execucoes: MetaRegistro[]): MetaRegistro[] {
  return execucoes.filter((m) => {
    const extras = (m.extras ?? {}) as Record<string, unknown>;
    return extras.status === "falhou";
  });
}

export class Supervisor {
  private readonly homeDir: string;
  private readonly store: SettingsStore;
  private readonly registros = new RegistryStore();
  private readonly approvals = new ApprovalsStore();
  private readonly sessoes: SessaoSupervisor;
  private readonly budget: BudgetManager;
  private readonly agora: () => Date;
  private sinalParada = false;
  private despertar: (() => void) | null = null;

  constructor(opts: SupervisorOptions = {}) {
    this.homeDir = opts.homeDir ?? opencorpHome();
    this.store = new SettingsStore({ homeDir: this.homeDir, cwd: opts.cwd });
    this.sessoes = opts.sessoes ?? new SessionManager({ homeDir: this.homeDir, cwd: opts.cwd });
    this.budget = opts.budget ?? new BudgetManager({ homeDir: this.homeDir, cwd: opts.cwd });
    this.agora = opts.agora ?? (() => new Date());
  }

  solicitarParada(): void {
    this.sinalParada = true;
    this.despertar?.();
  }

  estadoPath(wsPath: string): string {
    return join(wsPath, ".opencorp", "supervisor-estado.json");
  }

  async lerEstado(wsPath: string): Promise<EstadoSupervisor> {
    const path = this.estadoPath(wsPath);
    if (!existsSync(path)) return { ultimo_tick: null, chaves_tratadas: [] };
    try {
      const dados = JSON.parse(await readFile(path, "utf8")) as Partial<EstadoSupervisor>;
      return {
        ultimo_tick: typeof dados.ultimo_tick === "string" ? dados.ultimo_tick : null,
        chaves_tratadas: Array.isArray(dados.chaves_tratadas) ? dados.chaves_tratadas : [],
      };
    } catch {
      return { ultimo_tick: null, chaves_tratadas: [] };
    }
  }

  private async gravarEstado(wsPath: string, estado: EstadoSupervisor): Promise<void> {
    await writeFileAtomic(
      this.estadoPath(wsPath),
      `${JSON.stringify({ ...estado, chaves_tratadas: estado.chaves_tratadas.slice(-MAX_CHAVES) }, null, 2)}\n`,
    );
  }

  private async coletar(
    wsPath: string,
    estado: EstadoSupervisor,
    healing: { enabled: boolean; max_retries: number },
  ): Promise<{ problemas: Problema[]; checks: Checks; fechadas: string[] }> {
    const problemas: Problema[] = [];
    const fechadas: string[] = [];
    const checks: Checks = {
      execucoes_falhas: 0,
      approvals_pendentes: 0,
      approvals_antigas: 0,
      budget_80: 0,
      tarefas_delegadas: 0,
    };

    const execucoes = await this.registros.listar(wsPath, "execucoes");
    for (const meta of extrairFalhas(execucoes)) {
      const extrasMeta = (meta.extras ?? {}) as Record<string, unknown>;
      if (extrasMeta.tipo === "healing") continue;
      if (extrasMeta.healing_escala_humano === true) continue;
      checks.execucoes_falhas += 1;
      const detalhe = `execução ${meta.id} falhou — ${meta.descricao.slice(0, 120)}`;
      if (!healing.enabled) {
        problemas.push({
          tipo: "execucao_falha",
          chave: `execucao_falha:${meta.id}`,
          detalhe: `${detalhe} (healing desabilitado — apenas registrado)`,
          acao: "registrar",
        });
        continue;
      }
      if (estado.chaves_tratadas.includes(`healing_ok:${meta.id}`)) continue;
      const tentativas = Number(extrasMeta.healing_tentativas ?? 0);
      const correcoes = execucoes.filter((m) => {
        const e = (m.extras ?? {}) as Record<string, unknown>;
        const peloHealingOrigem = e.healing_origem === meta.id;
        const pelaReferencia = Array.isArray(m.referencias) && m.referencias.includes(meta.id);
        return e.tipo === "healing" && (peloHealingOrigem || pelaReferencia);
      });
      const ultima = correcoes.sort((a, b) => b.criado_em.localeCompare(a.criado_em))[0];
      if (ultima && ((ultima.extras ?? {}) as Record<string, unknown>).status === "concluido") {
        fechadas.push(`healing_ok:${meta.id}`);
        continue;
      }
      if (tentativas >= healing.max_retries) {
        problemas.push({
          tipo: "execucao_falha",
          chave: `escala_humano:${meta.id}:${tentativas}`,
          detalhe: `${detalhe} — ${tentativas} tentativa(s) de correção esgotada(s), escala para humano`,
          acao: "escalar",
          healing: { execOriginal: meta.id },
        });
        continue;
      }
      const contexto = await this.contextoFalha(wsPath, meta.id);
      problemas.push({
        tipo: "execucao_falha",
        chave: `execucao_falha:${meta.id}:healing:${tentativas + 1}`,
        detalhe: `${detalhe} — correção assistida (tentativa ${tentativas + 1}/${healing.max_retries})`,
        acao: "ordem",
        agente: "executor-padrao",
        ordem: contexto.ordem,
        healing: { execOriginal: meta.id },
      });
    }

    for (const pendencia of await this.approvals.listar(wsPath)) {
      if (pendencia.status !== "pendente") continue;
      checks.approvals_pendentes += 1;
      const idadeMin = (this.agora().getTime() - Date.parse(pendencia.criado_em)) / 60000;
      if (idadeMin < LIMITE_APROVACAO_MIN) continue;
      checks.approvals_antigas += 1;
      problemas.push({
        tipo: "approval_pendente",
        chave: `approval_pendente:${pendencia.id}`,
        detalhe: `pendência ${pendencia.id} aguarda aprovação há ${Math.floor(idadeMin)} min (padrão "${pendencia.padrao}")`,
        acao: "ordem",
        agente: "executor-padrao",
        ordem: `registre em .opencorp/registries/logs/ um lembrete formal da pendência de aprovação humana "${pendencia.id}" (padrão "${pendencia.padrao}", ordem: ${pendencia.ordem.slice(0, 80)}) — lembre o humano de usar "opencorp approvals"`,
      });
    }

    const estadoBudget = await this.budget.carregar(wsPath);
    const limites = await this.budget.limites(wsPath);
    if (estadoBudget.workspace_usd_hoje / Math.max(limites.daily_usd, 1e-9) >= 0.8) {
      checks.budget_80 += 1;
      problemas.push({
        tipo: "budget_80",
        chave: `budget_80:${estadoBudget.dia}:workspace`,
        detalhe: `consumo do workspace em ${estadoBudget.dia} atingiu ${((estadoBudget.workspace_usd_hoje / Math.max(limites.daily_usd, 1e-9)) * 100).toFixed(1)}% do teto diário`,
        acao: "registrar",
      });
    }
    for (const [agente, consumo] of Object.entries(estadoBudget.por_agente)) {
      if (consumo / Math.max(limites.per_agent_usd, 1e-9) >= 0.8) {
        checks.budget_80 += 1;
        problemas.push({
          tipo: "budget_80",
          chave: `budget_80:${estadoBudget.dia}:${agente}`,
          detalhe: `agente "${agente}" atingiu ${((consumo / Math.max(limites.per_agent_usd, 1e-9)) * 100).toFixed(1)}% do teto diário`,
          acao: "registrar",
          agente,
        });
      }
    }

    const auditPath = join(wsPath, ".opencorp", "registries", "logs", "audit-log", "journal.jsonl");
    if (existsSync(auditPath)) {
      try {
        const bruto = await readFile(auditPath, "utf8");
        for (const linha of bruto.split("\n")) {
          if (linha.trim().length === 0) continue;
          try {
            const ev = JSON.parse(linha) as { evento?: string; dono?: string; resumo?: string; origem?: string; ts?: string };
            if (ev.evento !== "tarefa_delegada") continue;
            checks.tarefas_delegadas += 1;
            problemas.push({
              tipo: "tarefa_delegada",
              chave: `tarefa_delegada:${ev.origem ?? "sem-origem"}|${ev.ts ?? linha.slice(0, 40)}`,
              detalhe: `tarefa delegada a "${ev.dono ?? "?"}" pela ata (${ev.origem ?? "?"}) — ${ev.resumo ?? ""}`,
              acao: "registrar",
            });
          } catch {
            continue;
          }
        }
      } catch {
        // journal ilegível — próxima tentativa
      }
    }
    return { problemas, checks, fechadas };
  }

  async tick(wsPath: string): Promise<ResultadoTick> {
    const inicioTick = this.agora();
    const estado = await this.lerEstado(wsPath);
    const healing = await this.healingCfg(wsPath);

    // ── anti-stale (Fase 3.3): limpar estado órfão antes de coletar ──
    const tarefas = new TaskStore({ agora: this.agora });
    let locks_liberados: string[] = [];
    try {
      locks_liberados = await tarefas.limparLocksExpirados(wsPath);
    } catch {
      // board indisponível — segue
    }
    let zombies_reconciliados: string[] = [];
    try {
      if (typeof this.sessoes.reconciliarZombies === "function") {
        zombies_reconciliados = await this.sessoes.reconciliarZombies(wsPath);
      }
    } catch {
      // registry indisponível — segue
    }
    const { problemas, checks, fechadas } = await this.coletar(wsPath, estado, healing);
    const tratadas = new Set([...estado.chaves_tratadas, ...fechadas]);
    const maxOrdens = await this.maxOrdensPorTick(wsPath);

    const ordens: OrdemEmitida[] = [];
    const recusas: Recusa[] = [];
    const escalacoes: { problema: string; detalhe: string }[] = [];
    const ignorados: string[] = [];
    let emitidas = 0;

    for (const problema of problemas) {
      if (tratadas.has(problema.chave)) {
        ignorados.push(problema.chave);
        continue;
      }
      if (problema.acao === "registrar") {
        tratadas.add(problema.chave);
        continue;
      }
      if (problema.acao === "escalar") {
        const original = await this.registros.lerMeta(wsPath, "execucoes", problema.healing!.execOriginal);
        const extrasOriginal = (original.extras ?? {}) as Record<string, unknown>;
        extrasOriginal.healing_escala_humano = true;
        original.extras = extrasOriginal;
        await this.registros.salvarMeta(wsPath, "execucoes", original.id, original);
        await this.registros.anexarEvento(wsPath, "execucoes", original.id, {
          ts: this.agora().toISOString(),
          por: "supervisor",
          evento: "escala_humano",
          resumo: problema.detalhe,
        });
        await this.registros.eventoAuditoria(wsPath, {
          por: "supervisor",
          evento: "escala_humano",
          resumo: problema.detalhe,
          execucao: original.id,
        });
        escalacoes.push({ problema: problema.chave, detalhe: problema.detalhe });
        tratadas.add(problema.chave);
        continue;
      }
      if (emitidas >= maxOrdens) continue;
      try {
        const r = await this.sessoes.rodar({
          agente: problema.agente!,
          ordem: problema.ordem!,
          model: MODELO_ORDEM_CEGA,
          workspaceDir: wsPath,
          pularGuard: true,
          tags: ["supervisor"],
          ...(problema.healing ? { referencias: [problema.healing.execOriginal], tipo: "healing" } : {}),
        });
        tratadas.add(problema.chave);
        emitidas += 1;
        ordens.push({ problema: problema.chave, agente: problema.agente!, ordem: problema.ordem!, exec_id: r.id });
        if (problema.healing) {
          const original = await this.registros.lerMeta(wsPath, "execucoes", problema.healing.execOriginal);
          const extrasOriginal = (original.extras ?? {}) as Record<string, unknown>;
          extrasOriginal.healing_tentativas = Number(extrasOriginal.healing_tentativas ?? 0) + 1;
          original.extras = extrasOriginal;
          await this.registros.salvarMeta(wsPath, "execucoes", original.id, original);
          await this.registros.anexarEvento(wsPath, "execucoes", original.id, {
            ts: this.agora().toISOString(),
            por: "supervisor",
            evento: "healing_disparado",
            correcao: r.id,
            resumo: `correção assistida disparada (tentativa ${extrasOriginal.healing_tentativas}/${healing.max_retries})`,
          });
        }
      } catch (erro) {
        recusas.push({ problema: problema.chave, motivo: msg(erro) });
      }
    }

    const em = this.agora().toISOString();
    const resultado: ResultadoTick = {
      em,
      duracao_ms: this.agora().getTime() - inicioTick.getTime(),
      checks,
      ordens,
      recusas,
      escalacoes,
      ignorados,
      locks_liberados,
      zombies_reconciliados,
    };
    await this.registros.garantirRegistro(wsPath, {
      categoria: "logs",
      id: "supervisor-log",
      descricao: "heartbeat do supervisor: checks e ações de cada tick",
      criadoPor: "opencorp",
    });
    await this.registros.anexarEvento(wsPath, "logs", "supervisor-log", {
      ts: em,
      por: "supervisor",
      evento: "tick",
      resumo: `falhas ${checks.execucoes_falhas} · approvals ${checks.approvals_pendentes} (${checks.approvals_antigas} antigas) · budget80 ${checks.budget_80} · tarefas ${checks.tarefas_delegadas} — ordens ${ordens.length}, recusas ${recusas.length}, escalações ${escalacoes.length}, ignorados ${ignorados.length}, locks liberados ${locks_liberados.length}, zombies ${zombies_reconciliados.length}`,
      checks,
      ordens,
      recusas,
      escalacoes,
      ignorados,
      locks_liberados,
      zombies_reconciliados,
    });
    await this.gravarEstado(wsPath, { ultimo_tick: em, chaves_tratadas: [...tratadas] });
    const pid = await lerPidfile(wsPath);
    if (pid) {
      await gravarPidfile(wsPath, { ...pid, ultimo_tick: em });
    }
    return resultado;
  }

  private async healingCfg(wsPath: string): Promise<{ enabled: boolean; max_retries: number }> {
    const enabled = await this.store.get("healing.enabled", { workspaceDir: wsPath });
    const retries = await this.store.get("healing.max_retries", { workspaceDir: wsPath });
    return { enabled: Boolean(enabled.valor), max_retries: Math.max(0, Number(retries.valor) || 0) };
  }

  private async contextoFalha(
    wsPath: string,
    execId: string,
  ): Promise<{ ordem: string; transcriptTrecho: string; logTrecho: string }> {
    let transcript = "";
    try {
      transcript = (await this.registros.obter(wsPath, "chats", execId)).conteudo ?? "";
    } catch {
      transcript = "";
    }
    let logTrecho = "";
    const logPath = join(wsPath, "logs", `${execId}.log`);
    if (existsSync(logPath)) {
      try {
        logTrecho = (await readFile(logPath, "utf8")).slice(-1500);
      } catch {
        logTrecho = "";
      }
    }
    const ordem = [
      "TAREFA DE CORREÇÃO (self-healing): a execução registrada abaixo falhou.",
      "Corrija a CAUSA RAIZ do problema (não apenas o sintoma) e REGISTRE o resultado em .opencorp/registries/logs/.",
      `Referência da execução original: .opencorp/registries/execucoes/${execId}/`,
      "",
      "=== TRANSCRIPT DA EXECUÇÃO FALHA (.opencorp/registries/chats) ===",
      transcript ? transcript.slice(-2000) : "(sem transcript)",
      "",
      "=== TRECHO FINAL DO LOG (logs) ===",
      logTrecho || "(sem log capturado)",
    ].join("\n");
    return { ordem, transcriptTrecho: transcript.slice(-2000), logTrecho };
  }

  private async maxOrdensPorTick(wsPath: string): Promise<number> {
    const r = await this.store.get("supervisor.max_orders_per_tick", { workspaceDir: wsPath });
    return Math.max(1, Number(r.valor) || 3);
  }

  private dormir(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.despertar = null;
        resolve();
      }, ms);
      this.despertar = () => {
        clearTimeout(t);
        this.despertar = null;
        resolve();
      };
    });
  }

  async rodarLoop(wsPath: string, intervaloMinutes: number): Promise<void> {
    const intervaloMs = Math.max(1, intervaloMinutes) * 60000;
    let primeira = true;
    while (!this.sinalParada) {
      try {
        await this.tick(wsPath);
        if (primeira) {
          console.log(`[supervisor] primeiro tick concluído — próximos a cada ${intervaloMinutes} min`);
          primeira = false;
        }
      } catch (erro) {
        console.error(`[supervisor] erro no tick (continuando): ${msg(erro)}`);
        try {
          await this.registros.eventoAuditoria(wsPath, {
            por: "supervisor",
            evento: "erro_tick",
            resumo: msg(erro),
          });
        } catch {
          // auditoria é melhor-esforço; o loop não pode cair
        }
      }
      if (this.sinalParada) break;
      await this.dormir(intervaloMs);
    }
  }
}

