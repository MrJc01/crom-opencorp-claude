import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

/** Composer do chat: autocomplete /, @ e ! no Secretário. */
test.describe("Composer — autocomplete / @ !", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: 20000 });
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => undefined);
  });

  test("(a) / abre comandos; filtrar /status + Enter preenche e envia", async ({ page }) => {
    await page.locator("#chat-input").fill("/");
    await expect(page.getByText("Comandos do Sistema (/)").first()).toBeVisible({ timeout: 10000 });

    await page.locator("#chat-input").fill("/st");
    await expect(page.getByText("/status", { exact: true }).first()).toBeVisible({ timeout: 10000 });

    await page.keyboard.press("Enter");
    await expect(page.locator("#chat-input")).toHaveValue("/status ", { timeout: 5000 });

    await page.keyboard.press("Enter");
    await expect(page.locator(".oc-user").last()).toContainText("/status", { timeout: 15000 });
    await expect(page.locator(".oc-assistant").last()).toBeVisible({ timeout: 20000 });
  });

  test("(b) @ abre menções; clicar insere o agente no input", async ({ page }) => {
    await page.locator("#chat-input").fill("@");
    await expect(page.getByText("Mencionar Agente (@)").first()).toBeVisible({ timeout: 10000 });

    await page.getByText("@executor-padrao", { exact: true }).first().click();
    await expect(page.locator("#chat-input")).toHaveValue(/@executor-padrao /, { timeout: 5000 });
  });

  test("(c) ! abre comandos de terminal", async ({ page }) => {
    await page.locator("#chat-input").fill("!");
    await expect(page.getByText("Terminal Shell (!)").first()).toBeVisible({ timeout: 10000 });
  });

  test("(d) Escape fecha o popover sem enviar", async ({ page }) => {
    await page.locator("#chat-input").fill("/");
    await expect(page.getByText("Comandos do Sistema (/)").first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    await expect(page.getByText("Comandos do Sistema (/)")).toHaveCount(0);
    await expect(page.locator("#chat-input")).toHaveValue("/");
  });
});
