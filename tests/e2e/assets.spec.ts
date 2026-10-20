import { test, expect } from "@playwright/test";
import { execa } from "execa";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// F4-T02 — Loja de assets: exportar/importar .corp com manifest asset.json,
// denylist de segredos, --dry-run, --como e --sobrescrever. CLI-level: roda
// `node bin/opencorp.mjs` com OPENCORP_HOME de e2e, nunca contra produção :4100.

const E2E_HOME = "/dev/shm/opencorp-e2e";
const WS = "e2e-corp";
const WS_PATH = join(E2E_HOME, ".opencorp", "workspaces", WS);
const SUFIXO = Date.now().toString(36);

const env = { ...process.env, OPENCORP_HOME: E2E_HOME };
const tempDirs: string[] = [];

function run(args: string[]): ReturnType<typeof execa> {
  return execa("node", ["bin/opencorp.mjs", ...args], { env });
}

function oc(target: string, args: string[]): ReturnType<typeof execa> {
  return execa("node", ["bin/opencorp.mjs", "-t", target, ...args], { env });
}

function hashDe(arquivo: string): string {
  return createHash("sha256").update(readFileSync(arquivo)).digest("hex");
}

async function dirTemp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

async function criarWs(id: string): Promise<string> {
  const r = await run(["workspace", "create", id]);
  expect(r.exitCode).toBe(0);
  return join(E2E_HOME, ".opencorp", "workspaces", id);
}

async function criarAgente(id: string): Promise<void> {
  const r = await oc(WS, ["agent", "create", id]);
  expect(r.exitCode).toBe(0);
}

async function escreverSkill(nome: string, corpo = "Corpo da skill."): Promise<void> {
  const dir = join(WS_PATH, ".opencorp", "skills", nome);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${nome}\ndescription: Skill ${nome}\n---\n\n${corpo}`,
    "utf8",
  );
  await writeFile(join(dir, "skill.json"), JSON.stringify({ versao: "1.0.0" }), "utf8");
}

async function escreverFlow(id: string, comando = "echo smoke-ok"): Promise<void> {
  const dir = join(WS_PATH, ".opencorp", "flows");
  await mkdir(dir, { recursive: true });
  const flow = {
    id,
    nome: `Flow ${id}`,
    nos: [
      { id: "gatilho", tipo: "manual", config: {} },
      { id: "passo", tipo: "script", config: { comando } },
    ],
    arestas: [{ de: "gatilho", para: "passo" }],
  };
  await writeFile(join(dir, `${id}.json`), `${JSON.stringify(flow, null, 2)}\n`, "utf8");
}

async function listarCorp(arquivo: string): Promise<string[]> {
  const r = await execa("tar", ["-tzf", arquivo]);
  return r.stdout.split("\n").filter(Boolean);
}

test.describe("Assets — exportar/importar .corp (F4-T02)", () => {
  test.afterAll(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
  });

  test("agente: exportar → importar em ws limpo → hash do payload idêntico", async () => {
    const id = `agente-asset-${SUFIXO}`;
    const saida = await dirTemp("opencorp-asset-e2e-");
    await criarAgente(id);

    const exp = await oc(WS, ["asset", "exportar", "--tipo", "agente", "--somente", id, "-o", join(saida, "agente.corp")]);
    expect(exp.exitCode).toBe(0);

    const wsLimpo = await criarWs(`ws-agente-${SUFIXO}`);
    const imp = await oc(`ws-agente-${SUFIXO}`, ["asset", "importar", join(saida, "agente.corp")]);
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout).toContain(`agente "${id}" criado`);

    const origem = join(WS_PATH, ".opencorp", "agents", `${id}.md`);
    const destino = join(wsLimpo, ".opencorp", "agents", `${id}.md`);
    expect(existsSync(destino)).toBe(true);
    expect(hashDe(destino)).toBe(hashDe(origem));
  });

  test("skill: exportar → importar em ws limpo → hash do payload idêntico", async () => {
    const nome = `skill-asset-${SUFIXO}`;
    const saida = await dirTemp("opencorp-asset-e2e-");
    await escreverSkill(nome, "Passos da skill: 1) analise.");

    const exp = await oc(WS, ["asset", "exportar", "--tipo", "skill", "--somente", nome, "-o", join(saida, "skill.corp")]);
    expect(exp.exitCode).toBe(0);

    const wsLimpo = await criarWs(`ws-skill-${SUFIXO}`);
    const imp = await oc(`ws-skill-${SUFIXO}`, ["asset", "importar", join(saida, "skill.corp")]);
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout).toContain(`skill "${nome}" criado`);

    const origem = join(WS_PATH, ".opencorp", "skills", nome, "SKILL.md");
    const destino = join(wsLimpo, ".opencorp", "skills", nome, "SKILL.md");
    expect(existsSync(destino)).toBe(true);
    expect(hashDe(destino)).toBe(hashDe(origem));
  });

  test("flow: exportar → importar em ws limpo → roda 1 nó smoke", async () => {
    const id = `flow-asset-${SUFIXO}`;
    const saida = await dirTemp("opencorp-asset-e2e-");
    await escreverFlow(id);

    const exp = await oc(WS, ["asset", "exportar", "--tipo", "flow", "--somente", id, "-o", join(saida, "flow.corp")]);
    expect(exp.exitCode).toBe(0);

    const wsLimpo = await criarWs(`ws-flow-${SUFIXO}`);
    const imp = await oc(`ws-flow-${SUFIXO}`, ["asset", "importar", join(saida, "flow.corp")]);
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout).toContain(`flow "${id}" criado`);

    const run = await oc(`ws-flow-${SUFIXO}`, ["flow", "run", id]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("concluido");
  });

  test("pack com agente+skill importa os dois", async () => {
    const agente = `agente-pack-${SUFIXO}`;
    const skill = `skill-pack-${SUFIXO}`;
    const saida = await dirTemp("opencorp-asset-e2e-");
    await criarAgente(agente);
    await escreverSkill(skill);

    const exp = await oc(WS, [
      "asset", "exportar", "--tipo", "pack",
      "--somente", `agente:${agente},skill:${skill}`,
      "-o", join(saida, "pack.corp"),
    ]);
    expect(exp.exitCode).toBe(0);

    const wsLimpo = await criarWs(`ws-pack-${SUFIXO}`);
    const imp = await oc(`ws-pack-${SUFIXO}`, ["asset", "importar", join(saida, "pack.corp")]);
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout).toContain(`agente "${agente}" criado`);
    expect(imp.stdout).toContain(`skill "${skill}" criado`);

    expect(existsSync(join(wsLimpo, ".opencorp", "agents", `${agente}.md`))).toBe(true);
    expect(existsSync(join(wsLimpo, ".opencorp", "skills", skill, "SKILL.md"))).toBe(true);
  });

  test("workspace-parcial --somente tasks traz só tasks", async () => {
    const saida = await dirTemp("opencorp-asset-e2e-");
    const marcador = `task-asset-${SUFIXO}`;
    const criar = await oc(WS, ["task", "create", "--titulo", marcador]);
    expect(criar.exitCode).toBe(0);

    // garante que o workspace tem um agente/skill extras que NÃO devem entrar
    await criarAgente(`agente-extra-${SUFIXO}`);
    await escreverSkill(`skill-extra-${SUFIXO}`);

    const exp = await oc(WS, [
      "asset", "exportar", "--tipo", "workspace-parcial", "--somente", "tasks",
      "-o", join(saida, "parcial.corp"),
    ]);
    expect(exp.exitCode).toBe(0);

    const membros = await listarCorp(join(saida, "parcial.corp"));
    expect(membros.some((m) => m.includes("tasks.json"))).toBe(true);
    expect(membros.some((m) => m.startsWith("agents/"))).toBe(false);
    expect(membros.some((m) => m.startsWith("skills/"))).toBe(false);
    expect(membros.some((m) => m.startsWith("flows/"))).toBe(false);

    const wsLimpo = await criarWs(`ws-parcial-${SUFIXO}`);
    const imp = await oc(`ws-parcial-${SUFIXO}`, ["asset", "importar", join(saida, "parcial.corp")]);
    expect(imp.exitCode).toBe(0);
    expect(imp.stdout).toContain('task "tasks" criado');

    const listar = await oc(`ws-parcial-${SUFIXO}`, ["task", "list", "--json"]);
    const tasks = JSON.parse(listar.stdout);
    expect(tasks.some((t: { titulo: string }) => t.titulo === marcador)).toBe(true);
    expect(existsSync(join(wsLimpo, ".opencorp", "agents", `agente-extra-${SUFIXO}.md`))).toBe(false);
    expect(existsSync(join(wsLimpo, ".opencorp", "skills", `skill-extra-${SUFIXO}`))).toBe(false);
  });

  test("exportar nunca inclui segredo (denylist)", async () => {
    const nome = `skill-segredo-${SUFIXO}`;
    const saida = await dirTemp("opencorp-asset-e2e-");
    await escreverSkill(nome, "Skill com segredos para testar a denylist.");

    // segredos dentro da pasta da skill (único lugar onde arquivos arbitrários são copiados)
    const skillDir = join(WS_PATH, ".opencorp", "skills", nome);
    await writeFile(join(skillDir, ".env"), "TOKEN_SECRETO=abc123\n", "utf8");
    await mkdir(join(skillDir, "secrets"), { recursive: true });
    await writeFile(join(skillDir, "secrets", "credencial.pem"), "PRIVATE KEY\n", "utf8");

    const exp = await oc(WS, ["asset", "exportar", "--tipo", "skill", "--somente", nome, "-o", join(saida, "skill.corp")]);
    expect(exp.exitCode).toBe(0);
    expect(exp.stdout).toContain("excluído(s) por padrão de segredo");

    const membros = await listarCorp(join(saida, "skill.corp"));
    expect(membros.some((m) => m.includes(".env"))).toBe(false);
    expect(membros.some((m) => m.includes("secrets/"))).toBe(false);
    expect(membros.some((m) => m.includes(".pem"))).toBe(false);
    expect(membros.some((m) => m.includes("SKILL.md"))).toBe(true);
  });
});
