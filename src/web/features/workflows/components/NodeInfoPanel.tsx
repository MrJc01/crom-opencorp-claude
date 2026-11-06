import React, { type FC } from "react";
import { Info } from "lucide-react";
import type { NoGrafo } from "../types.js";
import { descreverNo } from "../descricao-no.js";

/** Painel lateral só de leitura: mostra o comentário do nó sob o mouse (ou uma explicação automática). */
export const NodeInfoPanel: FC<{ no: NoGrafo | null }> = ({ no }) => {
  if (!no) return null;
  const escrito = typeof no.comentario === "string" && no.comentario.trim() !== "";
  return (
    <aside
      aria-label="Detalhes do nó"
      className="pointer-events-none absolute right-3 top-3 z-30 w-72 max-w-[40%] rounded-xl border border-zinc-800 bg-zinc-950/95 p-3 shadow-2xl shadow-black/60 backdrop-blur"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-sky-400">
        <Info size={12} /> {no.tipo}
      </div>
      <div className="mb-2 break-all font-mono text-xs font-semibold text-zinc-100">{no.id}</div>
      <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-zinc-300">{escrito ? no.comentario : descreverNo(no)}</p>
      {!escrito && <p className="mt-2 text-[9px] uppercase tracking-wide text-zinc-600">explicação automática (sem comentário escrito)</p>}
    </aside>
  );
};
