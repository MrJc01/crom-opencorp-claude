import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Web Fluxos: lista, canvas, NDV e execução", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
  });

  test("busca e filtros funcionam", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    const busca = page.getByPlaceholder("Buscar por nome, id ou descrição...");
    await busca.fill("zzz-nada-999");
    await esperarElementoTexto(page, "Nenhum fluxo encontrado");
    await busca.fill("");
    for (const filtro of [/^Cron \d+/, /^Todos \d+/]) {
      const botao = page.getByRole("button", { name: filtro }).first();
      await botao.click();
      await expect(botao).toHaveAttribute("aria-pressed", "true");
    }
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("criar fluxo pelo modal abre o canvas", async ({ page }) => {
    const nome = `Web fluxo ${Date.now()}`;
    await page.getByRole("button", { name: "Novo Fluxo", exact: true }).click();
    await esperarElementoTexto(page, "Criar Novo Fluxo DAG");
    await page.getByPlaceholder("ex: Produção de Conteúdo YouTube").fill(nome);
    await page.getByRole("button", { name: "Criar no Studio" }).click();
    await expect(page.locator('button[title="Voltar para Lista de Fluxos"]')).toBeVisible({ timeout: T(10000) });
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: T(10000) });
  });

  test("canvas: zoom, NDV e voltar", async ({ page }) => {
    const fid = `flow-canvas-${Date.now().toString(36)}`;
    await api(page).post("/flows", {
      headers: HDR,
      data: { id: fid, nome: "Canvas", nos: [{ id: "inicio", tipo: "manual", config: {} }, { id: "fim", tipo: "registro", config: { categoria: "documentos" } }], arestas: [{ de: "inicio", para: "fim" }] },
    });
    await page.reload();
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
    await page.getByTestId(`abrir-editor-${fid}`).click();
    await expect(page.locator('.react-flow__node[data-id="inicio"]').first()).toBeVisible({ timeout: T(15000) });

    await page.getByRole("button", { name: "Zoom In" }).click();
    await page.getByRole("button", { name: "Fit View" }).click();
    await page.locator('.react-flow__node[data-id="fim"]').first().click();
    await expect(page.getByTestId("ndv-panel")).toBeVisible({ timeout: T(10000) });

    await page.locator('button[title="Voltar para Lista de Fluxos"]').click();
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");

    page.once("dialog", (d) => d.accept());
    await page.getByTestId(`fluxo-card-${fid}`).getByRole("button", { name: "Excluir fluxo" }).click();
    await expect(page.getByTestId(`fluxo-card-${fid}`)).toHaveCount(0, { timeout: T(10000) });
  });

  test("executar pelo Studio dispara e informa o exec_id", async ({ page }) => {
    const fid = `flow-exec-${Date.now().toString(36)}`;
    await api(page).post("/flows", {
      headers: HDR,
      data: { id: fid, nome: "Exec", nos: [{ id: "inicio", tipo: "manual", config: {} }], arestas: [] },
    });
    await page.reload();
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
    await page.getByTestId(`abrir-editor-${fid}`).click();
    await expect(page.locator('.react-flow__node[data-id="inicio"]').first()).toBeVisible({ timeout: T(15000) });

    await page.getByRole("button", { name: "Executar", exact: true }).click();
    await esperarElementoTexto(page, "Disparar Execução");
    await page.getByRole("button", { name: "Disparar Agora" }).click();
    await expect(page.getByText(/exec_id exec-/).first()).toBeVisible({ timeout: T(15000) });
  });

  test("toggles de Ativo e Auto-agendar na lista atualizam sem erro 'nos: expected array'", async ({ page }) => {
    const fid = `flow-toggle-${Date.now().toString(36)}`;
    await api(page).post("/flows", {
      headers: HDR,
      data: {
        id: fid,
        nome: "Flow Toggle Test",
        nos: [{ id: "inicio", tipo: "manual", config: {} }],
        arestas: [],
        ativo: true,
      },
    });

    await page.reload();
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");

    const watcher = new ConsoleWatcher(page);
    watcher.start();

    // Filtra pelo fluxo criado
    await page.getByPlaceholder("Buscar por nome, id ou descrição...").fill(fid);
    await expect(page.getByText("Flow Toggle Test").first()).toBeVisible({ timeout: T(10000) });

    // Clica no toggle Ativo (que envia PUT /flows/:id com os dados do card)
    const toggleAtivo = page.locator(`[data-testid="toggle-ativo-${fid}"]`);
    await expect(toggleAtivo).toBeVisible({ timeout: T(5000) });
    await toggleAtivo.click();

    // Aguarda processamento
    await page.waitForTimeout(500);

    // Valida que nenhum toast de erro apareceu
    await expect(page.getByText(/campo "nos": Invalid input/i)).toHaveCount(0);
    await expect(page.getByText(/Sem conexão com o servidor/i)).toHaveCount(0);

    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });
});
