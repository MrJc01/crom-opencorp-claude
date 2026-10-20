import { test, expect } from "@playwright/test";
import { logado, api } from "../helpers.js";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

const TOKEN = "test-e2e";
const WS = "e2e-flux-join";
const HDR = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

async function garantirBase(client: ReturnType<typeof api>): Promise<void> {
  await client
    .post("/workspaces", { headers: HDR, data: { id: WS } })
    .catch(() => undefined);
}

async function criarAgente(client: ReturnType<typeof api>, wsId: string, agenteId: string, nome: string, prompt: string): Promise<void> {
  await client
    .post(`/agents?workspace=${wsId}`, {
      headers: HDR,
      data: {
        id: agenteId,
        name: nome,
        role: "Executor E2E",
        category: "operario",
        model: "openrouter/auto",
        tools: ["bash"],
        permissions: "level-1",
        budget: { daily_usd: 10, max_turns: 10 },
        prompt,
      },
    })
    .catch(() => undefined);
}

async function instalarFakeRunner(): Promise<void> {
  const fakeBin = join("/dev/shm/opencorp-e2e", ".opencorp", "bin", "opencode-fake");
  await mkdir(join("/dev/shm/opencorp-e2e", ".opencorp", "bin"), { recursive: true });
  await writeFile(
    fakeBin,
    '#!/bin/sh\nsleep 0.2\nlast=""\nfor arg do last="$arg"; done\nprintf "SAIDA: %s\\n" "$last"\nexit 0\n',
    "utf8",
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function removerFakeRunner(): Promise<void> {
  const fakeBin = join("/dev/shm/opencorp-e2e", ".opencorp", "bin", "opencode-fake");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await rm(fakeBin, { force: true });
}

function noManual(id: string) {
  return { id, tipo: "manual", config: {} };
}

function noAgente(id: string, ordem: string, agenteId: string) {
  return { id, tipo: "agente", config: { agente: agenteId, ordem } };
}

function noFanout(id: string, paralelos: any[], sintese?: any) {
  return { id, tipo: "fanout", config: { paralelos, ...(sintese ? { sintese } : {}) } };
}

function noReview(id: string, agenteExecutor: string, agenteRevisor: string) {
  return { id, tipo: "review", config: { executor: { agente: agenteExecutor, ordem: "{{entrada}} recomenda" }, revisor: { agente: agenteRevisor, ordem: "APROVADO ou AJUSTES: <motivo>" } } };
}

function noDebate(id: string, agenteProp1: string, agenteProp2: string, agenteMod: string) {
  return { id, tipo: "debate", config: { proponentes: [
    { agente: agenteProp1, ordem: "{{entrada}} Proposta A" },
    { agente: agenteProp2, ordem: "{{entrada}} Proposta B" },
  ], moderador: { agente: agenteMod, ordem: "" } } };
}

async function esperarFlowConcluir(
  page: import("@playwright/test").Page,
  flowId: string,
  timeoutMs = 30_000,
): Promise<{ execId: string; status: string; contextoFinal: string }> {
  const ini = Date.now();
  for (;;) {
    const r = await api(page).get(`/flows/${encodeURIComponent(flowId)}/status?workspace=${WS}`, {
      headers: HDR,
    });
    expect(r.status()).toBe(200);
    const j = await r.json();
    if (j && j.execId && j.status && j.status !== "executando") {
      return { execId: j.execId, status: j.status, contextoFinal: j.contextoFinal ?? "" };
    }
    if (Date.now() - ini > timeoutMs) throw new Error(`timeout aguardando fluxo ${flowId} concluir`);
    await new Promise((r2) => setTimeout(r2, 600));
  }
}

test.describe("Fluxo — fanout / review / debate (F9-T01)", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WS);
    await garantirBase(api(page));
    await instalarFakeRunner();
  });

  test.afterEach(async () => {
    await removerFakeRunner();
  });

  test("F9-T01-c1: fanout — múltiplos agentes em paralelo com sintese consolida saida", async ({ page }) => {
    const agenteA = `agente-fanout-a-${Date.now().toString(36)}`;
    const agenteB = `agente-fanout-b-${Date.now().toString(36)}`;

    await criarAgente(api(page), WS, agenteA, "Agente Fanout A", "Você é um agente de teste e2e.");
    await criarAgente(api(page), WS, agenteB, "Agente Fanout B", "Você é um agente de teste e2e.");

    const fluxo = `fluxo-fanout-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: fluxo,
        nome: "Fanout Teste",
        nos: [
          noManual("inicio"),
          noFanout("fanout", [
            { agente: agenteA, ordem: "RAMA-A: {{entrada}}" },
            { agente: agenteB, ordem: "RAMA-B: {{entrada}}" },
          ], {
            agente: agenteA,
            ordem: "SINTES: concatene as duas saídas e responda apenas 'OK'.",
          }),
        ],
        arestas: [
          { de: "inicio", para: "fanout" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(fluxo)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "entrada-fanout-e2e" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, fluxo);
    expect(fim.status).toBe("concluido");
    expect(fim.contextoFinal).toContain("RAMA-A");
    expect(fim.contextoFinal).toContain("RAMA-B");

    const contextoLower = fim.contextoFinal.toLowerCase();
    expect(contextoLower).toContain("rama-a");
    expect(contextoLower).toContain("rama-b");
  });

  test("F9-T01-c2: review — loop continua até APROVADO aparecer na primeira linha do revisor", async ({ page }) => {
    const agenteExecutor = `agente-review-exec-${Date.now().toString(36)}`;
    const agenteRevisor = `agente-review-rev-${Date.now().toString(36)}`;

    await criarAgente(api(page), WS, agenteExecutor, "Agente Review Executor", "Você é um executor de teste e2e.");
    await criarAgente(api(page), WS, agenteRevisor, "Agente Review Revisor", "Você é um revisor de teste e2e.");

    const fluxo = `fluxo-review-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: fluxo,
        nome: "Review Teste",
        nos: [
          noManual("inicio"),
          noReview("review", agenteExecutor, agenteRevisor),
        ],
        arestas: [
          { de: "inicio", para: "review" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(fluxo)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "por favor processe isto" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, fluxo);
    expect(fim.status).toBe("concluido");

    // Aprovado pelo revisor, o contexto que segue é a saída do executor.
    expect(fim.contextoFinal).toContain("recomenda");
  });

  test("F9-T01-c3: debate — moderador resposta começa com 'DECISÃO:' na primeira linha", async ({ page }) => {
    const agenteProp1 = `agente-debate-p1-${Date.now().toString(36)}`;
    const agenteProp2 = `agente-debate-p2-${Date.now().toString(36)}`;
    const agenteMod = `agente-debate-m-${Date.now().toString(36)}`;

    await criarAgente(api(page), WS, agenteProp1, "Agente Debate P1", "Você é um proponente de teste e2e.");
    await criarAgente(api(page), WS, agenteProp2, "Agente Debate P2", "Você é um proponente de teste e2e.");
    await criarAgente(api(page), WS, agenteMod, "Agente Debate Moderador", "Você é um moderador de teste e2e.");

    const fluxo = `fluxo-debate-${Date.now().toString(36)}`;
    const resCriar = await api(page).post(`/flows?workspace=${WS}`, {
      headers: HDR,
      data: {
        id: fluxo,
        nome: "Debate Teste",
        nos: [
          noManual("inicio"),
          noDebate("debate", agenteProp1, agenteProp2, agenteMod),
        ],
        arestas: [
          { de: "inicio", para: "debate" },
        ],
      },
    });
    expect(resCriar.status()).toBe(201);

    const resRun = await api(page).post(`/flows/${encodeURIComponent(fluxo)}/run?workspace=${WS}`, {
      headers: HDR,
      data: { entrada: "definir protocolo de seguranca" },
    });
    expect(resRun.status()).toBe(202);

    const fim = await esperarFlowConcluir(page, fluxo);
    expect(fim.status).toBe("concluido");

    const primeiraLinha = fim.contextoFinal.split("\n")[0];
    expect(primeiraLinha).toMatch(/^DECISÃO:/i);
  });
});