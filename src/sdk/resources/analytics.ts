/**
 * @module sdk/resources/analytics — Analytics unificado de todos os workspaces.
 */

import type { HttpClient, RequestOptions } from "../http-client.js";

export type JanelaAnalytics = "1h" | "6h" | "24h" | "7d";

export interface AnalyticsResumoSessoes {
  total: number;
  concluidas: number;
  falhas: number;
  canceladas: number;
  executando: number;
  taxa_falha: number;
  duracao_media_ms: number;
  custo_usd: number;
}

export interface AnalyticsBalde {
  inicio: number;
  total: number;
  falhas: number;
}

export interface AnalyticsWorkspace {
  id: string;
  nome: string;
  pausado: boolean;
  pausado_em: string | null;
  banco_disponivel: boolean;
  sessoes: AnalyticsResumoSessoes;
  por_tempo: AnalyticsBalde[];
  agentes: Array<{ agente: string; total: number; falhas: number; custo_usd: number; duracao_media_ms: number }>;
  fluxos: Array<{ flow: string; execucoes: number; falhas: number; ultima_execucao: string | null; ultimo_status: string | null }>;
  tarefas: Record<string, number>;
  notificacoes_nao_lidas: number;
  ultima_atividade: string | null;
  erros_recentes: Array<{ id: string; agente: string; quando: string; erro: string }>;
}

export interface AnalyticsEvento {
  workspace: string;
  quando: string;
  tipo: "execucao" | "fluxo";
  titulo: string;
  status: string;
  detalhe?: string;
}

export interface AnalyticsServicos {
  servidor: { rodando: boolean; pid: number; porta: number | null; versao: string | null; uptime_s: number; memoria_mb: number };
  agendador: { rodando: boolean; pid: number | null };
  secretario: { rodando: boolean };
}

export interface AnalyticsResposta {
  gerado_em: string;
  janela_ms: number;
  totais: AnalyticsResumoSessoes & {
    workspaces: number;
    pausados: number;
    tarefas_abertas: number;
    notificacoes_nao_lidas: number;
  };
  por_tempo: AnalyticsBalde[];
  workspaces: AnalyticsWorkspace[];
  linha_do_tempo: AnalyticsEvento[];
  disponiveis: Array<{ id: string; nome: string; pausado: boolean }>;
  selecionados: string[];
  servicos: AnalyticsServicos;
}

export class AnalyticsResource {
  constructor(private readonly http: HttpClient) {}

  /** GET /analytics/resumo — `ws` vazio = todos os workspaces. */
  async resumo(
    filtro: { ws?: string[]; janela?: JanelaAnalytics } = {},
    opts?: RequestOptions,
  ): Promise<AnalyticsResposta> {
    const params = new URLSearchParams();
    if (filtro.ws && filtro.ws.length > 0) params.set("ws", filtro.ws.join(","));
    if (filtro.janela) params.set("janela", filtro.janela);
    const qs = params.toString();
    return this.http.get<AnalyticsResposta>(`/analytics/resumo${qs ? `?${qs}` : ""}`, opts);
  }
}
