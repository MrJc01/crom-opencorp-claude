import { afterAll, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkNodeVersion,
  findSecretFiles,
  loadSettings,
  lookupExecutable,
  runDoctor,
  checkScheduler,
  checkHooks,
  checkApps,
  checkTeams,
  checkLedger,
  checkSecretario,
  schedulerPidfilePath,
  secretarioPidfilePath,
  hooksDir,
  appsDir,
  teamsDir,
} from "../src/core/contexts/platform/doctor.js";
import { mkdirSync } from "node:fs";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-doctor-"));
  raizes.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("checkNodeVersion", () => {
  it("passa para node >= 22", () => {
    expect(checkNodeVersion("v22.22.3").status).toBe("ok");
    expect(checkNodeVersion("v23.1.0").status).toBe("ok");
  });

  it("falha para node < 22", () => {
    expect(checkNodeVersion("v21.7.0").status).toBe("fail");
    expect(checkNodeVersion("v18.0.0").status).toBe("fail");
  });

  it("falha para versão ilegível", () => {
    expect(checkNodeVersion("banana").status).toBe("fail");
  });
});

describe("lookupExecutable (which sem spawn)", () => {
  it("encontra executável no PATH informado", async () => {
    const dir = await tmpDir();
    const exe = join(dir, "opencode");
    await writeFile(exe, "#!/bin/sh\n");
    await chmod(exe, 0o755);
    expect(lookupExecutable("opencode", dir)).toBe(exe);
  });

  it("ignora arquivo sem permissão de execução", async () => {
    const dir = await tmpDir();
    const exe = join(dir, "opencode");
    await writeFile(exe, "x");
    await chmod(exe, 0o644);
    expect(lookupExecutable("opencode", dir)).toBeNull();
  });

  it("ignora diretório com o mesmo nome", async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, "opencode"), { recursive: true });
    expect(lookupExecutable("opencode", dir)).toBeNull();
  });

  it("retorna null quando não existe em nenhum diretório", () => {
    expect(lookupExecutable("opencode", "/caminho/inexistente")).toBeNull();
  });
});

describe("loadSettings", () => {
  it("settings ausente → info com 'não encontrado'", async () => {
    const base = await tmpDir();
    const check = await loadSettings(join(base, ".opencorp", "settings.json"));
    expect(check.check.status).toBe("info");
    expect(check.check.detail).toContain("não encontrado");
    expect(check.settings).toBeUndefined();
  });

  it("settings válido → ok e dados aplicados com defaults", async () => {
    const base = await tmpDir();
    const caminho = join(base, "settings.json");
    await writeFile(caminho, JSON.stringify({ version: 1, budget: { daily_usd: 2.5 } }));
    const check = await loadSettings(caminho);
    expect(check.check.status).toBe("ok");
    expect(check.settings?.budget.daily_usd).toBe(2.5);
    expect(check.settings?.default_model).toBe("opencode/nemotron-3-ultra-free");
  });

  it("JSON quebrado → fail", async () => {
    const base = await tmpDir();
    const caminho = join(base, "settings.json");
    await writeFile(caminho, "{ não é json");
    const check = await loadSettings(caminho);
    expect(check.check.status).toBe("fail");
    expect(check.check.detail).toContain("JSON inválido");
  });

  it("valor inválido → fail apontando a chave", async () => {
    const base = await tmpDir();
    const caminho = join(base, "settings.json");
    await writeFile(caminho, JSON.stringify({ budget: { daily_usd: "cinco" } }));
    const check = await loadSettings(caminho);
    expect(check.check.status).toBe("fail");
    expect(check.check.detail).toContain("budget.daily_usd");
  });
});

describe("findSecretFiles", () => {
  it("encontra apenas arquivos secrets* (case-insensitive), pulando node_modules e .git", async () => {
    const root = await tmpDir();
    const wsA = join(root, "ws-a");
    await mkdir(join(wsA, "docs"), { recursive: true });
    await mkdir(join(root, "ws-b"), { recursive: true });
    await mkdir(join(root, "ws-c", "node_modules"), { recursive: true });
    await mkdir(join(root, "ws-c", ".git"), { recursive: true });
    await writeFile(join(wsA, "secrets.json"), "{}");
    await writeFile(join(wsA, "docs", "SECRETS.env"), "x");
    await writeFile(join(root, "ws-b", "notas.txt"), "x");
    await writeFile(join(root, "ws-c", "node_modules", "secrets.json"), "{}");
    await writeFile(join(root, "ws-c", ".git", "secrets.json"), "{}");
    const encontrados = await findSecretFiles([root]);
    const relativos = encontrados.map((p) => p.slice(root.length + 1));
    expect(relativos).toEqual(["ws-a/docs/SECRETS.env", "ws-a/secrets.json"]);
  });

  it("retorna [] para raiz inexistente", async () => {
    expect(await findSecretFiles(["/caminho/inexistente"])).toEqual([]);
  });
});

describe("runDoctor (integração, tudo injetado)", () => {
  it("ambiente saudável → exitCode 0, com alerta de segredos", async () => {
    const home = await tmpDir();
    const bin = await tmpDir();
    await writeFile(join(bin, "opencode"), "#!/bin/sh\n");
    await chmod(join(bin, "opencode"), 0o755);
    const settingsDir = join(home, ".opencorp");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(join(settingsDir, "settings.json"), JSON.stringify({ version: 1 }));
    const workspaces = join(home, "corps");
    await mkdir(join(workspaces, "corp-teste"), { recursive: true });
    await writeFile(join(workspaces, "corp-teste", "secrets.json"), "{}");

    const resultado = await runDoctor({
      nodeVersion: "v22.22.3",
      pathEnv: bin,
      homeDir: home,
      cwd: home,
      settingsPath: join(settingsDir, "settings.json"),
      workspaceRoots: [workspaces],
    });

    const porId = new Map(resultado.checks.map((c) => [c.id, c]));
    expect(porId.get("node")?.status).toBe("ok");
    expect(porId.get("motores")?.status).toBe("ok");
    expect(porId.get("settings")?.status).toBe("ok");
    expect(porId.get("escrita")?.status).toBe("ok");
    expect(porId.get("segredos")?.status).toBe("warn");
    expect(porId.get("segredos")?.items).toHaveLength(1);
    expect(resultado.ok).toBe(true);
    expect(resultado.exitCode).toBe(0);
  });

  it("motor configurado (padrão: opencode) ausente → exitCode 1", async () => {
    const home = await tmpDir();
    const resultado = await runDoctor({
      nodeVersion: "v22.0.0",
      pathEnv: "",
      homeDir: home,
      cwd: home,
      settingsPath: join(home, "inexistente.json"),
      workspaceRoots: [],
    });
    expect(resultado.checks.find((c) => c.id === "motores")?.status).toBe("fail");
    expect(resultado.ok).toBe(false);
    expect(resultado.exitCode).toBe(1);
  });

  it("motores configurados para Codex não exigem OpenCode", async () => {
    const home = await tmpDir();
    const bin = await tmpDir();
    await writeFile(join(bin, "codex"), "#!/bin/sh\n");
    await chmod(join(bin, "codex"), 0o755);
    const settingsDir = join(home, ".opencorp");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ default_conversation_engine: "codex", run_engine: { default: "codex" } }));
    const resultado = await runDoctor({ nodeVersion: "v22.0.0", pathEnv: bin, homeDir: home, cwd: home, settingsPath, workspaceRoots: [] });
    const motores = resultado.checks.find((c) => c.id === "motores");
    expect(motores?.status).toBe("ok");
    expect(motores?.items?.join("\n")).not.toContain("opencode");
  });

  it("settings inválido → exitCode 2", async () => {
    const home = await tmpDir();
    const settingsPath = join(home, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ budget: { daily_usd: "cinco" } }));
    const resultado = await runDoctor({
      nodeVersion: "v22.0.0",
      pathEnv: "",
      homeDir: home,
      cwd: home,
      settingsPath,
      workspaceRoots: [],
    });
    expect(resultado.checks.find((c) => c.id === "settings")?.status).toBe("fail");
    expect(resultado.exitCode).toBe(2);
  });

  it("node antigo → exitCode 1", async () => {
    const home = await tmpDir();
    const resultado = await runDoctor({
      nodeVersion: "v20.11.0",
      pathEnv: "",
      homeDir: home,
      cwd: home,
      settingsPath: join(home, "inexistente.json"),
      workspaceRoots: [],
    });
    expect(resultado.checks.find((c) => c.id === "node")?.status).toBe("fail");
    expect(resultado.exitCode).toBe(1);
  });

  const ehRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.skipIf(ehRoot)("sem permissão de escrita em ~/.opencorp → fail", async () => {
    const home = await tmpDir();
    const oc = join(home, ".opencorp");
    await mkdir(oc, { recursive: true });
    await chmod(oc, 0o555);
    const resultado = await runDoctor({
      nodeVersion: "v22.0.0",
      pathEnv: "",
      homeDir: home,
      cwd: home,
      settingsPath: join(home, "inexistente.json"),
      workspaceRoots: [],
    });
    const escrita = resultado.checks.find((c) => c.id === "escrita");
    expect(escrita?.status).toBe("fail");
    expect(escrita?.detail).toContain(join(home, ".opencorp"));
  });
});

describe("checkScheduler", () => {
  it("sem pidfile e sem scheduler.db → info (primeira execução)", async () => {
    const home = await tmpDir();
    const check = await checkScheduler(home);
    expect(check.status).toBe("info");
    expect(check.detail).toContain("scheduler não configurado");
  });

  it("pidfile órfão (PID inexistente) → warn sem jobs", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    const pidfile = schedulerPidfilePath(home);
    await writeFile(pidfile, JSON.stringify({ pid: 999_999, iniciado: new Date().toISOString() }));
    const check = await checkScheduler(home);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("pidfile órfão");
  });

  it("scheduler vivo (process.pid no pidfile) → ok com jobs=0", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    const pidfile = schedulerPidfilePath(home);
    await writeFile(pidfile, JSON.stringify({ pid: process.pid, iniciado: new Date().toISOString() }));
    const check = await checkScheduler(home, { pidVivo: () => true });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain(`pid ${process.pid}`);
    expect(check.detail).toContain("vivo");
  });

  it("scheduler morto com jobs ativos em scheduler.db → warn (aviso principal)", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    const pidfile = schedulerPidfilePath(home);
    await writeFile(pidfile, JSON.stringify({ pid: 999_999, iniciado: new Date().toISOString() }));
    // cria scheduler.db com 1 job ativo para simular resíduo de migração
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(join(home, ".opencorp", "scheduler.db"));
    db.exec("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, ativo INTEGER); INSERT INTO jobs (id, ativo) VALUES ('j1', 1);");
    db.close();
    const check = await checkScheduler(home);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("scheduler morto");
    expect(check.detail).toContain("1 job");
  });
});

describe("checkHooks", () => {
  it("diretório ausente → info", async () => {
    const ws = await tmpDir();
    const check = await checkHooks(ws);
    expect(check.status).toBe("info");
    expect(check.detail).toContain("não existe");
  });

  it("hook com JSON inválido → warn listando o nome", async () => {
    const ws = await tmpDir();
    const dir = hooksDir(ws);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, "hook-abc.json"), "{ não é json");
    const check = await checkHooks(ws);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("JSON inválido");
    expect(check.items).toBeDefined();
    expect(check.items?.[0]).toContain("hook-abc.json");
  });

  it("hook válido → ok", async () => {
    const ws = await tmpDir();
    const dir = hooksDir(ws);
    mkdirSync(dir, { recursive: true });
    await writeFile(
      join(dir, "hook-ok.json"),
      JSON.stringify({
        id: "hook-ok",
        nome: "ok",
        token: "x",
        metodos: ["POST"],
        respond: "imediato",
        dedup_seg: 60,
        ativo: true,
        alvo: { tipo: "task_create", titulo: "t" },
        workspace: "w",
        criado_em: new Date().toISOString(),
      }),
    );
    const check = await checkHooks(ws);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("1 hook");
  });
});

describe("checkApps", () => {
  it("app com spec inválida → warn", async () => {
    const ws = await tmpDir();
    const dir = appsDir(ws);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, "app-bad.json"), JSON.stringify({ id: "App_Bad", titulo: "x", paginas: [] }));
    const check = await checkApps(ws);
    expect(check.status).toBe("warn");
    expect(check.items?.[0]).toContain("app-bad.json");
  });

  it("app válido → ok", async () => {
    const ws = await tmpDir();
    const dir = appsDir(ws);
    mkdirSync(dir, { recursive: true });
    const spec = {
      id: "painel-ok",
      titulo: "Painel OK",
      paginas: [{ titulo: "Página", widgets: [] }],
    };
    await writeFile(join(dir, "painel-ok.json"), JSON.stringify(spec));
    const check = await checkApps(ws);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("1 app");
  });
});

describe("checkTeams", () => {
  it("team pipeline sem passos → warn", async () => {
    const ws = await tmpDir();
    const dir = teamsDir(ws);
    mkdirSync(dir, { recursive: true });
    await writeFile(
      join(dir, "team-bad.json"),
      JSON.stringify({
        id: "team-bad",
        titulo: "Bad",
        padrao: "pipeline",
        criado_em: new Date().toISOString(),
      }),
    );
    const check = await checkTeams(ws);
    expect(check.status).toBe("warn");
    expect(check.items?.[0]).toContain("team-bad.json");
  });

  it("team pipeline válido → ok", async () => {
    const ws = await tmpDir();
    const dir = teamsDir(ws);
    mkdirSync(dir, { recursive: true });
    await writeFile(
      join(dir, "team-ok.json"),
      JSON.stringify({
        id: "team-ok",
        titulo: "OK",
        padrao: "pipeline",
        passos: [{ agente: "executor-padrao", ordem: "faça" }],
        criado_em: new Date().toISOString(),
      }),
    );
    const check = await checkTeams(ws);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("1 team");
  });
});

describe("checkSecretario", () => {
  it("sem pidfile → ok (parado)", async () => {
    const home = await tmpDir();
    const check = await checkSecretario(home);
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("secretário parado");
  });

  it("com pidfile (PID vivo) e fetch mock ok → ok", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    await writeFile(
      secretarioPidfilePath(home),
      JSON.stringify({ pid: process.pid, porta: 12345, iniciado_em: new Date().toISOString() }),
    );
    const fetchMock = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const check = await checkSecretario(home, { pidVivo: () => true, fetch: fetchMock });
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("/health");
  });

  it("pidfile órfão (PID morto) → warn", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    await writeFile(
      secretarioPidfilePath(home),
      JSON.stringify({ pid: 999_999, porta: 12345, iniciado_em: new Date().toISOString() }),
    );
    const check = await checkSecretario(home, { pidVivo: () => false });
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("órfão");
  });
});

describe("runDoctor — checks novos integrados", () => {
  it("inclui scheduler, secretário, hooks, apps, teams; pidfile órfão do scheduler → warn", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    await writeFile(
      schedulerPidfilePath(home),
      JSON.stringify({ pid: 999_999, iniciado: new Date().toISOString() }),
    );
    const resultado = await runDoctor({
      nodeVersion: "v22.0.0",
      pathEnv: "",
      homeDir: home,
      cwd: home,
      settingsPath: join(home, "inexistente.json"),
      workspaceRoots: [],
      pidVivo: () => false,
    });
    const porId = new Map(resultado.checks.map((c) => [c.id, c]));
    expect(porId.get("scheduler")?.status).toBe("warn");
    expect(porId.get("secretario")?.status).toBe("ok"); // sem pidfile
    expect(porId.get("hooks")?.status).toBe("info"); // sem workspace
    expect(porId.get("apps")?.status).toBe("info");
    expect(porId.get("teams")?.status).toBe("info");
  });

  it("com workspacePath, hook inválido → warn", async () => {
    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp"), { recursive: true });
    const wsPath = await tmpDir();
    const dir = hooksDir(wsPath);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, "hook-x.json"), "{ inválido");
    const resultado = await runDoctor({
      nodeVersion: "v22.0.0",
      pathEnv: "",
      homeDir: home,
      cwd: home,
      settingsPath: join(home, "inexistente.json"),
      workspaceRoots: [],
      workspacePath: wsPath,
    });
    const hooks = resultado.checks.find((c) => c.id === "hooks");
    expect(hooks?.status).toBe("warn");
    expect(hooks?.items?.[0]).toContain("hook-x.json");
  });
});

describe("checkLedger (PLANO-UNIFICACAO)", () => {
  it("corp.db inexistente → info", async () => {
    const ws = await tmpDir();
    const check = await checkLedger(ws);
    expect(check.status).toBe("info");
  });

  it("ledger vazio → ok; execução órfã >24h → warn com item; execução recente executando → ok", async () => {
    const { CorpDb } = await import("../src/core/contexts/storage/corp-db.js");
    const ws = await tmpDir();
    mkdirSync(join(ws, ".opencorp"), { recursive: true });
    const db = new CorpDb(join(ws, ".opencorp", "corp.db"));

    // ledger vazio
    const vazio = await checkLedger(ws);
    expect(vazio.status).toBe("ok");

    const ontem = new Date(Date.now() - 30 * 3600_000).toISOString();
    const agora = new Date().toISOString();
    db.upsertExecucao({
      id: "exec-orfa", agente: "a", modelo: "m", gatilho_tipo: "cron", gatilho_origem: "sch-x",
      status: "executando", inicio: ontem, fim: null, duracao_ms: null, custo_usd: null, exit_code: null,
    });
    db.upsertExecucao({
      id: "exec-viva", agente: "b", modelo: "m", gatilho_tipo: "mencao", gatilho_origem: "tsk_1/x",
      status: "executando", inicio: agora, fim: null, duracao_ms: null, custo_usd: null, exit_code: null,
    });
    db.upsertExecucao({
      id: "exec-ok", agente: "c", modelo: "m", gatilho_tipo: "manual", gatilho_origem: "",
      status: "concluido", inicio: agora, fim: agora, duracao_ms: 10, custo_usd: 0, exit_code: 0,
    });

    const check = await checkLedger(ws);
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("1 execução(ões) presas");
    expect(check.items?.[0]).toContain("exec-orfa");
    db.fechar();
  });
});

describe("checkFlows + checkFlowsAgendados (integridade agenda↔fluxo)", () => {
  it("checkFlows: sem dir → info; flow válido → ok; inválido → fail", async () => {
    const { checkFlows } = await import("../src/core/contexts/platform/doctor.js");
    const { FlowStore } = await import("../src/core/contexts/orchestration/flow-store.js");
    const vazio = await tmpDir();
    expect((await checkFlows(vazio)).status).toBe("info");

    const ws = await tmpDir();
    const flows = new FlowStore();
    await flows.salvar(ws, {
      id: "ok-flow",
      nome: "OK",
      nos: [{ id: "gatilho", tipo: "manual", config: {} }],
      arestas: [],
    } as any);
    expect((await checkFlows(ws)).status).toBe("ok");

    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync(join(ws, ".opencorp", "flows"), { recursive: true });
    writeFileSync(join(ws, ".opencorp", "flows", "ruim.json"), '{"id":"RUIM","nos":[]}');
    const ruim = await checkFlows(ws);
    expect(ruim.status).toBe("fail");
    expect(ruim.items?.join(" ")).toContain("ruim.json");
  });

  it("checkFlowsAgendados: job para flow fantasma → fail; destino existe → ok", async () => {
    const { checkFlowsAgendados } = await import("../src/core/contexts/platform/doctor.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const Database = (await import("better-sqlite3")).default;
    const { FlowStore } = await import("../src/core/contexts/orchestration/flow-store.js");

    const home = await tmpDir();
    mkdirSync(join(home, ".opencorp", "workspaces", "ws1", ".opencorp", "flows"), { recursive: true });
    const db = new Database(join(home, ".opencorp", "scheduler.db"));
    db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, nome TEXT, agenda_tipo TEXT, agenda_valor TEXT, args TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '', ativo INTEGER NOT NULL DEFAULT 1, graca_min INTEGER NOT NULL DEFAULT 5, ultima_exec TEXT, proxima_exec TEXT, criado_em TEXT NOT NULL DEFAULT '')");
    const ins = db.prepare("INSERT INTO jobs (id, nome, agenda_tipo, agenda_valor, args, workspace) VALUES (?,?,?,?,?,?)");
    ins.run("sch-fantasma", "Fantasma", "cron", "0 9 * * *", JSON.stringify(["flow", "run", "nao-existe", "--workspace", "ws1"]), "ws1");
    ins.run("sch-agent", "Agente", "cron", "0 9 * * *", JSON.stringify(["agent", "run", "a", "oi"]), "ws1");
    const antes = await checkFlowsAgendados(home);
    expect(antes.status).toBe("fail");
    expect(antes.items?.join(" ")).toContain("sch-fantasma");

    await new FlowStore().salvar(join(home, ".opencorp", "workspaces", "ws1"), {
      id: "nao-existe",
      nome: "Agora existe",
      nos: [{ id: "gatilho", tipo: "manual", config: {} }],
      arestas: [],
    } as any);
    const depois = await checkFlowsAgendados(home);
    expect(depois.status).toBe("ok");
    db.close();
  });
});
