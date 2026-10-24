import React, { useCallback, useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertTriangle,
  Bell,
  CheckCircle2,
  CircleDollarSign,
  Cpu,
  ListChecks,
  Pause,
  PlayCircle,
  RefreshCw,
  Server,
  Timer,
  Workflow,
  XCircle,
} from "lucide-react";
import type { AnalyticsEvento, AnalyticsResposta, AnalyticsWorkspace, JanelaAnalytics } from "@opencorp/sdk";
import { useOpenCorp, extrairWorkspaceDoEventoSse } from "../../../providers/OpenCorpProvider.js";
import { workspacePath } from "../../../lib/routes.js";
import { formatarDataHoraCompleta, formatarDuracao, tempoDesde } from "../../../lib/format.js";

const JANELAS: ReadonlyArray<{ id: JanelaAnalytics; rotulo: string }> = [
  { id: "1h", rotulo: "1 h" },
  { id: "6h", rotulo: "6 h" },
  { id: "24h", rotulo: "24 h" },
  { id: "7d", rotulo: "7 dias" },
];
const CHAVE_SELECAO = "oc-analytics-ws";
const CHAVE_JANELA = "oc-analytics-janela";
const INTERVALO_MS = 10_000;

interface EventoAoVivo {
  chave: string;
  workspace: string;
  quando: string;
  titulo: string;
  status: string;
  detalhe?: string;
}

function lerLocal<T>(chave: string, padrao: T): T {
  try {
    const bruto = localStorage.getItem(chave);
    return bruto ? (JSON.parse(bruto) as T) : padrao;
  } catch {
    return padrao;
  }
}

function gravarLocal(chave: string, valor: unknown): void {
  try {
    localStorage.setItem(chave, JSON.stringify(valor));
  } catch {}
}

const percentual = (n: number): string => `${(n * 100).toFixed(n > 0 && n < 0.1 ? 1 : 0)}%`;
const dolar = (n: number): string => `US$ ${n.toFixed(n >= 10 ? 1 : 2)}`;

const COR_STATUS: Record<string, string> = {
  concluido: "text-emerald-300 bg-emerald-950/40 border-emerald-800/40",
  concluida: "text-emerald-300 bg-emerald-950/40 border-emerald-800/40",
  falhou: "text-rose-300 bg-rose-950/40 border-rose-800/40",
  cancelado: "text-zinc-300 bg-zinc-800/60 border-zinc-700/60",
  pendente: "text-sky-300 bg-sky-950/40 border-sky-800/40",
  executando: "text-sky-300 bg-sky-950/40 border-sky-800/40",
};

const Selo: FC<{ status: string }> = ({ status }) => (
  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${COR_STATUS[status] ?? "text-zinc-300 bg-zinc-800/60 border-zinc-700/60"}`}>
    {status}
  </span>
);

const Cartao: FC<{ titulo: string; icone: ReactNode; valor: string; detalhe?: string; alerta?: boolean }> = ({ titulo, icone, valor, detalhe, alerta }) => (
  <div className={`rounded-xl border p-3.5 bg-zinc-900/60 ${alerta ? "border-rose-800/50" : "border-zinc-800"}`}>
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-zinc-500">
      {icone}
      <span>{titulo}</span>
    </div>
    <div className={`mt-1.5 text-2xl font-semibold font-mono ${alerta ? "text-rose-300" : "text-zinc-100"}`}>{valor}</div>
    {detalhe && <div className="mt-0.5 text-[11px] text-zinc-500">{detalhe}</div>}
  </div>
);

const Secao: FC<{ titulo: string; icone?: ReactNode; extra?: ReactNode; children: ReactNode }> = ({ titulo, icone, extra, children }) => (
  <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
    <header className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-zinc-800/80">
      <h2 className="flex items-center gap-2 text-xs font-semibold text-zinc-300 uppercase tracking-wider">
        {icone}
        {titulo}
      </h2>
      {extra}
    </header>
    <div className="p-4">{children}</div>
  </section>
);

const Grafico: FC<{ baldes: AnalyticsResposta["por_tempo"]; janelaMs: number }> = ({ baldes, janelaMs }) => {
  const maximo = Math.max(1, ...baldes.map((b) => b.total));
  const largura = 100 / baldes.length;
  const passo = janelaMs / baldes.length;
  const formatarHora = (ms: number) =>
    new Date(ms).toLocaleString("pt-BR", janelaMs > 36 * 3_600_000 ? { day: "2-digit", month: "2-digit", hour: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  return (
    <div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="w-full h-36" role="img" aria-label="Execuções ao longo do tempo">
        {baldes.map((b, i) => {
          const alturaTotal = (b.total / maximo) * 38;
          const alturaFalha = (b.falhas / maximo) * 38;
          const x = i * largura + largura * 0.12;
          const w = largura * 0.76;
          return (
            <g key={b.inicio}>
              <title>{`${formatarHora(b.inicio)}: ${b.total} execuções, ${b.falhas} falhas`}</title>
              <rect x={x} y={39 - alturaTotal} width={w} height={Math.max(alturaTotal - alturaFalha, 0)} className="fill-emerald-500/70" />
              <rect x={x} y={39 - alturaFalha} width={w} height={alturaFalha} className="fill-rose-500/80" />
            </g>
          );
        })}
        <line x1="0" y1="39" x2="100" y2="39" className="stroke-zinc-700" strokeWidth="0.3" />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-500 font-mono mt-1">
        <span>{formatarHora(baldes[0]?.inicio ?? 0)}</span>
        <span>pico: {maximo} por {formatarDuracao(passo).replace(/ 0s$/, "")}</span>
        <span>agora</span>
      </div>
      <div className="flex gap-3 text-[10px] text-zinc-500 mt-1">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-emerald-500/70" />ok</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-rose-500/80" />falhas</span>
      </div>
    </div>
  );
};

export const AnalyticsView: FC = () => {
  const { client, tratarErro } = useOpenCorp();
  const [dados, setDados] = useState<AnalyticsResposta | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [atualizando, setAtualizando] = useState(false);
  const [selecionados, setSelecionados] = useState<string[]>(() => lerLocal<string[]>(CHAVE_SELECAO, []));
  const [janela, setJanela] = useState<JanelaAnalytics>(() => lerLocal<JanelaAnalytics>(CHAVE_JANELA, "24h"));
  const [aoVivo, setAoVivo] = useState<EventoAoVivo[]>([]);
  const [sseOk, setSseOk] = useState(false);
  const [agora, setAgora] = useState(() => Date.now());
  const emVoo = useRef(false);

  const carregar = useCallback(
    async (silencioso = false) => {
      if (emVoo.current) return;
      emVoo.current = true;
      if (!silencioso) setCarregando(true);
      else setAtualizando(true);
      try {
        const resposta = await client.analytics.resumo({ ws: selecionados, janela });
        setDados(resposta);
        setErro(null);
      } catch (e: unknown) {
        setErro(e instanceof Error ? e.message : "Falha ao carregar analytics");
        if (!silencioso) tratarErro(e, "Falha ao carregar analytics");
      } finally {
        emVoo.current = false;
        setCarregando(false);
        setAtualizando(false);
      }
    },
    [client, selecionados, janela, tratarErro],
  );

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Atualização periódica (só com a aba visível) e relógio dos "há X".
  useEffect(() => {
    const timer = setInterval(() => {
      setAgora(Date.now());
      if (document.visibilityState === "visible") void carregar(true);
    }, INTERVALO_MS);
    return () => clearInterval(timer);
  }, [carregar]);

  // Eventos ao vivo (SSE global): entram na linha do tempo e antecipam uma nova leitura.
  const selecionadosRef = useRef(selecionados);
  selecionadosRef.current = selecionados;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const token = localStorage.getItem("oc-token") || localStorage.getItem("opencorp_token") || "";
    let fonte: EventSource | null = null;
    let adiar: ReturnType<typeof setTimeout> | null = null;
    try {
      fonte = new EventSource(token ? `/events?token=${encodeURIComponent(token)}` : "/events");
    } catch {
      return;
    }
    fonte.onopen = () => setSseOk(true);
    fonte.onerror = () => setSseOk(false);
    fonte.onmessage = (e: MessageEvent) => {
      try {
        const bruto = JSON.parse(e.data) as Record<string, unknown>;
        const ws = extrairWorkspaceDoEventoSse(bruto) ?? "—";
        const escolhidos = selecionadosRef.current;
        if (escolhidos.length > 0 && ws !== "—" && !escolhidos.includes(ws)) return;
        const dadosEvento = (typeof bruto.dados === "object" && bruto.dados !== null ? bruto.dados : bruto) as Record<string, unknown>;
        const tipo = typeof bruto.tipo === "string" ? bruto.tipo : "evento";
        if (tipo === "conectado" || tipo === "heartbeat") return;
        const titulo = typeof dadosEvento.agente === "string" ? `@${dadosEvento.agente}` : tipo;
        const status = typeof dadosEvento.status === "string" ? dadosEvento.status : tipo;
        const detalhe = typeof dadosEvento.resumo === "string" ? dadosEvento.resumo : typeof dadosEvento.titulo === "string" ? dadosEvento.titulo : undefined;
        setAoVivo((prev) =>
          [{ chave: `${Date.now()}-${Math.random()}`, workspace: ws, quando: new Date().toISOString(), titulo, status, detalhe }, ...prev].slice(0, 30),
        );
        if (adiar) clearTimeout(adiar);
        adiar = setTimeout(() => void carregar(true), 1500);
      } catch {}
    };
    return () => {
      if (adiar) clearTimeout(adiar);
      fonte?.close();
      setSseOk(false);
    };
  }, [carregar]);

  const alternarWorkspace = (id: string) => {
    setSelecionados((prev) => {
      const proximo = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      gravarLocal(CHAVE_SELECAO, proximo);
      return proximo;
    });
  };
  const todosSelecionados = selecionados.length === 0;

  const escolherJanela = (id: JanelaAnalytics) => {
    setJanela(id);
    gravarLocal(CHAVE_JANELA, id);
  };

  const linhaDoTempo = useMemo(() => {
    const doServidor: EventoAoVivo[] = (dados?.linha_do_tempo ?? []).map((e: AnalyticsEvento) => ({
      chave: `${e.workspace}-${e.quando}-${e.titulo}`,
      workspace: e.workspace,
      quando: e.quando,
      titulo: e.titulo,
      status: e.status,
      detalhe: e.detalhe,
    }));
    return [...aoVivo.map((e) => ({ ...e, vivo: true })), ...doServidor.map((e) => ({ ...e, vivo: false }))].slice(0, 60);
  }, [dados, aoVivo]);

  const agentes = useMemo(() => {
    const mapa = new Map<string, { total: number; falhas: number; custo: number }>();
    for (const w of dados?.workspaces ?? []) {
      for (const a of w.agentes) {
        const atual = mapa.get(a.agente) ?? { total: 0, falhas: 0, custo: 0 };
        mapa.set(a.agente, { total: atual.total + a.total, falhas: atual.falhas + a.falhas, custo: atual.custo + a.custo_usd });
      }
    }
    return [...mapa.entries()].map(([agente, v]) => ({ agente, ...v })).sort((a, b) => b.total - a.total).slice(0, 8);
  }, [dados]);

  const fluxos = useMemo(
    () =>
      (dados?.workspaces ?? [])
        .flatMap((w: AnalyticsWorkspace) => w.fluxos.map((f) => ({ ...f, workspace: w.nome })))
        .sort((a, b) => b.execucoes - a.execucoes)
        .slice(0, 12),
    [dados],
  );

  const erros = useMemo(
    () =>
      (dados?.workspaces ?? [])
        .flatMap((w) => w.erros_recentes.map((e) => ({ ...e, workspace: w.nome })))
        .sort((a, b) => b.quando.localeCompare(a.quando))
        .slice(0, 8),
    [dados],
  );

  const t = dados?.totais;
  const servicos = dados?.servicos;

  return (
    <div className="h-full w-full overflow-y-auto p-3 sm:p-5 space-y-4 select-text" data-testid="analytics-view">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100 flex items-center gap-2">
            <Activity size={18} className="text-emerald-400" />
            Analytics
          </h1>
          <p className="text-xs text-zinc-500">Tudo o que roda nos seus projetos, numa página só.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={`flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border ${
              sseOk ? "bg-emerald-950/30 border-emerald-800/50 text-emerald-300" : "bg-zinc-900/60 border-zinc-800 text-zinc-400"
            }`}
            title={sseOk ? "Eventos em tempo real conectados" : "Sem stream; atualizando a cada 10 s"}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${sseOk ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"}`} />
            {sseOk ? "ao vivo" : "a cada 10 s"}
          </span>
          <div className="flex rounded-lg border border-zinc-800 overflow-hidden" role="group" aria-label="Janela de tempo">
            {JANELAS.map((j) => (
              <button
                key={j.id}
                type="button"
                onClick={() => escolherJanela(j.id)}
                className={`px-2.5 py-1.5 text-[11px] font-mono cursor-pointer transition-colors ${
                  janela === j.id ? "bg-emerald-600/20 text-emerald-300" : "bg-zinc-900/60 text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {j.rotulo}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void carregar(true)}
            className="p-2 rounded-lg border border-zinc-800 bg-zinc-900/60 text-zinc-400 hover:text-zinc-100 cursor-pointer"
            title="Atualizar agora"
            aria-label="Atualizar agora"
          >
            <RefreshCw size={14} className={atualizando ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Projetos">
        <button
          type="button"
          onClick={() => {
            setSelecionados([]);
            gravarLocal(CHAVE_SELECAO, []);
          }}
          aria-pressed={todosSelecionados}
          className={`px-3 py-1.5 rounded-full border text-xs cursor-pointer transition-colors ${
            todosSelecionados ? "bg-emerald-600/20 border-emerald-700/60 text-emerald-300" : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200"
          }`}
        >
          Todos os projetos{dados ? ` (${dados.disponiveis.length})` : ""}
        </button>
        {(dados?.disponiveis ?? []).map((w) => {
          const ligado = selecionados.includes(w.id);
          return (
            <button
              key={w.id}
              type="button"
              onClick={() => alternarWorkspace(w.id)}
              aria-pressed={ligado}
              className={`px-3 py-1.5 rounded-full border text-xs cursor-pointer transition-colors flex items-center gap-1.5 ${
                ligado ? "bg-emerald-600/20 border-emerald-700/60 text-emerald-300" : "bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {w.pausado && <Pause size={11} className="text-amber-400" />}
              {w.nome}
            </button>
          );
        })}
      </div>

      {erro && (
        <div className="rounded-lg border border-rose-800/50 bg-rose-950/30 px-3 py-2 text-xs text-rose-300 flex items-center gap-2">
          <AlertTriangle size={14} />
          {erro}
        </div>
      )}

      {carregando && !dados ? (
        <div className="text-xs text-zinc-500 py-10 text-center">Carregando analytics…</div>
      ) : (
        t && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <Cartao titulo="Execuções" icone={<Cpu size={12} />} valor={String(t.total)} detalhe={`${t.concluidas} concluídas`} />
              <Cartao titulo="Falhas" icone={<XCircle size={12} />} valor={String(t.falhas)} detalhe={`${percentual(t.taxa_falha)} das execuções`} alerta={t.taxa_falha >= 0.1} />
              <Cartao titulo="Rodando agora" icone={<PlayCircle size={12} />} valor={String(t.executando)} detalhe={`duração média ${formatarDuracao(t.duracao_media_ms)}`} />
              <Cartao titulo="Custo" icone={<CircleDollarSign size={12} />} valor={dolar(t.custo_usd)} detalhe="no período" />
              <Cartao titulo="Tarefas abertas" icone={<ListChecks size={12} />} valor={String(t.tarefas_abertas)} detalhe="fora de feito/publicado/descartado" />
              <Cartao titulo="Notificações" icone={<Bell size={12} />} valor={String(t.notificacoes_nao_lidas)} detalhe="não lidas" />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              <div className="xl:col-span-2 space-y-4">
                <Secao titulo="Execuções ao longo do tempo" icone={<Timer size={13} />}>
                  <Grafico baldes={dados!.por_tempo} janelaMs={dados!.janela_ms} />
                </Secao>

                <Secao titulo="Projetos" icone={<Activity size={13} />} extra={<span className="text-[11px] text-zinc-500">{t.workspaces} no total · {t.pausados} pausado(s)</span>}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-[10px] uppercase tracking-wider text-zinc-500">
                          <th className="pb-2 pr-3 font-medium">Projeto</th>
                          <th className="pb-2 pr-3 font-medium">Estado</th>
                          <th className="pb-2 pr-3 font-medium text-right">Exec.</th>
                          <th className="pb-2 pr-3 font-medium text-right">Falhas</th>
                          <th className="pb-2 pr-3 font-medium text-right">Rodando</th>
                          <th className="pb-2 pr-3 font-medium text-right">Custo</th>
                          <th className="pb-2 font-medium">Última atividade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dados!.workspaces.map((w) => (
                          <tr key={w.id} className="border-t border-zinc-800/70">
                            <td className="py-2 pr-3">
                              <Link to={workspacePath(w.id)} className="text-zinc-200 hover:text-emerald-300 font-medium">{w.nome}</Link>
                              <div className="text-[10px] text-zinc-500 font-mono">{w.id}</div>
                            </td>
                            <td className="py-2 pr-3">
                              {w.pausado ? (
                                <span
                                  title={w.pausado_em ? `Pausado em ${formatarDataHoraCompleta(w.pausado_em)}` : "Pausado (horário não registrado)"}
                                  className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40"
                                >
                                  <Pause size={10} />
                                  {w.pausado_em ? `pausado ${tempoDesde(w.pausado_em, agora)}` : "pausado"}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-950/40 text-emerald-300 border border-emerald-800/40">
                                  <CheckCircle2 size={10} />
                                  ativo
                                </span>
                              )}
                              {!w.banco_disponivel && <span className="ml-1 text-[10px] text-zinc-500">sem banco</span>}
                            </td>
                            <td className="py-2 pr-3 text-right font-mono text-zinc-200">{w.sessoes.total}</td>
                            <td className={`py-2 pr-3 text-right font-mono ${w.sessoes.falhas > 0 ? "text-rose-300" : "text-zinc-500"}`}>{w.sessoes.falhas}</td>
                            <td className="py-2 pr-3 text-right font-mono text-sky-300">{w.sessoes.executando}</td>
                            <td className="py-2 pr-3 text-right font-mono text-zinc-300">{dolar(w.sessoes.custo_usd)}</td>
                            <td className="py-2 text-zinc-400" title={w.ultima_atividade ? formatarDataHoraCompleta(w.ultima_atividade) : undefined}>
                              {w.ultima_atividade ? tempoDesde(w.ultima_atividade, agora) : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Secao>

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Secao titulo="Fluxos" icone={<Workflow size={13} />}>
                    {fluxos.length === 0 ? (
                      <p className="text-xs text-zinc-500">Nenhum fluxo rodou neste período.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {fluxos.map((f) => (
                          <li key={`${f.workspace}-${f.flow}`} className="flex items-center justify-between gap-2 text-xs">
                            <span className="min-w-0 truncate text-zinc-200" title={`${f.flow} · ${f.workspace}`}>
                              {f.flow}
                              <span className="ml-1.5 text-[10px] text-zinc-500">{f.workspace}</span>
                            </span>
                            <span className="flex items-center gap-2 shrink-0 font-mono">
                              <span className="text-zinc-300">{f.execucoes}×</span>
                              {f.falhas > 0 && <span className="text-rose-300">{f.falhas} falha(s)</span>}
                              {f.ultima_execucao && <span className="text-zinc-500">{tempoDesde(f.ultima_execucao, agora)}</span>}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Secao>

                  <Secao titulo="Agentes mais ativos" icone={<Cpu size={13} />}>
                    {agentes.length === 0 ? (
                      <p className="text-xs text-zinc-500">Nenhum agente rodou neste período.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {agentes.map((a) => (
                          <li key={a.agente} className="flex items-center justify-between gap-2 text-xs">
                            <span className="truncate text-zinc-200">@{a.agente}</span>
                            <span className="flex items-center gap-2 shrink-0 font-mono">
                              <span className="text-zinc-300">{a.total}×</span>
                              {a.falhas > 0 && <span className="text-rose-300">{a.falhas} falha(s)</span>}
                              <span className="text-zinc-500">{dolar(a.custo)}</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Secao>
                </div>
              </div>

              <div className="space-y-4">
                <Secao titulo="Serviços" icone={<Server size={13} />}>
                  <ul className="space-y-2 text-xs">
                    <li className="flex items-center justify-between">
                      <span className="text-zinc-300">Servidor</span>
                      <span className="text-emerald-300 font-mono">
                        rodando · {formatarDuracao((servicos?.servidor.uptime_s ?? 0) * 1000)} · {servicos?.servidor.memoria_mb} MB
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span className="text-zinc-300">Agendador</span>
                      <span className={`font-mono ${servicos?.agendador.rodando ? "text-emerald-300" : "text-rose-300"}`}>
                        {servicos?.agendador.rodando ? `rodando · pid ${servicos.agendador.pid}` : "parado"}
                      </span>
                    </li>
                    <li className="flex items-center justify-between">
                      <span className="text-zinc-300">Secretário</span>
                      <span className={`font-mono ${servicos?.secretario.rodando ? "text-emerald-300" : "text-zinc-500"}`}>
                        {servicos?.secretario.rodando ? "rodando" : "desligado"}
                      </span>
                    </li>
                    {dados!.workspaces.map((w) => (
                      <li key={w.id} className="flex items-center justify-between border-t border-zinc-800/70 pt-2">
                        <span className="text-zinc-400 truncate">{w.nome}</span>
                        <span className={`font-mono ${w.pausado ? "text-amber-300" : "text-emerald-300"}`}>{w.pausado ? "pausado" : "disparando fluxos"}</span>
                      </li>
                    ))}
                  </ul>
                </Secao>

                <Secao titulo="Erros recentes" icone={<AlertTriangle size={13} />}>
                  {erros.length === 0 ? (
                    <p className="text-xs text-zinc-500">Sem falhas neste período.</p>
                  ) : (
                    <ul className="space-y-2">
                      {erros.map((e) => (
                        <li key={e.id} className="text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-zinc-200 truncate">@{e.agente}<span className="ml-1.5 text-[10px] text-zinc-500">{e.workspace}</span></span>
                            <span className="text-zinc-500 shrink-0" title={formatarDataHoraCompleta(e.quando)}>{tempoDesde(e.quando, agora)}</span>
                          </div>
                          {e.erro && <div className="text-[11px] text-rose-300/80 line-clamp-2">{e.erro}</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </Secao>

                <Secao titulo="O que está acontecendo" icone={<Activity size={13} />} extra={<span className="text-[11px] text-zinc-500">{linhaDoTempo.length} eventos</span>}>
                  {linhaDoTempo.length === 0 ? (
                    <p className="text-xs text-zinc-500">Nada aconteceu neste período.</p>
                  ) : (
                    <ul className="space-y-1.5 max-h-[28rem] overflow-y-auto pr-1">
                      {linhaDoTempo.map((e) => (
                        <li key={e.chave} className="flex items-start gap-2 text-xs">
                          <span className="w-12 shrink-0 text-[10px] text-zinc-500 font-mono pt-0.5" title={formatarDataHoraCompleta(e.quando)}>
                            {new Date(e.quando).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-zinc-200 truncate">{e.titulo}</span>
                              <Selo status={e.status} />
                              <span className="text-[10px] text-zinc-500">{e.workspace}</span>
                              {e.vivo && <span className="text-[9px] px-1 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-800/40">ao vivo</span>}
                            </div>
                            {e.detalhe && <div className="text-[11px] text-zinc-500 truncate">{e.detalhe}</div>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Secao>
              </div>
            </div>
          </>
        )
      )}
    </div>
  );
};
