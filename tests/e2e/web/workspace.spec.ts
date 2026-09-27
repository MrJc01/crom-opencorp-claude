import { test, expect } from "@playwright/test";
import { logado, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

const WS = "ws-arquivos";
const AUTH = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("Web Workspace: explorer, editor, terminal e menu", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", WS);
    await page.request.post("/workspaces", {
      headers: AUTH,
      data: { id: WS, perfil: { empresa: "E2E Files", nicho: "teste" } },
    }).catch(() => undefined);
    await page.request.put(`/files?workspace=${WS}&path=${encodeURIComponent(".opencorp/projeto.json")}`, {
      headers: AUTH,
      data: { conteudo: '{\n  "empresa": "E2E Files",\n  "nicho": "teste"\n}\n' },
    }).catch(() => undefined);
    await page.goto("/workspace");
    await esperarElementoTexto(page, "Buscar (Ctrl+P)");
  });

  test("explorer expande, abre arquivo e Ctrl+P busca", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await page.getByText(".opencorp", { exact: true }).first().click();
    await expect(page.getByText("projeto.json", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await page.getByText("projeto.json", { exact: true }).first().click();
    await expect(page.locator("textarea").first()).toHaveValue(/E2E/, { timeout: 10000 });

    await page.keyboard.press("Control+p");
    await page.getByPlaceholder(/Buscar arquivo por nome ou caminho/).fill("projeto");
    await expect(page.getByText("projeto.json", { exact: true }).first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Escape");
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("editar marca sujo e Ctrl+S salva", async ({ page }) => {
    await page.getByText(".opencorp", { exact: true }).first().click();
    await page.getByText("projeto.json", { exact: true }).first().click();
    const editor = page.locator("textarea").first();
    await expect(editor).toHaveValue(/E2E/, { timeout: 10000 });
    await editor.fill('{\n  "empresa": "E2E Web Save",\n  "nicho": "teste"\n}\n');
    await expect(page.getByTitle("Alterações não salvas").first()).toBeVisible({ timeout: 10000 });
    await page.keyboard.press("Control+s");
    await expect(page.getByTitle("Alterações não salvas")).toHaveCount(0, { timeout: 10000 });

    const resp = await page.request.get(`/files?workspace=${WS}&path=.opencorp%2Fprojeto.json`, {
      headers: { authorization: "Bearer test-e2e" },
    });
    expect(((await resp.json()) as any).conteudo).toContain("E2E Web Save");

    await editor.fill('{\n  "empresa": "E2E Files",\n  "nicho": "teste"\n}\n');
    await page.keyboard.press("Control+s");
    await expect(page.getByTitle("Alterações não salvas")).toHaveCount(0, { timeout: 10000 });
  });

  test("terminal roda comando e limpa", async ({ page }) => {
    const input = page.locator('input[placeholder="Digite um comando (ex: tasks list, doctor, flow list)..."]');
    await input.fill("task list");
    await input.press("Enter");
    await expect(page.getByText("ws$ task list").first()).toBeVisible({ timeout: 20000 });
    await page.getByRole("button", { name: "Limpar" }).click();
    await expect(page.getByText("ws$ task list")).toHaveCount(0);
  });

  test("menu de contexto tem ações e novo terminal abre", async ({ page }) => {
    await page.getByText(".opencorp", { exact: true }).first().click({ button: "right" });
    await expect(page.getByText("Novo Arquivo").first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("Nova Pasta").first()).toBeVisible();
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "Nova aba de Terminal" }).click();
    await expect(page.getByText("Terminal 2", { exact: true }).first()).toBeVisible({ timeout: 10000 });
  });
});
