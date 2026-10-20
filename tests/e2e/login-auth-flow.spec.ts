import { test, expect } from "@playwright/test";
import { T } from "./helpers.js";

test.describe("E2E — Fluxo de Autenticação e Modal de Login", () => {

  test("quando não autenticado (401), deve exibir o modal de login acessível", async ({ page }) => {
    // Intercepta /workspaces para simular servidor protegido que requer token
    await page.route("**/workspaces*", (route) => {
      const auth = route.request().headers()["authorization"];
      if (!auth || auth !== "Bearer token-secreto-valido") {
        return route.fulfill({ status: 401, json: { erro: "Acesso não autorizado — informe o token" } });
      }
      return route.fulfill({ status: 200, json: [] });
    });

    await page.goto(`/home`);
    await page.waitForTimeout(1000);

    // Modal de login deve estar visível
    const loginScreen = page.locator("#login-screen");
    await expect(loginScreen).toBeVisible({ timeout: T(5000) });
    await expect(page.locator("#login-token")).toBeVisible();
    await expect(page.locator("#login-btn")).toBeVisible();
  });

  test("token inválido deve exibir mensagem de erro amigável", async ({ page }) => {
    await page.route("**/workspaces*", (route) => {
      return route.fulfill({ status: 401, json: { erro: "Token inválido" } });
    });

    await page.goto(`/home`);
    await page.waitForTimeout(1000);

    await page.fill("#login-token", "token-incorreto-123");
    await page.click("#login-btn");

    const erro = page.locator("#login-error");
    await expect(erro).toBeVisible({ timeout: T(5000) });
    await expect(erro).toContainText("Token inválido");
  });

  test("token válido deve autenticar com sucesso e liberar acesso ao sistema", async ({ page }) => {
    // Mock amplo: com o token válido, TODA a API responde (o app dispara
    // dezenas de fetches de fundo após o login; qualquer 401 real reabriria
    // o modal e o teste viraria corrida).
    await page.route("**/*", (route) => {
      const url = new URL(route.request().url());
      // Documentos e assets estáticos sempre passam (são públicos)
      if (route.request().resourceType() === "document") return route.continue();
      if (/\.[a-z0-9]+$/i.test(url.pathname)) return route.continue();
      if (url.pathname === "/events") return route.abort();
      const auth = route.request().headers()["authorization"];
      if (auth !== "Bearer token-secreto-valido") {
        return route.fulfill({ status: 401, json: { erro: "Não autorizado" } });
      }
      if (url.pathname === "/workspaces") {
        return route.fulfill({ status: 200, json: [{ id: "ws-principal", path: "/tmp/ws" }] });
      }
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.goto(`/home`);
    await page.waitForTimeout(1000);

    await page.fill("#login-token", "token-secreto-valido");
    await page.click("#login-btn");

    // Modal de login deve sumir e permanecer fora
    await expect(page.locator("#login-screen")).toBeHidden({ timeout: T(5000) });
    await page.waitForTimeout(3000);
    await expect(page.locator("#login-screen")).toBeHidden({ timeout: T(5000) });

    // Verifica que o token foi gravado no localStorage
    const savedToken = await page.evaluate(() => localStorage.getItem("oc-token"));
    expect(savedToken).toBe("token-secreto-valido");
  });
});
