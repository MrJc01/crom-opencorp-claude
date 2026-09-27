import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

test.describe("Navegação SolidJS e Transição entre Views", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", "e2e-corp");
    await seederEmpresaBasica(api(page), "test-e2e", "e2e-corp").catch(() => {});
  });

  test("1. Navega sequencialmente entre as views pela Sidebar mantendo estado", async ({ page }) => {
    await page.goto("/home");

    // Home
    await expect(page.locator("h1, h2").first()).toBeVisible();

    // Clica em Tasks
    await page.locator("aside").getByRole("link", { name: "Tarefas & Kanban", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks/);
    await expect(page.locator("text=Quadro Kanban").first()).toBeVisible();

    // Clica em Agentes
    await page.locator("aside").getByRole("link", { name: "Agentes & Teams", exact: true }).click();
    await expect(page).toHaveURL(/\/agentes/);
    await expect(page.locator("h1:has-text('Agentes')")).toBeVisible();

    // Clica em Apps
    await page.locator("aside").getByRole("link", { name: "Apps & MCPs", exact: true }).click();
    await expect(page).toHaveURL(/\/apps/);
    await expect(page.locator("h1:has-text('Mini-Apps')")).toBeVisible();

    // Clica em Segredos
    await page.locator("aside").getByRole("link", { name: "Segredos & Chaves", exact: true }).click();
    await expect(page).toHaveURL(/\/config\?tab=chaves/);
    await expect(page.locator("text=Cofre de Segredos & Credenciais").first()).toBeVisible();

    // Clica em Documentação
    await page.locator("aside").getByRole("link", { name: "Documentação", exact: true }).click();
    await expect(page).toHaveURL(/\/docs/);
    await expect(page.locator("h2:has-text('Documentação')")).toBeVisible();

    // Clica em Configurações
    await page.locator("aside").getByRole("link", { name: "Configurações", exact: true }).click();
    await expect(page).toHaveURL(/\/config/);
    await expect(page.locator("h1:has-text('Configurações')")).toBeVisible();
  });

  test("2. Colapso e expansão da Sidebar desktop funciona", async ({ page }) => {
    await page.goto("/home");

    // Botão de recolher/expandir sidebar desktop
    const btnColapso = page.locator('aside button[title*="menu"], aside button[title*="Recolher"], aside button[title*="Expandir"]').last();
    await expect(btnColapso).toBeVisible();

    // Clica para recolher
    await btnColapso.click();

    // A sidebar deve ter largura recolhida (w-16)
    const aside = page.locator("aside#sidebar-principal");
    await expect(aside).toHaveClass(/md:w-16/);

    // Clica para expandir novamente
    await btnColapso.click();
    await expect(aside).toHaveClass(/md:w-60/);
  });
});
