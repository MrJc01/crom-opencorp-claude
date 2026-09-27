import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

test.describe("Fluxos — Canvas n8n-style, Catálogo de Nós e Split-View", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/fluxos");
  });

  test("renderiza a interface de workflows e lista o catálogo expandido (Loop, Cron, Componente)", async ({ page }) => {
    // 1. Semeia o workflow via API para garantir teste determinístico e rápido
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-hle-e2e",
        nome: "Pipeline HLE E2E",
        descricao: "Esteira com HLE e Split-View",
        nos: [{ id: "inicio", tipo: "manual", config: {} }],
        arestas: [],
      },
    });

    await page.goto("/fluxos");

    // 2. Abre o canvas clicando no card do fluxo recém-criado
    const btnAbrir = page.locator('button:has-text("Studio")').first();
    await expect(btnAbrir).toBeVisible();
    await btnAbrir.click();

    // 3. Valida botões de alternância de visualização Split-View (Chat / Lado a Lado / Canvas)
    const btnChat = page.locator('button:has-text("Chat")');
    const btnSplit = page.locator('button:has-text("Lado a Lado")');
    const btnCanvas = page.locator('button:has-text("Canvas")');

    await expect(btnChat).toBeVisible();
    await expect(btnSplit).toBeVisible();
    await expect(btnCanvas).toBeVisible();

    // 4. Abre o modal de adicionar nós
    const btnAddNode = page.locator('button:has-text("Adicionar Node")').first();
    await expect(btnAddNode).toBeVisible();
    await btnAddNode.click();

    // 5. Valida que os novos nós de Loop, Cron e Componente estão no catálogo visual
    await expect(page.locator('text="Loop / HLE"')).toBeVisible();
    await expect(page.locator('text="Gatilho Cron / Agenda"')).toBeVisible();
    await expect(page.locator('text="Componente Modular"')).toBeVisible();
  });
});
