import { test, expect } from "@playwright/test";
import { chmod, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logado, api } from "./helpers.js";
import { SessionManager } from "../../src/core/contexts/execution/session-manager.js";

// F1-T02 — continuar/duplicar no SessionManager (CLI-level via API:
// fixtures via HTTP, execução via SessionManager, verificação via HTTP).
// Roda contra o servidor de teste do playwright (OPENCODE_SERVER_BIN=fake),
// nunca contra a produção :4100.

const TOKEN = "test-e2e";
const E2E_HOME = "/tmp/opencorp-e2e";
const WS = "e2e-sess-cont";
const AGENTE = "agente-sess-cont";
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
        name: "Agente Sessão E2E",
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

// Runner fake: o SessionManager resolve o binário opencode em
// <home>/.opencorp/bin/opencode antes do PATH — um script que sai 0 torna o
// run determinístico sem rede nem chaves (removido ao final de cada teste).
async function instalarFakeRunner(): Promise<void> {
  await mkdir(dirname(FAKE_BIN), { recursive: true });
  await writeFile(
    FAKE_BIN,
    '#!/bin/sh\necho "fake-opencode: execucao concluida com sucesso"\nexit 0\n',
    "utf8",
  );
  await chmod(FAKE_BIN, 0o755);
  // Precedência D3 do resolvedor: PATH vem antes da instalação gerenciada, então o
  // `opencode` real do PC do dono venceria o fake. Põe o diretório do fake na frente do PATH.
  // `aider` real (se instalado no PC) pediria login e travaria: sombreia com um que falha.
  await writeFile(join(dirname(FAKE_BIN), "aider"), '#!/bin/sh\necho "aider ausente (fake e2e)" >&2\nexit 127\n', "utf8");
  await chmod(join(dirname(FAKE_BIN), "aider"), 0o755);
  if (PATH_ORIGINAL === undefined) PATH_ORIGINAL = process.env.PATH ?? "";
  process.env.PATH = `${dirname(FAKE_BIN)}:${PATH_ORIGINAL}`;
}

let PATH_ORIGINAL: string | undefined;

async function removerFakeRunner(): Promise<void> {
  if (PATH_ORIGINAL !== undefined) process.env.PATH = PATH_ORIGINAL;
  await rm(FAKE_BIN, { force: true }).catch(() => undefined);
  await rm(join(dirname(FAKE_BIN), "aider"), { force: true }).catch(() => undefined);
}

// O driver sandbox (bwrap) monta --tmpfs em /tmp e esconde workspaces sob
// /tmp (caso do OPENCORP_HOME de e2e). Força execução direta no workspace
// dedicado deste spec (precedência: workspace > global; sem tocar no default).
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

test.describe("Sessão — continuar/duplicar (F1-T02)", () => {
  test("duplicar cria nova execução com fork_de + snapshot", async ({ page }) => {
    logado(page, TOKEN, WS);
    const client = api(page);
    await garantirBase(client);
    await instalarFakeRunner();
    try {
      const sm = new SessionManager({ homeDir: E2E_HOME });
      const ws = await sm.workspaceDe(WS);
      await forcarDriverHost(ws.path);
      const origem = await sm.rodar({
        agente: AGENTE,
        ordem: "ordem original de duplicação e2e",
        workspaceDir: ws.path,
        pularGuard: true,
      });
      expect(origem.status).toBe("concluido");

      const copia = await sm.duplicar(origem.id, { workspaceDir: ws.path });
      expect(copia.status).toBe("concluido");
      expect(copia.fork_de).toBe(origem.id);
      expect(copia.snapshot.de).toBe(origem.id);
      expect(copia.snapshot.agente).toBe(AGENTE);
      expect(copia.snapshot.ordem).toContain("ordem original de duplicação e2e");

      const res = await client.get(`/registries/execucoes/${copia.id}?workspace=${WS}`, {
        headers: HDR,
      });
      expect(res.status()).toBe(200);
      const corpo = await res.json();
      expect(corpo.meta.extras.fork_de).toBe(origem.id);
      expect(corpo.meta.extras.session_from_ancestral).toBe(origem.id);
      const eventos = (corpo.journal as Array<{ evento: string }>).map((e) => e.evento);
      expect(eventos).toContain("duplicada");

      const lista = await client.get(`/sessions?workspace=${WS}`, { headers: HDR });
      expect(lista.ok()).toBeTruthy();
      const sessoes = (await lista.json()) as Array<{ id: string }>;
      expect(sessoes.some((s) => s.id === copia.id)).toBe(true);
    } finally {
      await removerFakeRunner();
    }
  });

  test("continuar reaproveita a sessão no motor com suporte (opencode)", async ({
    page,
  }) => {
    logado(page, TOKEN, WS);
    const client = api(page);
    await garantirBase(client);
    await instalarFakeRunner();
    try {
      const sm = new SessionManager({ homeDir: E2E_HOME });
      const ws = await sm.workspaceDe(WS);
      await forcarDriverHost(ws.path);
      const origem = await sm.rodar({
        agente: AGENTE,
        ordem: "ordem original de continuação e2e",
        workspaceDir: ws.path,
        pularGuard: true,
      });
      expect(origem.status).toBe("concluido");

      const cont = await sm.continuar(origem.id, "pergunta de continuação e2e", {
        workspaceDir: ws.path,
      });
      expect(cont.status).toBe("concluido");
      expect(cont.continuidade_nativa).toBe(true);
      expect(cont.continuada_de).toBe(origem.id);
      expect(cont.aviso).toBeUndefined();

      const res = await client.get(`/registries/execucoes/${cont.id}?workspace=${WS}`, {
        headers: HDR,
      });
      expect(res.status()).toBe(200);
      const corpo = await res.json();
      expect(corpo.meta.extras.session).toBe(origem.id);
      expect(corpo.meta.extras.continuada_de).toBe(origem.id);
      const eventos = (corpo.journal as Array<{ evento: string }>).map((e) => e.evento);
      expect(eventos).toContain("continuada");
    } finally {
      await removerFakeRunner();
    }
  });

  test("continuar sem suporte nativo reidrata com aviso (aider)", async ({ page }) => {
    logado(page, TOKEN, WS);
    const client = api(page);
    await garantirBase(client);
    await instalarFakeRunner();
    try {
      const sm = new SessionManager({ homeDir: E2E_HOME });
      const ws = await sm.workspaceDe(WS);
      await forcarDriverHost(ws.path);
      const execIdAider = `exec-e2e-aider-${Date.now().toString(36)}`;
      // O binário aider não existe: o run falha, mas o registro fica com harness=aider.
      await sm
        .rodar({
          agente: AGENTE,
          ordem: "ordem original aider e2e",
          engine: "aider",
          execId: execIdAider,
          workspaceDir: ws.path,
          pularGuard: true,
        })
        .catch(() => undefined);

      const metaOrigem = await client.get(
        `/registries/execucoes/${execIdAider}?workspace=${WS}`,
        { headers: HDR },
      );
      expect(metaOrigem.status()).toBe(200);
      expect((await metaOrigem.json()).meta.extras.harness).toBe("aider");

      const cont = await sm.continuar(execIdAider, "pergunta após reidratação e2e", {
        workspaceDir: ws.path,
      });
      expect(cont.status).toBe("concluido");
      expect(cont.continuidade_nativa).toBe(false);
      expect(cont.aviso).toContain("sem-continuidade-nativa");

      const res = await client.get(`/registries/execucoes/${cont.id}?workspace=${WS}`, {
        headers: HDR,
      });
      expect(res.status()).toBe(200);
      const corpo = await res.json();
      expect(corpo.meta.extras.reidratada_de).toBe(execIdAider);
      expect(String(corpo.meta.extras.ordem)).toContain(`[contexto de ${execIdAider}]`);
    } finally {
      await removerFakeRunner();
    }
  });
});
