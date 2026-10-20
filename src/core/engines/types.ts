/**
 * OpenCorp Modular Engine System
 * Define o contrato para qualquer runner/motor autônomo de IA
 */

export interface EngineInstallStatus {
  installed: boolean;
  isManaged: boolean; // true se está isolado em ~/.opencorp/bin/
  path: string | null;
  version: string | null;
  details?: string;
}

export interface EngineHealth {
  healthy: boolean;
  statusText: string;
  latencyMs?: number;
  daemonActive?: boolean;
  details?: Record<string, unknown>;
}

export interface EngineExecutionOptions {
  workspaceId: string;
  workspacePath: string;
  sessionId: string;
  agentId: string;
  model: string;
  prompt: string;
  homeDir: string;
  title?: string;
  auto?: boolean;
  extraArgs?: string[];
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
  /** Conta explícita; falha antes do spawn se não autorizada para o workspace. */
  accountId?: string;
}

export interface EngineDriver {
  /** Identificador único do motor (ex: "opencode", "crom-agente", "claude-code", "antigravity") */
  id: string;

  /** Nome humano legível (ex: "OpenCode Engine", "Crom-Agente (Go)") */
  name: string;

  /** Descrição técnica e de capacidades do motor */
  description: string;

  /** Categoria do motor: cli | daemon | ide | hybrid */
  category: "cli" | "daemon" | "hybrid";

  /** Provedor / organização mantenedora */
  maintainer: string;

  /** Modelos recomendados ou suportados nativamente */
  supportedModelsHint: string[];

  /**
   * Limites padrão de execução (ms) quando o chamador não define. O núcleo consulta isto em vez de
   * conhecer o id do motor. Ausente = padrão global (teto 10 min, inatividade 60 s).
   */
  timeoutDefaults?: { tetoMs?: number; inatividadeMs?: number };

  /**
   * O driver aceita `opts.session` (continuar/duplicar sessão nativa do motor ao rodar). Ausente = o núcleo
   * reconstrói o contexto no prompt em vez de repassar a sessão.
   */
  nativeSessionPassthrough?: boolean;

  /** Modelos de rotação por falha/cota quando o agente não define `rotation` (acrescentados ao fim da lista). */
  fallbackModels?: string[];

  /**
   * Prefixos de modelo que o motor executa (ex.: ["claude-"]). Ausente = aceita qualquer modelo.
   * O núcleo usa isto para recusar combinações motor/modelo incompatíveis sem citar o motor.
   */
  modelPrefixes?: string[];

  /**
   * Verifica o status de instalação:
   * 1º prioridade: ~/.opencorp/bin/<id> (instalado e gerenciado pelo OpenCorp)
   * 2º prioridade: PATH global do sistema operacional (se permitido/detectado)
   */
  isInstalled(homeDir: string): Promise<EngineInstallStatus>;

  /**
   * Instala ou atualiza o binário do motor isoladamente dentro de ~/.opencorp/bin/
   */
  install(
    homeDir: string,
    onProgress?: (msg: string) => void,
  ): Promise<{ success: boolean; path: string; version: string; log: string }>;

  /**
   * Executa uma verificação rápida de diagnóstico (doctor/health check)
   */
  checkHealth(homeDir: string): Promise<EngineHealth>;

  /**
   * Prepara o comando de execução e variáveis de ambiente específicas do motor
   */
  prepareExecution(opts: EngineExecutionOptions): Promise<{
    binary: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }>;

  /**
   * Consulta diretamente o provedor/backend do motor para obter tokens disponíveis e cota real
   * sem cálculos cegos ou estimativas estáticas.
   */
  fetchLiveTokens(
    homeDir: string,
    accountCredentials?: { tokenOuChave?: string; authType?: string }
  ): Promise<EngineTokenUsage>;
}

export interface EngineTokenUsage {
  motorId: string;
  motorName: string;
  source: "api_live" | "cli_live" | "oauth_session" | "unconfigured" | "error";
  provedor: string;

  // Tokens e Cotas
  tokensDisponiveis: number | "ilimitado" | "indeterminado";
  tokensUsados?: number;
  limiteTokens?: number | "ilimitado";

  // Requisições e Rate Limits
  requestsRestantes?: number;
  requestsLimite?: number;
  rateLimitRpm?: number;

  // Saldo e Créditos Reais
  saldoUsd?: number;
  limiteUsd?: number;
  consumoUsd?: number;

  // Status e Diagnóstico Real
  statusCota: "normal" | "alerta_80" | "esgotado" | "desconhecido";
  mensagem: string;
  resetaEm?: string;
  consultadoEm: string;
  detalhes?: Record<string, unknown>;
}

export async function safeExecFile(
  file: string,
  args: string[],
  options?: any
): Promise<{ stdout: string; stderr: string }> {
  try {
    const cp = await import("node:child_process");
    const { promisify } = await import("node:util");
    if (typeof cp.execFile === "function") {
      const fn = promisify(cp.execFile);
      return (await fn(file, args, options)) as any;
    }
  } catch (err: any) {
    if (err.stdout !== undefined || err.stderr !== undefined) {
      return { stdout: err.stdout || "", stderr: err.stderr || "" };
    }
    throw err;
  }
  return { stdout: "", stderr: "" };
}
