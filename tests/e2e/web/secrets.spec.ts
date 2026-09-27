import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

const NOME = "TESTE_WEB_E2E";
const VALOR = "segredo-web-e2e";

test.describe("Web Secrets: templates, filtros e CRUD", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secrets");
    await esperarElementoTexto(page, "Cofre de Segredos & Credenciais");
  });

  test("templates trocam o form e filtros alternam", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.getByRole("button", { name: "Adicionar Credencial" }).first().click();
    await esperarElementoTexto(page, "Adicionar Credencial com Template");
    for (const tmpl of ["Customizado / Chave Livre", "WordPress"]) {
      await page.getByRole("button", { name: tmpl }).click();
      await page.waitForTimeout(300);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cancelar" }).click().catch(() => undefined);
    await expect(page.getByText("Adicionar Credencial com Template")).toHaveCount(0, { timeout: 5000 });
    for (const filtro of ["Workspace", "Global", "Todos (Merge)"]) {
      await page.getByRole("button", { name: filtro, exact: true }).click();
      await page.waitForTimeout(300);
    }
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("criar custom e excluir com confirm", async ({ page }) => {
    await page.getByRole("button", { name: "Adicionar Credencial" }).first().click();
    await page.getByRole("button", { name: "Customizado / Chave Livre" }).click();
    await page.locator('input[placeholder="Ex: STRIPE_API_KEY ou SUPABASE_SERVICE_ROLE"]').fill(NOME);
    await page.locator('textarea[placeholder="Cole o segredo, token ou JSON aqui..."]').fill(VALOR);
    await page.getByRole("button", { name: "Salvar Credencial" }).click();
    await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("••••••••••••••••••••").first()).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await page.locator('button[title="Excluir segredo permanentemente"]').first().click();
    await expect(page.getByText(NOME)).toHaveCount(0, { timeout: 10000 });
  });
});
