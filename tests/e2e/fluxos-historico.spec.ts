import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

const FLOW_BASE = "flow-hist-e2e";

function specFluxo(flowId: string) {
  return {
    id: flowId,
    nome: `Pipeline Hist E2E ${flowId}`,
    nos: [
      { id: "inicio", tipo: "manual", config: {} },
      { id: "gravar", tipo: "registro", config: { categoria: "documentos" } },
    ],
    arestas: [{ de: "inicio", para: "gravar" }],
  };
}

async function criarFlow(page: any, flowId: string) {
  const r = await api(page).post("/flows", {
    headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
    data: specFluxo(flowId),
  });
  expect([200, 201]).toContain(r.status());
}

async function rodarFlow(page: any, flowId: string, corpo: any = { entrada: "hello-hist" }) {
  const r = await api(page).post(`/flows/${flowId}/run`, {
    headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
    data: corpo,
  });
  expect(r.status()).toBe(202);
  const j = await r.json();
  expect(j.exec_id).toBeTruthy();
  return j.exec_id as string;
}

async function esperarStatus(page: any, flowId: string, execId: string, timeoutMs = 20000) {
  const ini = Date.now();
  for (;;) {
    const r = await api(page).get(`/flows/${flowId}/status`, {
      headers: { authorization: "Bearer test-e2e" },
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    if (j && j.execId === execId && j.status !== "executando") return j;
    if (Date.now() - ini > timeoutMs) throw new Error(`timeout esperando fluxo concluir (exec ${execId})`);
    await new Promise((r2) => setTimeout(r2, 750));
  }
}

test.describe("Fluxos no Histórico e Home (ABCD)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
  });

  test("A1. POST /flows/:id/run retorna exec_id rastreável", async ({ page }) => {
    const fid = `${FLOW_BASE}-a1`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid);
    expect(execId.startsWith("exec-")).toBe(true);
    await esperarStatus(page, fid, execId);
  });

  test("A2. GET /historico?tipo=fluxo lista a execução com nós e contexto", async ({ page }) => {
    const fid = `${FLOW_BASE}-a2`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid, { entrada: "entrada-hist-a2" });
    await esperarStatus(page, fid, execId);
    const r = await api(page).get("/historico?tipo=fluxo&limite=20", {
      headers: { authorization: "Bearer test-e2e" },
    });
    expect(r.status()).toBe(200);
    const itens = await r.json();
    const item = itens.find((i: any) => i.id === execId);
    expect(item).toBeTruthy();
    expect(item.tipo).toBe("fluxo");
    expect(item.flow).toBe(fid);
    expect(item.nos_total).toBe(2);
    expect(item.nos_ok).toBe(2);
  });

  test("A3. /historico geral inclui fluxos junto de tasks/execuções", async ({ page }) => {
    const fid = `${FLOW_BASE}-a3`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid);
    await esperarStatus(page, fid, execId);
    const r = await api(page).get("/historico?limite=200", {
      headers: { authorization: "Bearer test-e2e" },
    });
    const itens = await r.json();
    expect(itens.some((i: any) => i.id === execId && i.tipo === "fluxo")).toBe(true);
  });

  test("B1. GET /flows/:id/execucoes e /status expõem timeline por nó", async ({ page }) => {
    const fid = `${FLOW_BASE}-b1`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid, { entrada: "timeline-b1" });
    const st = await esperarStatus(page, fid, execId);
    expect(st.nos.map((n: any) => n.status)).toEqual(["ok", "ok"]);
    const r = await api(page).get(`/flows/${fid}/execucoes`, {
      headers: { authorization: "Bearer test-e2e" },
    });
    const lista = await r.json();
    const atual = lista.find((e: any) => e.execId === execId);
    expect(atual).toBeTruthy();
    expect(atual.entrada).toBe("timeline-b1");
    expect(atual.contextoFinal.length).toBeGreaterThan(0);
  });

  test("B2. UI do Histórico tem filtro Fluxos e abre a timeline do fluxo", async ({ page }) => {
    const fid = `${FLOW_BASE}-b2`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid, { entrada: "ui-b2" });
    await esperarStatus(page, fid, execId);
    await page.goto("/historico?tipo=fluxo");
    await esperarElementoTexto(page, "Identificador / Ordem");
    await esperarElementoTexto(page, "FLUXO");
    await page.locator(`text=${execId}`).first().waitFor({ state: "visible", timeout: T(15000) });
  });

  // A home não tem mais a aba Fluxos (ver pendências).
  test.fixme("C1. Home na aba Fluxos mostra Últimas execuções com status", async ({ page }) => {
    const fid = `${FLOW_BASE}-c1`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid, { entrada: "home-c1" });
    await esperarStatus(page, fid, execId);
    await page.goto("/?aba=fluxos");
    await esperarElementoTexto(page, "Últimas execuções");
    await page.locator(`text=${execId}`).first().waitFor({ state: "visible", timeout: T(15000) });
  });

  test("D1. gatilho cron enviado no run é preservado no histórico", async ({ page }) => {
    const fid = `${FLOW_BASE}-d1`;
    await criarFlow(page, fid);
    const execId = await rodarFlow(page, fid, { entrada: "via-cron", gatilho: "cron:sch-fluxo-e2e" });
    await esperarStatus(page, fid, execId);
    const r = await api(page).get("/historico?tipo=fluxo&limite=20", {
      headers: { authorization: "Bearer test-e2e" },
    });
    const itens = await r.json();
    const item = itens.find((i: any) => i.id === execId);
    expect(item?.gatilho).toEqual({ tipo: "cron", origem: "sch-fluxo-e2e" });
  });

  test("D2. resume sem exec_id retorna 422 (contrato de retomada)", async ({ page }) => {
    const fid = `${FLOW_BASE}-d2`;
    await criarFlow(page, fid);
    const r = await api(page).post(`/flows/${fid}/resume`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {},
    });
    expect(r.status()).toBe(422);
  });
});
