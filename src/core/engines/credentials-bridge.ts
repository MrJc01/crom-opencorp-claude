import { existsSync, readFileSync } from "node:fs";
import { claudeConfigDirOpencorp } from "./drivers/claude-config-dir.js";
import { join } from "node:path";
import { execFile, execFileSync } from "node:child_process";

export interface EngineAuthStatus {
  authenticated: boolean;
  method: string;
  account?: string;
  accountId?: string;
  details?: string;
}

/**
 * Chaves de provedor geridas pelo OpenCorp (painel "Chaves de API") mais o
 * ambiente do host. Não lê arquivos internos de CLIs de terceiros nem extrai
 * tokens de outras ferramentas (D4). Para montar o ambiente de um processo de
 * motor use `CredentialsStore.resolveForSpawn`, que aplica a política por motor
 * e workspace — esta função serve a diagnósticos e chamadas internas.
 */
export function resolveEngineCredentials(homeDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  const authPath = join(homeDir, ".opencorp", "opencode-data", "opencode", "auth.json");
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, "utf8"));
      if (auth.openrouter?.key) env.OPENROUTER_API_KEY = auth.openrouter.key;
      if (auth.anthropic?.key) env.ANTHROPIC_API_KEY = auth.anthropic.key;
      if (auth.openai?.key) env.OPENAI_API_KEY = auth.openai.key;
      if (auth.google?.key) env.GEMINI_API_KEY = auth.google.key;
    } catch {}
  }
  for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY", "CURSOR_API_KEY", "GEMINI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    if (!env[name] && process.env[name]) env[name] = process.env[name]!;
  }
  return env;
}

/** Contas do EngineAccountStore com chave, lidas sem expor valores. */
function engineAccountWithKey(homeDir: string, engineId: string): { id: string; nome: string } | undefined {
  const path = join(homeDir, ".opencorp", "engine-accounts.json");
  if (!existsSync(path)) return undefined;
  try {
    const contas = JSON.parse(readFileSync(path, "utf8")) as Array<{ id: string; nome: string; motorId: string; ativa?: boolean; tokenOuChave?: string }>;
    const conta = contas.find((c) => c.motorId === engineId && c.ativa && c.tokenOuChave);
    return conta ? { id: conta.id, nome: conta.nome } : undefined;
  } catch {
    return undefined;
  }
}

export interface CliLoginResult {
  loggedIn: boolean;
  method: string;
  details?: string;
}

export type CommandRunner = (bin: string, args: string[], timeoutMs: number) => { code: number; stdout: string };

const defaultCommandRunner: CommandRunner = (bin, args, timeoutMs) => {
  try {
    const stdout = execFileSync(bin, args, { timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout };
  } catch (error) {
    const e = error as { status?: number | null; stdout?: string };
    return { code: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout ?? "") };
  }
};

export type AsyncCommandRunner = (bin: string, args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string }>;

/** Versão não bloqueante: nunca congela o event loop do servidor enquanto o CLI responde. */
const defaultAsyncCommandRunner: AsyncCommandRunner = (bin, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      if (!error) return resolve({ code: 0, stdout: String(stdout ?? "") });
      const e = error as { code?: number | string | null };
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: String(stdout ?? "") });
    });
  });

let commandRunner: CommandRunner = defaultCommandRunner;
let customRunner = false;
const PROBE_CACHE_TTL_MS = 30_000;
const probeCache = new Map<string, { at: number; result: CliLoginResult | undefined }>();
const probesEmAndamento = new Map<string, Promise<CliLoginResult | undefined>>();

/** Substitui o executor de comandos dos probes (testes). Retorna o anterior. */
export function setCliLoginCommandRunner(runner: CommandRunner | undefined): CommandRunner {
  const previous = commandRunner;
  commandRunner = runner ?? defaultCommandRunner;
  customRunner = runner !== undefined;
  probeCache.clear();
  probesEmAndamento.clear();
  return previous;
}

function managedOrPath(homeDir: string, name: string): string {
  const managed = join(homeDir, ".opencorp", "bin", name);
  return existsSync(managed) ? managed : name;
}

/**
 * Verifica a sessão OAuth nativa de um CLI pelo comando oficial de status —
 * nunca lendo os arquivos internos da ferramenta. Resultado em cache por 30 s.
 * `undefined` significa que o motor não oferece um comando verificável.
 */
export function probeCliLogin(engineId: string, homeDir: string): CliLoginResult | undefined {
  const key = `${engineId}::${homeDir}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return cached.result;
  const result = runCliLoginProbeSync(engineId, homeDir);
  probeCache.set(key, { at: Date.now(), result });
  return result;
}

/**
 * Versão assíncrona de `probeCliLogin`: mesmo cache de 30 s, sem bloquear o event loop e com uma
 * única execução simultânea por motor. É a que as rotas HTTP devem usar.
 */
export function probeCliLoginAsync(engineId: string, homeDir: string): Promise<CliLoginResult | undefined> {
  const key = `${engineId}::${homeDir}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_TTL_MS) return Promise.resolve(cached.result);
  const emAndamento = probesEmAndamento.get(key);
  if (emAndamento) return emAndamento;
  const p = (async () => {
    const result = await runCliLoginProbe(engineId, homeDir, async (bin, args, ms) =>
      customRunner ? commandRunner(bin, args, ms) : defaultAsyncCommandRunner(bin, args, ms),
    );
    probeCache.set(key, { at: Date.now(), result });
    return result;
  })().finally(() => probesEmAndamento.delete(key));
  probesEmAndamento.set(key, p);
  return p;
}

/** Último valor conhecido do probe (mesmo vencido), sem executar nada. */
function probeEmCache(engineId: string, homeDir: string): { result: CliLoginResult | undefined; vencido: boolean } | undefined {
  const cached = probeCache.get(`${engineId}::${homeDir}`);
  return cached ? { result: cached.result, vencido: Date.now() - cached.at >= PROBE_CACHE_TTL_MS } : undefined;
}

function runCliLoginProbeSync(engineId: string, homeDir: string): CliLoginResult | undefined {
  const comando = comandoDeProbe(engineId, homeDir);
  return comando?.interpretar(commandRunner(comando.bin, comando.args, comando.timeoutMs));
}

async function runCliLoginProbe(engineId: string, homeDir: string, run: AsyncCommandRunner): Promise<CliLoginResult | undefined> {
  const comando = comandoDeProbe(engineId, homeDir);
  return comando?.interpretar(await run(comando.bin, comando.args, comando.timeoutMs));
}

interface ProbeComando {
  bin: string;
  args: string[];
  timeoutMs: number;
  interpretar(saida: { code: number; stdout: string }): CliLoginResult;
}

/** Comando oficial de status de cada CLI e a leitura da saída; a execução (sync ou async) é de quem chama. */
function comandoDeProbe(engineId: string, homeDir: string): ProbeComando | undefined {
  switch (engineId) {
    case "claude-code":
      return {
        bin: managedOrPath(homeDir, "claude"),
        args: ["auth", "status", "--json"],
        timeoutMs: 5000,
        interpretar: ({ code, stdout }) => {
          try {
            const status = JSON.parse(stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
            return {
              loggedIn: status.loggedIn === true,
              method: status.loggedIn ? `claude auth (${status.authMethod ?? "oauth"})` : "claude auth status",
              details: status.loggedIn ? status.subscriptionType : "Execute 'claude auth login'",
            };
          } catch {
            return { loggedIn: false, method: "claude auth status", details: code === 0 ? "saída não reconhecida" : "comando indisponível" };
          }
        },
      };
    case "codex":
      return {
        bin: managedOrPath(homeDir, "codex"),
        args: ["login", "status"],
        timeoutMs: 5000,
        interpretar: ({ code, stdout }) => {
          const text = stdout.toLowerCase();
          const loggedIn = code === 0 && text.includes("logged in") && !text.includes("not logged in");
          return { loggedIn, method: "codex login status", details: stdout.trim().split("\n")[0] || undefined };
        },
      };
    case "cursor":
      return {
        bin: managedOrPath(homeDir, "agent"),
        args: ["status", "--format", "json"],
        timeoutMs: 5000,
        interpretar: ({ stdout }) => {
          try {
            const status = JSON.parse(stdout) as { isAuthenticated?: boolean; message?: string };
            return { loggedIn: status.isAuthenticated === true, method: "agent status", details: status.message };
          } catch {
            return { loggedIn: false, method: "agent status", details: "comando indisponível" };
          }
        },
      };
    case "mimo": {
      // `mimo auth whoami` sai com 0 mesmo sem login; o texto é o sinal (0.1.15).
      const mimoBin = [join(homeDir, ".mimocode", "bin", "mimo"), join(homeDir, ".mimo", "bin", "mimo")].find((p) => existsSync(p)) ?? "mimo";
      return {
        bin: mimoBin,
        args: ["auth", "whoami"],
        timeoutMs: 8000,
        interpretar: ({ code, stdout }) => {
          const loggedIn = code === 0 && stdout.trim().length > 0 && !/not logged in/i.test(stdout);
          return { loggedIn, method: "mimo auth whoami", details: loggedIn ? undefined : "Execute 'mimo auth login' ou configure um provedor terceiro" };
        },
      };
    }
    case "copilot":
      return {
        bin: "gh",
        args: ["auth", "status"],
        timeoutMs: 5000,
        interpretar: ({ code }) => ({ loggedIn: code === 0, method: "gh auth status", details: code === 0 ? "GitHub CLI autenticado" : "Execute 'gh auth login' ou 'copilot login'" }),
      };
    default:
      return undefined;
  }
}

type ProbeFn = (engineId: string, homeDir: string) => CliLoginResult | undefined;

/** Motor cujo status depende de qual comando de login (para pré-aquecer o cache sem bloquear). */
function motorDoProbe(engineId: string): string | undefined {
  switch (engineId) {
    case "claude-code":
    case "claude-sdk":
      return "claude-code";
    case "codex":
    case "cursor":
    case "copilot":
    case "mimo":
      return engineId;
    default:
      return undefined;
  }
}

/**
 * Diagnóstico de autenticação de cada motor. Considera, nesta ordem: conta
 * ativa do OpenCorp, chaves geridas/ambiente e o comando oficial de status do
 * CLI. Nunca lê tokens de arquivos internos de terceiros.
 *
 * Esta versão é SÍNCRONA e pode bloquear o event loop até 5-8 s por motor (execFileSync): use só em
 * CLI/scripts. Rotas HTTP devem usar `checkEngineAuthStatusAsync`.
 */
export function checkEngineAuthStatus(engineId: string, homeDir: string): EngineAuthStatus {
  return statusDeAutenticacao(engineId, homeDir, probeCliLogin);
}

/**
 * Versão não bloqueante para rotas HTTP. Com `aceitarVencido`, devolve na hora o último valor conhecido
 * do probe (mesmo vencido) e atualiza em segundo plano; sem valor conhecido, espera a primeira execução.
 */
export async function checkEngineAuthStatusAsync(
  engineId: string,
  homeDir: string,
  opcoes: { aceitarVencido?: boolean } = {},
): Promise<EngineAuthStatus> {
  const alvo = motorDoProbe(engineId);
  const prontos = new Map<string, CliLoginResult | undefined>();
  if (alvo) {
    const conhecido = opcoes.aceitarVencido ? probeEmCache(alvo, homeDir) : undefined;
    if (conhecido) {
      prontos.set(alvo, conhecido.result);
      if (conhecido.vencido) void probeCliLoginAsync(alvo, homeDir).catch(() => undefined);
    } else {
      prontos.set(alvo, await probeCliLoginAsync(alvo, homeDir));
    }
  }
  return statusDeAutenticacao(engineId, homeDir, (id) => prontos.get(id));
}

function statusDeAutenticacao(engineId: string, homeDir: string, probeCliLogin: ProbeFn): EngineAuthStatus {
  const creds = resolveEngineCredentials(homeDir);
  const conta = engineAccountWithKey(homeDir, engineId);
  if (conta) {
    return { authenticated: true, method: "Conta OpenCorp", account: conta.nome, accountId: conta.id, details: "Credencial da conta ativa" };
  }

  switch (engineId) {
    case "opencode":
    case "crom-agente":
    case "aider": {
      const hasKey = Boolean(creds.OPENROUTER_API_KEY || creds.ANTHROPIC_API_KEY || creds.OPENAI_API_KEY || (engineId !== "crom-agente" && creds.GEMINI_API_KEY));
      return hasKey
        ? { authenticated: true, method: creds.OPENROUTER_API_KEY ? "OpenRouter BYOK" : "API Key", details: "Chave de provedor configurada no OpenCorp" }
        : { authenticated: false, method: "Chave de LLM ausente", details: "Adicione uma chave em Configurações > Chaves de API" };
    }

    case "claude-code": {
      if (creds.ANTHROPIC_API_KEY) return { authenticated: true, method: "ANTHROPIC_API_KEY", details: "Chave direta Anthropic ativa" };
      const probe = probeCliLogin(engineId, homeDir)!;
      return probe.loggedIn
        ? { authenticated: true, method: probe.method, details: probe.details }
        : { authenticated: false, method: "Sessão Claude ausente", details: "Execute 'claude auth login' no terminal ou configure ANTHROPIC_API_KEY" };
    }

    case "claude-sdk": {
      // Usa o login do plano (conta do OpenCorp ou a do CLI), nunca ANTHROPIC_API_KEY: a chave mudaria a cobrança.
      if (claudeConfigDirOpencorp()) {
        return { authenticated: true, method: "Login Claude (conta do OpenCorp)", details: "Pasta de login própria do OpenCorp" };
      }
      const probe = probeCliLogin("claude-code", homeDir)!;
      return probe.loggedIn
        ? { authenticated: true, method: probe.method, details: probe.details }
        : { authenticated: false, method: "Sessão Claude ausente", details: "Execute 'claude auth login' no terminal (o claude-sdk usa o login, não chave de API)" };
    }

    case "openheinerss":
      // Ponte local (JSON-RPC): não guarda credencial própria; cada harness que ela aciona usa o login dele.
      return { authenticated: true, method: "Local (sem credencial própria)", details: "A credencial é do harness escolhido (ex.: claude-code, codex)" };

    case "codex": {
      if (creds.OPENAI_API_KEY) return { authenticated: true, method: "OPENAI_API_KEY", details: "Chave da OpenAI ativa" };
      const probe = probeCliLogin(engineId, homeDir)!;
      return probe.loggedIn
        ? { authenticated: true, method: probe.method, details: probe.details }
        : { authenticated: false, method: "Requer Login ou OPENAI_API_KEY", details: "Execute 'codex login --device-auth' ou adicione OPENAI_API_KEY" };
    }

    case "cursor": {
      if (creds.CURSOR_API_KEY) return { authenticated: true, method: "CURSOR_API_KEY", details: "Chave de API do Cursor ativa" };
      const probe = probeCliLogin(engineId, homeDir)!;
      return probe.loggedIn
        ? { authenticated: true, method: "Conta Cursor (agent status)", details: probe.details }
        : { authenticated: false, method: "Requer Login ou CURSOR_API_KEY", details: "Execute 'agent login' no terminal ou obtenha chave em cursor.com/settings" };
    }

    case "copilot": {
      if (creds.COPILOT_GITHUB_TOKEN || creds.GH_TOKEN || creds.GITHUB_TOKEN) return { authenticated: true, method: "Token GitHub no ambiente" };
      const probe = probeCliLogin(engineId, homeDir)!;
      return probe.loggedIn
        ? { authenticated: true, method: probe.method, details: probe.details }
        : { authenticated: false, method: "GitHub não autenticado", details: "Execute 'copilot login' ou 'gh auth login'" };
    }

    case "antigravity":
      return creds.GEMINI_API_KEY
        ? { authenticated: true, method: "GEMINI_API_KEY", details: "Google AI Studio autenticado" }
        : { authenticated: false, method: "Não verificável", details: "O agy não oferece comando de status de login. Configure GEMINI_API_KEY ou use o teste funcional do motor." };

    case "mimo": {
      // O serviço gratuito do MiMo foi encerrado (erro do próprio CLI 0.1.15:
      // "MiMo free API service has ended. Sign in or configure a third-party API.").
      const probe = probeCliLogin(engineId, homeDir)!;
      return probe.loggedIn
        ? { authenticated: true, method: probe.method }
        : { authenticated: false, method: "Login MiMo ausente", details: "O tier gratuito foi encerrado pela Xiaomi. Execute 'mimo auth login' ou configure um provedor terceiro no MiMo." };
    }

    default:
      return { authenticated: false, method: "Motor desconhecido", details: `Sem regra de autenticação para "${engineId}"` };
  }
}

export interface EngineAuthInstruction {
  engineId: string;
  engineName: string;
  terminalCommand: string;
  envVarName?: string;
  webUrl: string;
  urlLabel: string;
  guideText: string;
}

export function getEngineAuthInstructions(engineId: string): EngineAuthInstruction {
  switch (engineId) {
    case "copilot":
      return {
        engineId,
        engineName: "GitHub Copilot CLI",
        terminalCommand: "copilot login --device-code",
        envVarName: "COPILOT_GITHUB_TOKEN",
        webUrl: "https://github.com/settings/tokens",
        urlLabel: "GitHub Tokens",
        guideText: "Execute no seu terminal 'copilot login --device-code' para autorizar no navegador, ou 'gh auth login'. O OpenCorp detecta seu token automaticamente.",
      };
    case "claude-code":
      return {
        engineId,
        engineName: "Claude Code",
        terminalCommand: "claude auth login",
        envVarName: "ANTHROPIC_API_KEY",
        webUrl: "https://console.anthropic.com/settings/keys",
        urlLabel: "Anthropic Console",
        guideText: "Execute 'claude login' no terminal para autenticar com sua conta Claude Pro/Team via navegador, ou informe ANTHROPIC_API_KEY na aba 'Chaves de API'.",
      };
    case "cursor":
      return {
        engineId,
        engineName: "Cursor Agent CLI",
        terminalCommand: "agent login",
        envVarName: "CURSOR_API_KEY",
        webUrl: "https://cursor.com/settings",
        urlLabel: "Cursor Settings",
        guideText: "Execute 'agent login' no terminal para logar sua conta Cursor, ou gere uma CURSOR_API_KEY em cursor.com/settings e configure no ambiente.",
      };
    case "codex":
      return {
        engineId,
        engineName: "OpenAI Codex CLI",
        terminalCommand: "codex login --device-auth",
        envVarName: "OPENAI_API_KEY",
        webUrl: "https://platform.openai.com/api-keys",
        urlLabel: "OpenAI API Keys",
        guideText: "Execute 'codex login --device-auth' para autorizar via navegador, ou configure sua OPENAI_API_KEY na aba 'Chaves de API'.",
      };
    case "antigravity":
      return {
        engineId,
        engineName: "Google Antigravity Engine (AGY)",
        terminalCommand: "agy login",
        envVarName: "GEMINI_API_KEY",
        webUrl: "https://aistudio.google.com/app/apikey",
        urlLabel: "Google AI Studio",
        guideText: "O Antigravity funciona com sua chave do Google AI Studio ($0 custo com Gemini 2.5/3.8 Flash) ou via login de desenvolvedor agy.",
      };
    case "mimo":
      return {
        engineId,
        engineName: "Xiaomi MiMo Code",
        terminalCommand: "mimo auth login",
        webUrl: "https://mimo.xiaomi.com/coder",
        urlLabel: "MiMo Code",
        guideText: "O tier gratuito do MiMo foi encerrado. Execute 'mimo auth login' no terminal ou configure um provedor terceiro no MiMo.",
      };
    case "crom-agente":
      return {
        engineId,
        engineName: "Crom-Agente Engine (Go)",
        terminalCommand: "export OPENROUTER_API_KEY=sk-or-...",
        envVarName: "OPENROUTER_API_KEY",
        webUrl: "https://openrouter.ai/settings/keys",
        urlLabel: "OpenRouter Keys",
        guideText: "Crom-Agente roda nativamente com OpenRouter BYOK configurado no OpenCorp.",
      };
    case "opencode":
    default:
      return {
        engineId,
        engineName: "OpenCode Engine",
        terminalCommand: "opencode auth login",
        envVarName: "OPENROUTER_API_KEY",
        webUrl: "https://openrouter.ai/settings/keys",
        urlLabel: "OpenRouter Keys",
        guideText: "Adicione sua chave OpenRouter ou provedor direto em Configurações > Chaves de API.",
      };
  }
}

/** Comando oficial de logout de cada CLI com sessão OAuth própria. */
const CLI_LOGOUT_COMMANDS: Readonly<Record<string, { bin: string; args: string[] }>> = Object.freeze({
  "claude-code": { bin: "claude", args: ["auth", "logout"] },
  codex: { bin: "codex", args: ["logout"] },
  cursor: { bin: "agent", args: ["logout"] },
  mimo: { bin: "mimo", args: ["auth", "logout"] },
});

/**
 * Encerra a sessão OAuth nativa do CLI pelo comando oficial. Afeta dados fora
 * do OpenCorp (a sessão do usuário no próprio CLI), por isso exige que o
 * chamador passe `confirmacao` igual ao ID do motor. Copilot não é suportado:
 * a sessão é do GitHub CLI, compartilhada com outras ferramentas.
 */
export function logoutCliSession(engineId: string, homeDir: string, confirmacao: string): { ok: boolean; message: string } {
  const cmd = CLI_LOGOUT_COMMANDS[engineId];
  if (!cmd) return { ok: false, message: `O motor "${engineId}" não tem sessão OAuth própria que o OpenCorp possa encerrar.` };
  if (confirmacao !== engineId) return { ok: false, message: `Confirmação ausente: envie confirmacao="${engineId}" para encerrar a sessão do CLI.` };
  const { code } = commandRunner(managedOrPath(homeDir, cmd.bin), cmd.args, 15_000);
  probeCache.delete(`${engineId}::${homeDir}`);
  return code === 0
    ? { ok: true, message: `Sessão do CLI "${engineId}" encerrada pelo comando oficial.` }
    : { ok: false, message: `O comando de logout do CLI "${engineId}" falhou (código ${code}).` };
}
