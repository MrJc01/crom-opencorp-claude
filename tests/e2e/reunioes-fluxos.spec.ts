import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

test.describe("Reuniões e Fluxos", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  test("Reuniões: header, estado e modal de convocação existem", async ({ page }) => {
    await page.goto("/reunioes");
    // Com ou sem sala ativa (outros testes podem ter criado salas), o header
    // e a ação de convocar sempre existem
    await expect(page.locator('button[title="Convocar nova reunião"]')).toBeVisible({ timeout: 15000 });

    await page.locator('button[title="Convocar nova reunião"]').click();
    await esperarElementoTexto(page, "Convocar Nova Reunião Multi-Agente");
    await expect(page.locator('textarea[placeholder="Ex: Alinhar lançamento da nova home e definir responsabilidade de cada agente..."]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Abrir Sala de Chat" })).toBeVisible();
  });

  test("Fluxos: lista com busca e botão Adicionar Fluxo", async ({ page }) => {
    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Fluxos");
    await expect(page.locator('input[placeholder="Pesquisar fluxos..."]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Adicionar Fluxo" })).toBeVisible();
  });
});
