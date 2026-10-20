import { test, expect } from "@playwright/test";
import { chmod, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logado, api } from "../helpers.js";
import { SessionManager } from "../../../src/core/contexts/execution/session-manager.js";
import { RegistryStore } from "../../../src/core/contexts/storage/registry-store.js";

// F1-T03 — seletor de sessão no nó agente (session_mode/session_from) e
// validação topológica de `session_from` (ancestral). Roda contra o servidor de
// teste do playwright (OPENCODE_SERVER_BIN=fake, porta 4399), nunca produção :4100.

const TOKEN = "test-e2e";
const E2E_HOME = "/dev/shm/opencorp-e2e";
const WS = "e2e-flux-sess";
const AGENTE = "agente-flux-sess";
const HDR = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const FAKE_BIN = join(E2E_HOME, ".opencorp", "bin", "opencode");

async function garantirBase(client: ReturnType<typeof api>): Promise<void> {
  await client
    .post("/workspaces", { headers: HDR, data: { id: WS } })
    .catch(() => undefined);
  await client
    .post(`/agents?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: AGENTE,
        name: "Agente Flux Sessão E2E",
        role: "Executor E2E",
        category: "operario",
        model: "openrouter/auto",
        tools: ["bash"],
        permissions: "level-1",
        budget: { daily_usd: 10, max_turns: 10 },
        prompt: "Você é um agente de teste e2e.",
      },
    })
    .catch(() => undefined);
}

async function instalarFakeRunner(): Promise<void> {
  await mkdir(dirname(FAKE_BIN), { recursive: true });
  await writeFile(
    FAKE_BIN,
    '#!/bin/sh\necho "fake-opencode: execucao concluida com sucesso"\nexit 0\n',
    "utf8",
  );
  await chmod(FAKE_BIN, 0o755);
}

async function removerFakeRunner(): Promise<void> {
  await rm(FAKE_BIN, { force: true }).catch(() => undefined);
}

async function forcarDriverHost(wsPath: string): Promise<void> {
  const cfgPath = join(wsPath, ".opencorp", "config.json");
  let cfg: Record<string, unknown> = {};
  try {
    cfg = JSON.parse(await readFile(cfgPath, "utf8")) as Record<string, unknown>;
  } catch {
    /* usa objeto vazio */
  }
  cfg.execution_driver = "host";
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2), "utf8");
}

function noManual(id: string) {
  return { id, tipo: "manual", config: {} };
}

function noAgente(id: string, ordem: string, sessao?: { mode: string; from?: string }) {
  return {
    id,
    tipo: "agente",
    config: {
      agente: AGENTE,
      ordem,
      ...(sessao ? { session_mode: sessao.mode, ...(sessao.from ? { session_from: sessao.from } : {}) } : {}),
    },
  };
}

async function esperarFlowConcluir(
  page: import("@playwright/test").Page,
  flowId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; nos: Array<{ id: string; status: string }> }> {
  const ini = Date.now();
  for (;;) {
    const r = await api(page).get(`/flows/${encodeURIComponent(flowId)}/status?workspace=${WS}`, {
      headers: HDR,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    if (j && j.status && j.status !== "executando") {
      return { status: j.status, nos: j.nos ?? [] };
    }
    if (Date.now() - ini > timeoutMs) throw new Error(`timeout aguardando fluxo ${flowId} concluir`);
    await new Promise((r2) => setTimeout(r2, 600));
  }
}

test.describe("Fluxo — seletor de sessão (F1-T03)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WS);
    await garantirBase(api(page));
    await instalarFakeRunner();
  });

  test.afterEach(async () => {
    await removerFakeRunner();
  });

  test("(a) flow com session_from válido executa (continuar)", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const flowId = `flux-sess-cont-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: flowId,
        nome: "Fluxo sessão continuar",
        nos: [
          noManual("inicio"),
          noAgente("a", "etapa um: {{entrada}}"),
          noAgente("b", "etapa dois: {{entrada}}", { mode: "continuar", from: "a" }),
        ],
        arestas: [
          { de: "inicio", para: "a" },
          { de: "a", para: "b" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(flowId)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "contexto e2e" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, flowId);
    expect(fim.status).toBe("concluido");
    expect(fim.nos.filter((n) => n.status === "ok").length).toBe(3);
  });

  test("(a) flow com session_from válido executa (duplicar)", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const flowId = `flux-sess-dup-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: flowId,
        nome: "Fluxo sessão duplicar",
        nos: [
          noManual("inicio"),
          noAgente("a", "etapa um: {{entrada}}"),
          noAgente("b", "etapa dois: {{entrada}}", { mode: "duplicar", from: "a" }),
        ],
        arestas: [
          { de: "inicio", para: "a" },
          { de: "a", para: "b" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(flowId)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "contexto e2e" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, flowId);
    expect(fim.status).toBe("concluido");
    expect(fim.nos.filter((n) => n.status === "ok").length).toBe(3);
  });

  test("(b) session_from para nó posterior/irmão é barrado no salvar (4xx)", async ({ page }) => {
    // posterior: "a" referencia "b" que vem DEPOIS (descendente, não ancestral)
    const posterior = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: `flux-sess-inv1-${Date.now().toString(36)}`,
        nome: "Inválido posterior",
        nos: [
          noManual("inicio"),
          noAgente("a", "etapa um", { mode: "continuar", from: "b" }),
          noAgente("b", "etapa dois"),
        ],
        arestas: [
          { de: "inicio", para: "a" },
          { de: "a", para: "b" },
        ],
      },
    });
    expect(posterior.status()).toBeGreaterThanOrEqual(400);
    expect(posterior.status()).toBeLessThan(500);

    // irmão: "esquerda" e "direita" saem do mesmo gatilho (nenhum é ancestral do outro)
    const irmao = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: `flux-sess-inv2-${Date.now().toString(36)}`,
        nome: "Inválido irmão",
        nos: [
          noManual("inicio"),
          noAgente("esquerda", "esquerda", { mode: "continuar", from: "direita" }),
          noAgente("direita", "direita"),
        ],
        arestas: [
          { de: "inicio", para: "esquerda" },
          { de: "inicio", para: "direita" },
        ],
      },
    });
    expect(irmao.status()).toBeGreaterThanOrEqual(400);
    expect(irmao.status()).toBeLessThan(500);

    // inexistente: id solto (ex.: "ses_*" de sessão, não de nó)
    const inexistente = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: `flux-sess-inv3-${Date.now().toString(36)}`,
        nome: "Inválido inexistente",
        nos: [
          noManual("inicio"),
          noAgente("a", "etapa um", { mode: "continuar", from: "ses_nao_eh_no" }),
        ],
        arestas: [{ de: "inicio", para: "a" }],
      },
    });
    expect(inexistente.status()).toBeGreaterThanOrEqual(400);
    expect(inexistente.status()).toBeLessThan(500);

    // continuar sem session_from é obrigatório → barrado
    const semFrom = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: `flux-sess-inv4-${Date.now().toString(36)}`,
        nome: "Inválido sem session_from",
        nos: [
          noManual("inicio"),
          noAgente("a", "etapa um", { mode: "continuar" }),
        ],
        arestas: [{ de: "inicio", para: "a" }],
      },
    });
    expect(semFrom.status()).toBeGreaterThanOrEqual(400);
    expect(semFrom.status()).toBeLessThan(500);
  });
});

// F6-T01 (nó LLM-direto/ad-hoc) + F10-T02 (multi-turno explícito no nó agente).
test.describe("Fluxo — nó LLM-direto e multi-turno (F6-T01/F10-T02)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WS);
    await garantirBase(api(page));
    await instalarFakeRunner();
  });

  test.afterEach(async () => {
    await removerFakeRunner();
  });

  test("(a) nó agente SEM agente executa com prompt_sistema + model (LLM-direto)", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const flowId = `flux-llm-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: flowId,
        nome: "Fluxo LLM direto",
        nos: [
          noManual("inicio"),
          {
            id: "ad-hoc",
            tipo: "agente",
            config: {
              prompt_sistema: "Você é um assistente de teste que responde em uma linha.",
              model: "opencode-go/glm-5.3-flash",
              ordem: "resuma: {{entrada}}",
            },
          },
        ],
        arestas: [{ de: "inicio", para: "ad-hoc" }],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(flowId)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "contexto e2e llm" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, flowId);
    expect(fim.status).toBe("concluido");
    expect(fim.nos.filter((n) => n.status === "ok").length).toBe(2);
  });

  test("(b) nó com turnos:2 reaproveita a sessão e o journal registra 2 turnos", async ({ page }) => {
    const sm = new SessionManager({ homeDir: E2E_HOME });
    const ws = await sm.workspaceDe(WS);
    await forcarDriverHost(ws.path);

    const flowId = `flux-turnos-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: flowId,
        nome: "Fluxo multi-turno",
        nos: [
          noManual("inicio"),
          {
            id: "trabalho",
            tipo: "agente",
            config: {
              agente: AGENTE,
              ordem: "refine: {{entrada}}",
              session_mode: "reaproveitar",
              turnos: 2,
            },
          },
        ],
        arestas: [{ de: "inicio", para: "trabalho" }],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(flowId)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "contexto e2e turnos" },
    });
    expect(resRun.status()).toBe(202);
    const runBody = await resRun.json();
    const execId = String(runBody.exec_id ?? "");

    const fim = await esperarFlowConcluir(page, flowId);
    expect(fim.status).toBe("concluido");

    const reg = new RegistryStore();
    const journal = await reg.lerJournal(ws.path, "execucoes", execId);
    const turnos = journal.filter((e) => e.evento === "no-turno");
    expect(turnos.length).toBe(2);
    expect(turnos.map((t) => t.volta as number).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(turnos.every((t) => t.total === 2)).toBe(true);

    // mesma sessão reaproveitada em ambos os turnos (extras.session idêntico)
    const ids = turnos.map((t) => String(t.exec_id ?? ""));
    expect(ids.length).toBe(2);
    const metas = await Promise.all(ids.map((id) => reg.lerMeta(ws.path, "execucoes", id)));
    const sessoes = metas.map((m) => ((m.extras ?? {}) as Record<string, unknown>).session);
    expect(new Set(sessoes.map(String)).size).toBe(1);
    expect(String(sessoes[0]).length).toBeGreaterThan(0);
  });

  test("(c) nó agente sem agente e sem prompt_sistema é barrado no salvar (4xx)", async ({ page }) => {
    const res = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: `flux-inv-llm-${Date.now().toString(36)}`,
        nome: "Inválido sem agente nem prompt",
        nos: [
          noManual("inicio"),
          { id: "vazio", tipo: "agente", config: { ordem: "sem instruções" } },
        ],
        arestas: [{ de: "inicio", para: "vazio" }],
      },
    });
    expect(res.status()).toBeGreaterThanOrEqual(400);
    expect(res.status()).toBeLessThan(500);
  });
});
