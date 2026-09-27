import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

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
    await expect(page.locator(".not-card")).toHaveCount(1, { timeout: 15000 });
  });

  test("filtro Não lidas e Todas via URL sem erro", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.getByRole("button", { name: /Não lidas/ }).click();
    await expect(page.locator(".not-card")).toHaveCount(1);
    await page.getByRole("button", { name: /^Todas/ }).click();
    await expect(page.locator(".not-card")).toHaveCount(1);
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("excluir todas com confirm limpa a lista", async ({ page }) => {
    page.once("dialog", (d) => d.accept());
    await page.locator('button[title="Limpar todas as notificações"]').click();
    await expect(page.getByText("Nenhuma notificação registrada neste workspace.").first()).toBeVisible({ timeout: 10000 });
  });
});
