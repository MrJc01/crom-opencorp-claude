import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Config — Motores, autenticação e provedores", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("exibe os 8 motores de agentes autônomos", async ({ page }) => {
    await page.goto("/config?tab=motores");
    for (const id of ["opencode", "crom-agente", "claude-code", "antigravity", "cursor", "copilot", "codex", "aider"]) {
      await expect(page.locator(`button[data-engine-id='${id}']`).first()).toBeVisible({ timeout: T(15000) });
    }
  });

  test("abre o modal de autenticação a partir do motor selecionado", async ({ page }) => {
    await page.goto("/config?tab=motores");
    await page.locator("button[data-engine-id='claude-code']").click();

    await page.getByRole("button", { name: /Autenticar \/ Conectar|Adicionar Conta/i }).first().click();
    await expect(page.getByRole("heading", { name: "Autenticar: Claude Code" })).toBeVisible({ timeout: T(10000) });

    await page.getByRole("button", { name: "Terminal CLI" }).click();
    await expect(page.getByText(/\$ claude (auth )?login/).first()).toBeVisible();

    await page.getByRole("button", { name: "Token / Chave Manual" }).click();
    await expect(page.getByText("ANTHROPIC_API_KEY").first()).toBeVisible();

    await page.getByTitle("Fechar modal").click();
    await expect(page.getByRole("heading", { name: "Autenticar: Claude Code" })).toHaveCount(0);
  });

  test("provedores contextuais do motor selecionado (OpenCode universais)", async ({ page }) => {
    await page.goto("/config?tab=motores");
    await page.locator("button[data-engine-id='opencode']").click();
    await page.getByRole("button", { name: /Autenticar \/ Conectar|Adicionar Conta/i }).first().click();
    // Provedores universais do OpenCode aparecem no seletor de provedor.
    await expect(page.locator("option", { hasText: "OpenRouter (Universal & BYOK)" })).toHaveCount(1, { timeout: T(10000) });
    await expect(page.locator("option", { hasText: "Google AI Studio / Gemini" })).toHaveCount(1);
    await page.getByTitle("Fechar modal").click();
  });

  test("alterna para Chaves de API e Modelos sem erros", async ({ page }) => {
    await page.goto("/config?tab=motores");
    await page.getByRole("button", { name: "Chaves de API & Secrets" }).click();
    await esperarElementoTexto(page, "Chaves de API dos Motores de IA (BYOK)");

    await page.getByRole("button", { name: /^Modelos$/i }).click();
    await esperarElementoTexto(page, "Modelo Padrão");
  });
});
