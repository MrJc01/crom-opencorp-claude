import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";
import { T } from "../helpers.js";

const ROTAS: Array<{ path: string; prova: { tipo: "texto" | "placeholder" | "titulo"; valor: string | RegExp } }> = [
  { path: "/", prova: { tipo: "texto", valor: "Governança da Empresa Autônoma" } },
  { path: "/home", prova: { tipo: "texto", valor: "Governança da Empresa Autônoma" } },
  { path: "/secretario", prova: { tipo: "titulo", valor: "Histórico de Sessões" } },
  { path: "/workspace", prova: { tipo: "texto", valor: "Buscar (Ctrl+P)" } },
  { path: "/tasks", prova: { tipo: "texto", valor: "Quadro Kanban" } },
  { path: "/agentes", prova: { tipo: "texto", valor: "Catálogo de Agentes & Equipes Multi-Agente" } },
  { path: "/reunioes", prova: { tipo: "titulo", valor: "Atualizar lista" } },
  { path: "/agenda", prova: { tipo: "texto", valor: "Studio de Fluxos Declarativos (DAG)" } },
  { path: "/fluxos", prova: { tipo: "texto", valor: "Studio de Fluxos Declarativos (DAG)" } },
  { path: "/hooks", prova: { tipo: "texto", valor: "Studio de Fluxos Declarativos (DAG)" } },
  { path: "/apps", prova: { tipo: "texto", valor: "Mini-Apps" } },
  { path: "/secrets", prova: { tipo: "texto", valor: "Cofre de Segredos & Credenciais" } },
  { path: "/historico", prova: { tipo: "texto", valor: "Histórico de Execuções" } },
  { path: "/notificacoes", prova: { tipo: "texto", valor: "Central de Alertas & Notificações" } },
  { path: "/docs", prova: { tipo: "placeholder", valor: "Buscar por título, slug ou categoria..." } },
  { path: "/config", prova: { tipo: "texto", valor: "Configurações & Governança do Sistema" } },
];

test.describe("Rotas: todas carregam sem erro e sem tela vazia", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  for (const rota of ROTAS) {
    test(`GET ${rota.path} renderiza`, async ({ page }) => {
      const watcher = new ConsoleWatcher(page);
      watcher.start();

      await page.goto(rota.path);
      if (rota.prova.tipo === "texto") {
        await expect(page.getByText(rota.prova.valor as string).first()).toBeVisible({ timeout: T(15000) });
      } else if (rota.prova.tipo === "placeholder") {
        await expect(page.locator(`input[placeholder="${rota.prova.valor}"]`)).toBeVisible({ timeout: T(15000) });
      } else {
        // Escopo ao main: o dock lateral do Secretário (fora do main) tem botões com mesmos titles
        await expect(page.locator("main").locator(`button[title="${rota.prova.valor}"]`)).toBeVisible({ timeout: T(15000) });
      }
      // main tem conteúdo (não é casca vazia)
      const corpo = await page.locator("main").first().textContent();
      expect((corpo || "").trim().length).toBeGreaterThan(50);

      watcher.stop();
      expect(watcher.limpos()).toEqual([]);
    });
  }
});
