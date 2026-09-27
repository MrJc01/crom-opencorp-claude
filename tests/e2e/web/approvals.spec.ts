import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

async function semearAprovacao(page: import("@playwright/test").Page, ordem: string): Promise<string> {
  await api(page).put("/settings/security", {
    headers: HDR,
    data: { level: "standard", hitl_patterns: ["git push"] },
  });
  await api(page).post("/agents/executor-padrao/run", { headers: HDR, data: { ordem } });
  let id = "";
  await expect.poll(async () => {
    const r = await api(page).get("/approvals", { headers: HDR });
    const lista = (await r.json()) as Array<{ id: string; status: string }>;
    const p = lista.find((x) => x.status === "pendente");
    id = p?.id || "";
    return id;
  }, { timeout: 15000 }).not.toBe("");
  return id;
}

test.describe("Web Aprovações HITL: aprovar e rejeitar resolvem", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  test.afterEach(async ({ page }) => {
    // Restaura auto-aprovação para não contaminar outros specs (policy persiste no env e2e)
    await api(page).put("/settings/security", {
      headers: HDR,
      data: { level: "permissive", hitl_patterns: [] },
    }).catch(() => undefined);
  });

  test("aprovar pendência some da inicial (sem 500)", async ({ page }) => {
    const id = await semearAprovacao(page, `git push origin aprovar-web-${Date.now()}`);
    await page.reload();
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
    await esperarElementoTexto(page, "aprovação(ões) humana(s) pendente(s)");

    await page.getByRole("button", { name: "Aprovar" }).first().click();
    await expect.poll(async () => {
      const r = await api(page).get("/approvals", { headers: HDR });
      const lista = (await r.json()) as Array<{ id: string; status: string }>;
      return lista.find((x) => x.id === id)?.status;
    }, { timeout: 15000 }).toBe("aprovado");
  });

  test("rejeitar sem motivo resolve (sem 500, regression do motivo obrigatório)", async ({ page }) => {
    const id = await semearAprovacao(page, `git push origin rejeitar-web-${Date.now()}`);
    const rej = await api(page).post(`/approvals/${id}/reject`, { headers: HDR, data: {} });
    expect(rej.status()).toBe(200);
    expect((await rej.json()).status).toBe("rejeitado");

    await page.reload();
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
    await expect(page.getByText("aprovação(ões) humana(s) pendente(s)")).toHaveCount(0, { timeout: 15000 });
  });
});
