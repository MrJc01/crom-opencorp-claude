import React, { useState, type FC } from "react";
import { type AgentResumo } from "@opencorp/sdk";
import { Bot, Play, Copy, Check, Power, Sliders, Shield, Cpu, Terminal } from "lucide-react";

export interface AgentCardProps {
  agente: AgentResumo;
  aoInspecionar: (agente: AgentResumo) => void;
  aoDisparar: (agente: AgentResumo) => void;
  aoAlternarAtivo: (agente: AgentResumo, ativo: boolean) => Promise<void>;
  carregandoAtivo?: boolean;
}

export const AgentCard: FC<AgentCardProps> = ({
  agente,
  aoInspecionar,
  aoDisparar,
  aoAlternarAtivo,
  carregandoAtivo = false,
}) => {
  const [copiado, setCopiado] = useState(false);

  const copiarHandle = (e: React.MouseEvent) => {
    e.stopPropagation();
    const handle = `@${agente.id}`;
    void navigator.clipboard.writeText(handle);
    setCopiado(true);
    setTimeout(() => setCopiado(false), 2000);
  };

  const isAtivo = agente.ativo !== false && agente.active !== false;
  const modeloFormatado = (agente.modelo || agente.model || "padrão").replace(/^.*\//, "");
  const skills = agente.skills || [];

  return (
    <div
      data-testid={`agent-card-${agente.id}`}
      data-ativo={isAtivo ? "true" : "false"}
      onClick={() => aoInspecionar(agente)}
      className={`p-4 rounded-2xl border transition-all duration-150 flex flex-col justify-between cursor-pointer space-y-3 relative group ${
        isAtivo
          ? "bg-zinc-900/60 border-zinc-800/90 hover:border-zinc-700 hover:bg-zinc-900/90 shadow-xs"
          : "bg-zinc-950/50 border-dashed border-zinc-700 hover:border-zinc-600"
      }`}
    >
      <div>
        {/* Topo: Avatar, Nome, Handle e Toggle de Ativação */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`h-9 w-9 rounded-xl flex items-center justify-center shrink-0 border transition-colors ${
                isAtivo
                  ? "bg-emerald-950/60 border-emerald-800/50 text-emerald-400 group-hover:bg-emerald-900/70"
                  : "bg-zinc-900 border-zinc-800 text-zinc-500"
              }`}
            >
              <Bot size={18} />
            </div>

            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <h3 className="text-xs font-bold text-zinc-100 truncate">
                  {agente.nome || agente.name || agente.id}
                </h3>
              </div>

              <div className="flex items-center gap-1.5 mt-0.5">
                <button
                  type="button"
                  onClick={copiarHandle}
                  className="flex items-center gap-1 text-[11px] font-mono text-zinc-400 hover:text-emerald-400 transition-colors"
                  title="Copiar handle do agente"
                >
                  <span>@{agente.id}</span>
                  {copiado ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
                </button>
              </div>
            </div>
          </div>

          {/* Toggle de Ativação */}
          <button
            type="button"
            disabled={carregandoAtivo}
            onClick={(e) => {
              e.stopPropagation();
              void aoAlternarAtivo(agente, !isAtivo);
            }}
            className={`p-1.5 rounded-lg border transition-all cursor-pointer ${
              isAtivo
                ? "bg-emerald-950/40 border-emerald-800/60 text-emerald-400 hover:bg-emerald-900/50"
                : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300"
            }`}
            title={isAtivo ? "Desativar agente" : "Ativar agente"}
            aria-label={isAtivo ? "Desativar agente" : "Ativar agente"}
            aria-pressed={isAtivo}
          >
            <Power size={13} />
          </button>
        </div>

        {/* Papel / Descrição */}
        <p className="text-xs text-zinc-400 line-clamp-2 mt-2.5 leading-relaxed">
          {agente.role || agente.descricao || agente.description || "Agente especialista autônomo."}
        </p>

        {/* Tags de Harness e Modelo */}
        <div className="flex flex-wrap items-center gap-1.5 mt-3 text-[10px] font-mono">
          <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-300">
            <Cpu size={10} className="text-cyan-400 shrink-0" />
            <span className="truncate max-w-[120px]">{modeloFormatado}</span>
          </span>

          {agente.harness && (
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-md bg-zinc-950 border border-zinc-800 text-zinc-400">
              <Terminal size={10} className="text-amber-400 shrink-0" />
              <span>{agente.harness}</span>
            </span>
          )}

          {agente.permissions && (
            <span
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[9px] uppercase font-bold ${
                agente.permissions === "level-3"
                  ? "bg-purple-950/60 border-purple-800 text-purple-300"
                  : agente.permissions === "level-1"
                  ? "bg-blue-950/60 border-blue-800 text-blue-300"
                  : "bg-zinc-800 border-zinc-700 text-zinc-300"
              }`}
            >
              <Shield size={9} />
              <span>{agente.permissions}</span>
            </span>
          )}
        </div>

        {/* Skills registradas */}
        {skills.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2.5">
            {skills.slice(0, 3).map((skill) => (
              <span
                key={skill}
                className="text-[10px] px-1.5 py-0.2 rounded bg-zinc-800/80 text-zinc-300 font-mono"
              >
                #{skill}
              </span>
            ))}
            {skills.length > 3 && (
              <span className="text-[10px] px-1 py-0.2 rounded bg-zinc-850 text-zinc-500 font-mono">
                +{skills.length - 3}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Rodapé: Ações */}
      <div className="flex items-center justify-between pt-3 mt-3 border-t border-zinc-800/60">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            aoInspecionar(agente);
          }}
          className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <Sliders size={12} />
          <span>Configurar</span>
        </button>

        <button
          type="button"
          disabled={!isAtivo}
          onClick={(e) => {
            e.stopPropagation();
            aoDisparar(agente);
          }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-semibold shadow-md transition-all cursor-pointer disabled:opacity-50"
          title="Disparar ordem avulsa para este agente"
        >
          <Play size={11} className="fill-current" />
          <span>Executar</span>
        </button>
      </div>
    </div>
  );
};
