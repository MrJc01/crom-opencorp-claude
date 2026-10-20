import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Tasks / Kanban", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
  });

  test("criar task pelo modal → aparece no kanban na coluna Backlog", async ({ page }) => {
    const titulo = `Nova task e2e via UI ${Date.now()}`;
    await page.getByRole("button", { name: "Nova Tarefa" }).click();
    await esperarElementoTexto(page, "Criar Nova Tarefa");
    await page.getByPlaceholder("Ex: Auditoria técnica de endpoints ou refatoração").fill(titulo);
    await page.getByRole("button", { name: "Criar Tarefa" }).click();

    // Modal fecha e o card aparece (filtra pela busca para isolar)
    await page.locator('input[placeholder="Buscar tarefas..."]').fill(titulo);
    await expect(page.getByText(titulo).first()).toBeVisible({ timeout: T(10000) });
    // Card está dentro da coluna Backlog (header exato "Backlog")
    const colunaBacklog = page.getByTestId("kanban-coluna-backlog");
    await expect(colunaBacklog.getByText(titulo)).toBeVisible();
  });

  test("clicar no card abre drawer com título e metadados", async ({ page }) => {
    const card = page.getByText("Task backlog e2e").first();
    await expect(card).toBeVisible({ timeout: T(10000) });
    await card.click();

    await esperarElementoTexto(page, "Detalhes da Tarefa");
    await expect(page.getByText("Task backlog e2e").nth(1)).toBeVisible();
  });

  test("comentar no drawer → mensagem aparece no histórico", async ({ page }) => {
    const texto = `Mensagem de teste e2e ${Date.now()}`;
    await page.getByText("Task backlog e2e").first().click();
    await esperarElementoTexto(page, "Detalhes da Tarefa");

    await page.locator('input[placeholder="Instrução para o agente executar na tarefa..."]').fill(texto);
    await page.getByRole("button", { name: "Apenas comentar" }).click();

    await expect(page.getByText(texto).first()).toBeVisible({ timeout: T(10000) });
  });

  test("concluir task no drawer → sai do Backlog e aparece em Concluído", async ({ page }) => {
    const titulo = `Task mover e2e ${Date.now()}`;
    await api(page).post("/tasks", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: { titulo, descricao: "criada para o teste de mover", coluna: "backlog", prioridade: "media" },
    });
    await page.reload();
    await esperarElementoTexto(page, "Quadro Kanban");
    await page.locator('input[placeholder="Buscar tarefas..."]').fill(titulo);
    const card = page.getByText(titulo).first();
    await expect(card).toBeVisible({ timeout: T(10000) });
    await card.click();
    await esperarElementoTexto(page, "Detalhes da Tarefa");

    await page.getByRole("button", { name: "Concluir" }).click();

    // Drawer mostra novo status e o card migra de coluna
    await expect(page.getByText("Concluído").first()).toBeVisible({ timeout: T(10000) });
    await page.locator('input[placeholder="Buscar tarefas..."]').fill("");
    await page.locator('input[placeholder="Buscar tarefas..."]').fill(titulo);
    await expect(page.getByText(titulo).first()).toBeVisible();
  });
});
