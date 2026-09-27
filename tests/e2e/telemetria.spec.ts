import { test, expect } from "@playwright/test";
import { logado, api, esperarElementoTexto } from "./helpers.js";

test.describe("Histórico — Visualizador de Telemetria Granular (E2E)", () => {
  const wsId = "e2e-telemetria-ws";
  const execId = "exec-telemetria-01";
  const ordem = "Análise de logs e execução de diagnóstico via tools";

  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e", wsId);
    const client = api(page);

    await client.post("/workspaces", {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: { id: wsId },
    }).catch(() => undefined);

    await client.post(`/registries/execucoes?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: { id: execId, descricao: `Ordem: ${ordem}` },
    }).catch(() => undefined);

    await client.put(`/registries/execucoes/${execId}?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        extras: {
          status: "concluido",
          ordem,
          agente: "secretario-exec",
          modelo: "glm-5.3-flash",
          duracao_ms: 3200,
          inicio: new Date().toISOString(),
        },
      },
    }).catch(() => undefined);
  });

  test("abre a execução e alterna para Telemetria (estado sem spans)", async ({ page }) => {
    // O modal lê o registro direto; a lista só exibe sessões reais (tag "sessao") — abre via ?run=
    await page.goto(`/historico?run=${encodeURIComponent(execId)}`);
    await esperarElementoTexto(page, "Identificador / Ordem");

    const botaoTelemetria = page.getByRole("button", { name: /Telemetria/ });
    await expect(botaoTelemetria).toBeVisible({ timeout: 15000 });

    await botaoTelemetria.click();
    await esperarElementoTexto(page, "Nenhum span registrado nesta execução.");
  });
});
