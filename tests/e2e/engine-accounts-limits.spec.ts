import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

/** Gestão de contas e limites dos motores (servidor e2e isolado). */
test.describe("Motores — Contas e Limites", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("1. Gerencia contas do motor (adicionar, alternar ativa, limites, desconectar)", async ({ page }) => {
    const client = api(page);
    const pre = await client.get("/api/motores/antigravity/contas", { headers: HDR });
    if (pre.ok()) {
      const preContas = ((await pre.json()) as any).contas || [];
      for (const conta of preContas) {
        await client.delete(`/api/motores/antigravity/contas/${encodeURIComponent(conta.id)}`, { headers: HDR });
      }
    }

    const r1 = await client.post("/api/motores/antigravity/contas", {
      headers: HDR,
      data: { nome: "AGY Pessoal e2e", tokenOuChave: "tok-e2e-1", authType: "token", limits: { daily_cost_usd: 15, rate_limit_rpm: 30 } },
    });
    expect(r1.status()).toBe(201);
    const c1 = ((await r1.json()) as any).conta;
    expect(c1.motorId).toBe("antigravity");
    expect(c1.ativa).toBe(true);

    const r2 = await client.post("/api/motores/antigravity/contas", {
      headers: HDR,
      data: { nome: "AGY Corp e2e", tokenOuChave: "tok-e2e-2", authType: "token", limits: { daily_cost_usd: 50, rate_limit_rpm: 60 } },
    });
    expect(r2.status()).toBe(201);
    const c2 = ((await r2.json()) as any).conta;
    expect(c2.ativa).toBe(false);

    const ativa = await client.post(`/api/motores/antigravity/contas/${encodeURIComponent(c2.id)}/ativar`, { headers: HDR });
    expect(ativa.ok()).toBeTruthy();
    const lista = ((await (await client.get("/api/motores/antigravity/contas", { headers: HDR })).json()) as any).contas;
    expect(lista.find((c: any) => c.id === c1.id).ativa).toBe(false);
    expect(lista.find((c: any) => c.id === c2.id).ativa).toBe(true);

    const lim = await client.put(`/api/motores/antigravity/contas/${encodeURIComponent(c2.id)}/limites`, {
      headers: HDR,
      data: { daily_cost_usd: 80, rate_limit_rpm: 100, status_cota: "normal" },
    });
    expect(lim.ok()).toBeTruthy();
    expect(((await lim.json()) as any).conta.limits.daily_cost_usd).toBe(80);

    const del = await client.delete(`/api/motores/antigravity/contas/${encodeURIComponent(c1.id)}`, { headers: HDR });
    expect(del.ok()).toBeTruthy();
    const final = ((await (await client.get("/api/motores/antigravity/contas", { headers: HDR })).json()) as any).contas;
    expect(final.some((c: any) => c.id === c1.id)).toBe(false);
    expect(final.some((c: any) => c.id === c2.id)).toBe(true);
  });

  test("2. Salva e lê limites consolidados dos motores", async ({ page }) => {
    const client = api(page);
    const ini = await client.get("/api/motores/limites", { headers: HDR });
    expect(ini.ok()).toBeTruthy();
    const base = ((await ini.json()) as any).limites;
    expect(base.opencode).toBeDefined();
    expect(base.antigravity).toBeDefined();
    expect(base.copilot).toBeDefined();

    const salvar = await client.put("/api/motores/limites", {
      headers: HDR,
      data: { antigravity: { timeout_min: 18, daily_cost_usd: 25 }, copilot: { timeout_min: 22, daily_cost_usd: 15 } },
    });
    expect(salvar.ok()).toBeTruthy();
    const salvos = ((await salvar.json()) as any).limites;
    expect(salvos.antigravity.timeout_min).toBe(18);
    expect(salvos.copilot.timeout_min).toBe(22);
  });

  test("3. GET /status expõe motores, fallback e limites", async ({ page }) => {
    const res = await api(page).get("/status", { headers: HDR });
    expect(res.ok()).toBeTruthy();
    const status = await res.json();
    expect(status.motores).toBeDefined();
    expect(status.motores.motor_ativo).toBeDefined();
    expect(Array.isArray(status.motores.harness_fallback)).toBeTruthy();
    expect(Array.isArray(status.motores.motores)).toBeTruthy();
    const agy = status.motores.motores.find((m: any) => m.id === "antigravity");
    expect(agy).toBeDefined();
    expect(agy.limits).toBeDefined();
  });

  test("4. Tab Limites lista os motores com ações", async ({ page }) => {
    await page.goto("/config?tab=limites");
    const tab = page.locator("[data-testid='tab-limites-motores']");
    await expect(tab).toBeVisible({ timeout: T(15000) });
    await esperarElementoTexto(page, "Limites Operacionais & Quotas dos Motores");
    await expect(tab.getByRole("button", { name: /Salvar Todos/i })).toBeVisible();
    await expect(tab.getByText("OpenCode Engine", { exact: true }).first()).toBeVisible();
    await expect(tab.getByText("Google Antigravity Engine (AGY)", { exact: true }).first()).toBeVisible();
    await expect(tab.getByText("GitHub Copilot CLI", { exact: true }).first()).toBeVisible();
  });

  test("5. GET /api/motores/tokens retorna contrato com source por motor", async ({ page }) => {
    const res = await api(page).get("/api/motores/tokens", { headers: HDR });
    expect(res.ok()).toBeTruthy();
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.tokens).toBeDefined();
    for (const [id, t] of Object.entries<any>(data.tokens)) {
      expect(typeof t.source).toBe("string");
    }

  });
});
