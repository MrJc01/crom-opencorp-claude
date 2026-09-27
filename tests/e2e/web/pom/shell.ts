import { expect, type Locator, type Page } from "@playwright/test";
import { BasePage } from "./base.js";

/** Shell global: Sidebar + Topbar + troca de workspace (presente em todas as páginas). */
export class Shell extends BasePage {
  readonly sidebar: Locator;
  readonly topbarWorkspace: Locator;
  readonly badgeStream: Locator;
  readonly btnNotificacoes: Locator;

  constructor(page: Page) {
    super(page);
    this.sidebar = page.locator("#sidebar-principal");
    this.topbarWorkspace = page.locator('button[title="Trocar workspace ou criar novo projeto"]');
    this.badgeStream = page.getByTitle(/Canal de eventos/).first();
    this.btnNotificacoes = page.locator("#btn-notificacoes-topbar");
  }

  async navegar(label: string | RegExp): Promise<void> {
    await this.page.getByRole("link", { name: label }).first().click();
  }

  async trocarWorkspace(wsId: string): Promise<void> {
    await this.topbarWorkspace.click();
    await this.page.getByRole("option", { name: new RegExp(wsId) }).first().click();
    await this.page.waitForURL(new RegExp(`/w/${wsId}(/|$)`), { timeout: 10000 });
    await expect.poll(async () => this.page.evaluate(() => localStorage.getItem("oc-ws")), { timeout: 10000 }).toBe(wsId);
  }
}
