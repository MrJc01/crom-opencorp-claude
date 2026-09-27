import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarNavegacao, esperarElementoTexto } from "./helpers.js";

test.describe("Workspaces / Empresas", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarNavegacao(page, "home");
  });

  test("seletor lista as empresas", async ({ page }) => {
    const seletor = page.getByTitle("Trocar workspace ou criar novo projeto");
    await expect(seletor).toBeVisible();
    await seletor.click();
    const opcoes = page.getByRole("option");
    expect(await opcoes.count()).toBeGreaterThan(1);
    await expect(page.getByRole("option", { name: /^e2e-corp(\s|$)/ })).toHaveCount(1);
  });

  test("sem localStorage oc-ws: UI auto-seleciona a primeira empresa", async ({ page }) => {
    // Garante que não há oc-ws
    await page.evaluate(() => localStorage.removeItem("oc-ws"));
    await page.reload();
    await esperarNavegacao(page, "home");
    // Verifica via evaluate se oc-ws foi definido
    const ws = await page.evaluate(() => localStorage.getItem("oc-ws"));
    expect(ws).toBeTruthy();
    // Deve ser o primeiro workspace (e2e-corp)
    expect(ws).toBe("e2e-corp");
  });
});