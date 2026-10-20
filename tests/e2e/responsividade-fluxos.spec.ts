import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Responsividade do Studio de Fluxos", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await api(page).post("/flows", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "flow-resp-test",
        nome: "Pipeline Responsivo",
        nos: [
          { id: "inicio", tipo: "manual", config: {} },
          { id: "saida", tipo: "registro", config: { categoria: "documentos" } },
        ],
        arestas: [{ de: "inicio", para: "saida" }],
      },
    });
    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
  });

  async function abrirCanvas(page: import("@playwright/test").Page) {
    await page.getByPlaceholder("Buscar por nome, id ou descrição...").fill("flow-resp-test");
    const btnAbrir = page.getByTestId("abrir-editor-flow-resp-test");
    await expect(btnAbrir).toBeVisible({ timeout: T(15000) });
    await btnAbrir.click();
    await expect(page.locator('.react-flow__node[data-id="inicio"]').first()).toBeVisible({ timeout: T(15000) });
  }

  test("Desktop (1280x800) — toolbar, canvas e NDV", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await abrirCanvas(page);

    // A visão dividida Chat/Canvas foi removida na UI React (ver pendências).
    await expect(page.getByRole("button", { name: "Executar", exact: true })).toBeVisible();
    await expect(page.getByTitle("Abrir paleta de nós")).toBeVisible();
    await page.screenshot({ path: "test-results/resp-desktop-1280-canvas.png" });

    await page.locator('.react-flow__node[data-id="inicio"]').first().click();
    const ndv = page.getByTestId("ndv-panel");
    await expect(ndv).toBeVisible();
    await page.screenshot({ path: "test-results/resp-desktop-1280-ndv.png" });
  });

  test("Mobile (375x667) — canvas e NDV cabem na tela", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await abrirCanvas(page);

    await expect(page.getByTitle("Abrir paleta de nós")).toBeVisible();
    await page.screenshot({ path: "test-results/resp-mobile-375-canvas.png" });

    await page.locator('.react-flow__node[data-id="inicio"]').first().click();
    const ndv = page.getByTestId("ndv-panel");
    await expect(ndv).toBeVisible();
    const box = await ndv.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    await page.screenshot({ path: "test-results/resp-mobile-375-ndv.png" });
  });
});
