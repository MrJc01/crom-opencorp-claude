import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencorpHome } from "../src/utils/paths.js";
import { WorkspaceError, WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-ws-"));
  raizes.push(dir);
  return dir;
}

function managerEm(home: string, opts: { workspacesRoot?: string } = {}): WorkspaceManager {
  return new WorkspaceManager({ homeDir: home, cwd: home, ...opts });
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("WorkspaceManager — criar", () => {
  it("cria a estrutura contratual completa a partir do template default", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    const info = await m.criar("corp-teste");
    const ws = info.path;
    for (const rel of [
      ".opencorp/config.json",
      ".opencorp/security_policy.json",
      ".opencorp/budget.json",
      ".opencorp/agents/secretario.md",
      ".opencorp/agents/ceo-documentos.md",
      ".opencorp/agents/executor-padrao.md",
      ".opencorp/registries/chats",
      ".opencorp/registries/documentos",
      ".opencorp/registries/execucoes",
      ".opencorp/registries/agentes",
      ".opencorp/registries/custos",
      ".opencorp/registries/logs",
      ".opencorp/registries/custom",
      ".opencorp/opencode",
      ".opencorp/reports/testes",
      "sandbox",
      "docs/README.md",
      "logs",
    ]) {
      expect(existsSync(join(ws, rel)), rel).toBe(true);
    }
    const policy = JSON.parse(await readFile(join(ws, ".opencorp", "security_policy.json"), "utf8"));
    expect(policy.level).toBe("standard");
    expect(policy.blocklist).toContain("rm -rf");
    expect(policy.hitl_patterns).toContain("git push");
    const config = JSON.parse(await readFile(join(ws, ".opencorp", "config.json"), "utf8"));
    expect(config.version).toBe(1);
  });

  it("primeiro workspace criado vira o ativo automaticamente", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    const info = await m.criar("primeiro");
    expect(info.ativo).toBe(true);
    const atual = await m.atual();
    expect(atual?.id).toBe("primeiro");
  });

  it("mantém o nome de exibição de workspaces.json ao listar", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("canal-um");
    const arq = join(home, ".opencorp", "workspaces.json");
    const estado = JSON.parse(await readFile(arq, "utf8"));
    estado.workspaces[0].nome = "Canal Um";
    await writeFile(arq, JSON.stringify(estado));
    const lista = await managerEm(home).listar();
    expect(lista[0]?.id).toBe("canal-um");
    expect(lista[0]?.nome).toBe("Canal Um");
  });

  it("rejeita id fora do kebab-case", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    for (const ruim of ["Nome Ruim!", "UPPER", "duplo--hifen", "-inicio", "fim-"]) {
      const err = await m.criar(ruim).catch((e) => e);
      expect(err).toBeInstanceOf(WorkspaceError);
      expect(err.message).toContain("kebab-case");
      expect(err.exitCode).toBe(1);
    }
  });

  it("rejeita id duplicado com erro claro", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("dup");
    const err = await m.criar("dup").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("já existe");
    expect(err.exitCode).toBe(1);
  });

  it("rejeita template inexistente", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    const err = await m.criar("corp-x", { template: "nao-existe" }).catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("template");
  });

  it("respeita paths.workspaces_root do settings", async () => {
    const home = await tmpDir();
    const raiz = join(home, "corps-custom");
    const { SettingsStore } = await import("../src/core/contexts/workspace/settings-store.js");
    const store = new SettingsStore({ homeDir: home, cwd: home });
    await store.set("paths.workspaces_root", raiz);
    const m = managerEm(home);
    const info = await m.criar("corp-raiz");
    expect(info.path).toBe(join(raiz, "corp-raiz"));
    expect(existsSync(info.path)).toBe(true);
  });

  it("respeita workspacesRoot injetado", async () => {
    const home = await tmpDir();
    const raiz = join(home, "raiz-injetada");
    const m = managerEm(home, { workspacesRoot: raiz });
    const info = await m.criar("corp-injetado");
    expect(info.path).toBe(join(raiz, "corp-injetado"));
  });
});

describe("WorkspaceManager — usar/atual/resolver", () => {
  it("usar define o ativo; atual retorna; usar inexistente falha", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("a");
    await m.criar("b");
    await m.usar("b");
    expect((await m.atual())?.id).toBe("b");
    const err = await m.usar("fantasma").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("não encontrado");
  });

  it("usar workspace com pasta ausente falha com mensagem clara", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("sumido");
    await rm(join(home, ".opencorp", "workspaces", "sumido"), { recursive: true, force: true });
    const err = await m.usar("sumido").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("não foi encontrada");
  });

  it("resolver sem flag e sem ativo falha; com flag resolve", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    const err = await m.resolver().catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("nenhum workspace ativo");
    await m.criar("corp-um");
    expect((await m.resolver("corp-um")).id).toBe("corp-um");
    const err2 = await m.resolver("nao-existe").catch((e) => e);
    expect(err2.message).toContain("não encontrado");
  });

  it("atual() é null quando nada foi criado", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    expect(await m.atual()).toBeNull();
  });
});

describe("WorkspaceManager — deletar", () => {
  it("exige confirmação (sim) antes de remover", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("alvo");
    const err = await m.deletar("alvo").catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("confirmação");
    expect(existsSync(join(home, ".opencorp", "workspaces", "alvo"))).toBe(true);
  });

  it("deleta pasta + registro; se era ativo, limpa o ativo", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("ativo-ws");
    const r = await m.deletar("ativo-ws", { sim: true });
    expect(r.removidoPasta).toBe(true);
    expect(r.eraAtivo).toBe(true);
    expect(existsSync(r.path)).toBe(false);
    expect(await m.atual()).toBeNull();
    expect((await m.listar()).map((w) => w.id)).not.toContain("ativo-ws");
  });

  it("remove registro mesmo sem pasta (estado ausente)", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("fantasma");
    await rm(join(home, ".opencorp", "workspaces", "fantasma"), { recursive: true, force: true });
    const r = await m.deletar("fantasma", { sim: true });
    expect(r.removidoPasta).toBe(false);
    expect(await m.listar()).toEqual([]);
  });
});

describe("WorkspaceManager — estado e agentes", () => {
  it("estado corrompido gera erro amigável", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await writeFile(join(home, ".opencorp", "workspaces.json"), "{ quebrado");
    const err = await m.listar().catch((e) => e);
    expect(err).toBeInstanceOf(WorkspaceError);
    expect(err.message).toContain("JSON inválido");
    expect(err.exitCode).toBe(2);
  });

  it("listarAgentes encontra os agentes do template (14, incluindo auditor e catálogo)", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("corp-agentes");
    const agentes = await m.listarAgentes("corp-agentes");
    expect(agentes.map((a) => a.id)).toEqual(["agente-financeiro", "agente-juridico", "agente-marketing", "agente-ops", "agente-suporte", "agente-vendas", "auditor", "ceo-documentos", "corretor-site", "critico-site", "executor-padrao", "frontend-especialista", "secretario", "secretario-exec"]);
    const porId = new Map(agentes.map((a) => [a.id, a]));
    expect(porId.get("secretario")?.category).toBe("secretario");
    expect(porId.get("ceo-documentos")?.category).toBe("ceo");
    expect(porId.get("executor-padrao")?.category).toBe("operario");
    expect(porId.get("executor-padrao")?.permissions).toBe("level-2");
    expect(porId.get("auditor")?.category).toBe("custom");
    expect(porId.get("agente-vendas")?.ativo).toBe(false);
  });

  it("detalhar mostra agentes e orçamento (default quando config vazio)", async () => {
    const home = await tmpDir();
    const m = managerEm(home);
    await m.criar("corp-detalhe");
    const d = await m.detalhar("corp-detalhe");
    expect(d.agentes).toHaveLength(14);
    expect(d.orcamento.daily_usd).toMatchObject({ valor: 5, origem: "default" });
    expect(d.seguranca).toBe("standard");
  });
});

describe("opencorpHome", () => {
  it("honra OPENCORP_HOME; sem env, usa homedir", async () => {
    const anterior = process.env.OPENCORP_HOME;
    try {
      process.env.OPENCORP_HOME = "/tmp/opencorp-isolado";
      expect(opencorpHome()).toBe("/tmp/opencorp-isolado");
      delete process.env.OPENCORP_HOME;
      expect(opencorpHome()).toBe((await import("node:os")).homedir());
    } finally {
      if (anterior === undefined) delete process.env.OPENCORP_HOME;
      else process.env.OPENCORP_HOME = anterior;
    }
  });
});
