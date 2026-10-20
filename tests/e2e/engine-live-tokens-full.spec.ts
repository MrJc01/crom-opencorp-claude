import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };
const MOTORES = ["opencode", "crom-agente", "copilot", "antigravity", "claude-code", "cursor", "codex", "aider"];

/** Tokens e quotas dos adaptadores (servidor e2e isolado; sem credenciais reais). */
test.describe("Motores — Tokens e Quotas ao Vivo", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("1. GET /api/motores/tokens retorna os 8 motores com contrato", async ({ page }) => {
    const res = await api(page).get("/api/motores/tokens", { headers: HDR });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    for (const id of MOTORES) {
      const tok = body.tokens[id];
      expect(tok, `Motor ${id} presente`).toBeDefined();
      expect(tok.motorId).toBe(id);
      expect(typeof tok.mensagem).toBe("string");
      expect(tok.consultadoEm).toBeDefined();
      expect(["api_live", "cli_live", "oauth_session", "unconfigured", "error"]).toContain(tok.source);
    }
  });

  test("2. Tokens por motor (copilot e opencode) com contrato", async ({ page }) => {
    for (const id of ["copilot", "opencode"]) {
      const res = await api(page).get(`/api/motores/${id}/tokens`, { headers: HDR });
      expect(res.ok()).toBeTruthy();
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.tokens.motorId).toBe(id);
      expect(typeof data.tokens.source).toBe("string");
    }
  });

  test("3. Conta temporária: cria, consulta tokens e limpa", async ({ page }) => {
    const client = api(page);
    const add = await client.post("/api/motores/antigravity/contas", {
      headers: HDR,
      data: { nome: "Conta e2e tokens", tokenOuChave: "dummy-e2e", authType: "token", limits: { daily_cost_usd: 20, rate_limit_rpm: 30 } },
    });
    expect(add.status()).toBe(201);
    const conta = ((await add.json()) as any).conta;

    const tok = await client.get(`/api/motores/antigravity/contas/${encodeURIComponent(conta.id)}/tokens`, { headers: HDR });
    expect(tok.ok()).toBeTruthy();
    const data = await tok.json();
    expect(data.ok).toBe(true);
    expect(data.motorId).toBe("antigravity");
    expect(data.contaId).toBe(conta.id);
    expect(data.tokens).toBeDefined();

    const del = await client.delete(`/api/motores/antigravity/contas/${encodeURIComponent(conta.id)}`, { headers: HDR });
    expect(del.ok()).toBeTruthy();
  });

  test("4. Aba limites exibe os motores e a ação de salvar", async ({ page }) => {
    await page.goto("/config?tab=limites");
    const container = page.locator("[data-testid='tab-limites-motores']");
    await expect(container).toBeVisible({ timeout: T(15000) });
    await expect(container.getByRole("button", { name: /Salvar Todos/i })).toBeVisible();
    await expect(container.getByText("OpenAI Codex CLI", { exact: true }).first()).toBeVisible();
  });

  // A UI React não exibe mais quotas ao vivo (removidas em 9ad8e1e); o contrato
  // de /api/motores/tokens segue coberto pelos testes 1–3.
  test("5. Aba motores exibe o painel do motor com diagnóstico", async ({ page }) => {
    await page.goto("/config?tab=motores");
    await expect(page.getByRole("heading", { name: "Motores de Inferência & Provedores BYOK" })).toBeVisible({ timeout: T(15000) });
    await expect(page.getByRole("button", { name: "Diagnóstico rápido" }).first()).toBeVisible();
  });
});
