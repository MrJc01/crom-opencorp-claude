import { test, expect } from "@playwright/test";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";

const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

/** Garantias de operação contínua: auto-aprovação, espelho agenda→fluxo e idempotência. */
test.describe("Operação contínua (sem travas)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
  });

  test("policy permissive: ordem com padrão ex-HITL não trava (202, sem hitl_pendente)", async ({ page }) => {
    const put = await api(page).put("/settings/security", {
      headers: HDR,
      data: { level: "permissive", hitl_patterns: ["git push"] },
    });
    expect(put.status()).toBe(200);

    const get = await api(page).get("/settings/security", { headers: HDR });
    expect((await get.json()).level).toBe("permissive");

    const run = await api(page).post("/agents/executor-padrao/run", {
      headers: HDR,
      data: { ordem: "git push origin main (verificacao auto-aprovacao e2e)" },
    });
    // permissive: executa em vez de abrir pendência humana
    expect(run.status()).toBe(202);
    const body = await run.json();
    expect(body.exec_id).toBeTruthy();
  });

  test("criação de job legado é recusada (410) e orienta a usar fluxo com nó cron", async ({ page }) => {
    const criado = await api(page).post("/schedules", {
      headers: HDR,
      data: { nome: "job-legado-e2e", agenda_tipo: "intervalo_min", agenda_valor: 1440, args: "task list", workspace: "e2e-corp" },
    });
    expect(criado.status()).toBe(410);
    expect(JSON.stringify(await criado.json())).toContain("POST /flows");
  });

  test("duplo run do mesmo fluxo não colide (ids únicos)", async ({ page }) => {
    const fid = `flow-idem-${Date.now().toString(36)}`;
    await api(page).post("/flows", {
      headers: HDR,
      data: {
        id: fid,
        nome: "Idempotente",
        nos: [
          { id: "inicio", tipo: "manual", config: {} },
          { id: "gravar", tipo: "registro", config: { categoria: "documentos" } },
        ],
        arestas: [{ de: "inicio", para: "gravar" }],
      },
    });
    const r1 = await api(page).post(`/flows/${fid}/run`, { headers: HDR, data: { entrada: "a" } });
    const r2 = await api(page).post(`/flows/${fid}/run`, { headers: HDR, data: { entrada: "b" } });
    const e1 = (await r1.json()).exec_id;
    const e2 = (await r2.json()).exec_id;
    expect(e1).toBeTruthy();
    expect(e2).toBeTruthy();
    expect(e1).not.toBe(e2);

    for (const [flow, exec] of [[fid, e1], [fid, e2]]) {
      const ini = Date.now();
      for (;;) {
        const st = await api(page).get(`/flows/${flow}/execucoes`, { headers: HDR });
        const atual = ((await st.json()) as any[]).find((e: any) => e.execId === exec);
        if (atual && atual.status !== "executando") {
          expect(atual.status).toBe("concluido");
          break;
        }
        if (Date.now() - ini > 20000) throw new Error(`timeout fluxo ${exec}`);
        await new Promise((r) => setTimeout(r, 750));
      }
    }
  });

  test("GET /status expõe saúde do scheduler e secretário", async ({ page }) => {
    const res = await api(page).get("/status", { headers: HDR });
    expect(res.ok()).toBeTruthy();
    const st = await res.json();
    // contrato: chaves presentes (no e2e não há daemon — valor false é válido)
    expect(typeof st.scheduler).toBe("boolean");
    expect(typeof st.secretario).toBe("boolean");
  });
});
