import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { afterEach } from "vitest";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Scheduler } from "../src/core/contexts/scheduling/scheduler.js";
import {
  SessionManager,
  WatchdogRun,
  proximoModeloRotacao,
  tetoRunPadraoMs,
} from "../src/core/contexts/execution/session-manager.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";
import { RegistryStore } from "../src/core/contexts/storage/registry-store.js";
import { CorpDb } from "../src/core/contexts/storage/corp-db.js";
import { formatarDataExecucao, dataDeExecucao } from "../src/cli/commands/monitor.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));
vi.mock("../src/core/contexts/execution/execution-driver.js", () => ({
  resolverDriverExecucao: async () => ({
    tipo: "host",
    disponivel: async () => true,
    preparar: async (opts: any) => ({
      driver: "host",
      binary: opts.binary,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
    }),
  }),
}));

const raizes: string[] = [];

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

beforeEach(() => {
  execaMock.mockClear();
});

function fakeChild(out: string[], exitCode = 0, pid = 424242) {
  const child = Promise.resolve({ exitCode, killed: false }) as unknown as {
    stdout: Readable;
    stderr: Readable;
    pid?: number;
    killed: boolean;
  } & Promise<{ exitCode: number; killed: boolean }>;
  child.stdout = Readable.from(out);
  child.stderr = Readable.from([]);
  child.pid = pid;
  child.killed = false;
  return child;
}

function filhoTravado(pid = 424242) {
  let resolver!: (v: { exitCode: number; killed: boolean }) => void;
  const promessa = new Promise<{ exitCode: number; killed: boolean }>((resolve) => {
    resolver = resolve;
  });
  const child = promessa as typeof promessa & {
    stdout: Readable;
    stderr: Readable;
    pid?: number;
    killed: boolean;
  };
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.pid = pid;
  child.killed = false;
  return { child, encerrar: () => resolver({ exitCode: 1, killed: true }) };
}

async function ambiente() {
  const home = await mkdtemp(join(tmpdir(), "opencorp-robusto-"));
  raizes.push(home);
  const manager = new WorkspaceManager({ homeDir: home, cwd: home });
  const ws = await manager.criar("corp-robusto");
  const sessoes = new SessionManager({ homeDir: home, cwd: home });
  return { home, ws, sessoes };
}

function dormir(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ateQue(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!(await Promise.resolve(cond()).catch(() => false))) {
    if (Date.now() - t0 > ms) throw new Error("condição não atingida em tempo");
    await dormir(10);
  }
}

async function primeiroExecId(wsPath: string): Promise<string> {
  const dir = join(wsPath, ".opencorp", "registries", "execucoes");
  await ateQue(() => readdirSync(dir).some((e) => !e.startsWith(".")));
  return readdirSync(dir).filter((e) => !e.startsWith("."))[0]!;
}

async function lerMetaJson(wsPath: string, id: string): Promise<Record<string, any>> {
  return JSON.parse(
    await readFile(join(wsPath, ".opencorp", "registries", "execucoes", id, "meta.json"), "utf8"),
  );
}

async function lerJournal(wsPath: string, id: string): Promise<string> {
  return readFile(join(wsPath, ".opencorp", "registries", "execucoes", id, "journal.jsonl"), "utf8");
}

async function escreverStatus(wsPath: string, id: string, status: string): Promise<void> {
  const meta = await lerMetaJson(wsPath, id);
  meta.extras.status = status;
  await writeFile(
    join(wsPath, ".opencorp", "registries", "execucoes", id, "meta.json"),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );
}

function espiarKill(encerrar?: () => void): { sinais: string[]; restaurar: () => void } {
  const sinais: string[] = [];
  const spy = vi
    .spyOn(process, "kill")
    .mockImplementation(((pid: number, sinal?: string | number) => {
      if (sinal === "SIGTERM" || sinal === "SIGKILL") sinais.push(String(sinal));
      if (sinal === "SIGTERM" && encerrar) encerrar();
      return true;
    }) as unknown as typeof process.kill);
  return { sinais, restaurar: () => spy.mockRestore() };
}

describe("WatchdogRun — unidade (relógio injetado)", () => {
  it("mata (SIGTERM → SIGKILL) quando o teto estoura com status executando, e só uma vez", async () => {
    const sinais: string[] = [];
    let relogio = 0;
    let estourou = 0;
    const w = new WatchdogRun({
      tetoMs: 100,
      pid: 4242,
      matar: (s) => sinais.push(s),
      gracaKillMs: 0,
      dormir: async () => {},
      agora: () => relogio,
      aoEstourar: () => {
        estourou++;
      },
    });
    expect(await w.verificar()).toBe(false);
    relogio = 99;
    expect(await w.verificar()).toBe(false);
    expect(sinais).toEqual([]);
    relogio = 100;
    expect(await w.verificar()).toBe(true);
    expect(sinais).toEqual(["SIGTERM", "SIGKILL"]);
    expect(estourou).toBe(1);
    expect(w.estourou).toBe(true);
    expect(await w.verificar()).toBe(false);
    expect(estourou).toBe(1);
  });

  it("NÃO mata em hitl_pendente — pausa o relógio e retoma a contagem ao voltar", async () => {
    const sinais: string[] = [];
    let relogio = 0;
    let status: string | undefined = "executando";
    const w = new WatchdogRun({
      tetoMs: 100,
      pid: 4242,
      matar: (s) => sinais.push(s),
      gracaKillMs: 0,
      dormir: async () => {},
      agora: () => relogio,
      obterStatus: async () => status,
      aoEstourar: () => undefined,
    });
    relogio = 50;
    expect(await w.verificar()).toBe(false);
    status = "hitl_pendente";
    relogio = 80;
    expect(await w.verificar()).toBe(false);
    relogio = 99_000;
    expect(await w.verificar()).toBe(false);
    expect(sinais).toEqual([]);
    status = "executando";
    relogio = 99_050;
    expect(await w.verificar()).toBe(false);
    relogio = 99_100;
    expect(await w.verificar()).toBe(true);
    expect(sinais).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("status final (concluido) encerra o watchdog sem matar", async () => {
    const sinais: string[] = [];
    let relogio = 0;
    let status: string | undefined = "executando";
    const w = new WatchdogRun({
      tetoMs: 100,
      pid: 4242,
      matar: (s) => sinais.push(s),
      gracaKillMs: 0,
      dormir: async () => {},
      agora: () => relogio,
      obterStatus: async () => status,
    });
    relogio = 10_000;
    status = "concluido";
    expect(await w.verificar()).toBe(false);
    expect(sinais).toEqual([]);
    expect(w.estourou).toBe(false);
  });
});

describe("Watchdog via rodar (execa mockado — child fake)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mata run travado e finaliza 'falhou' com a mensagem de timeout", async () => {
    const { ws, sessoes } = await ambiente();
    const { child, encerrar } = filhoTravado(424242);
    execaMock.mockImplementation(() => child);
    const { sinais, restaurar } = espiarKill(() => encerrar());
    const r = await sessoes.rodar({
      agente: "executor-padrao",
      ordem: "trabalho longo demais",
      timeoutMs: 80,
      watchdogIntervalMs: 10,
      watchdogGracaMs: 5,
    });
    restaurar();
    expect(r.status).toBe("falhou");
    expect(r.exit_code).toBeNull();
    expect(r.duracao_ms).toBeGreaterThanOrEqual(80);
    expect(sinais).toContain("SIGTERM");
    expect(sinais).toContain("SIGKILL");
    const meta = await lerMetaJson(ws.path, r.id);
    expect(meta.extras.status).toBe("falhou");
    const journal = await lerJournal(ws.path, r.id);
    expect(journal).toContain("opencode morto (modelo travado?)");
  });

  it("NÃO mata enquanto o registro está hitl_pendente; mata após voltar a executando", { timeout: 90_000 }, async () => {
    const { ws, sessoes } = await ambiente();
    const { child, encerrar } = filhoTravado(424242);
    execaMock.mockImplementation(() => child);
    const { sinais, restaurar } = espiarKill(() => encerrar());
    const promessa = sessoes.rodar({
      agente: "executor-padrao",
      ordem: "trabalho pausável",
      timeoutMs: 150,
      watchdogIntervalMs: 20,
      watchdogGracaMs: 5,
    });
    const id = await primeiroExecId(ws.path);
    // O run grava meta.json (pid + status "executando") depois de spawnar o filho; escrever
    // hitl_pendente antes disso seria sobrescrito (corrida read-modify-write sob carga).
    await ateQue(async () => (await lerMetaJson(ws.path, id)).extras?.pid === 424242);
    await escreverStatus(ws.path, id, "hitl_pendente");
    await dormir(400);
    expect(sinais).toEqual([]);
    await escreverStatus(ws.path, id, "executando");
    await ateQue(() => sinais.includes("SIGTERM"));
    const r = await promessa;
    restaurar();
    expect(sinais).toContain("SIGTERM");
    expect(sinais).toContain("SIGKILL");
    expect(r.status).toBe("falhou");
    const meta = await lerMetaJson(ws.path, id);
    expect(meta.extras.status).toBe("falhou");
  });
});

describe("tetoRunPadraoMs (constante 20min + env OPENCORP_RUN_TIMEOUT_MIN)", () => {
  const ENV = "OPENCORP_RUN_TIMEOUT_MIN";
  const comEnv = async (valor: string | undefined, rodar: () => Promise<void>) => {
    const anterior = process.env[ENV];
    if (valor === undefined) delete process.env[ENV];
    else process.env[ENV] = valor;
    try {
      await rodar();
    } finally {
      if (anterior === undefined) delete process.env[ENV];
      else process.env[ENV] = anterior;
    }
  };
  const homeIsolada = "/caminho-inexistente-opencorp-runs-robustos";

  it("padrão é 20min", async () => {
    await comEnv(undefined, async () => {
      expect(await tetoRunPadraoMs(homeIsolada)).toBe(20 * 60_000);
    });
  });

  it("env sobrepõe; 0 desativa; inválido cai no padrão", async () => {
    await comEnv("5", async () => {
      expect(await tetoRunPadraoMs(homeIsolada)).toBe(5 * 60_000);
    });
    await comEnv("0", async () => {
      expect(await tetoRunPadraoMs(homeIsolada)).toBeUndefined();
    });
    await comEnv("abc", async () => {
      expect(await tetoRunPadraoMs(homeIsolada)).toBe(20 * 60_000);
    });
  });
});

describe("proximoModeloRotacao", () => {
  it("índice → próximo, com wrap", () => {
    expect(proximoModeloRotacao(["a", "b", "c"], "a")).toBe("b");
    expect(proximoModeloRotacao(["a", "b", "c"], "c")).toBe("a");
  });

  it("modelo fora da lista → lista[0] (se diferente do falho)", () => {
    expect(proximoModeloRotacao(["a", "b"], "z")).toBe("a");
    expect(proximoModeloRotacao(["z"], "z")).toBeNull();
  });

  it("lista vazia → null", () => {
    expect(proximoModeloRotacao([], "a")).toBeNull();
  });
});

describe("Rotação de modelo no retry (execa mockado)", () => {
  /** Define a cadeia explícita de modelos do workspace (Etapa 13: sem listas embutidas). */
  async function rotacaoWorkspace(wsPath: string, rotacao: string[]) {
    const cfgPath = join(wsPath, ".opencorp", "config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8").catch(() => "{}"));
    cfg.modelos = { rotacao }; // sem `padrao`: a cadeia é só agente → esta rotação
    await writeFile(cfgPath, JSON.stringify(cfg), "utf8");
  }

  it("falha de cota/conexão → 1 retry com o próximo modelo da cadeia explícita, no mesmo motor", async () => {
    const { ws, sessoes } = await ambiente();
    await rotacaoWorkspace(ws.path, ["openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"]);
    execaMock.mockImplementationOnce(() =>
      fakeChild(["AI_APICallError: Weekly usage limit reached\n"], 1),
    );
    execaMock.mockImplementationOnce(() => fakeChild(["trabalho feito\n"], 0));
    const r = await sessoes.rodar({
      agente: "executor-padrao",
      ordem: "roda com quota instável",
      gatilho: { tipo: "cron", origem: "sch-ciclo-1" },
    });
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("concluido");
    expect(r.modelo).toBe("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");
    const [, args2] = execaMock.mock.calls[1]!;
    expect(args2).toContain("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free");

    const registros = new RegistryStore();
    const metas = await registros.listar(ws.path, "execucoes");
    expect(metas).toHaveLength(2);
    const metaRetry = metas.find((m) => Boolean((m.extras as any)?.retry))!;
    const metaOriginal = metas.find((m) => !(m.extras as any)?.retry)!;
    expect(metaRetry.extras!.retry).toEqual({
      de_modelo: "opencode-go/glm-5.3-flash",
      de_exec: metaOriginal.id,
    });
    expect(metaRetry.tags).toContain("retry");
    expect((metaRetry.extras!.gatilho as any).origem).toBe(
      "sch-ciclo-1 · retry:openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    );
    const journal = await lerJournal(ws.path, metaOriginal.id);
    expect(journal).toContain("retry_modelo");
    // Motivo auditável da decisão.
    expect(journal).toContain('no motor \\"opencode\\"');

    const db = new CorpDb(join(ws.path, ".opencorp", "corp.db"));
    const linhas = db.listarExecucoes({ gatilho_tipo: "cron" });
    expect(linhas).toHaveLength(2);
    const linhaRetry = linhas.find((l) => l.gatilho_origem.includes("retry"))!;
    expect(linhaRetry.gatilho_origem).toBe(
      "sch-ciclo-1 · retry:openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
    );
    expect(linhaRetry.status).toBe("concluido");
    db.fechar();
  });

  it("usa settings.tests.rotation quando configurada (falho fora da lista → lista[0])", async () => {
    const { home, sessoes } = await ambiente();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await writeFile(
      join(home, ".opencorp", "settings.json"),
      JSON.stringify({ version: 1, tests: { rotation: ["openrouter/qwen/qwen3.8-27b:free", "openrouter/z-ai/glm-5.2:free"] } }),
      "utf8",
    );
    execaMock.mockImplementationOnce(() => fakeChild(["Cannot connect to API\n"], 1));
    execaMock.mockImplementationOnce(() => fakeChild(["ok\n"], 0));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "roda" });
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(r.modelo).toBe("openrouter/qwen/qwen3.8-27b:free");
    const [, args2] = execaMock.mock.calls[1]!;
    expect(args2).toContain("openrouter/qwen/qwen3.8-27b:free");
  });

  it("modelo bloqueado pela governança e modelo de outro motor não entram na rotação; sem candidato, para com motivo", async () => {
    const { ws, sessoes } = await ambiente();
    await rotacaoWorkspace(ws.path, ["free/sem-metadados", "codex/gpt-x", "openrouter/meta/llama-3.2-1b:free"]);
    execaMock.mockImplementation(() => fakeChild(["AI_APICallError: Weekly usage limit reached\n"], 1));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "falha sem alternativa" });
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("falhou");
    const journal = await lerJournal(ws.path, r.id);
    expect(journal).toContain("fallback_interrompido");
    expect(journal).toContain("bloqueado para rotação autônoma");
    expect(journal).toContain('pertence ao motor \\"codex\\"');
    expect(journal).toContain("troca de motor não autorizada");
  });

  it("motor explícito não é trocado pelo prefixo do modelo: falha antes do spawn", async () => {
    const { sessoes } = await ambiente();
    execaMock.mockImplementation(() => fakeChild(["não deveria rodar\n"], 0));
    await expect(
      sessoes.rodar({ agente: "executor-padrao", ordem: "conflito", engine: "opencode", model: "codex/gpt-x" }),
    ).rejects.toThrow(/não é compatível com o motor "opencode"/);
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("sem cadeia explícita não há retry (nada de listas embutidas)", async () => {
    const { ws, sessoes } = await ambiente();
    await rotacaoWorkspace(ws.path, []);
    execaMock.mockImplementation(() => fakeChild(["AI_APICallError: Weekly usage limit reached\n"], 1));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "sem cadeia", model: "opencode-go/glm-5.3-flash" });
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("falhou");
  });

  it("nunca retenta além de 1 (retry que falha de novo não gera 3º run)", async () => {
    const { sessoes } = await ambiente();
    execaMock.mockImplementation(() =>
      fakeChild(["AI_APICallError: Weekly usage limit reached\n"], 1),
    );
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "sempre quebra" });
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect(r.status).toBe("falhou");
  });

  it("falha sem padrão de erro de modelo não dispara retry", async () => {
    const { sessoes } = await ambiente();
    execaMock.mockImplementation(() => fakeChild(["boom comum\n"], 3));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "falha comum" });
    expect(execaMock).toHaveBeenCalledTimes(1);
    expect(r.status).toBe("falhou");
  });
});

describe("Reaper de zumbis no tick do scheduler", () => {
  it("reconciliar injetado aparece no retorno do tick", async () => {
    const home = await mkdtemp(join(tmpdir(), "opencorp-reaper-inj-"));
    raizes.push(home);
    const scheduler = new Scheduler({
      homeDir: home,
      reconciliar: async () => ["exec-z1", "exec-z2"],
    });
    const r = await scheduler.tick();
    expect(r.reconciliados).toEqual(["exec-z1", "exec-z2"]);
    expect(r.executados).toEqual([]);
    expect(r.pulados).toEqual([]);
  });

  it("reconcilia execução 'executando' com pid morto → falhou com (reaper)", async () => {
    const home = await mkdtemp(join(tmpdir(), "opencorp-reaper-"));
    raizes.push(home);
    const manager = new WorkspaceManager({ homeDir: home, cwd: home });
    const ws = await manager.criar("corp-reaper");
    const registros = new RegistryStore();
    await registros.garantirCategorias(ws.path);
    await registros.criar(ws.path, {
      categoria: "execucoes",
      id: "exec-zumbi",
      descricao: "Ordem: teste",
      criadoPor: "executor-padrao",
      eventoInicial: { evento: "iniciado", resumo: "ordem: teste" },
      extras: {
        status: "executando",
        modelo: "opencode-go/glm-5.3-flash",
        ordem: "teste",
        pid: 999999999,
        fim: null,
        exit_code: null,
        duracao_ms: null,
        log: "logs/exec-zumbi.log",
      },
    });
    const scheduler = new Scheduler({ homeDir: home });
    const r = await scheduler.tick();
    expect(r.reconciliados).toContain("exec-zumbi");
    const meta = await lerMetaJson(ws.path, "exec-zumbi");
    expect(meta.extras.status).toBe("falhou");
    const journal = await lerJournal(ws.path, "exec-zumbi");
    expect(journal).toContain("morreu sem finalizar (reaper)");
  });
});

describe("Monitor — formatação de datas de execuções", () => {
  it("string ISO é usada direto (não divide por 1000)", () => {
    expect(formatarDataExecucao("2026-08-31T10:00:00.000Z")).toBe("08-31 10:00");
  });

  it("número epoch (s) e string numérica são interpretados como segundos", () => {
    const seg = Math.floor(Date.parse("2026-08-31T10:00:00.000Z") / 1000);
    expect(formatarDataExecucao(seg)).toBe("08-31 10:00");
    expect(formatarDataExecucao(String(seg))).toBe("08-31 10:00");
    expect(formatarDataExecucao(Date.parse("2026-08-31T10:00:00.000Z"))).toBe("08-31 10:00");
  });

  it("valor inválido volta como texto bruto; null/undefined → null", () => {
    expect(formatarDataExecucao("data-torta")).toBe("data-torta");
    expect(dataDeExecucao(null)).toBeNull();
    expect(dataDeExecucao(undefined)).toBeNull();
    expect(dataDeExecucao("")).toBeNull();
  });
});
