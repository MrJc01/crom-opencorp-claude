import { test, expect } from "@playwright/test";
import { execa } from "execa";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";

// F3-T02 — prompts.json: CLI-level. Cria ws, set chave, e verifica que o corpo de
// um agente com {{prompt:chave}} resolve no system prompt sincronizado.

const E2E_HOME = "/dev/shm/opencorp-e2e";
const SUFIXO = Date.now().toString(36);
const WS = `e2e-prompts-${SUFIXO}`;
const CHAVE = `saudacao-${SUFIXO}`;
const AGENTE = `agente-prompt-${SUFIXO}`;

const env = { ...process.env, OPENCORP_HOME: E2E_HOME };

function oc(args: string[]): ReturnType<typeof execa> {
  return execa("node", ["bin/opencorp.mjs", "-t", WS, ...args], { env });
}

function wsPath(): string {
  return join(E2E_HOME, ".opencorp", "workspaces", WS);
}

function syncedAgentMd(): string {
  return readFileSync(join(wsPath(), ".opencorp", "opencode", "agent", `${AGENTE}.md`), "utf8");
}

test.describe("Prompts — set/listar/mostrar + {{prompt:chave}} no agente (F3-T02)", () => {
  test.beforeAll(async () => {
    await execa("node", ["bin/opencorp.mjs", "workspace", "create", WS], { env });
  });

  test.afterAll(async () => {
    await rm(wsPath(), { recursive: true, force: true }).catch(() => undefined);
  });

  test("set → listar → mostrar → remover (CLI)", async () => {
    const set = await oc(["prompt", "set", CHAVE, "Seja objetivo e direto."]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain(`prompt "${CHAVE}" salvo`);

    const listar = await oc(["prompt", "listar", "--json"]);
    const lista = JSON.parse(listar.stdout) as Array<{ chave: string; texto: string }>;
    expect(lista.some((p) => p.chave === CHAVE && p.texto === "Seja objetivo e direto.")).toBe(true);

    const mostrar = await oc(["prompt", "mostrar", CHAVE]);
    expect(mostrar.exitCode).toBe(0);
    expect(mostrar.stdout.trim()).toBe("Seja objetivo e direto.");

    const remover = await oc(["prompt", "remover", CHAVE]);
    expect(remover.exitCode).toBe(0);

    const ausente = await oc(["prompt", "mostrar", CHAVE]).catch((e) => e);
    expect(ausente.exitCode).not.toBe(0);
    expect(ausente.stderr).toContain("não encontrado");
  });

  test("corpo de agente com {{prompt:chave}} resolve ao sincronizar", async () => {
    await oc(["prompt", "set", CHAVE, "Respeite o tom de voz da empresa."]);

    // Escreve o agente diretamente e sincroniza (agent create clona template).
    mkdirSync(join(wsPath(), ".opencorp", "agents"), { recursive: true });
    const agenteMd = `---
id: ${AGENTE}
role: Teste
category: custom
model: opencode-go/glm-5.3-flash
tools: [read, write, edit, bash]
permissions: level-2
budget:
  daily_usd: 1.00
  max_turns: 10
memory:
  reads: []
  writes: []
---

Você é um agente de teste.

Diretriz: {{prompt:${CHAVE}}}
`;
    writeFileSync(join(wsPath(), ".opencorp", "agents", `${AGENTE}.md`), agenteMd);

    const sync = await oc(["agent", "sync"]);
    expect(sync.exitCode).toBe(0);

    const bruto = syncedAgentMd();
    expect(bruto).toContain("Respeite o tom de voz da empresa.");
    expect(bruto).not.toContain(`{{prompt:${CHAVE}}}`);
  });

  test("chave inexistente referenciada no agente → erro legível no sync", async () => {
    const agenteFalho = `agente-prompt-falho-${SUFIXO}`;
    mkdirSync(join(wsPath(), ".opencorp", "agents"), { recursive: true });
    const agenteMd = `---
id: ${agenteFalho}
role: Teste
category: custom
model: opencode-go/glm-5.3-flash
tools: [read]
permissions: level-1
budget:
  daily_usd: 1.00
  max_turns: 10
memory:
  reads: []
  writes: []
---

Corpo com {{prompt:chave-que-nao-existe-${SUFIXO}}}
`;
    writeFileSync(join(wsPath(), ".opencorp", "agents", `${agenteFalho}.md`), agenteMd);

    const sync = await oc(["agent", "sync"]).catch((e) => e);
    expect(sync.exitCode).not.toBe(0);
    expect(sync.stderr).toContain("não encontrado");
  });
});
