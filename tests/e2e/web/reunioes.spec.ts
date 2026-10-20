import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

test.describe("Web Reuniões: convocar, sala, histórico e ata", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/reunioes");
    await page.getByRole("button", { name: "Nova Reunião" }).first().waitFor({ timeout: T(15000) });
  });

  async function convocar(page: import("@playwright/test").Page, pauta: string): Promise<void> {
    await page.getByRole("button", { name: "Nova Reunião" }).first().click();
    await esperarElementoTexto(page, "Convocar Nova Reunião Colegiada");
    await page.getByPlaceholder(/Definir linha editorial/).fill(pauta);
    await page.locator("button[aria-pressed]", { hasText: /@/ }).first().click();
    await page.getByRole("button", { name: "Iniciar Deliberação" }).click();
    await page.waitForURL(/reuniao=/, { timeout: T(20000) });
    await expect(page.getByText(pauta).first()).toBeVisible({ timeout: T(15000) });
  }

  test("modal convocar cria sala e fecha", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();
    await convocar(page, `Web reuniao ${Date.now()}`);
    await expect(page.getByText("Convocar Nova Reunião Colegiada")).toHaveCount(0);
    watcher.stop();
    expect(watcher.limpos()).toEqual([]);
  });

  test("enviar mensagem na sala aparece no feed", async ({ page }) => {
    await convocar(page, `Web sala msg ${Date.now()}`);
    const texto = `msg web ${Date.now()}`;
    const input = page.locator("main textarea").last();
    await expect(input).toBeVisible({ timeout: T(15000) });
    await input.fill(texto);
    await input.press("Enter");
    await expect(page.getByText(texto).first()).toBeVisible({ timeout: T(15000) });
  });

  test("histórico lista a sala criada", async ({ page }) => {
    const pauta = `Web historico ${Date.now()}`;
    await convocar(page, pauta);
    await page.goto("/reunioes");
    await expect(page.getByRole("button", { name: /Histórico \(\d+\)/ })).toBeVisible({ timeout: T(15000) });
    await expect(page.getByText(pauta).first()).toBeVisible({ timeout: T(15000) });
  });
});
