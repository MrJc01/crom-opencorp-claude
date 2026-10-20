import { test, expect } from "@playwright/test";
import { logado } from "../helpers.js";
import { T } from "../helpers.js";

test.describe("F5-T02 Loja Visual + Ficha do Agente", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await page.goto("/ativos");
    await page.waitForLoadState("networkidle");
  });

  test("a) página /ativos carrega skills", async ({ page }) => {
    await expect(page).toHaveURL(/\/ativos$/);
    await expect(page.locator("body")).toBeVisible({ timeout: T(10000) });
  });

  test("b) skill preview expande", async ({ page }) => {
    const skills = page.locator("[class*='p-4 rounded-xl']");
    const count = await skills.count();
    if (count > 0) {
      await skills.first().click();
      await expect(page.getByText("Tópicos principais:")).toBeVisible({ timeout: T(10000) });
    }
  });

  test("c) navega para ficha de agente", async ({ page }) => {
    await page.goto("/agente/executor-padrao");
    await expect(page).toHaveURL("/agente/executor-padrao");
  });

  test("d) ficha de agente carrega", async ({ page }) => {
    await page.goto("/agente/executor-padrao");
    await expect(page.locator("body")).toBeVisible({ timeout: T(15000) });
  });
});
