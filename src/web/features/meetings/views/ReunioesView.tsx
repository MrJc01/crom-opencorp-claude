import React, { useState, useEffect, useCallback, useMemo, type FC } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Users,
  Plus,
  RefreshCw,
  FileText,
  StopCircle,
  FileCheck,
  History,
  Bot,
  ChevronRight,
  Sparkles,
  Loader2,
} from "lucide-react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import type { SalaReuniao, MensagemGrupo } from "../types.js";
import {
  MeetingCard,
  MeetingRoomModal,
  MeetingTimeline,
  MeetingMinutesModal,
} from "../components/index.js";

export const ReunioesView: FC = () => {
  const { client, workspaceId, tratarErro } = useOpenCorp();
  const [searchParams, setSearchParams] = useSearchParams();

  const [reunioes, setReunioes] = useState<SalaReuniao[]>([]);
  const [agentesDisponiveis, setAgentesDisponiveis] = useState<any[]>([]);
  const [salaAtiva, setSalaAtiva] = useState<SalaReuniao | null>(null);
  const [mensagens, setMensagens] = useState<MensagemGrupo[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [agenteDigitando, setAgenteDigitando] = useState<string | null>(null);
  const [concluindoAta, setConcluindoAta] = useState(false);

  // Modais
  const [modalNovaReuniao, setModalNovaReuniao] = useState(false);
  const [modalAta, setModalAta] = useState(false);
  const [conteudoAta, setConteudoAta] = useState<string | null>(null);
  const [sidebarAberta, setSidebarAberta] = useState(true);

  const wsEfetivo = useMemo(() => {
    if (workspaceId && workspaceId.trim().length > 0) return workspaceId.trim();
    if (typeof window !== "undefined") {
      const salvo =
        localStorage.getItem("oc-ws") ||
        localStorage.getItem("opencorp_workspace_id");
      if (salvo && salvo.trim().length > 0) return salvo.trim();
    }
    return "default";
  }, [workspaceId]);

  const reuniaoParam = searchParams.get("reuniao");

  const carregarReunioes = useCallback(async () => {
    setCarregando(true);
    try {
      const [listaReunioes, listaAgentes] = await Promise.all([
        client.http.get<SalaReuniao[]>("/meetings", {
          headers: { "x-opencorp-workspace": wsEfetivo },
        }).catch(async () => {
          return client.http.get<SalaReuniao[]>("/reunioes", {
            headers: { "x-opencorp-workspace": wsEfetivo },
          }).catch(() => []);
        }),
        client.agents.listar().catch(() => []),
      ]);

      const arrayReunioes = Array.isArray(listaReunioes) ? listaReunioes : [];
      setReunioes(arrayReunioes);
      // Agentes desativados não podem participar (o turno deles falharia).
      setAgentesDisponiveis(
        Array.isArray(listaAgentes)
          ? listaAgentes.filter((a: any) => a?.ativo !== false && a?.active !== false)
          : [],
      );

      // Se há um parâmetro ou precisa abrir o primeiro
      if (reuniaoParam) {
        const encontrada = arrayReunioes.find((r) => r.id === reuniaoParam);
        if (encontrada) {
          void abrirSala(encontrada.id);
        }
      } else if (arrayReunioes.length > 0 && !salaAtiva) {
        const primeira =
          arrayReunioes.find(
            (r) => r.status === "em-andamento" || r.status === "em_andamento"
          ) || arrayReunioes[0];
        if (primeira) {
          setSearchParams({ reuniao: primeira.id });
        }
      }
    } catch {
      // Fallback
    } finally {
      setCarregando(false);
    }
  }, [client, wsEfetivo, reuniaoParam]);

  const abrirSala = async (id: string) => {
    try {
      const estado = await client.http.get<SalaReuniao>(
        `/meetings/${encodeURIComponent(id)}`,
        { headers: { "x-opencorp-workspace": wsEfetivo } }
      );
      setSalaAtiva(estado);
      setMensagens(estado.mensagens || []);
      if (estado.ata) {
        setConteudoAta(estado.ata);
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao carregar detalhes da reunião");
    }
  };

  useEffect(() => {
    void carregarReunioes();
  }, [carregarReunioes]);

  // Polling a cada 4s quando a sala ativa está ao vivo
  useEffect(() => {
    if (!salaAtiva) return;
    const st = String(salaAtiva.status || "").replace(/-/g, "_");
    if (st === "encerrada" || st === "concluida") return;

    const timer = setInterval(() => {
      if (!enviando) {
        client.http
          .get<SalaReuniao>(`/meetings/${encodeURIComponent(salaAtiva.id)}`, {
            headers: { "x-opencorp-workspace": wsEfetivo },
          })
          .then((est) => {
            if (!est) return;
            if (
              Array.isArray(est.mensagens) &&
              est.mensagens.length !== mensagens.length
            ) {
              setMensagens(est.mensagens);
            }
            if (est.status !== salaAtiva.status) {
              setSalaAtiva((prev) => (prev ? { ...prev, status: est.status } : est));
            }
            if (est.ata && est.ata !== conteudoAta) {
              setConteudoAta(est.ata);
            }
          })
          .catch(() => {});
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [salaAtiva?.id, salaAtiva?.status, enviando, mensagens.length, conteudoAta, client, wsEfetivo]);

  const enviarMensagem = async (
    texto: string,
    modo: "sequencial" | "direcionado",
    agenteAlvo?: string
  ) => {
    if (!salaAtiva || enviando) return;

    setEnviando(true);
    setAgenteDigitando(modo === "direcionado" ? agenteAlvo || "agente" : "conselho");

    // Otimista
    const msgLocal: MensagemGrupo = {
      agente: "usuario",
      texto,
      ts: new Date().toISOString(),
    };
    setMensagens((prev) => [...prev, msgLocal]);

    try {
      const res = await client.http.post<any>(
        `/meetings/${encodeURIComponent(salaAtiva.id)}/mensagem`,
        {
          mensagem: texto,
          modo,
          agente: modo === "direcionado" ? agenteAlvo : undefined,
        },
        { headers: { "x-opencorp-workspace": wsEfetivo } }
      );

      if (res && res.estado && Array.isArray(res.estado.mensagens)) {
        setMensagens(res.estado.mensagens);
      } else if (res && Array.isArray(res.respostas)) {
        setMensagens((prev) => [...prev, ...res.respostas]);
      }
    } catch (err: unknown) {
      tratarErro(err, "Falha ao enviar mensagem na reunião");
      setMensagens((prev) => prev.filter((m) => m !== msgLocal));
    } finally {
      setEnviando(false);
      setAgenteDigitando(null);
    }
  };

  const concluirReuniao = async () => {
    if (!salaAtiva) return;
    if (
      !confirm(
        "Deseja concluir esta reunião e solicitar ao Secretário/Moderador a redação da Ata Oficial?"
      )
    )
      return;

    setConcluindoAta(true);
    try {
      const res = await client.http.post<any>(
        `/meetings/${encodeURIComponent(salaAtiva.id)}/concluir`,
        {},
        { headers: { "x-opencorp-workspace": wsEfetivo } }
      );
      showToast("Reunião concluída! Ata executiva gerada com sucesso.", "sucesso");
      if (res.ata) {
        setConteudoAta(res.ata);
        setModalAta(true);
      }
      await carregarReunioes();
      await abrirSala(salaAtiva.id);
    } catch (err: unknown) {
      tratarErro(err, "Erro ao concluir reunião");
    } finally {
      setConcluindoAta(false);
    }
  };

  const interromperReuniao = async () => {
    if (!salaAtiva) return;
    if (!confirm("Deseja interromper imediatamente a deliberação ativa?")) return;

    try {
      await client.http.post(
        `/meetings/${encodeURIComponent(salaAtiva.id)}/stop`,
        {},
        { headers: { "x-opencorp-workspace": wsEfetivo } }
      );
      showToast("Deliberação interrompida!", "aviso");
      await carregarReunioes();
      await abrirSala(salaAtiva.id);
    } catch (err: unknown) {
      tratarErro(err, "Falha ao interromper reunião");
    }
  };

  const participantesDaSala: string[] = useMemo(() => {
    if (!salaAtiva) return [];
    if (Array.isArray(salaAtiva.participantes)) {
      return salaAtiva.participantes.map((p: any) =>
        typeof p === "string" ? p : p.id || p.nome
      );
    }
    return [];
  }, [salaAtiva]);

  const normStatus = (s: unknown) => String(s || "").replace(/-/g, "_");
  const isAoVivo =
    normStatus(salaAtiva?.status) === "em_andamento" ||
    normStatus(salaAtiva?.status) === "agendando";

  return (
    <div className="flex flex-col h-full w-full overflow-hidden bg-zinc-950 text-zinc-100">
      {/* Subheader / Barra de Controle Superior */}
      <div className="h-14 px-4 sm:px-6 border-b border-zinc-850 bg-zinc-900/60 backdrop-blur-md flex items-center justify-between gap-3 text-xs select-none shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-xl bg-purple-950/60 border border-purple-800/50 flex items-center justify-center text-purple-300 shrink-0">
            <Users size={17} />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="font-bold text-xs sm:text-sm text-zinc-200 truncate">
                {salaAtiva ? salaAtiva.pauta : "Nenhuma Reunião Selecionada"}
              </h2>
              {salaAtiva && (
                <span
                  className={`px-2 py-0.5 rounded-full text-[9px] font-mono font-bold uppercase shrink-0 ${
                    isAoVivo
                      ? "bg-emerald-950/80 text-emerald-400 border border-emerald-800/60 animate-pulse"
                      : "bg-zinc-800 text-zinc-400 border border-zinc-700"
                  }`}
                >
                  {isAoVivo ? "Ao Vivo" : "Concluída"}
                </span>
              )}
            </div>

            {/* Chips dos membros presentes */}
            <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-none mt-0.5">
              {participantesDaSala.map((ag) => (
                <span
                  key={ag}
                  className="text-[10px] font-mono text-purple-300/90 bg-purple-950/40 px-1.5 py-0.2 rounded border border-purple-800/40 truncate"
                >
                  @{ag}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Ações da Reunião */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setModalNovaReuniao(true)}
            className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold transition-colors cursor-pointer shadow-xs"
          >
            <Plus size={13} />
            <span>Nova Reunião</span>
          </button>

          <button
            type="button"
            onClick={() => setSidebarAberta((prev) => !prev)}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-xl border transition-colors cursor-pointer ${
              sidebarAberta
                ? "bg-zinc-800 text-zinc-100 border-zinc-700 font-semibold"
                : "bg-zinc-900 hover:bg-zinc-850 text-zinc-400 border-zinc-850"
            }`}
            title="Alternar lista de reuniões"
          >
            <History size={13} />
            <span className="hidden sm:inline">Histórico ({reunioes.length})</span>
          </button>

          {isAoVivo && (
            <>
              <button
                type="button"
                disabled={concluindoAta}
                onClick={concluirReuniao}
                className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/40 font-semibold transition-colors cursor-pointer disabled:opacity-50"
                title="Concluir deliberação e redigir ata"
              >
                {concluindoAta ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <FileCheck size={13} />
                )}
                <span className="hidden sm:inline">Concluir &amp; Ata</span>
              </button>

              <button
                type="button"
                onClick={interromperReuniao}
                className="p-1.5 rounded-xl bg-rose-600/20 hover:bg-rose-600/30 text-rose-400 border border-rose-500/40 transition-colors cursor-pointer"
                title="Interromper Reunião"
              >
                <StopCircle size={15} />
              </button>
            </>
          )}

          {conteudoAta && (
            <button
              type="button"
              onClick={() => setModalAta(true)}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border border-orange-500/40 font-semibold transition-colors cursor-pointer"
            >
              <FileText size={13} />
              <span>Ver Ata</span>
            </button>
          )}
        </div>
      </div>

      {/* Conteúdo: Barra Lateral com Histórico + Timeline Central */}
      <div className="flex-1 flex overflow-hidden">
        {/* Barra Lateral: Lista de Reuniões */}
        {sidebarAberta && (
          <aside className="w-80 border-r border-zinc-850 bg-zinc-950/70 p-4 space-y-3 flex flex-col shrink-0 overflow-y-auto scrollbar-thin">
            <div className="flex items-center justify-between pb-1 border-b border-zinc-800/60">
              <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider font-mono">
                Salas de Deliberação
              </span>
              <button
                type="button"
                onClick={carregarReunioes}
                className="p-1 rounded text-zinc-500 hover:text-zinc-300 transition-colors"
                title="Atualizar lista"
              >
                <RefreshCw size={12} className={carregando ? "animate-spin" : ""} />
              </button>
            </div>

            <div className="space-y-2.5 flex-1">
              {reunioes.map((r) => (
                <MeetingCard
                  key={r.id}
                  reuniao={r}
                  ativa={salaAtiva?.id === r.id}
                  aoSelecionar={(selecionada) => {
                    setSearchParams({ reuniao: selecionada.id });
                    void abrirSala(selecionada.id);
                  }}
                  aoVerAta={(selecionada) => {
                    if (selecionada.ata) {
                      setConteudoAta(selecionada.ata);
                      setModalAta(true);
                    }
                  }}
                />
              ))}

              {reunioes.length === 0 && !carregando && (
                <div className="py-12 text-center text-xs text-zinc-500 border border-dashed border-zinc-850 rounded-xl p-4">
                  Nenhuma reunião registrada no workspace. Clique em "Nova Reunião" para convocar o conselho.
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Timeline da Reunião Ativa */}
        <main className="flex-1 flex flex-col overflow-hidden bg-zinc-950">
          {salaAtiva ? (
            <MeetingTimeline
              mensagens={mensagens}
              participantes={participantesDaSala}
              enviando={enviando}
              agenteDigitando={agenteDigitando}
              onEnviarMensagem={enviarMensagem}
              salaStatus={salaAtiva.status}
            />
          ) : (
            <div className="h-full flex flex-col items-center justify-center text-center p-8 text-zinc-500 space-y-3">
              <div className="h-12 w-12 rounded-2xl bg-purple-950/40 border border-purple-800/40 flex items-center justify-center text-purple-400">
                <Users size={24} />
              </div>
              <h3 className="text-base font-bold text-zinc-200">
                Selecione ou Convoque uma Reunião
              </h3>
              <p className="text-xs text-zinc-400 max-w-sm">
                As salas colegiadas permitem que múltiplos agentes conversem, discordem, construam consenso e emitam atas executivas com tarefas para o Kanban.
              </p>
              <button
                type="button"
                onClick={() => setModalNovaReuniao(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md transition-colors cursor-pointer mt-2"
              >
                <Plus size={14} />
                <span>Convocar Conselho</span>
              </button>
            </div>
          )}
        </main>
      </div>

      {/* Modal Nova Reunião */}
      <MeetingRoomModal
        aberto={modalNovaReuniao}
        onClose={() => setModalNovaReuniao(false)}
        agentesDisponiveis={agentesDisponiveis}
        onReuniaoCriada={(nova) => {
          void carregarReunioes();
          if (nova && nova.id) {
            setSearchParams({ reuniao: nova.id });
            void abrirSala(nova.id);
          }
        }}
      />

      {/* Modal da Ata de Reunião */}
      <MeetingMinutesModal
        aberto={modalAta}
        onClose={() => setModalAta(false)}
        ata={conteudoAta}
        pauta={salaAtiva?.pauta}
        salaId={salaAtiva?.id}
      />
    </div>
  );
};
