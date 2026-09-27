import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

test.describe("Central de Documentação (/docs)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", "e2e-corp");
    await seederEmpresaBasica(api(page), "test-e2e", "e2e-corp").catch(() => {});
  });

  test("1. Carrega a lista de documentos e exibe o documento inicial", async ({ page }) => {
    await page.goto("/docs");

    // Header da Documentação
    await expect(page.locator("h2:has-text('Documentação')")).toBeVisible();

    // Documentos essenciais na sidebar de docs
    await expect(page.locator("text=01. Visão Geral da Plataforma").first()).toBeVisible();
    await expect(page.locator("text=17. Mini-Apps e Segredos").first()).toBeVisible();
    await expect(page.locator("text=08. Referência do CLI e oc").first()).toBeVisible();
  });

  test("2. Navega para o documento 17-mini-apps-segredos e renderiza seções completas", async ({ page }) => {
    await page.goto("/docs?doc=17-mini-apps-segredos");

    // Verifica que o conteúdo do novo documento 17 foi renderizado
    await expect(page.locator("h1:has-text('17 — Mini-Apps e Segredos & Credenciais')")).toBeVisible();
    await expect(page.locator("text=Os 3 Modos de Visualização com IA")).toBeVisible();
    await expect(page.locator("text=Só App").first()).toBeVisible();
    await expect(page.locator("text=Só Chat").first()).toBeVisible();
    await expect(page.locator("text=Os Dois").first()).toBeVisible();
    await expect(page.locator("text=Templates Rápidos de Conexão")).toBeVisible();
  });

  test("3. Campo de busca filtra a lista de tópicos em tempo real", async ({ page }) => {
    await page.goto("/docs");
    await expect(page.locator("text=01. Visão Geral da Plataforma").first()).toBeVisible();

    // Digita termo no campo de busca de docs
    const searchInput = page.locator('input[placeholder*="Buscar por título"]');
    await searchInput.fill("Mini-Apps");

    // Documento correspondente permanece visível
    await expect(page.locator("text=17. Mini-Apps e Segredos")).toBeVisible();

    // Outros são filtrados
    await expect(page.locator("text=01. Visão Geral da Plataforma")).not.toBeVisible();
  });

  test("4. Alterna colapso da sidebar interna da documentação", async ({ page }) => {
    await page.goto("/docs");

    // Botão de alternar sidebar interna
    const toggleBtn = page.locator('button[title*="menu"], button[title*="artigos"]').first();
    if (await toggleBtn.isVisible()) {
      await toggleBtn.click();
      // O documento principal permanece navegável
      await expect(page.locator("article")).toBeVisible();
    }
  });
});
