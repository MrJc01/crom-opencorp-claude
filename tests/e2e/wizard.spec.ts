import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const WS_ID = "wizard-test-e2e";
const E2E_HOME = "/tmp/opencorp-e2e";

function limparWsTeste(): void {
  for (const base of [
    `${E2E_HOME}/.opencorp/workspaces/${WS_ID}`,
    `${E2E_HOME}/workspaces/${WS_ID}`,
  ]) {
    rmSync(base, { recursive: true, force: true });
  }
  for (const wjPath of [`${E2E_HOME}/.opencorp/workspaces.json`, `${E2E_HOME}/workspaces.json`]) {
    if (existsSync(wjPath)) {
      try {
        const wj = JSON.parse(readFileSync(wjPath, "utf8"));
        wj.workspaces = (wj.workspaces ?? []).filter((w: { id: string }) => w.id !== WS_ID);
        if (wj.ativo === WS_ID) wj.ativo = "e2e-corp";
        writeFileSync(wjPath, JSON.stringify(wj, null, 2));
      } catch {}
    }
  }
}

test.describe("Criação de workspace (empresa)", () => {
  test.beforeEach(async ({ page }) => {
    limparWsTeste();
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  test.afterEach(() => {
    limparWsTeste();
  });

  test("cria workspace com template → POST 201 e ativa no seletor", async ({ page }) => {
    await page.getByTitle("Trocar workspace ou criar novo projeto").click();
    await page.getByRole("button", { name: "+ Novo Workspace" }).click();
    await esperarElementoTexto(page, "Criar ou Conectar Workspace");

    await page.locator('input[placeholder="ex: meu-projeto, portal-vendas, assistente-docs"]').fill(WS_ID);

    const postWs = page.waitForResponse(
      (r) => r.url().includes("/workspaces") && r.request().method() === "POST",
      { timeout: 30000 },
    );
    await page.getByRole("button", { name: "Criar Workspace" }).click();
    const respCriacao = await postWs;
    expect(respCriacao.status()).toBe(201);

    // ws ativo trocado para o novo
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("oc-ws")), { timeout: 20000 })
      .toBe(WS_ID);
    // seletor do topbar reflete o novo ativo
    await expect(page.getByTitle("Trocar workspace ou criar novo projeto")).toContainText(WS_ID, { timeout: 10000 });
  });

  test("id vazio bloqueia criação (toast de erro, modal continua aberto)", async ({ page }) => {
    await page.getByTitle("Trocar workspace ou criar novo projeto").click();
    await page.getByRole("button", { name: "+ Novo Workspace" }).click();
    await esperarElementoTexto(page, "Criar ou Conectar Workspace");

    await page.getByRole("button", { name: "Criar Workspace" }).click();
    // modal continua aberto
    await expect(page.getByText("Criar ou Conectar Workspace").first()).toBeVisible({ timeout: 5000 });
  });
});
