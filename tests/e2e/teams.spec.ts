import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

// Teams vivem em /agentes (Grupos de Agentes) e a migração legada segue via API.
test.describe("Teams / Grupos de Agentes", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
  });

  test("agentes lista o grupo semeado e2e-pipe", async ({ page }) => {
    const respTeams = page.waitForResponse(
      (r) => r.url().includes("/teams") && r.request().method() === "GET",
      { timeout: T(20000) },
    );
    await page.goto("/agentes");
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
    const res = await respTeams;
    expect(res.status()).toBe(200);
    await page.getByRole("button", { name: /^Equipes \d+/ }).click();
    await expect(page.getByText("ID: e2e-pipe").first()).toBeVisible({ timeout: T(15000) });
  });

  test("POST /flows/migrate-teams converte team legado em fluxo", async ({ page }) => {
    const r = await api(page).post("/flows/migrate-teams", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {},
    });
    expect([200, 201]).toContain(r.status());

    const lista = await api(page).get("/flows", {
      headers: { authorization: "Bearer test-e2e" },
    });
    const flows = await lista.json();
    expect(flows.some((f: any) => f.id === "e2e-pipe" || f.nome?.includes("e2e-pipe") || f.nome?.includes("Pipe E2E"))).toBe(true);
  });

  test("modal Nova Equipe oferece padrões Pipeline/Fan-out/Review/Debate", async ({ page }) => {
    await page.goto("/agentes");
    await esperarElementoTexto(page, "Catálogo de Agentes & Equipes Multi-Agente");
    await page.getByRole("button", { name: "Nova Equipe" }).click();
    await esperarElementoTexto(page, "Criar Nova Equipe Multi-Agente");
    for (const padrao of ["Pipeline", "Fan-out", "Review", "Debate"]) {
      const botao = page.getByRole("button", { name: new RegExp(padrao) }).first();
      await botao.click();
      await expect(botao).toHaveAttribute("aria-pressed", "true");
    }
  });
});
