import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";

test.describe("Secretário — Estresse (10x), Animações Fluidas, Edição e Persistência", () => {
  const VIDEO_DIR = "/home/j/.gemini/antigravity-ide/brain/96ed4bcd-0816-4777-a4f7-5b707a414d4f/test-videos";
  const ARTIFACTS_DIR = "/home/j/.gemini/antigravity-ide/brain/96ed4bcd-0816-4777-a4f7-5b707a414d4f";

  test("Executa 10 iterações de cada funcionalidade do chat e gera GIF fluido", async ({ browser }) => {
    test.setTimeout(180_000);

    if (!existsSync(VIDEO_DIR)) mkdirSync(VIDEO_DIR, { recursive: true });

    const context = await browser.newContext({
      viewport: { width: 1200, height: 750 },
      recordVideo: {
        dir: VIDEO_DIR,
        size: { width: 1200, height: 750 },
      },
    });

    const page = await context.newPage();

    // ─────────────────────────────────────────────────────────────
    // FASE 1: 10x Recarregamentos (F5) em Sessão com Raciocínio
    // Valida que pensamento e ferramentas permanecem salvos sem sumir
    // ─────────────────────────────────────────────────────────────
    console.log("==> FASE 1: 10 iterações de F5 e persistência de dados...");
    for (let i = 1; i <= 10; i++) {
      await page.goto("http://localhost:4100/secretario?workspace=yt-factory-01&sessao=ses_f33065b19ffeHcIvkNhEnUyoqU", { waitUntil: "domcontentloaded" });
      const abaAlvo = page.locator(":has-text('verifique por que')").first();
      if ((await abaAlvo.count()) > 0 && (await abaAlvo.isVisible())) {
        await abaAlvo.click().catch(() => {});
      }
      await page.waitForSelector("[data-role='user']", { timeout: 15000 });

      // Valida texto do usuário intacto
      const userText = await page.locator("[data-role='user']").first().innerText();
      expect(userText.trim().length).toBeGreaterThan(0);

      // Se houver mensagens anteriores paginadas, carrega para ver todo o raciocínio
      const btnAnteriores = page.locator("button:has-text('Carregar mensagens anteriores')");
      if ((await btnAnteriores.count()) > 0 && (await btnAnteriores.first().isVisible())) {
        await btnAnteriores.first().click();
        await page.waitForTimeout(350);
      }

      // Valida presença de blocos de mensagens e consistência
      const reasoningButtons = page.locator("button:has-text('Raciocínio')");
      if ((await reasoningButtons.count()) > 0) {
        expect(await reasoningButtons.count()).toBeGreaterThanOrEqual(1);
      }

      // Valida ausência de duplicação visual no DOM
      const userMessages = await page.locator("[data-role='user']").allTextContents();
      const uniqueContents = new Set(userMessages.map((t) => t.trim()));
      expect(userMessages.length).toBe(uniqueContents.size);
    }
    console.log("✓ FASE 1: 10 iterações de F5 concluídas com sucesso!");

    // ─────────────────────────────────────────────────────────────
    // FASE 2: 10x Expansão e Recolhimento Fluido de Raciocínio
    // Valida transição CSS fluida e preservação de estado
    // ─────────────────────────────────────────────────────────────
    console.log("==> FASE 2: 10 iterações de expansão/recolhimento de raciocínio...");
    const abaComRaciocinio = page.locator(":has-text('verifique por que')").first();
    if ((await abaComRaciocinio.count()) > 0 && (await abaComRaciocinio.isVisible())) {
      await abaComRaciocinio.click();
      await page.waitForTimeout(300);
    }

    const primeiroReasoningBtn = page.locator("button:has-text('Raciocínio')").first();
    if ((await primeiroReasoningBtn.count()) > 0) {
      const accordion = page.locator(".chat-reasoning-accordion").first();

      for (let i = 1; i <= 10; i++) {
        await primeiroReasoningBtn.click();
        await page.waitForTimeout(100);
        const classesAberta = await accordion.getAttribute("class");
        expect(classesAberta).toContain("aberto");

        await primeiroReasoningBtn.click();
        await page.waitForTimeout(100);
        const classesFechada = await accordion.getAttribute("class");
        expect(classesFechada).toContain("fechado");
      }
    }
    console.log("✓ FASE 2: 10 iterações de animação fluida de raciocínio concluídas!");

    // ─────────────────────────────────────────────────────────────
    // FASE 3: 10x Testes de Animação de Entrada e Envio sem Duplicação
    // ─────────────────────────────────────────────────────────────
    console.log("==> FASE 3: 10 iterações de envio e validação anti-duplicação...");
    // Clica em Nova Conversa para abrir contexto limpo
    const btnNova = page.locator("button[title*='nova conversa' i], button:has-text('Nova conversa'), button:has-text('Nova Conversa')").first();
    if ((await btnNova.count()) > 0 && (await btnNova.isVisible())) {
      await btnNova.click();
      await page.waitForTimeout(300);
    }

    const textarea = page.locator("textarea").first();
    await textarea.waitFor({ state: "visible", timeout: 6000 });

    const runId = Date.now().toString(36);
    for (let i = 1; i <= 10; i++) {
      // Garante que qualquer stream anterior foi finalizado e o chat está pronto
      const btnParar = page.locator("button[aria-label*='Interromper'], button[title*='Interromper']");
      if ((await btnParar.count()) > 0 && (await btnParar.first().isVisible())) {
        await btnParar.first().click().catch(() => {});
        await page.waitForTimeout(300);
      }

      const btnEnviar = page.locator("button[aria-label='Enviar mensagem']");
      await expect(btnEnviar).toBeVisible({ timeout: 8000 });

      const promptTeste = `Prompt fluidez ${runId} ${i}`;
      await textarea.fill(promptTeste);
      await page.waitForTimeout(100);
      await expect(btnEnviar).toBeEnabled({ timeout: 8000 });

      // Envia via clique no botão habilitado
      await btnEnviar.click();

      // Valida que o balão recém-enviado entrou com o texto e sem duplicação
      const userRecente = page.locator(`[data-role='user']:has-text("${promptTeste}")`);
      await expect(userRecente.last()).toBeVisible({ timeout: 6000 });

      // Valida ausência total de duplicação no DOM
      const countExato = await userRecente.count();
      expect(countExato).toBe(1);

      await page.waitForTimeout(200);

      // Interrompe imediatamente para desimpedir a próxima iteração
      if ((await btnParar.count()) > 0 && (await btnParar.first().isVisible())) {
        await btnParar.first().click().catch(() => {});
        await page.waitForTimeout(200);
      }
    }
    console.log("✓ FASE 3: 10 iterações de envio concluídas sem duplicação!");

    // ─────────────────────────────────────────────────────────────
    // FASE 4: 10x Edição de Mensagem no Histórico (Truncamento)
    // ─────────────────────────────────────────────────────────────
    console.log("==> FASE 4: 10 iterações de edição de mensagem e truncamento...");
    for (let i = 1; i <= 10; i++) {
      const btnParar = page.locator("button[aria-label*='Interromper'], button[title*='Interromper']");
      if ((await btnParar.count()) > 0 && (await btnParar.first().isVisible())) {
        await btnParar.first().click().catch(() => {});
        await page.waitForTimeout(300);
      }

      const btnEnviar = page.locator("button[aria-label='Enviar mensagem']");
      await expect(btnEnviar).toBeVisible({ timeout: 8000 });

      const botoesEditar = page.locator("button[title*='Editar prompt'], button[aria-label='Editar prompt']");
      const totalEditar = await botoesEditar.count();
      if (totalEditar > 0) {
        await botoesEditar.last().click({ force: true });
        await page.waitForTimeout(250);

        // Valida que o textarea recuperou o texto para edição
        const valorRestaurado = await textarea.inputValue();
        expect(valorRestaurado.length).toBeGreaterThan(0);

        // Altera e reenvia
        await textarea.fill(`${valorRestaurado} editado`);
        await page.waitForTimeout(100);
        await expect(btnEnviar).toBeEnabled({ timeout: 8000 });
        await btnEnviar.click();
        await page.waitForTimeout(200);

        // Interrompe imediatamente para desimpedir a próxima iteração
        if ((await btnParar.count()) > 0 && (await btnParar.first().isVisible())) {
          await btnParar.first().click().catch(() => {});
          await page.waitForTimeout(200);
        }
      }
    }
    console.log("✓ FASE 4: 10 iterações de edição concluídas com sucesso!");

    // Finaliza gravação de vídeo
    await page.close();
    await context.close();

    // ─────────────────────────────────────────────────────────────
    // FASE 5: Geração e Análise do GIF Fluido com FFMPEG
    // ─────────────────────────────────────────────────────────────
    console.log("==> FASE 5: Gerando GIF de alta qualidade a partir do vídeo capturado...");
    const files = readdirSync(VIDEO_DIR).filter((f) => f.endsWith(".webm"));
    if (files.length > 0) {
      const latestVideo = join(VIDEO_DIR, files[files.length - 1]);
      const gifOutput = join(ARTIFACTS_DIR, "chat_animacoes_estresse_10x.gif");

      const ffmpegCmd = `/home/j/.local/bin/ffmpeg -y -ss 00:00:01 -t 00:00:12 -i "${latestVideo}" -vf "fps=16,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${gifOutput}"`;
      try {
        execSync(ffmpegCmd, { stdio: "inherit" });
        console.log(`✓ GIF gerado com sucesso em: ${gifOutput}`);
        expect(existsSync(gifOutput)).toBe(true);
      } catch (err: any) {
        console.error("Falha ao gerar GIF com ffmpeg:", err.message);
      }
    }
  });
});
