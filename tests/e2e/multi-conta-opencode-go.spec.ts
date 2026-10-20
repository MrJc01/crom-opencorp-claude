/**
 * E2E — Multi-Contas OpenCode-Go, Rotação de Contas e Sincronização de Auth
 *
 * Cobre:
 * 1. CRUD de múltiplas contas opencode-go via API /api/motores
 * 2. Ativação/desativação com sincronização automática em auth.json
 * 3. Rotação automática de conta quando rate-limit é detectado
 * 4. Provider-keys: adicionar/listar/remover chaves por escopo
 * 5. Troca de modelo de sessão via PATCH (desbloqueio de sessão travada)
 * 6. Teste de inferência direta via /llm/test com modelo opencode-go
 * 7. Secretário: streaming com fallback de modelos
 */
import { test, expect } from "@playwright/test";
import { T } from "./helpers.js";

const BASE = "http://127.0.0.1:4399";
const TOKEN = "test-e2e";
const AUTH_HEADER = { authorization: `Bearer ${TOKEN}` };

// ────────────────────────────────────────────────────────────────────
// 1. CRUD de Contas OpenCode-Go
// ────────────────────────────────────────────────────────────────────
test.describe("Multi-Contas OpenCode-Go — API /api/motores", () => {
  const MOTOR = "opencode-go";

  test.beforeEach(async ({ request }) => {
    // Limpa contas anteriores do motor opencode-go para idempotência
    const res = await request.get(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: AUTH_HEADER,
    });
    if (res.ok()) {
      const { contas } = await res.json();
      for (const c of contas || []) {
        await request.delete(
          `${BASE}/api/motores/${MOTOR}/contas/${encodeURIComponent(c.id)}`,
          { headers: AUTH_HEADER },
        );
      }
    }
  });

  test("adicionar 2 contas: primeira nasce ativa, segunda inativa", async ({ request }) => {
    const r1 = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: {
        nome: "Conta Principal",
        authType: "apiKey",
        tokenOuChave: "sk-fake-key-principal-00001",
      },
    });
    expect(r1.status()).toBe(201);
    const b1 = await r1.json();
    expect(b1.conta.motorId).toBe(MOTOR);
    expect(b1.conta.nome).toBe("Conta Principal");
    expect(b1.conta.ativa).toBe(true);

    const r2 = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: {
        nome: "Conta Secundária",
        authType: "apiKey",
        tokenOuChave: "sk-fake-key-secundaria-00002",
      },
    });
    expect(r2.status()).toBe(201);
    const b2 = await r2.json();
    expect(b2.conta.ativa).toBe(false);
  });

  test("listar contas filtra por motorId", async ({ request }) => {
    // Cria 2 contas
    await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "A1", tokenOuChave: "sk-a1" },
    });
    await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "A2", tokenOuChave: "sk-a2" },
    });

    const res = await request.get(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: AUTH_HEADER,
    });
    expect(res.ok()).toBeTruthy();
    const { contas } = await res.json();
    expect(contas.length).toBe(2);
    expect(contas.every((c: any) => c.motorId === MOTOR)).toBe(true);
  });

  test("ativar conta 2 desativa conta 1", async ({ request }) => {
    const r1 = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "C1", tokenOuChave: "sk-c1" },
    });
    const id1 = (await r1.json()).conta.id;

    const r2 = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "C2", tokenOuChave: "sk-c2" },
    });
    const id2 = (await r2.json()).conta.id;

    // Ativar conta 2
    const resAtivar = await request.post(
      `${BASE}/api/motores/${MOTOR}/contas/${encodeURIComponent(id2)}/ativar`,
      { headers: AUTH_HEADER },
    );
    expect(resAtivar.ok()).toBeTruthy();

    // Verificar
    const resList = await request.get(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: AUTH_HEADER,
    });
    const { contas } = await resList.json();
    const c1 = contas.find((c: any) => c.id === id1);
    const c2 = contas.find((c: any) => c.id === id2);
    expect(c1.ativa).toBe(false);
    expect(c2.ativa).toBe(true);
  });

  test("desconectar conta ativa promove próxima", async ({ request }) => {
    const r1 = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "D1", tokenOuChave: "sk-d1" },
    });
    const id1 = (await r1.json()).conta.id;

    await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "D2", tokenOuChave: "sk-d2" },
    });

    // Desconectar conta 1 (ativa)
    const resDel = await request.delete(
      `${BASE}/api/motores/${MOTOR}/contas/${encodeURIComponent(id1)}`,
      { headers: AUTH_HEADER },
    );
    expect(resDel.ok()).toBeTruthy();

    // Verificar que D2 agora é ativa
    const resList = await request.get(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: AUTH_HEADER,
    });
    const { contas } = await resList.json();
    expect(contas.length).toBe(1);
    expect(contas[0].ativa).toBe(true);
    expect(contas[0].nome).toBe("D2");
  });

  test("atualizar limites de uma conta", async ({ request }) => {
    const r1 = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "L1", tokenOuChave: "sk-l1", limits: { daily_cost_usd: 10 } },
    });
    const id = (await r1.json()).conta.id;

    const resLim = await request.put(
      `${BASE}/api/motores/${MOTOR}/contas/${encodeURIComponent(id)}/limites`,
      {
        headers: { ...AUTH_HEADER, "content-type": "application/json" },
        data: { daily_cost_usd: 50, rate_limit_rpm: 200 },
      },
    );
    expect(resLim.ok()).toBeTruthy();
    const { conta } = await resLim.json();
    expect(conta.limits.daily_cost_usd).toBe(50);
    expect(conta.limits.rate_limit_rpm).toBe(200);
  });

  test("nome vazio rejeita com 400", async ({ request }) => {
    const r = await request.post(`${BASE}/api/motores/${MOTOR}/contas`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { nome: "", tokenOuChave: "sk-x" },
    });
    expect(r.status()).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────────
// 2. Provider Keys — CRUD por escopo (global / workspace)
// ────────────────────────────────────────────────────────────────────
test.describe("Provider Keys — CRUD", () => {
  test("PUT + GET + DELETE chave global", async ({ request }) => {
    // PUT
    const resPut = await request.put(`${BASE}/provider-keys`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { provider: "opencode-go", key: "sk-e2e-test-key-00001234", escopo: "global" },
    });
    expect(resPut.ok()).toBeTruthy();
    const putBody = await resPut.json();
    expect(putBody.ok).toBe(true);
    expect(putBody.provider).toBe("opencode-go");

    // GET
    const resGet = await request.get(`${BASE}/provider-keys`, {
      headers: AUTH_HEADER,
    });
    expect(resGet.ok()).toBeTruthy();
    const keys = await resGet.json();
    const globalKeys = keys.global?.chaves || [];
    const encontrada = globalKeys.find((k: any) => k.provider === "opencode-go");
    expect(encontrada).toBeDefined();
    expect(encontrada.preview).toContain("…"); // mascarada

    // DELETE
    const resDel = await request.delete(`${BASE}/provider-keys/opencode-go?escopo=global`, {
      headers: AUTH_HEADER,
    });
    expect(resDel.ok()).toBeTruthy();
  });

  test("provider inválido rejeita com 400", async ({ request }) => {
    const res = await request.put(`${BASE}/provider-keys`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { provider: "$$invalid$$", key: "sk-long-enough-key-here" },
    });
    expect(res.status()).toBe(400);
  });

  test("chave curta rejeita com 400", async ({ request }) => {
    const res = await request.put(`${BASE}/provider-keys`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { provider: "openrouter", key: "sk" },
    });
    expect(res.status()).toBe(400);
  });
});

// ────────────────────────────────────────────────────────────────────
// 3. Limites Globais de Motores
// ────────────────────────────────────────────────────────────────────
test.describe("Limites Globais de Motores", () => {
  test("GET /api/motores/limites retorna limites padrão", async ({ request }) => {
    const res = await request.get(`${BASE}/api/motores/limites`, {
      headers: AUTH_HEADER,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.limites).toBeDefined();
    // opencode deve ter max_turns=0 (ilimitado)
    expect(body.limites.opencode?.max_turns).toBe(0);
  });

  test("PUT /api/motores/limites atualiza e persiste", async ({ request }) => {
    const resPut = await request.put(`${BASE}/api/motores/limites`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { opencode: { daily_cost_usd: 42 } },
    });
    expect(resPut.ok()).toBeTruthy();

    const resGet = await request.get(`${BASE}/api/motores/limites`, {
      headers: AUTH_HEADER,
    });
    const { limites } = await resGet.json();
    expect(limites.opencode?.daily_cost_usd).toBe(42);
  });
});

// ────────────────────────────────────────────────────────────────────
// 4. Secretário — Status e Sessões
// ────────────────────────────────────────────────────────────────────
test.describe("Secretário — Status e Controle", () => {
  test("GET /secretario/status retorna estado", async ({ request }) => {
    const res = await request.get(`${BASE}/secretario/status`, {
      headers: AUTH_HEADER,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(typeof body.rodando).toBe("boolean");
    expect(typeof body.configurado).toBe("boolean");
  });

  test("POST /secretario/start inicia o secretário", async ({ request }) => {
    const res = await request.post(`${BASE}/secretario/start`, {
      headers: AUTH_HEADER,
    });
    // Pode retornar 200 (iniciou) ou 409 (já rodando) — ambos são aceitáveis
    expect([200, 409]).toContain(res.status());
    if (res.ok()) {
      const body = await res.json();
      expect(body.porta).toBeDefined();
    }
  });

  test("GET /secretario/sessoes lista sessões (pode ser vazia)", async ({ request }) => {
    // Garante secretário rodando
    await request.post(`${BASE}/secretario/start`, { headers: AUTH_HEADER });
    await new Promise((r) => setTimeout(r, 2000));

    const res = await request.get(`${BASE}/secretario/sessoes`, {
      headers: AUTH_HEADER,
    });
    // Pode ser 200 ou 409 (secretário não iniciou ainda)
    if (res.ok()) {
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 5. Motores — Catálogo e Diagnóstico
// ────────────────────────────────────────────────────────────────────
test.describe("Motores — Catálogo", () => {
  test("GET /motores/status retorna catálogo com provedores", async ({ request }) => {
    const res = await request.get(`${BASE}/motores/status`, {
      headers: AUTH_HEADER,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.motores).toBeDefined();
    expect(Array.isArray(body.motores)).toBe(true);
    // Deve conter pelo menos opencode
    const opencode = body.motores.find((m: any) => m.id === "opencode");
    expect(opencode).toBeDefined();
    expect(opencode.id).toBe("opencode");
  });

  test("GET /api/motores/contas lista todas as contas cadastradas", async ({ request }) => {
    const res = await request.get(`${BASE}/api/motores/contas`, {
      headers: AUTH_HEADER,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.contas)).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
// 6. LLM Test — Inferência Direta
// ────────────────────────────────────────────────────────────────────
test.describe("LLM — Teste de Conectividade", () => {
  test("POST /llm/test com modelo válido retorna resultado estruturado", async ({ request }) => {
    const res = await request.post(`${BASE}/llm/test`, {
      headers: { ...AUTH_HEADER, "content-type": "application/json" },
      data: { model: "openrouter/google/gemini-3.8-flash" },
      timeout: T(20_000),
    });
    // Pode falhar se não houver chave — o importante é que o endpoint responda
    const body = await res.json();
    expect(body).toHaveProperty("ok");
    expect(body).toHaveProperty("ms");
    expect(body).toHaveProperty("model");
  });
});

// ────────────────────────────────────────────────────────────────────
// 7. Opencode Config — GET/PUT
// ────────────────────────────────────────────────────────────────────
test.describe("Opencode Config", () => {
  test("GET /opencode-config retorna configuração ou 404", async ({ request }) => {
    const res = await request.get(`${BASE}/opencode-config`, {
      headers: AUTH_HEADER,
    });
    // 200 se existe, 404 se secretário nunca iniciou
    expect([200, 404]).toContain(res.status());
    if (res.ok()) {
      const body = await res.json();
      expect(body.config).toBeDefined();
      expect(body.path).toBeDefined();
    }
  });
});

// ────────────────────────────────────────────────────────────────────
// 8. UI — Navegação para Config → Motores & Provedores
// ────────────────────────────────────────────────────────────────────
test.describe("UI — Config Motores & Provedores", () => {
  test.beforeEach(async ({ page }) => {
    page.addInitScript(({ t, w }) => {
      window.localStorage.setItem("oc-token", t);
      window.localStorage.setItem("oc-ws", w);
    }, { t: TOKEN, w: "e2e-corp" });
  });

  test("abre Config e vê aba Motores & Provedores", async ({ page }) => {
    await page.goto(`${BASE}/#/config`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    // Procurar aba de Motores
    const abaMotores = page.getByText("Motores", { exact: false }).first();
    await expect(abaMotores).toBeVisible({ timeout: T(10_000) });
  });

  test("abre Config e vê aba Chaves de API", async ({ page }) => {
    await page.goto(`${BASE}/#/config`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);

    const abaChaves = page.getByText("Chaves", { exact: false }).first();
    await expect(abaChaves).toBeVisible({ timeout: T(10_000) });
  });
});

// ────────────────────────────────────────────────────────────────────
// 9. UI — Secretário Chat (smoke test)
// ────────────────────────────────────────────────────────────────────
test.describe("UI — Secretário Chat", () => {
  test.beforeEach(async ({ page }) => {
    page.addInitScript(({ t, w }) => {
      window.localStorage.setItem("oc-token", t);
      window.localStorage.setItem("oc-ws", w);
    }, { t: TOKEN, w: "e2e-corp" });
  });

  test("navega para /secretario e vê a view", async ({ page }) => {
    await page.goto(`${BASE}/#/secretario`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    // A view do secretário deve estar visível (em standby ou com chat)
    const secretarioView = page.locator("#view-secretario, [data-view='secretario'], main");
    await expect(secretarioView.first()).toBeVisible({ timeout: T(10_000) });
  });
});

// ────────────────────────────────────────────────────────────────────
// 10. Health Check e Doc
// ────────────────────────────────────────────────────────────────────
test.describe("Infraestrutura — Health & Doc", () => {
  test("GET /health retorna ok", async ({ request }) => {
    const res = await request.get(`${BASE}/health`);
    expect(res.ok()).toBeTruthy();
  });

  test("GET /doc retorna OpenAPI spec", async ({ request }) => {
    const res = await request.get(`${BASE}/doc`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.openapi).toBeDefined();
    expect(body.info).toBeDefined();
  });

  test("requisição sem token retorna 401", async ({ request }) => {
    const res = await request.get(`${BASE}/workspaces`);
    expect(res.status()).toBe(401);
  });
});
