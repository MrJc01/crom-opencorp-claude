import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

/** Chat do Secretário (página): enviar, receber resposta e navegar sem perder. */
test.describe("Chat do Secretário", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => undefined);
  });

  test("chat pronto com input e enviar visíveis", async ({ page }) => {
    await esperarElementoTexto(page, "Secretário");
    await expect(page.locator("#chat-input")).toBeVisible();
    await expect(page.locator("#chat-input")).toBeEnabled();
    await expect(page.locator("#btn-enviar")).toBeVisible();
  });

  test("enviar mensagem → resposta do fake aparece no feed", async ({ page }) => {
    const texto = `olá lateral e2e ${Date.now()}`;
    await page.locator("#chat-input").fill(texto);
    await page.click("#btn-enviar");

    await expect(page.locator(".oc-user").last()).toContainText(texto, { timeout: T(15000) });
    await expect(page.locator(".oc-assistant").last()).toContainText("Resposta do assistant", { timeout: T(20000) });
  });

  test("conversa persiste ao navegar para outra view e voltar", async ({ page }) => {
    const texto = `persistencia e2e ${Date.now()}`;
    await page.locator("#chat-input").fill(texto);
    await page.click("#btn-enviar");
    await expect(page.locator(".oc-user").last()).toContainText(texto, { timeout: T(15000) });

    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
    await expect(page.getByText(texto).first()).toBeVisible({ timeout: T(15000) });
  });

  test("mobile: chat utilizável em 390px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator("#chat-input")).toBeVisible({ timeout: T(20000) });
    await expect(page.locator("#btn-enviar")).toBeVisible();
  });
});
