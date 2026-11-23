import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsError,
  SettingsStore,
  formatarValor,
  parseValor,
} from "../src/core/contexts/workspace/settings-store.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-settings-"));
  raizes.push(dir);
  return dir;
}

function storeEm(home: string): SettingsStore {
  return new SettingsStore({ homeDir: home, cwd: home });
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("parseValor / formatarValor", () => {
  it("converte booleanos, números e JSON; texto vira string", () => {
    expect(parseValor("true")).toBe(true);
    expect(parseValor("false")).toBe(false);
    expect(parseValor("3.5")).toBe(3.5);
    expect(parseValor("-2")).toBe(-2);
    expect(parseValor("opencode/grok-code")).toBe("opencode/grok-code");
    expect(parseValor('["a","b"]')).toEqual(["a", "b"]);
    expect(parseValor("não é json {")).toBe("não é json {");
  });

  it("formatarValor: string crua, resto JSON", () => {
    expect(formatarValor("texto")).toBe("texto");
    expect(formatarValor(true)).toBe("true");
    expect(formatarValor(["a", "b"])).toBe('["a","b"]');
  });
});

describe("SettingsStore — get/set", () => {
  it("retorna default quando nada está definido", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    const r = await store.get("test_model");
    expect(r.valor).toBe("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(r.origem).toBe("default");
  });

  it("set/get roundtrip grava JSON bonito no arquivo global", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    await store.set("test_model", "opencode/mimo-v2.5-free");
    const caminho = join(home, ".opencorp", "settings.json");
    const bruto = await readFile(caminho, "utf8");
    expect(JSON.parse(bruto)).toEqual({ test_model: "opencode/mimo-v2.5-free" });
    const r = await store.get("test_model");
    expect(r.valor).toBe("opencode/mimo-v2.5-free");
    expect(r.origem).toBe("global");
  });

  it("set com --scope workspace grava em <ws>/.opencorp/config.json sem tocar no global", async () => {
    const home = await tmpDir();
    const ws = join(home, "corp-x");
    const store = storeEm(home);
    await store.set("test_model", "gl/model");
    await store.set("test_model", "ws/model", { scope: "workspace", workspaceDir: ws });
    const configWs = await readFile(join(ws, ".opencorp", "config.json"), "utf8");
    expect(JSON.parse(configWs)).toEqual({ test_model: "ws/model" });
    const globalBruto = await readFile(join(home, ".opencorp", "settings.json"), "utf8");
    expect(JSON.parse(globalBruto)).toEqual({ test_model: "gl/model" });
    const storeNoWs = new SettingsStore({ homeDir: home, cwd: ws });
    expect(await storeNoWs.get("test_model")).toMatchObject({ valor: "ws/model", origem: "workspace" });
    expect(await store.get("test_model")).toMatchObject({ valor: "gl/model", origem: "global" });
    expect(await store.get("test_model", { scope: "global" })).toMatchObject({
      valor: "gl/model",
      origem: "global",
    });
  });

  it("set com chave desconhecida é rejeitado", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    const err = await store.set("foobar", "1").catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.message).toContain("chave desconhecida");
    expect(err.exitCode).toBe(1);
  });

  it("get de chave desconhecida é rejeitado", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    const err = await store.get("nao.existe").catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.exitCode).toBe(1);
  });

  it("set inválido aponta a chave e preserva o valor anterior", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    await store.set("budget.daily_usd", "5");
    const antes = await readFile(join(home, ".opencorp", "settings.json"), "utf8");
    const err = await store.set("budget.daily_usd", "bananas").catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.message).toContain("budget.daily_usd");
    expect(err.message).toContain("nada foi salvo");
    expect(err.exitCode).toBe(2);
    const depois = await readFile(join(home, ".opencorp", "settings.json"), "utf8");
    expect(depois).toBe(antes);
  });
});

describe("SettingsStore — merge de níveis", () => {
  it("workspace sobrescreve global por chave; resto cai no global/default", async () => {
    const home = await tmpDir();
    const ws = join(home, "corp-y");
    const store = storeEm(home);
    await store.set("budget.daily_usd", "5");
    await mkdir(join(ws, ".opencorp"), { recursive: true });
    await writeFile(
      join(ws, ".opencorp", "config.json"),
      JSON.stringify({ budget: { daily_usd: 2 }, default_model: "ws/m" }),
    );
    expect(await store.get("budget.daily_usd", { workspaceDir: ws })).toMatchObject({
      valor: 2,
      origem: "workspace",
    });
    expect(await store.get("default_model", { workspaceDir: ws })).toMatchObject({
      valor: "ws/m",
      origem: "workspace",
    });
    expect(await store.get("budget.per_agent_usd", { workspaceDir: ws })).toMatchObject({
      valor: 1,
      origem: "default",
    });
    expect(await store.get("test_model", { workspaceDir: ws })).toMatchObject({
      valor: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      origem: "default",
    });
  });

  it("overrides de CLI ficam no topo da ordem CLI > workspace > global", async () => {
    const home = await tmpDir();
    const ws = join(home, "corp-z");
    const store = storeEm(home);
    await store.set("default_model", "gl/m");
    await mkdir(join(ws, ".opencorp"), { recursive: true });
    await writeFile(join(ws, ".opencorp", "config.json"), JSON.stringify({ default_model: "ws/m" }));
    const r = await store.resolve({
      overrides: { default_model: "cli/m" },
      workspaceDir: ws,
    });
    expect(r.settings.default_model).toBe("cli/m");
    expect(r.origens.get("default_model")).toBe("cli");
  });

  it("escopo global ignora o workspace; escopo workspace lê o arquivo literal", async () => {
    const home = await tmpDir();
    const ws = join(home, "corp-w");
    const store = storeEm(home);
    await store.set("default_model", "gl/m");
    await mkdir(join(ws, ".opencorp"), { recursive: true });
    await writeFile(join(ws, ".opencorp", "config.json"), JSON.stringify({ default_model: "ws/m" }));
    expect(await store.get("default_model", { scope: "global" })).toMatchObject({
      valor: "gl/m",
      origem: "global",
    });
    expect(await store.get("default_model", { scope: "workspace", workspaceDir: ws })).toMatchObject({
      valor: "ws/m",
      origem: "workspace",
    });
    expect(await store.get("budget.daily_usd", { scope: "workspace", workspaceDir: ws })).toMatchObject({
      valor: 5,
      origem: "default",
    });
  });

  it("arquivo de workspace inválido quebra o merge apontando a chave", async () => {
    const home = await tmpDir();
    const ws = join(home, "corp-broken");
    const store = storeEm(home);
    await mkdir(join(ws, ".opencorp"), { recursive: true });
    await writeFile(join(ws, ".opencorp", "config.json"), JSON.stringify({ budget: { daily_usd: "x" } }));
    const err = await store.get("default_model", { workspaceDir: ws }).catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.message).toContain("budget.daily_usd");
    expect(err.exitCode).toBe(2);
  });

  it("JSON quebrado no global gera erro amigável", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await writeFile(join(home, ".opencorp", "settings.json"), "{ quebrado");
    const err = await store.get("default_model").catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.message).toContain("JSON inválido");
    expect(err.exitCode).toBe(2);
  });
});

describe("SettingsStore — reset", () => {
  it("reset devolve a chave ao default (pós-reset)", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    await store.set("test_model", "x/y");
    const r = await store.reset("test_model");
    expect(r.changed).toBe(true);
    expect(r.valor).toBe("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(r.origem).toBe("default");
    expect(await store.get("test_model")).toMatchObject({ valor: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", origem: "default" });
  });

  it("reset de seção no workspace faz cair no valor global", async () => {
    const home = await tmpDir();
    const ws = join(home, "corp-r");
    const store = storeEm(home);
    await store.set("budget.daily_usd", "3");
    await mkdir(join(ws, ".opencorp"), { recursive: true });
    await writeFile(join(ws, ".opencorp", "config.json"), JSON.stringify({ budget: { daily_usd: 2 } }));
    const r = await store.reset("budget", { scope: "workspace", workspaceDir: ws });
    expect(r.changed).toBe(true);
    expect(r.valor).toMatchObject({ daily_usd: 3, per_agent_usd: 1 });
    expect(r.origem).toBe("global");
  });

  it("reset de chave não definida não altera nada e informa o valor em vigor", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    const r = await store.reset("ui.theme");
    expect(r.changed).toBe(false);
    expect(r.valor).toBe("dark");
    expect(r.origem).toBe("default");
  });

  it("reset de chave opcional ausente (ex.: secretary.model) retorna sem erro", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    const r = await store.reset("secretary.model");
    expect(r.changed).toBe(false);
    expect(r.valor).toBeUndefined();
    expect(r.origem).toBe("default");
  });

  it("reset de chave realmente desconhecida continua falhando", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    const err = await store.reset("nao.existe").catch((e) => e);
    expect(err).toBeInstanceOf(SettingsError);
    expect(err.message).toContain("chave desconhecida");
  });
});

describe("SettingsStore — paths e resolução de workspace", () => {
  it("paths apontam global e <ws>/.opencorp/config.json", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    expect(await store.paths()).toEqual({
      global: join(home, ".opencorp", "settings.json"),
      workspace: null,
    });
    const ws = join(home, "corp-p");
    expect(await store.paths({ workspaceDir: ws })).toEqual({
      global: join(home, ".opencorp", "settings.json"),
      workspace: join(ws, ".opencorp", "config.json"),
    });
  });

  it("workspaceId resolve contra paths.workspaces_root do global", async () => {
    const home = await tmpDir();
    const raiz = join(home, "corps");
    const store = storeEm(home);
    await store.set("paths.workspaces_root", raiz);
    const dir = await store.diretorioWorkspace({ workspaceId: "corp-a" });
    expect(dir).toBe(join(raiz, "corp-a"));
  });
});

describe("SettingsStore — list", () => {
  it("lista todas as chaves da doc 06 com origem", async () => {
    const home = await tmpDir();
    const store = storeEm(home);
    await store.set("test_model", "x/y");
    const entradas = await store.list();
    const chaves = entradas.map((e) => e.chave);
    for (const esperada of [
      "version",
      "default_model",
      "test_model",
      "secretary.agent",
      "budget.daily_usd",
      "budget.per_agent_usd",
      "budget.pause_on_exceed",
      "budget.notify_registry",
      "security.level",
      "security.blocklist",
      "security.hitl_patterns",
      "security.network_allowlist",
      "paths.workspaces_root",
      "tests.blind",
      "tests.test_model",
      "tests.reports_dir",
      "tests.rotation",
      "tests.timeout_minutes",
      "cloud.enabled",
      "cloud.mode",
      "cloud.targets",
      "ui.theme",
      "ui.verbose",
    ]) {
      expect(chaves).toContain(esperada);
    }
    const testModel = entradas.find((e) => e.chave === "test_model")!;
    expect(testModel.valor).toBe("x/y");
    expect(testModel.origem).toBe("global");
    const theme = entradas.find((e) => e.chave === "ui.theme")!;
    expect(theme.origem).toBe("default");
  });
});
