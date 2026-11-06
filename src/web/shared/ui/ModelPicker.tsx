import React, { useEffect, useMemo, useRef, useState, type FC } from "react";
import { Check, ChevronDown, Cpu, Loader2, Search, TestTube2, X } from "lucide-react";
import { useOpenCorp } from "../../providers/OpenCorpProvider.js";

export interface ModeloCatalogo {
  id: string;
  /** Motor compatível desta linha; `null` quando nenhuma origem vinculou um motor. */
  motor: string | null;
  provedor: string;
  origem: "live" | "hint";
  /** Origens que listaram o modelo (proveniência preservada). */
  origens?: string[];
  gratuito: boolean;
  recomendado: boolean;
  /** Pode entrar em rotação de agentes autônomos. */
  autonomo?: boolean;
  tier: "S" | "A" | "B" | "NAO_RECOMENDADO";
  motivo?: string;
  /** Probe real com este motor (catalogado ≠ verificado). */
  probe?: { status: "passed" | "failed"; em: string; nivel?: string } | null;
}

export interface ProvedorAtivoInfo {
  id: string;
  nome: string;
  tipo: string;
  membros: Array<{ id: string; nome: string }>;
  vagas: Array<{ vaga: string; modelos: string[] }>;
}

const ROTULO_VAGA: Record<string, string> = {
  padrao: "Padrão (quando nada é pedido)",
  haiku: "Rápido (haiku)",
  sonnet: "Equilibrado (sonnet)",
  opus: "Poderoso (opus)",
};

let cacheCatalogo: ModeloCatalogo[] | null = null;
let cacheProvedor: ProvedorAtivoInfo | null = null;

export interface ModelPickerProps {
  value: string | string[];
  onChange: (value: any) => void;
  multiple?: boolean;
  motor?: string;
  placeholder?: string;
  className?: string;
}

export const ModelPicker: FC<ModelPickerProps> = ({
  value,
  onChange,
  multiple = false,
  motor,
  placeholder = "Pesquisar e selecionar modelo...",
  className = "",
}) => {
  const { client, workspaceId } = useOpenCorp();
  const raizRef = useRef<HTMLDivElement | null>(null);
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState("");
  const [catalogo, setCatalogo] = useState<ModeloCatalogo[]>(cacheCatalogo ?? []);
  const [provedor, setProvedor] = useState<ProvedorAtivoInfo | null>(cacheProvedor);
  const [carregando, setCarregando] = useState(cacheCatalogo === null);
  const [somenteFree, setSomenteFree] = useState(false);
  const [somenteRecomendados, setSomenteRecomendados] = useState(false);
  const [testando, setTestando] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Record<string, boolean>>({});

  const selecionados = Array.isArray(value) ? value : value ? [value] : [];

  useEffect(() => {
    if (!aberto || cacheCatalogo) return;
    setCarregando(true);
    client.http.get<{ modelos?: ModeloCatalogo[]; provedorAtivo?: ProvedorAtivoInfo | null }>("/modelos/catalogo", {
      headers: workspaceId ? { "x-opencorp-workspace": workspaceId } : undefined,
    }).then((res) => {
      const lista = Array.isArray(res?.modelos) ? res.modelos : [];
      cacheCatalogo = lista;
      cacheProvedor = res?.provedorAtivo ?? null;
      setCatalogo(lista);
      setProvedor(cacheProvedor);
    }).catch(() => setCatalogo([])).finally(() => setCarregando(false));
  }, [aberto, client, workspaceId]);

  useEffect(() => {
    if (!aberto) return;
    const fechar = (evento: MouseEvent) => {
      if (!raizRef.current?.contains(evento.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fechar);
    return () => document.removeEventListener("mousedown", fechar);
  }, [aberto]);

  const opcoes = useMemo(() => {
    const termo = busca.trim().toLowerCase();
    return catalogo.filter((modelo) => {
      if (motor && modelo.motor !== motor) return false;
      if (somenteFree && !modelo.gratuito) return false;
      if (somenteRecomendados && !modelo.recomendado) return false;
      return !termo || `${modelo.id} ${modelo.motor} ${modelo.provedor}`.toLowerCase().includes(termo);
    });
  }, [busca, catalogo, motor, somenteFree, somenteRecomendados]);

  const alternar = (id: string) => {
    if (!multiple) {
      onChange(id);
      setAberto(false);
      return;
    }
    onChange(selecionados.includes(id) ? selecionados.filter((item) => item !== id) : [...selecionados, id]);
  };

  const testar = async (modelo: ModeloCatalogo) => {
    if (!modelo.motor) return;
    // Motores ≠ OpenCode: inferência real com este modelo (consome cota), não só o motor.
    if (modelo.motor !== "opencode" && !confirm(`Testar "${modelo.id}" no motor "${modelo.motor}" executa uma inferência real e consome cota. Continuar?`)) return;
    setTestando(modelo.id);
    try {
      const resposta = modelo.motor === "opencode"
        ? await client.http.post<any>("/llm/test", { model: modelo.id })
        : await client.http.post<any>(`/api/motores/${encodeURIComponent(modelo.motor)}/test`, { nivel: "inference", modelo: modelo.id, confirmarCusto: true });
      setResultados((atuais) => ({ ...atuais, [modelo.id]: Boolean(resposta?.ok) }));
    } catch {
      setResultados((atuais) => ({ ...atuais, [modelo.id]: false }));
    } finally {
      setTestando(null);
    }
  };

  return (
    <div ref={raizRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setAberto((atual) => !atual)}
        className="w-full min-h-10 flex items-center justify-between gap-2 rounded-xl border border-zinc-700/80 bg-zinc-950 px-3 py-2 text-left text-xs text-zinc-200 hover:border-zinc-600 focus:outline-none focus:border-emerald-500"
        aria-haspopup="dialog"
        aria-expanded={aberto}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Cpu size={14} className="shrink-0 text-emerald-400" />
          <span className="font-mono truncate">
            {multiple
              ? selecionados.length > 0 ? `${selecionados.length} modelo(s) selecionado(s)` : placeholder
              : (selecionados[0] && ROTULO_VAGA[selecionados[0]]) || selecionados[0] || placeholder}
          </span>
        </span>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${aberto ? "rotate-180" : ""}`} />
      </button>

      {multiple && selecionados.length > 0 && (
        <div className="mt-2 flex max-h-24 flex-wrap gap-1 overflow-y-auto scrollbar-thin">
          {selecionados.map((id, indice) => (
            <span key={`${id}-${indice}`} className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-900 px-2 py-1 font-mono text-[10px] text-zinc-300">
              <span className="max-w-[220px] truncate">{indice + 1}. {id}</span>
              <button type="button" onClick={() => alternar(id)} aria-label={`Remover ${id}`} className="text-zinc-500 hover:text-rose-400"><X size={10} /></button>
            </span>
          ))}
        </div>
      )}

      {aberto && (
        <div role="dialog" aria-label="Catálogo de modelos" className="absolute left-0 right-0 z-[80] mt-2 overflow-hidden rounded-xl border border-zinc-700 bg-zinc-950 shadow-2xl shadow-black/60">
          <div className="space-y-2 border-b border-zinc-800 p-2.5">
            <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5">
              <Search size={13} className="text-zinc-500" />
              <input autoFocus value={busca} onChange={(e) => setBusca(e.target.value)} placeholder={placeholder} className="h-9 min-w-0 flex-1 bg-transparent font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-600" />
              <span className="text-[10px] text-zinc-500">{opcoes.length}/{catalogo.length}</span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-zinc-400">
              <button type="button" onClick={() => setSomenteRecomendados((v) => !v)} className={`rounded-full border px-2 py-1 ${somenteRecomendados ? "border-emerald-700 bg-emerald-950/50 text-emerald-300" : "border-zinc-700"}`}>Recomendados</button>
              <button type="button" onClick={() => setSomenteFree((v) => !v)} className={`rounded-full border px-2 py-1 ${somenteFree ? "border-cyan-700 bg-cyan-950/50 text-cyan-300" : "border-zinc-700"}`}>Free</button>
              {motor && <span className="ml-auto font-mono">motor: {motor}</span>}
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto p-1.5 scrollbar-thin">
            {provedor && (
              <div className="px-2 pb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                Provedor ativo: <span className="text-emerald-400">{provedor.nome}</span>
                {provedor.tipo === "pool" && <span> · reveza {provedor.membros.length} contas</span>}
              </div>
            )}
            {carregando ? (
              <div className="flex items-center justify-center gap-2 py-8 text-xs text-zinc-500"><Loader2 size={14} className="animate-spin" /> Descobrindo modelos...</div>
            ) : opcoes.length === 0 ? (
              <div className="py-8 text-center text-xs text-zinc-500">Nenhum modelo encontrado com estes filtros.</div>
            ) : opcoes.map((modelo) => {
              const marcado = selecionados.includes(modelo.id);
              return (
                <div key={`${modelo.motor ?? "-"}:${modelo.id}`} className={`group flex items-center gap-2 rounded-lg border px-2 py-1.5 ${marcado ? "border-emerald-800/70 bg-emerald-950/30" : "border-transparent hover:border-zinc-800 hover:bg-zinc-900"}`}>
                  <button type="button" onClick={() => alternar(modelo.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${marcado ? "border-emerald-500 bg-emerald-600 text-white" : "border-zinc-700"}`}>{marcado && <Check size={10} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-[11px] text-zinc-200">{modelo.id}</span>
                      <span className="flex gap-1.5 text-[9px] text-zinc-500">
                        <span>{modelo.motor ?? "motor não identificado"}</span><span>·</span>
                        <span title={modelo.origens?.join(", ")}>{modelo.origem === "live" ? "catálogo ao vivo" : "catalogado"}</span>
                        {modelo.probe?.status === "passed" && <span className="text-emerald-300" title={`Probe aprovado em ${modelo.probe.em}`}>VERIFICADO</span>}
                        {modelo.probe?.status === "failed" && <span className="text-rose-400" title={`Probe reprovado em ${modelo.probe.em}`}>FALHOU</span>}
                        {modelo.gratuito && <span className="text-emerald-400">FREE</span>}
                        {modelo.recomendado && <span className="text-cyan-400">AGENTE</span>}
                        {modelo.autonomo === false && <span className="text-amber-400" title={modelo.motivo}>BLOQUEADO P/ AUTÔNOMOS</span>}
                      </span>
                    </span>
                  </button>
                  <button type="button" disabled={!modelo.motor} onClick={() => void testar(modelo)} title={modelo.motor === "opencode" ? "Testar modelo" : "Testar modelo (inferência real, consome cota)"} className={`rounded-md p-1.5 ${resultados[modelo.id] === true ? "text-emerald-400" : resultados[modelo.id] === false ? "text-rose-400" : "text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"}`}>
                    {testando === modelo.id ? <Loader2 size={12} className="animate-spin" /> : <TestTube2 size={12} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
