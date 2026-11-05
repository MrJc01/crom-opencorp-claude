import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathComCliLocal, projectRoot } from "../../../utils/paths.js";
import { opencorpHome } from "../../../utils/paths.js";
import { provedorAtivoTraduzModelos, configDirsDoPool, membrosPoolResolvidos, poolAtivo, resolverProvedorClaude } from "../provedor-claude.js";
import { pastaEstadoRotacao } from "../rotacao-provedores.js";
import { mkdirSync } from "node:fs";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { PreflightBinaryMissingError } from "../errors.js";
import type { EngineDriver, EngineExecutionOptions } from "../types.js";
import { ClaudeCodeDriver } from "./claude-code-driver.js";

/** Credenciais e contas do Claude Code (mesmo login do claude.ai). */
const CREDENTIALS_ENGINE_ID = "claude-code";

/**
 * Driver do motor "claude-sdk". Existe para o motor aparecer na lista de motores
 * (Configurações e seletor do Secretário), que é montada a partir de drivers.
 * Binário, instalação e login são os do Claude Code. A execução é do ClaudeSdkAdapter.
 */
export class ClaudeSdkDriver implements EngineDriver {
  id = "claude-sdk";
  name = "Claude Agent SDK";
  description = "Claude Agent SDK (@anthropic-ai/claude-agent-sdk): conversa com aprovações, usando o login do Claude Code";
  category = "cli" as const;
  maintainer = "Anthropic";
  supportedModelsHint = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];
  // Uma pesquisa com ferramentas (ex.: boletim) fica longos trechos sem saída: limites maiores que o padrão.
  timeoutDefaults = { tetoMs: 1_800_000, inatividadeMs: 300_000 };
  /** Com provedor compatível/pool qualquer modelo é aceito (traduzido pelo provedor); senão só claude-*. */
  get modelPrefixes(): string[] | undefined {
    return provedorAtivoTraduzModelos(opencorpHome()) ? undefined : ["claude-"];
  }

  private readonly claudeCode = new ClaudeCodeDriver();

  isInstalled(homeDir: string) {
    return this.claudeCode.isInstalled(homeDir);
  }

  install(homeDir: string, onProgress?: (msg: string) => void) {
    return this.claudeCode.install(homeDir, onProgress);
  }

  checkHealth(homeDir: string) {
    return this.claudeCode.checkHealth(homeDir);
  }

  async fetchLiveTokens(homeDir: string, accountCredentials?: { tokenOuChave?: string; authType?: string }) {
    // A cota é a do login do Claude Code; a identidade no resultado é a deste motor.
    const usage = await this.claudeCode.fetchLiveTokens(homeDir, accountCredentials);
    return { ...usage, motorId: this.id, motorName: this.name };
  }

  /**
   * Agentes e fluxos rodam por processo filho: `node claude-sdk-cli.js`, que chama `query()`
   * do SDK. O processo inteiro (inclusive o claude que o SDK dispara) fica no sandbox do
   * workspace; por isso os caminhos de leitura são informados em OPENCORP_SANDBOX_RO_BIND.
   */
  async prepareExecution(opts: EngineExecutionOptions): Promise<{
    binary: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }> {
    const status = await this.claudeCode.isInstalled(opts.homeDir);
    if (!status.installed || !status.path) throw new PreflightBinaryMissingError(this.id);
    const claudeReal = realpathSync(status.path);
    const pacoteSdk = dirname(createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"));
    // dist: o runner importa módulos do próprio projeto (provedor, rodízio); sem isso a sandbox não os encontra.
    const leitura = [dirname(claudeReal), pacoteSdk, join(projectRoot(), "package.json"), join(projectRoot(), "dist")];
    // Login do Claude Code gravável no sandbox: conta própria do OpenCorp tem prioridade sobre o login padrão do dono.
    // Provedor ativo (provedores.json): assinatura, API da Anthropic ou endpoint compatível, com mapa de modelos.
    // Pool: a conta é escolhida pelo runner a cada tentativa (rodízio com cooldown), então aqui só se libera as pastas de
    // todos os membros. Resolver um membro agora gastaria uma posição do rodízio.
    const poolId = poolAtivo(opts.homeDir);
    if (poolId) mkdirSync(pastaEstadoRotacao(opts.homeDir), { recursive: true });
    // Credenciais de todos os membros vão pelo ambiente do processo (a sandbox não enxerga ~/.opencorp).
    const membrosPool = poolId ? JSON.stringify(membrosPoolResolvidos(opts.homeDir, poolId)) : undefined;
    const provedor = poolId ? undefined : resolverProvedorClaude(opts.homeDir);
    const contaPropria = provedor?.configDir;
    const homeClaude = process.env.HOME || "";
    const escrita = poolId
      ? [pastaEstadoRotacao(opts.homeDir), ...configDirsDoPool(opts.homeDir, poolId)]
      : contaPropria
        ? [contaPropria]
        : homeClaude
          ? [join(homeClaude, ".claude"), join(homeClaude, ".claude.json")]
          : [];

    const env = await resolveEngineSpawnEnv(
      CREDENTIALS_ENGINE_ID,
      { homeDir: opts.homeDir, workspaceId: opts.workspaceId, workspacePath: opts.workspacePath, accountId: opts.accountId },
      {
        ANTHROPIC_DISABLE_TELEMETRY: "1",
        PATH: pathComCliLocal(),
        ...(opts.envOverrides || {}),
        OPENCORP_SANDBOX_RW_BIND: escrita.join(":"),
        // conta própria do OpenCorp, se configurada e logada (o sandbox monta esta pasta no lugar do ~/.claude)
        ...(provedor?.env ?? {}),
        ...(membrosPool ? { OPENCORP_POOL_MEMBROS: membrosPool } : {}),
        ...(contaPropria ? { CLAUDE_CONFIG_DIR: contaPropria } : {}),
        OPENCORP_SANDBOX_RO_BIND: leitura.join(":"),
      },
      // Login local: a ANTHROPIC_API_KEY do shell não entra (chaves do OpenCorp continuam valendo).
      { ...process.env, ANTHROPIC_API_KEY: undefined }
    );

    const runner = fileURLToPath(new URL("../runners/claude-sdk-cli.js", import.meta.url));
    const modelo = provedor?.modelo(opts.model);
    const modoPool = poolId ? ["--pool", poolId, "--home", opts.homeDir, ...(opts.model && opts.model !== "default" ? ["--model-pedido", opts.model] : [])] : [];
    // O session-manager grava o agente montado (corpo + skills + contexto) antes de preparar a execução.
    const arquivoAgente = opts.agentId ? join(opts.workspacePath, ".opencorp", "opencode", "agent", `${opts.agentId}.md`) : undefined;
    const agente = arquivoAgente && existsSync(arquivoAgente) ? ["--agente", arquivoAgente] : [];
    return {
      binary: process.execPath,
      args: [runner, "--cwd", opts.workspacePath, ...(modelo ? ["--model", modelo] : []), ...modoPool, "--claude-path", claudeReal, ...agente, "--", opts.prompt],
      env,
      cwd: opts.workspacePath,
    };
  }
}
