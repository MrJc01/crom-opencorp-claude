import { test, expect, type Page } from "@playwright/test";
import { logado, esperarNavegacao } from "./helpers.js";
import { T } from "./helpers.js";

/** Etapa 7 (P-24) — notificações: página, badge no navbar, marcar lida e filtro.
 *  Determinístico: 100% via API do painel (sem fake opencode), seed limpo por teste. */

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };
const WS = "?workspace=e2e-corp";

async function seedNotificacoes(page: Page, itens: Array<{ titulo: string; tipo?: string }>): Promise<string[]> {
  const ids: string[] = [];
  for (const item of itens) {
    const resp = await page.request.post(`/notifications${WS}`, { headers: HDR, data: { titulo: item.titulo, corpo: `corpo de ${item.titulo}`, tipo: item.tipo ?? "resumo", origem: "e2e" } });
    expect(resp.status(), `seed ${item.titulo}`).toBe(201);
    ids.push(((await resp.json()) as { id: string }).id);
  }
  return ids;
}

test.describe("Notificações", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    // limpa o feed do workspace (seed determinístico)
    await page.request.delete(`/notifications${WS}`, { headers: HDR });
  });

  test("(a) seed 2 via API → página mostra 2 cards e badge '2' no navbar", async ({ page }) => {
    await seedNotificacoes(page, [{ titulo: "Resumo do blog" }, { titulo: "Vendas do dia" }]);
    await page.goto("/");
    await esperarNavegacao(page, "home");

    await page.click("#btn-notificacoes-topbar");
    await page.waitForURL(/\/notificacoes/);
    await esperarNavegacao(page, "notificacoes");

    await expect(page.locator(".not-card")).toHaveCount(2, { timeout: T(10000) });
    const badge = page.locator("#nav-badge-notificacoes");
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText("2");
  });

  test("(b) marcar 1 lida → badge '1' e card perde o destaque", async ({ page }) => {
    const [idA] = await seedNotificacoes(page, [{ titulo: "Para marcar" }, { titulo: "Fica não lida" }]);
    await page.goto("/#/notificacoes");
    await esperarNavegacao(page, "notificacoes");
    await expect(page.locator(".not-card")).toHaveCount(2, { timeout: T(10000) });

    const cardA = page.locator(`.not-card[data-not-id="${idA}"]`);
    await expect(cardA).toHaveClass(/nao-lida/);
    await cardA.getByRole("button", { name: "Marcar como lida" }).click();

    await expect(page.locator("#nav-badge-notificacoes")).toHaveText("1", { timeout: T(10000) });
    await expect(page.locator(`.not-card[data-not-id="${idA}"]`)).toHaveAttribute("data-lida", "true");
    await expect(page.locator(`.not-card[data-not-id="${idA}"]`)).not.toHaveClass(/nao-lida/);
  });

  test("(c) marcar todas como lidas → badge some", async ({ page }) => {
    await seedNotificacoes(page, [{ titulo: "Uma" }, { titulo: "Duas" }]);
    await page.goto("/#/notificacoes");
    await esperarNavegacao(page, "notificacoes");
    await expect(page.locator("#nav-badge-notificacoes")).toHaveText("2", { timeout: T(10000) });

    await page.click("button:has-text('Marcar todas como lidas')");
    await expect(page.locator("#nav-badge-notificacoes")).toBeHidden({ timeout: T(10000) });
    await expect(page.locator(".not-card.nao-lida")).toHaveCount(0);
  });

  test("(d) filtro 'Não lidas' esconde as lidas", async ({ page }) => {
    const [idA] = await seedNotificacoes(page, [{ titulo: "Vai ser lida" }, { titulo: "Continua pendente" }]);
    await page.request.post(`/notifications/${idA}/lida${WS}`, { headers: HDR });

    await page.goto("/#/notificacoes");
    await esperarNavegacao(page, "notificacoes");
    await expect(page.locator(".not-card")).toHaveCount(2, { timeout: T(10000) });

    await page.click("#not-filtro-nao-lidas");
    await expect(page.locator(".not-card")).toHaveCount(1);
    await expect(page.locator(".not-card.nao-lida")).toHaveCount(1);
    await expect(page.locator(".not-card.nao-lida")).toContainText("Continua pendente");

    await page.click("#not-filtro-todas");
    await expect(page.locator(".not-card")).toHaveCount(2);
  });
});
