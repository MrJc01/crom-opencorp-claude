import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

/**
 * Acessibilidade das telas novas da arquitetura multimotores (P-13):
 * painel de motores (seleção, diagnóstico, erros), limites, linhas de
 * configuração e cards de agentes. Falha em violações graves/críticas.
 */
async function violacoesGraves(page: Page, seletor: string) {
  const resultado = await new AxeBuilder({ page }).include(seletor).withTags(["wcag2a", "wcag2aa"]).analyze();
  return resultado.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.html.slice(0, 160)).join(" | ")}`);
}

test.describe("Acessibilidade — telas multimotores", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("aba Motores", async ({ page }) => {
    await page.goto("/config?tab=motores");
    await expect(page.getByTestId("tab-motores")).toBeVisible({ timeout: 15000 });
    expect(await violacoesGraves(page, "[data-testid='tab-motores']")).toEqual([]);
  });

  test("aba Limites", async ({ page }) => {
    await page.goto("/config?tab=limites");
    await expect(page.getByTestId("tab-limites-motores")).toBeVisible({ timeout: 15000 });
    expect(await violacoesGraves(page, "[data-testid='tab-limites-motores']")).toEqual([]);
  });

  test("linhas de configuração (Orçamento)", async ({ page }) => {
    await page.goto("/config?tab=orcamento");
    await expect(page.getByTestId("setting-budget.daily_usd")).toBeVisible({ timeout: 15000 });
    expect(await violacoesGraves(page, "[data-testid^='setting-']")).toEqual([]);
  });

  test("cards de agentes", async ({ page }) => {
    await api(page).post("/agents/semear-catalogo", { headers: { authorization: "Bearer test-e2e" } });
    await page.goto("/agentes");
    await expect(page.locator("[data-testid^='agent-card-']").first()).toBeVisible({ timeout: 15000 });
    expect(await violacoesGraves(page, "[data-testid^='agent-card-']")).toEqual([]);
  });
});
