import React, { useState, useEffect, useCallback, type FC, type ChangeEvent } from "react";
import {
  Key,
  RefreshCw,
  Play,
  Trash2,
  Plus,
  Lock,
  Copy,
  Check,
  Loader2,
  ShieldCheck,
  Globe,
  Server,
  Sparkles,
  GitBranch,
  CreditCard,
  KeyRound,
  Eye,
  EyeOff,
  ChevronRight,
  X,
  Layers,
  Edit3,
  Info,
  MapPin,
  AlertCircle,
} from "lucide-react";
import { showToast } from "../../../../shared/ui/Toast.js";
import { useOpenCorp } from "../../../../providers/OpenCorpProvider.js";
import type { SecretItem } from "../../types.js";
import {
  TEMPLATES_SECRETS,
  identificarTemplatePorNome,
  type SecretTemplate,
} from "../../constants/secretTemplates.js";

export interface TabSecretsProps {
  escopoConfig: "global" | "workspace";
}

export const TabSecrets: FC<TabSecretsProps> = ({ escopoConfig }) => {
  const { client, tratarErro } = useOpenCorp();

  // Estados de Chaves de API (Provedores BYOK)
  const [chavesApi, setChavesApi] = useState<any>({
    global: { chaves: [] },
    workspace: { chaves: [], herdadas: [] },
  });
  const [carregandoChaves, setCarregandoChaves] = useState(false);
  const [novoProvider, setNovoProvider] = useState("openrouter");
  const [novaChaveValor, setNovaChaveValor] = useState("");
  const [novoEscopo, setNovoEscopo] = useState<"global" | "workspace">(escopoConfig);
  const [salvandoChave, setSalvandoChave] = useState(false);

  // Estados do Cofre de Segredos (Secrets)
  const [secretsLista, setSecretsLista] = useState<SecretItem[]>([]);
  const [carregandoSecrets, setCarregandoSecrets] = useState(false);
  const [filtroEscopoSecrets, setFiltroEscopoSecrets] = useState<"todos" | "workspace" | "global">("todos");

  // Modal de Cadastro com Templates Especializados
  const [modalNovoAberto, setModalNovoAberto] = useState(false);
  const [templateAtivoId, setTemplateAtivoId] = useState<SecretTemplate["id"]>("wordpress");
  const [valoresForm, setValoresForm] = useState<Record<string, string>>({});
  const [mostrarSenhasForm, setMostrarSenhasForm] = useState<Record<string, boolean>>({});
  const [escopoSalvarNovo, setEscopoSalvarNovo] = useState<"global" | "workspace">(escopoConfig);
  const [salvandoSecret, setSalvandoSecret] = useState(false);

  // Modal de Atualização Segura (Write-Only Override)
  const [modalAtualizarAberto, setModalAtualizarAberto] = useState(false);
  const [secretEmAtualizacao, setSecretEmAtualizacao] = useState<SecretItem | null>(null);
  const [novoValorAtualizacao, setNovoValorAtualizacao] = useState("");
  const [mostrarSenhaAtualizacao, setMostrarSenhaAtualizacao] = useState(false);
  const [salvandoAtualizacao, setSalvandoAtualizacao] = useState(false);

  // Modal de Regras de Uso / Guia Informativo
  const [modalRegrasAberto, setModalRegrasAberto] = useState(false);
  const [detalhesRegras, setDetalhesRegras] = useState<{
    nome: string;
    tmpl: SecretTemplate;
    origem: string;
  } | null>(null);

  useEffect(() => {
    setNovoEscopo(escopoConfig);
    setEscopoSalvarNovo(escopoConfig);
  }, [escopoConfig]);

  const carregarChaves = useCallback(async () => {
    setCarregandoChaves(true);
    try {
      const data = await client.http.get<any>("/provider-keys");
      if (data) setChavesApi(data);
    } catch {
      // Silencioso se rota ainda não responder
    } finally {
      setCarregandoChaves(false);
    }
  }, [client]);

  const carregarSecrets = useCallback(async () => {
    setCarregandoSecrets(true);
    try {
      const data = await client.http.get<any[]>("/secrets");
      const normalizada: SecretItem[] = (data || []).map((s: any) =>
        typeof s === "string" ? { nome: s, origem: "global" } : s
      );
      setSecretsLista(normalizada);
    } catch (err: unknown) {
      setSecretsLista([]);
      tratarErro(err, "Falha ao carregar segredos do cofre");
    } finally {
      setCarregandoSecrets(false);
    }
  }, [client, tratarErro]);

  const adicionarChave = async () => {
    const prov = novoProvider.trim();
    const chave = novaChaveValor.trim();
    if (!chave) {
      showToast("Insira a chave de API", "aviso");
      return;
    }
    setSalvandoChave(true);
    try {
      await client.http.put("/provider-keys", {
        provider: prov,
        key: chave,
        escopo: novoEscopo,
      });
      showToast(`Chave do provedor ${prov} salva com sucesso!`, "sucesso");
      setNovaChaveValor("");
      await carregarChaves();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao salvar chave de API");
    } finally {
      setSalvandoChave(false);
    }
  };

  const removerChave = async (provider: string, escopoAlvo: string) => {
    if (
      !confirm(
        `Deseja remover a chave do provedor "${provider}" no escopo ${escopoAlvo}?`
      )
    )
      return;
    try {
      await client.http.delete(
        `/provider-keys/${encodeURIComponent(provider)}?escopo=${escopoAlvo}`
      );
      showToast(`Chave do provedor ${provider} removida`, "sucesso");
      await carregarChaves();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao remover chave");
    }
  };

  const testarConexaoModelo = async (model: string) => {
    try {
      const res = await client.http.post<any>("/llm/test", { model });
      if (res.ok) {
        showToast(
          `Modelo respondendo (${res.ms || 0}ms)! ${
            res.is_byok ? "• BYOK Custo $0" : ""
          }`,
          "sucesso"
        );
      } else {
        showToast(`Falha no teste: ${res.error || "Erro na API"}`, "erro");
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao testar conexão");
    }
  };

  // ── MÉTODOS DE GERENCIAMENTO DE SECRETS COM TEMPLATES ─────────────────

  const abrirModalNovo = (templateId?: SecretTemplate["id"]) => {
    const tId = templateId || "wordpress";
    setTemplateAtivoId(tId);
    const tmpl = TEMPLATES_SECRETS.find((t) => t.id === tId) || TEMPLATES_SECRETS[0];
    setValoresForm({
      nome_identificador: tmpl.sugestaoNome,
    });
    setMostrarSenhasForm({});
    setEscopoSalvarNovo(escopoConfig);
    setModalNovoAberto(true);
  };

  const mudarTemplate = (templateId: SecretTemplate["id"]) => {
    setTemplateAtivoId(templateId);
    const tmpl = TEMPLATES_SECRETS.find((t) => t.id === templateId) || TEMPLATES_SECRETS[0];
    setValoresForm({
      nome_identificador: tmpl.sugestaoNome,
    });
    setMostrarSenhasForm({});
  };

  const atualizarCampoForm = (chave: string, valor: string) => {
    setValoresForm((prev) => ({
      ...prev,
      [chave]: valor,
    }));
  };

  const alternarMostrarSenhaForm = (chave: string) => {
    setMostrarSenhasForm((prev) => ({
      ...prev,
      [chave]: !prev[chave],
    }));
  };

  const salvarNovoSecret = async () => {
    const tmpl = TEMPLATES_SECRETS.find((t) => t.id === templateAtivoId) || TEMPLATES_SECRETS[0];
    const nome = (valoresForm["nome_identificador"] || tmpl.sugestaoNome).trim();

    if (!nome) {
      showToast("Informe o nome identificador do segredo", "aviso");
      return;
    }

    // Validar campos obrigatórios do template
    for (const campo of tmpl.campos) {
      if (campo.obrigatorio && campo.chave !== "nome_identificador") {
        const val = (valoresForm[campo.chave] || "").trim();
        if (!val) {
          showToast(`O campo "${campo.rotulo.replace(" *", "")}" é obrigatório`, "aviso");
          return;
        }
      }
    }

    let valorFinal = "";

    if (tmpl.id === "custom") {
      if (nome.startsWith("app:custom:")) {
        valorFinal = JSON.stringify(
          {
            rotulo: nome,
            conteudo: (valoresForm["valor_secreto"] || "").trim(),
            notas: (valoresForm["notas"] || "").trim() || undefined,
          },
          null,
          2
        );
      } else {
        valorFinal = (valoresForm["valor_secreto"] || "").trim();
      }
    } else if (tmpl.id === "llm") {
      valorFinal = (valoresForm["chave_api"] || "").trim();
    } else if (tmpl.id === "github") {
      valorFinal = (valoresForm["token"] || "").trim();
    } else if (tmpl.id === "wordpress") {
      if (nome.startsWith("app:wordpress:")) {
        valorFinal = JSON.stringify(
          {
            rotulo: nome,
            url: (valoresForm["url"] || "").trim(),
            usuario: (valoresForm["usuario"] || "").trim(),
            senha_app: (valoresForm["senha_app"] || "").trim(),
            onde_roda: (valoresForm["onde_roda"] || "").trim() || undefined,
            notas: (valoresForm["notas"] || "").trim() || undefined,
          },
          null,
          2
        );
      } else {
        valorFinal = (valoresForm["senha_app"] || "").trim();
      }
    } else if (tmpl.id === "vps") {
      if (nome.startsWith("app:vps:")) {
        const portaRaw = (valoresForm["porta"] || "22").trim();
        valorFinal = JSON.stringify(
          {
            rotulo: nome,
            host: (valoresForm["host"] || "").trim(),
            porta: parseInt(portaRaw, 10) || 22,
            usuario: (valoresForm["usuario"] || "root").trim(),
            chave_ssh: (valoresForm["chave_ssh"] || "").trim() || undefined,
            senha: (valoresForm["senha"] || "").trim() || undefined,
            notas: (valoresForm["notas"] || "").trim() || undefined,
          },
          null,
          2
        );
      } else {
        valorFinal = (valoresForm["chave_ssh"] || valoresForm["senha"] || "").trim();
      }
    } else if (tmpl.id === "mercadopago") {
      if (nome.startsWith("app:mercadopago:")) {
        valorFinal = JSON.stringify(
          {
            rotulo: nome,
            public_key: (valoresForm["public_key"] || "").trim(),
            access_token: (valoresForm["access_token"] || "").trim(),
            ambiente: (valoresForm["ambiente"] || "test").trim(),
            notas: (valoresForm["notas"] || "").trim() || undefined,
          },
          null,
          2
        );
      } else {
        valorFinal = (valoresForm["access_token"] || "").trim();
      }
    }

    if (!valorFinal) {
      showToast("Preencha o valor da credencial", "aviso");
      return;
    }

    setSalvandoSecret(true);
    try {
      const res = await client.http.post<any>("/secrets", {
        nome: nome.trim(),
        valor: valorFinal.trim(),
        escopo: escopoSalvarNovo,
      });
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao salvar segredo");
      }
      showToast(
        `Segredo "${nome}" salvo no cofre (${escopoSalvarNovo === "workspace" ? "Workspace" : "Global"})!`,
        "sucesso"
      );
      setModalNovoAberto(false);
      await carregarSecrets();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao salvar segredo");
    } finally {
      setSalvandoSecret(false);
    }
  };

  const abrirModalAtualizacao = (secret: SecretItem) => {
    setSecretEmAtualizacao(secret);
    setNovoValorAtualizacao("");
    setMostrarSenhaAtualizacao(false);
    setModalAtualizarAberto(true);
  };

  const salvarAtualizacaoSecret = async () => {
    if (!secretEmAtualizacao) return;
    const valor = novoValorAtualizacao.trim();
    if (!valor) {
      showToast("Insira o novo valor para sobrescrever o segredo", "aviso");
      return;
    }
    setSalvandoAtualizacao(true);
    try {
      const res = await client.http.put<any>(
        `/secrets/${encodeURIComponent(secretEmAtualizacao.nome)}`,
        {
          valor,
          escopo: secretEmAtualizacao.origem || escopoConfig,
        }
      );
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao atualizar segredo");
      }
      showToast(`Segredo "${secretEmAtualizacao.nome}" atualizado com sucesso no cofre!`, "sucesso");
      setModalAtualizarAberto(false);
      setSecretEmAtualizacao(null);
      setNovoValorAtualizacao("");
      await carregarSecrets();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao atualizar segredo");
    } finally {
      setSalvandoAtualizacao(false);
    }
  };

  const removerSecret = async (nome: string, origem?: string) => {
    const escopoDesc = origem === "workspace" ? "do workspace" : "global";
    if (
      !confirm(
        `Remover permanentemente o segredo "${nome}" (${escopoDesc}) do cofre? Esta ação é irreversível.`
      )
    ) {
      return;
    }
    try {
      const query = origem ? `?escopo=${origem}` : "";
      const res = await client.http.delete<any>(
        `/secrets/${encodeURIComponent(nome)}${query}`
      );
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao remover segredo");
      }
      showToast(`Segredo "${nome}" removido do cofre`, "sucesso");
      await carregarSecrets();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao remover segredo");
    }
  };

  const copiarNomeSecret = (nome: string) => {
    void navigator.clipboard.writeText(nome);
    showToast(`Nome da variável "${nome}" copiado!`, "sucesso");
  };

  useEffect(() => {
    void carregarChaves();
    void carregarSecrets();
  }, [carregarChaves, carregarSecrets]);

  const chavesGlobal = chavesApi?.global?.chaves || [];
  const chavesWs = chavesApi?.workspace?.chaves || [];

  const secretsFiltrados = secretsLista.filter((s) => {
    const origem = s.origem || "global";
    if (filtroEscopoSecrets === "todos") return true;
    return origem === filtroEscopoSecrets;
  });

  const templateAtivo = TEMPLATES_SECRETS.find((t) => t.id === templateAtivoId) || TEMPLATES_SECRETS[0];

  return (
    <div className="space-y-8 bg-transparent">
      {/* ─────────────────────────────────────────────────────────────
          SEÇÃO 1: CHAVES DE API DOS PROVEDORES (BYOK & INFERÊNCIA)
         ───────────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800 gap-3">
          <div>
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Key size={16} className="text-amber-400" />
              Chaves de API dos Motores de IA (BYOK)
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Credenciais para OpenRouter, Google AI Studio, Anthropic e OpenAI com herança transparente por workspace.
            </p>
          </div>
          <button
            type="button"
            disabled={carregandoChaves}
            onClick={carregarChaves}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 text-xs font-medium transition-colors cursor-pointer self-start sm:self-center"
          >
            <RefreshCw size={13} className={carregandoChaves ? "animate-spin" : ""} />
            <span>Atualizar Chaves</span>
          </button>
        </div>

        {/* Formulário de Adicionar Nova Chave de Provedor */}
        <div className="p-4 rounded-xl border border-zinc-850 bg-zinc-900/30 space-y-3">
          <span className="text-xs font-semibold text-zinc-200 block">
            Adicionar ou Atualizar Chave de Provedor
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2.5">
            <select
              value={novoProvider}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setNovoProvider(e.target.value)
              }
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-orange-500 cursor-pointer"
            >
              <option value="openrouter">OpenRouter (BYOK / Universal)</option>
              <option value="google">Google AI Studio (Gemini Direct)</option>
              <option value="anthropic">Anthropic (Claude Direct)</option>
              <option value="openai">OpenAI (GPT-4o Direct)</option>
              <option value="groq">Groq (Ultra-Fast Inference)</option>
              <option value="ollama">Ollama Local (Offline)</option>
            </select>

            <select
              value={novoEscopo}
              onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                setNovoEscopo(e.target.value as "global" | "workspace")
              }
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-orange-500 cursor-pointer"
            >
              <option value="global">Escopo Global (Todas as Empresas)</option>
              <option value="workspace">Escopo Workspace (Exclusivo)</option>
            </select>

            <input
              type="password"
              placeholder="sk-or-v1-... ou chave da API"
              value={novaChaveValor}
              onChange={(e: ChangeEvent<HTMLInputElement>) =>
                setNovaChaveValor(e.target.value)
              }
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-mono text-zinc-200 focus:outline-none focus:border-orange-500"
            />

            <button
              type="button"
              disabled={salvandoChave}
              onClick={adicionarChave}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
            >
              {salvandoChave ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Plus size={13} />
              )}
              <span>Salvar Chave</span>
            </button>
          </div>
        </div>

        {/* Lista de Chaves Ativas */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Chaves Globais */}
          <div className="p-4 rounded-xl border border-zinc-850 bg-zinc-900/30 space-y-2.5">
            <div className="flex items-center justify-between pb-1 border-b border-zinc-800/40">
              <span className="text-xs font-semibold text-cyan-400 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
                Chaves no Escopo Global
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                {chavesGlobal.length} ativas
              </span>
            </div>
            <div className="space-y-2">
              {chavesGlobal.map((c: any, idx: number) => (
                <div
                  key={c.provider || idx}
                  data-testid={`chave-${c.provider}`}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-850 text-xs"
                >
                  <div>
                    <span className="font-semibold text-zinc-200 block font-mono">
                      {c.provider}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500">
                      {c.preview || "sk-••••••••"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void testarConexaoModelo(c.provider)}
                      className="p-1 rounded text-zinc-400 hover:text-emerald-400 transition-colors"
                      title="Testar ping"
                      aria-label={`Testar ping de ${c.provider}`}
                    >
                      <Play size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removerChave(c.provider, "global")}
                      className="p-1 rounded text-zinc-400 hover:text-rose-400 transition-colors"
                      title="Remover chave"
                      aria-label={`Remover chave de ${c.provider}`}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {chavesGlobal.length === 0 && (
                <p className="text-xs text-zinc-500 py-3 text-center">
                  Nenhuma chave global cadastrada.
                </p>
              )}
            </div>
          </div>

          {/* Chaves do Workspace */}
          <div className="p-4 rounded-xl border border-zinc-850 bg-zinc-900/30 space-y-2.5">
            <div className="flex items-center justify-between pb-1 border-b border-zinc-800/40">
              <span className="text-xs font-semibold text-purple-400 flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
                Chaves Exclusivas do Workspace
              </span>
              <span className="text-[10px] font-mono text-zinc-500">
                {chavesWs.length} ativas
              </span>
            </div>
            <div className="space-y-2">
              {chavesWs.map((c: any, idx: number) => (
                <div
                  key={c.provider || idx}
                  className="flex items-center justify-between p-2.5 rounded-lg bg-zinc-950/60 border border-zinc-850 text-xs"
                >
                  <div>
                    <span className="font-semibold text-zinc-200 block font-mono">
                      {c.provider}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-500">
                      {c.preview || "sk-••••••••"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => void testarConexaoModelo(c.provider)}
                      className="p-1 rounded text-zinc-400 hover:text-emerald-400 transition-colors"
                      title="Testar ping"
                    >
                      <Play size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void removerChave(c.provider, "workspace")}
                      className="p-1 rounded text-zinc-400 hover:text-rose-400 transition-colors"
                      title="Remover chave"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
              {chavesWs.length === 0 && (
                <p className="text-xs text-zinc-500 py-3 text-center">
                  O workspace utiliza chaves herdadas do escopo global.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          SEÇÃO 2: COFRE DE SEGREDOS & CREDENCIAIS DE APPS (SECRETS)
         ───────────────────────────────────────────────────────────── */}
      <div className="space-y-6 pt-6 border-t border-zinc-800">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800 gap-3">
          <div>
            <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
              <Lock size={16} className="text-emerald-400" />
              Cofre de Segredos &amp; Credenciais de Mini-Apps (Secrets)
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Armazenado em cofre local isolado no servidor (permissão estrita POSIX 0600 — somente escrita/consulta interna).
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
            <button
              type="button"
              disabled={carregandoSecrets}
              onClick={carregarSecrets}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
            >
              <RefreshCw size={13} className={carregandoSecrets ? "animate-spin" : ""} />
              <span>Atualizar Secrets</span>
            </button>
            <button
              type="button"
              onClick={() => abrirModalNovo()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer"
            >
              <Plus size={13} />
              <span>+ Novo Segredo</span>
            </button>
          </div>
        </div>

        {/* Banner Informativo de Honestidade e Segurança do Cofre */}
        <div className="flex items-start gap-3 p-3.5 rounded-xl border border-emerald-900/40 bg-emerald-950/20 text-xs text-emerald-200">
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-emerald-400" />
          <div className="space-y-0.5">
            <p className="font-semibold text-emerald-300">
              Arquitetura de Cofre Write-Only (Segurança Ativa)
            </p>
            <p className="text-emerald-200/80 leading-relaxed text-[11px]">
              Os valores de credenciais são persistidos diretamente em arquivo isolado no sistema com permissão POSIX 0600.
              Por conformidade de segurança e proteção contra vazamento, os segredos nunca são transmitidos em texto claro para a interface web após cadastrados.
            </p>
          </div>
        </div>

        {/* Grid de Templates Especializados Rápidos */}
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider block">
              Templates Estruturados para Mini-Apps &amp; Agentes
            </span>
            <span className="text-[11px] text-zinc-500">
              Clique em um template para configurar com validação guiada
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {TEMPLATES_SECRETS.map((tmpl) => {
              const Icone = tmpl.icone;

              return (
                <div
                  key={tmpl.id}
                  role="button"
                  tabIndex={0}
                  aria-label={`Configurar ${tmpl.rotulo}`}
                  data-testid={`template-segredo-${tmpl.id}`}
                  onClick={() => abrirModalNovo(tmpl.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      abrirModalNovo(tmpl.id);
                    }
                  }}
                  className="p-3.5 rounded-xl border border-zinc-850 bg-zinc-900/40 hover:border-emerald-500/50 hover:bg-zinc-850/60 transition-all cursor-pointer flex flex-col justify-between group space-y-3"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800 text-emerald-400 group-hover:border-emerald-500/40 transition-colors">
                        <Icone size={16} />
                      </div>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-950 text-zinc-400 border border-zinc-800">
                        {tmpl.id}
                      </span>
                    </div>

                    <div>
                      <h4 className="text-xs font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors">
                        {tmpl.rotulo}
                      </h4>
                      <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                        {tmpl.subtitulo}
                      </p>
                    </div>
                  </div>

                  <div className="pt-2 border-t border-zinc-800/60 flex items-center justify-between text-[11px] text-zinc-400">
                    <span className="font-mono text-zinc-500 truncate max-w-[170px]">
                      {tmpl.sugestaoNome}
                    </span>
                    <span className="text-emerald-400 font-semibold flex items-center gap-1 group-hover:underline">
                      Configurar <ChevronRight size={11} />
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Tabela de Segredos Armazenados no Cofre */}
        <div className="space-y-3 pt-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-300 font-mono">
                Credenciais Armazenadas ({secretsFiltrados.length})
              </span>
            </div>

            {/* Filtros de Escopo */}
            <div className="flex items-center gap-1 bg-zinc-900/80 p-1 rounded-lg border border-zinc-800 text-xs">
              <button
                type="button"
                onClick={() => setFiltroEscopoSecrets("todos")}
                data-testid="secrets-filtro-todos"
                aria-pressed={filtroEscopoSecrets === "todos"}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer ${
                  filtroEscopoSecrets === "todos"
                    ? "bg-zinc-800 text-zinc-100 font-semibold shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Layers size={11} />
                <span>Todos</span>
              </button>
              <button
                type="button"
                onClick={() => setFiltroEscopoSecrets("workspace")}
                data-testid="secrets-filtro-workspace"
                aria-pressed={filtroEscopoSecrets === "workspace"}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer ${
                  filtroEscopoSecrets === "workspace"
                    ? "bg-purple-950/60 text-purple-300 border border-purple-800/60 font-semibold shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Lock size={11} />
                <span>Workspace</span>
              </button>
              <button
                type="button"
                onClick={() => setFiltroEscopoSecrets("global")}
                data-testid="secrets-filtro-global"
                aria-pressed={filtroEscopoSecrets === "global"}
                className={`px-2.5 py-1 rounded text-[11px] font-medium transition-all flex items-center gap-1 cursor-pointer ${
                  filtroEscopoSecrets === "global"
                    ? "bg-cyan-950/60 text-cyan-300 border border-cyan-800/60 font-semibold shadow-xs"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Globe size={11} />
                <span>Global</span>
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-850 bg-zinc-900/30 overflow-hidden divide-y divide-zinc-850/60">
            {secretsFiltrados.map((sec, idx) => {
              const nome = sec.nome;
              const origem = sec.origem || "global";
              const tmpl = identificarTemplatePorNome(nome);
              const Icone = tmpl.icone;

              return (
                <div
                  key={nome || idx}
                  className="p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs hover:bg-zinc-900/60 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="h-8 w-8 rounded-lg bg-zinc-950 border border-zinc-800 flex items-center justify-center text-emerald-400 shrink-0">
                      <Icone size={15} />
                    </div>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-zinc-100 font-mono text-xs truncate">
                          {nome}
                        </span>
                        <span className="text-[10px] font-mono px-2 py-0.2 rounded bg-zinc-800 text-zinc-400 border border-zinc-700/60">
                          {tmpl.rotulo}
                        </span>
                        <span
                          className={`text-[10px] font-mono px-2 py-0.2 rounded border uppercase font-bold flex items-center gap-1 ${
                            origem === "workspace"
                              ? "text-purple-300 bg-purple-950/40 border-purple-800/50"
                              : "text-cyan-300 bg-cyan-950/40 border-cyan-800/50"
                          }`}
                        >
                          {origem === "workspace" ? (
                            <>
                              <Lock size={10} /> Workspace
                            </>
                          ) : (
                            <>
                              <Globe size={10} /> Global
                            </>
                          )}
                        </span>
                      </div>
                      <div className="text-[10px] font-mono text-zinc-500 flex items-center gap-1.5 flex-wrap">
                        <span>••••••••••••••••••••</span>
                        <span>·</span>
                        <span className="text-emerald-400/90 font-medium">
                          Armazenado no cofre (POSIX 0600 — Write-Only)
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-center">
                    {/* Botão Guia / Regras */}
                    <button
                      type="button"
                      onClick={() => {
                        setDetalhesRegras({ nome, tmpl, origem });
                        setModalRegrasAberto(true);
                      }}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-zinc-100 border border-zinc-800 text-[11px] font-medium transition-colors cursor-pointer"
                      title="Ver regras de uso e permissões desta credencial"
                    >
                      <Info size={12} className="text-blue-400" />
                      <span>Guia</span>
                    </button>

                    {/* Botão Copiar Nome */}
                    <button
                      type="button"
                      onClick={() => copiarNomeSecret(nome)}
                      className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition-colors cursor-pointer"
                      title="Copiar nome identificador da variável"
                    >
                      <Copy size={13} />
                    </button>

                    {/* Botão Atualizar (Write-Only Override) */}
                    <button
                      type="button"
                      onClick={() => abrirModalAtualizacao(sec)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-zinc-100 border border-zinc-800 text-[11px] font-medium transition-colors cursor-pointer"
                      title="Sobrescrever valor deste segredo no cofre"
                    >
                      <Edit3 size={12} className="text-orange-400" />
                      <span>Atualizar</span>
                    </button>

                    {/* Botão Destrutivo Excluir */}
                    <button
                      type="button"
                      onClick={() => void removerSecret(nome, origem)}
                      className="p-1.5 rounded-lg bg-zinc-900 hover:bg-rose-950/40 text-rose-400 hover:text-rose-300 border border-zinc-800 hover:border-rose-900/50 transition-colors cursor-pointer"
                      title="Excluir segredo permanentemente"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              );
            })}

            {secretsFiltrados.length === 0 && (
              <div className="py-10 text-center text-xs text-zinc-500 space-y-2">
                <Lock size={20} className="mx-auto text-zinc-600 mb-1" />
                <p>Nenhuma credencial ou segredo cadastrado para este filtro.</p>
                <button
                  type="button"
                  onClick={() => abrirModalNovo()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs transition-colors cursor-pointer mt-1"
                >
                  <Plus size={13} /> Adicionar Primeiro Segredo
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─────────────────────────────────────────────────────────────
          MODAL 1: CADASTRO COM TEMPLATES ESPECIALIZADOS
         ───────────────────────────────────────────────────────────── */}
      {modalNovoAberto && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-3xl w-full p-5 space-y-4 shadow-2xl max-h-[92vh] flex flex-col">
            {/* Topo do Modal */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 shrink-0">
              <div className="flex items-center gap-2">
                <KeyRound size={18} className="text-emerald-400" />
                <h3 className="text-sm font-bold text-zinc-100">
                  Adicionar Credencial com Template Especializado
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModalNovoAberto(false)}
                aria-label="Fechar"
                className="text-zinc-400 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            {/* Seletor Horizontal de Templates */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 shrink-0 scrollbar-none">
              {TEMPLATES_SECRETS.map((tmpl) => {
                const Icone = tmpl.icone;
                const isAtivo = templateAtivoId === tmpl.id;

                return (
                  <button
                    key={tmpl.id}
                    type="button"
                    onClick={() => mudarTemplate(tmpl.id)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shrink-0 cursor-pointer ${
                      isAtivo
                        ? "bg-zinc-800 text-emerald-300 border border-emerald-500/50 shadow-xs font-semibold"
                        : "text-zinc-400 hover:text-zinc-200 bg-zinc-950/60 border border-zinc-850"
                    }`}
                  >
                    <Icone size={14} className={isAtivo ? "text-emerald-400" : "text-zinc-400"} />
                    <span>{tmpl.rotulo}</span>
                  </button>
                );
              })}
            </div>

            {/* Conteúdo com Scroll */}
            <div className="flex-1 overflow-y-auto space-y-4 pr-1 text-xs">
              {/* Box de Instruções & Regras de Uso do Template */}
              <div className="rounded-xl border border-blue-900/40 bg-blue-950/20 p-4 space-y-3">
                <div className="flex items-center gap-2 font-bold text-blue-300 text-xs font-mono">
                  <Info size={15} className="text-blue-400" />
                  <span>Guia de Operação: {templateAtivo.rotulo}</span>
                </div>

                {/* Como Encontrar */}
                <div className="space-y-1">
                  <div className="font-semibold text-zinc-200 text-[11px] uppercase tracking-wider font-mono flex items-center gap-1">
                    <MapPin size={11} className="text-zinc-400" />
                    <span>Como Gerar / Obter a Chave:</span>
                  </div>
                  <div className="text-zinc-300 space-y-1 leading-relaxed pl-1 text-[11px]">
                    {templateAtivo.comoEncontrar.map((passo, idx) => (
                      <p key={idx}>{passo}</p>
                    ))}
                  </div>
                </div>

                {/* O Que Dá Acesso */}
                <div className="space-y-1 pt-1 border-t border-blue-900/30">
                  <div className="font-semibold text-zinc-200 text-[11px] uppercase tracking-wider font-mono flex items-center gap-1">
                    <Key size={11} className="text-zinc-400" />
                    <span>Capacidades Habilitadas para os Agentes:</span>
                  </div>
                  <ul className="list-disc list-inside text-zinc-300 space-y-0.5 pl-1 text-[11px]">
                    {templateAtivo.oQueDaAcesso.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>

                {/* Regras de Uso & Segurança */}
                <div className="space-y-1 pt-1 border-t border-blue-900/30">
                  <div className="font-semibold text-amber-300 text-[11px] uppercase tracking-wider font-mono flex items-center gap-1">
                    <ShieldCheck size={13} />
                    <span>Boas Práticas &amp; Governança:</span>
                  </div>
                  <ul className="list-disc list-inside text-amber-200/90 space-y-0.5 pl-1 text-[11px] leading-relaxed">
                    {templateAtivo.regrasDeUso.map((regra, idx) => (
                      <li key={idx}>{regra}</li>
                    ))}
                  </ul>
                </div>
              </div>

              {/* Seletor de Escopo de Armazenamento */}
              <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80 space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                    <Lock size={13} className="text-emerald-400" />
                    <span>Destino no Cofre:</span>
                  </label>
                  <span className="text-[10px] text-zinc-500">
                    Defina o isolamento do segredo
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setEscopoSalvarNovo("workspace")}
                    className={`p-2.5 rounded-lg border text-left flex flex-col gap-0.5 transition-all cursor-pointer ${
                      escopoSalvarNovo === "workspace"
                        ? "bg-purple-950/30 border-purple-600/60 text-purple-200 ring-1 ring-purple-500/40"
                        : "bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                    }`}
                  >
                    <span className="text-xs font-bold flex items-center gap-1">
                      <Lock size={11} className="text-purple-400" /> Workspace Atual
                    </span>
                    <span className="text-[10px] opacity-80 leading-tight">
                      Isolado no workspace ativo (maior precedência)
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEscopoSalvarNovo("global")}
                    className={`p-2.5 rounded-lg border text-left flex flex-col gap-0.5 transition-all cursor-pointer ${
                      escopoSalvarNovo === "global"
                        ? "bg-cyan-950/30 border-cyan-600/60 text-cyan-200 ring-1 ring-cyan-500/40"
                        : "bg-zinc-900/50 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                    }`}
                  >
                    <span className="text-xs font-bold flex items-center gap-1">
                      <Globe size={11} className="text-cyan-400" /> Global (Todos)
                    </span>
                    <span className="text-[10px] opacity-80 leading-tight">
                      Disponível como fallback para todos os workspaces
                    </span>
                  </button>
                </div>
              </div>

              {/* Formulário dos Campos do Template */}
              <div className="space-y-3 pt-1">
                <span className="font-semibold text-zinc-200 font-mono text-[11px] uppercase tracking-wider block">
                  Parâmetros da Credencial:
                </span>

                {templateAtivo.campos.map((campo) => {
                  const valorAtual = valoresForm[campo.chave] || "";
                  const mostrarSenha = Boolean(mostrarSenhasForm[campo.chave]);

                  return (
                    <div key={campo.chave} className="space-y-1">
                      <label className="block text-zinc-300 font-medium text-xs">
                        {campo.rotulo}
                      </label>

                      {campo.tipo === "textarea" ? (
                        <textarea
                          rows={3}
                          placeholder={campo.placeholder}
                          value={valorAtual}
                          onChange={(e) => atualizarCampoForm(campo.chave, e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-hidden focus:border-emerald-500 font-mono text-xs"
                        />
                      ) : campo.tipo === "select" ? (
                        <select
                          value={valorAtual || (campo.opcoes?.[0]?.valor ?? "")}
                          onChange={(e) => atualizarCampoForm(campo.chave, e.target.value)}
                          className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-hidden focus:border-emerald-500 text-xs cursor-pointer"
                        >
                          {campo.opcoes?.map((opt) => (
                            <option key={opt.valor} value={opt.valor}>
                              {opt.rotulo}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="relative flex items-center">
                          <input
                            type={
                              campo.tipo === "password"
                                ? mostrarSenha
                                  ? "text"
                                  : "password"
                                : "text"
                            }
                            placeholder={campo.placeholder}
                            value={valorAtual}
                            onChange={(e) => atualizarCampoForm(campo.chave, e.target.value)}
                            className={`w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-zinc-200 focus:outline-hidden focus:border-emerald-500 font-mono text-xs ${
                              campo.tipo === "password" ? "pr-10" : ""
                            }`}
                          />
                          {campo.tipo === "password" && (
                            <button
                              type="button"
                              onClick={() => alternarMostrarSenhaForm(campo.chave)}
                              className="absolute right-2.5 text-zinc-400 hover:text-zinc-200 p-1 cursor-pointer"
                              title={mostrarSenha ? "Ocultar" : "Mostrar"}
                            >
                              {mostrarSenha ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Rodapé do Modal */}
            <div className="flex items-center justify-end gap-2 border-t border-zinc-800 pt-3 shrink-0">
              <button
                type="button"
                onClick={() => setModalNovoAberto(false)}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-850 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={salvandoSecret}
                onClick={salvarNovoSecret}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
              >
                {salvandoSecret ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                <span>Salvar no Cofre</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          MODAL 2: ATUALIZAÇÃO SEGURA DE VALOR (WRITE-ONLY OVERRIDE)
         ───────────────────────────────────────────────────────────── */}
      {modalAtualizarAberto && secretEmAtualizacao && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Edit3 size={18} className="text-orange-400" />
                <h3 className="text-sm font-bold text-zinc-100">
                  Sobrescrever Segredo: {secretEmAtualizacao.nome}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setModalAtualizarAberto(false);
                  setSecretEmAtualizacao(null);
                }}
                className="text-zinc-400 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-850 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-3 rounded-xl border border-amber-800/40 bg-amber-950/20 text-xs text-amber-200 space-y-1">
              <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                <AlertCircle size={14} className="shrink-0" />
                <span>Política de Segurança Estrita (Write-Only)</span>
              </div>
              <p className="text-[11px] text-amber-200/80 leading-relaxed">
                Por governança, o valor anterior permanece gravado no cofre do servidor e não pode ser exibido.
                Digite o novo valor para sobrescrever a credencial.
              </p>
            </div>

            <div className="space-y-1 text-xs">
              <label className="block text-zinc-300 font-medium">
                Novo Valor da Credencial *
              </label>
              <div className="relative flex items-center">
                <input
                  type={mostrarSenhaAtualizacao ? "text" : "password"}
                  placeholder="Insira o novo token, senha ou payload..."
                  value={novoValorAtualizacao}
                  onChange={(e) => setNovoValorAtualizacao(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 pr-10 text-zinc-200 focus:outline-hidden focus:border-orange-500 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setMostrarSenhaAtualizacao((prev) => !prev)}
                  className="absolute right-2.5 text-zinc-400 hover:text-zinc-200 p-1 cursor-pointer"
                  title={mostrarSenhaAtualizacao ? "Ocultar" : "Mostrar"}
                >
                  {mostrarSenhaAtualizacao ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-zinc-800 pt-3">
              <button
                type="button"
                onClick={() => {
                  setModalAtualizarAberto(false);
                  setSecretEmAtualizacao(null);
                }}
                className="px-3.5 py-1.5 rounded-lg bg-zinc-850 hover:bg-zinc-800 text-zinc-300 text-xs font-semibold transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                disabled={salvandoAtualizacao}
                onClick={salvarAtualizacaoSecret}
                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
              >
                {salvandoAtualizacao ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Check size={13} />
                )}
                <span>Sobrescrever no Cofre</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          MODAL 3: REGRAS DE USO & GUIA DE CAPACIDADES DO SEGREDO
         ───────────────────────────────────────────────────────────── */}
      {modalRegrasAberto && detalhesRegras && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-xs flex items-center justify-center p-3 sm:p-4 z-50 animate-in fade-in duration-150">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-lg w-full p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <div className="flex items-center gap-2">
                <Info size={18} className="text-blue-400" />
                <h3 className="text-sm font-bold text-zinc-100">
                  Regras de Operação: {detalhesRegras.nome}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => {
                  setModalRegrasAberto(false);
                  setDetalhesRegras(null);
                }}
                className="text-zinc-400 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-850 transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3 text-xs leading-relaxed text-zinc-300">
              <div className="p-3 rounded-xl bg-zinc-950/70 border border-zinc-800/80 space-y-1">
                <span className="text-[10px] font-mono text-zinc-500 block uppercase">
                  Classificação do Template
                </span>
                <p className="font-bold text-zinc-100 font-mono">
                  {detalhesRegras.tmpl.rotulo}
                </p>
                <p className="text-[11px] text-zinc-400">
                  {detalhesRegras.tmpl.subtitulo}
                </p>
              </div>

              <div className="space-y-1">
                <span className="font-semibold text-zinc-200 text-[11px] font-mono uppercase tracking-wider block">
                  Capacidades Acessadas no Sistema:
                </span>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-zinc-300">
                  {detalhesRegras.tmpl.oQueDaAcesso.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="space-y-1 pt-1 border-t border-zinc-800/60">
                <span className="font-semibold text-amber-300 text-[11px] font-mono uppercase tracking-wider block">
                  Regras de Segurança &amp; Auditoria:
                </span>
                <ul className="list-disc list-inside space-y-0.5 text-[11px] text-amber-200/90">
                  {detalhesRegras.tmpl.regrasDeUso.map((regra, idx) => (
                    <li key={idx}>{regra}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="flex items-center justify-end border-t border-zinc-800 pt-3">
              <button
                type="button"
                onClick={() => {
                  setModalRegrasAberto(false);
                  setDetalhesRegras(null);
                }}
                className="px-4 py-1.5 rounded-lg bg-zinc-850 hover:bg-zinc-800 text-zinc-200 text-xs font-semibold transition-colors cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

