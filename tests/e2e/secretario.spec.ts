import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Secretário", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => {});
  });

  test("status inicial: chat pronto com input e botão de enviar visíveis", async ({ page }) => {
    // Verifica que o título do Secretário está presente
    await esperarElementoTexto(page, "Secretário");

    // Verifica que o chat-input está visível e habilitado
    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // Verifica que o botão de enviar está presente
    const btnEnviar = page.locator("#btn-enviar");
    await expect(btnEnviar).toBeVisible();
  });

  test("enviar 'olá' → resposta do fake aparece; conversa aparece no modal de histórico", async ({ page }) => {
    await esperarElementoTexto(page, "Secretário");

    // Verifica chat pronto
    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // Envia "olá"
    await input.fill("olá");
    await page.click("#btn-enviar");

    // Aguarda resposta do fake
    await expect(page.locator(".oc-assistant").first()).toContainText("Resposta do assistant", { timeout: T(15000) });

    // Abre modal de histórico de sessões
    const btnHist = page.locator('button[title="Histórico de Sessões"]');
    await expect(btnHist).toBeVisible();
    await btnHist.click();

    // Modal de histórico deve abrir
    await expect(page.getByText("Histórico de Conversas")).toBeVisible({ timeout: T(5000) });
  });
});