import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Web Config: abas, escopo, orçamento e chaves", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/config");
    await esperarElementoTexto(page, "Configurações & Governança do Sistema");
  });

  test("todas as abas abrem sem erro", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    for (const aba of ["Motores & Provedores", "Limites dos Motores", "Modelos", "Orçamento", "Segurança", "Scheduler", "Workspace", "Testes", "Reuniões", "Chaves de API & Secrets", "Ferramentas", "Geral"]) {
      await page.getByRole("button", { name: aba, exact: true }).click();
      await page.waitForTimeout(300);
    }
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("escopo workspace/global troca o indicador e recarrega", async ({ page }) => {
    await page.getByRole("button", { name: /Workspace:/ }).click();
    await esperarElementoTexto(page, "Escopo Workspace:");
    await page.getByRole("button", { name: "Global (Sistema)" }).click();
    await esperarElementoTexto(page, "Escopo Global:");
  });

  test("orçamento edita e persiste via API", async ({ page }) => {
    await page.goto("/config?tab=orcamento");
    await esperarElementoTexto(page, "Limites de Gasto & Orçamento Financeiro");
    const linha = page.getByTestId("setting-budget.daily_usd");
    await linha.locator('input[type="number"]').fill("7.5");
    await linha.getByRole("button").click();
    await expect.poll(async () => {
      const r = await api(page).get("/settings", { headers: HDR });
      const l = (await r.json()) as Array<{ chave: string; valor: any }>;
      return Number(l.find((s) => s.chave === "budget.daily_usd")?.valor);
    }, { timeout: 10000 }).toBe(7.5);
    await linha.locator('input[type="number"]').fill("5");
    await api(page).put("/settings", {
      headers: HDR,
      data: { chave: "budget.daily_usd", valor: 5, scope: "global" },
    });
  });

  test("chaves: salva e remove com confirm", async ({ page }) => {
    await page.goto("/config?tab=chaves");
    await esperarElementoTexto(page, "Chaves de API dos Motores de IA (BYOK)");
    await page.getByPlaceholder("sk-or-v1-... ou chave da API").fill("sk-or-v1-e2e-web-1234567890");
    await page.getByRole("button", { name: "Salvar Chave" }).click();
    await expect(page.getByText("openrouter").first()).toBeVisible({ timeout: 15000 });
    page.once("dialog", (d) => d.accept());
    await page.getByTestId("chave-openrouter").getByRole("button", { name: "Remover chave de openrouter" }).click();
    await expect(page.getByTestId("chave-openrouter")).toHaveCount(0, { timeout: 10000 });
  });
});
