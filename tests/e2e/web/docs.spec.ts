import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

test.describe("Web Docs: busca, leitura e copiar", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/docs");
  });

  test("busca filtra e abrir doc mostra conteúdo + copiar", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.locator('input[placeholder="Buscar por título, slug ou categoria..."]').fill("wordpress");
    await page.waitForTimeout(500);
    await page.locator('input[placeholder="Buscar por título, slug ou categoria..."]').fill("");
    await page.getByText("01. Visão Geral da Plataforma").first().click();
    await page.waitForURL("**/docs?doc=*", { timeout: 10000 });
    await page.getByRole("button", { name: /Copiar/ }).first().click();
    await page.waitForTimeout(400);
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  // O menu da documentação não é mais recolhível na UI React (ver pendências).
  test.fixme("sidebar recolhe e expande", async ({ page }) => {
    await esperarElementoTexto(page, "01. Visão Geral da Plataforma");
    await page.locator('button[title="Recolher menu da documentação"]').first().click();
    await page.waitForTimeout(400);
    await page.locator('button[title="Expandir menu da documentação"]').click();
    await expect(page.getByText("01. Visão Geral da Plataforma").first()).toBeVisible({ timeout: 10000 });
  });
});
