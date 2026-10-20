import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };
const ALVO = "ag-e2e-toggle";

async function garantirAgente(page: import("@playwright/test").Page, ativo: boolean): Promise<void> {
  await api(page).post("/agents", { headers: HDR, data: { id: ALVO } }).catch(() => undefined);
  const put = await api(page).put(`/agents/${ALVO}`, { headers: HDR, data: { ativo } });
  expect([200, 201]).toContain(put.status());
}

test.describe("Agentes — catálogo e toggle", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    const semear = await api(page).post("/agents/semear-catalogo", { headers: HDR });
    expect(semear.status()).toBe(200);
    await page.goto("/agentes");
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
  });

  test.afterEach(async ({ page }) => {
    await api(page).put(`/agents/${ALVO}`, { headers: HDR, data: { ativo: false } }).catch(() => undefined);
  });

  test("semear catálogo lista agente-vendas como Inativo", async ({ page }) => {
    const card = page.getByTestId("agent-card-agente-vendas");
    await expect(card).toBeVisible({ timeout: T(15000) });
    await expect(card).toHaveAttribute("data-ativo", "false");
    await expect(card.getByRole("button", { name: "Ativar agente" })).toBeVisible();
  });

  test("toggle desativa → persiste após recarregar", async ({ page }) => {
    await garantirAgente(page, true);
    await page.reload();
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
    const card = page.getByTestId(`agent-card-${ALVO}`);
    await expect(card).toBeVisible({ timeout: T(15000) });

    await card.getByRole("button", { name: "Desativar agente" }).click();
    await expect(card).toHaveAttribute("data-ativo", "false", { timeout: T(10000) });
    await page.reload();
    await expect(page.getByTestId(`agent-card-${ALVO}`)).toHaveAttribute("data-ativo", "false", { timeout: T(15000) });

    const get = await api(page).get(`/agents/${ALVO}`, { headers: HDR });
    const detalhe = await get.json();
    expect(detalhe.frontmatter?.ativo ?? detalhe.ativo).toBe(false);
  });

  test("toggle reativa → volta para Ativo", async ({ page }) => {
    await garantirAgente(page, false);
    await page.reload();
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
    const card = page.getByTestId(`agent-card-${ALVO}`);
    await expect(card).toBeVisible({ timeout: T(15000) });

    await card.getByRole("button", { name: "Ativar agente" }).click();
    await expect(card).toHaveAttribute("data-ativo", "true", { timeout: T(10000) });

    const get = await api(page).get(`/agents/${ALVO}`, { headers: HDR });
    const detalhe = await get.json();
    expect(detalhe.frontmatter?.ativo ?? detalhe.ativo).toBe(true);
  });

  test("agente desativado: Executar desabilitado na UI e 409 na API", async ({ page }) => {
    await garantirAgente(page, false);
    await page.reload();
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
    const card = page.getByTestId(`agent-card-${ALVO}`);
    await expect(card.getByRole("button", { name: "Executar" })).toBeDisabled({ timeout: T(15000) });

    const run = await api(page).post(`/agents/${ALVO}/run`, { headers: HDR, data: { ordem: "não deve rodar" } });
    expect(run.status()).toBe(409);
  });
});
