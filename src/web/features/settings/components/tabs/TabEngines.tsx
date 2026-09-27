import React, { useState, useEffect, useCallback, type FC, type ChangeEvent } from "react";
import {
  Bot,
  RefreshCw,
  Cpu,
  Key,
  KeyRound,
  Plus,
  Play,
  Activity,
  Save,
  Check,
  AlertCircle,
  ExternalLink,
  Shield,
  Layers,
  Loader2,
  Sliders,
  Sparkles,
  Download,
  Unplug,
  Trash2,
  Edit3,
  X,
  Star,
  Copy,
} from "lucide-react";
import { showToast } from "../../../../shared/ui/Toast.js";
import { useOpenCorp } from "../../../../providers/OpenCorpProvider.js";
import { EngineAuthModal } from "../EngineAuthModal.js";
import { LegacyConfigBanner } from "../LegacyConfigBanner.js";
import type {
  TabConfigId,
  MotorInfo,
  ContaMotor,
} from "../../types.js";

export interface TabEnginesProps {
  abaAtiva: TabConfigId;
  escopoConfig?: "global" | "workspace";
  wsAtivo?: string;
  onGoToKeysTab?: () => void;
}

type NivelSaude = "installed" | "authenticated" | "inference" | "streaming" | "tools" | "conversation" | "lifecycle";
const NIVEIS_REAIS: readonly NivelSaude[] = ["inference", "streaming", "tools", "conversation", "lifecycle"];
const ROTULO_NIVEL: Record<NivelSaude, string> = {
  installed: "Instalado",
  authenticated: "Autenticado",
  inference: "Inferência",
  streaming: "Streaming",
  tools: "Ferramentas",
  conversation: "Conversa",
  lifecycle: "Ciclo de vida",
};

export const TabEngines: FC<TabEnginesProps> = ({
  abaAtiva,
  onGoToKeysTab,
}) => {
  const { client, tratarErro } = useOpenCorp();
  const [statusMotores, setStatusMotores] = useState<any>(null);
  const [carregando, setCarregando] = useState(false);
  const [erroCarregamento, setErroCarregamento] = useState<string | null>(null);
  const [motorSelecionado, setMotorSelecionado] = useState<string>("opencode");
  const [limites, setLimites] = useState<Record<string, any>>({});
  const [salvandoLimites, setSalvandoLimites] = useState(false);
  const [testandoMotor, setTestandoMotor] = useState<string | null>(null);
  const [resultadoTeste, setResultadoTeste] = useState<Record<string, any>>({});
  const [comandoMimoCopiado, setComandoMimoCopiado] = useState(false);

  // Controle de abertura do EngineAuthModal
  const [modalAuthAberto, setModalAuthAberto] = useState(false);
  const [motorSelecionadoAuth, setMotorSelecionadoAuth] = useState<{ id: string; nome: string } | null>(null);

  // Estados de Ciclo de Vida do Motor
  const [instalandoMotor, setInstalandoMotor] = useState<string | null>(null);
  const [desconectandoMotor, setDesconectandoMotor] = useState<string | null>(null);
  const [conectandoPadraoMotor, setConectandoPadraoMotor] = useState<string | null>(null);

  // Estados de Gestão de Contas
  const [ativandoContaId, setAtivandoContaId] = useState<string | null>(null);
  const [excluindoContaId, setExcluindoContaId] = useState<string | null>(null);
  const [editandoContaId, setEditandoContaId] = useState<string | null>(null);
  const [limitesContaEdicao, setLimitesContaEdicao] = useState<{ daily_cost_usd: number; rate_limit_rpm: number }>({
    daily_cost_usd: 10,
    rate_limit_rpm: 30,
  });
  const [salvandoLimitesConta, setSalvandoLimitesConta] = useState(false);

  const abrirModalAuth = (motor: { id: string; name?: string }) => {
    setMotorSelecionadoAuth({ id: motor.id, nome: motor.name || motor.id });
    setModalAuthAberto(true);
  };

  const carregarDados = useCallback(async () => {
    setCarregando(true);
    setErroCarregamento(null);
    try {
      const [resMotores, resLimites] = await Promise.all([
        client.http.get<any>("/api/motores"),
        client.http.get<any>("/api/motores/limites"),
      ]);

      if (!resMotores || !Array.isArray(resMotores.motores)) {
        throw new Error("Resposta inválida ao carregar os motores");
      }
      setStatusMotores(resMotores);
      if (resMotores.limits) {
        setLimites(resMotores.limits);
      }
      if (resLimites?.limites && typeof resLimites.limites === "object") {
        setLimites((prev) => ({ ...prev, ...resLimites.limites }));
      }
    } catch (err: unknown) {
      setStatusMotores(null);
      setLimites({});
      setErroCarregamento(err instanceof Error ? err.message : String(err));
    } finally {
      setCarregando(false);
    }
  }, [client]);

  useEffect(() => {
    void carregarDados();
  }, [carregarDados]);

  const motores: MotorInfo[] = statusMotores?.motores || [];
  const comandoInstalacaoMimo = "curl -fsSL https://mimo.xiaomi.com/install | bash";

  const copiarComandoMimo = async () => {
    if (!navigator.clipboard) {
      showToast("Área de transferência indisponível neste navegador.", "aviso");
      return;
    }
    await navigator.clipboard.writeText(comandoInstalacaoMimo);
    setComandoMimoCopiado(true);
    showToast("Comando de instalação do MiMo copiado!", "sucesso");
    setTimeout(() => setComandoMimoCopiado(false), 2000);
  };

  const motorAtual = motores.find((m) => m.id === motorSelecionado) || motores[0];
  // Todos os motores exigem autenticação (o tier gratuito sem login do MiMo foi encerrado).
  const motorSemAutenticacao = (_motor: MotorInfo) => false;
  const motorPronto = (motor: MotorInfo) =>
    motor.installed && (motorSemAutenticacao(motor) || Boolean(motor.authStatus?.authenticated || motor.contaAtiva));
  const contasDoMotor: ContaMotor[] = (statusMotores?.contas || []).filter(
    (c: any) => c.motorId === motorAtual?.id
  );

  /**
   * Diagnóstico por nível. Sem argumentos: "authenticated" (barato, sem
   * inferência). Níveis reais consomem cota e exigem modelo e confirmação.
   */
  const testarMotor = async (motorId: string, nivel: NivelSaude = "authenticated", modelo?: string) => {
    setTestandoMotor(motorId);
    try {
      const real = NIVEIS_REAIS.includes(nivel);
      const res = await client.http.post<any>(`/api/motores/${encodeURIComponent(motorId)}/test`, {
        nivel,
        ...(real ? { modelo, confirmarCusto: true } : {}),
      });
      setResultadoTeste((prev) => ({ ...prev, [motorId]: res }));
      const resumo = res?.health?.statusText || res?.erro || "Diagnóstico sem causa informada";
      showToast(`${motorId}: ${resumo}`, res?.ok ? "sucesso" : "erro");
    } catch (err: unknown) {
      const causa = err instanceof Error ? err.message : String(err);
      setResultadoTeste((prev) => ({ ...prev, [motorId]: { ok: false, error: causa } }));
      tratarErro(err, `Falha ao testar motor ${motorId}`);
    } finally {
      setTestandoMotor(null);
    }
  };

  const testeFuncional = async (motor: MotorInfo) => {
    const sugestao = (motor as { contaAtiva?: { modeloPadrao?: string } | string }).contaAtiva;
    const modelo = window.prompt(
      `Teste funcional de "${motor.name}": executa inferência real, streaming, leitura de arquivo e continuação num workspace temporário e CONSOME COTA da conta ativa.\n\nInforme o modelo exato (provedor/modelo):`,
      typeof sugestao === "object" && sugestao?.modeloPadrao ? sugestao.modeloPadrao : "",
    );
    if (!modelo?.trim()) return;
    if (!confirm(`Confirmar teste funcional de "${motor.name}" com o modelo "${modelo.trim()}"? Isso consome cota.`)) return;
    await testarMotor(motor.id, "conversation", modelo.trim());
  };

  const salvarTodosLimites = async () => {
    setSalvandoLimites(true);
    try {
      await client.http.put("/api/motores/limites", limites);
      showToast("Limites operacionais dos motores salvos!", "sucesso");
      await carregarDados();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao salvar limites dos motores");
    } finally {
      setSalvandoLimites(false);
    }
  };

  // Ciclo de vida: Instalar Motor
  const instalarMotor = async (motorId: string) => {
    setInstalandoMotor(motorId);
    try {
      showToast(`Instalando versão fixada e verificada de "${motorId}"...`, "aviso");
      const res = await client.http.post<any>(`/api/motores/${encodeURIComponent(motorId)}/install`, {});
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha na instalação do motor");
      }
      showToast(res?.log || `Motor "${motorId}" instalado com sucesso!`, "sucesso");
      await carregarDados();
      await testarMotor(motorId);
    } catch (err: unknown) {
      tratarErro(err, `Falha ao instalar motor ${motorId}`);
    } finally {
      setInstalandoMotor(null);
    }
  };

  // Ciclo de vida: Desconectar Motor
  const desconectarMotor = async (motorId: string) => {
    // O motor padrão só é trocado para um motor escolhido pelo usuário (sem padrão implícito).
    const candidatos = motores.filter((m) => m.installed && m.id !== motorId).map((m) => m.id);
    if (candidatos.length === 0) {
      showToast("Nenhum outro motor instalado para assumir como padrão. Instale outro motor antes de desconectar este.", "erro");
      return;
    }
    const escolha = prompt(
      `Desconectar "${motorId}". Qual motor passa a ser o padrão das execuções?\nInstalados: ${candidatos.join(", ")}`,
      candidatos[0]
    );
    if (escolha === null) return;
    const novoPadrao = escolha.trim();
    if (!candidatos.includes(novoPadrao)) {
      showToast(`"${novoPadrao}" não é um motor instalado. Escolha entre: ${candidatos.join(", ")}.`, "erro");
      return;
    }
    setDesconectandoMotor(motorId);
    try {
      const res = await client.http.post<any>(`/api/motores/${encodeURIComponent(motorId)}/desconectar`, { novoPadrao });
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao desconectar motor");
      }
      showToast(`Motor "${motorId}" desconectado. "${novoPadrao}" agora é o padrão.`, "sucesso");
      await carregarDados();
    } catch (err: unknown) {
      tratarErro(err, `Erro ao desconectar motor ${motorId}`);
    } finally {
      setDesconectandoMotor(null);
    }
  };

  // Ciclo de vida: Ativar Motor como padrão (settings.run_engine)
  const ativarMotorComoPadrao = async (motorId: string) => {
    setConectandoPadraoMotor(motorId);
    try {
      const res = await client.http.post<any>(`/api/motores/${encodeURIComponent(motorId)}/conectar?forcar=true`, {});
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao ativar motor");
      }
      showToast(`Motor "${motorId}" definido como executor padrão no runner!`, "sucesso");
      await carregarDados();
    } catch (err: unknown) {
      tratarErro(err, `Erro ao ativar motor ${motorId}`);
    } finally {
      setConectandoPadraoMotor(null);
    }
  };

  // Gestão de Contas: Ativar Conta
  const ativarContaMotor = async (motorId: string, contaId: string) => {
    setAtivandoContaId(contaId);
    try {
      const res = await client.http.post<any>(
        `/api/motores/${encodeURIComponent(motorId)}/contas/${encodeURIComponent(contaId)}/ativar`,
        {}
      );
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao ativar conta");
      }
      showToast("Conta ativada como principal do motor!", "sucesso");
      await carregarDados();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao ativar conta");
    } finally {
      setAtivandoContaId(null);
    }
  };

  // Gestão de Contas: Excluir / Desconectar Conta
  const desconectarContaMotor = async (motorId: string, contaId: string, nomeConta?: string) => {
    if (!confirm(`Desconectar e remover a conta "${nomeConta || contaId}" deste motor?`)) {
      return;
    }
    setExcluindoContaId(contaId);
    try {
      const res = await client.http.delete<any>(
        `/api/motores/${encodeURIComponent(motorId)}/contas/${encodeURIComponent(contaId)}`
      );
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao desconectar conta");
      }
      showToast("Conta desconectada com sucesso!", "sucesso");
      await carregarDados();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao desconectar conta");
    } finally {
      setExcluindoContaId(null);
    }
  };

  // Gestão de Contas: Iniciar Edição de Limites
  const abrirEdicaoLimitesConta = (conta: ContaMotor) => {
    setEditandoContaId(conta.id);
    setLimitesContaEdicao({
      daily_cost_usd: conta.limits?.daily_cost_usd ?? 10,
      rate_limit_rpm: conta.limits?.rate_limit_rpm ?? 30,
    });
  };

  // Gestão de Contas: Salvar Limites da Conta
  const salvarLimitesConta = async (motorId: string, contaId: string) => {
    setSalvandoLimitesConta(true);
    try {
      const res = await client.http.put<any>(
        `/api/motores/${encodeURIComponent(motorId)}/contas/${encodeURIComponent(contaId)}/limites`,
        limitesContaEdicao
      );
      if (!res?.ok && res?.erro) {
        throw new Error(res.erro || "Falha ao salvar limites da conta");
      }
      showToast("Limites da conta atualizados com sucesso!", "sucesso");
      setEditandoContaId(null);
      await carregarDados();
    } catch (err: unknown) {
      tratarErro(err, "Erro ao salvar limites da conta");
    } finally {
      setSalvandoLimitesConta(false);
    }
  };

  const atualizarLimiteMotor = (motorId: string, campo: string, valor: any) => {
    setLimites((prev) => ({
      ...prev,
      [motorId]: {
        ...(prev[motorId] || {}),
        [campo]: valor,
      },
    }));
  };

  return (
    <div className="space-y-6 bg-transparent">
      {/* ─────────────────────────────────────────────────────────────
          ABA MOTORES & PROVEDORES
         ───────────────────────────────────────────────────────────── */}
      {abaAtiva === "motores" && (
        <div className="space-y-6 bg-transparent" data-testid="tab-motores">
          <LegacyConfigBanner />
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800 gap-3">
            <div>
              <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Bot size={16} className="text-orange-400" />
                Motores de Inferência & Provedores BYOK
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Runtimes de agentes autônomos, execução em sandbox e conexões com APIs de inteligência.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {onGoToKeysTab && (
                <button
                  type="button"
                  onClick={onGoToKeysTab}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600/20 hover:bg-orange-600/30 text-orange-400 border border-orange-500/40 text-xs font-semibold transition-colors cursor-pointer"
                >
                  <Key size={13} />
                  <span>Gerenciar Chaves</span>
                </button>
              )}
              <button
                type="button"
                disabled={carregando}
                onClick={carregarDados}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-300 border border-zinc-800 text-xs font-medium transition-colors cursor-pointer disabled:opacity-50"
              >
                <RefreshCw size={13} className={carregando ? "animate-spin" : ""} />
                <span>Atualizar</span>
              </button>
            </div>
          </div>

          {erroCarregamento && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-rose-800/60 bg-rose-950/30 p-4 text-xs text-rose-200">
              <div className="flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0 text-rose-400" />
                <div>
                  <p className="font-semibold">Falha ao carregar motores</p>
                  <p className="mt-0.5 text-rose-300/80">{erroCarregamento}</p>
                </div>
              </div>
              <button
                type="button"
                disabled={carregando}
                onClick={carregarDados}
                className="flex items-center justify-center gap-1.5 rounded-lg border border-rose-700/60 bg-rose-900/40 px-3 py-1.5 font-semibold text-rose-100 transition-colors hover:bg-rose-900/70 disabled:opacity-50"
              >
                <RefreshCw size={13} className={carregando ? "animate-spin" : ""} />
                Tentar novamente
              </button>
            </div>
          )}

          {/* Grid de Motores Cadastrados */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {motores.map((m) => {
              const isSel = m.id === motorAtual?.id;
              const isPronto = motorPronto(m);
              const isAtivo = Boolean(m.ativo && m.installed);

              return (
                <div
                  key={m.id}
                  onClick={() => setMotorSelecionado(m.id)}
                  className={`p-3.5 rounded-xl border cursor-pointer transition-all flex flex-col justify-between space-y-2.5 ${
                    isSel
                      ? "bg-zinc-850/90 border-orange-500/80 shadow-md ring-1 ring-orange-500/30"
                      : "bg-zinc-900/40 border-zinc-850 hover:border-zinc-750 hover:bg-zinc-900/70"
                  }`}
                >
                  <button
                    type="button"
                    data-engine-id={m.id}
                    aria-pressed={isSel}
                    className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 rounded-md"
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-xs text-zinc-100 font-mono truncate">
                        {m.name}
                      </span>
                      <span
                        className={`w-2 h-2 rounded-full ${
                          isAtivo || isPronto
                            ? "bg-emerald-400"
                            : m.installed ? "bg-orange-400" : "bg-amber-400"
                        }`}
                      />
                    </div>
                    <span className="block text-[11px] text-zinc-400 line-clamp-2 mt-1">
                      {m.description}
                    </span>
                  </button>

                  <div className="flex items-center justify-between pt-2 border-t border-zinc-800/60 text-[10px] font-mono text-zinc-500">
                    <span>{m.installed ? (m.version || "Versão detectada") : "Não instalado"}</span>
                    {isAtivo ? (
                      <span className="text-emerald-400 font-semibold flex items-center gap-1">
                        <Star size={11} className="fill-emerald-400" /> Em uso
                      </span>
                    ) : isPronto ? (
                      <span className="text-emerald-400 font-semibold flex items-center gap-1">
                        <Check size={11} /> Pronto
                      </span>
                    ) : !m.installed ? (
                      <span className="text-amber-400 font-semibold flex items-center gap-1">
                        <Download size={11} /> Instalar
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMotorSelecionado(m.id);
                          abrirModalAuth(m);
                        }}
                        className="text-orange-400 hover:text-orange-300 font-semibold flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <KeyRound size={11} />
                        <span>Autenticar</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Painel de Detalhes do Motor Selecionado */}
          {motorAtual && (
            <div className="p-4 sm:p-5 rounded-2xl border border-zinc-850 bg-zinc-900/40 space-y-4">
              {/* Header do Motor Selecionado */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800 gap-3">
                <div className="flex items-center gap-3">
                  <div className="p-2.5 rounded-xl bg-orange-600/10 border border-orange-500/20 text-orange-400 shrink-0">
                    <Cpu size={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-sm font-bold text-zinc-100">
                        {motorAtual.name}
                      </h3>
                      {motorAtual.category && (
                        <span className="text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                          {motorAtual.category}
                        </span>
                      )}
                      {motorAtual.id === "mimo" && (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-sky-800/60 bg-sky-950/40 text-sky-300 font-semibold">
                          Tier Gratuito Oficial / Sem Login
                        </span>
                      )}
                      {motorAtual.installed ? (
                        motorAtual.ativo ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-emerald-800/60 bg-emerald-950/40 text-emerald-300 font-semibold">
                            <Star size={10} className="fill-emerald-400 text-emerald-400" />
                            Motor Padrão Ativo
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-850 text-zinc-300">
                            <Check size={10} className="text-zinc-400" />
                            Instalado
                          </span>
                        )
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-amber-800/50 bg-amber-950/30 text-amber-300 font-semibold">
                          <AlertCircle size={10} className="text-amber-400" />
                          Não Instalado
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">
                      {motorAtual.description}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {/* Se o motor não estiver instalado, botão destacado para instalar */}
                  {!motorAtual.installed && motorAtual.instalacaoGerenciada?.suportada && (
                    <button
                      type="button"
                      disabled={instalandoMotor === motorAtual.id}
                      onClick={() => instalarMotor(motorAtual.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold shadow-xs transition-colors cursor-pointer disabled:opacity-50"
                      title={`Instala a versão fixada ${motorAtual.instalacaoGerenciada?.versao ?? ""}, verificada por SHA-256, em ~/.opencorp/engines`}
                    >
                      {instalandoMotor === motorAtual.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Download size={13} />
                      )}
                      <span>Instalar {motorAtual.instalacaoGerenciada?.versao ? `v${motorAtual.instalacaoGerenciada.versao}` : "Motor"}</span>
                    </button>
                  )}

                  {/* Se o motor estiver instalado mas não for o padrão ativo */}
                  {motorAtual.installed && !motorAtual.ativo && (
                    <button
                      type="button"
                      disabled={conectandoPadraoMotor === motorAtual.id}
                      onClick={() => ativarMotorComoPadrao(motorAtual.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-750 text-zinc-200 border border-zinc-700 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                      title="Definir este motor como o executor padrão do sistema"
                    >
                      {conectandoPadraoMotor === motorAtual.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Star size={13} className="text-amber-400" />
                      )}
                      <span>Definir como Padrão</span>
                    </button>
                  )}

                  {/* Motor padrão ativo: desconectar exige escolher o novo padrão */}
                  {motorAtual.ativo && (
                    <button
                      type="button"
                      disabled={desconectandoMotor === motorAtual.id}
                      onClick={() => desconectarMotor(motorAtual.id)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-rose-950/40 text-rose-400 hover:text-rose-300 border border-zinc-800 hover:border-rose-900/50 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                      title="Desconectar este motor e escolher o novo motor padrão"
                    >
                      {desconectandoMotor === motorAtual.id ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Unplug size={13} />
                      )}
                      <span>Desconectar</span>
                    </button>
                  )}

                  {/* Autenticação só existe para motores instalados que usam conta/chave. */}
                  {motorAtual.installed && !motorSemAutenticacao(motorAtual) && (
                    <button
                      type="button"
                      onClick={() => abrirModalAuth(motorAtual)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-200 border border-zinc-800 text-xs font-semibold transition-colors cursor-pointer"
                    >
                      <KeyRound size={13} className="text-orange-400" />
                      <span>
                        {motorAtual.authStatus?.authenticated || motorAtual.contaAtiva
                          ? "+ Adicionar Conta"
                          : "Autenticar / Conectar"}
                      </span>
                    </button>
                  )}

                  {/* Botão de Testar Conexão / Diagnóstico */}
                  <button
                    type="button"
                    disabled={testandoMotor !== null}
                    onClick={() => testarMotor(motorAtual.id)}
                    title="Verifica binário e autenticação, sem inferência"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-zinc-200 border border-zinc-800 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                  >
                    {testandoMotor === motorAtual.id ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Play size={13} className="text-emerald-400" />
                    )}
                    <span>Diagnóstico rápido</span>
                  </button>

                  {motorAtual.installed && (
                    <button
                      type="button"
                      disabled={testandoMotor !== null}
                      onClick={() => void testeFuncional(motorAtual)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-850 text-amber-200 border border-amber-800/60 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                      title="Executa inferência real num workspace temporário — consome cota"
                    >
                      <Activity size={13} className="text-amber-400" />
                      <span>Teste funcional</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Banner informativo de status do motor */}
              {!motorAtual.installed && motorAtual.id !== "mimo" && (
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-amber-800/40 bg-amber-950/20 text-xs text-amber-200" role="status">
                  <div className="flex items-center gap-2">
                    <AlertCircle size={15} className="shrink-0 text-amber-400" aria-hidden="true" />
                    <span>
                      O binário de <strong>{motorAtual.name}</strong> não foi encontrado (settings, PATH ou instalação gerenciada).{" "}
                      {motorAtual.instalacaoGerenciada?.suportada
                        ? "Há uma versão verificada disponível para instalação gerenciada."
                        : motorAtual.instalacaoGerenciada?.instrucoes || "Instalação gerenciada não suportada para este motor."}
                    </span>
                  </div>
                  {motorAtual.instalacaoGerenciada?.suportada && (
                    <button
                      type="button"
                      disabled={instalandoMotor === motorAtual.id}
                      onClick={() => instalarMotor(motorAtual.id)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-500 text-white font-semibold text-[11px] shrink-0 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {instalandoMotor === motorAtual.id ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Download size={12} />
                      )}
                      <span>Instalar agora</span>
                    </button>
                  )}
                </div>
              )}

              {motorAtual.id === "mimo" && !motorAtual.installed && (
                <div className="flex flex-col gap-3 p-3 rounded-xl border border-amber-800/40 bg-amber-950/20 text-xs text-amber-200">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="flex items-start gap-2">
                      <AlertCircle size={15} className="mt-0.5 shrink-0 text-amber-400" />
                      <div>
                        <span className="font-semibold block">MiMo Code ainda não está instalado</span>
                        <span className="text-[11px] text-amber-200/80">
                          A detecção verifica o PATH, <code>~/.mimo/bin/mimo</code> e <code>~/.mimocode/bin/mimo</code>. O OpenCorp não executa scripts de instalação: rode o comando oficial abaixo no seu terminal.
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-[11px] text-emerald-400">
                    <code className="select-all overflow-x-auto">$ {comandoInstalacaoMimo}</code>
                    <button
                      type="button"
                      onClick={() => void copiarComandoMimo()}
                      className="shrink-0 rounded-md p-1.5 text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
                      title="Copiar comando de instalação"
                    >
                      {comandoMimoCopiado ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                    </button>
                  </div>
                </div>
              )}

              {motorAtual.id === "mimo" && motorAtual.installed && (
                <div className="flex items-center gap-2 p-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 text-xs text-emerald-200">
                  <Check size={15} className="shrink-0 text-emerald-400" />
                  <span><strong>Pronto para executar</strong> — versão {motorAtual.version || "detectada"}</span>
                </div>
              )}

              {motorAtual.ativo && motorAtual.installed && (
                <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-emerald-800/40 bg-emerald-950/20 text-xs text-emerald-200">
                  <div className="flex items-center gap-2">
                    <Star size={15} className="fill-emerald-400 text-emerald-400 shrink-0" />
                    <span>
                      <strong>Motor Padrão Ativo do Sistema</strong> — Orquestrando turnos autônomos, tarefas agendadas e chamadas de ferramentas no OpenCorp.
                    </span>
                  </div>
                  {motorAtual.id !== "opencode" && (
                    <button
                      type="button"
                      disabled={desconectandoMotor === motorAtual.id}
                      onClick={() => desconectarMotor(motorAtual.id)}
                      className="text-[11px] text-zinc-400 hover:text-rose-300 font-medium flex items-center gap-1 transition-colors cursor-pointer shrink-0 disabled:opacity-50"
                      title="Reverter para o executor padrão OpenCode"
                    >
                      <Unplug size={11} />
                      <span>Reverter p/ OpenCode</span>
                    </button>
                  )}
                </div>
              )}

              {resultadoTeste[motorAtual.id] && (
                <div
                  className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
                    resultadoTeste[motorAtual.id]?.ok && resultadoTeste[motorAtual.id]?.health?.healthy
                      ? "border-emerald-800/60 bg-emerald-950/30 text-emerald-300"
                      : "border-rose-800/60 bg-rose-950/30 text-rose-300"
                  }`}
                >
                  {resultadoTeste[motorAtual.id]?.ok && resultadoTeste[motorAtual.id]?.health?.healthy ? (
                    <Check size={14} className="mt-0.5 shrink-0" />
                  ) : (
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  )}
                  <div className="flex flex-col gap-1.5">
                    <span>
                      {resultadoTeste[motorAtual.id]?.health?.statusText ||
                        resultadoTeste[motorAtual.id]?.health?.message ||
                        resultadoTeste[motorAtual.id]?.error ||
                        "Diagnóstico do motor indisponível"}
                    </span>
                    {Array.isArray(resultadoTeste[motorAtual.id]?.relatorio?.results) && (
                      <ul className="flex flex-wrap gap-1.5" aria-label="Resultado por nível">
                        {resultadoTeste[motorAtual.id].relatorio.results.map((r: { level: NivelSaude; status: string; detail?: string; latencyMs?: number }) => (
                          <li
                            key={r.level}
                            title={[r.detail, r.latencyMs !== undefined ? `${r.latencyMs} ms` : ""].filter(Boolean).join(" · ")}
                            className={`rounded-md border px-1.5 py-0.5 text-[10px] font-medium ${
                              r.status === "passed"
                                ? "border-emerald-700/60 text-emerald-300"
                                : r.status === "failed"
                                  ? "border-rose-700/60 text-rose-300"
                                  : "border-zinc-700 text-zinc-400"
                            }`}
                          >
                            {r.status === "passed" ? "✓" : r.status === "failed" ? "✗" : "–"} {ROTULO_NIVEL[r.level] ?? r.level}
                            {r.status === "unsupported" ? " (não suportado)" : r.status === "skipped" ? " (não executado)" : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                    {resultadoTeste[motorAtual.id]?.relatorio && !NIVEIS_REAIS.includes(resultadoTeste[motorAtual.id].relatorio.requestedLevel) && (
                      <span className="text-[10px] text-zinc-400">
                        Diagnóstico rápido: não executa inferência. Use “Teste funcional” para verificar respostas reais.
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Contas / Perfis de Execução do Motor */}
              {!motorSemAutenticacao(motorAtual) ? (
              <div className="space-y-2.5 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider block">
                    Contas &amp; Instâncias Configuradas ({contasDoMotor.length})
                  </span>
                  <button
                    type="button"
                    onClick={() => abrirModalAuth(motorAtual)}
                    className="text-xs font-semibold text-orange-400 hover:text-orange-300 flex items-center gap-1 transition-colors cursor-pointer"
                  >
                    <Plus size={13} />
                    <span>Adicionar Conta</span>
                  </button>
                </div>

                <div className="space-y-2.5">
                  {contasDoMotor.map((conta) => {
                    const isEditando = editandoContaId === conta.id;

                    return (
                      <div
                        key={conta.id}
                        className="p-3.5 rounded-xl bg-zinc-950/70 border border-zinc-850 hover:border-zinc-800 space-y-3 transition-colors text-xs"
                      >
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                          <div className="space-y-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-zinc-100 font-mono text-xs">
                                {conta.nome || conta.label || conta.id}
                              </span>

                              {/* Badge de Ativa / Inativa */}
                              {conta.ativa ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-full border border-emerald-800/60 bg-emerald-950/40 text-emerald-300 font-semibold">
                                  <Check size={11} />
                                  Ativa
                                </span>
                              ) : (
                                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full border border-zinc-800 bg-zinc-900 text-zinc-500 font-medium">
                                  Inativa
                                </span>
                              )}

                              {conta.provider && (
                                <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-zinc-850 text-zinc-300 border border-zinc-750">
                                  {conta.provider}
                                </span>
                              )}
                            </div>

                            <div className="text-[11px] font-mono text-zinc-400 flex items-center gap-2 flex-wrap">
                              <span className="text-amber-400/90" title="Chave mascarada">
                                {conta.previewChave || conta.authType || "credencial ativa"}
                              </span>
                              {conta.modeloPadrao && (
                                <>
                                  <span className="text-zinc-600">•</span>
                                  <span className="text-zinc-300">Mod: {conta.modeloPadrao}</span>
                                </>
                              )}
                              <span className="text-zinc-600">•</span>
                              <span className="text-zinc-400">
                                Limites: ${conta.limits?.daily_cost_usd ?? 10}/dia · {conta.limits?.rate_limit_rpm ?? 30} RPM
                              </span>
                              <span className="text-zinc-600">•</span>
                              <span className="text-zinc-500">
                                Cota: {conta.limits?.status_cota || "normal"}
                              </span>
                            </div>
                          </div>

                          {/* Ações da Conta */}
                          <div className="flex items-center gap-2 shrink-0 self-start sm:self-center">
                            {/* Se não for a conta ativa, botão para Tornar Ativa */}
                            {!conta.ativa && (
                              <button
                                type="button"
                                disabled={ativandoContaId === conta.id}
                                onClick={() => ativarContaMotor(motorAtual.id, conta.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-emerald-950/50 text-zinc-300 hover:text-emerald-300 border border-zinc-800 hover:border-emerald-800/60 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                                title="Definir esta conta como principal para este motor"
                              >
                                {ativandoContaId === conta.id ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Check size={12} />
                                )}
                                <span>Tornar Ativa</span>
                              </button>
                            )}

                            {/* Botão de Edição Rápida de Limites */}
                            <button
                              type="button"
                              onClick={() => {
                                if (isEditando) {
                                  setEditandoContaId(null);
                                } else {
                                  abrirEdicaoLimitesConta(conta);
                                }
                              }}
                              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs font-semibold transition-colors cursor-pointer ${
                                isEditando
                                  ? "bg-orange-950/40 text-orange-300 border-orange-800/60"
                                  : "bg-zinc-900 hover:bg-zinc-850 text-zinc-300 hover:text-zinc-100 border-zinc-800"
                              }`}
                              title="Ajustar limites de custo diário e taxa de requisições"
                            >
                              <Edit3 size={12} className={isEditando ? "text-orange-400" : "text-zinc-400"} />
                              <span>{isEditando ? "Fechar" : "Limites"}</span>
                            </button>

                            {/* Botão de Excluir / Desconectar Conta */}
                            <button
                              type="button"
                              disabled={excluindoContaId === conta.id}
                              onClick={() => desconectarContaMotor(motorAtual.id, conta.id, conta.nome)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-rose-950/40 text-rose-400 hover:text-rose-300 border border-zinc-800 hover:border-rose-900/50 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50"
                              title="Desconectar e remover esta conta do motor"
                            >
                              {excluindoContaId === conta.id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                              <span>Desconectar</span>
                            </button>
                          </div>
                        </div>

                        {/* Painel Inline de Edição de Limites */}
                        {isEditando && (
                          <div className="pt-3 border-t border-zinc-800/60 mt-2 space-y-3 bg-zinc-900/40 p-3 rounded-lg border border-zinc-800/50">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-zinc-200 flex items-center gap-1.5">
                                <Sliders size={13} className="text-orange-400" />
                                Limites Operacionais da Conta ({conta.nome || conta.id})
                              </span>
                              <button
                                type="button"
                                onClick={() => setEditandoContaId(null)}
                                className="text-zinc-400 hover:text-zinc-200"
                              >
                                <X size={13} />
                              </button>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                              <div>
                                <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                  Cota Diária Máxima (USD)
                                </label>
                                <input
                                  type="number"
                                  min="1"
                                  max="2000"
                                  step="1"
                                  value={limitesContaEdicao.daily_cost_usd}
                                  onChange={(e) =>
                                    setLimitesContaEdicao((prev) => ({
                                      ...prev,
                                      daily_cost_usd: Number(e.target.value) || 0,
                                    }))
                                  }
                                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 font-mono focus:outline-hidden focus:border-orange-500/60"
                                />
                              </div>

                              <div>
                                <label className="block text-[11px] font-medium text-zinc-400 mb-1">
                                  Taxa de Requisições (RPM)
                                </label>
                                <input
                                  type="number"
                                  min="1"
                                  max="500"
                                  step="1"
                                  value={limitesContaEdicao.rate_limit_rpm}
                                  onChange={(e) =>
                                    setLimitesContaEdicao((prev) => ({
                                      ...prev,
                                      rate_limit_rpm: Number(e.target.value) || 0,
                                    }))
                                  }
                                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 font-mono focus:outline-hidden focus:border-orange-500/60"
                                />
                              </div>
                            </div>

                            <div className="flex items-center justify-end gap-2 pt-2">
                              <button
                                type="button"
                                onClick={() => setEditandoContaId(null)}
                                className="px-2.5 py-1 rounded-lg bg-zinc-850 hover:bg-zinc-800 text-zinc-300 text-xs font-medium transition-colors"
                              >
                                Cancelar
                              </button>
                              <button
                                type="button"
                                disabled={salvandoLimitesConta}
                                onClick={() => salvarLimitesConta(motorAtual.id, conta.id)}
                                className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-xs font-semibold transition-colors disabled:opacity-50"
                              >
                                {salvandoLimitesConta ? (
                                  <Loader2 size={12} className="animate-spin" />
                                ) : (
                                  <Save size={12} />
                                )}
                                <span>Salvar Limites</span>
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {contasDoMotor.length === 0 && (
                    <p className="text-xs text-zinc-500 py-4 text-center border border-dashed border-zinc-850 rounded-xl">
                      Nenhuma conta extra cadastrada para este motor. Utilizando credenciais padrão do sistema.
                    </p>
                  )}
                </div>
              </div>
              ) : (
                <div className="flex items-start gap-2 rounded-xl border border-sky-800/40 bg-sky-950/20 p-3 text-xs text-sky-200">
                  <Shield size={15} className="mt-0.5 shrink-0 text-sky-400" />
                  <div>
                    <span className="font-semibold block">Login feito pelo próprio MiMo</span>
                    <span className="text-[11px] text-sky-200/80">
                      O tier gratuito do MiMo foi encerrado. Após instalar, execute <code>mimo auth login</code> (ou configure um provedor terceiro no MiMo) e use o Diagnóstico rápido para confirmar.
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          ABA LIMITES DOS MOTORES
         ───────────────────────────────────────────────────────────── */}
      {abaAtiva === "limites" && (
        <div className="space-y-6 bg-transparent" data-testid="tab-limites-motores">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-zinc-800 gap-3">
            <div>
              <h2 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <Sliders size={16} className="text-purple-400" />
                Limites Operacionais &amp; Quotas dos Motores
              </h2>
              <p className="text-xs text-zinc-400 mt-0.5">
                Defina timeouts, turns máximos por turno, rate limit de requisições e teto financeiro por motor.
              </p>
            </div>
            <button
              type="button"
              disabled={salvandoLimites}
              onClick={salvarTodosLimites}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-orange-700 hover:bg-orange-600 text-white text-xs font-semibold transition-colors cursor-pointer disabled:opacity-50 shadow-sm self-start sm:self-center"
            >
              {salvandoLimites ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <Save size={13} />
              )}
              <span>Salvar Todos os Limites</span>
            </button>
          </div>

          <div className="divide-y divide-zinc-850 border border-zinc-850 rounded-xl bg-zinc-900/30 overflow-hidden">
            {motores.map((m) => {
              const lim = limites[m.id] || {
                timeout_min: 20,
                max_turns: 40,
                rate_limit_rpm: 60,
                daily_cost_usd: 10,
              };

              return (
                <div
                  key={m.id}
                  className="p-4 flex flex-col md:flex-row md:items-center justify-between gap-4 hover:bg-zinc-900/40 transition-colors"
                >
                  <div className="space-y-0.5 max-w-sm">
                    <span className="font-bold text-xs text-zinc-100 font-mono">
                      {m.name}
                    </span>
                    <p className="text-[11px] text-zinc-400">{m.description}</p>
                    <span className="text-[10px] font-mono text-zinc-500 block">
                      ID: {m.id}
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        TIMEOUT (MIN)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="240"
                        value={lim.timeout_min ?? 20}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          atualizarLimiteMotor(m.id, "timeout_min", Number(e.target.value))
                        }
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs font-mono text-zinc-100 text-right focus:outline-none focus:border-orange-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        TURNS MÁX.
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="100"
                        value={lim.max_turns ?? 40}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          atualizarLimiteMotor(m.id, "max_turns", Number(e.target.value))
                        }
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs font-mono text-zinc-100 text-right focus:outline-none focus:border-orange-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        RATE (RPM)
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="300"
                        value={lim.rate_limit_rpm ?? 60}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          atualizarLimiteMotor(m.id, "rate_limit_rpm", Number(e.target.value))
                        }
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs font-mono text-zinc-100 text-right focus:outline-none focus:border-orange-500"
                      />
                    </div>

                    <div>
                      <label className="block text-[10px] font-mono text-zinc-400 mb-1">
                        CUSTO DIA (USD)
                      </label>
                      <input
                        type="number"
                        step="0.5"
                        min="0"
                        value={lim.daily_cost_usd ?? 10}
                        onChange={(e: ChangeEvent<HTMLInputElement>) =>
                          atualizarLimiteMotor(m.id, "daily_cost_usd", Number(e.target.value))
                        }
                        className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1 text-xs font-mono text-zinc-100 text-right focus:outline-none focus:border-orange-500"
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Modal de Autenticação de Motores e Credenciais */}
      <EngineAuthModal
        aberto={modalAuthAberto}
        motorId={motorSelecionadoAuth?.id || null}
        motorNome={motorSelecionadoAuth?.nome}
        aoFechar={() => {
          setModalAuthAberto(false);
          setMotorSelecionadoAuth(null);
        }}
        aoSalvarSucesso={() => {
          void carregarDados();
        }}
      />
    </div>
  );
};
