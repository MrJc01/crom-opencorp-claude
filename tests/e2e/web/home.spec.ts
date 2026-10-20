import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { Shell } from "./pom/shell.js";
import { T } from "../helpers.js";

test.describe("Web Home: tabs, modal task, comando, aprovações", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  // Abas, "Nova Task" e barra de comando da home antiga não existem na UI React
  // (ver docs/PENDENCIAS-MULTIMOTORES.md); a home atual é coberta por tests/e2e/home.spec.ts.
  test("nova tarefa pelo Kanban: abre, cria e aparece", async ({ page }) => {
    const titulo = `Web nova task ${Date.now()}`;
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    await page.getByRole("button", { name: "Nova Tarefa" }).click();
    const campo = page.getByPlaceholder(/Auditoria/).first();
    await expect(campo).toBeVisible({ timeout: T(10000) });
    await campo.fill(titulo);
    await page.getByRole("button", { name: /Criar Tarefa/ }).click();
    await page.getByPlaceholder("Buscar tarefas...").fill(titulo);
    await expect(page.getByText(titulo).first()).toBeVisible({ timeout: T(10000) });
  });

  test("shell: trocar workspace pelo topbar atualiza tudo", async ({ page }) => {
    const shell = new Shell(page);
    await shell.trocarWorkspace("outro-ws");
    await expect(page.locator('button[title="Trocar workspace ou criar novo projeto"]')).toContainText("outro-ws");
    await shell.trocarWorkspace("e2e-corp");
  });

  test("indicador do canal de eventos conecta (stream)", async ({ page }) => {
    const shell = new Shell(page);
    await expect(shell.badgeStream).toBeVisible({ timeout: T(15000) });
    await expect(shell.badgeStream).toContainText("stream", { timeout: T(15000) });
  });
});
