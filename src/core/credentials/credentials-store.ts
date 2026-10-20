/**
 * CredentialsStore — fachada única de credenciais para spawn de motores (D4).
 *
 * Não é um cofre novo: lê as fontes que já existem e decide, por motor e
 * workspace, o conjunto mínimo de variáveis que o processo recebe.
 *
 * Fontes, em ordem de precedência por variável:
 *   1. conta explícita ou conta ativa autorizada do motor (EngineAccountStore);
 *   2. segredo do workspace (SecretsStore, `<ws>/.opencorp/secrets.json`);
 *   3. segredo global (SecretsStore, `~/.opencorp/secrets.json`);
 *   4. chaves de provedor geridas pelo OpenCorp (painel "Chaves de API",
 *      `~/.opencorp/opencode-data/opencode/auth.json`);
 *   5. ambiente do host.
 *
 * Regras:
 *   - cada motor só recebe as variáveis da sua política (`ENGINE_CREDENTIAL_VARS`);
 *   - toda variável sensível conhecida é removida do ambiente herdado antes da injeção;
 *   - conta restrita a outros workspaces nunca é usada; se foi pedida
 *     explicitamente, o spawn falha antes de acontecer (`CredentialScopeError`);
 *   - arquivos internos de CLIs de terceiros (ex.: `~/.claude/.credentials.json`,
 *     `~/.codex/auth.json`, `~/.local/share/opencode/auth.json`) nunca são lidos;
 *   - a única delegação é `gh auth token`, comando oficial do GitHub CLI, e só
 *     para o motor Copilot quando nenhuma outra fonte fornece o token.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnAsync } from "../../utils/spawn-async.js";
import { SecretsStore } from "../contexts/storage/secrets-store.js";
import { EngineAccountStore, type EngineAccount } from "../engines/engine-account-store.js";
import { EngineError } from "../engines/errors.js";

/** Variáveis que cada motor pode receber (padrão legado). Motores ausentes recebem nenhuma. */
export const ENGINE_CREDENTIAL_VARS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  codex: ["OPENAI_API_KEY"],
  "claude-code": ["ANTHROPIC_API_KEY"],
  copilot: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
  antigravity: ["GEMINI_API_KEY"],
  opencode: ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
  "crom-agente": ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  aider: ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"],
  mimo: [],
});

/** Variável de ambiente que representa a chave de cada provedor. */
export const PROVIDER_ENV_VARS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  openrouter: ["OPENROUTER_API_KEY"],
  "opencode-go": ["OPENROUTER_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GEMINI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  github: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"],
  cursor: ["CURSOR_API_KEY"],
});

/** Provedor implícito de uma conta cujo `provider` coincide com o motor. */
const ENGINE_DEFAULT_PROVIDER: Readonly<Record<string, string>> = Object.freeze({
  codex: "openai",
  "claude-code": "anthropic",
  copilot: "github",
  cursor: "cursor",
  antigravity: "google",
  opencode: "openrouter",
  "crom-agente": "openrouter",
  aider: "openrouter",
});

/** Todas as variáveis sensíveis que o OpenCorp conhece; nunca herdadas implicitamente. */
export const KNOWN_SECRET_ENV_VARS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(ENGINE_CREDENTIAL_VARS).flat(), ...Object.values(PROVIDER_ENV_VARS).flat()]),
]);

/** Política declarada pelo manifest do motor (`credentialEnvVars`); sobrepõe a tabela legada. */
export interface EngineCredentialPolicy {
  envVars: readonly string[];
  /** Provedor implícito das contas do motor (para mapear conta → variável). */
  defaultProvider?: string;
}

const registeredPolicies = new Map<string, EngineCredentialPolicy>();

/** Registra a política de credenciais de um motor (vinda do manifest). Nome do motor → variáveis aceitas. */
export function registerEngineCredentialPolicy(engineId: string, policy: EngineCredentialPolicy): void {
  registeredPolicies.set(engineId, { envVars: [...policy.envVars], defaultProvider: policy.defaultProvider });
}

export function clearEngineCredentialPolicies(): void {
  registeredPolicies.clear();
}

/** Variáveis que o motor pode receber: manifest registrado, senão a tabela legada. */
export function engineCredentialVars(engineId: string): readonly string[] {
  return registeredPolicies.get(engineId)?.envVars ?? ENGINE_CREDENTIAL_VARS[engineId] ?? [];
}

/** A variável é segredo conhecido (tabelas legadas + políticas registradas)? */
export function isKnownSecretEnvVar(name: string): boolean {
  if (KNOWN_SECRET_ENV_VARS.includes(name)) return true;
  for (const p of registeredPolicies.values()) if (p.envVars.includes(name)) return true;
  return false;
}

/** Chaves do auth.json gerido pelo OpenCorp → variável correspondente. */
const MANAGED_AUTH_KEYS: Readonly<Record<string, string>> = Object.freeze({
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
});

export type CredentialOrigin =
  | "account"
  | "workspace-secret"
  | "global-secret"
  | "opencorp-managed"
  | "host-env"
  | "cli-delegation";

export interface CredentialSource {
  variable: string;
  origin: CredentialOrigin;
  accountId?: string;
}

/** Resultado da resolução: variáveis a injetar e de onde vieram (sem valores). */
export interface CredentialGrant {
  engineId: string;
  workspaceId: string;
  env: Record<string, string>;
  sources: CredentialSource[];
  accountId?: string;
}

export interface ResolveCredentialsInput {
  engineId: string;
  workspaceId: string;
  workspacePath?: string;
  /** Conta pedida explicitamente. Falha se não autorizada para o workspace. */
  accountId?: string;
}

export class CredentialScopeError extends EngineError {
  constructor(engineId: string, accountId: string, workspaceId: string) {
    super(
      "CREDENTIAL_SCOPE_DENIED",
      `A conta "${accountId}" do motor "${engineId}" não está autorizada para o workspace "${workspaceId}".`,
      { engineId, details: { accountId, workspaceId } }
    );
  }
}

export function isAccountAllowedForWorkspace(account: Pick<EngineAccount, "workspaces">, workspaceId: string): boolean {
  return !account.workspaces || account.workspaces.length === 0 || account.workspaces.includes(workspaceId);
}

export function accountEnvVars(engineId: string, account: Pick<EngineAccount, "provider" | "motorId">): string[] {
  const provider = account.provider && account.provider !== account.motorId ? account.provider : registeredPolicies.get(engineId)?.defaultProvider ?? ENGINE_DEFAULT_PROVIDER[engineId];
  const vars = (provider && PROVIDER_ENV_VARS[provider]) || [];
  const allowed = engineCredentialVars(engineId);
  return vars.filter((v) => allowed.includes(v));
}

export interface CredentialsStoreOptions {
  homeDir: string;
  secrets?: SecretsStore;
  accounts?: EngineAccountStore;
  hostEnv?: NodeJS.ProcessEnv;
  /** Delegação ao GitHub CLI (`gh auth token`). Injetável para testes. */
  githubCliToken?: () => string | undefined | Promise<string | undefined>;
}

export class CredentialsStore {
  private readonly homeDir: string;
  private readonly secrets: SecretsStore;
  private readonly accounts: EngineAccountStore;
  private readonly hostEnv: NodeJS.ProcessEnv;
  private readonly githubCliToken: () => string | undefined | Promise<string | undefined>;

  constructor(opts: CredentialsStoreOptions) {
    this.homeDir = opts.homeDir;
    this.secrets = opts.secrets ?? new SecretsStore(opts.homeDir);
    this.accounts = opts.accounts ?? new EngineAccountStore({ homeDir: opts.homeDir });
    this.hostEnv = opts.hostEnv ?? process.env;
    this.githubCliToken = opts.githubCliToken ?? defaultGithubCliToken;
  }

  /** Resolve o conjunto mínimo de credenciais de um motor para um workspace. */
  async resolveForSpawn(input: ResolveCredentialsInput): Promise<CredentialGrant> {
    const allowed = engineCredentialVars(input.engineId);
    const grant: CredentialGrant = { engineId: input.engineId, workspaceId: input.workspaceId, env: {}, sources: [] };
    if (allowed.length === 0) return grant;

    const put = (variable: string, value: string | undefined, origin: CredentialOrigin, accountId?: string) => {
      if (!value || !allowed.includes(variable) || variable in grant.env) return;
      grant.env[variable] = value;
      grant.sources.push({ variable, origin, ...(accountId ? { accountId } : {}) });
    };

    // 1. Conta (explícita ou ativa), respeitando a restrição de workspace.
    const account = await this.pickAccount(input);
    if (account?.tokenOuChave) {
      for (const variable of accountEnvVars(input.engineId, account)) put(variable, account.tokenOuChave, "account", account.id);
      grant.accountId = account.id;
    }

    // 2–3. Segredos do workspace e globais.
    for (const variable of allowed) {
      const secret = this.secrets.obterValor(variable, input.workspacePath);
      if (secret) put(variable, secret.valor, secret.origem === "workspace" ? "workspace-secret" : "global-secret");
    }

    // 4. Chaves de provedor geridas pelo OpenCorp.
    const managed = this.readManagedProviderKeys();
    for (const [variable, value] of Object.entries(managed)) put(variable, value, "opencorp-managed");

    // 5. Ambiente do host.
    for (const variable of allowed) put(variable, this.hostEnv[variable], "host-env");

    // Delegação oficial ao GitHub CLI, somente para o Copilot.
    if (input.engineId === "copilot" && !grant.sources.some((s) => s.variable === "COPILOT_GITHUB_TOKEN" || s.variable === "GH_TOKEN" || s.variable === "GITHUB_TOKEN")) {
      const token = await this.githubCliToken();
      if (token) for (const variable of engineCredentialVars("copilot")) put(variable, token, "cli-delegation");
    }

    return grant;
  }

  /**
   * Monta o ambiente do processo: herda o host sem nenhuma variável sensível
   * conhecida e injeta apenas o que a política do motor concedeu.
   */
  static buildSpawnEnv(
    grant: CredentialGrant,
    base: NodeJS.ProcessEnv = process.env,
    extra: Record<string, string | undefined> = {}
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
      if (value !== undefined && !isKnownSecretEnvVar(key)) env[key] = value;
    }
    Object.assign(env, grant.env);
    for (const [key, value] of Object.entries(extra)) if (value !== undefined) env[key] = value;
    return env;
  }

  private async pickAccount(input: ResolveCredentialsInput): Promise<EngineAccount | undefined> {
    if (input.accountId) {
      const account = await this.accounts.obter(input.accountId);
      if (!account || account.motorId !== input.engineId) {
        throw new EngineError("ENGINE_AUTH_REQUIRED", `Conta "${input.accountId}" não encontrada para o motor "${input.engineId}".`, { engineId: input.engineId });
      }
      if (!isAccountAllowedForWorkspace(account, input.workspaceId)) {
        throw new CredentialScopeError(input.engineId, account.id, input.workspaceId);
      }
      return account;
    }
    const accounts = (await this.accounts.listar(input.engineId)).filter((a) => isAccountAllowedForWorkspace(a, input.workspaceId));
    return accounts.find((a) => a.ativa) ?? undefined;
  }

  private readManagedProviderKeys(): Record<string, string> {
    const path = join(this.homeDir, ".opencorp", "opencode-data", "opencode", "auth.json");
    if (!existsSync(path)) return {};
    try {
      const auth = JSON.parse(readFileSync(path, "utf8")) as Record<string, { key?: unknown }>;
      const out: Record<string, string> = {};
      for (const [provider, variable] of Object.entries(MANAGED_AUTH_KEYS)) {
        const key = auth[provider]?.key;
        if (typeof key === "string" && key.trim()) out[variable] = key.trim();
      }
      return out;
    } catch {
      return {};
    }
  }
}

async function defaultGithubCliToken(): Promise<string | undefined> {
  const r = await spawnAsync("gh", ["auth", "token"], { timeoutMs: 2500 });
  const token = r.status === 0 ? r.stdout.trim() : "";
  return token.startsWith("gh") ? token : undefined;
}

const REDACTED = "[REDACTED]";

/** Valores já concedidos a processos neste ciclo de vida; usados na redação. */
const grantedSecretValues = new Set<string>();

/**
 * Redige qualquer credencial conhecida: valores concedidos a motores por este
 * processo e variáveis sensíveis do ambiente do host.
 */
export function redactKnownSecrets(text: string): string {
  const values = [...grantedSecretValues];
  const names = new Set(KNOWN_SECRET_ENV_VARS);
  for (const p of registeredPolicies.values()) for (const v of p.envVars) names.add(v);
  for (const name of names) {
    const value = process.env[name];
    if (value) values.push(value);
  }
  return values.length > 0 ? redactSecrets(text, values) : text;
}

/**
 * Substitui valores de segredo por `[REDACTED]` em um texto. Usa os valores
 * informados e os das variáveis sensíveis conhecidas do ambiente dado.
 */
export function redactSecrets(text: string, secrets: Iterable<string> | Record<string, string | undefined> = {}): string {
  const values = new Set<string>();
  const add = (v: string | undefined) => { if (v && v.length >= 6) values.add(v); };
  if (Symbol.iterator in Object(secrets)) for (const v of secrets as Iterable<string>) add(v);
  else for (const [k, v] of Object.entries(secrets as Record<string, string | undefined>)) if (isKnownSecretEnvVar(k) || /KEY|TOKEN|SECRET|PASSWORD/i.test(k)) add(v);
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) out = out.split(value).join(REDACTED);
  return out;
}

/** Cópia do ambiente segura para log: variáveis sensíveis viram `[REDACTED]`. */
export function redactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    out[key] = isKnownSecretEnvVar(key) || /KEY|TOKEN|SECRET|PASSWORD/i.test(key) ? REDACTED : value;
  }
  return out;
}

export interface EngineSpawnEnvInput {
  homeDir: string;
  workspaceId: string;
  workspacePath?: string;
  accountId?: string;
}

/**
 * Ambiente efêmero de um processo de motor: host sem segredos conhecidos +
 * credenciais concedidas pela política do motor/workspace + `extra`. O objeto
 * retornado vive só até o spawn; nunca deve ser persistido nem logado sem
 * `redactEnv`.
 */
export async function resolveEngineSpawnEnv(
  engineId: string,
  input: EngineSpawnEnvInput,
  extra: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env
): Promise<Record<string, string>> {
  const store = new CredentialsStore({ homeDir: input.homeDir, hostEnv: base });
  const grant = await store.resolveForSpawn({
    engineId,
    workspaceId: input.workspaceId,
    workspacePath: input.workspacePath,
    accountId: input.accountId,
  });
  for (const value of Object.values(grant.env)) if (value.length >= 6) grantedSecretValues.add(value);
  return CredentialsStore.buildSpawnEnv(grant, base, extra);
}
