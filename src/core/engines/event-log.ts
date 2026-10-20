import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "./events.js";

/**
 * Log JSONL por conversa com os `AgentEvent` canônicos. É a fonte única do histórico do Secretário:
 * independe do motor (claude-sdk, opencode, harness futuro), porque guarda o que o servidor já normalizou.
 */
export type EntradaLog =
  | { t: string; tipo: "user"; text: string }
  | { t: string; tipo: "evento"; ev: AgentEvent; resumo?: string };

export type StatusAprovacao = "pendente" | "aprovado" | "rejeitado" | "expirada";

export interface AcaoHistorico {
  ferramenta: string;
  resumo: string;
  status: "running" | "completed" | "failed";
  sucesso: boolean;
}

export interface AprovacaoHistorico {
  id: string;
  acao: string;
  descricao: string;
  status: StatusAprovacao;
  /** Preenchido pela rota de histórico: o cartão precisa dele para decidir. */
  workspace?: string;
}

/** Mesmo formato que `/secretario/sessoes/:id/mensagens` já devolve, acrescido de `aprovacoes`. */
export interface MensagemHistorico {
  id: string;
  role: "user" | "assistant";
  content: string;
  criado_em: string;
  acoes?: AcaoHistorico[];
  aprovacoes?: AprovacaoHistorico[];
}

function nomeSeguro(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Assinante de uma conversa: recebe cada entrada gravada (com o índice dela no log) e o fim do turno. */
export interface AssinanteLog {
  entrada: (entrada: EntradaLog, indice: number) => void;
  fimTurno?: () => void;
}

interface EstadoConversa {
  assinantes: Set<AssinanteLog>;
  /** Nº de entradas já gravadas; só é mantido enquanto há assinantes (senão relê o arquivo ao precisar). */
  total?: number;
  /** Serializa `anexar` da mesma conversa para que ordem do arquivo e índice emitido coincidam. */
  fila: Promise<void>;
}

/** Emissor em memória: compartilhado entre instâncias de `EventLog` do mesmo processo. */
const conversas = new Map<string, EstadoConversa>();

export class EventLog {
  constructor(private readonly home: string) {}

  private chave(workspaceId: string, sessaoId: string): string {
    return `${this.home}\u0000${nomeSeguro(workspaceId)}\u0000${nomeSeguro(sessaoId)}`;
  }

  /**
   * Acompanha as entradas gravadas da conversa. Assine ANTES de `ler` o backlog e descarte as entradas com
   * índice já enviado: assim nada se perde nem duplica. Devolve a função que cancela a assinatura.
   */
  assinar(workspaceId: string, sessaoId: string, assinante: AssinanteLog | ((e: EntradaLog, indice: number) => void)): () => void {
    const chave = this.chave(workspaceId, sessaoId);
    const a: AssinanteLog = typeof assinante === "function" ? { entrada: assinante } : assinante;
    let est = conversas.get(chave);
    if (!est) {
      est = { assinantes: new Set(), fila: Promise.resolve() };
      conversas.set(chave, est);
    }
    est.assinantes.add(a);
    return () => {
      const atual = conversas.get(chave);
      if (!atual) return;
      atual.assinantes.delete(a);
      if (atual.assinantes.size === 0) {
        atual.total = undefined;
        // Mantém a entrada enquanto houver anexar em voo; ela se limpa sozinha ao terminar.
        const fila = atual.fila;
        void fila.then(() => {
          if (conversas.get(chave) === atual && atual.fila === fila && atual.assinantes.size === 0) conversas.delete(chave);
        });
      }
    };
  }

  /** Avisa os assinantes de que o turno da conversa terminou (depois de gravadas todas as entradas em voo). */
  async encerrarTurno(workspaceId: string, sessaoId: string): Promise<void> {
    const est = conversas.get(this.chave(workspaceId, sessaoId));
    if (!est) return;
    await est.fila;
    for (const a of [...est.assinantes]) {
      try { a.fimTurno?.(); } catch { /* assinante com defeito não derruba os outros */ }
    }
  }

  private dir(workspaceId: string): string {
    return join(this.home, ".opencorp", "secretario-log", nomeSeguro(workspaceId));
  }

  private arquivo(workspaceId: string, sessaoId: string): string {
    return join(this.dir(workspaceId), `${nomeSeguro(sessaoId)}.jsonl`);
  }

  async anexar(workspaceId: string, sessaoId: string, entrada: EntradaLog): Promise<void> {
    const chave = this.chave(workspaceId, sessaoId);
    let est = conversas.get(chave);
    if (!est) {
      est = { assinantes: new Set(), fila: Promise.resolve() };
      conversas.set(chave, est);
    }
    const estado = est;
    const gravacao = estado.fila.then(async () => {
      await mkdir(this.dir(workspaceId), { recursive: true });
      await appendFile(this.arquivo(workspaceId, sessaoId), `${JSON.stringify(entrada)}\n`, "utf8");
      if (estado.assinantes.size === 0) {
        estado.total = undefined;
        return;
      }
      estado.total = estado.total === undefined ? (await this.ler(workspaceId, sessaoId)).length : estado.total + 1;
      const indice = estado.total - 1;
      for (const a of [...estado.assinantes]) {
        try { a.entrada(entrada, indice); } catch { /* idem */ }
      }
    });
    const minhaFila: Promise<void> = gravacao.catch(() => undefined).then(() => {
      if (conversas.get(chave) === estado && estado.fila === minhaFila && estado.assinantes.size === 0) conversas.delete(chave);
    });
    estado.fila = minhaFila;
    await gravacao;
  }

  async ler(workspaceId: string, sessaoId: string): Promise<EntradaLog[]> {
    let bruto: string;
    try {
      bruto = await readFile(this.arquivo(workspaceId, sessaoId), "utf8");
    } catch {
      return [];
    }
    const saida: EntradaLog[] = [];
    for (const linha of bruto.split("\n")) {
      if (!linha.trim()) continue;
      try {
        saida.push(JSON.parse(linha) as EntradaLog);
      } catch {
        continue;
      }
    }
    return saida;
  }

  /** Acha a conversa que pediu a aprovação e registra a decisão nela. Devolve false se não achar. */
  async registrarAprovacaoResolvida(
    workspaceId: string,
    approvalId: string,
    decision: "approved" | "rejected" | "expired",
  ): Promise<boolean> {
    let arquivos: string[];
    try {
      arquivos = await readdir(this.dir(workspaceId));
    } catch {
      return false;
    }
    for (const f of arquivos.filter((a) => a.endsWith(".jsonl"))) {
      const sessaoId = f.slice(0, -".jsonl".length);
      const entradas = await this.ler(workspaceId, sessaoId);
      const pedido = entradas.find(
        (e) => e.tipo === "evento" && e.ev.type === "approval.requested" && e.ev.approval.id === approvalId,
      );
      if (!pedido || pedido.tipo !== "evento") continue;
      await this.anexar(workspaceId, sessaoId, {
        t: new Date().toISOString(),
        tipo: "evento",
        ev: { type: "approval.resolved", runId: pedido.ev.runId, approvalId, decision },
      });
      return true;
    }
    return false;
  }
}

/**
 * Reduz o log em mensagens. `ativa` diz se há um stream aberto agora: sem ele (ou depois que
 * a conversa seguiu em frente), uma aprovação sem decisão virou "expirada", nunca "pendente".
 */
export function reduzirHistorico(entradas: EntradaLog[], ativa: boolean): MensagemHistorico[] {
  const msgs: MensagemHistorico[] = [];
  let atual: MensagemHistorico | undefined;
  const ferramentas = new Map<string, AcaoHistorico>();
  const aprovacoes = new Map<string, AprovacaoHistorico>();

  const garantirAssistente = (t: string): MensagemHistorico => {
    if (!atual) {
      atual = { id: `a${msgs.length}`, role: "assistant", content: "", criado_em: t, acoes: [], aprovacoes: [] };
      msgs.push(atual);
    }
    return atual;
  };

  for (const e of entradas) {
    if (e.tipo === "user") {
      atual = undefined;
      msgs.push({ id: `u${msgs.length}`, role: "user", content: e.text, criado_em: e.t });
      continue;
    }
    const ev = e.ev;
    if (ev.type === "message.delta") {
      garantirAssistente(e.t).content += ev.text;
    } else if (ev.type === "tool.requested") {
      const acao: AcaoHistorico = { ferramenta: ev.call.name, resumo: e.resumo ?? ev.call.name, status: "running", sucesso: true };
      ferramentas.set(ev.call.id, acao);
      garantirAssistente(e.t).acoes!.push(acao);
    } else if (ev.type === "tool.completed") {
      const acao = ferramentas.get(ev.result.id);
      if (acao) {
        acao.status = ev.result.isError ? "failed" : "completed";
        acao.sucesso = !ev.result.isError;
      }
    } else if (ev.type === "approval.requested") {
      const ap: AprovacaoHistorico = {
        id: ev.approval.id,
        acao: ev.approval.action,
        descricao: ev.approval.description,
        status: "pendente",
      };
      aprovacoes.set(ap.id, ap);
      garantirAssistente(e.t).aprovacoes!.push(ap);
    } else if (ev.type === "approval.resolved") {
      const ap = aprovacoes.get(ev.approvalId);
      if (ap) ap.status = ev.decision === "approved" ? "aprovado" : ev.decision === "rejected" ? "rejeitado" : "expirada";
    } else if (ev.type === "run.completed") {
      const a = garantirAssistente(e.t);
      if (!a.content && ev.result.output) a.content = ev.result.output;
    }
  }

  const ultimaAssistente = [...msgs].reverse().find((m) => m.role === "assistant");
  for (const m of msgs) {
    for (const ap of m.aprovacoes ?? []) {
      if (ap.status === "pendente" && !(ativa && m === ultimaAssistente && m === msgs[msgs.length - 1])) {
        ap.status = "expirada";
      }
    }
  }
  return msgs;
}
