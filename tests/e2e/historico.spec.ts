import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Histórico", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/historico");
    await esperarElementoTexto(page, "Identificador / Ordem");
  });

  test("timeline mostra itens (task semeada gera badge TASK)", async ({ page }) => {
    const linha = page.locator("tr[data-tipo='task']", { hasText: "Task backlog e2e" }).first();
    await expect(linha).toBeVisible({ timeout: T(15000) });
  });

  test("filtro Tasks mostra só tasks", async ({ page }) => {
    await page.getByRole("button", { name: "Kanban" }).click();
    await expect(page.locator("tr[data-tipo='task']").first()).toBeVisible({ timeout: T(10000) });
    await expect(page.locator("tr[data-tipo]:not([data-tipo='task'])")).toHaveCount(0);
  });

  test("filtro Fluxos lista execução de fluxo com nós", async ({ page }) => {
    await api(page).post("/flows", {
      headers: HDR,
      data: {
        id: "flow-hist-spec",
        nome: "Flow Hist Spec",
        nos: [
          { id: "inicio", tipo: "manual", config: {} },
          { id: "gravar", tipo: "registro", config: { categoria: "documentos" } },
        ],
        arestas: [{ de: "inicio", para: "gravar" }],
      },
    });
    const run = await api(page).post("/flows/flow-hist-spec/run", {
      headers: HDR,
      data: { entrada: "spec-historico" },
    });
    expect(run.status()).toBe(202);
    const { exec_id: execId } = await run.json();

    await page.getByRole("button", { name: "Fluxos DAG" }).click();
    await expect(page.locator("tr[data-tipo='fluxo']").first()).toBeVisible({ timeout: T(15000) });
    await expect(page.getByText(execId).first()).toBeVisible({ timeout: T(15000) });
  });
});
