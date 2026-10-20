import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

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
    await expect(page.getByRole("button", { name: "Nova Reunião" }).first()).toBeVisible({ timeout: T(15000) });

    await page.getByRole("button", { name: "Nova Reunião" }).first().click();
    await esperarElementoTexto(page, "Convocar Nova Reunião Colegiada");
    await expect(page.getByPlaceholder(/Definir linha editorial/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Iniciar Deliberação" })).toBeVisible();
  });

  test("Fluxos: lista com busca e botão Novo Fluxo", async ({ page }) => {
    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
    await expect(page.getByPlaceholder("Buscar por nome, id ou descrição...")).toBeVisible();
    await expect(page.getByRole("button", { name: "Novo Fluxo", exact: true })).toBeVisible();
  });
});
