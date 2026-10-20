import { test, expect } from "@playwright/test";
import { chmod, mkdir, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logado, api } from "../helpers.js";
import { SessionManager } from "../../../src/core/contexts/execution/session-manager.js";

// F10-T01 — Join/barreira de múltiplas entradas. Fluxo manual → fanout (2 ramos
// agente) → nó final com 2 entradas. Sem `join`, o nó final executa UMA vez com
// contexto concatenado dos 2 ramos; com `join: "any"`, executa a cada entrada.
// Roda contra o servidor de teste do playwright (:4399), nunca produção :4100.

const TOKEN = "test-e2e";
const E2E_HOME = "/dev/shm/opencorp-e2e";
const WS = "e2e-flux-join";
const AGENTE = "agente-flux-join";
const HDR = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const FAKE_BIN = join(E2E_HOME, ".opencorp", "bin", "opencode");

async function garantirBase(client: ReturnType<typeof api>): Promise<void> {
  await client
    .post("/workspaces", { headers: HDR, data: { id: WS } })
    .catch(() => undefined);
  await client
    .post(`/agents?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: AGENTE,
        name: "Agente Flux Join E2E",
        role: "Executor E2E",
        category: "operario",
        model: "openrouter/auto",
        tools: ["bash"],
        permissions: "level-1",
        budget: { daily_usd: 10, max_turns: 10 },
        prompt: "Você é um agente de teste e2e.",
      },
    })
    .catch(() => undefined);
}

async function instalarFakeRunner(): Promise<void> {
  await mkdir(dirname(FAKE_BIN), { recursive: true });
  // O runner ecoa o último argumento (o prompt/ordem) — assim cada ramo agente
  // produz uma saída distinta e determinística para o join. O `sleep` evita que
  // o processo termine antes de o session-manager anexar a leitura do stdout.
  await writeFile(
    FAKE_BIN,
    '#!/bin/sh\nsleep 0.5\nlast=""\nfor arg do last="$arg"; done\nprintf \'RAMO: %s\\n\' "$last"\nexit 0\n',
    "utf8",
  );
  await chmod(FAKE_BIN, 0o755);
}

async function removerFakeRunner(): Promise<void> {
  await rm(FAKE_BIN, { force: true }).catch(() => undefined);
}

async function forcarDriverHost(wsPath: string): Promise<void> {
  const cfgPath = join(wsPath, ".opencorp", "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* usa objeto vazio */
  }
  cfg.execution_driver = "host";
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
}

function noManual(id: string) {
  return { id, tipo: "manual", config: {} };
}

function noAgente(id: string, ordem: string) {
  return { id, tipo: "agente", config: { agente: AGENTE, ordem } };
}

function noScript(id: string, comando: string, joinMode?: "all" | "any") {
  return { id, tipo: "script", config: { comando }, ...(joinMode ? { join: joinMode } : {}) };
}

async function esperarFlowConcluir(
  page: import("@playwright/test").Page,
  flowId: string,
  timeoutMs = 30_000,
): Promise<{ execId: string; status: string; contextoFinal: string }> {
  const ini = Date.now();
  for (;;) {
    const r = await api(page).get(`/flows/${encodeURIComponent(flowId)}/status?workspace=${WS}`, {
      headers: HDR,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    if (j && j.execId && j.status && j.status !== "executando") {
      return { execId: j.execId, status: j.status, contextoFinal: j.contextoFinal ?? "" };
    }
    if (Date.now() - ini > timeoutMs) throw new Error(`timeout aguardando fluxo ${flowId} concluir`);
    await new Promise((r2) => setTimeout(r2, 600));
  }
}

test.describe("Fluxo — join de múltiplas entradas (F10-T01)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WS);
    await garantirBase(api(page));
    await instalarFakeRunner();
  });

  test.afterEach(async () => {
    await removerFakeRunner();
  });

  test("(a) sem join (default all): nó final executa 1x com contexto concatenado", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const contador = `join-count-${Date.now().toString(36)}.txt`;
    const fluxo = `flux-join-all-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: fluxo,
        nome: "Fluxo join default all",
        nos: [
          noManual("inicio"),
          noAgente("rama", "BRANCH-ALFA {{entrada}}"),
          noAgente("ramb", "BRANCH-BETA {{entrada}}"),
          noScript("fim", `printf '%s' "$OPENCORP_ENTRADA" ; printf 'X' >> ${contador}`),
        ],
        arestas: [
          { de: "inicio", para: "rama" },
          { de: "inicio", para: "ramb" },
          { de: "rama", para: "fim" },
          { de: "ramb", para: "fim" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(fluxo)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "entrada-e2e" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, fluxo);
    expect(fim.status).toBe("concluido");
    expect(fim.contextoFinal).toContain("BRANCH-ALFA");
    expect(fim.contextoFinal).toContain("BRANCH-BETA");

    const marcas = await readFile(join(ws.path, contador), "utf8");
    expect(marcas.length).toBe(1);
    await unlink(join(ws.path, contador)).catch(() => undefined);
  });

  test("(b) join: any preserva legado — nó final executa a cada entrada", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const contador = `join-count-${Date.now().toString(36)}.txt`;
    const fluxo = `flux-join-any-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: fluxo,
        nome: "Fluxo join any",
        nos: [
          noManual("inicio"),
          noAgente("rama", "BRANCH-ALFA {{entrada}}"),
          noAgente("ramb", "BRANCH-BETA {{entrada}}"),
          noScript("fim", `printf '%s' "$OPENCORP_ENTRADA" ; printf 'X' >> ${contador}`, "any"),
        ],
        arestas: [
          { de: "inicio", para: "rama" },
          { de: "inicio", para: "ramb" },
          { de: "rama", para: "fim" },
          { de: "ramb", para: "fim" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(fluxo)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "entrada-e2e" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, fluxo);
    expect(fim.status).toBe("concluido");

    const marcas = await readFile(join(ws.path, contador), "utf8");
    expect(marcas.length).toBe(2);
    await unlink(join(ws.path, contador)).catch(() => undefined);
  });
});
