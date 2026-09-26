import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

test.describe("Apps / Mini-Apps", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/apps");
    await esperarElementoTexto(page, "Mini-Apps");
  });

  test("app semeado aparece na lista instalada", async ({ page }) => {
    await esperarElementoTexto(page, "Painel de Tarefas");
    await expect(page.getByText("apps/painel-tarefas").first()).toBeVisible();
  });

  test("abrir app mostra topbar com modos e voltar funciona", async ({ page }) => {
    const card = page.getByTestId("app-card-painel-tarefas");
    await expect(card).toBeVisible({ timeout: 15000 });
    await card.getByRole("button", { name: "Abrir App" }).click();

    await expect(page.getByRole("button", { name: "Voltar aos Apps" })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Só App" })).toBeVisible();
    await page.getByRole("button", { name: "Voltar aos Apps" }).click();
    await esperarElementoTexto(page, "Catálogo de Mini-Apps & Servidores MCP");
  });
});
