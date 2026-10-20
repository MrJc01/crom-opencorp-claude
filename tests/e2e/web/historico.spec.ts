import { test, expect } from "@playwright/test";
import { chmod, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { SessionManager } from "../../../src/core/contexts/execution/session-manager.js";
import { T, esperarServidorPronto, comRetryTransporte } from "../helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

// F2-T02 — histórico agrupado: flow com N nós vira 1 pai + N filhas (sem duplicata).
const TOKEN = "test-e2e";
const E2E_HOME = "/tmp/opencorp-e2e";
const WS = "e2e-hist-agrupado";
const AGENTE = "agente-hist-agrupado";
const FAKE_BIN = join(E2E_HOME, ".opencorp", "bin", "opencode");

async function garantirBase(client: ReturnType<typeof api>): Promise<void> {
  await esperarServidorPronto(client);
  await comRetryTransporte(() => client.post("/workspaces", { headers: HDR, data: { id: WS } }));
  await comRetryTransporte(() => client
    .post(`/agents?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: AGENTE,
        name: "Agente Hist Agrupado E2E",
        role: "Executor E2E",
        category: "operario",
        model: "openrouter/auto",
        tools: ["bash"],
        permissions: "level-1",
        budget: { daily_usd: 10, max_turns: 10 },
        prompt: "Você é um agente de teste e2e.",
      },
    }));
}

async function instalarFakeRunner(): Promise<void> {
  await mkdir(dirname(FAKE_BIN), { recursive: true });
  await writeFile(FAKE_BIN, '#!/bin/sh\necho "fake-opencode: execucao concluida"\nexit 0\n', "utf8");
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

async function esperarFlowConcluir(page: import("@playwright/test").Page, flowId: string, timeoutMs = 30_000): Promise<{ status: string }> {
  const ini = Date.now();
  for (;;) {
    const r = await api(page).get(`/flows/${encodeURIComponent(flowId)}/status?workspace=${WS}`, { headers: HDR });
    expect(r.status()).toBe(200);
    const j = await r.json();
    if (j && j.status && j.status !== "executando") return j;
    if (Date.now() - ini > timeoutMs) throw new Error(`timeout aguardando fluxo ${flowId} concluir`);
    await new Promise((r2) => setTimeout(r2, 600));
  }
}

function noManual(id: string) {
  return { id, tipo: "manual", config: {} };
}

function noAgente(id: string, ordem: string) {
  return { id, tipo: "agente", config: { agente: AGENTE, ordem } };
}

test.describe("Web Histórico: filtros, modal e ações", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/historico");
    await esperarElementoTexto(page, "Identificador / Ordem");
  });

  test("filtros de tipo filtram sem erro", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    for (const tab of ["Agentes", "Fluxos DAG", "Kanban", "Rotinas", "Secretário"]) {
      const botao = page.getByRole("button", { name: tab, exact: true });
      await botao.click();
      await expect(botao).toHaveAttribute("aria-pressed", "true");
    }
    await page.getByRole("button", { name: "Todos", exact: true }).click();
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("status e agente filtram a lista", async ({ page }) => {
    const selects = page.locator("main select");
    await expect(selects.first()).toBeVisible();
    await selects.first().selectOption("sucesso");
    await expect(selects.first()).toHaveValue("sucesso");
    await selects.first().selectOption("todos");
  });

  test("pausar tempo-real interrompe o polling", async ({ page }) => {
    const botao = page.getByTestId("historico-tempo-real");
    await expect(botao).toBeVisible();
    const antes = await botao.getAttribute("aria-pressed");
    await botao.click();
    await expect(botao).not.toHaveAttribute("aria-pressed", antes ?? "");
    await botao.click();
    await expect(botao).toHaveAttribute("aria-pressed", antes ?? "");
  });

  test("painel de task abre e fecha sem erro", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    const linha = page.locator("tr[data-tipo='task']").first();
    await expect(linha).toBeVisible({ timeout: T(15000) });
    await linha.click();
    await page.waitForTimeout(800);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("modal de execução: alterna abas e reenvia", async ({ page }) => {
    const execId = `exec-rt-${Date.now().toString(36)}`;
    await api(page).post("/registries/execucoes", {
      headers: HDR,
      data: { id: execId, descricao: "Ordem: listing e2e" },
    });
    await api(page).put(`/registries/execucoes/${execId}`, {
      headers: HDR,
      data: { extras: { status: "concluido", ordem: "listing e2e", agente: "executor-padrao" } },
    });
    // O modal lê o registro direto (/registries/execucoes/:id); a lista
    // (/historico) só exibe sessões reais (tag "sessao") — abre via ?run=
    await page.goto(`/historico?run=${encodeURIComponent(execId)}`);
    await expect(page.getByRole("heading", { name: execId })).toBeVisible({ timeout: T(15000) });

    for (const aba of ["Telemetria", "Terminal", "Diff / Git"]) {
      await page.getByRole("button", { name: new RegExp(aba) }).click();
      await page.waitForTimeout(400);
    }
    await page.keyboard.press("Escape");
  });
});

test.describe("Web Histórico: agrupamento de fluxo (F2-T02)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WS);
    await garantirBase(api(page));
    await instalarFakeRunner();
  });

  test.afterEach(async () => {
    await removerFakeRunner();
  });

  test("fluxo com 2 nós vira 1 pai + 2 filhas, sem duplicata na lista plana", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const flowId = `flux-hist-agrup-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: flowId,
        nome: "Fluxo agrupado e2e",
        nos: [
          noManual("inicio"),
          noAgente("no-a1", "etapa um: {{entrada}}"),
          noAgente("no-b2", "etapa dois: {{entrada}}"),
        ],
        arestas: [
          { de: "inicio", para: "no-a1" },
          { de: "no-a1", para: "no-b2" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(flowId)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "contexto agrupado e2e" },
    });
    expect(resRun.status()).toBe(202);
    const execId = (await resRun.json()).exec_id as string;

    const fim = await esperarFlowConcluir(page, flowId);
    expect(fim.status).toBe("concluido");

    // API: 1 pai (fluxo) com 2 filhas; nenhuma delas repete como exec plana.
    const itens = (await (await api(page).get(`/historico?limite=200&workspace=${WS}`, { headers: HDR })).json()) as Array<any>;
    const pai = itens.find((i) => i.id === execId && i.tipo === "fluxo");
    expect(pai).toBeTruthy();
    expect(pai.filhas).toBeTruthy();
    expect(pai.filhas.length).toBe(2);
    const idsFilhas = pai.filhas.map((f: any) => f.id);
    for (const fid of idsFilhas) {
      expect(itens.some((i) => i.id === fid && i.tipo === "execucao")).toBe(false);
    }
    // ordenadas por nó (no-a1 antes de no-b2)
    expect(pai.filhas.map((f: any) => f.no)).toEqual(["no-a1", "no-b2"]);

    // UI: o grupo expande e mostra as filhas (status por filho).
    await page.goto("/historico");
    await esperarElementoTexto(page, "Identificador / Ordem");
    // UI: a linha do fluxo abre o painel na aba "Grafo DAG" com um item por nó.
    const linhaFluxo = page.getByTestId(`historico-item-${execId}`);
    await expect(linhaFluxo).toHaveAttribute("data-tipo", "fluxo", { timeout: T(15000) });
    await linhaFluxo.click();
    await expect(page.getByText("no-a1").first()).toBeVisible({ timeout: T(10000) });
    await expect(page.getByText("no-b2").first()).toBeVisible({ timeout: T(10000) });
  });
});
