import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

test.describe("CRUD via UI", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  test("Excluir task: drawer → Excluir (confirm) → some do kanban", async ({ page }) => {
    const titulo = `Task excluir e2e ${Date.now()}`;
    await api(page).post("/tasks", {
      headers: HDR,
      data: { titulo, descricao: "criada para exclusão", coluna: "backlog", prioridade: "media" },
    });
    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");
    await page.locator('input[placeholder="Buscar tarefas..."]').fill(titulo);
    await page.getByText(titulo).first().click();
    await esperarElementoTexto(page, "Detalhes da Tarefa");

    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Excluir", exact: true }).last().click();
    await expect(page.getByText(titulo)).toHaveCount(0, { timeout: 10000 });
  });

  test("Criar fluxo pela UI → abre o canvas do novo fluxo", async ({ page }) => {
    const nome = `Fluxo e2e ${Date.now()}`;
    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
    await page.getByRole("button", { name: "Novo Fluxo", exact: true }).click();
    await esperarElementoTexto(page, "Criar Novo Fluxo DAG");

    await page.getByPlaceholder("ex: Produção de Conteúdo YouTube").fill(nome);
    // ID é sugerido automaticamente a partir do nome
    await page.getByRole("button", { name: "Criar no Studio" }).click();

    // Canvas abre (botão voltar + nome no editor)
    await expect(page.locator('button[title="Voltar para Lista de Fluxos"]')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(nome).first()).toBeVisible({ timeout: 10000 });
  });

  test("Excluir fluxo pela UI (confirm) → some da lista", async ({ page }) => {
    const fid = `flow-excluir-${Date.now().toString(36)}`;
    await api(page).post("/flows", {
      headers: HDR,
      data: { id: fid, nome: `Flow excluir ${fid}`, nos: [{ id: "gatilho", tipo: "manual", config: {} }], arestas: [] },
    });
    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Studio de Fluxos Declarativos (DAG)");
    await page.getByPlaceholder("Buscar por nome, id ou descrição...").fill(fid);
    await expect(page.getByText(fid).first()).toBeVisible({ timeout: 10000 });

    page.once("dialog", (d) => d.accept());
    await page.getByTestId(`fluxo-card-${fid}`).getByRole("button", { name: "Excluir fluxo" }).click();
    await expect(page.getByText(fid)).toHaveCount(0, { timeout: 10000 });
  });

  test("Reunião: pauta + agente → Abrir Sala limpa o form e abre a sala", async ({ page }) => {
    const pauta = `Pauta de lançamento e2e ${Date.now()}`;
    await page.goto("/reunioes");
    await page.getByRole("button", { name: "Nova Reunião" }).first().click();
    await esperarElementoTexto(page, "Convocar Nova Reunião Colegiada");

    await page.getByPlaceholder(/Definir linha editorial/).fill(pauta);
    // seleciona o primeiro agente da mesa
    const agente = page.locator("button[aria-pressed]", { hasText: /@/ }).first();
    await agente.click();
    await expect(agente).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Iniciar Deliberação" }).click();
    // modal fecha e a sala abre com a pauta
    await expect(page.getByText("Convocar Nova Reunião Colegiada")).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByText(pauta).first()).toBeVisible({ timeout: 15000 });
  });
});
