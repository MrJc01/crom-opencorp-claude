import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

/**
 * Home do workspace (UI React). O antigo "Painel de Operações" (KPIs de custo/saúde,
 * barra de comando com `!`, lista "A Seguir") não existe mais nesta tela — ver
 * docs/PENDENCIAS-MULTIMOTORES.md.
 */
test.describe("Home do workspace", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  test("mostra tarefas em aberto (task semeada) e agentes", async ({ page }) => {
    await esperarElementoTexto(page, "Tarefas em Aberto");
    await expect(page.getByText("Task backlog e2e").first()).toBeVisible({ timeout: T(10000) });
    await esperarElementoTexto(page, "Especialistas e Agentes");
  });

  test("Abrir Secretário navega ao chat", async ({ page }) => {
    await page.getByRole("link", { name: "Abrir Secretário" }).click();
    await page.waitForURL(/\/secretario/, { timeout: T(10000) });
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
  });

  test("Ver Kanban navega às tarefas", async ({ page }) => {
    await page.getByRole("link", { name: /Ver Kanban/ }).click();
    await page.waitForURL(/\/tasks/, { timeout: T(10000) });
    await esperarElementoTexto(page, "Quadro Kanban");
  });

  test("atalhos levam a Fluxos e Configurações", async ({ page }) => {
    await expect(page.locator('main a[href$="/fluxos"]').first()).toBeVisible();
    await expect(page.locator('main a[href$="/config"]').first()).toBeVisible();
  });
});
