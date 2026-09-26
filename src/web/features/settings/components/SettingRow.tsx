import React, { useState, useEffect, type FC, type ChangeEvent } from "react";
import { Check, Loader2 } from "lucide-react";
import type { EntradaSettingsRow } from "../types.js";

export interface SettingRowProps {
  chave: string;
  label: string;
  descricao: string;
  tipo?: "text" | "number" | "bool" | "textarea" | "select";
  opcoes?: Array<{ valor: string; label: string }>;
  step?: string;
  min?: string;
  todasEntradas: EntradaSettingsRow[];
  onSalvar: (chave: string, valor: unknown) => Promise<void>;
  salvando?: boolean;
}

export const SettingRow: FC<SettingRowProps> = ({
  chave,
  label,
  descricao,
  tipo = "text",
  opcoes,
  step = "1",
  min,
  todasEntradas,
  onSalvar,
  salvando = false,
}) => {
  const item = todasEntradas.find((e) => e.chave === chave);

  const getValorInicial = () => {
    if (!item) return tipo === "bool" ? false : "";
    if (tipo === "textarea" && Array.isArray(item.valor)) {
      return item.valor.join("\n");
    }
    return item.valor ?? "";
  };

  const [val, setVal] = useState<any>(getValorInicial);
  const [modificado, setModificado] = useState(false);
  const [salvandoLocal, setSalvandoLocal] = useState(false);
  const [salvoFeedback, setSalvoFeedback] = useState(false);

  useEffect(() => {
    setVal(getValorInicial());
    setModificado(false);
  }, [item?.valor, chave]);

  const origem = item?.origem || "default";

  const handleSalvar = async (valorCustom?: any) => {
    const valorASalvar = valorCustom !== undefined ? valorCustom : val;
    let finalVal: any = valorASalvar;

    if (tipo === "number") {
      finalVal = Number(finalVal);
    } else if (tipo === "textarea") {
      finalVal = String(finalVal)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    }

    setSalvandoLocal(true);
    try {
      await onSalvar(chave, finalVal);
      setModificado(false);
      setSalvoFeedback(true);
      setTimeout(() => setSalvoFeedback(false), 2000);
    } finally {
      setSalvandoLocal(false);
    }
  };

  const badgeClass = () => {
    if (origem === "workspace")
      return "text-purple-400 bg-purple-950/40 border-purple-800/40";
    if (origem === "global")
      return "text-cyan-400 bg-cyan-950/40 border-cyan-800/40";
    return "text-zinc-400 bg-zinc-850/60 border-zinc-750/60";
  };

  return (
    <div data-testid={`setting-${chave}`} className="py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-transparent border-b border-zinc-850/60 last:border-b-0">
      <div className="space-y-1 max-w-md sm:max-w-lg">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-100">{label}</span>
          <span
            className={`text-[9px] font-mono px-1.5 py-0.2 rounded border uppercase tracking-wider ${badgeClass()}`}
          >
            {origem}
          </span>
          {salvoFeedback && (
            <span className="text-[10px] font-mono text-emerald-400 flex items-center gap-1 animate-in fade-in">
              <Check size={11} /> Salvo
            </span>
          )}
        </div>
        <p className="text-[11px] text-zinc-400 leading-relaxed">{descricao}</p>
        <span className="text-[10px] font-mono text-zinc-500 block">{chave}</span>
      </div>

      <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
        {/* Switch Booleano */}
        {tipo === "bool" && (
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(val)}
            aria-label={label}
            disabled={salvandoLocal || salvando}
            onClick={async () => {
              const novo = !Boolean(val);
              setVal(novo);
              await handleSalvar(novo);
            }}
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
              Boolean(val) ? "bg-orange-500" : "bg-zinc-800"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-zinc-950 shadow-sm ring-0 transition duration-200 ease-in-out ${
                Boolean(val) ? "translate-x-4" : "translate-x-0"
              }`}
            />
          </button>
        )}

        {/* Dropdown Select */}
        {tipo === "select" && (
          <select
            value={String(val)}
            disabled={salvandoLocal || salvando}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => {
              const novo = e.target.value;
              setVal(novo);
              void handleSalvar(novo);
            }}
            className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs text-zinc-200 focus:outline-none focus:border-orange-500 cursor-pointer"
          >
            {(opcoes || []).map((op) => (
              <option key={op.valor} value={op.valor}>
                {op.label}
              </option>
            ))}
          </select>
        )}

        {/* Entrada Numérica */}
        {tipo === "number" && (
          <div className="flex items-center gap-1.5">
            <input
              aria-label={label}
              type="number"
              step={step}
              min={min}
              value={val ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSalvar();
              }}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setVal(e.target.value);
                setModificado(true);
              }}
              className="w-24 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-orange-500 text-right"
            />
            {modificado && (
              <button
                type="button"
                onClick={() => void handleSalvar()}
                disabled={salvandoLocal || salvando}
                className="p-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors cursor-pointer"
                title="Salvar alteração"
                aria-label={`Salvar ${label}`}
              >
                {salvandoLocal ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
              </button>
            )}
          </div>
        )}

        {/* Entrada de Texto */}
        {tipo === "text" && (
          <div className="flex items-center gap-1.5">
            <input
              aria-label={label}
              type="text"
              value={val ?? ""}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSalvar();
              }}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setVal(e.target.value);
                setModificado(true);
              }}
              className="w-48 sm:w-64 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs font-mono text-zinc-200 focus:outline-none focus:border-orange-500"
            />
            {modificado && (
              <button
                type="button"
                onClick={() => void handleSalvar()}
                disabled={salvandoLocal || salvando}
                className="p-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white transition-colors cursor-pointer"
                title="Salvar alteração"
                aria-label={`Salvar ${label}`}
              >
                {salvandoLocal ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Check size={12} />
                )}
              </button>
            )}
          </div>
        )}

        {/* Área de Texto Multilinhas */}
        {tipo === "textarea" && (
          <div className="flex flex-col items-end gap-1.5">
            <textarea
              rows={3}
              value={val ?? ""}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => {
                setVal(e.target.value);
                setModificado(true);
              }}
              className="w-56 sm:w-72 bg-zinc-900 border border-zinc-800 rounded-lg p-2 text-xs font-mono text-zinc-200 focus:outline-none focus:border-orange-500"
            />
            {modificado && (
              <button
                type="button"
                onClick={() => void handleSalvar()}
                disabled={salvandoLocal || salvando}
                className="px-2 py-0.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-medium flex items-center gap-1 transition-colors cursor-pointer"
              >
                {salvandoLocal ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <Check size={11} />
                )}
                <span>Salvar</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
