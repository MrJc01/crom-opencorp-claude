import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Web Agentes: abas, toggle, inspeção e grupos", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await api(page).post("/agents/semear-catalogo", { headers: HDR });
    await page.goto("/agentes");
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
  });

  test("abas Todos/Agentes/Equipes filtram", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.getByRole("button", { name: /^Agentes \d+/ }).click();
    await expect(page.getByTestId("agent-card-executor-padrao")).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: /^Equipes \d+/ }).click();
    await expect(page.getByText("ID: e2e-pipe").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("agent-card-executor-padrao")).toHaveCount(0);
    await page.getByRole("button", { name: /^Todos \d+/ }).click();
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("busca filtra agentes", async ({ page }) => {
    const busca = page.getByPlaceholder("Buscar por nome, papel ou skill...");
    await busca.fill("executor-padrao");
    await expect(page.getByTestId("agent-card-executor-padrao")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("agent-card-agente-vendas")).toHaveCount(0);
    await busca.fill("");
  });

  test("configurar abre prompt/modelo e fecha", async ({ page }) => {
    const card = page.getByTestId("agent-card-executor-padrao");
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.getByRole("button", { name: "Configurar" }).click();
    await expect(page.getByText("Configuração & Prompt do Sistema")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Prompt do Sistema (System Prompt)")).toBeVisible();
    await page.getByTitle("Fechar", { exact: true }).first().click();
    await expect(page.getByText("Configuração & Prompt do Sistema")).toHaveCount(0);
  });

  test("modal execução dispara e mostra confirmação", async ({ page }) => {
    const card = page.getByTestId("agent-card-executor-padrao");
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.getByRole("button", { name: "Executar" }).click();
    await expect(page.getByText("Disparar Execução:")).toBeVisible({ timeout: 10000 });
    await page.locator("textarea").last().fill("ping web e2e");
    await page.getByRole("button", { name: "Disparar Ordem" }).click();
    await expect(page.getByText("Execução iniciada com sucesso!")).toBeVisible({ timeout: 15000 });
  });
});
