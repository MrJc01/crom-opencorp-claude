import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

test.describe("Config / Settings", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/config");
    await esperarElementoTexto(page, "Configurações & Governança do Sistema");
  });

  test("abre com as 12 abas da central", async ({ page }) => {
    for (const aba of ["Motores & Provedores", "Limites dos Motores", "Modelos", "Orçamento", "Segurança", "Scheduler", "Workspace", "Testes", "Reuniões", "Chaves de API & Secrets", "Ferramentas", "Geral"]) {
      await expect(page.getByRole("button", { name: aba }).first()).toBeVisible();
    }
  });

  test("get/set budget.daily_usd via UI reflete no GET /settings", async ({ page }) => {
    await page.goto("/config?tab=orcamento");
    await esperarElementoTexto(page, "Limites de Gasto & Orçamento Financeiro");

    const linha = page.getByTestId("setting-budget.daily_usd");
    const input = linha.locator('input[type="number"]');
    await expect(input).toBeVisible({ timeout: 10000 });
    await input.fill("9.25");
    // botão de salvar (Check) aparece ao modificar
    await linha.getByRole("button").click();

    await page.waitForTimeout(800);
    const resp = await page.request.get("/settings", { headers: { authorization: "Bearer test-e2e" } });
    const settings = await resp.json();
    const lista = Array.isArray(settings) ? settings : (settings.dados ?? []);
    const budget = lista.find((s: { chave: string }) => s.chave === "budget.daily_usd");
    expect(Number(budget?.valor)).toBe(9.25);
  });

  test("campo bool salva na interação (toggle budget.pause_on_exceed)", async ({ page }) => {
    await page.goto("/config?tab=orcamento");
    await esperarElementoTexto(page, "Pausar Agentes ao Estourar");

    const linha = page.getByTestId("setting-budget.pause_on_exceed");
    const toggle = linha.getByRole("switch");
    await expect(toggle).toBeVisible({ timeout: 10000 });

    const antesResp = await page.request.get("/settings?escopo=global", { headers: { authorization: "Bearer test-e2e" } });
    const antesJson = await antesResp.json();
    const listaAntes = Array.isArray(antesJson) ? antesJson : (antesJson.dados ?? []);
    const antes = listaAntes.find((s: { chave: string }) => s.chave === "budget.pause_on_exceed")?.valor;

    await toggle.click();
    await page.waitForTimeout(1000);

    const depoisResp = await page.request.get("/settings?escopo=global", { headers: { authorization: "Bearer test-e2e" } });
    const depoisJson = await depoisResp.json();
    const listaDepois = Array.isArray(depoisJson) ? depoisJson : (depoisJson.dados ?? []);
    const depois = listaDepois.find((s: { chave: string }) => s.chave === "budget.pause_on_exceed")?.valor;
    expect(depois).toBe(!antes);

    await toggle.click(); // restaura
    await page.waitForTimeout(1000);
  });

  test("toggle de escopo injeta ?escopo= na request e troca o indicador", async ({ page }) => {
    const escopos: string[] = [];
    await page.route("**/settings*", (route) => {
      if (route.request().method() === "GET") {
        escopos.push(new URL(route.request().url()).searchParams.get("escopo") ?? "(sem)");
      }
      void route.continue();
    });

    await page.goto("/config");
    await esperarElementoTexto(page, "Escopo Global:");

    await page.getByRole("button", { name: /Workspace:/ }).click();
    await esperarElementoTexto(page, "Escopo Workspace:");
    expect(escopos).toContain("workspace");

    await page.getByRole("button", { name: "Global (Sistema)" }).click();
    await esperarElementoTexto(page, "Escopo Global:");
    expect(escopos).toContain("global");
  });

  test("aba Chaves: lista mockada exibe provider e preview sem vazar segredo", async ({ page }) => {
    await page.route((url) => url.pathname.endsWith("/provider-keys"), async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          global: { existe: true, chaves: [{ provider: "openrouter", tipo: "api", preview: "sk-or-v…Xyz9" }] },
          workspace: { id: "e2e-corp", existe: false, chaves: [] },
        }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true }) });
    });

    await page.goto("/config?tab=chaves");
    await esperarElementoTexto(page, "Chaves de API dos Motores de IA (BYOK)");
    await expect(page.getByText("openrouter").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("sk-or-v…Xyz9").first()).toBeVisible();
  });
});
