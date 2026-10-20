import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "../helpers.js";
import { T } from "../helpers.js";

/**
 * E2E — F3-T01: gramática @ vs / vs ! (menções e comandos)
 *
 * Cobertura:
 * (a) /status no início dispara ação (não vira mensagem ao LLM)
 * (b) @arquivo hidrata conteúdo real do arquivo no contexto
 * (c) @agente troca o destinatário (campo `agente` do corpo)
 * (d) @prompt:chave injeta texto editável no input
 * (e) comando / não-whitelistado responde ajuda (não cai no LLM)
 */

const AUTH = { authorization: "Bearer test-e2e", "content-type": "application/json" };
const WS = "e2e-corp";

test.describe("Web Menções e Comandos (@ / !)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", WS);
    await seederEmpresaBasica(api(page), "test-e2e", WS);
    // O secretário (fake opencode) precisa estar de pé para o caminho LLM (b/c).
    await page.request.post("/secretario/start", { headers: AUTH }).catch(() => {});
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => {});
  });

  test("(a) /status no início dispara ação (não vira mensagem ao LLM)", async ({ page }) => {
    const resp = await page.request.post(`/secretario/conversa?workspace=${WS}`, {
      headers: AUTH,
      data: { mensagem: "/status" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
    expect(body.resposta).toContain("Status do workspace");
    expect(body.resposta).not.toContain("Resposta do assistant");
  });

  test("(b) @arquivo hidrata conteúdo real do arquivo no contexto", async ({ page }) => {
    const marcador = `marcador-contexto-e2e-${Date.now()}`;
    await page.request.post(`/files?workspace=${WS}`, {
      headers: AUTH,
      data: { path: "contexto-e2e.txt", conteudo: `conteudo ${marcador}\n`, tipo: "arquivo" },
    });

    const resp = await page.request.post(`/secretario/conversa?workspace=${WS}`, {
      headers: AUTH,
      data: { mensagem: "explique @arquivo:contexto-e2e.txt" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.resposta).toContain(marcador);
    expect(body.resposta).toContain("Fonte: arquivo");
  });

  test("(c) @agente troca o destinatário (campo agente)", async ({ page }) => {
    const resp = await page.request.post(`/secretario/conversa?workspace=${WS}`, {
      headers: AUTH,
      data: { mensagem: "olá @agente:executor-padrao", agente: "secretario-exec" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.agente).toBe("executor-padrao");
  });

  test("(d) @prompt:chave injeta texto editável no input", async ({ page }) => {
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
    const input = page.locator("#chat-input");
    await input.fill("@prompt:minha-chave");

    // Seleciona o item da seção Prompt no autocomplete.
    const item = page.getByText("@prompt:minha-chave", { exact: false }).first();
    await item.waitFor({ state: "visible", timeout: T(10000) }).catch(() => undefined);
    await item.click();

    await expect(input).toHaveValue(/@prompt:minha-chave/);
    // É texto editável (não vira chip nem pill).
    await expect(page.locator('[data-testid="mention-chip-task"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="mention-agente-pill"]')).toHaveCount(0);
  });

  test("(e) comando / não-whitelistado responde ajuda (não cai no LLM)", async ({ page }) => {
    const resp = await page.request.post(`/secretario/conversa?workspace=${WS}`, {
      headers: AUTH,
      data: { mensagem: "/nao-existe" },
    });
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.resposta).toContain("não reconhecido");
    expect(body.resposta).toContain("/help");
    expect(body.resposta).not.toContain("Resposta do assistant");
  });
});
