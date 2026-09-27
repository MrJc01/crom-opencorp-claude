import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "../helpers.js";
import { ConsoleWatcher } from "./pom/base.js";

const TOKEN = "test-e2e";
const WS_ID = "e2e-cors-corp";

test.describe("Auditoria E2E de CORS e Mutações Web (Prevenção de 403 Forbidden)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WS_ID);
    await seederEmpresaBasica(api(page), TOKEN, WS_ID);
  });

  test("1. Mutações via fetch na UI de Fluxos não recebem 403 Forbidden com qualquer origem válida (0.0.0.0 / 127.0.0.1)", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();

    await page.goto("/fluxos");
    await esperarElementoTexto(page, "Fluxos");

    const fluxoId = `flow-test-${Date.now()}`;
    const resultado = await page.evaluate(async ({ id, ws, token }) => {
      // 1. Cria o fluxo via POST /flows
      const postRes = await fetch(`/flows?workspace=${encodeURIComponent(ws)}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id,
          nome: `Fluxo E2E ${id}`,
          workspace: ws,
          nos: [{ id: "n1", tipo: "manual", config: {} }],
          arestas: [],
        }),
      });
      if (!postRes.ok) return { status: postRes.status, ok: false, etapa: "post" };

      // 2. Atualiza o fluxo via PUT /flows/:id (mesmo fluxo da edição visual)
      const putRes = await fetch(`/flows/${encodeURIComponent(id)}?workspace=${encodeURIComponent(ws)}`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id,
          nome: `Fluxo Atualizado ${id}`,
          workspace: ws,
          nos: [{ id: "n1", tipo: "manual", config: { editado: true } }],
          arestas: [],
        }),
      });

      return { status: putRes.status, ok: putRes.ok, etapa: "put" };
    }, { id: fluxoId, ws: WS_ID, token: TOKEN });

    expect(resultado.status).toBe(200);
    expect(resultado.ok).toBe(true);

    watcher.stop();
    const erros403 = watcher.limpos([]).filter((msg) => msg.includes("403"));
    expect(erros403).toHaveLength(0);
  });

  test("2. Todas as rotas mutáveis aceitam preflight e mutação para origens 0.0.0.0, LAN e loopback", async ({ page }) => {
    const origensValidas = [
      "http://0.0.0.0:4100",
      "http://127.0.0.1:4399",
      "http://localhost:4399",
      "http://192.168.1.50:4100",
      "http://10.0.0.15:4100",
      "http://[::1]:4100",
    ];

    for (const origem of origensValidas) {
      // Teste preflight OPTIONS em /flows/:id
      const preflightFlow = await page.request.fetch("/flows/meu-fluxo", {
        method: "OPTIONS",
        headers: {
          origin: origem,
          "access-control-request-method": "PUT",
        },
      });
      expect(preflightFlow.status(), `Preflight em /flows com origem ${origem} falhou`).toBe(204);

      // Teste preflight OPTIONS em /tasks
      const preflightTask = await page.request.fetch("/tasks", {
        method: "OPTIONS",
        headers: {
          origin: origem,
          "access-control-request-method": "POST",
        },
      });
      expect(preflightTask.status(), `Preflight em /tasks com origem ${origem} falhou`).toBe(204);

      // Teste preflight OPTIONS em /settings
      const preflightSettings = await page.request.fetch("/settings", {
        method: "OPTIONS",
        headers: {
          origin: origem,
          "access-control-request-method": "PUT",
        },
      });
      expect(preflightSettings.status(), `Preflight em /settings com origem ${origem} falhou`).toBe(204);

      // Teste mutação POST /flows com header Origin refletindo 0.0.0.0 ou LAN
      const fid = `fluxo-cors-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const postFlow = await page.request.fetch(`/flows?workspace=${encodeURIComponent(WS_ID)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          origin: origem,
        },
        data: {
          id: fid,
          nome: "Fluxo CORS Test",
          workspace: WS_ID,
          nos: [{ id: "inicio", tipo: "manual", config: {} }],
          arestas: [],
        },
      });
      expect(postFlow.status(), `POST /flows com origem ${origem} deve ser 201 (não 403)`).toBe(201);

      // Teste mutação PUT /flows/:id com header Origin refletindo 0.0.0.0 ou LAN
      const putFlow = await page.request.fetch(`/flows/${fid}?workspace=${encodeURIComponent(WS_ID)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          origin: origem,
        },
        data: {
          id: fid,
          nome: "Fluxo CORS Atualizado",
          workspace: WS_ID,
          nos: [{ id: "inicio", tipo: "manual", config: { atualizado: true } }],
          arestas: [],
        },
      });
      expect(putFlow.status(), `PUT /flows/${fid} com origem ${origem} deve ser 200 (não 403)`).toBe(200);

      // Teste mutação POST /tasks
      const postTask = await page.request.fetch(`/tasks?workspace=${encodeURIComponent(WS_ID)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TOKEN}`,
          "content-type": "application/json",
          origin: origem,
        },
        data: {
          titulo: `Tarefa CORS ${origem}`,
          coluna: "backlog",
          prioridade: "media",
        },
      });
      expect(postTask.status(), `POST /tasks com origem ${origem} deve ser 201 (não 403)`).toBe(201);
    }
  });

  test("3. UI de Tasks: criação e transição de estado não sofrem 403", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();

    await page.goto("/tasks");
    await esperarElementoTexto(page, "Quadro Kanban");

    const titulo = `Tarefa E2E ${Date.now()}`;
    await page.getByRole("button", { name: "Nova Tarefa" }).click();
    await esperarElementoTexto(page, "Criar Nova Tarefa");
    await page.getByPlaceholder("Ex: Auditoria técnica de endpoints ou refatoração").fill(titulo);
    await page.getByRole("button", { name: "Criar Tarefa" }).click();

    // Aguarda o card aparecer no Kanban
    await expect(page.getByText(titulo).first()).toBeVisible({ timeout: 10000 });

    watcher.stop();
    const erros403 = watcher.limpos([]).filter((msg) => msg.includes("403"));
    expect(erros403).toHaveLength(0);
  });

  test("4. UI de Configuração: salvamento de preferências não sofre 403", async ({ page }) => {
    const watcher = new ConsoleWatcher(page);
    watcher.start();

    await page.goto("/config");
    await esperarElementoTexto(page, "Geral");

    // Salva configurações usando o botão da aba Geral se houver
    const btnSalvar = page.getByRole("button", { name: /Salvar Alterações/i }).first();
    if (await btnSalvar.isVisible({ timeout: 5000 }).catch(() => false)) {
      await btnSalvar.click();
      await page.waitForTimeout(500);
    }

    watcher.stop();
    const erros403 = watcher.limpos([]).filter((msg) => msg.includes("403"));
    expect(erros403).toHaveLength(0);
  });

  test("5. Segurança Mantida: Origem maliciosa desconhecida continua bloqueada com 403", async ({ page }) => {
    const origemMaliciosa = "https://attacker.evil-corporation.com";

    // Preflight OPTIONS deve ser bloqueado com 403
    const preflight = await page.request.fetch("/flows/qualquer-fluxo", {
      method: "OPTIONS",
      headers: {
        origin: origemMaliciosa,
        "access-control-request-method": "PUT",
      },
    });
    expect(preflight.status()).toBe(403);

    // Mutações POST/PUT devem ser bloqueadas com 403
    const postMutacao = await page.request.fetch(`/tasks?workspace=${encodeURIComponent(WS_ID)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        origin: origemMaliciosa,
      },
      data: {
        titulo: "Tentativa de CSRF Maliciosa",
      },
    });
    expect(postMutacao.status()).toBe(403);
    const corpo = await postMutacao.json();
    expect(corpo.erro).toContain("CORS");
  });
});
