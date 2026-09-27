import { test, expect } from "@playwright/test";
import { logado, esperarElementoTexto } from "./helpers.js";

/**
 * Workspace estilo VS Code: explorador, editor com salvar e terminais.
 */
const WS = "ws-arquivos";
const AUTH = { authorization: "Bearer test-e2e", "content-type": "application/json" };
const ARQ = ".opencorp/projeto.json";

test.describe("View Workspace", () => {
  test.beforeAll(async ({ request }) => {
    await request.post("/workspaces", {
      headers: AUTH,
      data: { id: WS, perfil: { empresa: "E2E Files", nicho: "teste" } },
    }).catch(() => {});
    await request.put(`/files?workspace=${WS}&path=${encodeURIComponent(ARQ)}`, {
      headers: AUTH,
      data: { conteudo: '{\n  "empresa": "E2E Files",\n  "nicho": "teste"\n}\n' },
    }).catch(() => {});
  });

  async function irParaWorkspace(page: import("@playwright/test").Page): Promise<void> {
    await logado(page, "test-e2e", WS);
    await page.goto("/workspace");
    await esperarElementoTexto(page, "Buscar (Ctrl+P)");
  }

  async function abrirProjeto(page: import("@playwright/test").Page): Promise<void> {
    await irParaWorkspace(page);
    await page.getByText(".opencorp", { exact: true }).first().click();
    await expect(page.getByText("projeto.json", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  }

  test("(a) árvore lista os arquivos semeados do workspace", async ({ page }) => {
    await irParaWorkspace(page);
    const dir = page.getByText(".opencorp", { exact: true }).first();
    await expect(dir).toBeVisible({ timeout: 10000 });
    await dir.click();
    await expect(page.getByText("projeto.json", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("agents", { exact: true }).first()).toBeVisible();
  });

  test("(b) abrir projeto.json → tab com conteúdo no editor e salvar desabilitado", async ({ page }) => {
    await abrirProjeto(page);
    await page.getByText("projeto.json", { exact: true }).first().click();

    await expect(page.getByText(".opencorp/projeto.json").first()).toBeVisible({ timeout: 10000 });
    const editor = page.locator("textarea").first();
    await expect(editor).toHaveValue(/E2E Files/, { timeout: 10000 });
    await expect(page.getByTitle("Salvar alterações (Ctrl+S)")).toBeDisabled();
  });

  test("(c) editar + Salvar → PUT grava no server e marca some", async ({ page }) => {
    await abrirProjeto(page);
    await page.getByText("projeto.json", { exact: true }).first().click();
    const editor = page.locator("textarea").first();
    await expect(editor).toHaveValue(/E2E/, { timeout: 10000 });

    await editor.fill('{\n  "empresa": "E2E Editada",\n  "nicho": "teste"\n}\n');
    await expect(page.getByTitle("Alterações não salvas").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByTitle("Salvar alterações (Ctrl+S)")).toBeEnabled();

    await page.getByTitle("Salvar alterações (Ctrl+S)").click();
    await expect(page.getByTitle("Alterações não salvas")).toHaveCount(0, { timeout: 10000 });

    const resp = await page.request.get(`/files?workspace=${WS}&path=${encodeURIComponent(ARQ)}`, {
      headers: { authorization: "Bearer test-e2e" },
    });
    expect(resp.status()).toBe(200);
    const body = (await resp.json()) as { conteudo: string };
    expect(body.conteudo).toContain("E2E Editada");
  });

  test("(d) terminal: 'task list' (whitelist) ok e comando fora mostra erro", async ({ page }) => {
    await irParaWorkspace(page);
    await expect(page.getByText("Terminal 1").first()).toBeVisible({ timeout: 10000 });

    const input = page.locator('input[placeholder="Digite um comando (ex: tasks list, doctor, flow list)..."]');
    await input.fill("task list");
    await input.press("Enter");
    await expect(page.getByText("ws$ task list").first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText("[ok]").first()).toBeVisible({ timeout: 20000 });

    await input.fill("rm -rf /");
    await input.press("Enter");
    await expect(page.getByText(/fora da whitelist/).first()).toBeVisible({ timeout: 10000 });
  });

  test("(e) right-click no arquivo → menu com Renomear, Copiar Caminho e Excluir", async ({ page }) => {
    await abrirProjeto(page);
    await page.getByText("projeto.json", { exact: true }).first().click({ button: "right" });

    await expect(page.getByText("Renomear").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Copiar Caminho").first()).toBeVisible();
    await expect(page.getByText("Excluir").first()).toBeVisible();
    await page.keyboard.press("Escape");
  });
});
