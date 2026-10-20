import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

/**
 * Histórico do Secretário como modal (HistoricoModal): abre pelo header do chat,
 * lista ou estado vazio, busca filtra, e fecha sem órfãos.
 */
test.describe("Histórico do Secretário como modal", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await esperarElementoTexto(page, "Secretário");
  });

  test("(a) abre pelo header, mostra conteúdo e fecha com Escape", async ({ page }) => {
    const btn = page.locator('button[title="Histórico de Sessões"]');
    await expect(btn).toBeVisible({ timeout: T(15000) });
    await btn.click();

    await esperarElementoTexto(page, "Histórico de Conversas");
    await expect(page.locator('input[placeholder="Buscar conversas..."]')).toBeVisible({ timeout: T(10000) });

    await page.keyboard.press("Escape");
    await expect(page.getByText("Histórico de Conversas")).toHaveCount(0);
  });

  test("(b) busca sem resultado mostra estado vazio", async ({ page }) => {
    await page.locator('button[title="Histórico de Sessões"]').click();
    await esperarElementoTexto(page, "Histórico de Conversas");

    await page.locator('input[placeholder="Buscar conversas..."]').fill("zzz-inexistente-999");
    await esperarElementoTexto(page, "Nenhuma conversa encontrada.");
  });

  test("(c) Nova Conversa fecha o modal", async ({ page }) => {
    await page.locator('button[title="Histórico de Sessões"]').click();
    await esperarElementoTexto(page, "Histórico de Conversas");

    await page.getByRole("dialog").getByRole("button", { name: "Nova Conversa" }).click();
    await expect(page.getByText("Histórico de Conversas")).toHaveCount(0);
  });
});
