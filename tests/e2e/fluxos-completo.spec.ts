import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

test.describe("E2E Completo — OpenCorp Fluxos & Studio n8n-style", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/fluxos");
  });

  test("1. Redirecionamento da rota /agenda e exibição de fluxos com nós cron", async ({ page }) => {
    // Semeia o fluxo com nó cron
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-cron-agenda",
        nome: "Rotina Noturna Cron",
        descricao: "Executa sincronizações às 2h",
        nos: [
          { id: "gatilho-cron", tipo: "cron", config: { expressao_cron: "0 2 * * *" } },
          { id: "espera", tipo: "delay", config: { segundos: 10 } },
        ],
        arestas: [{ de: "gatilho-cron", para: "espera" }],
      },
    });

    // Navega para /agenda e valida redirecionamento automático para /fluxos?filtro=cron
    await page.goto("/agenda");
    await page.waitForURL("**/fluxos?filtro=cron*", { timeout: 10000 });
    expect(page.url()).toContain("/fluxos?filtro=cron");
    await expect(page.locator("text=Rotina Noturna Cron").first()).toBeVisible();
  });

  test("2. Filtros por Gatilho (Todos, Cron, Webhook, Manual) e busca textual", async ({ page }) => {
    // Semeia fluxos para cada tipo
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-filtro-cron",
        nome: "Fluxo Agendado Alpha",
        nos: [{ id: "cron-1", tipo: "cron", config: { expressao_cron: "0 9 * * *" } }],
        arestas: [],
      },
    });

    await page.goto("/fluxos");

    // Filtro Agendados (Cron)
    const btnCron = page.getByRole("button", { name: /^Cron \d+/ });
    await expect(btnCron).toBeVisible();
    await btnCron.click();
    await expect(page.locator("text=Fluxo Agendado Alpha").first()).toBeVisible();

    // Filtro Todos
    const btnTodos = page.getByRole("button", { name: /^Todos \d+/ });
    await btnTodos.click();
    await expect(page.locator("text=Fluxo Agendado Alpha").first()).toBeVisible();

    // Pesquisa por texto
    const inputBusca = page.getByPlaceholder("Buscar por nome, id ou descrição...");
    await inputBusca.fill("Alpha");
    await expect(page.locator("text=Fluxo Agendado Alpha").first()).toBeVisible();

    await inputBusca.fill("inexistente_xyz_999");
    await expect(page.locator("text=Nenhum fluxo encontrado")).toBeVisible();
  });

  test("3. Abertura do Canvas e retorno seguro à lista de fluxos (Botão Voltar)", async ({ page }) => {
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-retorno-teste",
        nome: "Pipeline Retorno Teste",
        nos: [{ id: "inicio", tipo: "manual", config: {} }],
        arestas: [],
      },
    });

    await page.goto("/fluxos");

    // Clica no botão Abrir Canvas
    const btnAbrir = page.locator('button:has-text("Studio")').first();
    await expect(btnAbrir).toBeVisible();
    await btnAbrir.click();

    // Verifica que o canvas abriu e o botão voltar está visível
    const btnVoltar = page.locator("#btn-voltar-fluxos");
    await expect(btnVoltar).toBeVisible({ timeout: 10000 });

    // Clica no botão Voltar para Fluxos
    await btnVoltar.click();

    // Valida que retornou para a lista geral
    await expect(page.locator('h1:has-text("Studio de Fluxos")')).toBeVisible({ timeout: 10000 });
    await expect(page).not.toHaveURL(/fluxo=/);
  });

  test("4. Menu Lateral de Nós (Drawer n8n) com Categorias e Novos Nós", async ({ page }) => {
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-drawer-teste",
        nome: "Pipeline Drawer Teste",
        nos: [{ id: "inicio", tipo: "manual", config: {} }],
        arestas: [],
      },
    });

    await page.goto("/fluxos");

    const btnAbrir = page.locator('button:has-text("Studio")').first();
    await btnAbrir.click();

    // Abre o catálogo lateral de nós
    const btnAddNode = page.getByTitle("Abrir paleta de nós");
    await expect(btnAddNode).toBeVisible();
    await btnAddNode.click();

    // Valida catálogo com todos os nós
    await expect(page.locator('text="Executar Sub-Fluxo"')).toBeVisible();
    await expect(page.locator('text="Requisição HTTP / API"')).toBeVisible();
    await expect(page.locator('text="Aguardar / Delay"')).toBeVisible();
    await expect(page.locator('text="Loop / Repetição"')).toBeVisible();
    await expect(page.locator('text="Gatilho Cron / Agenda"')).toBeVisible();
    await expect(page.locator('text="Gatilho Webhook"')).toBeVisible();

    // Filtra no drawer
    const inputBuscaDrawer = page.locator('input[placeholder*="Buscar nós"]');
    await inputBuscaDrawer.fill("Sub-Fluxo");
    await expect(page.locator('text="Executar Sub-Fluxo"')).toBeVisible();
    await expect(page.locator('text="Requisição HTTP / API"')).not.toBeVisible();
  });

  test("5. Painel Inferior Colapsável de Logs e Inspeção de Dados I/O por Elemento", async ({ page }) => {
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-logs-teste",
        nome: "Pipeline Logs Teste",
        nos: [{ id: "inicio", tipo: "manual", config: {} }],
        arestas: [],
      },
    });

    await page.goto("/fluxos");

    const btnAbrir = page.locator('button:has-text("Studio")').first();
    await btnAbrir.click();

    // Abre o painel inferior de logs
    const btnLogs = page.locator('#btn-painel-logs, #btn-header-logs').first();
    await expect(btnLogs).toBeVisible();
    await btnLogs.click();

    // Verifica que o painel inferior abriu
    await expect(page.locator('text=Execuções & Telemetria I/O')).toBeVisible();
  });
});
