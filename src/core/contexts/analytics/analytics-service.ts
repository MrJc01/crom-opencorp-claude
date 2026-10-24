/**
 * Analytics multi-projeto: lê o `opencorp.db` de cada workspace (somente leitura) e devolve, num só objeto,
 * execuções, falhas, custo, fluxos, tarefas, notificações e a linha do tempo recente.
 *
 * Por que SQL e não varrer registries/: o disco do dono é lento e um workspace chega a ter 16 mil pastas de execução.
 * As consultas usam índices e janelas limitadas (o journal não tem índice de tempo; por isso só olhamos as últimas linhas).
 * Cada leitura abre e fecha o próprio handle `readonly`: nunca reaproveita (nem cacheia) a conexão de escrita do servidor.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceAnalyticsEntrada {
  id: string;
  path: string;
  nome?: string;
  pausado?: boolean;
  pausado_em?: string;
}

export interface OpcoesAnalytics {
  janelaMs: number;
  /** Instante de referência (ms); injetável para teste. */
  agora?: number;
  /** Quantos baldes do gráfico por hora/tempo (padrão 24). */
  baldes?: number;
  limiteLinhaDoTempo?: number;
}

export interface ResumoSessoes {
  total: number;
  concluidas: number;
  falhas: number;
  canceladas: number;
  executando: number;
  taxa_falha: number;
  duracao_media_ms: number;
  custo_usd: number;
}

export interface BaldeTempo {
  inicio: number;
  total: number;
  falhas: number;
}

export interface AgenteAnalytics {
  agente: string;
  total: number;
  falhas: number;
  custo_usd: number;
  duracao_media_ms: number;
}

export interface FluxoAnalytics {
  flow: string;
  execucoes: number;
  falhas: number;
  ultima_execucao: string | null;
  ultimo_status: string | null;
}

export interface EventoLinhaDoTempo {
  workspace: string;
  quando: string;
  tipo: "execucao" | "fluxo";
  titulo: string;
  status: string;
  detalhe?: string;
}

export interface WorkspaceAnalytics {
  id: string;
  nome: string;
  pausado: boolean;
  pausado_em: string | null;
  banco_disponivel: boolean;
  sessoes: ResumoSessoes;
  por_tempo: BaldeTempo[];
  agentes: AgenteAnalytics[];
  fluxos: FluxoAnalytics[];
  tarefas: Record<string, number>;
  notificacoes_nao_lidas: number;
  ultima_atividade: string | null;
  erros_recentes: Array<{ id: string; agente: string; quando: string; erro: string }>;
}

export interface TotaisAnalytics extends ResumoSessoes {
  workspaces: number;
  pausados: number;
  tarefas_abertas: number;
  notificacoes_nao_lidas: number;
}

export interface AnalyticsResumo {
  gerado_em: string;
  janela_ms: number;
  totais: TotaisAnalytics;
  por_tempo: BaldeTempo[];
  workspaces: WorkspaceAnalytics[];
  linha_do_tempo: EventoLinhaDoTempo[];
}

const COLUNAS_TAREFA_ENCERRADAS = new Set(["feito", "publicado", "descartado", "concluido", "cancelado"]);
const STATUS_EM_EXECUCAO = ["executando", "pendente", "em_execucao"];
/** Sessão "em execução" há mais que isso, sem fim, é zumbi e não conta como rodando. */
const LIMITE_ZUMBI_MS = 6 * 3_600_000;
/** O journal não tem índice por tempo: olhamos só as últimas linhas (por rowid, que acompanha o tempo). */
const LINHAS_JOURNAL_RECENTES = 20_000;

function arredondar(n: number, casas = 4): number {
  const f = 10 ** casas;
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f;
}

function resumoVazio(): ResumoSessoes {
  return { total: 0, concluidas: 0, falhas: 0, canceladas: 0, executando: 0, taxa_falha: 0, duracao_media_ms: 0, custo_usd: 0 };
}

function baldesVazios(inicioJanela: number, janelaMs: number, quantidade: number): BaldeTempo[] {
  const largura = janelaMs / quantidade;
  return Array.from({ length: quantidade }, (_, i) => ({ inicio: Math.round(inicioJanela + i * largura), total: 0, falhas: 0 }));
}

function temTabela(db: Database.Database, nome: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(nome) !== undefined;
}

function lerWorkspace(ws: WorkspaceAnalyticsEntrada, o: Required<Pick<OpcoesAnalytics, "janelaMs" | "agora" | "baldes" | "limiteLinhaDoTempo">>): {
  analytics: WorkspaceAnalytics;
  linha: EventoLinhaDoTempo[];
} {
  const base: WorkspaceAnalytics = {
    id: ws.id,
    nome: ws.nome || ws.id,
    pausado: ws.pausado === true,
    pausado_em: ws.pausado ? (ws.pausado_em ?? null) : null,
    banco_disponivel: false,
    sessoes: resumoVazio(),
    por_tempo: baldesVazios(o.agora - o.janelaMs, o.janelaMs, o.baldes),
    agentes: [],
    fluxos: [],
    tarefas: {},
    notificacoes_nao_lidas: 0,
    ultima_atividade: null,
    erros_recentes: [],
  };
  const caminhoDb = join(ws.path, ".opencorp", "opencorp.db");
  if (!existsSync(caminhoDb)) return { analytics: base, linha: [] };

  let db: Database.Database | null = null;
  try {
    db = new Database(caminhoDb, { readonly: true, fileMustExist: true, timeout: 2000 });
    base.banco_disponivel = true;
    const desde = o.agora - o.janelaMs;
    const linha: EventoLinhaDoTempo[] = [];

    if (temTabela(db, "sessions")) {
      const r = db
        .prepare(
          `SELECT COUNT(*) AS total,
                  COALESCE(SUM(CASE WHEN status IN ('concluido','concluida') THEN 1 ELSE 0 END), 0) AS concluidas,
                  COALESCE(SUM(CASE WHEN status = 'falhou' THEN 1 ELSE 0 END), 0) AS falhas,
                  COALESCE(SUM(CASE WHEN status = 'cancelado' THEN 1 ELSE 0 END), 0) AS canceladas,
                  COALESCE(AVG(NULLIF(duracao_ms, 0)), 0) AS duracao_media_ms,
                  COALESCE(SUM(custo_micro_usd), 0) AS custo_micro
           FROM sessions WHERE inicio_ms >= ?`,
        )
        .get(desde) as { total: number; concluidas: number; falhas: number; canceladas: number; duracao_media_ms: number; custo_micro: number };
      const rodando = db
        .prepare(
          `SELECT COUNT(*) AS n FROM sessions WHERE fim_ms IS NULL AND status IN (${STATUS_EM_EXECUCAO.map(() => "?").join(",")}) AND inicio_ms >= ?`,
        )
        .get(...STATUS_EM_EXECUCAO, o.agora - LIMITE_ZUMBI_MS) as { n: number };
      base.sessoes = {
        total: r.total,
        concluidas: r.concluidas,
        falhas: r.falhas,
        canceladas: r.canceladas,
        executando: rodando.n,
        taxa_falha: r.total > 0 ? arredondar(r.falhas / r.total, 4) : 0,
        duracao_media_ms: Math.round(r.duracao_media_ms),
        custo_usd: arredondar(r.custo_micro / 1_000_000, 4),
      };

      const largura = o.janelaMs / o.baldes;
      const porBalde = db
        .prepare(
          `SELECT CAST((inicio_ms - ?) / ? AS INTEGER) AS b, COUNT(*) AS total,
                  SUM(CASE WHEN status = 'falhou' THEN 1 ELSE 0 END) AS falhas
           FROM sessions WHERE inicio_ms >= ? GROUP BY b`,
        )
        .all(desde, largura, desde) as Array<{ b: number; total: number; falhas: number }>;
      for (const linhaBalde of porBalde) {
        const i = Math.min(o.baldes - 1, Math.max(0, linhaBalde.b));
        base.por_tempo[i]!.total += linhaBalde.total;
        base.por_tempo[i]!.falhas += linhaBalde.falhas;
      }

      base.agentes = (
        db
          .prepare(
            `SELECT agente, COUNT(*) AS total, SUM(CASE WHEN status = 'falhou' THEN 1 ELSE 0 END) AS falhas,
                    COALESCE(SUM(custo_micro_usd), 0) AS custo_micro, COALESCE(AVG(NULLIF(duracao_ms, 0)), 0) AS duracao_media_ms
             FROM sessions WHERE inicio_ms >= ? GROUP BY agente ORDER BY total DESC LIMIT 8`,
          )
          .all(desde) as Array<{ agente: string | null; total: number; falhas: number; custo_micro: number; duracao_media_ms: number }>
      ).map((a) => ({
        agente: a.agente || "(sem agente)",
        total: a.total,
        falhas: a.falhas,
        custo_usd: arredondar(a.custo_micro / 1_000_000, 4),
        duracao_media_ms: Math.round(a.duracao_media_ms),
      }));

      base.erros_recentes = (
        db
          .prepare(`SELECT id, agente, inicio_ms, erro FROM sessions WHERE status = 'falhou' AND inicio_ms >= ? ORDER BY inicio_ms DESC LIMIT 5`)
          .all(desde) as Array<{ id: string; agente: string | null; inicio_ms: number; erro: string | null }>
      ).map((e) => ({ id: e.id, agente: e.agente || "(sem agente)", quando: new Date(e.inicio_ms).toISOString(), erro: (e.erro ?? "").slice(0, 240) }));

      const recentes = db
        .prepare(`SELECT id, agente, status, inicio_ms, erro FROM sessions ORDER BY inicio_ms DESC LIMIT ?`)
        .all(o.limiteLinhaDoTempo) as Array<{ id: string; agente: string | null; status: string; inicio_ms: number; erro: string | null }>;
      for (const s of recentes) {
        if (s.inicio_ms < desde) continue;
        linha.push({
          workspace: ws.id,
          quando: new Date(s.inicio_ms).toISOString(),
          tipo: "execucao",
          titulo: `@${s.agente || "agente"}`,
          status: s.status,
          detalhe: s.erro ? s.erro.slice(0, 160) : undefined,
        });
      }
      const ultima = db.prepare("SELECT MAX(inicio_ms) AS m FROM sessions").get() as { m: number | null };
      if (ultima.m) base.ultima_atividade = new Date(ultima.m).toISOString();
    }

    if (temTabela(db, "journal")) {
      const desdeIso = new Date(desde).toISOString();
      const corte = `rowid > (SELECT COALESCE(MAX(rowid), 0) FROM journal) - ${LINHAS_JOURNAL_RECENTES}`;
      const porFluxo = db
        .prepare(
          `SELECT registro_id AS flow, COUNT(*) AS execucoes,
                  SUM(CASE WHEN resumo LIKE '%falhou%' THEN 1 ELSE 0 END) AS falhas, MAX(ts) AS ultima
           FROM journal WHERE ${corte} AND categoria = 'flows' AND evento = 'execucao' AND ts >= ?
           GROUP BY registro_id ORDER BY execucoes DESC LIMIT 8`,
        )
        .all(desdeIso) as Array<{ flow: string; execucoes: number; falhas: number; ultima: string | null }>;
      const ultimoStatus = db.prepare(
        `SELECT resumo FROM journal WHERE ${corte} AND categoria = 'flows' AND evento = 'execucao' AND registro_id = ? ORDER BY ts DESC LIMIT 1`,
      );
      base.fluxos = porFluxo.map((f) => {
        const resumo = (ultimoStatus.get(f.flow) as { resumo: string } | undefined)?.resumo ?? "";
        return {
          flow: f.flow,
          execucoes: f.execucoes,
          falhas: f.falhas,
          ultima_execucao: f.ultima,
          ultimo_status: /falhou/.test(resumo) ? "falhou" : /concluido/.test(resumo) ? "concluido" : resumo || null,
        };
      });

      const eventosFluxo = db
        .prepare(
          `SELECT ts, registro_id, resumo FROM journal WHERE ${corte} AND categoria = 'flows' AND evento = 'execucao' AND ts >= ? ORDER BY ts DESC LIMIT ?`,
        )
        .all(desdeIso, o.limiteLinhaDoTempo) as Array<{ ts: string; registro_id: string; resumo: string }>;
      for (const e of eventosFluxo) {
        linha.push({
          workspace: ws.id,
          quando: e.ts,
          tipo: "fluxo",
          titulo: e.registro_id,
          status: /falhou/.test(e.resumo) ? "falhou" : "concluido",
          detalhe: e.resumo,
        });
      }
      const ultimoJournal = base.fluxos[0]?.ultima_execucao ?? null;
      if (ultimoJournal && (!base.ultima_atividade || ultimoJournal > base.ultima_atividade)) base.ultima_atividade = ultimoJournal;
    }

    if (temTabela(db, "tasks")) {
      for (const t of db.prepare("SELECT coluna, COUNT(*) AS n FROM tasks GROUP BY coluna").all() as Array<{ coluna: string; n: number }>) {
        base.tarefas[t.coluna || "(sem coluna)"] = t.n;
      }
    }
    if (temTabela(db, "notifications")) {
      const n = db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE lida = 0").get() as { n: number };
      base.notificacoes_nao_lidas = n.n;
    }
    return { analytics: base, linha };
  } catch {
    return { analytics: { ...base, banco_disponivel: false }, linha: [] };
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export function coletarAnalytics(workspaces: WorkspaceAnalyticsEntrada[], opcoes: OpcoesAnalytics): AnalyticsResumo {
  const agora = opcoes.agora ?? Date.now();
  const o = { janelaMs: opcoes.janelaMs, agora, baldes: opcoes.baldes ?? 24, limiteLinhaDoTempo: opcoes.limiteLinhaDoTempo ?? 40 };
  const lidos = workspaces.map((ws) => lerWorkspace(ws, o));
  const lista = lidos.map((l) => l.analytics);

  const totais: TotaisAnalytics = { ...resumoVazio(), workspaces: lista.length, pausados: 0, tarefas_abertas: 0, notificacoes_nao_lidas: 0 };
  let somaDuracao = 0;
  let pesoDuracao = 0;
  const porTempo = baldesVazios(agora - o.janelaMs, o.janelaMs, o.baldes);
  for (const w of lista) {
    totais.total += w.sessoes.total;
    totais.concluidas += w.sessoes.concluidas;
    totais.falhas += w.sessoes.falhas;
    totais.canceladas += w.sessoes.canceladas;
    totais.executando += w.sessoes.executando;
    totais.custo_usd += w.sessoes.custo_usd;
    somaDuracao += w.sessoes.duracao_media_ms * w.sessoes.total;
    pesoDuracao += w.sessoes.total;
    if (w.pausado) totais.pausados += 1;
    totais.notificacoes_nao_lidas += w.notificacoes_nao_lidas;
    for (const [coluna, n] of Object.entries(w.tarefas)) if (!COLUNAS_TAREFA_ENCERRADAS.has(coluna)) totais.tarefas_abertas += n;
    w.por_tempo.forEach((b, i) => {
      porTempo[i]!.total += b.total;
      porTempo[i]!.falhas += b.falhas;
    });
  }
  totais.custo_usd = arredondar(totais.custo_usd, 4);
  totais.duracao_media_ms = pesoDuracao > 0 ? Math.round(somaDuracao / pesoDuracao) : 0;
  totais.taxa_falha = totais.total > 0 ? arredondar(totais.falhas / totais.total, 4) : 0;

  const linhaDoTempo = lidos
    .flatMap((l) => l.linha)
    .sort((a, b) => b.quando.localeCompare(a.quando))
    .slice(0, o.limiteLinhaDoTempo);

  return { gerado_em: new Date(agora).toISOString(), janela_ms: o.janelaMs, totais, por_tempo: porTempo, workspaces: lista, linha_do_tempo: linhaDoTempo };
}

export const JANELAS_ANALYTICS_MS: Record<string, number> = {
  "1h": 3_600_000,
  "6h": 6 * 3_600_000,
  "24h": 24 * 3_600_000,
  "7d": 7 * 24 * 3_600_000,
};
