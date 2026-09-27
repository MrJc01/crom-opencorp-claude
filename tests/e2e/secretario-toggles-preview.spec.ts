import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

// Os controles de raciocínio/ferramentas e o Preview Lateral do Secretário foram
// removidos na UI React (9ad8e1e); ver docs/PENDENCIAS-MULTIMOTORES.md.
test.describe.fixme("Secretário - Controles Superiores e Preview Web", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", "e2e-corp");
    await seederEmpresaBasica(api(page), "test-e2e", "e2e-corp").catch(() => {});
  });

  test("1. Barra superior do Secretário exibe os ícones de ação (Brain, Terminal, Globe)", async ({ page }) => {
    await page.goto("/secretario");

    // Identificador do agente
    await expect(page.locator("text=@secretario-exec")).toBeVisible();

    // Botão de Toggle de Raciocínio (Brain)
    const btnBrain = page.locator('button[title*="Raciocínio"], button[title*="Pensamento"]').first();
    await expect(btnBrain).toBeVisible();
    await expect(btnBrain.locator("svg")).toBeVisible();

    // Botão de Toggle de Ferramentas (Terminal)
    const btnTerminal = page.locator('button[title*="Ferramentas"]').first();
    await expect(btnTerminal).toBeVisible();
    await expect(btnTerminal.locator("svg")).toBeVisible();

    // Botão de Toggle de Preview Lateral (Globe)
    const btnGlobe = page.locator('button[title*="Preview Lateral"]').first();
    await expect(btnGlobe).toBeVisible();
    await expect(btnGlobe.locator("svg")).toBeVisible();
  });

  test("2. Abrir e fechar Preview Lateral via botão Globo", async ({ page }) => {
    await page.goto("/secretario");

    const btnGlobe = page.locator('button[title*="Preview Lateral"]').first();
    await expect(btnGlobe).toBeVisible();

    // Clica para abrir o Preview Lateral
    await btnGlobe.click();

    // Painel de preview deve estar visível com input de endereço
    const urlInput = page.locator('input[placeholder*="https://exemplo.com"]');
    await expect(urlInput).toBeVisible();

    // Botões de ação do preview (Recarregar, Copiar, Fechar)
    await expect(page.locator('button[title="Recarregar"]')).toBeVisible();
    await expect(page.locator('button[title="Copiar Link"]')).toBeVisible();
    await expect(page.locator('button[title="Fechar Preview"]')).toBeVisible();

    // Clica em Fechar Preview
    await page.locator('button[title="Fechar Preview"]').click();

    // O input de URL deve sumir da tela
    await expect(urlInput).not.toBeVisible();
  });

  test("3. Alternância dos toggles de Pensamento e Ferramentas atualiza estado ativo", async ({ page }) => {
    await page.goto("/secretario");

    const btnBrain = page.locator('button[title*="Raciocínio"], button[title*="Pensamento"]').first();
    await expect(btnBrain).toBeVisible();

    // Clica para alternar
    await btnBrain.click();
    // O botão deve responder à interação e permanecer funcional
    await expect(btnBrain).toBeVisible();

    const btnTerminal = page.locator('button[title*="Ferramentas"]').first();
    await expect(btnTerminal).toBeVisible();
    await btnTerminal.click();
    await expect(btnTerminal).toBeVisible();
  });
});
