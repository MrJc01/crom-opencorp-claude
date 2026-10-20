import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Web Notificações: filtros, excluir e console limpo", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await api(page).delete("/notifications?workspace=e2e-corp", { headers: HDR }).catch(() => undefined);
    await api(page).post("/notifications?workspace=e2e-corp", {
      headers: HDR,
      data: { titulo: "Web resumo e2e", corpo: "corpo web", tipo: "resumo", origem: "e2e" },
    });
    await page.goto("/notificacoes");
    await esperarElementoTexto(page, "Central de Alertas & Notificações");
    await expect(page.locator(".not-card")).toHaveCount(1, { timeout: T(15000) });
  });

  test("filtro Não lidas e Todas via URL sem erro", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.locator("#not-filtro-nao-lidas").click();
    await expect(page.locator(".not-card")).toHaveCount(1);
    await page.locator("#not-filtro-todas").click();
    await expect(page.locator(".not-card")).toHaveCount(1);
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("excluir todas com confirm limpa a lista", async ({ page }) => {
    page.once("dialog", (d) => d.accept());
    await page.getByTitle("Limpar histórico").click();
    await expect(page.getByText("Nenhuma notificação registrada no momento.").first()).toBeVisible({ timeout: T(10000) });
  });
});
