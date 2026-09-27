import React, { useState, useEffect, type FC } from "react";
import { type TeamSpec, type TeamPasso, type AgentResumo } from "@opencorp/sdk";
import { showToast } from "../../../shared/ui/Toast.js";
import {
  X,
  Users,
  Layers,
  Cpu,
  Shield,
  MessageSquare,
  Plus,
  Trash2,
  Save,
  Loader2,
} from "lucide-react";

export interface TeamManageModalProps {
  aberto: boolean;
  teamParaEditar: TeamSpec | null;
  agentes: AgentResumo[];
  aoFechar: () => void;
  aoSalvar: (team: TeamSpec) => Promise<void>;
}

export const TeamManageModal: FC<TeamManageModalProps> = ({
  aberto,
  teamParaEditar,
  agentes,
  aoFechar,
  aoSalvar,
}) => {
  const [id, setId] = useState("");
  const [titulo, setTitulo] = useState("");
  const [padrao, setPadrao] = useState<"pipeline" | "fanout" | "review" | "debate">("pipeline");
  const [turnos, setTurnos] = useState(3);
  const [maxMsgs, setMaxMsgs] = useState(30);

  // Participantes por Padrão
  const [passosPipeline, setPassosPipeline] = useState<TeamPasso[]>([
    { agente: "", ordem: "Processar etapa inicial" },
    { agente: "", ordem: "Revisar e consolidar entrega" },
  ]);

  const [executorReview, setExecutorReview] = useState<TeamPasso>({
    agente: "",
    ordem: "Elaborar versão completa",
  });
  const [revisorReview, setRevisorReview] = useState<TeamPasso>({
    agente: "",
    ordem: "Avaliar critérios e emitir aprovação ou correções",
  });

  const [paralelosFanout, setParalelosFanout] = useState<TeamPasso[]>([
    { agente: "", ordem: "Análise técnica de arquitetura" },
    { agente: "", ordem: "Análise de impacto e segurança" },
  ]);
  const [sinteseFanout, setSinteseFanout] = useState<TeamPasso>({
    agente: "",
    ordem: "Consolidar todas as análises em parecer único",
  });

  const [proponentesDebate, setProponentesDebate] = useState<TeamPasso[]>([
    { agente: "", ordem: "Defender proposta técnica A" },
    { agente: "", ordem: "Apresentar contraponto crítico B" },
  ]);
  const [moderadorDebate, setModeradorDebate] = useState("");

  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (teamParaEditar) {
      setId(teamParaEditar.id);
      setTitulo(teamParaEditar.titulo || "");
      setPadrao(teamParaEditar.padrao || "pipeline");
      setTurnos(teamParaEditar.turnos || 3);
      setMaxMsgs(teamParaEditar.max_mensagens_auto_h || 30);

      let rawPassos = teamParaEditar.passos;
      if (typeof rawPassos === "string") {
        try { rawPassos = JSON.parse(rawPassos); } catch { rawPassos = []; }
      }
      if (Array.isArray(rawPassos) && rawPassos.length > 0) {
        setPassosPipeline(rawPassos);
      }
      if (teamParaEditar.executor) setExecutorReview(teamParaEditar.executor);
      if (teamParaEditar.revisor) setRevisorReview(teamParaEditar.revisor);

      let rawParalelos = teamParaEditar.paralelos;
      if (typeof rawParalelos === "string") {
        try { rawParalelos = JSON.parse(rawParalelos); } catch { rawParalelos = []; }
      }
      if (Array.isArray(rawParalelos) && rawParalelos.length > 0) {
        setParalelosFanout(rawParalelos);
      }
      if (teamParaEditar.sintese) setSinteseFanout(teamParaEditar.sintese);

      let rawProponentes = teamParaEditar.proponentes;
      if (typeof rawProponentes === "string") {
        try { rawProponentes = JSON.parse(rawProponentes); } catch { rawProponentes = []; }
      }
      if (Array.isArray(rawProponentes) && rawProponentes.length > 0) {
        setProponentesDebate(rawProponentes);
      }
      if (teamParaEditar.moderador?.agente) setModeradorDebate(teamParaEditar.moderador.agente);
    } else {
      setId("");
      setTitulo("");
      setPadrao("pipeline");
      setPassosPipeline([
        { agente: agentes[0]?.id || "", ordem: "Processar etapa inicial" },
        { agente: agentes[1]?.id || agentes[0]?.id || "", ordem: "Revisar e consolidar entrega" },
      ]);
    }
  }, [teamParaEditar, agentes, aberto]);

  if (!aberto) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim() || !titulo.trim()) {
      showToast("ID e Título são obrigatórios", "aviso");
      return;
    }

    setSalvando(true);
    try {
      const spec: TeamSpec = {
        id: id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
        titulo: titulo.trim(),
        padrao,
      };

      if (padrao === "pipeline") {
        spec.passos = passosPipeline.filter((p) => p.agente.trim());
      } else if (padrao === "fanout") {
        spec.paralelos = paralelosFanout.filter((p) => p.agente.trim());
        spec.sintese = sinteseFanout;
      } else if (padrao === "review") {
        spec.executor = executorReview;
        spec.revisor = revisorReview;
      } else if (padrao === "debate") {
        spec.proponentes = proponentesDebate.filter((p) => p.agente.trim());
        spec.moderador = moderadorDebate ? { agente: moderadorDebate } : undefined;
        spec.turnos = turnos;
        spec.max_mensagens_auto_h = maxMsgs;
      }

      await aoSalvar(spec);
      aoFechar();
    } catch {
      // erro já tratado pelo caller
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-xs animate-in fade-in duration-150"
      onClick={aoFechar}
    >
      <div
        className="w-full max-w-xl bg-zinc-900 border border-zinc-800 rounded-2xl p-6 shadow-2xl space-y-4 max-h-[92vh] overflow-y-auto scrollbar-thin"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header do Modal */}
        <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
          <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <Users size={16} className="text-purple-400" />
            <span>{teamParaEditar ? "Editar Equipe Multi-Agente" : "Criar Nova Equipe Multi-Agente"}</span>
          </h2>
          <button
            type="button"
            onClick={aoFechar}
            className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* ID e Título */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-zinc-300 font-medium mb-1">Identificador (slug) *</label>
              <input
                type="text"
                required
                disabled={!!teamParaEditar}
                value={id}
                onChange={(e) => setId(e.target.value)}
                placeholder="ex: squad-auditoria"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 font-mono text-xs focus:outline-none focus:border-purple-500 disabled:opacity-60"
              />
            </div>

            <div>
              <label className="block text-zinc-300 font-medium mb-1">Título da Equipe *</label>
              <input
                type="text"
                required
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                placeholder="Ex: Squad de Auditoria & Qualidade"
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-100 focus:outline-none focus:border-purple-500"
              />
            </div>
          </div>

          {/* Seleção do Padrão */}
          <div>
            <label className="block text-zinc-300 font-medium mb-1.5">
              Padrão de Colaboração Multi-Agente
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() => setPadrao("pipeline")}
                aria-pressed={padrao === "pipeline"}
                className={`p-2.5 rounded-xl border text-center transition-all cursor-pointer flex flex-col items-center gap-1.5 ${
                  padrao === "pipeline"
                    ? "bg-blue-950/50 border-blue-600 text-blue-300 font-semibold"
                    : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <Layers size={16} className="text-blue-400" />
                <span className="text-[11px]">Pipeline</span>
              </button>

              <button
                type="button"
                onClick={() => setPadrao("fanout")}
                aria-pressed={padrao === "fanout"}
                className={`p-2.5 rounded-xl border text-center transition-all cursor-pointer flex flex-col items-center gap-1.5 ${
                  padrao === "fanout"
                    ? "bg-purple-950/50 border-purple-600 text-purple-300 font-semibold"
                    : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <Cpu size={16} className="text-purple-400" />
                <span className="text-[11px]">Fan-out</span>
              </button>

              <button
                type="button"
                onClick={() => setPadrao("review")}
                aria-pressed={padrao === "review"}
                className={`p-2.5 rounded-xl border text-center transition-all cursor-pointer flex flex-col items-center gap-1.5 ${
                  padrao === "review"
                    ? "bg-amber-950/50 border-amber-600 text-amber-300 font-semibold"
                    : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <Shield size={16} className="text-amber-400" />
                <span className="text-[11px]">Review</span>
              </button>

              <button
                type="button"
                onClick={() => setPadrao("debate")}
                aria-pressed={padrao === "debate"}
                className={`p-2.5 rounded-xl border text-center transition-all cursor-pointer flex flex-col items-center gap-1.5 ${
                  padrao === "debate"
                    ? "bg-emerald-950/50 border-emerald-600 text-emerald-300 font-semibold"
                    : "bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                }`}
              >
                <MessageSquare size={16} className="text-emerald-400" />
                <span className="text-[11px]">Debate</span>
              </button>
            </div>
          </div>

          {/* Configuração Dinâmica por Padrão */}
          {padrao === "pipeline" && (
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-zinc-200 font-semibold text-[11px]">
                  Passos Sequenciais (Pipeline)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setPassosPipeline((prev) => [
                      ...prev,
                      { agente: agentes[0]?.id || "", ordem: "Nova etapa do fluxo" },
                    ])
                  }
                  className="flex items-center gap-1 text-[11px] text-purple-400 hover:text-purple-300"
                >
                  <Plus size={12} />
                  <span>Adicionar Passo</span>
                </button>
              </div>

              <div className="space-y-2">
                {passosPipeline.map((passo, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-zinc-500 w-4">{idx + 1}.</span>
                    <select
                      value={passo.agente}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPassosPipeline((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, agente: val } : p)),
                        );
                      }}
                      className="w-36 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono focus:outline-none"
                    >
                      <option value="">Selecione...</option>
                      {agentes.map((ag) => (
                        <option key={ag.id} value={ag.id}>
                          @{ag.id}
                        </option>
                      ))}
                    </select>

                    <input
                      type="text"
                      value={passo.ordem}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPassosPipeline((prev) =>
                          prev.map((p, i) => (i === idx ? { ...p, ordem: val } : p)),
                        );
                      }}
                      placeholder="Instrução do passo..."
                      className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs focus:outline-none"
                    />

                    {passosPipeline.length > 1 && (
                      <button
                        type="button"
                        onClick={() =>
                          setPassosPipeline((prev) => prev.filter((_, i) => i !== idx))
                        }
                        className="text-zinc-500 hover:text-rose-400 p-1"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {padrao === "fanout" && (
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <span className="text-zinc-200 font-semibold text-[11px] block">
                Agentes Paralelos & Síntese
              </span>

              <div className="space-y-2">
                {paralelosFanout.map((p, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-[10px] text-zinc-500 font-mono">P{idx + 1}</span>
                    <select
                      value={p.agente}
                      onChange={(e) => {
                        const val = e.target.value;
                        setParalelosFanout((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, agente: val } : item)),
                        );
                      }}
                      className="w-36 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono"
                    >
                      <option value="">Selecione...</option>
                      {agentes.map((ag) => (
                        <option key={ag.id} value={ag.id}>
                          @{ag.id}
                        </option>
                      ))}
                    </select>
                    <input
                      type="text"
                      value={p.ordem}
                      onChange={(e) => {
                        const val = e.target.value;
                        setParalelosFanout((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, ordem: val } : item)),
                        );
                      }}
                      className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs"
                    />
                  </div>
                ))}
              </div>

              <div className="pt-2 border-t border-zinc-850">
                <label className="block text-zinc-400 text-[11px] mb-1">Agente de Síntese Final</label>
                <div className="flex items-center gap-2">
                  <select
                    value={sinteseFanout.agente}
                    onChange={(e) => setSinteseFanout({ ...sinteseFanout, agente: e.target.value })}
                    className="w-36 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono"
                  >
                    <option value="">Selecione...</option>
                    {agentes.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        @{ag.id}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={sinteseFanout.ordem}
                    onChange={(e) => setSinteseFanout({ ...sinteseFanout, ordem: e.target.value })}
                    className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {padrao === "review" && (
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <div>
                <label className="block text-zinc-300 font-medium mb-1">Agente Executor (Autor)</label>
                <div className="flex items-center gap-2">
                  <select
                    value={executorReview.agente}
                    onChange={(e) => setExecutorReview({ ...executorReview, agente: e.target.value })}
                    className="w-36 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono"
                  >
                    <option value="">Selecione...</option>
                    {agentes.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        @{ag.id}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={executorReview.ordem}
                    onChange={(e) => setExecutorReview({ ...executorReview, ordem: e.target.value })}
                    className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs"
                  />
                </div>
              </div>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">Agente Revisor Crítico</label>
                <div className="flex items-center gap-2">
                  <select
                    value={revisorReview.agente}
                    onChange={(e) => setRevisorReview({ ...revisorReview, agente: e.target.value })}
                    className="w-36 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono"
                  >
                    <option value="">Selecione...</option>
                    {agentes.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        @{ag.id}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    value={revisorReview.ordem}
                    onChange={(e) => setRevisorReview({ ...revisorReview, ordem: e.target.value })}
                    className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs"
                  />
                </div>
              </div>
            </div>
          )}

          {padrao === "debate" && (
            <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-zinc-300 font-medium mb-1">Turnos de Debate</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={turnos}
                    onChange={(e) => setTurnos(Number(e.target.value) || 3)}
                    className="w-full px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="block text-zinc-300 font-medium mb-1">Agente Moderador</label>
                  <select
                    value={moderadorDebate}
                    onChange={(e) => setModeradorDebate(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono"
                  >
                    <option value="">Nenhum (automático)</option>
                    {agentes.map((ag) => (
                      <option key={ag.id} value={ag.id}>
                        @{ag.id}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-zinc-300 font-medium mb-1">Debatedores Proponentes</label>
                <div className="space-y-1.5">
                  {proponentesDebate.map((p, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <select
                        value={p.agente}
                        onChange={(e) => {
                          const val = e.target.value;
                          setProponentesDebate((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, agente: val } : item)),
                          );
                        }}
                        className="w-36 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 text-xs font-mono"
                      >
                        <option value="">Selecione...</option>
                        {agentes.map((ag) => (
                          <option key={ag.id} value={ag.id}>
                            @{ag.id}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={p.ordem}
                        onChange={(e) => {
                          const val = e.target.value;
                          setProponentesDebate((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, ordem: val } : item)),
                          );
                        }}
                        className="flex-1 px-2.5 py-1.5 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 text-xs"
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Footer */}
          <div className="pt-3 border-t border-zinc-800 flex justify-end gap-2">
            <button
              type="button"
              disabled={salvando}
              onClick={aoFechar}
              className="px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={salvando}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold shadow-md transition-colors cursor-pointer disabled:opacity-50"
            >
              {salvando ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              <span>Salvar Equipe</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
