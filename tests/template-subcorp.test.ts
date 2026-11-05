import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SubcorpError } from "../src/core/shared/errors.js";
import { SubcorpStore } from "../src/core/contexts/workspace/subcorp-store.js";
import { SessionManager } from "../src/core/contexts/execution/session-manager.js";
import { TemplateStore } from "../src/core/contexts/platform/template-store.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));
vi.mock("../src/core/contexts/execution/execution-driver.js", () => ({
  resolverDriverExecucao: async () => ({
    tipo: "host",
    disponivel: async () => true,
    preparar: async (opts: any) => ({
      driver: "host",
      binary: opts.binary,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
    }),
  }),
}));

const raizes: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  raizes.push(dir);
  return dir;
}

interface Ambiente {
  home: string;
  manager: WorkspaceManager;
  templates: TemplateStore;
  subcorps: SubcorpStore;
  wsBase: { path: string; id: string };
}

async function ambiente(): Promise<Ambiente> {
  const home = await tmpDir("opencorp-tpl-");
  const manager = new WorkspaceManager({ homeDir: home, cwd: home });
  const ws = await manager.criar("test-base");
  return {
    home,
    manager,
    templates: new TemplateStore({ homeDir: home }),
    subcorps: new SubcorpStore({ homeDir: home }),
    wsBase: { path: ws.path, id: ws.id },
  };
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

beforeEach(() => {
  execaMock.mockClear();
});

describe("TemplateStore — criar/listar", () => {
  it("cria template vazio editável e lista com default", async () => {
    const { templates } = await ambiente();
    const dir = await templates.criar("meu-tpl");
    expect(existsSync(join(dir, "template.json"))).toBe(true);
    expect(existsSync(join(dir, "agents"))).toBe(true);
    expect(existsSync(join(dir, "registries"))).toBe(true);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
    expect(existsSync(join(dir, "security_policy.json"))).toBe(true);
    const lista = await templates.listar();
    const ids = lista.map((t) => t.id);
    expect(ids).toContain("default");
    expect(ids).toContain("meu-tpl");
  });

  it("rejeita template duplicado", async () => {
    const { templates } = await ambiente();
    await templates.criar("dup-tpl");
    const err = await templates.criar("dup-tpl").catch((e) => e);
    expect(err.message).toContain("já existe");
  });
});

describe("TemplateStore — export/import (roundtrip)", () => {
  async function workspacePopulado() {
    const env = await ambiente();
    const { writeFileAtomic } = await import("../src/utils/fs-safe.js");
    await writeFileAtomic(join(env.wsBase.path, ".opencorp", "agents", "auditor.md"), `---
id: auditor
role: Auditor
category: custom
model: opencode/grok-code
tools: [read, bash]
permissions: level-2
budget:
  daily_usd: 1
  max_turns: 10
memory:
  reads: []
  writes: []
---

Você é o auditor.
`);
    await writeFileAtomic(
      join(env.wsBase.path, ".opencorp", "registries", "notas", "base", "meta.json"),
      JSON.stringify({
        id: "base",
        categoria: "notas",
        descricao: "doc base",
        criado_por: "humano",
        criado_em: "2026-08-28T10:00:00.000Z",
        atualizado_em: "2026-08-28T10:00:00.000Z",
        permissoes: { leitura: ["*"], escrita: ["humano"], modificacao_meta: [] },
        tags: [],
        referencias: [],
      }, null, 2) + "\n",
    );
    await writeFileAtomic(
      join(env.wsBase.path, ".opencorp", "registries", "notas", "base", "conteudo.md"),
      "conteúdo da nota base\n",
    );
    await writeFileAtomic(
      join(env.wsBase.path, ".opencorp", "registries", "notas", "base", "journal.jsonl"),
      '{"ts":"2026-08-28T10:00:00.000Z","por":"humano","evento":"criado","resumo":"doc base"}\n',
    );
    await writeFile(env.wsBase.path + "/.opencorp/secrets.json", '{"chave":"x"}', "utf8");
    return env;
  }

  it("export pasta + import: agentes e registros preservados", async () => {
    const env = await workspacePopulado();
    const destino = join(env.home, "tpl-pasta");
    const r = await env.templates.exportar(env.wsBase.path, env.wsBase.id, destino);
    expect(r.excluidos.map((x) => x.includes("secrets"))).toContain(true);
    expect(existsSync(join(destino, "agents", "auditor.md"))).toBe(true);
    expect(existsSync(join(destino, "registries", "notas", "base", "conteudo.md"))).toBe(true);
    expect(existsSync(join(destino, "template.json"))).toBe(true);

    const imp = await env.templates.importar(destino, "tpl-pasta-import");
    const manager = new WorkspaceManager({ homeDir: env.home, cwd: env.home });
    const ws = await manager.criar("corp-pasta", { template: imp.id });
    expect(existsSync(join(ws.path, ".opencorp", "agents", "auditor.md"))).toBe(true);
    expect(existsSync(join(ws.path, ".opencorp", "registries", "notas", "base", "conteudo.md"))).toBe(true);
    const config = JSON.parse(readFileSync(join(ws.path, ".opencorp", "config.json"), "utf8"));
    expect(config.version).toBe(1);
  });

  it("export .corp gera tar.gz válido; import extrai e cria workspace com tudo", async () => {
    const env = await workspacePopulado();
    const destino = join(env.home, "tpl.corp");
    await env.templates.exportar(env.wsBase.path, env.wsBase.id, destino);
    const tar = spawnSync("tar", ["-tf", destino]);
    expect(tar.status).toBe(0);
    const conteudo = tar.stdout.toString();
    expect(conteudo).toContain("agents/auditor.md");
    expect(conteudo).toContain("registries/notas/base/meta.json");

    const imp = await env.templates.importar(destino, "tpl-corp-import");
    const manager = new WorkspaceManager({ homeDir: env.home, cwd: env.home });
    const ws = await manager.criar("corp-corp", { template: imp.id });
    expect(existsSync(join(ws.path, ".opencorp", "agents", "auditor.md"))).toBe(true);
    expect(existsSync(join(ws.path, ".opencorp", "registries", "notas", "base", "journal.jsonl"))).toBe(true);
    const { RegistryStore } = await import("../src/core/contexts/storage/registry-store.js");
    const registros = new RegistryStore();
    const r = await registros.obter(ws.path, "notas", "base");
    expect(r.meta.descricao).toBe("doc base");
    expect(r.conteudo).toContain("conteúdo da nota base");
  });

  it("export nunca inclui segredos (secrets?, keys?, .env*) mas mantém agentes legítimos", async () => {
    const env = await workspacePopulado();
    const { writeFileAtomic } = await import("../src/utils/fs-safe.js");
    const { mkdirRecursive } = await import("../src/utils/fs-safe.js");
    await mkdirRecursive(join(env.wsBase.path, ".opencorp", "registries", "custos"));
    await writeFileAtomic(join(env.wsBase.path, ".opencorp", "registries", "custos", "keys.txt"), "k");
    await writeFileAtomic(join(env.wsBase.path, ".opencorp", "registries", "custom", "api.env"), "e");
    const destino = join(env.home, "tpl-seg.corp");
    const r = await env.templates.exportar(env.wsBase.path, env.wsBase.id, destino);
    expect(r.excluidos.length).toBeGreaterThanOrEqual(3);
    const tar = spawnSync("tar", ["-tf", destino]);
    const linhas = tar.stdout.toString().split("\n");
    expect(linhas.some((l) => /(^|[^a-z0-9])(secrets?|keys?)([^a-z0-9]|$)|\.env/i.test(l))).toBe(false);
    expect(linhas.some((l) => l.includes("secrets.json"))).toBe(false);
    expect(linhas.some((l) => l.includes("agents/secretario.md"))).toBe(true);
    expect(linhas.some((l) => l.includes("agents/auditor.md"))).toBe(true);
  });
});

describe("SubcorpStore — add/list/remove", () => {
  it("add valida perm, grava no config.json do pai e expõe todos os agentes", async () => {
    const env = await ambiente();
    const err = await env.subcorps
      .adicionar(env.wsBase.path, { fonte: env.wsBase.path, id: "filho", perm: "escreve" as never })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SubcorpError);
    expect(err.message).toContain("read | ask | write");

    const wsFilho = await env.manager.criar("filho-real");
    const entrada = await env.subcorps.adicionar(env.wsBase.path, {
      fonte: wsFilho.path,
      id: "financeiro",
      perm: "ask",
    });
    expect(entrada.exposed_agents.length).toBe(14);
    expect(entrada.permissions).toBe("ask");
    const config = JSON.parse(readFileSync(join(env.wsBase.path, ".opencorp", "config.json"), "utf8"));
    expect(config.subcorps[0].id).toBe("financeiro");

    const errDup = await env.subcorps
      .adicionar(env.wsBase.path, { fonte: wsFilho.path, id: "financeiro", perm: "ask" })
      .catch((e) => e);
    expect(errDup.message).toContain("já existe");
  });

  it("add rejeita fonte inexistente e fonte sem .opencorp/agents", async () => {
    const env = await ambiente();
    const err1 = await env.subcorps
      .adicionar(env.wsBase.path, { fonte: "/caminho/que-nao-existe", id: "x", perm: "read" })
      .catch((e) => e);
    expect(err1.message).toContain("não existe");
    const vazio = await tmpDir("opencorp-vazio-");
    const err2 = await env.subcorps
      .adicionar(env.wsBase.path, { fonte: vazio, id: "y", perm: "read" })
      .catch((e) => e);
    expect(err2.message).toContain("não é um workspace instanciado");
  });

  it("remove tira só a referência; pasta do subcorp permanece", async () => {
    const env = await ambiente();
    const wsFilho = await env.manager.criar("filho-rm");
    await env.subcorps.adicionar(env.wsBase.path, { fonte: wsFilho.path, id: "fin", perm: "read" });
    const entrada = await env.subcorps.remover(env.wsBase.path, "fin");
    expect(entrada.id).toBe("fin");
    expect(existsSync(wsFilho.path)).toBe(true);
    const err = await env.subcorps.obter(env.wsBase.path, "fin").catch((e) => e);
    expect(err).toBeInstanceOf(SubcorpError);
    expect(existsSync(join(wsFilho.path, ".opencorp", "agents"))).toBe(true);
    expect(readdirSync(join(wsFilho.path, ".opencorp", "agents")).length).toBe(14);
  });

  it("perm read bloqueia run; agente não exposto bloqueia run (exit 3)", async () => {
    const env = await ambiente();
    const wsFilho = await env.manager.criar("filho-perm");
    await env.subcorps.adicionar(env.wsBase.path, { fonte: wsFilho.path, id: "solo", perm: "read" });
    const err = await env.subcorps.resolverParaRun(env.wsBase.path, "solo", "executor-padrao").catch((e) => e);
    expect(err).toBeInstanceOf(SubcorpError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain("read");

    await env.subcorps.adicionar(env.wsBase.path, { fonte: wsFilho.path, id: "parcial", perm: "ask" });
    const err2 = await env.subcorps.resolverParaRun(env.wsBase.path, "parcial", "nao-exposto").catch((e) => e);
    expect(err2.exitCode).toBe(3);
    const ok = await env.subcorps.resolverParaRun(env.wsBase.path, "parcial", "secretario");
    expect(ok.agenteId).toBe("secretario");
  });
});
