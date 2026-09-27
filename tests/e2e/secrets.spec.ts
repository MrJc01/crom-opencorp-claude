import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

const NOME = "TESTE_X_E2E";
const VALOR = "segredo-e2e-" + Date.now();

test.describe("Secrets / Credenciais", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secrets");
    await esperarElementoTexto(page, "Cofre de Segredos & Credenciais");
  });

  async function adicionarSegredo(page: import("@playwright/test").Page) {
    await page.getByRole("button", { name: "Adicionar Credencial" }).first().click();
    await esperarElementoTexto(page, "Adicionar Credencial com Template");
    // Template customizado (chave livre)
    await page.getByRole("button", { name: "Customizado / Chave Livre" }).click();
    await page.locator('input[placeholder="Ex: STRIPE_API_KEY ou SUPABASE_SERVICE_ROLE"]').fill(NOME);
    await page.locator('textarea[placeholder="Cole o segredo, token ou JSON aqui..."]').fill(VALOR);
    await page.getByRole("button", { name: "Salvar Credencial" }).click();
    await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 10000 });
  }

  test("adicionar segredo → nome listado mascarado, valor NUNCA aparece", async ({ page }) => {
    await adicionarSegredo(page);

    // Mascarado na UI
    await esperarElementoTexto(page, "••••••••••••••••••••");

    // API não vaza o valor
    const resp = await page.request.get("/secrets", { headers: { authorization: "Bearer test-e2e" } });
    const corpo = await resp.text();
    expect(corpo).toContain(NOME);
    expect(corpo).not.toContain(VALOR);

    // limpa (confirm nativo)
    page.once("dialog", (d) => d.accept());
    await page.locator('button[title="Excluir segredo permanentemente"]').first().click();
    await expect(page.getByText(NOME)).toHaveCount(0, { timeout: 10000 });
  });

  test("remover segredo pede confirmação: dispensar mantém, aceitar remove", async ({ page }) => {
    await adicionarSegredo(page);

    // dispensar mantém
    page.once("dialog", (d) => d.dismiss());
    await page.locator('button[title="Excluir segredo permanentemente"]').first().click();
    await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 10000 });

    // aceitar remove
    page.once("dialog", (d) => d.accept());
    await page.locator('button[title="Excluir segredo permanentemente"]').first().click();
    await expect(page.getByText(NOME)).toHaveCount(0, { timeout: 10000 });
  });
});
