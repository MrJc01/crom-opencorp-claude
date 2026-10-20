import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

/** Secretário em dock lateral: em todas as páginas, conversa compartilhada com /secretario. */
test.describe("Web Secretário dock lateral", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => undefined);
  });

  test("toggle abre/fecha o dock em página comum", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");

    const dock = page.locator('[data-testid="secretario-dock"]');
    const toggle = page.locator('[data-testid="secretario-toggle"]').first();
    // Estado inicial pode ser aberto (persistido) ou fechado — normaliza para fechado
    if (await dock.isVisible().catch(() => false)) {
      await toggle.click();
      await expect(dock).not.toBeVisible({ timeout: T(10000) });
    }
    await toggle.click();
    await expect(dock).toBeVisible({ timeout: T(10000) });
    await expect(page.locator("#secretario-dock-input")).toBeVisible();
    await page.locator('[data-testid="secretario-dock-fechar"]').click();
    await expect(dock).not.toBeVisible({ timeout: T(10000) });
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("mensagem enviada no dock aparece na página do secretário", async ({ page }) => {
    const texto = `secretario dock e2e ${Date.now()}`;
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    const dock = page.locator('[data-testid="secretario-dock"]');
    if (!(await dock.isVisible().catch(() => false))) {
      await page.locator('[data-testid="secretario-toggle"]').first().click();
      await expect(dock).toBeVisible({ timeout: T(10000) });
    }
    await dock.locator("#secretario-dock-input").fill(texto);
    await dock.locator('[data-testid="secretario-dock-btn-enviar"]').click();
    await expect(dock.locator(".oc-user").last()).toContainText(texto, { timeout: T(15000) });
    await expect(dock.locator(".oc-assistant").last()).toContainText("Resposta do assistant", { timeout: T(30000) });

    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
    await expect(page.getByText(texto).first()).toBeVisible({ timeout: T(15000) });
  });

  test("na página /secretario o dock se oculta (a página já é o chat)", async ({ page }) => {
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
    await expect(page.locator('[data-testid="secretario-dock"]')).toHaveCount(0);
    await expect(page.locator("#chat-input")).toHaveCount(1);
    await expect(page.locator('[data-testid="btn-enviar"]')).toHaveCount(1);
  });

  test("em outra página o dock monta com ids próprios (sem duplicados)", async ({ page }) => {
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    const dock = page.locator('[data-testid="secretario-dock"]');
    if (!(await dock.isVisible().catch(() => false))) {
      await page.locator('[data-testid="secretario-toggle"]').first().click();
      await expect(dock).toBeVisible({ timeout: T(10000) });
    }
    await expect(page.locator("#chat-input")).toHaveCount(0);
    await expect(page.locator("#secretario-dock-input")).toHaveCount(1);
    await expect(page.locator('[data-testid="secretario-dock-btn-enviar"]')).toHaveCount(1);
  });

  test("botão flutuante abre o dock no desktop", async ({ page }) => {
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    const dock = page.locator('[data-testid="secretario-dock"]');
    if (await dock.isVisible().catch(() => false)) {
      await page.locator('[data-testid="secretario-dock-fechar"]').click();
      await expect(dock).not.toBeVisible({ timeout: T(10000) });
    }
    const fab = page.locator('[data-testid="secretario-fab"]');
    await expect(fab).toBeVisible({ timeout: T(10000) });
    await fab.click();
    await expect(dock).toBeVisible({ timeout: T(10000) });
    await expect(fab).not.toBeVisible({ timeout: T(10000) });
  });

  test("mobile 390px: FAB abre o dock como overlay e fecha", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    const dock = page.locator('[data-testid="secretario-dock"]');
    if (await dock.isVisible().catch(() => false)) {
      await page.locator('[data-testid="secretario-dock-fechar"]').click();
      await expect(dock).not.toBeVisible({ timeout: T(10000) });
    }
    const fab = page.locator('[data-testid="secretario-fab"]');
    await expect(fab).toBeVisible({ timeout: T(10000) });
    await fab.click();
    await expect(dock).toBeVisible({ timeout: T(10000) });
    await expect(page.locator("#secretario-dock-input")).toBeVisible();
    await page.locator('[data-testid="secretario-dock-fechar"]').click();
    await expect(dock).not.toBeVisible({ timeout: T(10000) });
  });
});
