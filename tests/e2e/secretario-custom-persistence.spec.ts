import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";
import { T } from "./helpers.js";

test.describe("Secretário: Persistência do Input Customizado e Desbloqueio de Sessão", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: T(20000) });
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => {});
  });

  test("clicar em Outro abre o input customizado e polling não fecha o input nem reverte para o botão", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // 1. Envia ordem para disparar a pergunta da IA com opções
    await input.fill("teste pergunta tool");
    await page.click("#btn-enviar");

    // Aguarda o card de perguntas com opções interativas aparecer
    const cardOpcoes = page.locator(".chat-pergunta-card").last();
    await expect(cardOpcoes).toBeVisible({ timeout: T(15000) });

    // 2. Localiza o botão "Outro: digitar resposta personalizada..."
    const btnCustom = cardOpcoes.locator("button:has-text('Outro: digitar resposta personalizada')");
    await expect(btnCustom).toBeVisible();

    // 3. Clica no botão customizado para abrir o input de texto livre
    await btnCustom.click();

    // 4. Verifica que o campo de input personalizado abriu
    const inputCustom = cardOpcoes.locator("input[placeholder*='resposta personalizada']");
    await expect(inputCustom).toBeVisible({ timeout: T(3000) });

    // 5. Digita a resposta livre
    await inputCustom.fill("Deploy no cluster Kubernetes dedicado");

    // 6. Aguarda 3 segundos inteiros para assegurar que múltiplos ciclos de polling reconciliaram
    // Antes da correção, qualquer tick de polling resetava o componente e voltava o botão "Outro"
    await page.waitForTimeout(3000);

    // 7. Garante que o input AINDA está visível e preservou o texto digitado
    await expect(inputCustom).toBeVisible();
    await expect(inputCustom).toHaveValue("Deploy no cluster Kubernetes dedicado");

    // 8. Clica no botão "Enviar" do input customizado
    const btnEnviarCustom = cardOpcoes.locator("button:has-text('Enviar')");
    await expect(btnEnviarCustom).toBeVisible();
    await btnEnviarCustom.click();

    // 9. Verifica que a resposta personalizada foi despachada para o chat como mensagem do usuário
    const ultimaMsgUsuario = page.locator(".oc-user, [data-role='user']").last();
    await expect(ultimaMsgUsuario).toContainText("Deploy no cluster Kubernetes dedicado", { timeout: T(10000) });

    // 10. O card de opções deve sumir após ser respondido
    await expect(cardOpcoes).not.toBeVisible({ timeout: T(5000) });
  });

  test("interface não fica travada em carregamento eterno quando sessão está ociosa ou após erro", async ({ page }) => {
    // 1. O textarea do chat deve estar interativo e habilitado
    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();
    await expect(input).toBeEnabled();

    // 2. O botão de enviar deve estar visível e NÃO deve exibir o botão vermelho de Parar quando ocioso
    const btnEnviar = page.locator("#btn-enviar");
    await expect(btnEnviar).toBeVisible();

    const btnParar = page.locator("button:has-text('Parar')");
    await expect(btnParar).not.toBeVisible();

    // 3. Envia uma mensagem comum para garantir fluxo de ida e volta
    await input.fill("olá secretário teste de desbloqueio");
    await btnEnviar.click();

    // 4. Aguarda resposta do assistente
    await expect(page.locator(".oc-assistant, [data-role='assistant']").last()).toBeVisible({ timeout: T(10000) });

    // 5. Após a resposta, o input volta a ficar pronto e liberado (sem travar)
    await expect(input).toBeEnabled({ timeout: T(5000) });
    await expect(btnParar).not.toBeVisible();
  });

  test("múltiplas perguntas: resposta customizada na última aba submete respostas e não reverte", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // Dispara pergunta múltipla
    await input.fill("teste pergunta multipla");
    await page.click("#btn-enviar");

    const cardOpcoes = page.locator(".chat-pergunta-card").last();
    await expect(cardOpcoes).toBeVisible({ timeout: T(15000) });

    // Pergunta 1: seleciona a primeira opção
    const btnOpcao1 = cardOpcoes.locator("button[data-opcao='Produção']");
    await expect(btnOpcao1).toBeVisible();
    await btnOpcao1.click();

    // Avança para a pergunta 2
    await expect(cardOpcoes).toContainText("Pergunta 2 de 2", { timeout: T(5000) });

    // Na pergunta 2, abre o customizado
    const btnCustom = cardOpcoes.locator("button:has-text('Outro: digitar resposta personalizada')");
    await expect(btnCustom).toBeVisible();
    await btnCustom.click();

    const inputCustom = cardOpcoes.locator("input[placeholder*='resposta personalizada']");
    await expect(inputCustom).toBeVisible();
    await inputCustom.fill("Estratégia Blue-Green com Rollback Automático");

    // Aguarda 2.5s de polling
    await page.waitForTimeout(2500);
    await expect(inputCustom).toBeVisible();
    await expect(inputCustom).toHaveValue("Estratégia Blue-Green com Rollback Automático");

    // Submete a resposta customizada
    const btnEnviarCustom = cardOpcoes.getByRole("button", { name: "Enviar", exact: true });
    await btnEnviarCustom.click();

    // Verifica que ambas as respostas foram submetidas ao chat
    const ultimaMsg = page.locator(".oc-user, [data-role='user']").last();
    await expect(ultimaMsg).toContainText("Estratégia Blue-Green com Rollback Automático", { timeout: T(10000) });
  });
});
