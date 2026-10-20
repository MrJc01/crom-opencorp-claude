import { test, expect } from "@playwright/test";
import { execa } from "execa";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// F4-T01 — Skills: instalação, declaração em agentes e injeção no system prompt.
// CLI-level: roda `node bin/opencorp.mjs` com OPENCORP_HOME de e2e, nunca contra
// a produção :4100.

const E2E_HOME = "/dev/shm/opencorp-e2e";
const WS = "e2e-corp";
const WS_PATH = join(E2E_HOME, ".opencorp", "workspaces", WS);
const SUFIXO = Date.now().toString(36);
const SKILL_A = `auditoria-seo-${SUFIXO}`;
const SKILL_B = `redacao-tecnica-${SUFIXO}`;
const SKILL_C = `revisao-codigo-${SUFIXO}`;
const AGENTE = `agente-skill-${SUFIXO}`;

const env = { ...process.env, OPENCORP_HOME: E2E_HOME };

const tempDirs: string[] = [];

function oc(args: string[]): ReturnType<typeof execa> {
  return execa("node", ["bin/opencorp.mjs", "-t", WS, ...args], { env });
}

async function criarSkillSrc(name: string, description: string, corpo: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-skill-e2e-"));
  tempDirs.push(dir);
  const skillMd = `---\nname: ${name}\ndescription: ${description}\nallowed-tools: [bash, read]\n---\n\n${corpo}`;
  await writeFile(join(dir, "SKILL.md"), skillMd, "utf8");
  await writeFile(join(dir, "skill.json"), JSON.stringify({ versao: "1.0.0" }), "utf8");
  return dir;
}

function syncedAgentMd(): string {
  return readFileSync(join(WS_PATH, ".opencorp", "opencode", "agent", `${AGENTE}.md`), "utf8");
}

test.describe("Skills — instalar, declarar e injetar (F4-T01)", () => {
  test.beforeAll(async () => {
    await oc(["agent", "create", AGENTE]);
  });

  test.afterAll(async () => {
    await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
    for (const s of [SKILL_A, SKILL_B, SKILL_C]) {
      await oc(["skill", "remover", s]).catch(() => undefined);
    }
  });

  test("instala skill → agent skills --add → frontmatter e system prompt refletem", async () => {
    const src = await criarSkillSrc(SKILL_A, "Audita SEO de páginas", "## Passos\n\n1. Analise o título.");

    const instalar = await oc(["skill", "instalar", src]);
    expect(instalar.exitCode).toBe(0);
    expect(instalar.stdout).toContain(`skill "${SKILL_A}" instalada`);

    const listar = await oc(["skill", "listar", "--json"]);
    const lista = JSON.parse(listar.stdout);
    expect(lista.some((s: { name: string }) => s.name === SKILL_A)).toBe(true);

    const add = await oc(["agent", "skills", AGENTE, "--add", SKILL_A, "--json"]);
    expect(add.exitCode).toBe(0);
    expect(JSON.parse(add.stdout).skills).toContain(SKILL_A);

    const show = await oc(["agent", "show", AGENTE, "--json"]);
    const detalhe = JSON.parse(show.stdout);
    expect(detalhe.skills).toContain(SKILL_A);

    const bruto = syncedAgentMd();
    expect(bruto).toContain("## Skills (1)");
    expect(bruto).toContain(`### ${SKILL_A}: Audita SEO de páginas`);
    expect(bruto).toContain("1. Analise o título.");
  });

  test("skill não instalada → erro legível; multi-add/remove/--set funcionam", async () => {
    const srcB = await criarSkillSrc(SKILL_B, "Redige textos técnicos", "Corpo B.");
    const srcC = await criarSkillSrc(SKILL_C, "Revisa código", "Corpo C.");
    await oc(["skill", "instalar", srcB]);
    await oc(["skill", "instalar", srcC]);

    // limpa estado herdado do teste anterior para isolar o multi-add
    await oc(["agent", "skills", AGENTE, "--set", ""]);

    // skill declarada mas não instalada → erro legível (exit != 0)
    const ausente = await oc(["agent", "skills", AGENTE, "--add", "nao-instalada"]).catch((e) => e);
    expect(ausente.exitCode).not.toBe(0);
    expect(ausente.stderr).toContain("não instalada");

    // multi-add
    const add = await oc(["agent", "skills", AGENTE, "--add", `${SKILL_B},${SKILL_C}`, "--json"]);
    expect(add.exitCode).toBe(0);
    expect(JSON.parse(add.stdout).skills).toEqual([SKILL_B, SKILL_C]);

    // remove
    const remove = await oc(["agent", "skills", AGENTE, "--remove", SKILL_C, "--json"]);
    expect(remove.exitCode).toBe(0);
    expect(JSON.parse(remove.stdout).skills).toEqual([SKILL_B]);

    // set (lista exata)
    const set = await oc(["agent", "skills", AGENTE, "--set", SKILL_C, "--json"]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout).skills).toEqual([SKILL_C]);

    // skill removida do agente some do system prompt sincronizado
    const bruto = syncedAgentMd();
    expect(bruto).toContain(`### ${SKILL_C}: Revisa código`);
    expect(bruto).not.toContain(`### ${SKILL_B}:`);
  });

  test("agente sem skills não é alterado (default [])", async () => {
    const show = await oc(["agent", "show", "executor-padrao", "--json"]);
    const detalhe = JSON.parse(show.stdout);
    expect(detalhe.skills ?? []).toEqual([]);

    const sync = await oc(["agent", "sync"]);
    expect(sync.exitCode).toBe(0);
    const bruto = readFileSync(join(WS_PATH, ".opencorp", "opencode", "agent", "executor-padrao.md"), "utf8");
    expect(bruto).not.toContain("## Skills");
  });
});
