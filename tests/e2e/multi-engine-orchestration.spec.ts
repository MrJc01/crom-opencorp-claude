import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

/** Orquestração multi-motor contra o servidor e2e (fake-opencode, sem LLM real). */
test.describe("Orquestração Multi-Motor (e2e isolado)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("1. Lista agentes com harness e rotação configuráveis", async ({ page }) => {
    const res = await api(page).get("/agents", { headers: HDR });
    expect(res.ok()).toBeTruthy();
    const agentes = await res.json();
    expect(agentes.length).toBeGreaterThan(0);
    for (const a of agentes) {
      expect(a.id).toBeTruthy();
    }
    const exec = agentes.find((a: any) => a.id === "executor-padrao");
    expect(exec).toBeDefined();
  });

  test("2. Roda o mesmo agente com override de engine (202 + exec_id)", async ({ page }) => {
    for (const engine of ["opencode", "copilot"]) {
      const res = await api(page).post("/agents/executor-padrao/run", {
        headers: HDR,
        data: { ordem: `verificar status via ${engine} (e2e)`, engine },
      });
      expect(res.status()).toBe(202);
      const body = await res.json();
      expect(body.exec_id).toBeDefined();
    }
  });

  test("3. Cria sala de reunião e troca mensagens sequencial e paralelo", async ({ page }) => {
    test.setTimeout(120_000);
    const resSala = await api(page).post("/meetings/chat", {
      headers: HDR,
      data: { pauta: "Alinhamento e2e", agentes: "executor-padrao" },
    });
    expect(resSala.status()).toBe(201);
    const sala = await resSala.json();
    expect(sala.id).toBeDefined();
    expect(sala.participantes).toContain("executor-padrao");

    for (const modo of ["sequencial", "paralelo"]) {
      const resMsg = await api(page).post(`/meetings/${encodeURIComponent(sala.id)}/mensagem`, {
        headers: HDR,
        data: { mensagem: `ping ${modo} e2e`, modo },
      });
      expect(resMsg.ok()).toBeTruthy();
      const dados = await resMsg.json();
      expect(dados.mensagemUsuario).toBeDefined();
      expect(Array.isArray(dados.respostas)).toBeTruthy();
    }

    const resEstado = await api(page).get(`/meetings/${encodeURIComponent(sala.id)}`, { headers: HDR });
    expect(resEstado.ok()).toBeTruthy();
    const estado = await resEstado.json();
    expect(estado.mensagens.length).toBeGreaterThan(0);
  });

  test("4. Drawer do Secretário troca o motor de conversa do workspace", async ({ page }) => {
    await page.goto("/secretario");
    await page.locator('[data-testid="btn-configurar-motor"]').click();

    const drawer = page.locator('[data-testid="drawer-lateral-config"]');
    await expect(drawer).toBeVisible({ timeout: 10000 });
    const seletor = drawer.getByTestId("secretario-motor-conversa");
    // Só motores com runtime conversacional são oferecidos
    await expect(seletor.locator("option[value='codex']")).toHaveCount(1, { timeout: 10000 });
    await expect(seletor.locator("option[value='claude-code']")).toHaveCount(0);

    await seletor.selectOption("codex");
    await expect.poll(async () => {
      const r = await api(page).get("/secretario/status?workspace=e2e-corp", { headers: HDR });
      const j = await r.json();
      return `${j.motor?.engineId}:${j.motor?.origem}`;
    }, { timeout: 10000 }).toBe("codex:workspace_override");

    await seletor.selectOption("opencode");
    await expect.poll(async () => {
      const r = await api(page).get("/secretario/status?workspace=e2e-corp", { headers: HDR });
      return (await r.json()).motor?.engineId;
    }, { timeout: 10000 }).toBe("opencode");
  });

  test("5. Fluxo fanout cria e inicia (202 com exec_id)", async ({ page }) => {
    const flowId = `flow-me-${Date.now().toString(36)}`;
    const resCriar = await api(page).post("/flows", {
      headers: HDR,
      data: {
        id: flowId,
        nome: "Fanout e2e",
        nos: [
          { id: "inicio", tipo: "manual", config: {} },
          {
            id: "n1",
            tipo: "fanout",
            config: {
              paralelos: [
                { agente: "executor-padrao", ordem: "resumo um: {{entrada}}" },
                { agente: "executor-padrao", ordem: "resumo dois: {{entrada}}" },
              ],
            },
          },
        ],
        arestas: [{ de: "inicio", para: "n1" }],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(flowId)}/run`, {
      headers: HDR,
      data: { entrada: "Projeto e2e" },
    });
    expect(resRun.status()).toBe(202);
    const resultado = await resRun.json();
    expect(resultado.status).toBe("iniciado");
    expect(resultado.flow).toBe(flowId);
    expect(resultado.exec_id).toBeDefined();
  });

  test("6. Detalhe do agente expõe model e frontmatter de execução", async ({ page }) => {
    const res = await api(page).get("/agents/executor-padrao", { headers: HDR });
    expect(res.ok()).toBeTruthy();
    const detalhe = await res.json();
    const fm = detalhe.frontmatter ?? detalhe;
    expect(fm.model).toBeTruthy();
    expect(typeof fm.model).toBe("string");
  });
});
