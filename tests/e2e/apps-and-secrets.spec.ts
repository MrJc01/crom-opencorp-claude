import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";
import { execa } from "execa";

test.describe("Apps e Segredos (E2E)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", "e2e-corp");
    await seederEmpresaBasica(api(page), "test-e2e", "e2e-corp").catch(() => {});
    // Garante que o mini-app de teste está criado
    await api(page).post("/api/apps/novo", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "monitor-pulso",
        titulo: "Monitor do Pulso Diário",
        descricao: "Dashboard em tempo real das métricas do portal",
        htmlInicial: "<h1>Monitor do Pulso</h1>",
      },
    }).catch(() => {});
    await page.goto("/home");
  });

  test("1. Sidebar possui links de Apps & MCPs e Segredos & Chaves", async ({ page }) => {
    const sidebar = page.locator("aside#sidebar-principal");
    await expect(sidebar.getByRole("link", { name: "Apps & MCPs" })).toBeVisible();
    await expect(sidebar.getByRole("link", { name: "Segredos & Chaves" })).toBeVisible();
  });

  test("2. Navegação para /apps lista os Mini-Apps do workspace e permite abrir no Iframe", async ({ page }) => {
    await page.goto("/apps");

    await expect(page.locator("h1")).toContainText("Mini-Apps");

    // App semeado 'Monitor do Pulso Diário'
    const appCard = page.getByTestId("app-card-monitor-pulso");
    await expect(appCard).toBeVisible({ timeout: 15000 });
    await expect(appCard).toContainText("Monitor do Pulso Diário");

    // Botões de ação
    const btnAbrir = appCard.getByRole("button", { name: "Abrir App" });
    await expect(btnAbrir).toBeVisible();

    // Clica em 'Abrir App' (deve abrir com Só App ativo e chat oculto)
    await btnAbrir.click();

    // Verifica topbar do app aberto com as 3 opções
    await expect(page.locator("button:has-text('Voltar aos Apps')")).toBeVisible();
    await expect(page.getByRole("button", { name: "Só App" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Só Chat" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ambos" })).toBeVisible();

    // Verifica que o Iframe do Mini-App foi montado
    const iframe = page.locator('iframe[src*="/api/apps/monitor-pulso/view"]');
    await expect(iframe).toBeVisible();

    // Alterna para 'Só Chat'
    await page.getByRole("button", { name: "Só Chat" }).click();
    await expect(page.getByRole("button", { name: "Só Chat" })).toHaveAttribute("aria-pressed", "true");

    // Alterna para 'Ambos'
    await page.getByRole("button", { name: "Ambos" }).click();
    await expect(iframe).toBeVisible();

    // Clica em 'Voltar aos Apps'
    await page.locator("button:has-text('Voltar aos Apps')").click();
    await expect(page.locator("h1:has-text('Mini-Apps')")).toBeVisible();
  });

  test("3. Navegação para /secrets exibe templates de conexão, instruções de segurança e lista protegida", async ({ page }) => {
    await page.goto("/secrets");

    // Templates rápidos
    await expect(page.locator("text=WordPress (Application Password)")).toBeVisible();
    await expect(page.locator("text=Servidor VPS / SSH")).toBeVisible();
    await expect(page.locator("text=Provedor LLM / Chave de IA")).toBeVisible();
    await expect(page.locator("text=GitHub (Personal Access Token)")).toBeVisible();
    await expect(page.locator("text=Mercado Pago / Checkout")).toBeVisible();

    // Filtros de escopo
    for (const f of ["todos", "workspace", "global"]) await expect(page.getByTestId(`secrets-filtro-${f}`)).toBeVisible();

    // Clica em template (acessível por teclado) para abrir o modal guiado
    await page.getByTestId("template-segredo-wordpress").press("Enter");
    await expect(page.getByText("Guia de Operação: WordPress (Application Password)").first()).toBeVisible();
    await expect(page.getByText("Como Gerar / Obter a Chave:").first()).toBeVisible();
    await expect(page.getByText("Boas Práticas & Governança:").first()).toBeVisible();

    // Fecha modal
    await page.getByRole("button", { name: "Cancelar" }).click();
    await expect(page.getByText("Guia de Operação:")).toHaveCount(0);
  });

  test("4. CLI oc secret permite CRUD completo de senhas (set, get, list, delete)", async () => {
    const nomeSegredo = `teste_cli_${Date.now()}`;
    const valorSegredo = `chave_secreta_${Date.now()}`;

    // 1. SET
    const setRes = await execa("node", [
      "bin/opencorp.mjs",
      "secret",
      "set",
      nomeSegredo,
      valorSegredo,
      "--global",
    ]);
    expect(setRes.exitCode).toBe(0);
    expect(setRes.stdout).toContain("definido");

    // 2. GET
    const getRes = await execa("node", [
      "bin/opencorp.mjs",
      "secret",
      "get",
      nomeSegredo,
      "--json",
    ]);
    expect(getRes.exitCode).toBe(0);
    const parsed = JSON.parse(getRes.stdout);
    expect(parsed.nome).toBe(nomeSegredo);
    expect(parsed.valor).toBe(valorSegredo);
    expect(parsed.origem).toBe("global");

    // 3. LIST
    const listRes = await execa("node", [
      "bin/opencorp.mjs",
      "secret",
      "list",
      "--json",
    ]);
    expect(listRes.exitCode).toBe(0);
    const lista = JSON.parse(listRes.stdout);
    expect(lista.some((s: any) => s.nome === nomeSegredo)).toBe(true);

    // 4. DELETE
    const delRes = await execa("node", [
      "bin/opencorp.mjs",
      "secret",
      "delete",
      nomeSegredo,
      "--global",
    ]);
    expect(delRes.exitCode).toBe(0);
    expect(delRes.stdout).toContain("removido");

    // 5. GET após remoção deve falhar (exit code 1)
    try {
      await execa("node", ["bin/opencorp.mjs", "secret", "get", nomeSegredo]);
      expect(true).toBe(false); // não deveria chegar aqui
    } catch (err: any) {
      expect(err.exitCode).toBe(1);
    }
  });
});
