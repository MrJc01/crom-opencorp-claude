import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarNavegacao } from "./helpers.js";
import { T } from "./helpers.js";

const views = [
  { path: "home", link: "Home Dashboard", seletor: "h1:has-text('Governança da Empresa Autônoma')" },
  { path: "tasks", link: "Tarefas & Kanban", seletor: "text=Quadro Kanban" },
  { path: "fluxos", link: "Fluxos de Automação", seletor: "h1:has-text('Fluxos')" },
  { path: "historico", link: "Histórico de Auditoria", seletor: "h1:has-text('Histórico')" },
  { path: "secretario", link: "Secretário Executivo", seletor: "#chat-input" },
  { path: "apps", link: "Apps & MCPs", seletor: "h1:has-text('Mini-Apps')" },
];

test.describe("Navegação Sidebar", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  for (const view of views) {
    test(`clicar em ${view.path} navega para /${view.path}`, async ({ page }) => {
      // Inicia em rota diferente para garantir transição real
      const pontoPartida = view.path === "home" ? "tasks" : "home";
      await page.goto(`/${pontoPartida}`);
      await esperarNavegacao(page, pontoPartida);

      // Clica no item correspondente da sidebar
      const navItem = page.locator("aside").getByRole("link", { name: view.link }).first();
      await expect(navItem).toBeVisible();
      await navItem.click();

      // Aguarda navegação
      if (view.path === "home") await page.waitForURL(/\/w\/[^/]+\/?$/);
      else await page.waitForURL(new RegExp(`/${view.path}`));

      // Verifica que o elemento identificador da página está visível
      await expect(page.locator(view.seletor).first()).toBeVisible({ timeout: T(10000) });
    });
  }

  test("rota com hash legado #/reunioes redireciona para /reunioes", async ({ page }) => {
    await page.goto("/home");
    await esperarNavegacao(page, "home");
    await page.evaluate(() => { window.location.hash = "#/reunioes"; });
    await page.waitForURL("**/reunioes*");
    await expect(page).toHaveURL(/\/reunioes/);
    await expect(page.locator("main").getByText("Reunião", { exact: false }).first()).toBeVisible({ timeout: T(10000) });
  });

  test("botão recolher altera largura da sidebar e persiste após reload", async ({ page }) => {
    await page.goto("/home");
    await esperarNavegacao(page, "home");

    const aside = page.locator("aside#sidebar-principal");
    await expect(aside).toBeVisible();
    await expect(aside).toHaveClass(/md:w-60/);

    // Clica no botão de recolher da sidebar desktop
    const btnColapso = page.locator('aside button[title*="menu"], aside button[title*="Recolher"], aside button[title*="Expandir"], #sidebar-collapse-btn').last();
    await expect(btnColapso).toBeVisible();
    await btnColapso.click();

    // Sidebar fica recolhida
    await expect(aside).toHaveClass(/md:w-16/);

    // Persistência: recarrega e o estado colapsado volta
    await page.reload();
    await esperarNavegacao(page, "home");
    await expect(aside).toHaveClass(/md:w-16/);

    // Volta ao normal (expande)
    const btnExpansao = page.locator('aside button[title*="menu"], aside button[title*="Recolher"], aside button[title*="Expandir"], #sidebar-collapse-btn').last();
    await btnExpansao.click();
    await expect(aside).toHaveClass(/md:w-60/);
  });
});
