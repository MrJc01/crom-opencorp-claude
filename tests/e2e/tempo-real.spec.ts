import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

async function criarFlowDelay(page: import("@playwright/test").Page, fid: string, segundos: number) {
  await api(page).post("/flows", {
    headers: HDR,
    data: {
      id: fid,
      nome: `Delay ${fid}`,
      nos: [
        { id: "inicio", tipo: "manual", config: {} },
        { id: "espera", tipo: "delay", config: { segundos } },
        { id: "fim", tipo: "registro", config: { categoria: "documentos" } },
      ],
      arestas: [{ de: "inicio", para: "espera" }, { de: "espera", para: "fim" }],
    },
  });
}

async function esperarStatus(page: import("@playwright/test").Page, fid: string, execId: string, fim: string, timeoutMs = 60000) {
  const ini = Date.now();
  for (;;) {
    const r = await api(page).get(`/flows/${fid}/execucoes`, { headers: HDR });
    const atual = ((await r.json()) as any[]).find((e: any) => e.execId === execId);
    if (atual && atual.status === fim) return atual;
    if (Date.now() - ini > timeoutMs) throw new Error(`timeout esperando ${fim} em ${execId}`);
    await new Promise((r2) => setTimeout(r2, 1000));
  }
}

test.describe("Tempo real: execução ao vivo no web", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("fluxo executando aparece no Histórico, no hover do Topbar e na Home", async ({ page }) => {
    const fid = `flow-rt-${Date.now().toString(36)}`;
    await criarFlowDelay(page, fid, 25);
    const run = await api(page).post(`/flows/${fid}/run`, { headers: HDR, data: { entrada: "tempo-real" } });
    expect(run.status()).toBe(202);
    const execId = (await run.json()).exec_id as string;

    // Topbar hover primeiro (antes de abrir qualquer modal): card informa a execução
    await page.goto("/");
    const badge = page.getByRole("link", { name: /stream|offline/ }).first();
    await expect(badge).toBeVisible({ timeout: 15000 });
    await badge.hover();
    await esperarElementoTexto(page, "Execução em Tempo Real");
    await esperarElementoTexto(page, "Executando Agora");

    // Home geral: card Executando Agora identifica o FLUXO com link de log
    await expect(page.getByText("FLUXO", { exact: true }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Acompanhar Log →").first()).toBeVisible({ timeout: 10000 });

    // Histórico: badge FLUXO + status executando + nó em execução
    await page.goto(`/historico?run=${execId}`);
    await esperarElementoTexto(page, "Identificador / Ordem");
    await expect(page.getByText("FLUXO", { exact: true }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("executando", { exact: true }).first()).toBeVisible({ timeout: 15000 });

    // Home aba Fluxos: última execução em andamento
    await page.goto("/?aba=fluxos");
    await esperarElementoTexto(page, "Últimas execuções");
    await expect(page.getByText(execId).first()).toBeVisible({ timeout: 15000 });

    // Finaliza sozinho e o status vira concluído
    const fim = await esperarStatus(page, fid, execId, "concluido", 90000);
    expect(fim.nos.every((n: any) => n.status === "ok")).toBe(true);

    // Aba Resultado do fluxo mostra Entrada + Resultado (visão de circuito, sem chat)
    await page.goto(`/historico?run=${execId}`);
    await esperarElementoTexto(page, "Identificador / Ordem");
    await page.getByRole("button", { name: /Resultado/ }).click();
    await expect(page.getByText("Resultado", { exact: false }).first()).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("Circuito", { exact: false }).first()).toBeVisible({ timeout: 10000 });
  });

  test("cancelar fluxo no meio marca cancelado e aparece no filtro", async ({ page }) => {
    const fid = `flow-cancel-${Date.now().toString(36)}`;
    await criarFlowDelay(page, fid, 8);
    const run = await api(page).post(`/flows/${fid}/run`, { headers: HDR, data: {} });
    const execId = (await run.json()).exec_id as string;
    await new Promise((r) => setTimeout(r, 3000));

    const cancel = await api(page).post(`/execucoes/${execId}/cancelar`, { headers: HDR });
    expect(cancel.status()).toBe(200);

    await esperarStatus(page, fid, execId, "cancelado", 60000);

    await page.goto("/historico?tipo=fluxo");
    await esperarElementoTexto(page, "Identificador / Ordem");
    await page.locator("main select").first().selectOption("cancelado");
    await expect(page.getByText(execId).first()).toBeVisible({ timeout: 15000 });
  });

  test("retomar execução não-falha responde 422 (sem falso sucesso)", async ({ page }) => {
    const fid = `flow-resume-${Date.now().toString(36)}`;
    await criarFlowDelay(page, fid, 1);
    const run = await api(page).post(`/flows/${fid}/run`, { headers: HDR, data: {} });
    const execId = (await run.json()).exec_id as string;
    await esperarStatus(page, fid, execId, "concluido", 60000);

    const resume = await api(page).post(`/flows/${fid}/resume`, { headers: HDR, data: { exec_id: execId } });
    expect(resume.status()).toBe(422);

    const fantasma = await api(page).post(`/flows/${fid}/resume`, { headers: HDR, data: { exec_id: "exec-inexistente-xyz" } });
    expect([404, 422]).toContain(fantasma.status());
  });

  test("task criada via API aparece no kanban sem reload (polling)", async ({ page }) => {
    const titulo = `Task polling e2e ${Date.now()}`;
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    await api(page).post("/tasks", {
      headers: HDR,
      data: { titulo, descricao: "polling", coluna: "backlog", prioridade: "media" },
    });
    await expect(page.getByText(titulo).first()).toBeVisible({ timeout: 15000 });
  });

  test("lista de fluxos mostra badge da última execução", async ({ page }) => {
    const fid = `flow-badge-${Date.now().toString(36)}`;
    await criarFlowDelay(page, fid, 1);
    const run = await api(page).post(`/flows/${fid}/run`, { headers: HDR, data: {} });
    const execId = (await run.json()).exec_id as string;
    await esperarStatus(page, fid, execId, "concluido", 60000);

    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Fluxos");
    await page.locator('input[placeholder="Pesquisar fluxos..."]').fill(fid);
    await expect(page.getByText("concluido").first()).toBeVisible({ timeout: 15000 });
  });
});
