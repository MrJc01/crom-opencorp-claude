import { test, expect } from "@playwright/test";
import { logado, api } from "./helpers.js";

test.describe("Histórico — Reenviar / Clone de Execução", () => {
  const wsId = "e2e-retry-corp";
  const execIdOriginal = "exec-test-orig-e2e";
  const ordemOriginal = "Testar automação e2e de retry e clonagem";

  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", wsId);
    const client = api(page);

    // 1. Criar workspace
    await client.post("/workspaces", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: { id: wsId },
    }).catch(() => undefined);

    // 2. Criar agente
    await client.post(`/agents?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "agente-e2e",
        name: "Agente E2E",
        role: "Executor E2E",
        category: "operario",
        model: "openrouter/auto",
        tools: ["bash"],
        permissions: "level-1",
        budget: { daily_usd: 10, max_turns: 10 },
        prompt: "Você é um agente de teste e2e.",
      },
    }).catch(() => undefined);

    // 3. Criar registro de execução original (status: falhou)
    await client.post(`/registries/execucoes?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: execIdOriginal,
        descricao: `Ordem: ${ordemOriginal}`,
      },
    });

    // Atualiza metadados com extras (status, ordem, agente, modelo)
    await client.put(`/registries/execucoes/${execIdOriginal}?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        conteudo: `# log da sessão ${execIdOriginal}\nFalha simulada para teste`,
      },
    });
  });

  test("API: POST /execucoes/:id/retry clona a execução e suporta cross-workspace", async ({ page }) => {
    const client = api(page);

    // Reenviar apontando para outro workspace diferente para testar a busca cross-workspace
    const res = await client.post(`/execucoes/${execIdOriginal}/retry?workspace=outro-ws`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {},
    });

    expect(res.status()).toBe(202);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.exec_id_original).toBe(execIdOriginal);
    expect(body.exec_id).toMatch(/^exec-/);
    expect(body.mensagem).toContain(`clone de ${execIdOriginal}`);
  });

  test("UI: exibe botão Reenviar no modal e clona a execução com sucesso", async ({ page }) => {
    // Abrir o histórico diretamente com ?run=
    await page.goto(`/historico?run=${execIdOriginal}&workspace=${wsId}`);

    // Modal deve estar aberto
    const modal = page.getByRole("heading", { name: execIdOriginal });
    await expect(modal).toBeVisible({ timeout: 15000 });

    // Botão Reenviar deve estar visível
    const btnReenviar = page.locator('button:has-text("Reenviar")');
    await expect(btnReenviar).toBeVisible({ timeout: 10000 });

    // Clicar em Reenviar
    await btnReenviar.click();

    // Deve exibir toast de sucesso ou notificação de reenviado
    const toastSucesso = page.getByText(/Execução reenviada com sucesso/).first();
    await expect(toastSucesso).toBeVisible({ timeout: 15000 });
  });
});
