import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

test.describe("Web Secretário: sugestões, drawer motor, histórico", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: 20000 });
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => undefined);
  });

  test("sugestão envia e resposta aparece", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.getByText("O que aconteceu hoje?").first().click();
    await expect(page.locator(".oc-user").last()).toContainText("O que aconteceu hoje?", { timeout: 15000 });
    await expect(page.locator(".oc-assistant").last()).toContainText("Resposta do assistant", { timeout: 20000 });
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("drawer motor abre, salva e fecha", async ({ page }) => {
    await page.locator('[data-testid="btn-configurar-motor"]').click();
    const drawer = page.locator('[data-testid="drawer-lateral-config"]');
    await expect(drawer).toBeVisible({ timeout: 10000 });
    await expect(drawer.getByText("Modelo Principal")).toBeVisible();
    await drawer.getByRole("button", { name: /Salvar no Workspace/ }).click();
    await expect(drawer.getByText("Salvo!")).toBeVisible({ timeout: 10000 });
    await page.getByTitle("Fechar painel").click();
    await expect(drawer).not.toBeVisible({ timeout: 10000 });
  });

  test("histórico modal busca e nova conversa", async ({ page }) => {
    await page.locator('main button[title="Histórico de Sessões"]').click();
    await esperarElementoTexto(page, "Histórico de Conversas");
    await page.locator('input[placeholder="Buscar conversas..."]').fill("zzz-nada-999");
    await esperarElementoTexto(page, "Nenhuma conversa encontrada.");
    await page.getByRole("dialog").getByRole("button", { name: "Nova Conversa" }).click();
    await expect(page.getByText("Histórico de Conversas")).toHaveCount(0);
  });
});
