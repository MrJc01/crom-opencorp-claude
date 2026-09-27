import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api } from "./helpers.js";

test.describe("Perguntas da IA com Opções Interativas e Configuração de Modelo no Chat", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/secretario");
    await page.waitForSelector("#chat-input", { timeout: 20000 });
  });

  test.afterAll(async ({ request }) => {
    await request.post("/secretario/stop", { headers: { authorization: "Bearer test-e2e" } }).catch(() => {});
  });

  test("menu lateral carrega configurações do secretário e salva no workspace", async ({ page }) => {
    await page.locator('[data-testid="btn-configurar-motor"]').first().click();

    const drawer = page.locator("[data-testid='drawer-lateral-config']");
    await expect(drawer).toBeVisible({ timeout: 5000 });

    // Select de agente supervisor carregado
    const selectAgente = drawer.locator("select").first();
    await expect(selectAgente).toBeVisible();
    await expect(selectAgente.locator("option")).not.toHaveCount(0);

    // Salvar persiste e dá retorno visual
    await drawer.getByRole("button", { name: /Salvar no Workspace/ }).click();
    await expect(drawer.getByText("Salvo!")).toBeVisible({ timeout: 10000 });
  });

  test("IA pergunta usando tool ask_question com opções → botões clicáveis são renderizados e o clique envia a resposta", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // Envia ordem para disparar a pergunta com opções via tool
    await input.fill("teste pergunta tool");
    await page.click("#btn-enviar");

    // Aguarda o card de perguntas com opções interativas aparecer no layout
    const cardOpcoes = page.locator(".chat-pergunta-card").last();
    await expect(cardOpcoes).toBeVisible({ timeout: 15000 });

    // Verifica que o título da pergunta é renderizado
    await expect(cardOpcoes).toContainText("Qual ambiente você deseja implantar?");

    // Verifica que há exatamente 3 botões de opções
    const botoesOpcoes = cardOpcoes.locator("button[data-testid='chat-opcao-btn']");
    await expect(botoesOpcoes).toHaveCount(3);
    await expect(botoesOpcoes.nth(0)).toContainText("Produção");
    await expect(botoesOpcoes.nth(1)).toContainText("Staging");
    await expect(botoesOpcoes.nth(2)).toContainText("Desenvolvimento");

    // Clica na opção "Staging"
    const btnStaging = cardOpcoes.locator("button[data-opcao='Staging']");
    await expect(btnStaging).toBeVisible();
    await btnStaging.click();

    // Verifica que a escolha "Staging" foi enviada no chat como resposta do usuário
    await expect(page.locator(".oc-user, [data-role='user']").last()).toContainText("Staging", { timeout: 10000 });
  });

  test("IA pergunta em formato texto com opções numeradas → detecta e renderiza botões de escolha rápida", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // Envia ordem para disparar pergunta em formato texto com lista de opções
    await input.fill("teste pergunta texto");
    await page.click("#btn-enviar");

    // Aguarda o card de perguntas com opções interativas aparecer no layout
    const cardOpcoes = page.locator(".chat-pergunta-card").last();
    await expect(cardOpcoes).toBeVisible({ timeout: 15000 });

    // Verifica que os 3 botões com as opções do texto foram criados
    const botoesOpcoes = cardOpcoes.locator("button[data-testid='chat-opcao-btn']");
    await expect(botoesOpcoes).toHaveCount(3);
    await expect(botoesOpcoes.nth(0)).toContainText("Publicar agora no YouTube");
    await expect(botoesOpcoes.nth(1)).toContainText("Agendar para amanhã");
    await expect(botoesOpcoes.nth(2)).toContainText("Descartar rascunho");

    // Clica na primeira opção "Publicar agora no YouTube"
    await botoesOpcoes.first().click();

    // Verifica que a mensagem foi enviada ao chat com a opção escolhida
    await expect(page.locator(".oc-user, [data-role='user']").last()).toContainText("Publicar agora no YouTube", { timeout: 10000 });

    // Após resposta, o card de opções deve ser ocultado
    await expect(cardOpcoes).not.toBeVisible({ timeout: 5000 });
  });

  test("múltiplas perguntas: exibe navegação por abas/pills, opção customizada e oculta card após resposta", async ({ page }) => {
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

    // Aguarda card aparecer
    const cardOpcoes = page.locator(".chat-pergunta-card").last();
    await expect(cardOpcoes).toBeVisible({ timeout: 15000 });

    // Verifica navegação de abas (Pergunta 1 de 2)
    await expect(cardOpcoes).toContainText("Pergunta 1 de 2");
    await expect(cardOpcoes).toContainText("Qual ambiente de destino?");

    // Verifica botão customizado presente
    const btnCustom = cardOpcoes.locator("button:has-text('Outro: digitar resposta personalizada')");
    await expect(btnCustom).toBeVisible();

    // Seleciona primeira opção da pergunta 1 ("Produção") -> deve avançar automaticamente para Pergunta 2
    const btnProd = cardOpcoes.locator("button[data-opcao='Produção']");
    await btnProd.click();

    // Verifica que avançou para a pergunta 2
    await expect(cardOpcoes).toContainText("Pergunta 2 de 2");
    await expect(cardOpcoes).toContainText("Qual o método de entrega?");

    // Na pergunta 2, clica em "Gradual (Canary)"
    const btnCanary = cardOpcoes.locator("button[data-opcao='Gradual (Canary)']");
    await btnCanary.click();

    // Clica no botão de envio consolidado "Enviar respostas (2/2)"
    const btnEnviarRespostas = cardOpcoes.locator("button:has-text('Enviar respostas')");
    await expect(btnEnviarRespostas).toBeVisible();
    await btnEnviarRespostas.click();

    // Aguarda a resposta do usuário aparecer no chat contendo as respostas
    const ultimoUserMsg = page.locator(".oc-user, [data-role='user']").last();
    await expect(ultimoUserMsg).toBeVisible({ timeout: 10000 });
    await expect(ultimoUserMsg).toContainText("Produção");
    await expect(ultimoUserMsg).toContainText("Gradual (Canary)");

    // Como já foi respondida, o card de opções deve sumir da tela!
    await expect(cardOpcoes).not.toBeVisible({ timeout: 5000 });
  });

  test("pergunta com resposta personalizada: abre campo de digitação, envia texto customizado e oculta card", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    await input.fill("teste pergunta tool");
    await page.click("#btn-enviar");

    const cardOpcoes = page.locator(".chat-pergunta-card").last();
    await expect(cardOpcoes).toBeVisible({ timeout: 15000 });

    // Clica no botão "Outro: digitar resposta personalizada..."
    const btnCustom = cardOpcoes.locator("button:has-text('Outro: digitar resposta personalizada')");
    await expect(btnCustom).toBeVisible();
    await btnCustom.click();

    // Preenche a resposta personalizada no input
    const inputCustom = cardOpcoes.locator("input[placeholder*='resposta personalizada']");
    await expect(inputCustom).toBeVisible();
    await inputCustom.fill("Deploy no cluster Kubernetes local");

    // Clica em Enviar
    const btnEnviarCustom = cardOpcoes.locator("button:has-text('Enviar')");
    await btnEnviarCustom.click();

    // Verifica que o texto customizado foi enviado como mensagem do usuário
    const ultimoUser = page.locator(".oc-user, [data-role='user']").last();
    await expect(ultimoUser).toContainText("Deploy no cluster Kubernetes local", { timeout: 10000 });

    // O card deve sumir após ser respondido
    await expect(cardOpcoes).not.toBeVisible({ timeout: 5000 });
  });

  // Removido na UI React (9ad8e1e); ver docs/PENDENCIAS-MULTIMOTORES.md, seção de lacunas do chat.
  test.fixme("redimensionamento do input: expande com quebras de linha até o limite, diminui ao perder foco e restaura ao focar", async ({ page }) => {
    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // 1. Altura inicial compacta
    const bboxInicial = await input.boundingBox();
    expect(bboxInicial).not.toBeNull();
    expect(bboxInicial!.height).toBeLessThanOrEqual(44);

    // 2. Foca e digita múltiplas linhas
    await input.focus();
    await input.fill("Linha 1\nLinha 2\nLinha 3\nLinha 4\nLinha 5");
    await page.waitForTimeout(150);

    const bboxExpandido = await input.boundingBox();
    expect(bboxExpandido).not.toBeNull();
    expect(bboxExpandido!.height).toBeGreaterThan(bboxInicial!.height);
    expect(bboxExpandido!.height).toBeLessThanOrEqual(225);

    // 3. Tira o foco (blur) clicando fora -> deve diminuir de volta para a altura compacta
    await page.locator("body").click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(250);

    const bboxBlur = await input.boundingBox();
    expect(bboxBlur).not.toBeNull();
    expect(bboxBlur!.height).toBeLessThanOrEqual(44);

    // 4. Clica novamente no input (foco) -> restaura a altura expandida
    await input.focus();
    await page.waitForTimeout(250);

    const bboxRefocus = await input.boundingBox();
    expect(bboxRefocus).not.toBeNull();
    expect(bboxRefocus!.height).toBeGreaterThan(44);

    // 5. Limpa o texto -> volta à altura normal
    await input.fill("");
    await page.waitForTimeout(150);

    const bboxLimpo = await input.boundingBox();
    expect(bboxLimpo).not.toBeNull();
    expect(bboxLimpo!.height).toBeLessThanOrEqual(44);
  });

  // Removido na UI React (9ad8e1e); ver docs/PENDENCIAS-MULTIMOTORES.md, seção de lacunas do chat.
  test.fixme("carregamento paginado: exibe inicialmente últimos 2 turnos e scroll infinito para cima carrega anteriores", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // Envia 4 turnos sequenciais
    const prompts = ["Turno alfa inicial", "Turno beta intermediario", "Turno gama recente", "Turno delta final"];
    for (const p of prompts) {
      await input.fill(p);
      await page.click("#btn-enviar");
      // Aguarda o balão do usuário correspondente aparecer
      await expect(page.locator(`.oc-user:has-text("${p}"), [data-role='user']:has-text("${p}")`)).toBeVisible({ timeout: 10000 });
      // Aguarda resposta do assistente ser concluída
      await expect(page.locator(".oc-assistant").last()).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(200);
    }

    // Recarrega a página para testar o carregamento inicial da sessão
    await page.reload();
    await page.waitForSelector("#chat-input", { timeout: 20000 });

    // 1. Inicialmente deve exibir apenas os últimos 2 turnos (gama recente e delta final)
    await expect(page.locator(".oc-user:has-text('Turno delta final')")).toBeVisible({ timeout: 8000 });
    await expect(page.locator(".oc-user:has-text('Turno gama recente')")).toBeVisible({ timeout: 8000 });

    // O primeiro turno ainda NÃO deve estar visível no DOM
    await expect(page.locator(".oc-user:has-text('Turno alfa inicial')")).not.toBeVisible();

    // 2. O botão de carregar anteriores deve estar visível no topo
    const btnCarregarAnteriores = page.locator("button:has-text('Carregar mensagens anteriores')");
    await expect(btnCarregarAnteriores).toBeVisible();

    // 3. Clica para carregar mensagens anteriores
    await btnCarregarAnteriores.click();

    // 4. Agora os turnos anteriores devem aparecer no chat
    await expect(page.locator(".oc-user:has-text('Turno alfa inicial')")).toBeVisible({ timeout: 8000 });
    await expect(page.locator(".oc-user:has-text('Turno beta intermediario')")).toBeVisible({ timeout: 8000 });

    // 5. Como chegou ao início, o indicador "Início do histórico da conversa" deve ser exibido
    await expect(page.locator("text=Início do histórico da conversa")).toBeVisible({ timeout: 5000 });
  });

  // Removido na UI React (9ad8e1e); ver docs/PENDENCIAS-MULTIMOTORES.md, seção de lacunas do chat.
  test.fixme("editar prompt: clica no botão editar e o texto é restaurado no input para edição", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    const textoPromptOriginal = "Prompt de teste para verificar edicao sem sumir";
    await input.fill(textoPromptOriginal);
    await page.click("#btn-enviar");

    // Aguarda o balão do usuário aparecer no chat
    const balaoUsuario = page.locator(`.oc-user:has-text("${textoPromptOriginal}"), [data-role='user']:has-text("${textoPromptOriginal}")`).last();
    await expect(balaoUsuario).toBeVisible({ timeout: 10000 });

    // O input deve estar limpo após o envio
    await expect(input).toHaveValue("");

    // Passa o mouse sobre o balão para revelar os botões de ação e clica no botão de editar
    await balaoUsuario.hover();
    const btnEditar = balaoUsuario.locator("button[title='Editar prompt']");
    await expect(btnEditar).toBeVisible({ timeout: 3000 });
    await btnEditar.click();

    // O texto deve ser restaurado IMEDIATAMENTE no input!
    await expect(input).toHaveValue(textoPromptOriginal, { timeout: 5000 });

    // O input deve estar focado
    await expect(input).toBeFocused();
  });

  // Removido na UI React (9ad8e1e); ver docs/PENDENCIAS-MULTIMOTORES.md, seção de lacunas do chat.
  test.fixme("fila de prompts: enfileira mensagens enquanto o agente roda, exibe no dock, permite editar, excluir e dispara automaticamente ao fim do turno", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // 1. Envia a primeira mensagem
    await input.fill("teste inicio de execucao longa");
    await page.click("#btn-enviar");

    // 2. Enquanto o assistente está executando, digita a mensagem seguinte
    await input.fill("Meu segundo prompt na fila de espera");
    await page.waitForTimeout(100);

    // O botão + Fila deve estar visível e clicável!
    const btnFila = page.locator("[data-testid='btn-enfileirar']");
    await expect(btnFila).toBeVisible();
    await btnFila.click();

    // O input deve ser limpo e o FollowupQueueDock deve aparecer!
    await expect(input).toHaveValue("");
    const dockFila = page.locator("[data-testid='followup-queue-dock']");
    await expect(dockFila).toBeVisible({ timeout: 5000 });
    await expect(dockFila).toContainText("Fila de Espera");
    await expect(dockFila).toContainText("Meu segundo prompt na fila de espera");

    // 3. Testa a ação de EDITAR na fila
    const btnEditarFila = dockFila.locator("button[title*='Editar prompt']").first();
    await expect(btnEditarFila).toBeVisible();
    await btnEditarFila.click();

    // O prompt deve sair da fila e voltar para o input
    await expect(dockFila).not.toBeVisible();
    await expect(input).toHaveValue("Meu segundo prompt na fila de espera");

    // 4. Enfileira novamente via teclado (Enter)
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(dockFila).toBeVisible({ timeout: 5000 });

    // 5. Adiciona um item adicional à fila para testar múltiplos itens e exclusão
    await input.fill("Item para ser excluido");
    await input.press("Enter");
    await expect(dockFila).toContainText("2 prompts aguardando");

    // 6. Testa a ação de EXCLUIR um item da fila
    const btnExcluir = dockFila.locator("button[title*='Excluir da fila']").last();
    await expect(btnExcluir).toBeVisible();
    await btnExcluir.click();
    await expect(dockFila).toContainText("1 prompt aguardando");
    await expect(dockFila).not.toContainText("Item para ser excluido");

    // 7. Validação do envio automático: quando o turno atual finaliza, a fila é consumida automaticamente
    // O dock deve sumir e o prompt da fila é disparado como mensagem no chat
    await expect(dockFila).not.toBeVisible({ timeout: 25000 });
    const ultimoUser = page.locator(".oc-user, [data-role='user']").last();
    await expect(ultimoUser).toContainText("Meu segundo prompt na fila de espera", { timeout: 15000 });
  });

  // Removido na UI React (9ad8e1e); ver docs/PENDENCIAS-MULTIMOTORES.md, seção de lacunas do chat.
  test.fixme("fila de prompts: botão adiantar interrompe execução atual e dispara prompt da fila imediatamente", async ({ page }) => {
    const btnNova = page.locator("[data-testid='btn-nova-conversa']");
    if (await btnNova.isVisible().catch(() => false)) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const input = page.locator("#chat-input");
    await expect(input).toBeVisible();

    // Envia primeira mensagem
    await input.fill("teste turno longo para adiantar");
    await page.click("#btn-enviar");

    // Rapidamente enfileira mensagem prioritária
    await input.fill("Mensagem prioritária adiantada agora");
    const btnFila = page.locator("[data-testid='btn-enfileirar']");
    await expect(btnFila).toBeVisible({ timeout: 5000 });
    await btnFila.click();

    const dockFila = page.locator("[data-testid='followup-queue-dock']");
    await expect(dockFila).toBeVisible({ timeout: 5000 });

    // Clica imediatamente em Adiantar
    const btnAdiantar = dockFila.locator("button:has-text('Adiantar')").first();
    await expect(btnAdiantar).toBeVisible();
    await btnAdiantar.click();

    // O dock deve fechar e a mensagem deve aparecer enviada
    await expect(dockFila).not.toBeVisible({ timeout: 5000 });
    const ultimoUser = page.locator(".oc-user, [data-role='user']").last();
    await expect(ultimoUser).toContainText("Mensagem prioritária adiantada agora", { timeout: 10000 });
  });
});
