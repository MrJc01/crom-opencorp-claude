import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialScopeError,
  CredentialsStore,
  KNOWN_SECRET_ENV_VARS,
  redactEnv,
  redactKnownSecrets,
  redactSecrets,
  resolveEngineSpawnEnv,
} from "../src/core/credentials/index.js";
import { EngineAccountStore } from "../src/core/engines/engine-account-store.js";
import {
  checkEngineAuthStatus,
  logoutCliSession,
  probeCliLogin,
  resolveEngineCredentials,
  setCliLoginCommandRunner,
  type CommandRunner,
} from "../src/core/engines/credentials-bridge.js";
import { normalizeEngineError } from "../src/core/engines/error-normalizer.js";
import { SecretsStore } from "../src/core/contexts/storage/secrets-store.js";
import { CodexDriver } from "../src/core/engines/drivers/codex-driver.js";

const THIRD_PARTY_SENTINEL = "sk-terceiro-NAO-PODE-VAZAR-123456";

describe("ETAPA 9 — CredentialsStore e injeção efêmera", () => {
  let home: string;
  let wsA: string;
  let wsB: string;
  let commands: Array<{ bin: string; args: string[] }>;
  let previousRunner: CommandRunner;
  const hostEnv = {
    PATH: "/usr/bin",
    HOME: "/home/x",
    OPENAI_API_KEY: "sk-host-openai-aaaaaa",
    ANTHROPIC_API_KEY: "sk-host-anthropic-bbbbbb",
    GITHUB_TOKEN: "ghp_host_cccccccc",
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-cred-"));
    wsA = join(home, "ws-a");
    wsB = join(home, "ws-b");
    await mkdir(join(wsA, ".opencorp"), { recursive: true });
    await mkdir(join(wsB, ".opencorp"), { recursive: true });
    await mkdir(join(home, ".opencorp"), { recursive: true });
    // Arquivos internos de CLIs de terceiros com valores-sentinela.
    await mkdir(join(home, ".local", "share", "opencode"), { recursive: true });
    await writeFile(join(home, ".local", "share", "opencode", "auth.json"), JSON.stringify({ openrouter: { type: "api", key: THIRD_PARTY_SENTINEL } }));
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: THIRD_PARTY_SENTINEL, refreshToken: THIRD_PARTY_SENTINEL, refreshTokenExpiresAt: Date.now() + 1e9 } }));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: THIRD_PARTY_SENTINEL } }));
    commands = [];
    previousRunner = setCliLoginCommandRunner((bin, args) => {
      commands.push({ bin, args });
      return { code: 1, stdout: "" };
    });
  });

  afterEach(async () => {
    setCliLoginCommandRunner(previousRunner);
    await rm(home, { recursive: true, force: true });
  });

  const store = (extra: Partial<ConstructorParameters<typeof CredentialsStore>[0]> = {}) =>
    new CredentialsStore({ homeDir: home, hostEnv, githubCliToken: () => undefined, ...extra });

  it("injeta a conta autorizada no workspace e registra a origem sem o valor", async () => {
    const accounts = new EngineAccountStore({ homeDir: home });
    const conta = await accounts.adicionarConta("codex", { nome: "Equipe A", provider: "openai", tokenOuChave: "sk-conta-a-111111", workspaces: ["ws-a"] });
    const grant = await store().resolveForSpawn({ engineId: "codex", workspaceId: "ws-a", workspacePath: wsA });
    expect(grant.env).toEqual({ OPENAI_API_KEY: "sk-conta-a-111111" });
    expect(grant.accountId).toBe(conta.id);
    expect(grant.sources).toEqual([{ variable: "OPENAI_API_KEY", origin: "account", accountId: conta.id }]);
    expect(JSON.stringify(grant.sources)).not.toContain("sk-conta-a");
  });

  it("não usa conta restrita em outro workspace e falha antes do spawn quando pedida explicitamente", async () => {
    const accounts = new EngineAccountStore({ homeDir: home });
    const conta = await accounts.adicionarConta("codex", { nome: "Só A", provider: "openai", tokenOuChave: "sk-conta-a-111111", workspaces: ["ws-a"] });
    const implicit = await store().resolveForSpawn({ engineId: "codex", workspaceId: "ws-b", workspacePath: wsB });
    expect(implicit.env.OPENAI_API_KEY).toBe(hostEnv.OPENAI_API_KEY);
    expect(implicit.sources[0]?.origin).toBe("host-env");
    await expect(store().resolveForSpawn({ engineId: "codex", workspaceId: "ws-b", accountId: conta.id })).rejects.toBeInstanceOf(CredentialScopeError);
  });

  it("o driver falha antes de montar o comando quando a conta não é autorizada", async () => {
    const accounts = new EngineAccountStore({ homeDir: home });
    const conta = await accounts.adicionarConta("codex", { nome: "Só A", provider: "openai", tokenOuChave: "sk-conta-a-111111", workspaces: ["ws-a"] });
    const fakeBin = join(home, "bin", "codex");
    await mkdir(join(home, "bin"), { recursive: true });
    await writeFile(fakeBin, "#!/bin/sh\necho codex 0.0.0\n", { mode: 0o755 });
    await writeFile(join(home, ".opencorp", "settings.json"), JSON.stringify({ engines: { codex: { binary_path: fakeBin } } }));
    const driver = new CodexDriver();
    await expect(driver.prepareExecution({
      workspaceId: "ws-b", workspacePath: wsB, sessionId: "s", agentId: "a", model: "default", prompt: "x", homeDir: home, accountId: conta.id,
    })).rejects.toMatchObject({ code: "CREDENTIAL_SCOPE_DENIED" });
  });

  it("cada motor recebe só as variáveis da sua política e o host não vaza as demais", async () => {
    const codexEnv = await resolveEngineSpawnEnv("codex", { homeDir: home, workspaceId: "ws-a", workspacePath: wsA }, {}, hostEnv);
    expect(codexEnv.OPENAI_API_KEY).toBe(hostEnv.OPENAI_API_KEY);
    expect(codexEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(codexEnv.GITHUB_TOKEN).toBeUndefined();
    expect(codexEnv.PATH).toBe("/usr/bin");

    const mimoEnv = await resolveEngineSpawnEnv("mimo", { homeDir: home, workspaceId: "ws-a" }, {}, hostEnv);
    for (const name of KNOWN_SECRET_ENV_VARS) expect(mimoEnv[name]).toBeUndefined();

    const claudeEnv = await resolveEngineSpawnEnv("claude-code", { homeDir: home, workspaceId: "ws-a" }, { EXTRA: "1" }, hostEnv);
    expect(Object.keys(claudeEnv).filter((k) => KNOWN_SECRET_ENV_VARS.includes(k))).toEqual(["ANTHROPIC_API_KEY"]);
    expect(claudeEnv.EXTRA).toBe("1");
  });

  it("segredo do workspace vence o global e não atravessa para outro workspace", async () => {
    const secrets = new SecretsStore(home);
    await secrets.definir("OPENAI_API_KEY", "sk-global-222222", "global");
    await secrets.definir("OPENAI_API_KEY", "sk-ws-a-333333", "workspace", wsA);
    const a = await store({ hostEnv: {} }).resolveForSpawn({ engineId: "codex", workspaceId: "ws-a", workspacePath: wsA });
    const b = await store({ hostEnv: {} }).resolveForSpawn({ engineId: "codex", workspaceId: "ws-b", workspacePath: wsB });
    expect(a.env.OPENAI_API_KEY).toBe("sk-ws-a-333333");
    expect(a.sources[0]?.origin).toBe("workspace-secret");
    expect(b.env.OPENAI_API_KEY).toBe("sk-global-222222");
  });

  it("delega ao gh auth token apenas para o Copilot", async () => {
    const gh = () => "gho_delegado_444444";
    const copilot = await store({ hostEnv: {}, githubCliToken: gh }).resolveForSpawn({ engineId: "copilot", workspaceId: "ws-a" });
    expect(copilot.env.COPILOT_GITHUB_TOKEN).toBe("gho_delegado_444444");
    expect(copilot.sources.every((s) => s.origin === "cli-delegation")).toBe(true);
    const codex = await store({ hostEnv: {}, githubCliToken: gh }).resolveForSpawn({ engineId: "codex", workspaceId: "ws-a" });
    expect(Object.values(codex.env)).not.toContain("gho_delegado_444444");
  });

  it("nunca lê arquivos internos de CLIs de terceiros", async () => {
    for (const engineId of ["opencode", "codex", "claude-code", "crom-agente", "aider", "copilot"]) {
      const env = await resolveEngineSpawnEnv(engineId, { homeDir: home, workspaceId: "ws-a" }, {}, {});
      expect(Object.values(env), engineId).not.toContain(THIRD_PARTY_SENTINEL);
    }
    expect(Object.values(resolveEngineCredentials(home))).not.toContain(THIRD_PARTY_SENTINEL);
    // Com arquivos OAuth presentes mas sem login no CLI, o status é "não autenticado".
    const saved = { ...process.env };
    for (const name of KNOWN_SECRET_ENV_VARS) delete process.env[name];
    try {
      expect(checkEngineAuthStatus("claude-code", home).authenticated).toBe(false);
      expect(checkEngineAuthStatus("codex", home).authenticated).toBe(false);
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("claude-sdk usa o login do plano e ignora ANTHROPIC_API_KEY", () => {
    const saved = { ...process.env };
    for (const name of KNOWN_SECRET_ENV_VARS) delete process.env[name];
    delete process.env.OPENCORP_CLAUDE_CONFIG_DIR;
    try {
      setCliLoginCommandRunner(() => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }) }));
      expect(checkEngineAuthStatus("claude-sdk", home)).toMatchObject({ authenticated: true, details: "pro" });
      setCliLoginCommandRunner(() => ({ code: 0, stdout: JSON.stringify({ loggedIn: false }) }));
      process.env.ANTHROPIC_API_KEY = "sk-nao-conta";
      expect(checkEngineAuthStatus("claude-sdk", home).authenticated).toBe(false);
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });

  it("openheinerss é ponte local: autenticado sem credencial própria", () => {
    expect(checkEngineAuthStatus("openheinerss", home)).toMatchObject({ authenticated: true, method: "Local (sem credencial própria)" });
  });

  it("verifica OAuth pelo comando oficial do CLI e guarda em cache", () => {
    setCliLoginCommandRunner((bin, args) => {
      commands.push({ bin, args });
      if (args.join(" ") === "auth status --json") return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
      if (args.join(" ") === "login status") return { code: 0, stdout: "Logged in using ChatGPT\n" };
      if (args.join(" ") === "status --format json") return { code: 0, stdout: JSON.stringify({ isAuthenticated: false, message: "Not logged in" }) };
      return { code: 1, stdout: "" };
    });
    expect(probeCliLogin("claude-code", home)).toMatchObject({ loggedIn: true, details: "max" });
    expect(probeCliLogin("codex", home)).toMatchObject({ loggedIn: true });
    expect(probeCliLogin("cursor", home)).toMatchObject({ loggedIn: false });
    expect(probeCliLogin("copilot", home)).toMatchObject({ loggedIn: false, method: "gh auth status" });
    expect(probeCliLogin("antigravity", home)).toBeUndefined();
    const count = commands.length;
    probeCliLogin("claude-code", home);
    expect(commands.length).toBe(count);
    expect(commands.map((c) => c.bin)).toEqual(["claude", "codex", "agent", "gh"]);
  });

  it("não declara autenticado um motor sem verificação possível", () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      expect(checkEngineAuthStatus("antigravity", home)).toMatchObject({ authenticated: false, method: "Não verificável" });
      expect(checkEngineAuthStatus("motor-inexistente", home).authenticated).toBe(false);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it("encerra a sessão externa do CLI apenas com confirmação explícita", () => {
    expect(logoutCliSession("codex", home, "")).toMatchObject({ ok: false });
    expect(commands.some((c) => c.args.includes("logout"))).toBe(false);
    setCliLoginCommandRunner((bin, args) => { commands.push({ bin, args }); return { code: 0, stdout: "" }; });
    expect(logoutCliSession("codex", home, "codex")).toMatchObject({ ok: true });
    expect(commands.at(-1)).toEqual({ bin: "codex", args: ["logout"] });
    expect(logoutCliSession("copilot", home, "copilot")).toMatchObject({ ok: false });
  });

  it("rotação de conta respeita motor e workspace", async () => {
    const accounts = new EngineAccountStore({ homeDir: home });
    const a1 = await accounts.adicionarConta("codex", { nome: "A1", tokenOuChave: "sk-a1-555555", workspaces: ["ws-a"] });
    await accounts.adicionarConta("codex", { nome: "B1", tokenOuChave: "sk-b1-666666", workspaces: ["ws-b"] });
    const a2 = await accounts.adicionarConta("codex", { nome: "A2", tokenOuChave: "sk-a2-777777", workspaces: ["ws-a"] });
    await accounts.adicionarConta("claude-code", { nome: "Outro motor", tokenOuChave: "sk-c-888888" });
    expect((await accounts.obterContaAtiva("codex"))?.id).toBe(a1.id);
    const next = await accounts.rotacionarProximaConta("codex", "ws-a");
    expect(next?.id).toBe(a2.id);
    const back = await accounts.rotacionarProximaConta("codex", "ws-a");
    expect(back?.id).toBe(a1.id);
    expect((await accounts.obterContaAtiva("claude-code"))?.nome).toBe("Outro motor");
  });

  it("redige segredos em textos, ambientes e erros normalizados", async () => {
    expect(redactSecrets("chave sk-abc123456 recusada", ["sk-abc123456"])).toBe("chave [REDACTED] recusada");
    expect(redactEnv({ OPENAI_API_KEY: "sk-1234567", MY_SERVICE_TOKEN: "abcdefgh", PATH: "/bin" })).toEqual({ OPENAI_API_KEY: "[REDACTED]", MY_SERVICE_TOKEN: "[REDACTED]", PATH: "/bin" });
    await resolveEngineSpawnEnv("codex", { homeDir: home, workspaceId: "ws-a" }, {}, { OPENAI_API_KEY: "sk-concedida-999999" });
    expect(redactKnownSecrets("401: invalid api key sk-concedida-999999")).not.toContain("sk-concedida-999999");
    const error = normalizeEngineError(new Error("401 Unauthorized: sk-concedida-999999"), { engineId: "codex" });
    expect(error.message + JSON.stringify(error.details)).not.toContain("sk-concedida-999999");
  });

  it("resolver credenciais não escreve em disco nem altera o ambiente do processo", async () => {
    const before = await readdir(join(home, ".opencorp"));
    const envBefore = JSON.stringify(process.env);
    await resolveEngineSpawnEnv("opencode", { homeDir: home, workspaceId: "ws-a", workspacePath: wsA }, {}, hostEnv);
    expect(await readdir(join(home, ".opencorp"))).toEqual(before);
    expect(JSON.stringify(process.env)).toBe(envBefore);
  });
});
