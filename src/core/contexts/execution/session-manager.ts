import { existsSync, readFileSync } from "node:fs";
import { readRunEngineConfig } from "../../config/run-engine-config.js";
import { classifyFailure, decideFallback, formatFallbackAudit } from "../../models/fallback-router.js";
import { explicitEngineOfModel, modelIdForEngine, providerOfModel } from "../../models/catalog.js";
import { ModelIncompatibleError } from "../../engines/errors.js";
import { KNOWN_SECRET_ENV_VARS, redactSecrets } from "../../credentials/credentials-store.js";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { freemem } from "node:os";
import { execa } from "execa";
import { tokenBucketGlobal } from "../../engines/token-bucket-limiter.js";
import type { Agente } from "../../../schemas/agent.js";
import { AgentStore } from "../agents/agent-store.js";
import { SessionError } from "../../shared/errors.js";
import { OpenCodeBridge } from "./opencode-bridge.js";
import { RegistryStore, type MetaRegistro } from "../storage/registry-store.js";
import { eventBus } from "../../shared/event-bus.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import { ApprovalsStore } from "../platform/approvals-store.js";
import { BudgetManager } from "../platform/budget-manager.js";
import { avaliar, casaPadrao } from "../platform/security-guard.js";
import { parseSecurityPolicyTexto } from "../../../schemas/security-policy.js";
import { gatilhoSchema, type Gatilho } from "../../../schemas/gatilho.js";
import { mkdirRecursive } from "../../../utils/fs-safe.js";
import { opencorpHome, resolvePath } from "../../../utils/paths.js";
import { SettingsStore } from "../workspace/settings-store.js";
import { engineRegistry } from "../../engines/index.js";
import { CapabilitiesPara } from "../../engines/capabilities.js";
import { EngineAccountStore } from "../../engines/engine-account-store.js";
import {
  resolverCadeiaModelosAgente,
  proximoModeloDaCadeia,
  ehModeloGratuito,
} from "../agents/model-resolver.js";

import {
  sanitizarTranscript,
  limparAnsi,
  extrairDeltaTexto,
  normalizarQuebrasDeLinha,
  extrairResumoErro,
} from "../../domain/session/transcript-parser.js";

export {
  ehModeloGratuito,
  sanitizarTranscript,
  limparAnsi,
  extrairDeltaTexto,
  normalizarQuebrasDeLinha,
  extrairResumoErro,
};

export type StatusExecucao = "executando" | "concluido" | "falhou" | "cancelado" | "hitl_pendente";

export interface OpcoesRun {
  agente: string;
  ordem?: string;
  file?: string;
  model?: string;
  /** Motor de execução explicitamente solicitado para esta ordem (sobrescreve frontmatter e sistema) */
  engine?: string;
  /** Alias para engine */
  harness?: string;
  session?: string;
  title?: string;
  workspaceId?: string;
  workspaceDir?: string;
  pularGuard?: boolean;
  tags?: string[];
  referencias?: string[];
  tipo?: string;
  execId?: string;
  /** teto de execução em ms — watchdog HITL-aware mata o opencode (SIGTERM→SIGKILL) e finaliza "falhou" */
  timeoutMs?: number;
  /** timeout de inatividade em ms (padrão 60s) — mata o processo se o modelo não gerar tokens */
  inatividadeMs?: number;
  /** intervalo de checagem do watchdog em ms (padrão 30s) — knob de teste */
  watchdogIntervalMs?: number;
  /** graça SIGTERM→SIGKILL do watchdog em ms (padrão 5s) — knob de teste */
  watchdogGracaMs?: number;
  /** uso interno (retry de rotação de modelo e motor): marca este run como retry de outra execução */
  retryDe?: {
    de_modelo: string;
    de_harness?: string;
    de_exec: string;
    tentativas?: number;
    modelosTentados?: string[];
    motoresTentados?: string[];
  };
  /**
   * Gatilho da execução (PLANO-UNIFICACAO): quem chamou e por quê — cron, menção, nó de flow,
   * passo de team, turno de reunião, evento ou manual. Vai para extras, ledger (corp.db) e eventos.
   */
  gatilho?: Gatilho;
  /**
   * F1-T02 — linhagem agnóstica de sessão (aditivo; vai para extras do registro):
   * - session_from_ancestral: execução ancestral da qual esta deriva (continuar ou duplicar);
   * - fork_de: esta execução duplica a sessão indicada (snapshot → nova sessão);
   * - reidratada_de: nova sessão com o transcript da indicada, sem continuidade nativa;
   * - continuada_de: reaproveitou a sessão indicada no motor (continuidade nativa).
   */
  session_from_ancestral?: string;
  fork_de?: string;
  reidratada_de?: string;
  continuada_de?: string;
}

export interface ResultadoRun extends RegistroExecucao {
  captura: string;
  custo_usd: number | null;
}

/**
 * F1-T02 — snapshot agnóstico de sessão para duplicar/reidratar.
 * Formato: transcript (chats/<id> → fallback logs/<id>.log → "") + contexto
 * (agente/modelo/ordem/harness/status) + config (extras da origem sem pid).
 * Persistido no mirror: evento `snapshot`/`duplicada` no journal da nova
 * execução + marcadores fork_de/reidratada_de nos extras (meta.json).
 */
export interface SnapshotSessao {
  de: string;
  em: string;
  agente: string;
  modelo: string;
  ordem: string;
  harness: string;
  status_origem: StatusExecucao;
  transcript: string;
  fonte_transcript: "chats" | "log" | "vazio";
  log_path: string | null;
  extras_origem: Record<string, unknown>;
}

export interface OpcoesContinuarDuplicar {
  prompt?: string;
  model?: string;
  title?: string;
  tags?: string[];
  workspaceId?: string;
  workspaceDir?: string;
  timeoutMs?: number;
}

export interface ResultadoContinuar extends ResultadoRun {
  continuada_de: string;
  continuidade_nativa: boolean;
  aviso?: string;
}

export interface ResultadoDuplicar extends ResultadoRun {
  fork_de: string;
  snapshot: SnapshotSessao;
}

/** Código de aviso quando o motor não continua sessões (fallback reidratado honesto). */
export const AVISO_SEM_CONTINUIDADE_NATIVA = "sem-continuidade-nativa";

/** Teto do transcript embutido no prompt reidratado (evita ordens gigantes). */
export const LIMITE_TRANSCRIPT_REIDRATADO = 4000;

export interface RegistroExecucao {
  id: string;
  agente: string;
  modelo: string;
  ordem: string;
  inicio: string;
  fim: string | null;
  status: StatusExecucao;
  exit_code: number | null;
  duracao_ms: number | null;
  pid: number | null;
  log: string;
  gatilho?: Gatilho;
}

export interface ResumoExecucao {
  id: string;
  agente: string;
  modelo: string;
  status: StatusExecucao;
  inicio: string;
  duracao_ms: number | null;
  exit_code: number | null;
  gatilho?: Gatilho;
}

function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

export function gerarIdExecucao(prefixo = "exec"): string {
  return gerarId(prefixo);
}

function gerarId(prefixo: string): string {
  const agora = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const ts = `${agora.getFullYear()}${p2(agora.getMonth() + 1)}${p2(agora.getDate())}-${p2(agora.getHours())}${p2(agora.getMinutes())}${p2(agora.getSeconds())}`;
  return `${prefixo}-${ts}-${randomUUID().slice(0, 4)}`;
}

export const PADRAO_ERRO_MODELO =
  /usage limit|Cannot connect to API|AI_APICallError|rate limit|free-models-per-day|quota|429|overloaded|resource exhausted|unavailable for free|model not found|not available|Provider not found|from --model flag|insufficient balance|payment_required|402|credit balance|temporarily unavailable|Provider returned error|requires more credits|can only afford|billing_not_active|exceeded.*quota|insufficient.?credits|add (?:more )?credits|exceed.*credits|in-flight requests|database is locked|sqlite_busy|nenhuma resposta do modelo|ETIMEDOUT|ECONNRESET|socket hang up|504 Gateway Timeout|502 Bad Gateway|503 Service Unavailable|deadline exceeded|connection refused|econnrefused|fetch failed|aborterror/i;

export const PADRAO_ERRO_CREDITOS =
  /requires more credits|can only afford|insufficient balance|payment_required|402|credit balance|billing_not_active|exceeded.*quota|insufficient.?credits|add (?:more )?credits|exceed.*credits/i;

export const MODELOS_ROTACAO_PADRAO = [
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/thinkingmachines/inkling:free",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/qwen/qwen3.8-27b:free",
  "openrouter/cohere/north-mini-code:free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
];

const TETO_RUN_PADRAO_MIN = 20;
const ENV_TETO_RUN_MIN = "OPENCORP_RUN_TIMEOUT_MIN";

export async function tetoRunPadraoMs(homeDir?: string): Promise<number | undefined> {
  const env = process.env[ENV_TETO_RUN_MIN];
  if (env !== undefined && env.trim() !== "") {
    const n = Number(env.trim());
    if (Number.isFinite(n)) {
      if (n <= 0) return undefined;
      return Math.round(n * 60_000);
    }
  }
  try {
    const { settings } = await new SettingsStore({ homeDir }).resolve();
    const runs = (settings as unknown as { runs?: { timeout_min?: number } }).runs;
    if (typeof runs?.timeout_min === "number" && runs.timeout_min > 0) {
      return Math.round(runs.timeout_min * 60_000);
    }
  } catch {
    /* settings indisponível — cai no padrão */
  }
  return TETO_RUN_PADRAO_MIN * 60_000;
}

export function proximoModeloRotacao(lista: string[], modeloFalho: string): string | null {
  if (!lista || lista.length === 0) return null;
  const idx = lista.findIndex((m) => m.trim().toLowerCase() === modeloFalho.trim().toLowerCase());
  if (idx < 0) {
    return lista[0] !== modeloFalho ? lista[0]! : null;
  }
  const prox = lista[(idx + 1) % lista.length]!;
  return prox !== modeloFalho ? prox : null;
}

export async function obterListaRotacaoCompleta(
  agenteStore?: AgentStore,
  wsPath?: string,
  agenteId?: string,
  _homeDir?: string,
): Promise<string[]> {
  let ag: any = undefined;
  if (agenteStore && wsPath && agenteId) {
    try {
      ag = await agenteStore.carregar(wsPath, agenteId);
    } catch {}
  }

  try {
    const res = resolverCadeiaModelosAgente({
      agente: ag?.frontmatter,
      wsPath: wsPath || "",
    });
    if (res.herdarWorkspace && res.camada2Workspace.length === 0) {
      return [...new Set([...res.cadeia, ...MODELOS_ROTACAO_PADRAO])];
    }
    return res.cadeia;
  } catch {
    return MODELOS_ROTACAO_PADRAO;
  }
}

/**
 * Lê defensivamente as últimas 30 linhas do log interno do OpenCode
 * para extrair erros reais ocultados por UnknownError ou ref (ex: err_8ddb12a9).
 */
export function lerUltimasLinhasLogOpencode(homeDir: string, wsId: string): string {
  try {
    const logPath = join(homeDir, ".opencorp", "opencode-data", "workspaces", wsId, "opencode", "log", "opencode.log");
    if (!existsSync(logPath)) return "";
    const content = readFileSync(logPath, "utf8");
    const lines = content.trim().split("\n");
    return lines.slice(-30).join("\n");
  } catch {
    return "";
  }
}


export const MODELOS_ROTACAO_POR_HARNESS: Record<string, string[]> = {
  antigravity: [
    "google/gemini-3.8-flash-high",
    "google/gemini-3.7-flash-high",
    "google/gemini-3.1-pro-high",
    "claude-sonnet-4-6",
  ],
  copilot: [
    "github/gpt-4o",
    "github/claude-3.5-sonnet",
    "github/gpt-4o-mini",
  ],
  opencode: [
    "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    "openrouter/thinkingmachines/inkling:free",
    "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    "openrouter/qwen/qwen3.8-27b:free",
    "openrouter/cohere/north-mini-code:free",
  ],
  codex: [
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.6-sol",
  ],
};

export const HARNESS_FALLBACK_PADRAO = [
  "antigravity",
  "copilot",
  "opencode",
];

export async function obterCadeiaHarness(
  agenteStore?: AgentStore,
  wsPath?: string,
  agenteId?: string,
  homeDir?: string,
): Promise<string[]> {
  const cadeia: string[] = [];
  if (agenteStore && wsPath && agenteId) {
    try {
      const ag = await agenteStore.carregar(wsPath, agenteId);
      const hPrimary = ag.frontmatter.harness || (ag.frontmatter as any).engine;
      if (hPrimary) cadeia.push(hPrimary);
      const hFallbacks = ag.frontmatter.harness_fallback || (ag.frontmatter as any).engine_fallback;
      if (Array.isArray(hFallbacks)) {
        for (const h of hFallbacks) {
          const s = String(h).trim();
          if (s && !cadeia.includes(s)) cadeia.push(s);
        }
      }
    } catch {}
  }

  // Motor padrão e cadeia explícita (settings.run_engine; runner.json legado como fallback)
  try {
    const cfg = readRunEngineConfig(homeDir || opencorpHome(), { emitNotice: false });
    for (const h of [cfg.engine, ...cfg.fallbackEngines]) {
      if (h && !cadeia.includes(h)) cadeia.push(h);
    }
  } catch {}

  for (const h of HARNESS_FALLBACK_PADRAO) {
    if (!cadeia.includes(h)) cadeia.push(h);
  }
  return cadeia;
}

export async function obterListaRotacaoPorHarness(
  harness: string,
  agenteStore?: AgentStore,
  wsPath?: string,
  agenteId?: string,
  _homeDir?: string,
): Promise<string[]> {
  const lista: string[] = [];
  if (agenteStore && wsPath && agenteId) {
    try {
      const ag = await agenteStore.carregar(wsPath, agenteId);
      const rot = ag.frontmatter.rotation || (ag.frontmatter as any).model_fallback;
      if (Array.isArray(rot)) {
        for (const m of rot) {
          const s = String(m).trim();
          if (s && !lista.includes(s)) lista.push(s);
        }
      }
    } catch {}
  }

  // Rotação declarada pelo próprio motor (EngineDriver.fallbackModels) tem prioridade sobre a tabela legada.
  let doMotor: string[] | undefined;
  try {
    doMotor = engineRegistry.resolveDriver(harness).fallbackModels;
  } catch {}
  const padraoHarness = doMotor ?? MODELOS_ROTACAO_POR_HARNESS[harness] ?? [];
  for (const m of padraoHarness) {
    const s = String(m).trim();
    if (s && !lista.includes(s)) lista.push(s);
  }

  return lista;
}

function sufixarRetry(origem: string, modelo: string): string {
  const sufixo = ` · retry:${modelo}`.slice(0, 200);
  return origem.slice(0, Math.max(0, 200 - sufixo.length)) + sufixo;
}

export interface OpcoesWatchdogRun {
  tetoMs: number;
  inatividadeMs?: number;
  pid?: number | null;
  intervaloMs?: number;
  gracaKillMs?: number;
  agora?: () => number;
  dormir?: (ms: number) => Promise<void>;
  obterStatus?: () => Promise<string | undefined>;
  matar?: (sinal: "SIGTERM" | "SIGKILL") => void;
  aoEstourar?: (decorridoMs: number, motivo?: string) => void | Promise<void>;
}

export class WatchdogRun {
  private readonly opcoes: OpcoesWatchdogRun;
  private readonly intervalo: number;
  private inicioEfetivo: number;
  private ultimoChunkAt: number;
  private pausaDesde: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private disparou = false;
  private morteEmAndamento: Promise<void> | null = null;
  private motivoEstouro = "";

  constructor(opcoes: OpcoesWatchdogRun) {
    this.opcoes = opcoes;
    this.intervalo = Math.max(1, opcoes.intervaloMs ?? 5_000);
    this.inicioEfetivo = opcoes.agora ? opcoes.agora() : Date.now();
    this.ultimoChunkAt = this.inicioEfetivo;
  }

  get estourou(): boolean {
    return this.disparou;
  }

  get motivo(): string {
    return this.motivoEstouro;
  }

  /** Promise da sequência SIGTERM→espera→SIGKILL→aoEstourar (null se ainda não disparou). */
  get quandoMorto(): Promise<void> | null {
    return this.morteEmAndamento;
  }

  registrarAtividade(): void {
    const agoraMs = this.opcoes.agora ? this.opcoes.agora() : Date.now();
    this.ultimoChunkAt = agoraMs;
  }

  iniciar(): void {
    if (this.timer || this.disparou) return;
    this.timer = setInterval(() => {
      void this.verificar().catch(() => undefined);
    }, this.intervalo);
    this.timer.unref?.();
  }

  parar(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Um passo de verificação; @returns true se o teto ou inatividade estourou e a sequência de kill foi acionada. */
  async verificar(): Promise<boolean> {
    if (this.disparou) return false;
    const agoraMs = this.opcoes.agora ? this.opcoes.agora() : Date.now();
    let status: string | undefined;
    try {
      status = await this.opcoes.obterStatus?.();
    } catch {
      status = undefined;
    }
    if (status === "hitl_pendente") {
      this.pausaDesde ??= agoraMs;
      return false;
    }
    if (this.pausaDesde !== null) {
      const delta = agoraMs - this.pausaDesde;
      this.inicioEfetivo += delta;
      this.ultimoChunkAt += delta;
      this.pausaDesde = null;
    }
    if (status !== undefined && status !== "executando") {
      this.parar();
      return false;
    }

    // 1. Checagem de inatividade (nenhuma resposta por inatividadeMs, padrão 60s)
    const inatividadeMs = typeof this.opcoes.inatividadeMs === "number" ? this.opcoes.inatividadeMs : 60_000;
    if (inatividadeMs > 0 && agoraMs - this.ultimoChunkAt >= inatividadeMs) {
      this.disparou = true;
      this.motivoEstouro = `inatividade: nenhuma resposta do modelo por ${Math.round(inatividadeMs / 1000)}s (modelo travado)`;
      this.parar();
      this.morteEmAndamento = this.executarMorte(agoraMs - this.inicioEfetivo, this.motivoEstouro);
      await this.morteEmAndamento;
      return true;
    }

    // 2. Checagem de teto total de tempo
    if (this.opcoes.tetoMs > 0 && agoraMs - this.inicioEfetivo >= this.opcoes.tetoMs) {
      this.disparou = true;
      this.motivoEstouro = `timeout total de ${Math.round(this.opcoes.tetoMs / 1000)}s excedido`;
      this.parar();
      this.morteEmAndamento = this.executarMorte(agoraMs - this.inicioEfetivo, this.motivoEstouro);
      await this.morteEmAndamento;
      return true;
    }

    return false;
  }

  private async executarMorte(decorridoMs: number, motivo?: string): Promise<void> {
    const matar =
      this.opcoes.matar ??
      ((sinal: "SIGTERM" | "SIGKILL") => {
        const pid = this.opcoes.pid;
        if (!pid) return;
        try {
          process.kill(pid, sinal);
        } catch {
          /* processo já morreu */
        }
      });
    matar("SIGTERM");
    const graca = Math.max(0, this.opcoes.gracaKillMs ?? 5_000);
    const dormir = this.opcoes.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    if (graca > 0) await dormir(graca);
    matar("SIGKILL");
    await this.opcoes.aoEstourar?.(decorridoMs, motivo ?? this.motivoEstouro);
  }
}

/**
 * PIDs que podem receber sinal de cancelamento. Fluxos rodam dentro do próprio
 * OpenCorp e registram `pid: process.pid`; sinalizar esse pid (ou o pai) mataria
 * o servidor/daemon inteiro. Nesses casos o cancelamento é cooperativo (status no meta).
 */
export function pidSinalizavel(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid !== process.pid && pid !== process.ppid;
}

export class SessionManager {
  private readonly homeDir: string;
  private readonly workspaces: WorkspaceManager;
  private readonly agentes: AgentStore;
  private readonly registros = new RegistryStore();
  private readonly approvals = new ApprovalsStore();
  private readonly bridge = new OpenCodeBridge();
  private readonly processosAtivos = new Map<string, ReturnType<typeof execa>>();

  constructor(opts: { homeDir?: string; cwd?: string; templatesDir?: string } = {}) {
    this.homeDir = opts.homeDir ?? opencorpHome();
    this.workspaces = new WorkspaceManager(opts);
    this.agentes = new AgentStore({ templatesDir: opts.templatesDir });
  }

  async cancelar(wsPath: string, execId: string): Promise<boolean> {
    const child = this.processosAtivos.get(execId);
    let matou = false;
    if (child) {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch {}
        }, 2000);
        matou = true;
      } catch {}
      this.processosAtivos.delete(execId);
    } else {
      try {
        const meta = await this.registros.lerMeta(wsPath, "execucoes", execId);
        const pid = (meta.extras as any)?.pid;
        if (pidSinalizavel(pid)) {
          try {
            process.kill(pid, "SIGTERM");
            setTimeout(() => {
              try { process.kill(pid, "SIGKILL"); } catch {}
            }, 2000);
            matou = true;
          } catch {}
        }
      } catch {}
    }

    // Persiste status "cancelado" no registry (meta.json)
    try {
      const meta = await this.registros.lerMeta(wsPath, "execucoes", execId);
      const extras = (meta.extras ?? {}) as Record<string, unknown>;
      const inicio = Date.parse(meta.criado_em);
      const fim = new Date().toISOString();
      const duracao = Number.isFinite(inicio) ? Date.now() - inicio : 0;
      meta.extras = {
        ...extras,
        status: "cancelado",
        fim,
        duracao_ms: (extras.duracao_ms as number | null) ?? duracao,
        pid: null,
      };
      await this.registros.salvarMeta(wsPath, "execucoes", execId, meta);
    } catch {}

    try {
      this.registros.corpDb(wsPath).atualizarStatusExecucao(execId, "cancelado");
    } catch {}

    return matou;
  }

  private carregarPolicy(wsPath: string) {
    const path = join(wsPath, ".opencorp", "security_policy.json");
    if (!existsSync(path)) {
      return parseSecurityPolicyTexto("{}", path);
    }
    return parseSecurityPolicyTexto(readFileSync(path, "utf8"), path);
  }

  /**
   * Grava/atualiza a execução no ledger unificado (corp.db `execucoes`) — a leitura
   * cross-motor do PLANO-UNIFICACAO. Falha de ledger NUNCA quebra a execução
   * (mesma tolerância do job_runs do scheduler).
   */
  private registrarNoLedger(wsPath: string, registro: RegistroExecucao, custoUsd: number | null, erro?: string | null): void {
    try {
      this.registros.corpDb(wsPath).upsertExecucao({
        id: registro.id,
        agente: registro.agente,
        modelo: registro.modelo,
        gatilho_tipo: registro.gatilho?.tipo ?? "manual",
        gatilho_origem: registro.gatilho?.origem ?? "",
        status: registro.status,
        inicio: registro.inicio,
        fim: registro.fim,
        duracao_ms: registro.duracao_ms,
        custo_usd: custoUsd,
        exit_code: registro.exit_code,
        erro: erro ?? (registro as any).erro ?? null,
      });
    } catch {
      /* ledger é índice; os registros (MD/JSON) são a fonte documental */
    }
  }

  async workspaceDe(workspaceId?: string) {
    return this.workspaces.resolver(workspaceId);
  }

  async rodar(opcoes: OpcoesRun): Promise<ResultadoRun> {
    let ws: { path: string; id: string; existe: boolean };
    if (opcoes.workspaceDir) {
      const dir = resolvePath(opcoes.workspaceDir);
      if (!existsSync(join(dir, ".opencorp"))) {
        throw new SessionError(`workspace do subcorp inválido: ${dir} não contém .opencorp/`);
      }
      ws = { path: dir, id: basename(dir), existe: true };
    } else {
      const info = await this.workspaces.resolver(opcoes.workspaceId);
      if (!info.existe) {
        throw new SessionError(`a pasta do workspace "${info.id}" não existe (${info.path})`);
      }
      ws = info;
    }
    const ag = await this.agentes.carregar(ws.path, opcoes.agente);
    // Etapa 5 — guard central: agente desativado não roda em NENHUM gatilho
    // (API, hooks, nós de fluxo fanout/review/debate, reuniões, menções, scheduler, CLI).
    // O erro é logado pelo chamador (nó do fluxo marca "falhou", hook registra, team escreve na task).
    if (ag.frontmatter.ativo === false) {
      throw new SessionError(
        `agente '${opcoes.agente}' está desativado — ative no painel de agentes`,
      );
    }
    let ordem = opcoes.ordem ?? "";
    if (opcoes.file) {
      try {
        ordem = (await readFile(opcoes.file, "utf8")).trim();
      } catch (erro) {
        throw new SessionError(`não foi possível ler --file "${opcoes.file}": ${msg(erro)}`);
      }
    }
    if (ordem.trim().length === 0) {
      throw new SessionError("ordem vazia — informe a instrução (ou use --file)");
    }
    let modelo = opcoes.model ?? ag.frontmatter.model;
    if (!modelo || modelo.trim() === "" || modelo === "padrao" || modelo === "default" || modelo === "sistema") {
      try {
        const res = resolverCadeiaModelosAgente({
          agente: ag.frontmatter,
          wsPath: ws.path,
          wsId: ws.id,
          modeloSolicitado: opcoes.model,
        });
        modelo = res.modeloPrimario;
      } catch (err: any) {
        throw new SessionError(err?.message || `Não foi possível resolver modelo para o agente "${ag.frontmatter.id}" no workspace "${ws.id}".`);
      }
    }

    const policy = this.carregarPolicy(ws.path);
    const acessoTotalGlobal = (policy as any).global_full_access === true || policy.level === "permissive";
    if (!opcoes.pularGuard && !acessoTotalGlobal) {
      const pre = avaliar(ordem, policy, ag.frontmatter.permissions);
      if (pre.acao === "bloqueado") {
        const idBloqueio = gerarId("exec");
        await this.registros.garantirCategorias(ws.path);
        await this.registrarNoLedger(ws.path, {
          id: idBloqueio,
          agente: ag.frontmatter.id,
          modelo,
          ordem,
          inicio: new Date().toISOString(),
          fim: new Date().toISOString(),
          status: "falhou",
          exit_code: 3,
          duracao_ms: 0,
          pid: null,
          log: "",
          gatilho: opcoes.gatilho,
        }, null);
        await this.registros.criar(ws.path, {
          categoria: "execucoes",
          id: idBloqueio,
          descricao: `Ordem: ${ordem.slice(0, 160)}`,
          criadoPor: ag.frontmatter.id,
          tags: ["sessao", "bloqueada"],
          eventoInicial: {
            evento: "bloqueado",
            resumo: `SecurityGuard: ${pre.motivo}`,
          },
          extras: {
            status: "falhou",
            modelo,
            ordem,
            pid: null,
            fim: new Date().toISOString(),
            exit_code: 3,
            duracao_ms: 0,
            log: "",
          },
        });
        await this.registros.eventoAuditoria(ws.path, {
          por: ag.frontmatter.id,
          evento: "bloqueado_pre_voo",
          resumo: pre.motivo,
          padrao: pre.padrao ?? "",
          ordem: ordem.slice(0, 160),
        });
        throw new SessionError(`bloqueado pelo SecurityGuard: ${pre.motivo}`, { exitCode: 3 });
      }
      if (pre.acao === "hitl") {
        const idHitl = gerarId("exec");
        await this.registros.garantirCategorias(ws.path);
        await this.registrarNoLedger(ws.path, {
          id: idHitl,
          agente: ag.frontmatter.id,
          modelo,
          ordem,
          inicio: new Date().toISOString(),
          fim: null,
          status: "hitl_pendente",
          exit_code: null,
          duracao_ms: null,
          pid: null,
          log: "",
          gatilho: opcoes.gatilho,
        }, null);
        await this.registros.criar(ws.path, {
          categoria: "execucoes",
          id: idHitl,
          descricao: `Ordem: ${ordem.slice(0, 160)}`,
          criadoPor: ag.frontmatter.id,
          tags: ["sessao", "hitl"],
          eventoInicial: {
            evento: "hitl_pendente",
            resumo: `SecurityGuard: ${pre.motivo}`,
          },
          extras: {
            status: "hitl_pendente",
            modelo,
            ordem,
            pid: null,
            fim: null,
            exit_code: null,
            duracao_ms: null,
            log: "",
          },
        });
        const pendencia = await this.approvals.criar(ws.path, {
          ordem,
          agente: ag.frontmatter.id,
          modelo,
          padrao: pre.padrao ?? "",
          origem: "pre-voo",
          motivo_guard: pre.motivo,
          workspace_id: ws.id,
          workspace_path: ws.path,
          exec_id: idHitl,
        });
        // Notificação + evento para o Secretário/Notificações aparecerem imediatamente
        try {
          const { NotificationStore } = await import("../platform/notification-store.js");
          const notifs = new NotificationStore();
          await notifs.adicionar(ws.path, {
            titulo: `Permissão necessária: ${ag.frontmatter.id}`,
            corpo: `${ordem.slice(0, 120)} — ${pre.motivo} (toque em Notificações para aprovar)`,
            tipo: "aviso",
            origem: "hitl",
          });
        } catch {}
        try { eventBus.emit("secretario.mensagem", { sessao_id: pendencia.id, fase: "hitl", workspace: ws.id }); } catch {}
        try { eventBus.emit("notificacao.nova", { workspace: ws.id }); } catch {}
        throw new SessionError(
          `HITL: a ordem casa com "${pre.padrao}" e aguarda aprovação humana — pendência ${pendencia.id} (opencorp approvals list)`,
          { exitCode: 5 },
        );
      }
    }

    const budget = new BudgetManager({ homeDir: this.homeDir });
    const orcamento = await budget.podeExecutar(ws.path, ag.frontmatter.id);
    if (!orcamento.ok) {
      throw new SessionError(`recusada pelo BudgetManager: ${orcamento.motivo}`, { exitCode: 4 });
    }

    await this.registros.garantirCategorias(ws.path);

    const id = opcoes.execId ?? gerarId("exec");
    const logRelativo = `logs/${id}.log`;
    const logPath = join(ws.path, logRelativo);
    await mkdirRecursive(join(ws.path, "logs"));
    const inicio = new Date();
    const registro: RegistroExecucao = {
      id,
      agente: ag.frontmatter.id,
      modelo,
      ordem,
      inicio: inicio.toISOString(),
      fim: null,
      status: "executando",
      exit_code: null,
      duracao_ms: null,
      pid: null,
      log: logRelativo,
      gatilho: opcoes.gatilho,
    };

    await this.registros.criar(ws.path, {
      categoria: "execucoes",
      id,
      descricao: `Ordem: ${ordem.slice(0, 160)}`,
      criadoPor: registro.agente,
      tags: ["sessao", ...(opcoes.tags ?? []), ...(opcoes.retryDe ? ["retry"] : [])],
      referencias: opcoes.referencias,
      eventoInicial: {
        evento: "iniciado",
        resumo: `ordem: ${ordem.slice(0, 160)} · modelo: ${modelo}${opcoes.gatilho ? ` · gatilho: ${opcoes.gatilho.tipo}:${opcoes.gatilho.origem}` : ""}`,
      },
      extras: {
        status: "executando",
        modelo,
        ordem,
        pid: null,
        fim: null,
        exit_code: null,
        duracao_ms: null,
        log: logRelativo,
        ...(opcoes.tipo ? { tipo: opcoes.tipo } : {}),
        ...(opcoes.gatilho ? { gatilho: opcoes.gatilho } : {}),
        ...(opcoes.retryDe ? { retry: opcoes.retryDe } : {}),
        // F1-T02: linhagem de sessão (aditivo; continuar/duplicar).
        ...(opcoes.session ? { session: opcoes.session } : {}),
        ...(opcoes.session_from_ancestral ? { session_from_ancestral: opcoes.session_from_ancestral } : {}),
        ...(opcoes.fork_de ? { fork_de: opcoes.fork_de } : {}),
        ...(opcoes.reidratada_de ? { reidratada_de: opcoes.reidratada_de } : {}),
        ...(opcoes.continuada_de ? { continuada_de: opcoes.continuada_de } : {}),
      },
    });
    this.registrarNoLedger(ws.path, registro, null);
    // evento unificado da primitiva Execução (PLANO-UNIFICACAO Etapa 5):
    // qualquer consumidor casa "execução iniciada por gatilho X" sem conhecer o motor
    eventBus.emit("exec.iniciada", {
      exec_id: id,
      agente: registro.agente,
      modelo,
      workspace: ws.id,
      ...(opcoes.gatilho ? { gatilho: opcoes.gatilho } : { gatilho: { tipo: "manual", origem: "" } }),
    });
    eventBus.emit("sessao-inicio", {
      exec_id: id,
      agente: registro.agente,
      modelo,
      ...(opcoes.gatilho ? { gatilho: opcoes.gatilho } : {}),
    });

    await this.bridge.sincronizarAgente(ws.path, ag.frontmatter, ag.corpo);

    // Motor padrão das execuções: settings.run_engine.default (runner.json legado como fallback).
    const runnerConfigEngine = readRunEngineConfig(this.homeDir).engine;

    // Motor explícito (execução ou agente) nunca é trocado pelo prefixo do
    // modelo (D1). O prefixo só escolhe o motor quando não há motor explícito
    // (compatibilidade com o formato legado `codex/<modelo>`), sobre o padrão.
    const motorExplicito = opcoes.engine || opcoes.harness || ag.frontmatter.harness || (ag.frontmatter as any).engine;
    let harnessEscolhido = motorExplicito || runnerConfigEngine || "opencode";
    const motorDoPrefixo = explicitEngineOfModel(modelo);
    if (motorDoPrefixo) {
      const explicitoCanonico = motorExplicito ? engineRegistry.resolveDriver(motorExplicito).id : undefined;
      if (explicitoCanonico && explicitoCanonico !== motorDoPrefixo) {
        const falha = new ModelIncompatibleError(explicitoCanonico, modelo, {
          details: { reason: `o prefixo do modelo nomeia o motor "${motorDoPrefixo}"; o motor explícito não é trocado` },
        }).message;
        (registro as any).erro = falha;
        await this.finalizar(ws, registro, ag.frontmatter, "falhou", null, Date.now() - inicio.getTime(), falha, "", null);
        throw new SessionError(falha);
      }
      harnessEscolhido = motorDoPrefixo;
    }
    const modeloEfetivo = modelIdForEngine(modelo);

    const driver = engineRegistry.resolveDriver(harnessEscolhido);
    // Motor que efetivamente executa: base da rotação de conta/modelo no retry.
    (registro as any).motor = driver.id;
    // F1-T02: marca o harness efetivo nos extras (base para continuar/duplicar;
    // best-effort — quando ausente, continuar/duplicar inferem do modelo).
    try {
      const metaHarness = await this.registros.lerMeta(ws.path, "execucoes", id);
      metaHarness.extras = { ...(metaHarness.extras ?? {}), harness: driver.id };
      await this.registros.salvarMeta(ws.path, "execucoes", id, metaHarness);
    } catch {
      /* marca best-effort */
    }
    let runnerBin: string;
    let args: string[];
    let execEnv: Record<string, string>;
    let execCwd = ws.path;

    let prep: Awaited<ReturnType<typeof driver.prepareExecution>>;
    try {
      prep = await driver.prepareExecution({
        workspaceId: ws.id,
        workspacePath: ws.path,
        sessionId: opcoes.session ?? id,
        agentId: ag.frontmatter.id,
        model: modeloEfetivo,
        prompt: ordem,
        homeDir: this.homeDir,
        title: opcoes.title,
        auto: true,
      });
    } catch (erro) {
      // Ex.: CredentialScopeError — a credencial não é autorizada para este
      // workspace. Falha antes do spawn, sem processo iniciado.
      const falha = `não foi possível preparar o motor "${driver.id}": ${msg(erro)}`;
      (registro as any).erro = falha;
      await this.finalizar(ws, registro, ag.frontmatter, "falhou", null, Date.now() - inicio.getTime(), falha, "", null);
      throw new SessionError(falha);
    }
    runnerBin = prep.binary;
    args = prep.args;
    execEnv = prep.env;
    execCwd = prep.cwd;

    try {
      const { WorkspaceGit } = await import("../workspace/workspace-git.js");
      const wsGit = new WorkspaceGit();
      if (wsGit.temGit(ws.path)) {
        void wsGit.criarCheckpoint(ws.path, id);
      }
    } catch {
      /* best-effort checkpoint */
    }

    const logStream = createWriteStream(logPath, { flags: "a" });
    logStream.write(
      `# sessão ${id}\n# agente: ${registro.agente} · modelo: ${modelo} · workspace: ${ws.id}\n# ordem: ${ordem}\n\n`,
    );
    const captura: string[] = [];
    let watchdog: WatchdogRun | null = null;
    const teeing = async (stream: AsyncIterable<unknown> | null | undefined) => {
      if (!stream) return;
      for await (const chunk of stream) {
        watchdog?.registrarAtividade();
        const bruto = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        const texto = segredosRun.length > 0 ? redactSecrets(bruto, segredosRun) : bruto;
        captura.push(texto);
        logStream.write(texto);
        process.stdout.write(texto);
      }
    };

    let child: ReturnType<typeof execa>;
    // Consumo de stdout/stderr começa junto com o processo: com `buffer: false`,
    // a saída de um processo rápido se perdia se a leitura só começasse depois
    // das gravações em disco abaixo.
    let consumoSaida: Promise<unknown> = Promise.resolve();
    // Valores das credenciais injetadas: nunca vão para captura, log ou stdout.
    let segredosRun: string[] = [];
    try {
      // Resolve driver de execução (sandbox Bubblewrap, host ou container) e limites
      let binEfetivo = runnerBin;
      let argsEfetivos = args;
      let cwdEfetivo = execCwd;
      let envEfetivo = execEnv;

      try {
        const { resolverDriverExecucao } = await import("./execution-driver.js");
        const modDriver = (await import("./execution-driver.js")) as {
          escolherPreferenciaDriver?: (agente?: string, workspace?: string, global?: string) => string;
        };
        const escolher = modDriver.escolherPreferenciaDriver ?? ((_ag?: string, w?: string, g = "sandbox") => w || g);
        let modoDriver = "sandbox";
        let driverWorkspace: string | undefined;
        let driverGlobal = "sandbox";
        let limites: { ramMb?: number; cpuPct?: number; redeIsolada?: boolean; dominiosPermitidos?: string[] } | undefined;
        try {
          const cfgPath = join(ws.path, ".opencorp", "config.json");
          if (existsSync(cfgPath)) {
            const rawCfg = JSON.parse(await readFile(cfgPath, "utf8"));
            // Formato novo (ModalConfigIsolamento / driver-config)
            if (rawCfg.execution_driver) driverWorkspace = String(rawCfg.execution_driver);
            const lim = rawCfg.limites ?? {};
            // Formato legado (runner.*) mantido por compatibilidade
            if (rawCfg.runner?.modo && !driverWorkspace) driverWorkspace = rawCfg.runner.modo;
            const ramMb = lim.ramMb ?? rawCfg.runner?.limite_ram_mb;
            const cpuPct = lim.cpuPct ?? rawCfg.runner?.limite_cpu_pct;
            const redeIsolada = lim.redeIsolada ?? rawCfg.runner?.rede_isolada;
            const dominiosPermitidos = lim.dominiosPermitidos ?? rawCfg.runner?.dominios_permitidos;
            if (ramMb || cpuPct || redeIsolada !== undefined || dominiosPermitidos) {
              limites = {
                ramMb,
                cpuPct,
                redeIsolada,
                dominiosPermitidos,
              };
            }
          }
          try {
            const gcPath = join(this.homeDir, ".opencorp", "config.json");
            if (existsSync(gcPath)) {
              const gc = JSON.parse(await readFile(gcPath, "utf8"));
              if (gc.execution_driver) driverGlobal = String(gc.execution_driver);
            }
          } catch {}
        } catch {}
        // Precedência: frontmatter do agente > workspace > global
        const driverAgente = (ag.frontmatter as { execution_driver?: string } | undefined)?.execution_driver;
        modoDriver = escolher(driverAgente, driverWorkspace, driverGlobal);

        // Se limites não foram explicitados no workspace, injeta salvaguardas padrão de cgroup v2
        if (!limites && (modoDriver === "sandbox" || modoDriver === "container")) {
          limites = {
            ramMb: 2048,
            cpuPct: 200,
            redeIsolada: false,
          };
        }

        const driver = await resolverDriverExecucao(modoDriver);
        const prep = await driver.preparar({
          binary: runnerBin,
          args,
          cwd: execCwd,
          env: execEnv,
          workspaceId: ws.id,
          workspacePath: ws.path,
          limites,
        });

        binEfetivo = prep.binary;
        argsEfetivos = prep.args;
        cwdEfetivo = prep.cwd;
        envEfetivo = Object.fromEntries(
          Object.entries(prep.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        );
        if (prep.aviso) {
          console.warn(`[session:${id}] ${prep.aviso}`);
        }
      } catch {
        /* fallback silencioso para execução direta */
      }

      // Host Admission Control: verifica memória do host antes de spawnar novo container
      await this.admitirExecucaoHost(id);

      // Token Bucket Rate Limiter: amortecimento preventivo de rajadas por motor
      const motorNome = (ag.frontmatter as { engine?: string } | undefined)?.engine || "opencode";
      await tokenBucketGlobal.adquirirToken(motorNome).catch(() => {});

      segredosRun = Object.entries(envEfetivo)
        .filter(([nome]) => KNOWN_SECRET_ENV_VARS.includes(nome))
        .map(([, valor]) => valor);
      child = execa(binEfetivo, argsEfetivos, {
        cwd: cwdEfetivo,
        env: envEfetivo,
        buffer: false,
        reject: false,
        stdin: "ignore",
      });
      consumoSaida = Promise.all([teeing(child.stdout), teeing(child.stderr)]);
      consumoSaida.catch(() => {}); // tratado no await abaixo; evita rejeição não tratada enquanto isso
    } catch (erro) {
      logStream.end();
      const falha = `não foi possível iniciar o runner (${runnerBin}): ${msg(erro)} — ele está no PATH? (rode "opencorp doctor")`;
      (registro as any).erro = falha;
      await this.finalizar(ws, registro, ag.frontmatter, "falhou", null, Date.now() - inicio.getTime(), falha, "", null);
      throw new SessionError(falha);
    }
    this.processosAtivos.set(id, child);
    if (child.pid) {
      registro.pid = child.pid;
      const meta = await this.registros.lerMeta(ws.path, "execucoes", id);
      await this.salvarExtras(ws.path, meta, registro);
    }

    let mortePorTimeout = false;
    let motivoTimeout = "";
    // Limites padrão vêm do motor (EngineDriver.timeoutDefaults); o núcleo não conhece ids de motor.
    const padraoTetoMs = driver.timeoutDefaults?.tetoMs ?? 600_000;
    const padraoInatividadeMs = driver.timeoutDefaults?.inatividadeMs ?? 60_000;
    const tetoMs = typeof opcoes.timeoutMs === "number" && opcoes.timeoutMs > 0 ? opcoes.timeoutMs : padraoTetoMs;
    const inatividadeMs = typeof (opcoes as any).inatividadeMs === "number"
      ? (opcoes as any).inatividadeMs
      : Number(process.env.OPENCORP_INATIVIDADE_TIMEOUT_MS || padraoInatividadeMs);

    watchdog =
      (tetoMs > 0 || inatividadeMs > 0) && child.pid
        ? new WatchdogRun({
            tetoMs,
            inatividadeMs,
            pid: child.pid,
            intervaloMs: opcoes.watchdogIntervalMs ?? 5_000,
            ...(opcoes.watchdogGracaMs !== undefined ? { gracaKillMs: opcoes.watchdogGracaMs } : {}),
            obterStatus: async () => {
              try {
                const meta = await this.registros.lerMeta(ws.path, "execucoes", id);
                return ((meta.extras ?? {}) as Record<string, unknown>).status as string | undefined;
              } catch {
                return undefined;
              }
            },
            aoEstourar: async (decorrido, motivo) => {
              mortePorTimeout = true;
              motivoTimeout = motivo ?? `timeout de ${Math.round(tetoMs / 1000)}s excedido`;
              const mensagem = `${motivoTimeout} — opencode morto (modelo travado?)`;
              registro.status = "falhou";
              (registro as any).erro = mensagem;
              registro.exit_code = null;
              registro.duracao_ms = decorrido;
              registro.fim = new Date().toISOString();
              await this.finalizar(ws, registro, null, "falhou", null, decorrido, mensagem, captura.join(""), null);
            },
          })
        : null;
    watchdog?.iniciar();

    const resolverAposTimeout = async (): Promise<ResultadoRun> => {
      const morte = watchdog?.quandoMorto;
      if (morte) await morte;
      const retry = await this.tentarRetry(ws, opcoes, registro, captura.join(""), motivoTimeout || "timeout/inatividade");
      if (retry) return retry;
      return {
        ...registro,
        status: "falhou",
        exit_code: null,
        captura: captura.join(""),
        custo_usd: null,
      };
    };

    let resultado;
    try {
      await consumoSaida;
      resultado = await child;
    } catch (erro) {
      logStream.end();
      watchdog?.parar();
      if (watchdog?.estourou || mortePorTimeout) {
        return await resolverAposTimeout();
      }
      const falha = `não foi possível executar o runner (${runnerBin}): ${msg(erro)} — ele está no PATH? (rode "opencorp doctor")`;
      (registro as any).erro = falha;
      await this.finalizar(ws, registro, ag.frontmatter, "falhou", null, Date.now() - inicio.getTime(), falha, captura.join(""), null);
      throw new SessionError(falha);
    }
    watchdog?.parar();
    logStream.end();

    if (watchdog?.estourou || mortePorTimeout) {
      return await resolverAposTimeout();
    }

    const fim = new Date();
    const duracao = fim.getTime() - inicio.getTime();
    const res = resultado as unknown as { exitCode?: number | null; killed?: boolean; timedOut?: boolean };
    const status: StatusExecucao = res.killed
      ? "cancelado"
      : res.exitCode === 0
        ? "concluido"
        : "falhou";
    registro.fim = fim.toISOString();
    registro.status = status;
    registro.exit_code = res.exitCode ?? null;
    registro.duracao_ms = duracao;

    const textoCaptura = captura.join("");

    // Se falhou (erro de modelo ou de motor), tenta retry com rotação de modelo ou rotação de motor
    if (status === "falhou") {
      const retry = await this.tentarRetry(ws, opcoes, registro, textoCaptura);
      if (retry) return retry;
    }

    if (status === "falhou") {
      (registro as any).erro = extrairResumoErro(textoCaptura, registro.exit_code);
    }

    const custo = budget.estimarCusto(
      await budget.carregar(ws.path),
      modelo,
      duracao,
      textoCaptura,
    );
    const consumo = await budget.registrarConsumo(ws.path, ag.frontmatter.id, custo, {
      modelo,
      duracao_ms: duracao,
    });
    if (consumo.aviso80) {
      console.log(
        `\n[opencorp] ⚠ aviso: consumo atingiu 80% do orçamento (${ag.frontmatter.id} ou workspace) — veja "opencorp budget status"`,
      );
    }
    await this.finalizar(
      ws,
      registro,
      ag.frontmatter,
      status,
      registro.exit_code,
      duracao,
      textoCaptura.slice(0, 400),
      textoCaptura,
      custo,
    );

    if (!opcoes.pularGuard) {
      const posHitl = policy.hitl_patterns.find((padrao) => casaPadrao(padrao, textoCaptura));
      if (posHitl) {
        const pendencia = await this.approvals.criar(ws.path, {
          ordem,
          agente: ag.frontmatter.id,
          modelo,
          padrao: posHitl,
          origem: "pos-voo",
          motivo_guard: `transcript da sessão contém o padrão de HITL "${posHitl}" — requer revisão humana`,
          workspace_id: ws.id,
          workspace_path: ws.path,
          exec_id: registro.id,
        });
        await this.registros.anexarEvento(ws.path, "execucoes", registro.id, {
          ts: new Date().toISOString(),
          por: "security-guard",
          evento: "hitl_pos_voo",
          padrao: posHitl,
          resumo: `pendência ${pendencia.id} criada para revisão humana`,
        });
        throw new SessionError(
          `HITL pós-voo: o transcript contém "${posHitl}" — pendência ${pendencia.id} criada para revisão humana (exit 5)`,
          { exitCode: 5 },
        );
      }
      const posBloq = policy.blocklist.find((padrao) => casaPadrao(padrao, textoCaptura));
      if (posBloq) {
        await this.registros.eventoAuditoria(ws.path, {
          por: ag.frontmatter.id,
          evento: "padrao_bloqueado_pos_voo",
          resumo: `transcript contém padrão da blocklist "${posBloq}" — execução já ocorreu dentro do opencode; registrada para auditoria`,
          padrao: posBloq,
          ordem: ordem.slice(0, 160),
        });
        await this.registros.anexarEvento(ws.path, "execucoes", registro.id, {
          ts: new Date().toISOString(),
          por: "security-guard",
          evento: "violacao_pos_voo",
          padrao: posBloq,
          resumo: "transcript contém padrão da blocklist — auditoria (a sessão já tinha corrido)",
        });
        console.log(
          `\n[opencorp] ⚠ auditoria: o transcript contém o padrão de blocklist "${posBloq}" — evento registrado em .opencorp/registries/logs/audit-log`,
        );
      }
    }
    if (status === "falhou") {
      const retry = await this.tentarRetry(ws, opcoes, registro, textoCaptura);
      if (retry) return retry;
    }
    return { ...registro, captura: textoCaptura, custo_usd: custo };
  }

  // ── F1-T02: continuar / duplicar (aditivo; rodar não muda de comportamento) ──

  /**
   * Continua a sessão no motor quando há suporte nativo de ponta a ponta
   * (opencode via --session; crom-agente via opts.session → --session).
   * Demais harnesses (mesmo os que declaram continuação na matriz, ex.
   * claude-code/codex, cujo driver ainda não repassa a sessão) e harnesses sem
   * suporte (aider, desconhecidos) caem no fallback honesto: sessão nova com o
   * prompt reidratado `[contexto de <id>]`, extras `reidratada_de` e aviso
   * `sem-continuidade-nativa` — nunca finge continuação.
   */
  async continuar(
    sessaoId: string,
    prompt: string,
    opts: OpcoesContinuarDuplicar = {},
  ): Promise<ResultadoContinuar> {
    if (!prompt || prompt.trim().length === 0) {
      throw new SessionError("ordem vazia — informe o prompt da continuação");
    }
    const { wsPath, wsId, meta } = await this.localizarExecucao(sessaoId, opts);
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    const agente = meta.criado_por;
    const modeloOrigem = String(extras.modelo ?? "");
    const harness = this.harnessDaExecucao(meta);
    const capacidade = CapabilitiesPara(harness);
    // O repasse da sessão nativa é declarado pelo driver (EngineDriver.nativeSessionPassthrough).
    let repasseNativo = false;
    try {
      repasseNativo = engineRegistry.resolveDriver(harness).nativeSessionPassthrough === true;
    } catch {}
    const modelo = (opts.model ?? modeloOrigem).trim();

    if (capacidade.continuaNativo && repasseNativo) {
      const r = await this.rodar({
        agente,
        ordem: prompt,
        ...(modelo ? { model: modelo } : {}),
        session: sessaoId,
        continuada_de: sessaoId,
        session_from_ancestral: sessaoId,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.tags ? { tags: opts.tags } : {}),
        workspaceDir: wsPath,
        workspaceId: wsId,
        ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      });
      try {
        await this.registros.anexarEvento(wsPath, "execucoes", r.id, {
          ts: new Date().toISOString(),
          por: "opencorp",
          evento: "continuada",
          resumo: `continuação nativa de ${sessaoId} no motor ${harness} (session repassada)`,
          continuada_de: sessaoId,
          harness,
        });
      } catch {
        /* journal best-effort */
      }
      return { ...r, continuada_de: sessaoId, continuidade_nativa: true };
    }

    // Fallback honesto: sessão nova + prompt reidratado com o transcript.
    const snapshot = await this.montarSnapshot(wsPath, meta);
    const ordemReidratada = this.montarPromptReidratado(sessaoId, snapshot, prompt);
    const r = await this.rodar({
      agente,
      ordem: ordemReidratada,
      ...(modelo ? { model: modelo } : {}),
      reidratada_de: sessaoId,
      session_from_ancestral: sessaoId,
      ...(opts.title ? { title: opts.title } : {}),
      tags: [...(opts.tags ?? []), "reidratada"],
      workspaceDir: wsPath,
      workspaceId: wsId,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    const motivo = capacidade.continuaNativo
      ? `o motor "${harness}" declara continuação nativa (${capacidade.como}), mas o driver ainda não repassa a sessão`
      : `o motor "${harness}" não continua sessões nativamente`;
    const aviso = `${AVISO_SEM_CONTINUIDADE_NATIVA}: ${motivo} — nova sessão reidratada a partir do transcript de ${sessaoId}`;
    try {
      await this.registros.anexarEvento(wsPath, "execucoes", r.id, {
        ts: new Date().toISOString(),
        por: "opencorp",
        evento: "reidratada",
        resumo: aviso,
        reidratada_de: sessaoId,
        harness,
      });
    } catch {
      /* journal best-effort */
    }
    return { ...r, continuada_de: sessaoId, continuidade_nativa: false, aviso };
  }

  /**
   * Duplica a sessão: snapshot (transcript + contexto + config) → sessão nova
   * com extras `fork_de`. Sempre agnóstico — nunca finge continuação, mesmo em
   * motor com suporte nativo.
   */
  async duplicar(
    sessaoId: string,
    opts: OpcoesContinuarDuplicar = {},
  ): Promise<ResultadoDuplicar> {
    const { wsPath, wsId, meta } = await this.localizarExecucao(sessaoId, opts);
    const snapshot = await this.montarSnapshot(wsPath, meta);
    const ordem = opts.prompt !== undefined && opts.prompt.trim().length > 0 ? opts.prompt : snapshot.ordem;
    if (!ordem || ordem.trim().length === 0) {
      throw new SessionError(
        `a sessão "${sessaoId}" não tem ordem registrada — informe um prompt para duplicar`,
      );
    }
    const modelo = (opts.model ?? snapshot.modelo ?? "").trim();
    const r = await this.rodar({
      agente: snapshot.agente,
      ordem,
      ...(modelo && modelo !== "-" ? { model: modelo } : {}),
      fork_de: sessaoId,
      session_from_ancestral: sessaoId,
      title: opts.title ?? `fork de ${sessaoId}`,
      tags: [...(opts.tags ?? []), "fork"],
      workspaceDir: wsPath,
      workspaceId: wsId,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    try {
      await this.registros.anexarEvento(wsPath, "execucoes", r.id, {
        ts: new Date().toISOString(),
        por: "opencorp",
        evento: "duplicada",
        resumo: `fork agnóstico de ${sessaoId} (transcript via ${snapshot.fonte_transcript}, ${snapshot.transcript.length} chars)`,
        fork_de: sessaoId,
        snapshot,
      });
    } catch {
      /* journal best-effort */
    }
    return { ...r, fork_de: sessaoId, snapshot };
  }

  /** Localiza a execução no workspace da dica ou em qualquer workspace registrado. */
  private async localizarExecucao(
    sessaoId: string,
    dica?: { workspaceId?: string; workspaceDir?: string },
  ): Promise<{ wsPath: string; wsId: string; meta: MetaRegistro }> {
    const candidatos: Array<{ path: string; id: string }> = [];
    if (dica?.workspaceDir) {
      candidatos.push({ path: dica.workspaceDir, id: dica.workspaceId ?? "" });
    }
    if (dica?.workspaceId) {
      try {
        const info = await this.workspaces.resolver(dica.workspaceId);
        if (info.existe && !candidatos.some((c) => c.path === info.path)) {
          candidatos.push({ path: info.path, id: info.id });
        }
      } catch {
        /* workspace da dica inválido — cai na busca geral */
      }
    }
    try {
      for (const w of await this.workspaces.listar()) {
        if (!candidatos.some((c) => c.path === w.path)) {
          candidatos.push({ path: w.path, id: w.id });
        }
      }
    } catch {
      /* sem lista — tenta só os candidatos */
    }
    for (const c of candidatos) {
      try {
        const meta = await this.registros.lerMeta(c.path, "execucoes", sessaoId);
        return { wsPath: c.path, wsId: c.id || meta.criado_por, meta };
      } catch {
        /* tenta o próximo workspace */
      }
    }
    throw new SessionError(
      `sessão "${sessaoId}" não encontrada em nenhum workspace (.opencorp/registries/execucoes)`,
    );
  }

  /** Harness efetivo da execução: extras.harness → prefixo do modelo → "opencode". */
  private harnessDaExecucao(meta: MetaRegistro): string {
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    if (typeof extras.harness === "string" && extras.harness.trim().length > 0) {
      return extras.harness.trim().toLowerCase();
    }
    return this.inferirHarness(String(extras.modelo ?? ""));
  }

  private inferirHarness(modelo: string): string {
    const m = modelo.trim().toLowerCase();
    for (const prefixo of [
      "opencode/",
      "claude-code/",
      "antigravity/",
      "crom-agente/",
      "crom/",
      "cursor/",
      "copilot/",
      "codex/",
      "aider/",
    ]) {
      if (m.startsWith(prefixo)) {
        return prefixo === "crom/" ? "crom-agente" : prefixo.slice(0, -1);
      }
    }
    return "opencode";
  }

  /** Transcript da sessão: chats/<id> (transcript) → logs/<id>.log → vazio. */
  private async lerTranscriptComFonte(
    wsPath: string,
    id: string,
  ): Promise<{ texto: string; fonte: "chats" | "log" | "vazio" }> {
    try {
      const t = await this.transcriptDe(wsPath, id);
      if (t && t.trim().length > 0) return { texto: t, fonte: "chats" };
    } catch {
      /* sem transcript em chats — tenta o log */
    }
    try {
      const t = await this.logDe(wsPath, id);
      if (t && t.trim().length > 0) return { texto: t, fonte: "log" };
    } catch {
      /* sem log — snapshot sem transcript */
    }
    return { texto: "", fonte: "vazio" };
  }

  private async montarSnapshot(wsPath: string, meta: MetaRegistro): Promise<SnapshotSessao> {
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    const { texto, fonte } = await this.lerTranscriptComFonte(wsPath, meta.id);
    const { pid: _pid, ...extrasSemRuntime } = extras;
    void _pid;
    return {
      de: meta.id,
      em: new Date().toISOString(),
      agente: meta.criado_por,
      modelo: String(extras.modelo ?? "-"),
      ordem: String(extras.ordem ?? ""),
      harness: this.harnessDaExecucao(meta),
      status_origem: (extras.status as StatusExecucao) ?? "executando",
      transcript: texto,
      fonte_transcript: fonte,
      log_path: typeof extras.log === "string" ? extras.log : null,
      extras_origem: extrasSemRuntime,
    };
  }

  private montarPromptReidratado(sessaoId: string, snapshot: SnapshotSessao, prompt: string): string {
    const trecho =
      snapshot.transcript.length > LIMITE_TRANSCRIPT_REIDRATADO
        ? `${snapshot.transcript.slice(0, LIMITE_TRANSCRIPT_REIDRATADO)}\n[…transcript truncado…]`
        : snapshot.transcript;
    return (
      `[contexto de ${sessaoId}] (${snapshot.agente} · ${snapshot.modelo} · fonte: ${snapshot.fonte_transcript})\n` +
      `${trecho}\n\n--- nova ordem ---\n${prompt}`
    );
  }

  /**
   * Retry com rotabilidade de modelo e de harness:
   * 1. Se foi erro de modelo/cota e há modelos disponíveis para o motor atual, rotaciona o modelo.
   * 2. Se os modelos do motor se esgotaram ou o motor falhou (crash, processo abortado, erro do binário),
   *    rotaciona para o próximo motor da cadeia de harness (agente ou padrão do sistema).
   */


  private async tentarRetry(
    ws: { path: string; id: string },
    opcoes: OpcoesRun,
    registro: RegistroExecucao,
    captura: string,
    motivoMorteTimeout?: string,
  ): Promise<ResultadoRun | null> {
    if (opcoes.retryDe) return null;
    if (registro.status === "hitl_pendente") return null;

    const erroRegistro = String((registro as any).erro ?? "");
    const textoValidar = `${captura}\n${erroRegistro}\n${motivoMorteTimeout ?? ""}`;

    // Apenas inatividade do modelo (travamento sem tokens) dispara rotação automática por watchdog
    const ehInatividadeModelo = Boolean(
      (motivoMorteTimeout && /inatividade/i.test(motivoMorteTimeout)) ||
      (registro.exit_code === null && /inatividade/i.test(erroRegistro)),
    );

    if (!ehInatividadeModelo && !PADRAO_ERRO_MODELO.test(textoValidar)) {
      return null;
    }

    // Motor que executou (nunca inferido do prefixo do modelo — `openrouter/*`
    // não implica OpenCode). Registros antigos sem o campo usam o motor do agente.
    const motorId = String((registro as any).motor || opcoes.engine || opcoes.harness || "opencode");
    const falhaCreditos = PADRAO_ERRO_CREDITOS.test(textoValidar);
    const failure = falhaCreditos ? "credits" : classifyFailure(textoValidar, { inactivity: ehInatividadeModelo });

    // Rotação de conta: contas do provedor do modelo (ex.: `opencode-go` no
    // OpenCode) ou, na falta delas, do próprio motor. Nunca troca o motor.
    const acctStore = new EngineAccountStore({ homeDir: this.homeDir });
    let contaDono = motorId;
    let contaDisponivel = false;
    if (failure === "quota" || failure === "credits") {
      try {
        const provedor = providerOfModel(registro.modelo);
        const doProvedor = provedor !== motorId ? await acctStore.listar(provedor) : [];
        contaDono = doProvedor.length > 0 ? provedor : motorId;
        const contas = doProvedor.length > 0 ? doProvedor : await acctStore.listar(motorId);
        contaDisponivel = contas.some((c) => !c.ativa && c.limits.status_cota !== "esgotado" && (!c.workspaces?.length || c.workspaces.includes(ws.id)));
      } catch {
        contaDisponivel = false;
      }
    }

    const decisao = decideFallback({
      engineId: motorId,
      failedModel: registro.modelo,
      failure,
      modelChain: await this.cadeiaExplicitaDeFallback(ws.path, opcoes.agente),
      accountAvailable: contaDisponivel,
      // Troca de motor só pela cadeia explícita do usuário (settings.run_engine.fallback).
      engineChain: (() => {
        const chain = readRunEngineConfig(this.homeDir, { emitNotice: false }).fallbackEngines;
        return chain.length ? [motorId, ...chain.filter((e) => e !== motorId)] : [];
      })(),
    });
    const auditoria = formatFallbackAudit(decisao);
    const registrar = async (evento: string, resumo: string) => {
      try {
        await this.registros.anexarEvento(ws.path, "execucoes", registro.id, { ts: new Date().toISOString(), por: "opencorp", evento, resumo });
      } catch {
        /* journal best-effort */
      }
    };

    const acao = decisao.result;
    if (acao.action === "stop") {
      await registrar("fallback_interrompido", `${decisao.reason} — ${auditoria}`);
      return null;
    }

    const idRetry = gerarId("exec");
    if (acao.action === "rotate_account") {
      try {
        const ativa = await acctStore.obterContaAtiva(contaDono);
        if (ativa) await acctStore.atualizarLimitesConta(ativa.id, { status_cota: "esgotado" });
        const proxConta = await acctStore.rotacionarProximaConta(contaDono, ws.id);
        if (!proxConta) return null;
        await acctStore.sincronizarAuth(contaDono);
        await registrar("rotacao_conta", `cota esgotada no motor "${motorId}" (contas de "${contaDono}") — rotacionado para conta "${proxConta.nome}" → ${idRetry} (${auditoria})`);
        return this.rodar({
          ...opcoes,
          execId: idRetry,
          retryDe: { de_modelo: registro.modelo, de_exec: registro.id },
          gatilho: opcoes.gatilho
            ? { ...opcoes.gatilho, origem: sufixarRetry(opcoes.gatilho.origem, `conta:${proxConta.nome}`) }
            : undefined,
        });
      } catch (erroRotacao) {
        console.warn(`[session-manager] falha ao rotacionar conta para motor "${motorId}":`, erroRotacao);
        return null;
      }
    }

    // next_model (next_engine só ocorre com cadeia explícita de motores)
    await registrar(
      acao.action === "next_engine" ? "retry_motor" : "retry_modelo",
      `falha de modelo/API (${registro.modelo}) — 1 retry com ${acao.model} no motor "${acao.engineId}"${falhaCreditos ? " (filtrando apenas gratuitos)" : ""} → ${idRetry} (${auditoria})`,
    );
    return this.rodar({
      ...opcoes,
      model: acao.model,
      // Fixa o motor: o prefixo do próximo modelo nunca troca o motor em silêncio.
      engine: acao.engineId,
      execId: idRetry,
      retryDe: { de_modelo: registro.modelo, de_exec: registro.id },
      gatilho: opcoes.gatilho
        ? { ...opcoes.gatilho, origem: sufixarRetry(opcoes.gatilho.origem, acao.model) }
        : undefined,
    });
  }

  /**
   * Cadeia EXPLÍCITA de fallback: `settings.tests.rotation` configurada, ou a
   * rotação do agente seguida da rotação do workspace (se herdada). Nunca usa
   * listas embutidas — sem cadeia configurada não há retry (Etapa 13).
   */
  public async cadeiaExplicitaDeFallback(wsPath: string, agenteId?: string): Promise<string[]> {
    try {
      const r = await new SettingsStore({ homeDir: this.homeDir, cwd: wsPath }).resolve();
      const configurada = [...r.origens.entries()].some(([chave, origem]) => chave.startsWith("tests.rotation") && origem !== "default");
      if (configurada && Array.isArray(r.settings?.tests?.rotation) && r.settings.tests.rotation.length > 0) {
        return [...r.settings.tests.rotation];
      }
    } catch {
      /* settings indisponível */
    }
    let frontmatter: any;
    if (this.agentes && agenteId) {
      try {
        frontmatter = (await this.agentes.carregar(wsPath, agenteId)).frontmatter;
      } catch {
        frontmatter = undefined;
      }
    }
    try {
      return resolverCadeiaModelosAgente({ agente: frontmatter, wsPath }).cadeia;
    } catch {
      return [];
    }
  }

  /**
   * Lista de rotação completa (agente + fallbacks globais/workspace).
   * Retorna o próximo modelo que ainda não foi tentado nesta cadeia de execução.
   * Quando apenasGratuitos for true (ex.: cota/créditos esgotados), prioriza modelos gratuitos.
   * Só retorna null se todos os modelos disponíveis já tiverem falhado.
   */
  public async proximoModeloDaRotacao(
    modeloFalho: string,
    wsPath?: string,
    agenteId?: string,
    modelosJaTentados: string[] = [],
    apenasGratuitos: boolean = false,
  ): Promise<string | null> {
    if (!wsPath) return null;

    // 1. settings.tests.rotation tem prioridade máxima se configurada
    try {
      const r = await new SettingsStore({ homeDir: this.homeDir, cwd: wsPath ?? this.homeDir }).resolve();
      const configurada = [...r.origens.entries()].some(
        ([chave, origem]) => chave.startsWith("tests.rotation") && origem !== "default",
      );
      if (configurada && Array.isArray(r.settings?.tests?.rotation) && r.settings.tests.rotation.length > 0) {
        let lista = r.settings.tests.rotation;
        if (apenasGratuitos) {
          lista = lista.filter((m) => ehModeloGratuito(m));
        }
        if (modelosJaTentados.length > 0) {
          const tentadosSet = new Set(modelosJaTentados);
          const restantes = lista.filter((m) => !tentadosSet.has(m));
          if (restantes.length > 0) return restantes[0]!;
          return null;
        }
        return proximoModeloRotacao(lista, modeloFalho);
      }
    } catch {
      /* settings indisponível */
    }

    // 2. Se o agente possui rotation declarada no frontmatter
    let ag: any = undefined;
    if (this.agentes && agenteId) {
      try {
        ag = await this.agentes.carregar(wsPath, agenteId);
      } catch {}
    }

    const rotAgente = ag?.frontmatter?.rotation || ag?.frontmatter?.model_fallback;
    if (Array.isArray(rotAgente) && rotAgente.length > 0) {
      let lista = rotAgente;
      if (apenasGratuitos) {
        lista = lista.filter((m) => ehModeloGratuito(m));
      }
      const prox = proximoModeloDaCadeia({
        cadeia: lista,
        modeloAtual: modeloFalho,
        modelosJaTentados,
        apenasGratuitos,
      });
      if (prox) return prox;

      // 2.1 Se a rotação própria do agente esgotou, tenta fallback no workspace se autorizado
      const herdarWorkspace =
        ag?.frontmatter?.workspace_rotation_fallback !== undefined
          ? Boolean(ag.frontmatter.workspace_rotation_fallback)
          : ag?.frontmatter?.rotacao_global !== undefined
            ? Boolean(ag.frontmatter.rotacao_global)
            : true;

      if (herdarWorkspace && wsPath) {
        try {
          const wsCfgPath = join(wsPath, ".opencorp", "config.json");
          if (existsSync(wsCfgPath)) {
            const wsCfg = JSON.parse(readFileSync(wsCfgPath, "utf8"));
            const rotWs = wsCfg?.modelos?.rotacao || wsCfg?.tests?.rotation;
            if (Array.isArray(rotWs) && rotWs.length > 0) {
              let listaWs = rotWs;
              if (apenasGratuitos) {
                listaWs = listaWs.filter((m: string) => ehModeloGratuito(m));
              }
              const proxWs = proximoModeloDaCadeia({
                cadeia: listaWs,
                modeloAtual: modeloFalho,
                modelosJaTentados,
                apenasGratuitos,
              });
              if (proxWs) return proxWs;
            }
          }
        } catch {}
      }
    }

    // 3. Sem cadeia explícita não há próximo modelo (Etapa 13: nada de listas embutidas).
    return null;
  }

  async listarExecucoes(wsPath: string, filtro?: { agente?: string }): Promise<ResumoExecucao[]> {
    const metas = await this.registros.listar(wsPath, "execucoes");
    // Só sessões de verdade (tag "sessao"): registros avulsos na categoria
    // (ex.: saída de flow gravada em execucoes/*) não são execuções e
    // apareciam como fantasmas "executando" no Histórico.
    const sessoes = metas.filter((meta) => (meta.tags ?? []).includes("sessao"));
    const filtradas = sessoes.filter((meta) => !filtro?.agente || meta.criado_por === filtro.agente);
    for (const meta of filtradas) {
      await this.reconciliarZombie(wsPath, meta);
    }
    return filtradas
      .map((meta) => this.paraResumo(meta))
      .sort((a, b) => b.inicio.localeCompare(a.inicio));
  }

  /**
   * Host Admission Control: protege o host caso a RAM física disponível esteja baixa.
   * Se freemem < 800MB, aguarda até 5s em intervalos de 500ms para permitir que outras
   * tarefas liberem recursos antes do spawn do novo processo.
   */
  async admitirExecucaoHost(sessionId: string): Promise<void> {
    const freememBytes = freemem();
    const freememMb = Math.round(freememBytes / (1024 * 1024));
    if (freememMb < 800) {
      console.warn(`[session:${sessionId}] Host sob pressão de memória (${freememMb}MB livres). Aguardando alívio...`);
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 500));
        if (Math.round(freemem() / (1024 * 1024)) >= 800) return;
      }
    }
  }

  /** execução "executando" cujo processo morreu sem finalizar → marca status final (zombie) */
  async reconciliarZombie(wsPath: string, meta: MetaRegistro): Promise<void> {
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    if (extras.status !== "executando") return;
    if (extras.tipo === "flow") {
      const pid = typeof extras.pid === "number" ? extras.pid : null;
      let vivo = true;
      if (pid) {
        try {
          process.kill(pid, 0);
        } catch {
          vivo = false;
        }
      } else {
        // Flow sem pid registrado (legado ou processo morto): se >10min sem finalizar, considera zumbi
        const inicio = Date.parse(meta.criado_em);
        if (Number.isFinite(inicio) && Date.now() - inicio > 10 * 60_000) {
          vivo = false;
        }
      }
      if (!vivo) {
        const agoraIso = new Date().toISOString();
        const inicio = Date.parse(meta.criado_em);
        const duracao = Number.isFinite(inicio) ? Date.now() - inicio : 0;
        const erroMsg = pid
          ? `zombie: processo pai do flow (pid ${pid}) morreu sem finalizar — reconciliado em ${agoraIso}`
          : `zombie: flow sem pid há >10min sem finalizar — reconciliado em ${agoraIso}`;
        const nos = Array.isArray(extras.nos) ? (extras.nos as Array<{ id?: string; status?: string }>) : [];
        for (const n of nos) {
          if (n.status === "executando") n.status = "falhou";
        }
        meta.extras = {
          ...extras,
          status: "falhou",
          fim: agoraIso,
          duracao_ms: duracao,
          erro: erroMsg,
          motivo: erroMsg,
          nos,
        };
        await this.registros.salvarMeta(wsPath, "execucoes", meta.id, meta);
        await this.registros.anexarEvento(wsPath, "execucoes", meta.id, {
          ts: agoraIso,
          por: "opencorp",
          evento: "finalizado",
          status: "falhou",
          resumo: erroMsg,
        });
        try {
          this.registros.corpDb(wsPath).atualizarStatusExecucao(meta.id, "falhou", agoraIso, erroMsg);
        } catch {}
      }
      return;
    }
    const pid = extras.pid as number | null;
    if (!pid) {
      // Sem pid (ex.: processo falhou ao iniciar ou mention sem fork): se já passou 60s do início, é zumbi
      const inicio = Date.parse(meta.criado_em);
      if (Number.isFinite(inicio) && Date.now() - inicio < 60_000) return;
      const registro = await this.paraRegistro(meta);
      registro.status = "falhou";
      registro.fim = new Date().toISOString();
      registro.duracao_ms = Number.isFinite(inicio) ? Date.now() - inicio : 0;
      registro.exit_code = null;
      const erroMsg = `zombie: registro "executando" sem pid há >60s — processo morreu sem finalizar (reaper) — reconciliado em ${registro.fim}`;
      await this.finalizar(
        { path: wsPath, id: "" },
        registro,
        null,
        "falhou",
        null,
        registro.duracao_ms,
        erroMsg,
        "",
        null,
      );
      meta.extras = { ...extras, status: "falhou", duracao_ms: registro.duracao_ms, fim: registro.fim, pid: null, erro: erroMsg };
      try {
        this.registros.corpDb(wsPath).atualizarStatusExecucao(meta.id, "falhou", registro.fim, erroMsg);
      } catch {}
      return;
    }
    let viva = true;
    try {
      process.kill(pid, 0);
    } catch {
      viva = false;
    }

    const inicio = Date.parse(meta.criado_em);
    const duracao = Number.isFinite(inicio) ? Date.now() - inicio : 0;
    const MAX_RUN_TIME_MS = 15 * 60_000; // 15 minutos de teto para processos em hang

    if (viva) {
      if (duracao < MAX_RUN_TIME_MS) return;
      // Processo vivo há mais de 15 minutos sem finalizar — trava/hang detectado pelo reaper.
      // Execução dentro do próprio processo (fluxo): marca como falha, mas nunca sinaliza o OpenCorp.
      if (pidSinalizavel(pid)) try {
        process.kill(pid, "SIGTERM");
        setTimeout(() => {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }, 4000);
      } catch {}
    }

    const registro = await this.paraRegistro(meta);
    registro.status = "falhou";
    registro.fim = new Date().toISOString();
    registro.duracao_ms = duracao;
    registro.exit_code = null;
    const erroMsg = viva
      ? `zombie: processo (pid ${pid}) estourou TTL de 15min sem finalizar (reaper timeout) — terminado em ${registro.fim}`
      : `zombie: processo (pid ${pid}) morreu sem finalizar (reaper) — reconciliado em ${registro.fim}`;
    await this.finalizar(
      { path: wsPath, id: "" },
      registro,
      null,
      "falhou",
      null,
      duracao,
      erroMsg,
      "",
      null,
    );
    meta.extras = { ...extras, status: "falhou", duracao_ms: duracao, fim: registro.fim, pid: null, erro: erroMsg };
    try {
      this.registros.corpDb(wsPath).atualizarStatusExecucao(meta.id, "falhou", registro.fim, erroMsg);
    } catch {}
  }

  async reconciliarZombieSeNecessario(wsPath: string, execId: string): Promise<MetaRegistro | null> {
    try {
      const meta = await this.registros.lerMeta(wsPath, "execucoes", execId);
      if ((meta.extras as any)?.status === "executando") {
        await this.reconciliarZombie(wsPath, meta);
      }
      return meta;
    } catch {
      return null;
    }
  }

  async caminhoLog(wsPath: string, id: string): Promise<string> {
    const logPath = join(wsPath, "logs", `${id}.log`);
    if (!existsSync(logPath)) {
      throw new SessionError(`log não encontrado para a sessão "${id}" (${logPath})`);
    }
    return logPath;
  }

  /**
   * Anti-stale: reconcilia TODAS as execuções "executando" cujo processo já
   * morreu sem finalizar (zombies) ou divergiram entre o registro em disco e o banco.
   * @returns ids que foram reconciliados.
   */
  async reconciliarZombies(wsPath: string): Promise<string[]> {
    const reconciliados: string[] = [];
    const metas = await this.registros.listar(wsPath, "execucoes");
    const metasPorId = new Map<string, MetaRegistro>();

    for (const meta of metas) {
      metasPorId.set(meta.id, meta);
      const extras = (meta.extras ?? {}) as Record<string, unknown>;
      if (extras.status === "executando") {
        await this.reconciliarZombie(wsPath, meta);
        const depois = (meta.extras ?? {}) as Record<string, unknown>;
        if (depois.status !== "executando") {
          reconciliados.push(meta.id);
          try {
            this.registros.corpDb(wsPath).atualizarStatusExecucao(
              meta.id,
              String(depois.status || "falhou"),
              depois.fim as string | undefined,
              (depois.erro as string) ?? null,
            );
          } catch {}
        }
      } else {
        // Se no meta.json já está finalizado, garante sincronização no banco corpDb
        try {
          const noBanco = this.registros.corpDb(wsPath).obterExecucao(meta.id);
          if (noBanco && noBanco.status === "executando") {
            this.registros.corpDb(wsPath).atualizarStatusExecucao(
              meta.id,
              String(extras.status || "falhou"),
              (extras.fim as string) ?? new Date().toISOString(),
              (extras.erro as string) ?? null,
            );
            reconciliados.push(meta.id);
          }
        } catch {}
      }
    }

    // Varre execuções no banco SQLite que ainda constem como "executando"
    try {
      const execsNoBanco = this.registros.corpDb(wsPath).listarExecucoes({ status: "executando" });
      for (const e of execsNoBanco) {
        if (reconciliados.includes(e.id)) continue;
        const meta = metasPorId.get(e.id);
        if (meta) {
          const extras = (meta.extras ?? {}) as Record<string, unknown>;
          if (extras.status !== "executando") {
            this.registros.corpDb(wsPath).atualizarStatusExecucao(
              e.id,
              String(extras.status || "falhou"),
              (extras.fim as string) ?? e.fim ?? new Date().toISOString(),
              (extras.erro as string) ?? null,
            );
            reconciliados.push(e.id);
          } else {
            await this.reconciliarZombie(wsPath, meta);
            const depois = (meta.extras ?? {}) as Record<string, unknown>;
            if (depois.status !== "executando") {
              reconciliados.push(e.id);
              this.registros.corpDb(wsPath).atualizarStatusExecucao(
                e.id,
                String(depois.status || "falhou"),
                (depois.fim as string) ?? new Date().toISOString(),
                (depois.erro as string) ?? null,
              );
            }
          }
        } else {
          // Sem meta.json: se iniciou há mais de 60s, finaliza no banco como falhou
          const inicioMs = e.inicio ? Date.parse(e.inicio) : 0;
          if (!inicioMs || Date.now() - inicioMs > 60_000) {
            this.registros.corpDb(wsPath).atualizarStatusExecucao(
              e.id,
              "falhou",
              new Date().toISOString(),
              "zombie: processo morreu sem finalizar (reconciliado)",
            );
            reconciliados.push(e.id);
          }
        }
      }
    } catch {
      /* best-effort na varredura do banco */
    }

    return reconciliados;
  }

  async logDe(wsPath: string, id: string): Promise<string> {
    return readFile(await this.caminhoLog(wsPath, id), "utf8");
  }

  async transcriptDe(wsPath: string, id: string): Promise<string> {
    const registro = await this.registros.obter(wsPath, "chats", id);
    return sanitizarTranscript(registro.conteudo ?? "");
  }

  async matar(wsPath: string, id: string): Promise<void> {
    let meta: MetaRegistro;
    try {
      meta = await this.registros.lerMeta(wsPath, "execucoes", id);
    } catch {
      throw new SessionError(`sessão "${id}" não encontrada (.opencorp/registries/execucoes)`);
    }
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    if (extras.status !== "executando") {
      throw new SessionError(
        `sessão "${id}" não está em execução (status: ${String(extras.status ?? "desconhecido")})`,
      );
    }
    const pid = extras.pid as number | null;
    if (!pid) {
      throw new SessionError(`sessão "${id}" não tem pid registrado — não é possível matar`);
    }
    let viva = true;
    try {
      process.kill(pid, 0);
    } catch {
      viva = false;
    }
    if (!viva) {
      throw new SessionError(`o processo da sessão "${id}" (pid ${pid}) não está mais vivo`);
    }
    if (!pidSinalizavel(pid)) {
      throw new SessionError(`a sessão "${id}" roda dentro do próprio OpenCorp (pid ${pid}); use o cancelamento da execução em vez de matar o processo`);
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch (erro) {
      throw new SessionError(`não foi possível matar o pid ${pid}: ${msg(erro)}`);
    }
    const registro = await this.paraRegistro(meta);
    registro.status = "cancelado";
    registro.fim = new Date().toISOString();
    registro.duracao_ms = Date.now() - Date.parse(registro.inicio);
    await this.finalizar(
      { path: wsPath, id: "" },
      registro,
      null,
      "cancelado",
      null,
      registro.duracao_ms,
      "cancelada via session kill",
      "",
      null,
    );
  }

  private paraResumo(meta: MetaRegistro): ResumoExecucao {
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    return {
      id: meta.id,
      agente: meta.criado_por,
      modelo: String(extras.modelo ?? "-"),
      status: (extras.status as StatusExecucao) ?? "executando",
      inicio: meta.criado_em,
      duracao_ms: (extras.duracao_ms as number | null) ?? null,
      exit_code: (extras.exit_code as number | null) ?? null,
      ...(extras.gatilho ? { gatilho: gatilhoSchema.parse(extras.gatilho) } : {}),
    };
  }

  private async paraRegistro(meta: MetaRegistro): Promise<RegistroExecucao> {
    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    return {
      id: meta.id,
      agente: meta.criado_por,
      modelo: String(extras.modelo ?? "-"),
      ordem: String(extras.ordem ?? ""),
      inicio: meta.criado_em,
      fim: (extras.fim as string | null) ?? null,
      status: (extras.status as StatusExecucao) ?? "executando",
      exit_code: (extras.exit_code as number | null) ?? null,
      duracao_ms: (extras.duracao_ms as number | null) ?? null,
      pid: (extras.pid as number | null) ?? null,
      log: String(extras.log ?? `logs/${meta.id}.log`),
      ...(extras.gatilho ? { gatilho: gatilhoSchema.parse(extras.gatilho) } : {}),
    };
  }

  private async salvarExtras(wsPath: string, meta: MetaRegistro, registro: RegistroExecucao): Promise<void> {
    meta.extras = {
      ...(meta.extras ?? {}),
      status: registro.status,
      modelo: registro.modelo,
      ordem: registro.ordem,
      pid: registro.pid,
      fim: registro.fim,
      exit_code: registro.exit_code,
      duracao_ms: registro.duracao_ms,
      log: registro.log,
      ...(registro.gatilho ? { gatilho: registro.gatilho } : {}),
    };
    await this.registros.salvarMeta(wsPath, "execucoes", registro.id, meta);
  }

  private async finalizar(
    ws: { path: string; id: string },
    registro: RegistroExecucao,
    agente: Agente | null,
    status: StatusExecucao,
    exitCode: number | null,
    duracaoMs: number,
    resumo: string,
    captura: string,
    custoUsd: number | null = null,
  ): Promise<void> {
    this.processosAtivos.delete(registro.id);
    registro.status = status;
    registro.exit_code = exitCode;
    registro.duracao_ms = duracaoMs;
    registro.fim = registro.fim ?? new Date().toISOString();
    eventBus.emit("sessao-fim", {
      exec_id: registro.id,
      agente: registro.agente,
      status,
      exit_code: exitCode,
      duracao_ms: duracaoMs,
      ...(registro.gatilho ? { gatilho: registro.gatilho } : {}),
    });
    await this.registros.anexarEvento(ws.path, "execucoes", registro.id, {
      ts: new Date().toISOString(),
      por: "opencorp",
      evento: "finalizado",
      status,
      exit_code: exitCode,
      duracao_ms: duracaoMs,
      resumo,
    });
    const meta = await this.registros.lerMeta(ws.path, "execucoes", registro.id);
    await this.salvarExtras(ws.path, meta, registro);
    const erroDesc =
      (registro as any).erro ||
      (status === "falhou"
        ? (resumo && resumo.trim() ? resumo : `Processo encerrou com falha (exit code ${exitCode ?? "desconhecido"})`)
        : null);
    (registro as any).erro = erroDesc;
    this.registrarNoLedger(ws.path, registro, custoUsd, erroDesc);

    // Auto-commit Git no workspace se houver arquivos alterados
    try {
      const { WorkspaceGit } = await import("../workspace/workspace-git.js");
      const wsGit = new WorkspaceGit();
      if (wsGit.temGit(ws.path)) {
        void wsGit.autoCommit(ws.path, registro.agente, registro.ordem || "", registro.id);
      }
    } catch {
      /* best-effort auto-commit */
    }

    // Notificação automática de falha de execução/modelo
    if (status === "falhou") {
      try {
        const { NotificationStore } = await import("../platform/notification-store.js");
        const notifs = new NotificationStore();
        const motivo = erroDesc || `Processo encerrou com falha (exit ${exitCode})`;
        await notifs.adicionar(ws.path, {
          tipo: "erro",
          titulo: `Falha na execução: @${registro.agente}`,
          corpo: `A execução ${registro.id} (@${registro.agente}) falhou no modelo ${registro.modelo}.\nMotivo: ${motivo.slice(0, 240)}`,
        });
        eventBus.emit("notificacao", {
          workspace: ws.id,
          tipo: "erro",
          titulo: `Falha: @${registro.agente}`,
          corpo: motivo.slice(0, 240),
        });
      } catch {
        /* best-effort notification */
      }
    }
    await this.registros.registrarSessao(ws.path, {
      id: registro.id,
      agente: registro.agente,
      modelo: registro.modelo,
      inicio: registro.inicio,
      fim: registro.fim,
      custo_usd: custoUsd,
      status: registro.status,
    });
    if (captura !== "" || agente !== null) {
      await this.registros.garantirRegistro(ws.path, {
        categoria: "chats",
        id: registro.id,
        descricao: `transcript da sessão ${registro.id} (${registro.agente} · ${registro.modelo})`,
        criadoPor: registro.agente,
        tags: ["sessao", "transcript"],
        conteudo: sanitizarTranscript(captura),
      });
    }
  }

}
