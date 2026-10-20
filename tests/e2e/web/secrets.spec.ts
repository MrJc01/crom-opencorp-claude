import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

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
    await page.getByRole("button", { name: "+ Novo Segredo" }).click();
    await esperarElementoTexto(page, "Adicionar Credencial com Template");
    for (const tmpl of ["Customizado / Chave Livre", "WordPress (Application Password)"]) {
      await page.getByRole("button", { name: tmpl, exact: true }).click();
      await page.waitForTimeout(300);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cancelar" }).click().catch(() => undefined);
    await expect(page.getByText("Adicionar Credencial com Template")).toHaveCount(0, { timeout: T(5000) });
    for (const filtro of ["workspace", "global", "todos"]) {
      await page.getByTestId(`secrets-filtro-${filtro}`).click();
      await expect(page.getByTestId(`secrets-filtro-${filtro}`)).toHaveAttribute("aria-pressed", "true");
    }
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("criar custom e excluir com confirm", async ({ page }) => {
    await page.getByRole("button", { name: "+ Novo Segredo" }).click();
    await page.getByRole("button", { name: "Customizado / Chave Livre", exact: true }).click();
    await page.getByPlaceholder("Ex: app:custom:variavel-privada ou STRIPE_API_KEY").fill(NOME);
    await page.getByPlaceholder("Cole o segredo, token ou JSON aqui...").fill(VALOR);
    await page.getByRole("button", { name: "Salvar no Cofre" }).click();
    await expect(page.getByText(NOME).first()).toBeVisible({ timeout: T(10000) });
    await expect(page.getByText("••••••••••••••••••••").first()).toBeVisible();

    page.once("dialog", (d) => d.accept());
    await page.locator('button[title="Excluir segredo permanentemente"]').first().click();
    await expect(page.getByText(NOME)).toHaveCount(0, { timeout: T(10000) });
  });
});
