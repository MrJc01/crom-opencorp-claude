import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Secretário — Resiliência e Auto-Recuperação E2E", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => {});
  });

  test("chat inicial pronto: input habilitado e sem indicador falso de processamento", async ({ page }) => {
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // Não deve exibir o indicador de carregamento perpétuo quando o chat está ocioso
    const spinner = page.getByText("Processando resposta com modelo livre...");
    await expect(spinner).not.toBeVisible();
  });

  test("envio e recebimento ponta a ponta sem bloqueio da UI", async ({ page }) => {
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });

    const input = page.locator("#chat-input");
    await input.fill("teste resiliencia e2e");
    await page.click("#btn-enviar");

    // Deve receber resposta do assistente
    await expect(page.locator(".oc-assistant").first()).toBeVisible({ timeout: T(15000) });

    // O campo de input deve voltar a ficar habilitado após a resposta
    await expect(input).toBeEnabled({ timeout: T(10000) });

    // Não deve ficar travado com spinner infinito
    const spinner = page.getByText("Processando resposta com modelo livre...");
    await expect(spinner).not.toBeVisible();
  });

  test("abort manual desativa estado de loading e libera a interface", async ({ page, request }) => {
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });

    // Envia uma mensagem
    const input = page.locator("#chat-input");
    await input.fill("teste abort e2e");
    await page.click("#btn-enviar");

    // Aguarda o turno ser iniciado
    await page.waitForTimeout(500);

    // Obtém lista de sessões para pegar a sessão ativa
    const sessResp = await request.get("/secretario/sessoes", {
      headers: { authorization: "Bearer test-e2e" },
    });
    if (sessResp.ok()) {
      const sessoes = await sessResp.json();
      if (Array.isArray(sessoes) && sessoes.length > 0) {
        const sid = sessoes[0].id;
        // Dispara abort na rota /secretario/sessoes/:id/abort
        const abortResp = await request.post(`/secretario/sessoes/${encodeURIComponent(sid)}/abort`, {
          headers: { authorization: "Bearer test-e2e" },
        });
        expect(abortResp.status()).toBe(200);
      }
    }

    // A interface deve permanecer responsiva com input habilitado
    await expect(input).toBeEnabled({ timeout: T(10000) });
  });
});
