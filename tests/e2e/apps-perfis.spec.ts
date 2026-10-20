import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Apps — Mini-Apps do workspace", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/apps");
    await esperarElementoTexto(page, "Mini-Apps");
  });

  test("criar mini-app pela UI → aparece na lista instalada", async ({ page }) => {
    const id = `mini-e2e-${Date.now().toString(36)}`;
    await page.getByRole("button", { name: "Novo Mini-App" }).first().click();
    await esperarElementoTexto(page, "Criar Novo Mini-App");

    await page.getByPlaceholder("Ex: painel-metricas ou lead-tracker").fill(id);
    await page.getByPlaceholder("Ex: Painel de Métricas do YouTube").fill(`Painel ${id}`);
    await page.getByRole("button", { name: "Criar Aplicação" }).click();

    await expect(page.getByText(`apps/${id}/index.html`).first()).toBeVisible({ timeout: T(15000) });

    await api(page).delete(`/apps/${id}`, { headers: HDR }).catch(() => undefined);
  });

  test("app semeado abre no modo app (iframe/preview)", async ({ page }) => {
    const card = page.getByTestId("app-card-painel-tarefas");
    await expect(card).toBeVisible({ timeout: T(15000) });
    await card.getByRole("button", { name: "Abrir App" }).click();
    await page.waitForTimeout(1000);
    await expect(page.getByText("Painel de Tarefas").first()).toBeVisible({ timeout: T(10000) });
  });

  test("via API: GET /secrets lista nome/tipo_app mas NUNCA o valor", async ({ page }) => {
    const valor = JSON.stringify({ rotulo: "Perfil API e2e", host: "198.51.100.7", usuario: "root", senha: "senha-super-secreta-e2e-xyz" });
    const put = await api(page).put("/secrets/app%3Avps%3Ae2e-api", {
      headers: HDR,
      data: JSON.stringify({ valor }),
    });
    expect(put.status()).toBe(200);

    try {
      const resp = await api(page).get("/secrets", { headers: HDR });
      expect(resp.status()).toBe(200);
      const corpo = await resp.text();
      const lista = JSON.parse(corpo) as Array<{ nome: string; tipo_app: string | null }>;
      const entrada = lista.find((s) => s.nome === "app:vps:e2e-api");
      expect(entrada).toBeDefined();
      expect(entrada!.tipo_app).toBe("vps");
      expect(corpo).not.toContain("senha-super-secreta-e2e-xyz");
      expect(corpo).not.toContain("198.51.100.7");
    } finally {
      await api(page).delete("/secrets/app%3Avps%3Ae2e-api", { headers: HDR }).catch(() => undefined);
    }
  });
});
