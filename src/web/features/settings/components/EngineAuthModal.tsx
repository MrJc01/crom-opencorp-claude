import React, { useState, useEffect, useRef, useCallback, type FC } from "react";
import {
  Globe,
  KeyRound,
  Terminal,
  X,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Zap,
  Play,
  Eye,
  EyeOff,
  Cpu,
} from "lucide-react";
import { showToast } from "../../../shared/ui/Toast.js";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { ModelPicker } from "../../../shared/ui/ModelPicker.js";

export interface EngineAuthModalProps {
  aberto: boolean;
  motorId: string | null;
  motorNome?: string;
  aoFechar: () => void;
  aoSalvarSucesso: () => void;
}

export interface ProvedorItem {
  id: string;
  nome: string;
  envVar: string;
  url: string;
  urlText: string;
  placeholder: string;
  desc: string;
  defaultBaseUrl?: string;
}

export const PROVEDORES_DISPONIVEIS: ProvedorItem[] = [
  {
    id: "openrouter",
    nome: "OpenRouter (Universal & BYOK)",
    envVar: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/keys",
    urlText: "OpenRouter Keys",
    placeholder: "sk-or-v1-...",
    desc: "Roteador universal com suporte a BYOK Google AI Studio ($0), NVIDIA Nemotron e centenas de modelos.",
  },
  {
    id: "google",
    nome: "Google AI Studio / Gemini",
    envVar: "GEMINI_API_KEY",
    url: "https://aistudio.google.com/app/apikey",
    urlText: "Google AI Studio",
    placeholder: "AIzaSy...",
    desc: "Gemini 2.5 e 3.8 Flash/Pro gratuitos no tier padrão do Google AI Studio.",
  },
  {
    id: "anthropic",
    nome: "Anthropic Claude Direto",
    envVar: "ANTHROPIC_API_KEY",
    url: "https://console.anthropic.com/settings/keys",
    urlText: "Console Anthropic",
    placeholder: "sk-ant-api03-...",
    desc: "Claude 3.7 Sonnet, Claude 3.5 Sonnet e Haiku com acesso direto oficial.",
  },
  {
    id: "openai",
    nome: "OpenAI API Direta",
    envVar: "OPENAI_API_KEY",
    url: "https://platform.openai.com/api-keys",
    urlText: "Plataforma OpenAI",
    placeholder: "sk-proj-...",
    desc: "Acesso a GPT-4o, o3-mini e modelos de raciocínio da OpenAI.",
  },
  {
    id: "deepseek",
    nome: "DeepSeek Oficial",
    envVar: "DEEPSEEK_API_KEY",
    url: "https://platform.deepseek.com/api_keys",
    urlText: "DeepSeek Platform",
    placeholder: "sk-...",
    desc: "DeepSeek-V3 e DeepSeek-R1 oficial com custo por token extremamente baixo.",
  },
  {
    id: "groq",
    nome: "Groq LPU",
    envVar: "GROQ_API_KEY",
    url: "https://console.groq.com/keys",
    urlText: "Groq Console",
    placeholder: "gsk_...",
    desc: "Inferência em altíssima velocidade para Llama 3.3 70B e modelos abertos.",
  },
  {
    id: "ollama",
    nome: "Ollama (Local)",
    envVar: "OLLAMA_HOST",
    url: "https://ollama.com",
    urlText: "Ollama Docs",
    placeholder: "http://localhost:11434",
    desc: "Servidor Ollama local para execução privada e offline sem custos.",
    defaultBaseUrl: "http://localhost:11434",
  },
  {
    id: "custom",
    nome: "Provedor Customizado (OpenAI-Compatible)",
    envVar: "CUSTOM_API_KEY",
    url: "",
    urlText: "",
    placeholder: "Chave de API do provedor",
    desc: "Qualquer endpoint compatível com a API da OpenAI (vLLM, LM Studio, TGI, etc.).",
    defaultBaseUrl: "https://api.provedor.com/v1",
  },
];

interface WebLoginSession {
  id: string;
  motorId: string;
  status: "iniciando" | "aguardando_usuario" | "concluido" | "erro";
  authUrl?: string;
  userCode?: string;
  message?: string;
  autoInheritAvailable?: boolean;
  autoInheritUser?: string;
  accountName?: string;
}

export const EngineAuthModal: FC<EngineAuthModalProps> = ({
  aberto,
  motorId,
  motorNome,
  aoFechar,
  aoSalvarSucesso,
}) => {
  const { client, tratarErro } = useOpenCorp();

  // Abas do Modal: "chave" | "web" | "cli"
  const [abaModal, setAbaModal] = useState<"chave" | "web" | "cli">("chave");

  // Formulário Chave / Conta Manual
  const [nomeConta, setNomeConta] = useState("");
  const [tokenOuChave, setTokenOuChave] = useState("");
  const [mostrarToken, setMostrarToken] = useState(false);
  const [provedor, setProvedor] = useState("openrouter");
  const [baseUrl, setBaseUrl] = useState("");
  const [modeloPadrao, setModeloPadrao] = useState("");
  const [cotaDiariaUsd, setCotaDiariaUsd] = useState(10);
  const [rateLimitRpm, setRateLimitRpm] = useState(30);
  const [salvandoConta, setSalvandoConta] = useState(false);
  const [erroForm, setErroForm] = useState<string | null>(null);

  // Instruções dinâmicas do Backend
  const [instrucoesBackend, setInstrucoesBackend] = useState<any>(null);

  // Estados Web Login (1-clique / device code)
  const [webSession, setWebSession] = useState<WebLoginSession | null>(null);
  const [iniciandoWeb, setIniciandoWeb] = useState(false);
  const [autoConectando, setAutoConectando] = useState(false);
  const [codigoResposta, setCodigoResposta] = useState("");
  const [enviandoCodigo, setEnviandoCodigo] = useState(false);
  const pollingRef = useRef<NodeJS.Timeout | null>(null);

  // Estados Diagnóstico CLI / Prontidão
  const [testando, setTestando] = useState(false);
  const [testResult, setTestResult] = useState<any | null>(null);
  const [conectandoMotor, setConectandoMotor] = useState(false);

  // Helpers de cópia
  const [copiadoComando, setCopiadoComando] = useState(false);
  const [copiadoCodigo, setCopiadoCodigo] = useState(false);
  const [copiadoUrl, setCopiadoUrl] = useState(false);

  const limparPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const isWebSupported = Boolean(instrucoesBackend?.login?.web);
  // Motor sem variável de credencial no manifest só autentica pelo CLI.
  const soCli = Boolean(instrucoesBackend && !instrucoesBackend.envVar);
  const importaGithub = Boolean(instrucoesBackend?.login?.importar);
  const pedeCodigoNoLogin = Boolean(instrucoesBackend?.login?.codigo);

  // Reset e inicialização ao abrir
  useEffect(() => {
    if (aberto && motorId) {
      limparPolling();
      setWebSession(null);
      setTestResult(null);
      setErroForm(null);
      setCodigoResposta("");
      setMostrarToken(false);

      // Define aba inicial: web se suportado, senão chave
      if (soCli) {
        setAbaModal("cli");
      } else if (isWebSupported) {
        setAbaModal("web");
      } else {
        setAbaModal("chave");
      }

      // Sugestão de nome inicial
      const provInicial = PROVEDORES_DISPONIVEIS[0]!;
      setProvedor(provInicial.id);
      setNomeConta(`${motorNome || motorId} - Principal`);
      setTokenOuChave("");
      setBaseUrl("");
      setModeloPadrao("");

      // Buscar instruções dinâmicas do backend
      void client.http
        .get<any>(`/api/motores/${encodeURIComponent(motorId)}/auth-instructions`)
        .then((res: any) => {
          if (res?.ok && res.instructions) {
            setInstrucoesBackend(res.instructions);
          }
        })
        .catch(() => {
          setInstrucoesBackend(null);
        });
    } else {
      limparPolling();
      setWebSession(null);
    }

    return () => limparPolling();
  }, [aberto, motorId, motorNome, isWebSupported, soCli, client, limparPolling]);

  // Atualizar baseUrl e nome quando provedor muda
  const handleMudarProvedor = (novoProvId: string) => {
    setProvedor(novoProvId);
    const prov = PROVEDORES_DISPONIVEIS.find((p) => p.id === novoProvId);
    if (prov) {
      if (prov.defaultBaseUrl) {
        setBaseUrl(prov.defaultBaseUrl);
      } else if (baseUrl === "http://localhost:11434") {
        setBaseUrl("");
      }
      setNomeConta(`${prov.nome.split(" ")[0]} - ${motorNome || motorId || "Conta"}`);
    }
  };

  // Obter instruções estáticas ou dinâmicas
  const obterInstrucoes = () => {
    // Instruções fixas por motor são a base; o backend só sobrescreve o que informar.
    const fixas = instrucoesFixas();
    if (instrucoesBackend) {
      return {
        title: instrucoesBackend.title || fixas.title || motorNome || motorId,
        cliCommand: instrucoesBackend.cliCommand || fixas.cliCommand,
        envVar: instrucoesBackend.envVar || fixas.envVar,
        url: instrucoesBackend.url || fixas.url,
        urlText: instrucoesBackend.urlText || fixas.urlText,
        desc: instrucoesBackend.desc || fixas.desc,
        webPrompt: instrucoesBackend.webPrompt || fixas.webPrompt,
      };
    }
    return fixas;
  };

  // Fallback genérico: o texto específico de cada motor vem do manifest (instrucoesBackend).
  const instrucoesFixas = () => {
    const provAtual = PROVEDORES_DISPONIVEIS.find((p) => p.id === provedor) || PROVEDORES_DISPONIVEIS[0]!;
    return {
      title: motorNome || motorId || "Motor de IA",
      cliCommand: `export ${provAtual.envVar}=...`,
      envVar: provAtual.envVar,
      url: provAtual.url,
      urlText: provAtual.urlText,
      desc: provAtual.desc,
      webPrompt: `Conecte sua conta ${provAtual.nome} para utilização pelo runtime de execução nos workspaces.`,
    };
  };

  const instrucoes = obterInstrucoes();

  // Copiar para clipboard com feedback
  const copiarParaClipboard = (texto: string, tipo: "comando" | "codigo" | "url") => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(texto);
      if (tipo === "comando") {
        setCopiadoComando(true);
        setTimeout(() => setCopiadoComando(false), 2000);
      } else if (tipo === "codigo") {
        setCopiadoCodigo(true);
        setTimeout(() => setCopiadoCodigo(false), 2000);
      } else {
        setCopiadoUrl(true);
        setTimeout(() => setCopiadoUrl(false), 2000);
      }
      showToast("Copiado para a área de transferência!", "sucesso");
    }
  };

  // SUBMETER CONTA MANUAL / CHAVE (POST /api/motores/:id/contas)
  const salvarContaManual = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!motorId) return;

    const nomeFormatado = nomeConta.trim();
    if (!nomeFormatado) {
      setErroForm("O nome ou identificador da conta é obrigatório.");
      return;
    }

    const provAtual = PROVEDORES_DISPONIVEIS.find((p) => p.id === provedor);
    const requerChave = provAtual?.id !== "ollama";
    if (requerChave && !tokenOuChave.trim()) {
      setErroForm("Informe a chave de API ou credencial para conectar.");
      return;
    }

    setSalvandoConta(true);
    setErroForm(null);

    try {
      const isCustomOrOllama = provedor === "custom" || provedor === "ollama";
      const payload = {
        nome: nomeFormatado,
        provider: provedor,
        baseUrl: isCustomOrOllama ? baseUrl.trim() || undefined : undefined,
        modeloPadrao: modeloPadrao.trim() || undefined,
        tokenOuChave: tokenOuChave.trim() || undefined,
        authType: tokenOuChave.trim() ? "token" : "deviceOAuth",
        limits: {
          daily_cost_usd: Number(cotaDiariaUsd) || 10,
          rate_limit_rpm: Number(rateLimitRpm) || 30,
        },
      };

      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/contas`,
        payload
      );

      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao registrar conta no servidor");
      }

      showToast(`Conta "${nomeFormatado}" conectada ao motor ${motorNome || motorId}!`, "sucesso");
      aoSalvarSucesso();
      aoFechar();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setErroForm(msg);
      tratarErro(err, "Falha ao conectar conta de motor");
    } finally {
      setSalvandoConta(false);
    }
  };

  // FLUXO DE LOGIN WEB / DEVICE (POST /api/motores/:id/login-web)
  const iniciarLoginWeb = async () => {
    if (!motorId) return;
    setIniciandoWeb(true);
    limparPolling();

    try {
      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/login-web`,
        {}
      );

      if (res?.ok && res.session) {
        setWebSession(res.session);

        if (res.session.status === "concluido") {
          showToast(`Motor ${motorNome || motorId} autenticado com sucesso!`, "sucesso");
          aoSalvarSucesso();
          return;
        }

        if (res.session.status === "iniciando" || res.session.status === "aguardando_usuario") {
          iniciarPollingSessao(res.session.id);
        }
      } else {
        const msg = res?.erro || "Não foi possível iniciar a sessão de login web";
        showToast(msg, "erro");
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao iniciar autorização no navegador");
    } finally {
      setIniciandoWeb(false);
    }
  };

  const iniciarPollingSessao = (sessionId: string) => {
    limparPolling();
    pollingRef.current = setInterval(async () => {
      if (!motorId) return;
      try {
        const res = await client.http.get<any>(
          `/api/motores/${encodeURIComponent(motorId)}/login-web/${encodeURIComponent(sessionId)}`
        );

        if (res?.ok && res.session) {
          setWebSession(res.session);

          if (res.session.status === "concluido") {
            limparPolling();
            showToast(`Autenticação de ${motorNome || motorId} concluída com sucesso!`, "sucesso");
            aoSalvarSucesso();
          } else if (res.session.status === "erro") {
            limparPolling();
            showToast(`Falha na autenticação: ${res.session.message || "Processo encerrado"}`, "aviso");
          }
        }
      } catch {
        // Polling silencioso
      }
    }, 2000);
  };

  const cancelarLoginWeb = async () => {
    if (!webSession || !motorId) return;
    limparPolling();
    try {
      await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/login-web/${encodeURIComponent(webSession.id)}/cancel`,
        {}
      );
    } catch {
      // Ignora erro ao cancelar
    } finally {
      setWebSession(null);
      showToast("Tentativa de login cancelada.", "aviso");
    }
  };

  const submeterCodigoLogin = async () => {
    if (!webSession || !motorId || !codigoResposta.trim()) return;
    setEnviandoCodigo(true);
    try {
      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/login-web/${encodeURIComponent(webSession.id)}/code`,
        { code: codigoResposta.trim() }
      );
      if (res?.ok) {
        showToast("Código enviado para validação!", "sucesso");
      } else {
        showToast("Código rejeitado ou inválido", "erro");
      }
    } catch (err: unknown) {
      tratarErro(err, "Falha ao enviar código");
    } finally {
      setEnviandoCodigo(false);
    }
  };

  // CONEXÃO AUTOMÁTICA GITHUB CLI 1-CLIQUE (COPILOT)
  const conectarAutomaticoCli = async () => {
    if (!motorId) return;
    setAutoConectando(true);
    try {
      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/login-auto`,
        {}
      );
      if (res?.ok) {
        showToast("Conta conectada com sucesso a partir do GitHub CLI!", "sucesso");
        aoSalvarSucesso();
        aoFechar();
      } else {
        showToast(`Não foi possível conectar automaticamente: ${res?.erro || "Erro desconhecido"}`, "aviso");
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao conectar automaticamente");
    } finally {
      setAutoConectando(false);
    }
  };

  // TESTAR PRONTIDÃO REAL (POST /api/motores/:id/test)
  const testarProntidao = async () => {
    if (!motorId) return;
    setTestando(true);
    setTestResult(null);
    try {
      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/test`,
        {}
      );
      setTestResult(res?.health || null);
      if (res?.ok && res?.health?.healthy) {
        showToast(`Motor ${motorNome || motorId} está operacional e autenticado (${res.ms || 0}ms)!`, "sucesso");
        aoSalvarSucesso();
      } else {
        const causa = res?.health?.statusText || res?.erro || "Requer autenticação";
        showToast(
          `Motor requer autenticação: ${causa}`,
          "aviso",
        );
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao testar prontidão do motor");
    } finally {
      setTestando(false);
    }
  };

  // ATIVAR MOTOR COMO PADRÃO NO RUNNER.JSON (POST /api/motores/:id/conectar?forcar=true)
  const ativarMotorComoPadrao = async () => {
    if (!motorId) return;
    setConectandoMotor(true);
    try {
      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/conectar?forcar=true`,
        {}
      );
      if (res?.ok) {
        showToast(`Motor "${motorNome || motorId}" conectado e ativado no runner!`, "sucesso");
        aoSalvarSucesso();
        aoFechar();
      } else {
        showToast(res?.erro || "Falha ao ativar motor", "erro");
      }
    } catch (err: unknown) {
      tratarErro(err, "Erro ao ativar motor");
    } finally {
      setConectandoMotor(false);
    }
  };

  if (!aberto || !motorId) return null;

  return (
    <div
      className="fixed inset-0 bg-black/75 backdrop-blur-xs flex items-center justify-center p-4 z-50 select-none animate-in fade-in duration-100"
      onClick={aoFechar}
    >
      <div
        className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-xl w-full overflow-hidden shadow-2xl animate-in zoom-in-95 duration-100 flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* CABEÇALHO */}
        <div className="p-4 border-b border-zinc-800 flex items-start justify-between gap-3 bg-zinc-950/60 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-orange-600/10 border border-orange-500/20 flex items-center justify-center text-orange-400 shrink-0">
              {abaModal === "web" ? <Globe size={20} /> : abaModal === "cli" ? <Terminal size={20} /> : <KeyRound size={20} />}
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <span>Autenticar: {motorNome || motorId}</span>
              </h3>
              <p className="text-xs text-zinc-400 mt-0.5">
                {abaModal === "web"
                  ? "Login direto no navegador via autorização de dispositivo"
                  : abaModal === "cli"
                  ? "Instruções oficiais de terminal e verificação de prontidão"
                  : "Credenciais de API e instâncias dedicadas de execução"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={aoFechar}
            className="text-zinc-500 hover:text-zinc-200 p-1 rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer"
            title="Fechar modal"
          >
            <X size={16} />
          </button>
        </div>

        {/* SELETOR DE ABAS */}
        <div className="px-4 pt-3 pb-2 border-b border-zinc-800/60 flex items-center gap-1.5 bg-zinc-950/30 shrink-0">
          {isWebSupported && (
            <button
              type="button"
              onClick={() => setAbaModal("web")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                abaModal === "web"
                  ? "bg-emerald-950/50 text-emerald-300 border border-emerald-700/60 shadow-xs"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <Globe size={13} />
              <span>Login no Navegador (1-Clique)</span>
            </button>
          )}

          {!soCli && (
            <button
              type="button"
              onClick={() => setAbaModal("chave")}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
                abaModal === "chave"
                  ? "bg-zinc-800 text-zinc-100 border border-zinc-700/60 shadow-xs"
                  : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
              }`}
            >
              <KeyRound size={13} />
              <span>Token / Chave Manual</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setAbaModal("cli")}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 cursor-pointer ${
              abaModal === "cli"
                ? "bg-zinc-800 text-zinc-100 border border-zinc-700/60 shadow-xs"
                : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
            }`}
          >
            <Terminal size={13} />
            <span>Terminal CLI</span>
          </button>
        </div>

        {/* CONTEÚDO PRINCIPAL COM SCROLL */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 text-xs font-sans">
          {/* ─────────────────────────────────────────────────────────────
              ABA 1: LOGIN NO NAVEGADOR (WEB)
             ───────────────────────────────────────────────────────────── */}
          {abaModal === "web" && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl border border-zinc-800 bg-zinc-950/60 text-xs text-zinc-300 leading-relaxed">
                <p>{instrucoes.webPrompt}</p>
              </div>

              {/* ATALHO 1-CLIQUE GITHUB CLI PARA COPILOT */}
              {importaGithub && (
                <div className="p-3.5 rounded-xl border border-emerald-800/50 bg-emerald-950/20 space-y-2.5">
                  <div className="flex items-start gap-2.5">
                    <Sparkles size={16} className="text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold text-emerald-300 block">
                        Detecção Automática do GitHub CLI
                      </span>
                      <span className="text-[11px] text-zinc-400 block mt-0.5">
                        Importe as credenciais ativas do seu terminal GitHub CLI com um clique, sem abrir páginas adicionais.
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={autoConectando}
                    onClick={conectarAutomaticoCli}
                    className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs flex items-center justify-center gap-2 py-2 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {autoConectando ? <RefreshCw size={13} className="animate-spin" /> : <Zap size={13} />}
                    <span>Conectar Instantaneamente via GitHub CLI</span>
                  </button>
                </div>
              )}

              {/* ESTADO INICIAL: BOTÃO DE GERAR SESSÃO */}
              {!webSession && (
                <div className="p-5 rounded-xl border border-zinc-800 bg-zinc-950/40 text-center space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-full bg-emerald-950/40 border border-emerald-800/50 flex items-center justify-center text-emerald-400">
                    <Globe size={22} />
                  </div>
                  <div>
                    <h4 className="font-semibold text-zinc-100">Iniciar Autorização no Navegador</h4>
                    <p className="text-[11px] text-zinc-400 mt-1 max-w-sm mx-auto">
                      O OpenCorp gerará uma URL oficial de autorização e o código correspondente para vincular a conta com segurança.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={iniciandoWeb}
                    onClick={iniciarLoginWeb}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-5 py-2.5 rounded-lg shadow-sm transition-colors cursor-pointer inline-flex items-center gap-2 disabled:opacity-50"
                  >
                    {iniciandoWeb ? <RefreshCw size={14} className="animate-spin" /> : <ExternalLink size={14} />}
                    <span>Gerar Link de Autorização</span>
                  </button>
                </div>
              )}

              {/* SESSÃO ATIVA: AGUARDANDO AUTORIZAÇÃO */}
              {webSession && (webSession.status === "iniciando" || webSession.status === "aguardando_usuario") && (
                <div className="space-y-3 p-4 rounded-xl border border-zinc-800 bg-zinc-950/70">
                  <div className="flex items-center justify-between gap-2 border-b border-zinc-800 pb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      <span className="font-semibold text-zinc-200">
                        {webSession.authUrl ? "Aguardando autorização no navegador..." : "Iniciando processo..."}
                      </span>
                    </div>
                    <span className="text-[10px] text-zinc-500 font-mono">
                      Sessão #{webSession.id.slice(0, 8)}
                    </span>
                  </div>

                  {/* CÓDIGO DO DISPOSITIVO (USER CODE) */}
                  {webSession.userCode && (
                    <div className="space-y-1.5 bg-zinc-900 p-3 rounded-lg border border-amber-800/40">
                      <span className="text-[11px] font-semibold text-amber-300 block">
                        Passo 1: Copie o seu código de dispositivo único
                      </span>
                      <div className="flex items-center justify-between gap-2 bg-zinc-950 border border-zinc-800 px-3 py-2 rounded-lg">
                        <span className="font-mono text-sm font-bold tracking-widest text-emerald-400 select-all">
                          {webSession.userCode}
                        </span>
                        <button
                          type="button"
                          onClick={() => copiarParaClipboard(webSession.userCode!, "codigo")}
                          className="px-2.5 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-mono flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          {copiadoCodigo ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                          <span>{copiadoCodigo ? "Copiado!" : "Copiar"}</span>
                        </button>
                      </div>
                      <p className="text-[10px] text-zinc-400">
                        Cole este código exato no prompt da página oficial que será aberta.
                      </p>
                    </div>
                  )}

                  {/* BOTÃO PARA ABRIR PÁGINA OFICIAL */}
                  {webSession.authUrl && (
                    <div className="space-y-2 pt-1">
                      <span className="text-[11px] font-semibold text-zinc-300 block">
                        {webSession.userCode ? "Passo 2: Abra a página oficial no navegador" : "Passo 1: Autorize no navegador"}
                      </span>
                      <a
                        href={webSession.authUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs py-2.5 px-4 rounded-lg shadow-sm transition-all cursor-pointer group"
                      >
                        <span>Abrir Página de Autorização</span>
                        <ExternalLink size={14} className="group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                      </a>

                      <div className="flex items-center justify-between text-[11px] text-zinc-500 pt-1">
                        <button
                          type="button"
                          onClick={() => copiarParaClipboard(webSession.authUrl!, "url")}
                          className="hover:text-zinc-300 flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <Copy size={11} /> {copiadoUrl ? "Link copiado!" : "Copiar link de acesso"}
                        </button>
                        <span className="flex items-center gap-1.5 text-amber-400/90 font-mono text-[10px]">
                          <RefreshCw size={11} className="animate-spin" /> Verificando autorização...
                        </span>
                      </div>

                      {/* CÓDIGO DE RESPOSTA DO LOGIN (se o motor pedir) */}
                      {pedeCodigoNoLogin && (
                        <div className="space-y-1.5 bg-zinc-900 p-3 rounded-lg border border-purple-800/40 mt-2">
                          <span className="text-[11px] font-semibold text-purple-300 block">
                            Passo 2: Cole o código gerado após autorizar no navegador
                          </span>
                          <div className="flex items-center gap-2">
                            <input
                              type="text"
                              placeholder="Cole o código retornado aqui..."
                              value={codigoResposta}
                              onChange={(e) => setCodigoResposta(e.target.value)}
                              className="flex-1 bg-zinc-950 border border-zinc-700/60 rounded-lg px-3 py-1.5 text-xs text-zinc-100 font-mono focus:outline-none focus:border-purple-500"
                            />
                            <button
                              type="button"
                              disabled={enviandoCodigo || !codigoResposta.trim()}
                              onClick={submeterCodigoLogin}
                              className="bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs px-3.5 py-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {enviandoCodigo ? "Enviando..." : "Confirmar"}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* CANCELAR SESSÃO */}
                  <div className="pt-2 border-t border-zinc-800 flex items-center justify-end">
                    <button
                      type="button"
                      onClick={cancelarLoginWeb}
                      className="text-zinc-400 hover:text-zinc-200 text-xs px-2 py-1 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                    >
                      Cancelar Tentativa
                    </button>
                  </div>
                </div>
              )}

              {/* SESSÃO CONCLUÍDA */}
              {webSession && webSession.status === "concluido" && (
                <div className="p-5 rounded-xl border border-emerald-800/50 bg-emerald-950/30 text-center space-y-3">
                  <div className="w-12 h-12 mx-auto rounded-full bg-emerald-900/60 border border-emerald-600/60 flex items-center justify-center text-emerald-400">
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-emerald-300">Autenticação Concluída com Sucesso!</h4>
                    <p className="text-xs text-zinc-300 mt-1 max-w-sm mx-auto">
                      {webSession.message || `A conta foi vinculada e o motor ${motorNome || motorId} está pronto para execução.`}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      aoSalvarSucesso();
                      aoFechar();
                    }}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-5 py-2 rounded-lg transition-colors cursor-pointer"
                  >
                    Concluir e Fechar
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ─────────────────────────────────────────────────────────────
              ABA 2: TOKEN / CHAVE MANUAL E MULTI-CONTAS
             ───────────────────────────────────────────────────────────── */}
          {abaModal === "chave" && (
            <form onSubmit={salvarContaManual} className="space-y-3.5">
              {erroForm && (
                <div className="p-3 rounded-xl border border-rose-800/60 bg-rose-950/30 text-rose-200 flex items-start gap-2">
                  <AlertCircle size={15} className="mt-0.5 shrink-0 text-rose-400" />
                  <span className="text-xs">{erroForm}</span>
                </div>
              )}

              {/* SELETOR DE PROVEDOR DE IA */}
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Provedor de Inteligência Artificial / Modelo
                </label>
                <select
                  value={provedor}
                  onChange={(e) => handleMudarProvedor(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 focus:outline-none focus:border-zinc-600 font-sans cursor-pointer"
                >
                  {PROVEDORES_DISPONIVEIS.map((p) => (
                    <option key={p.id} value={p.id} className="bg-zinc-900 text-zinc-100">
                      {p.nome}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-zinc-500 mt-1">
                  {PROVEDORES_DISPONIVEIS.find((p) => p.id === provedor)?.desc}
                </p>
              </div>

              {/* BASE URL CUSTOM OU OLLAMA */}
              {(provedor === "custom" || provedor === "ollama") && (
                <div>
                  <label className="block text-xs font-semibold text-zinc-300 mb-1">
                    {provedor === "ollama" ? "Endpoint Ollama Host" : "Base URL da API (Compatível com OpenAI)"}
                  </label>
                  <input
                    type="text"
                    placeholder={provedor === "ollama" ? "http://localhost:11434" : "https://api.provedor.com/v1"}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                  />
                </div>
              )}

              {/* APELIDO / IDENTIFICADOR DA CONTA */}
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Identificador / Apelido da Conta
                </label>
                <input
                  type="text"
                  placeholder={`ex.: ${motorNome || motorId} - Trabalho ou Pessoal`}
                  value={nomeConta}
                  onChange={(e) => setNomeConta(e.target.value)}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                />
              </div>

              {/* CHAVE DE API / TOKEN */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-zinc-300">
                    {provedor === "ollama" ? "Chave de Acesso (Opcional para Ollama)" : `Chave de API / Token (${instrucoes.envVar})`}
                  </label>
                  {instrucoes.url && (
                    <a
                      href={instrucoes.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-orange-400 hover:text-orange-300 flex items-center gap-1 transition-colors"
                    >
                      <span>Obter no {instrucoes.urlText}</span>
                      <ExternalLink size={11} />
                    </a>
                  )}
                </div>
                <div className="relative">
                  <input
                    type={mostrarToken ? "text" : "password"}
                    placeholder={PROVEDORES_DISPONIVEIS.find((p) => p.id === provedor)?.placeholder || "sk-..."}
                    value={tokenOuChave}
                    onChange={(e) => setTokenOuChave(e.target.value)}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-3 pr-9 py-2 text-xs text-zinc-200 font-mono placeholder-zinc-600 focus:outline-none focus:border-zinc-600"
                  />
                  <button
                    type="button"
                    onClick={() => setMostrarToken((prev) => !prev)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                    title={mostrarToken ? "Ocultar credencial" : "Exibir credencial"}
                  >
                    {mostrarToken ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
                <p className="text-[11px] text-zinc-500 mt-1">
                  As credenciais são persistidas no cofre isolado <code className="text-zinc-400">0600</code> do servidor OpenCorp.
                </p>
              </div>

              {/* MODELO PADRÃO DA CONTA */}
              <div>
                <label className="block text-xs font-semibold text-zinc-300 mb-1">
                  Modelo Padrão da Conta (Opcional)
                </label>
                <ModelPicker
                  value={modeloPadrao}
                  onChange={setModeloPadrao}
                  motor={motorId || undefined}
                  placeholder="Pesquisar modelos deste motor..."
                />
              </div>

              {/* LIMITES DE CUSTO E RPM */}
              <div className="grid grid-cols-2 gap-3 pt-1">
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1 font-mono">Cota Diária (USD)</label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={cotaDiariaUsd}
                    onChange={(e) => setCotaDiariaUsd(Number(e.target.value))}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-zinc-600"
                  />
                </div>
                <div>
                  <label className="block text-[11px] text-zinc-400 mb-1 font-mono">Rate Limit (RPM)</label>
                  <input
                    type="number"
                    min="1"
                    step="5"
                    value={rateLimitRpm}
                    onChange={(e) => setRateLimitRpm(Number(e.target.value))}
                    className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-zinc-600"
                  />
                </div>
              </div>

              {/* RODAPÉ DO FORMULÁRIO */}
              <div className="pt-3 border-t border-zinc-800 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={aoFechar}
                  className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={salvandoConta}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-4 py-1.5 rounded-lg flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer disabled:opacity-50"
                >
                  {salvandoConta ? <RefreshCw size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}
                  <span>{salvandoConta ? "Conectando..." : "Salvar e Conectar Conta"}</span>
                </button>
              </div>
            </form>
          )}

          {/* ─────────────────────────────────────────────────────────────
              ABA 3: TERMINAL CLI & PRONTIDÃO
             ───────────────────────────────────────────────────────────── */}
          {abaModal === "cli" && (
            <div className="space-y-4">
              {/* STATUS DE PRONTIDÃO ATUAL */}
              <div
                className={`p-3.5 rounded-xl border text-xs flex items-start gap-2.5 ${
                  testResult?.healthy
                    ? "bg-emerald-950/20 border-emerald-800/40 text-emerald-300"
                    : "bg-amber-950/20 border-amber-800/40 text-amber-300"
                }`}
              >
                {testResult?.healthy ? (
                  <CheckCircle2 size={16} className="shrink-0 text-emerald-400 mt-0.5" />
                ) : (
                  <AlertCircle size={16} className="shrink-0 text-amber-400 mt-0.5" />
                )}
                <div className="space-y-0.5">
                  <span className="font-bold block">
                    {testResult?.healthy
                      ? "Motor Autenticado e Pronto para Execução"
                      : "Autenticação Necessária"}
                  </span>
                  <span className="text-[11px] opacity-90 block">
                    {testResult?.statusText || "Execute o comando de autenticação no terminal ou conecte uma conta direta."}
                  </span>
                </div>
              </div>

              <p className="text-xs text-zinc-300 leading-relaxed">{instrucoes.desc}</p>

              {/* BLOCO DO COMANDO DE TERMINAL */}
              <div className="space-y-1.5">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                  <Terminal size={13} className="text-zinc-400" />
                  Comando Oficial de Terminal
                </span>
                <div className="relative bg-zinc-950 p-3 rounded-xl border border-zinc-800/80 font-mono text-xs text-zinc-300 flex items-center justify-between">
                  <span className="text-emerald-400 select-all">$ {instrucoes.cliCommand}</span>
                  <button
                    type="button"
                    onClick={() => copiarParaClipboard(instrucoes.cliCommand, "comando")}
                    className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-850 transition-colors cursor-pointer"
                    title="Copiar comando"
                  >
                    {copiadoComando ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
                  </button>
                </div>
              </div>

              {/* AÇÕES DE PRONTIDÃO */}
              <div className="pt-3 border-t border-zinc-800 flex items-center justify-between gap-2">
                <button
                  type="button"
                  disabled={testando}
                  onClick={testarProntidao}
                  className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                >
                  {testando ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
                  <span>Testar Prontidão Real</span>
                </button>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={aoFechar}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    disabled={conectandoMotor}
                    onClick={ativarMotorComoPadrao}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-xs px-3.5 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {conectandoMotor ? <RefreshCw size={12} className="animate-spin" /> : <Cpu size={12} />}
                    <span>Ativar Motor</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
