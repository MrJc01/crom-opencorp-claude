import { test, expect } from "@playwright/test";
import { logado } from "../helpers.js";
import { T } from "../helpers.js";

test.describe("F5-T02: Loja Visual smoke test", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await page.goto("/ativos");
    await page.waitForLoadState("networkidle");
  });

  test("página /ativos carrega e tem conteúdo", async ({ page }) => {
    await expect(page).toHaveURL(/\/ativos$/);
    // A página deve ter algum conteúdo visível
    await expect(page.locator("body")).toBeVisible({ timeout: T(10000) });
    // Pelo menos um elemento deve existir
    const elements = await page.locator("*").count();
    expect(elements).toBeGreaterThan(0);
  });
});
