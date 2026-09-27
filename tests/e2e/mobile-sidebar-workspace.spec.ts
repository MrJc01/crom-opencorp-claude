import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

/** Barra lateral e troca de workspace no celular (375x667). */
test.describe("Mobile Sidebar & Workspace Switcher (375x667)", () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("menu lateral abre no mobile mesmo com a versão desktop recolhida e navega", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("oc_sidebar_collapsed", "1"));
    await page.goto("/home");
    const sidebar = page.locator("#sidebar-principal");
    await expect(sidebar).not.toBeInViewport();

    await page.getByRole("button", { name: "Abrir menu de navegação" }).click();
    await expect(sidebar).toBeInViewport();
    // No mobile a barra aparece expandida (rótulos visíveis), mesmo com a preferência desktop recolhida.
    await expect(sidebar.getByRole("link", { name: "Tarefas & Kanban" })).toBeVisible();

    await sidebar.getByRole("link", { name: "Tarefas & Kanban" }).click();
    await page.waitForURL(/\/tasks/);
    await expect(sidebar).not.toBeInViewport();
  });

  test("seletor de workspace funciona no mobile", async ({ page }) => {
    await page.goto("/home");
    const seletor = page.getByTitle("Trocar workspace ou criar novo projeto");
    await expect(seletor).toBeVisible();
    await seletor.click();
    await page.getByRole("option", { name: /outro-ws/ }).click();
    await page.waitForURL(/\/w\/outro-ws/);
    await expect(seletor).toContainText("outro-ws");
  });
});
