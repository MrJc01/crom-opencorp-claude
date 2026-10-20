import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Web Tasks: busca, filtros, drawer e agendamento", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
  });

  test("busca filtra e responsável filtra", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.locator('input[placeholder="Buscar tarefas..."]').fill("backlog e2e");
    await expect(page.getByText("Task backlog e2e").first()).toBeVisible({ timeout: T(10000) });
    await page.locator('input[placeholder="Buscar tarefas..."]').fill("zzz-nada-999");
    await expect(page.getByText("Task backlog e2e")).toHaveCount(0);
    await page.locator('input[placeholder="Buscar tarefas..."]').fill("");
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("drawer: mover para feito e excluir com confirm", async ({ page }) => {
    const titulo = `Web mover ${Date.now()}`;
    await api(page).post("/tasks", { headers: HDR, data: { titulo, coluna: "backlog", prioridade: "media" } });
    await page.locator('input[placeholder="Buscar tarefas..."]').fill(titulo);
    await page.getByText(titulo).first().click();
    await esperarElementoTexto(page, "Detalhes da Tarefa");

    await page.getByRole("button", { name: "Concluir" }).click();
    await expect(page.getByText("Concluído").first()).toBeVisible({ timeout: T(10000) });

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Excluir", exact: true }).last().click();
    await expect(page.getByText(titulo)).toHaveCount(0, { timeout: T(10000) });
  });

  test("modal criação com agendamento recorrente", async ({ page }) => {
    await page.getByRole("button", { name: "Nova Tarefa" }).click();
    await esperarElementoTexto(page, "Criar Nova Tarefa");
    await page.getByPlaceholder("Ex: Auditoria técnica de endpoints ou refatoração").fill(`Web agenda ${Date.now()}`);
    await page.locator("#checkAgendar").check();
    await page.getByRole("button", { name: "Repetir (Recorrente)" }).click();
    await page.locator("select:has(option[value='horario'])").selectOption("horario");
    await page.getByRole("button", { name: "Criar Tarefa" }).click();
    await expect(page.getByText("Criar Nova Tarefa")).toHaveCount(0, { timeout: T(10000) });
  });

  test("chat do drawer comenta sem executar", async ({ page }) => {
    const texto = `Web comentario ${Date.now()}`;
    await page.getByText("Task backlog e2e").first().click();
    await esperarElementoTexto(page, "Detalhes da Tarefa");
    await page.locator('input[placeholder="Instrução para o agente executar na tarefa..."]').fill(texto);
    await page.getByRole("button", { name: "Apenas comentar" }).click();
    await expect(page.getByText(texto).first()).toBeVisible({ timeout: T(10000) });
  });
});
