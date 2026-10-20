import { test, expect, type Page } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";
import { T } from "./helpers.js";

// Cartão de aprovação (HITL) do Secretário com um motor conversacional de verdade (caminho do runtime):
// o `openheinerss` falso (tests/e2e/fixtures/bin/openheinerss, via OPENHEINERSS_BIN) pede aprovação quando a
// mensagem contém "permissão" e só segue depois de `session.permission_respond`.
const WS = "e2e-corp";
const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

async function definirMotor(page: Page, engineId: string): Promise<void> {
  const res = await api(page).put(`/settings?workspace=${WS}`, {
    headers: HDR,
    data: { chave: "default_conversation_engine", valor: engineId, scope: "workspace" },
  });
  expect(res.ok()).toBeTruthy();
}

const cartao = (page: Page) => page.getByRole("group", { name: "Solicitação de aprovação do motor" });

async function pedirPermissao(page: Page): Promise<void> {
  await page.goto("/secretario");
  await page.waitForSelector("#chat-input", { timeout: T(20000) });
  await page.locator("#chat-input").fill("preciso de permissão para o status e2e");
  await page.click("#btn-enviar");
  await expect(cartao(page).getByRole("button", { name: "Aprovar" })).toBeVisible({ timeout: T(20000) });
  await expect(cartao(page).getByRole("button", { name: "Rejeitar" })).toBeVisible();
}

// Sai para outra tela e volta: o cartão pendente continua com os botões (o turno não foi abortado).
async function sairEVoltar(page: Page): Promise<void> {
  await page.goto("/");
  await page.goto("/secretario");
  await page.waitForSelector("#chat-input", { timeout: T(20000) });
  await expect(cartao(page).getByRole("button", { name: "Aprovar" })).toBeVisible({ timeout: T(20000) });
}

test.describe("Secretário — cartão de aprovação do motor", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await definirMotor(page, "openheinerss");
  });

  test.afterEach(async ({ page }) => {
    await api(page).post("/secretario/stop", { headers: HDR }).catch(() => undefined);
    await definirMotor(page, "opencode").catch(() => undefined);
  });

  test("aprovar: pendente sobrevive à navegação; vira 'Aprovado.' e persiste após F5, com a resposta final", async ({ page }) => {
    await pedirPermissao(page);
    await sairEVoltar(page);

    await cartao(page).getByRole("button", { name: "Aprovar" }).click();
    await expect(cartao(page).getByText("Aprovado.")).toBeVisible({ timeout: T(15000) });
    await expect(cartao(page).getByRole("button")).toHaveCount(0);
    // A resposta final chega depois de a conexão original ser fechada (saímos da tela): só aparece pelo histórico (F5).

    await page.reload();
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
    await expect(cartao(page).getByText("Aprovado.")).toBeVisible({ timeout: T(20000) });
    await expect(page.getByRole("button", { name: "Aprovar" })).toHaveCount(0);
    await expect(page.getByText("Resposta: ").first()).toBeVisible({ timeout: T(20000) });
  });

  test("rejeitar: vira 'Rejeitado.' sem botões e persiste após F5", async ({ page }) => {
    await pedirPermissao(page);
    await sairEVoltar(page);

    await cartao(page).getByRole("button", { name: "Rejeitar" }).click();
    await expect(cartao(page).getByText("Rejeitado.")).toBeVisible({ timeout: T(15000) });
    await expect(cartao(page).getByRole("button")).toHaveCount(0);

    // A resposta final chega depois da aprovação, mas a conexão original já foi fechada ao sair da tela:
    // ela só aparece pelo histórico (F5).
    await page.reload();
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
    await expect(cartao(page).getByText("Rejeitado.")).toBeVisible({ timeout: T(20000) });
    await expect(page.getByRole("button", { name: "Rejeitar" })).toHaveCount(0);
  });
});
