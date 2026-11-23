import React, { useEffect, useState, type FC, type FormEvent } from "react";
import { Cpu, Edit3, Layers, Loader2, Save, Trash2, X } from "lucide-react";
import { showToast } from "../../../shared/ui/Toast.js";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";

/** Provedores e pools grátis do motor claude-sdk. A chave nunca volta do servidor; só `chaveDefinida`. */
interface ProvedorGratis {
  id: string;
  nome: string;
  baseUrl: string;
  modelos: Record<string, string>;
  chaveDefinida: boolean;
  chaveEnv?: string;
}

interface PoolGratis {
  id: string;
  nome: string;
  membros: string[];
}

interface ListaGratis {
  ok?: boolean;
  erro?: string;
  ativo: string;
  provedores: ProvedorGratis[];
  pools: PoolGratis[];
}

const FAMILIAS = ["padrao", "haiku", "sonnet", "opus"] as const;
type Familia = (typeof FAMILIAS)[number];

interface FormProvedor {
  id: string;
  nome: string;
  baseUrl: string;
  modelos: Record<Familia, string>;
  chave: string;
  chaveEnv: string;
}

const FORM_VAZIO: FormProvedor = {
  id: "",
  nome: "",
  baseUrl: "",
  modelos: { padrao: "", haiku: "", sonnet: "", opus: "" },
  chave: "",
  chaveEnv: "",
};

const FORM_POOL_VAZIO = { id: "", nome: "", membros: [] as string[] };

const CAMPO =
  "w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 font-mono focus:outline-hidden focus:border-orange-500/60 disabled:opacity-50";
const ROTULO = "block text-[11px] font-medium text-zinc-400 mb-1";
const BOTAO =
  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50";
const BOTAO_PRIMARIO =
  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border border-orange-500/40 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50";

export const ProvedoresGratisSecao: FC = () => {
  const { client, tratarErro } = useOpenCorp();
  const [lista, setLista] = useState<ListaGratis | null>(null);
  const [form, setForm] = useState<FormProvedor>(FORM_VAZIO);
  const [editando, setEditando] = useState(false);
  const [pool, setPool] = useState(FORM_POOL_VAZIO);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    client.http
      .get<ListaGratis>("/api/provedores-gratis")
      .then(setLista)
      .catch((err) => tratarErro(err, "Erro ao carregar provedores grátis"));
  }, [client, tratarErro]);

  /** Roda uma ação do servidor, atualiza a lista e mostra o resultado. Resposta com `erro` vira aviso. */
  const executar = async (acao: () => Promise<ListaGratis>, sucesso: string): Promise<boolean> => {
    setOcupado(true);
    try {
      const res = await acao();
      if (res.ok === false || res.erro) throw new Error(res.erro ?? "Operação recusada");
      setLista(res);
      showToast(sucesso, "sucesso");
      return true;
    } catch (err) {
      tratarErro(err, "Não foi possível concluir");
      return false;
    } finally {
      setOcupado(false);
    }
  };

  const salvarProvedor = async (e: FormEvent) => {
    e.preventDefault();
    const modelos: Record<string, string> = {};
    for (const f of FAMILIAS) if (form.modelos[f].trim()) modelos[f] = form.modelos[f].trim();
    const ok = await executar(
      () =>
        client.http.post<ListaGratis>("/api/provedores-gratis/provedor", {
          id: form.id.trim(),
          nome: form.nome.trim(),
          baseUrl: form.baseUrl.trim(),
          modelos,
          chave: form.chave.trim() || undefined,
          chaveEnv: form.chaveEnv.trim() || undefined,
        }),
      "Provedor grátis salvo",
    );
    if (ok) {
      setForm(FORM_VAZIO);
      setEditando(false);
    }
  };

  const editarProvedor = (p: ProvedorGratis) => {
    setForm({
      id: p.id,
      nome: p.nome,
      baseUrl: p.baseUrl,
      modelos: {
        padrao: p.modelos.padrao ?? "",
        haiku: p.modelos.haiku ?? "",
        sonnet: p.modelos.sonnet ?? "",
        opus: p.modelos.opus ?? "",
      },
      chave: "",
      chaveEnv: p.chaveEnv ?? "",
    });
    setEditando(true);
  };

  const removerProvedor = (id: string) => {
    if (!window.confirm(`Remover o provedor grátis "${id}"?`)) return;
    void executar(
      () => client.http.delete<ListaGratis>(`/api/provedores-gratis/provedor/${encodeURIComponent(id)}`),
      "Provedor removido",
    );
  };

  const usar = (id: string) => {
    void executar(() => client.http.post<ListaGratis>("/api/provedores-gratis/ativo", { id }), `Ativo: ${id}`);
  };

  const salvarPool = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await executar(
      () =>
        client.http.post<ListaGratis>("/api/provedores-gratis/pool", {
          id: pool.id.trim(),
          nome: pool.nome.trim(),
          membros: pool.membros,
        }),
      "Rodízio salvo",
    );
    if (ok) setPool(FORM_POOL_VAZIO);
  };

  const removerPool = (id: string) => {
    if (!window.confirm(`Remover o rodízio "${id}"?`)) return;
    void executar(
      () => client.http.delete<ListaGratis>(`/api/provedores-gratis/pool/${encodeURIComponent(id)}`),
      "Rodízio removido",
    );
  };

  const alternarMembro = (id: string) => {
    setPool((atual) => ({
      ...atual,
      membros: atual.membros.includes(id) ? atual.membros.filter((m) => m !== id) : [...atual.membros, id],
    }));
  };

  if (!lista) {
    return (
      <div className="flex items-center gap-2 p-4 text-xs text-zinc-500">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando provedores grátis…
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-5 rounded-2xl border border-zinc-850 bg-zinc-900/40 space-y-6" data-testid="provedores-gratis">
      <div className="flex items-start gap-3 pb-3 border-b border-zinc-800">
        <div className="p-2.5 rounded-xl bg-orange-600/10 border border-orange-500/20 text-orange-400 shrink-0">
          <Cpu className="w-4 h-4" />
        </div>
        <div>
          <h2 className="text-sm font-bold text-zinc-100">Provedores grátis (CCO / Agent SDK)</h2>
          <p className="text-xs text-zinc-500 mt-0.5">
            Os agentes rodam no CCO Agent SDK apontando para estes endpoints. Só modelos grátis: o id precisa
            terminar em <code className="font-mono">:free</code> ou <code className="font-mono">-free</code>. Nenhuma
            conta da Anthropic.
          </p>
          <p className="text-xs text-zinc-400 mt-1">
            Ativo agora: <span className="font-mono text-zinc-200">{lista.ativo}</span>
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {lista.provedores.length === 0 && <p className="text-xs text-zinc-500">Nenhum provedor grátis cadastrado.</p>}
        {lista.provedores.map((p) => (
          <div
            key={p.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-100">{p.nome}</span>
                <span className="font-mono text-[10px] text-zinc-500">{p.id}</span>
                {lista.ativo === p.id && <span className="text-[10px] font-semibold text-emerald-400">ATIVO</span>}
              </div>
              <div className="font-mono text-[11px] text-zinc-500 truncate">{p.baseUrl}</div>
              <div className="font-mono text-[11px] text-zinc-400 truncate">padrão: {p.modelos.padrao}</div>
              <div className="text-[11px] text-zinc-500">
                chave: {p.chaveDefinida ? "definida" : "não definida"}
                {p.chaveEnv ? ` (variável ${p.chaveEnv})` : ""}
              </div>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <button type="button" className={BOTAO} onClick={() => usar(p.id)} disabled={ocupado || lista.ativo === p.id}>
                Usar
              </button>
              <button type="button" className={BOTAO} onClick={() => editarProvedor(p)} disabled={ocupado}>
                <Edit3 className="w-3.5 h-3.5" /> Editar
              </button>
              <button
                type="button"
                className={BOTAO}
                onClick={() => removerProvedor(p.id)}
                disabled={ocupado || lista.ativo === p.id}
              >
                <Trash2 className="w-3.5 h-3.5" /> Remover
              </button>
            </div>
          </div>
        ))}
      </div>

      <form onSubmit={salvarProvedor} className="space-y-3 rounded-xl border border-zinc-800 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-zinc-100">{editando ? `Editar ${form.id}` : "Novo provedor grátis"}</h3>
          {editando && (
            <button
              type="button"
              className={BOTAO}
              onClick={() => {
                setForm(FORM_VAZIO);
                setEditando(false);
              }}
            >
              <X className="w-3.5 h-3.5" /> Cancelar
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={ROTULO}>ID (kebab-case)</label>
            <input
              className={CAMPO}
              value={form.id}
              disabled={editando}
              placeholder="openrouter-conta2"
              required
              onChange={(e) => setForm({ ...form, id: e.target.value })}
            />
          </div>
          <div>
            <label className={ROTULO}>Nome</label>
            <input
              className={CAMPO}
              value={form.nome}
              placeholder="OpenRouter conta 2"
              required
              onChange={(e) => setForm({ ...form, nome: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={ROTULO}>URL base (https; http só em localhost)</label>
            <input
              className={CAMPO}
              value={form.baseUrl}
              placeholder="https://openrouter.ai/api"
              required
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            />
          </div>
          {FAMILIAS.map((f) => (
            <div key={f}>
              <label className={ROTULO}>{f === "padrao" ? "Modelo padrão" : `Modelo para ${f} (opcional)`}</label>
              <input
                className={CAMPO}
                value={form.modelos[f]}
                placeholder={f === "padrao" ? "nvidia/nemotron-3-super-120b-a12b:free" : "deixe vazio para usar o padrão"}
                required={f === "padrao"}
                onChange={(e) => setForm({ ...form, modelos: { ...form.modelos, [f]: e.target.value } })}
              />
            </div>
          ))}
          <div>
            <label className={ROTULO}>Chave</label>
            <input
              type="password"
              autoComplete="new-password"
              className={CAMPO}
              value={form.chave}
              placeholder={editando ? "vazio mantém a chave atual" : "cole a chave"}
              onChange={(e) => setForm({ ...form, chave: e.target.value })}
            />
          </div>
          <div>
            <label className={ROTULO}>ou nome da variável de ambiente</label>
            <input
              className={CAMPO}
              value={form.chaveEnv}
              placeholder="OPENROUTER_API_KEY"
              onChange={(e) => setForm({ ...form, chaveEnv: e.target.value })}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="submit" className={BOTAO_PRIMARIO} disabled={ocupado}>
            {ocupado ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />} Salvar provedor
          </button>
        </div>
      </form>

      <div className="space-y-3">
        <div>
          <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
            <Layers className="w-4 h-4" /> Rodízio entre provedores grátis
          </h3>
          <p className="text-xs text-zinc-500">
            Quando um membro esgota a cota, o próximo assume. Um rodízio precisa de pelo menos um membro.
          </p>
        </div>

        {lista.pools.map((pl) => (
          <div
            key={pl.id}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-zinc-100">{pl.nome}</span>
                <span className="font-mono text-[10px] text-zinc-500">{pl.id}</span>
                {lista.ativo === pl.id && <span className="text-[10px] font-semibold text-emerald-400">ATIVO</span>}
              </div>
              <div className="font-mono text-[11px] text-zinc-400 truncate">membros: {pl.membros.join(", ")}</div>
            </div>
            <div className="flex flex-wrap gap-2 shrink-0">
              <button type="button" className={BOTAO} onClick={() => usar(pl.id)} disabled={ocupado || lista.ativo === pl.id}>
                Usar
              </button>
              <button type="button" className={BOTAO} onClick={() => setPool({ id: pl.id, nome: pl.nome, membros: [...pl.membros] })} disabled={ocupado}>
                <Edit3 className="w-3.5 h-3.5" /> Editar
              </button>
              <button type="button" className={BOTAO} onClick={() => removerPool(pl.id)} disabled={ocupado || lista.ativo === pl.id}>
                <Trash2 className="w-3.5 h-3.5" /> Remover
              </button>
            </div>
          </div>
        ))}

        <form onSubmit={salvarPool} className="space-y-3 rounded-xl border border-zinc-800 p-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={ROTULO}>ID do rodízio</label>
              <input
                className={CAMPO}
                value={pool.id}
                placeholder="rodizio-gratis"
                required
                onChange={(e) => setPool({ ...pool, id: e.target.value })}
              />
            </div>
            <div>
              <label className={ROTULO}>Nome</label>
              <input
                className={CAMPO}
                value={pool.nome}
                placeholder="Rodízio grátis"
                required
                onChange={(e) => setPool({ ...pool, nome: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <span className={ROTULO}>Membros</span>
            {lista.provedores.length === 0 && <p className="text-xs text-zinc-500">Cadastre um provedor grátis antes.</p>}
            {lista.provedores.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-xs text-zinc-300">
                <input
                  type="checkbox"
                  checked={pool.membros.includes(p.id)}
                  onChange={() => alternarMembro(p.id)}
                />
                {p.nome} <span className="font-mono text-zinc-500">{p.id}</span>
              </label>
            ))}
          </div>
          <div className="flex justify-end">
            <button type="submit" className={BOTAO_PRIMARIO} disabled={ocupado || pool.membros.length === 0}>
              <Save className="w-3.5 h-3.5" /> Salvar rodízio
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
