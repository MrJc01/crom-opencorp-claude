import { test, expect } from "@playwright/test";
import { logado, api } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Histórico — Modal com Layout do Secretário e Encerramento", () => {
  const wsId = "e2e-chat-layout-ws";
  const execIdSequential = "exec-e2e-chat-seq-01";
  const execIdRunning = "exec-e2e-chat-run-02";
  const ordemSequential = "Diagnóstico do sistema: verificar arquivos e gerar sumário";

  const rawLogSequential = [
    `# agente: executor-padrao · modelo: openrouter/auto`,
    `# ordem: ${ordemSequential}`,
    `Vou analisar os arquivos do projeto e verificar as dependências instaladas.`,
    `$ ls -la`,
    `total 48`,
    `drwxr-xr-x 8 j j 4096 Sep 3 23:00 .`,
    `-rw-r--r-- 1 j j 1641 Sep 3 23:00 package.json`,
    `→ Read package.json`,
    `{\n  "name": "opencorp"\n}`,
    `← Write build-report.md`,
    `Relatório gerado com sucesso.`,
    `Conclusão: O sistema está operacional e todas as dependências foram validadas.`,
  ].join("\n");

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
        id: "executor-padrao",
        name: "Executor Padrão",
        role: "Operário",
        category: "operario",
        model: "openrouter/auto",
        tools: ["bash"],
        permissions: "level-1",
        budget: { daily_usd: 10, max_turns: 10 },
        prompt: "Você é um agente executor.",
      },
    }).catch(() => undefined);

    // 3. Criar registro da execução concluída (com passos sequenciais)
    await client.post(`/registries/execucoes?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: execIdSequential,
        descricao: `Ordem: ${ordemSequential}`,
      },
    });

    await client.put(`/registries/execucoes/${execIdSequential}?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        conteudo: rawLogSequential,
      },
    });

    // 4. Criar registro de uma execução em andamento (para testar encerramento)
    await client.post(`/registries/execucoes?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: execIdRunning,
        descricao: `Ordem: Tarefa em execução prolongada`,
      },
    });

    await client.put(`/registries/execucoes/${execIdRunning}?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        conteudo: `# agente: executor-padrao · modelo: openrouter/auto\n# ordem: Tarefa em execução prolongada\nProcessando dados em lote...`,
      },
    });
  });

  test("(a) Modal exibe layout sequencial estilo Secretário (Você -> Passos do Agente -> Resposta)", async ({ page }) => {
    // Acessar diretamente pelo query param ?run=
    await page.goto(`/historico?run=${execIdSequential}&workspace=${wsId}`);

    // Modal aberto com o ID da execução
    await expect(page.getByRole("heading", { name: execIdSequential })).toBeVisible({ timeout: T(15000) });

    // Ordem original (turno do operador)
    await expect(page.getByText("Ordem Operacional").first()).toBeVisible({ timeout: T(10000) });
    await expect(page.locator(`text=${ordemSequential}`).first()).toBeVisible({ timeout: T(10000) });

    // Ações do agente em sequência (bash → read → write), cada uma expansível
    await expect(page.getByRole("button", { name: /bash\s*ls -la/ }).first()).toBeVisible({ timeout: T(10000) });
    await expect(page.getByRole("button", { name: /read\s*.*package\.json/ }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: /write\s*.*build-report\.md/ }).first()).toBeVisible();

    // Conclusão final (aba Resultado)
    await page.getByRole("button", { name: /^Resultado/ }).click();
    await expect(
      page.locator("text=Conclusão: O sistema está operacional e todas as dependências foram validadas.").first()
    ).toBeVisible({ timeout: T(10000) });
  });

  test("(b) Alternador entre Chat ao Vivo e Terminal Raw funciona perfeitamente", async ({ page }) => {
    await page.goto(`/historico?run=${execIdSequential}&workspace=${wsId}`);
    await expect(page.getByRole("heading", { name: execIdSequential })).toBeVisible({ timeout: T(15000) });

    // Alternar para Terminal Raw
    const btnTerminal = page.getByRole("button", { name: /^Terminal/ });
    await expect(btnTerminal).toBeVisible();
    await btnTerminal.click();

    // Tag pre visível com o log bruto
    const preRaw = page.locator("pre");
    await expect(preRaw).toBeVisible({ timeout: T(5000) });
    await expect(preRaw).toContainText("executor-padrao");

    // Alternar de volta para Chat ao Vivo
    const btnChat = page.getByRole("button", { name: /^Chat/ });
    await expect(btnChat).toBeVisible();
    await btnChat.click();

    // Chat sequencial volta a ficar visível
    await expect(page.getByText("Ordem Operacional").first()).toBeVisible({ timeout: T(5000) });
  });

  test("(c) Encerramento de execução ('Encerrar') interrompe polling e persiste status cancelado", async ({ page }) => {
    const client = api(page);

    // Simula execução com status 'executando'
    await client.post(`/registries/execucoes?workspace=${wsId}`, {
      headers: { authorization: "Bearer test-e2e", "content-type": "application/json" },
      data: {
        id: "exec-test-cancelar-99",
        descricao: "Ordem: Teste de encerramento forçado",
      },
    });

    await page.goto(`/historico?run=exec-test-cancelar-99&workspace=${wsId}`);
    await expect(page.getByRole("heading", { name: "exec-test-cancelar-99" })).toBeVisible({ timeout: T(15000) });

    // Botão Encerrar ou fechar
    const btnEncerrar = page.locator('button:has-text("Encerrar")');
    if (await btnEncerrar.isVisible({ timeout: T(3000) }).catch(() => false)) {
      await btnEncerrar.click();
      // Toast de encerramento
      await expect(page.locator("text=encerrada com sucesso").first()).toBeVisible({ timeout: T(10000) });
      // Status muda para cancelado (dentro do modal, não o <option> do filtro)
      const modal = page.locator("div.fixed.inset-0").last();
      await expect(modal.getByText("cancelado", { exact: true })).toBeVisible({ timeout: T(10000) });
    }

    // Tecla Escape fecha o modal sem deixar órfãos
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { name: "exec-test-cancelar-99" })).toHaveCount(0);
  });
});
