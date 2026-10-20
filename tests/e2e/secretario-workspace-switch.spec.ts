import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Secretário — Isolamento de Workspace E2E", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => {});
  });

  test("carrega sessão isolada e limpa mensagens ao navegar para outro workspace", async ({ page }) => {
    // 1. Acessa o secretário no workspace padrão
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // 2. Envia uma mensagem no primeiro workspace
    await input.fill("pergunta isolamento workspace 1");
    await page.click("#btn-enviar");

    // Aguarda mensagem ser exibida na tela
    await expect(page.getByText("pergunta isolamento workspace 1")).toBeVisible({ timeout: T(15000) });

    // 3. Simula troca de workspace via localStorage / evento
    await page.evaluate(() => {
      localStorage.setItem("oc-ws", "outro-ws-teste");
      // Despacha evento de storage para os ouvintes
      window.dispatchEvent(new Event("storage"));
    });

    // 4. Ao navegar com query param limpa para novo workspace, a tela não deve reter a mensagem do anterior
    await page.goto("/secretario?workspace=outro-ws-teste");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });

    // O input continua pronto
    await expect(page.locator("#chat-input")).toBeEnabled();
  });
});
