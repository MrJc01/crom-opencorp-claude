import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Scheduler, SchedulerError } from "../src/core/contexts/scheduling/scheduler.js";
import { CorpDb } from "../src/core/contexts/storage/corp-db.js";
import { RegistryStore } from "../src/core/contexts/storage/registry-store.js";

const raizes: string[] = [];

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

let relogio = 0;
let home = "";
let scheduler: Scheduler;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "opencorp-sched2-"));
  raizes.push(home);
  relogio = Date.now();
  scheduler = new Scheduler({ homeDir: home, agora: () => new Date(relogio) });
});

describe("Scheduler — validação de args", () => {
  it("barra agent run com --ordem (flag inexistente que matava jobs em silêncio)", async () => {
    await expect(
      scheduler.criar({
        nome: "ciclo",
        agenda: { tipo: "intervalo_min", valor: 60 },
        args: ["agent", "run", "critico-site", "--ordem", "faça"],
      }),
    ).rejects.toThrow(/--ordem/);
  });

  it("aceita ordem posicional (sintaxe correta)", async () => {
    await expect(
      scheduler.criar({
        nome: "ciclo",
        agenda: { tipo: "intervalo_min", valor: 60 },
        args: ["agent", "run", "critico-site", "faça a auditoria"],
      }),
    ).resolves.toBeTruthy();
  });
});

describe("Scheduler — workspace pausado", () => {
  it("não dispara fluxos de workspace pausado e volta ao retomar", async () => {
    const { WorkspaceManager } = await import("../src/core/contexts/workspace/workspace-manager.js");
    const wm = new WorkspaceManager({ homeDir: home });
    await wm.criar("canal-pausa");
    const executados: string[] = [];
    const s = new Scheduler({
      homeDir: home,
      agora: () => new Date(relogio),
      executar: async (job) => {
        executados.push(job.id);
        return "ok";
      },
    });
    await s.criar({ nome: "p1", workspace: "canal-pausa", agenda: { tipo: "intervalo_min", valor: 1 }, args: ["task", "list"] });
    relogio += 2 * 60_000;
    await wm.definirPausado("canal-pausa", true);
    expect((await wm.listar())[0]?.pausado).toBe(true);
    expect((await s.tick()).executados.length).toBe(0);
    await wm.definirPausado("canal-pausa", false);
    expect((await wm.listar())[0]?.pausado).toBeUndefined();
    expect((await s.tick()).executados.length).toBe(1);
    expect(executados.length).toBe(1);
  });
});

describe("Scheduler — claim atômico e job_runs", () => {
  it("tick executa o job vencido e registra run", async () => {
    const executados: string[] = [];
    const s = new Scheduler({
      homeDir: home,
      agora: () => new Date(relogio),
      executar: async (job) => {
        executados.push(job.id);
        return "spawn pid 123";
      },
    });
    await s.criar({ nome: "tick1", agenda: { tipo: "intervalo_min", valor: 1 }, args: ["task", "list"] });
    // vencer o job
    relogio += 2 * 60_000;
    const r = await s.tick();
    expect(r.executados.length).toBe(1);
    expect(executados.length).toBe(1);
    const job = (await s.listar())[0]!;
    const runs = (await s.listarRuns(job.id)) as Array<{ resultado: string; pulado: number; erro: string | null }>;
    expect(runs.length).toBe(1);
    expect(runs[0].resultado).toContain("spawn pid 123");
    expect(runs[0].pulado).toBe(0);
    expect(runs[0].erro).toBeNull();
  });

  it("tick com atraso > graça pula e registra o pulo", async () => {
    const s = new Scheduler({
      homeDir: home,
      agora: () => new Date(relogio),
      executar: async () => "nunca",
    });
    await s.criar({ nome: "atrasado", agenda: { tipo: "intervalo_min", valor: 10 }, args: ["task", "list"], graca_min: 5 });
    relogio += 30 * 60_000; // 30min de atraso > 5min de graça
    const r = await s.tick();
    expect(r.pulados.length).toBe(1);
    const job = (await s.listar())[0]!;
    const runs = (await s.listarRuns(job.id)) as Array<{ pulado: number; erro: string }>;
    expect(runs[0].pulado).toBe(1);
    expect(runs[0].erro).toContain("pulado");
  });

  it("dois schedulers em corrida: só um executa (claim atômico)", async () => {
    let execucoes = 0;
    const criarScheduler = (): Scheduler =>
      new Scheduler({
        homeDir: home,
        agora: () => new Date(relogio),
        executar: async () => {
          execucoes++;
          return "ok";
        },
      });
    const s1 = criarScheduler();
    const s2 = criarScheduler();
    await s1.criar({ nome: "corrida", agenda: { tipo: "intervalo_min", valor: 1 }, args: ["task", "list"] });
    relogio += 2 * 60_000;
    // os dois tickam "ao mesmo tempo"
    const [a, b] = await Promise.all([s1.tick(), s2.tick()]);
    expect(a.executados.length + b.executados.length).toBe(1);
    expect(execucoes).toBe(1);
  });

  it("runNow registra run e avança o próximo ciclo", async () => {
    await scheduler.criar({ nome: "now", agenda: { tipo: "intervalo_min", valor: 60 }, args: ["task", "list"] });
    const job = (await scheduler.listar())[0]!;
    await scheduler.runNow(job.id);
    const runs = await scheduler.listarRuns(job.id);
    expect(runs.length).toBe(1);
    const depois = (await scheduler.listar())[0]!;
    expect(depois.ultima_exec).toBeDefined();
    expect(depois.proxima_exec).not.toBeNull();
  });
});

describe("Scheduler — catch-up (settings.scheduler)", () => {
  const comSettings = async (homeDir: string, cfg: Record<string, unknown>): Promise<void> => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(homeDir, ".opencorp"), { recursive: true });
    await writeFile(join(homeDir, ".opencorp", "settings.json"), JSON.stringify({ version: 1, ...cfg }));
  };

  it("catch_up=true executa job atrasado dentro da janela", async () => {
    await comSettings(home, { scheduler: { catch_up: true, catch_up_max_min: 60 } });
    const s = new Scheduler({ homeDir: home, agora: () => new Date(relogio), executar: async () => "executado!" });
    await s.criar({ nome: "atrasado", agenda: { tipo: "intervalo_min", valor: 10 }, args: ["task", "list"], graca_min: 5 });
    relogio += 30 * 60_000; // 30min atraso > graça 5, mas <= janela 60
    const r = await s.tick();
    expect(r.executados.length).toBe(1);
    expect(r.pulados.length).toBe(0);
    const job = (await s.listar())[0]!;
    const runs = (await s.listarRuns(job.id)) as Array<{ resultado: string; pulado: number }>;
    // 2 runs: o do catch-up (antes da execução) + o da execução em si
    expect(runs.length).toBe(2);
    expect(runs.map((r) => r.resultado).join(" | ")).toContain("catch-up");
    expect(runs[0]!.pulado).toBe(0);
  });

  it("catch_up=true mas atraso além da janela → pula", async () => {
    await comSettings(home, { scheduler: { catch_up: true, catch_up_max_min: 60 } });
    const s = new Scheduler({ homeDir: home, agora: () => new Date(relogio), executar: async () => "nunca" });
    await s.criar({ nome: "muito-atrasado", agenda: { tipo: "intervalo_min", valor: 10 }, args: ["task", "list"], graca_min: 5 });
    relogio += 3 * 60 * 60_000; // 3h atraso > janela 60min
    const r = await s.tick();
    expect(r.pulados.length).toBe(1);
    expect(r.executados.length).toBe(0);
  });

  it("catch_up=false (default) pula atrasado mesmo dentro da janela", async () => {
    const s = new Scheduler({ homeDir: home, agora: () => new Date(relogio), executar: async () => "nunca" });
    await s.criar({ nome: "atrasado", agenda: { tipo: "intervalo_min", valor: 10 }, args: ["task", "list"], graca_min: 5 });
    relogio += 30 * 60_000;
    const r = await s.tick();
    expect(r.pulados.length).toBe(1);
  });
});

describe("CorpDb — mensagens e sessões da secretária", () => {
  it("migração cria tabelas mensagens e grava/recupera mensagens", async () => {
    const wsHome = await mkdtemp(join(tmpdir(), "opencorp-ws-"));
    raizes.push(wsHome);
    const db = new CorpDb(join(wsHome, ".opencorp", "corp.db"));
    db.upsertSessao({ id: "ses_x", agente: "secretario", modelo: "", inicio: "2026-08-31T10:00:00Z", fim: "2026-08-31T10:01:00Z", custo_usd: null, status: "concluida" });
    db.inserirMensagem({ id: "m1", sessao_id: "ses_x", agente: "secretario", role: "user", conteudo: "oi", criado_em: "2026-08-31T10:00:01Z" });
    db.inserirMensagem({ id: "m2", sessao_id: "ses_x", agente: "secretario", role: "assistant", conteudo: "olá!", criado_em: "2026-08-31T10:01:00Z" });
    db.inserirMensagem({ id: "m1", sessao_id: "ses_x", agente: "secretario", role: "user", conteudo: "oi duplicado", criado_em: null });
    const msgs = db.mensagensDaSessao("ses_x");
    expect(msgs.length).toBe(2); // id duplicado não regrava
    expect(msgs[0].conteudo).toBe("oi");

    const sessoes = db.listarSessoes({ agentePrefixo: "secretario" });
    expect(sessoes.length).toBe(1);
    expect(sessoes[0].agente).toBe("secretario");
    db.fechar();
  });

  it("corpDb acessível via RegistryStore (mesma instância por caminho)", async () => {
    const wsHome = await mkdtemp(join(tmpdir(), "opencorp-ws2-"));
    raizes.push(wsHome);
    const registros = new RegistryStore();
    const db = registros.corpDb(wsHome);
    db.upsertSessao({ id: "ses_y", agente: "secretario-exec", modelo: "", inicio: "2026-08-31T10:00:00Z", fim: null, custo_usd: null, status: "concluida" });
    const deNovo = registros.corpDb(wsHome);
    expect(deNovo.listarSessoes({ agentePrefixo: "secretario-exec" }).length).toBe(1);
    registros.fechar();
  });
});
