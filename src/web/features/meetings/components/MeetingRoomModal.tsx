import React, { useState, type FC, type FormEvent } from "react";
import { Users, X, Bot, Sparkles, Loader2, MessageSquare, Play } from "lucide-react";
import { showToast } from "../../../shared/ui/Toast.js";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";

export interface MeetingRoomModalProps {
  aberto: boolean;
  onClose: () => void;
  agentesDisponiveis: Array<{ id: string; nome?: string; role?: string; emoji?: string }>;
  onReuniaoCriada: (novaSala: any) => void;
}

export const MeetingRoomModal: FC<MeetingRoomModalProps> = ({
  aberto,
  onClose,
  agentesDisponiveis,
  onReuniaoCriada,
}) => {
  const { client, tratarErro } = useOpenCorp();
  const [pauta, setPauta] = useState("");
  const [participantes, setParticipantes] = useState<string[]>([]);
  const [moderador, setModerador] = useState("secretario");
  const [modo, setModo] = useState<"chat" | "autonomo">("chat");
  const [criando, setCriando] = useState(false);

  if (!aberto) return null;

  const toggleParticipante = (id: string) => {
    setParticipantes((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  const selecionarTodos = () => {
    setParticipantes(agentesDisponiveis.map((a) => a.id));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const pLimpa = pauta.trim();
    if (!pLimpa) {
      showToast("Informe a pauta ou objetivo da reunião", "aviso");
      return;
    }
    if (participantes.length === 0) {
      showToast("Selecione ao menos 1 agente para a deliberação", "aviso");
      return;
    }

    setCriando(true);
    try {
      const agentesStr = participantes.join(",");
      let res: any;

      if (modo === "chat") {
        res = await client.http.post<any>("/meetings/chat", {
          pauta: pLimpa,
          agentes: agentesStr,
          moderador,
        });
      } else {
        res = await client.http.post<any>("/meetings", {
          pauta: pLimpa,
          participantes,
          moderador,
        });
      }

      showToast("Sala de reunião convocada com sucesso!", "sucesso");
      setPauta("");
      setParticipantes([]);
      onClose();
      onReuniaoCriada(res);
    } catch (err: unknown) {
      tratarErro(err, "Falha ao convocar reunião");
    } finally {
      setCriando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="w-full max-w-lg rounded-2xl bg-zinc-950 border border-zinc-850 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Topo do Modal */}
        <div className="p-4 border-b border-zinc-850 flex items-center justify-between shrink-0 bg-zinc-900/50">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-purple-600/10 border border-purple-500/20 text-purple-400">
              <Users size={18} />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100">
                Convocar Nova Reunião Colegiada
              </h3>
              <p className="text-[11px] text-zinc-400 mt-0.5">
                Alinhe agentes autônomos para tomada de decisões colegiadas e emissão de atas.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        {/* Formulário */}
        <form onSubmit={handleSubmit} className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Pauta */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-zinc-200">
              Pauta da Reunião / Problema a Resolver *
            </label>
            <textarea
              rows={3}
              placeholder="Ex: Definir linha editorial dos vídeos de IA para o próximo mês e validar roteiro de pauta..."
              value={pauta}
              onChange={(e) => setPauta(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-200 focus:outline-none focus:border-purple-500 leading-relaxed"
            />
          </div>

          {/* Modo de Deliberação */}
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold text-zinc-200">
              Formato de Deliberação
            </label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setModo("chat")}
                className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                  modo === "chat"
                    ? "bg-purple-950/40 border-purple-600 text-purple-200 shadow-xs"
                    : "bg-zinc-900/40 border-zinc-850 text-zinc-400 hover:border-zinc-750"
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs text-zinc-100 mb-0.5">
                  <MessageSquare size={13} className="text-purple-400" />
                  <span>Chat Interativo</span>
                </div>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Você acompanha cada turno ao vivo e pode guiar a deliberação.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setModo("autonomo")}
                className={`p-3 rounded-xl border text-left transition-colors cursor-pointer ${
                  modo === "autonomo"
                    ? "bg-purple-950/40 border-purple-600 text-purple-200 shadow-xs"
                    : "bg-zinc-900/40 border-zinc-850 text-zinc-400 hover:border-zinc-750"
                }`}
              >
                <div className="flex items-center gap-1.5 font-semibold text-xs text-zinc-100 mb-0.5">
                  <Play size={13} className="text-emerald-400" />
                  <span>Autônomo (Fundo)</span>
                </div>
                <p className="text-[10px] text-zinc-400 leading-relaxed">
                  Os agentes debatem até atingir consenso e notificam ao gerar a ata.
                </p>
              </button>
            </div>
          </div>

          {/* Participantes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="block text-xs font-semibold text-zinc-200">
                Agentes Participantes ({participantes.length} selecionados)
              </label>
              <button
                type="button"
                onClick={selecionarTodos}
                className="text-[11px] text-purple-400 hover:text-purple-300 font-medium cursor-pointer"
              >
                Selecionar Todos
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 max-h-44 overflow-y-auto p-1 scrollbar-thin">
              {agentesDisponiveis.map((ag) => {
                const isSelected = participantes.includes(ag.id);
                return (
                  <button
                    key={ag.id}
                    type="button"
                    onClick={() => toggleParticipante(ag.id)}
                    aria-pressed={isSelected}
                    className={`p-2 rounded-xl border text-left text-xs transition-colors flex items-center gap-2 cursor-pointer ${
                      isSelected
                        ? "bg-purple-950/50 border-purple-600/70 text-purple-200 font-semibold"
                        : "bg-zinc-900/60 border-zinc-850 text-zinc-400 hover:border-zinc-750 hover:text-zinc-200"
                    }`}
                  >
                    <span className="text-base">{ag.emoji || "🤖"}</span>
                    <span className="truncate font-mono text-[11px]">@{ag.id}</span>
                  </button>
                );
              })}
              {agentesDisponiveis.length === 0 && (
                <div className="col-span-full py-4 text-center text-xs text-zinc-500">
                  Nenhum agente cadastrado no workspace.
                </div>
              )}
            </div>
          </div>

          {/* Botões do Rodapé */}
          <div className="pt-3 border-t border-zinc-850 flex items-center justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 rounded-xl text-xs font-medium text-zinc-400 hover:text-zinc-200 hover:bg-zinc-850 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={criando}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md transition-colors cursor-pointer disabled:opacity-50"
            >
              {criando ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Sparkles size={13} />
              )}
              <span>Iniciar Deliberação</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
