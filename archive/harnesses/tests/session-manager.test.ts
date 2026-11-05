import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { SessionError } from "../src/core/shared/errors.js";
import { SessionManager } from "../src/core/contexts/execution/session-manager.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

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

function fakeChild(opts: { out?: string[]; err?: string[]; exitCode?: number; pid?: number }) {
  const base = Promise.resolve({
    exitCode: opts.exitCode ?? 0,
    killed: false,
    stdout: undefined,
    stderr: undefined,
  }) as Promise<{ exitCode: number; killed: boolean }> & {
    stdout: Readable;
    stderr: Readable;
    pid?: number;
    killed: boolean;
  };
  const child = base as typeof base & { pid?: number };
  child.stdout = Readable.from(opts.out ?? []);
  child.stderr = Readable.from(opts.err ?? []);
  child.pid = opts.pid ?? 424242;
  child.killed = false;
  return child;
}

async function ambiente() {
  const home = await mkdtemp(join(tmpdir(), "opencorp-sess-"));
  raizes.push(home);
  const manager = new WorkspaceManager({ homeDir: home, cwd: home });
  const ws = await manager.criar("corp-sess");
  const sessoes = new SessionManager({ homeDir: home, cwd: home });
  return { home, ws, sessoes };
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

beforeEach(() => {
  execaMock.mockClear();
});

describe("SessionManager.rodar (execa mockado — nunca roda opencode real)", () => {
  it("spawn com args corretos, stream para log e registro completo", async () => {
    const { ws, sessoes } = await ambiente();
    execaMock.mockImplementation(() =>
      fakeChild({ out: ["trabalho feito\n"], err: ["aviso: nada\n"] }),
    );
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "crie o probe.txt" });
    expect(execaMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execaMock.mock.calls[0]!;
    expect(cmd).toMatch(/(?:^|\/)opencode$/);
    expect(args).toContain("--auto");
    expect(args).toContain("--agent");
    expect(args[args.indexOf("--agent") + 1]).toBe("executor-padrao");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opencode-go/glm-5.3-flash");
    expect(args).toContain("--dir");
    expect(args[args.indexOf("--dir") + 1]).toBe(ws.path);
    expect(args[args.length - 1]).toBe("crie o probe.txt");
    expect((opts as { cwd: string }).cwd).toBe(ws.path);
    expect(r.status).toBe("concluido");
    expect(r.exit_code).toBe(0);
    expect(r.duracao_ms).toBeGreaterThanOrEqual(0);
    const logPath = join(ws.path, r.log);
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("trabalho feito");
    expect(log).toContain("aviso: nada");
    expect(log).toContain("# agente: executor-padrao");

    const registros = await sessoes.listarExecucoes(ws.path);
    expect(registros).toHaveLength(1);
    expect(registros[0]).toMatchObject({ agente: "executor-padrao", status: "concluido", exit_code: 0 });

    const meta = JSON.parse(
      readFileSync(join(ws.path, ".opencorp", "registries", "execucoes", r.id, "meta.json"), "utf8"),
    );
    expect(meta.categoria).toBe("execucoes");
    expect(meta.criado_por).toBe("executor-padrao");
    expect(meta.extras.status).toBe("concluido");
    const journal = readFileSync(
      join(ws.path, ".opencorp", "registries", "execucoes", r.id, "journal.jsonl"),
      "utf8",
    );
    const eventos = journal.trim().split("\n").map((l) => JSON.parse(l));
    expect(eventos.map((e) => e.evento)).toEqual(["iniciado", "finalizado"]);
    expect(eventos[1].status).toBe("concluido");

    const transcript = readFileSync(
      join(ws.path, ".opencorp", "registries", "chats", r.id, "conteudo.md"),
      "utf8",
    );
    expect(transcript).toContain("trabalho feito");
    const chatsMeta = JSON.parse(
      readFileSync(join(ws.path, ".opencorp", "registries", "chats", r.id, "meta.json"), "utf8"),
    );
    expect(chatsMeta.categoria).toBe("chats");
    expect(chatsMeta.criado_por).toBe("executor-padrao");
  });

  it("--model sobrepõe o modelo do agente; --session e --title são repassados", async () => {
    const { sessoes } = await ambiente();
    execaMock.mockImplementation(() => fakeChild({ out: [] }));
    await sessoes.rodar({
      agente: "executor-padrao",
      ordem: "ordem qualquer",
      model: "opencode/hy3-free",
      session: "sess-abc",
      title: "título da sessão",
    });
    const [, args] = execaMock.mock.calls[0]!;
    // Prefixo opencode/ força o motor opencode e é preservado integralmente no --model.
    expect(args[0]).toBe("run");
    expect(args).toContain("opencode/hy3-free");
    expect(args).toContain("--session");
    expect(args[args.indexOf("--session") + 1]).toBe("sess-abc");
    expect(args).toContain("--title");
    expect(args[args.indexOf("--title") + 1]).toBe("título da sessão");
  });

  it("--file lê a ordem do arquivo", async () => {
    const { home, sessoes } = await ambiente();
    const arquivo = join(home, "ordem.txt");
    await writeFile(arquivo, "ordem vinda do arquivo\n", "utf8");
    execaMock.mockImplementation(() => fakeChild({ out: [] }));
    await sessoes.rodar({ agente: "executor-padrao", file: arquivo });
    const [, args] = execaMock.mock.calls[0]!;
    expect(args[args.length - 1]).toBe("ordem vinda do arquivo");
  });

  it("exit não-zero → status falhou e exit code propagado", async () => {
    const { ws, sessoes } = await ambiente();
    execaMock.mockImplementation(() => fakeChild({ out: ["boom\n"], exitCode: 3 }));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "algo" });
    expect(r.status).toBe("falhou");
    expect(r.exit_code).toBe(3);
    const registros = await sessoes.listarExecucoes(ws.path);
    expect(registros[0].status).toBe("falhou");
  });

  it("falha de spawn (opencode ausente) vira SessionError amigável com registro de falha", async () => {
    const { ws, sessoes } = await ambiente();
    execaMock.mockImplementation(() => {
      throw new Error("spawn opencode ENOENT");
    });
    const err = await sessoes.rodar({ agente: "executor-padrao", ordem: "algo" }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect(err.message).toContain("opencode");
    expect(err.message).toContain("doctor");
    const registros = await sessoes.listarExecucoes(ws.path);
    expect(registros).toHaveLength(1);
    expect(registros[0].status).toBe("falhou");
  });

  it("ordem vazia falha antes do spawn", async () => {
    const { sessoes } = await ambiente();
    const err = await sessoes.rodar({ agente: "executor-padrao", ordem: "  " }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect(err.message).toContain("ordem vazia");
    expect(execaMock).not.toHaveBeenCalled();
  });

  it("agente inexistente falha com AgentError", async () => {
    const { sessoes } = await ambiente();
    const err = await sessoes.rodar({ agente: "fantasma", ordem: "x" }).catch((e) => e);
    expect(err.message).toContain("não encontrado");
    expect(execaMock).not.toHaveBeenCalled();
  });
});

describe("SessionManager.matar / logDe", () => {
  it("matar sessão inexistente / não-executando / pid morto falha com SessionError", async () => {
    const { ws, sessoes } = await ambiente();
    const err1 = await sessoes.matar(ws.path, "exec-nao-existe").catch((e) => e);
    expect(err1).toBeInstanceOf(SessionError);
    execaMock.mockImplementation(() => fakeChild({ out: [] }));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "algo" });
    const err2 = await sessoes.matar(ws.path, r.id).catch((e) => e);
    expect(err2.message).toContain("não está em execução");
    const { writeFileAtomic } = await import("../src/utils/fs-safe.js");
    const metaPath = join(ws.path, ".opencorp", "registries", "execucoes", r.id, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.extras.status = "executando";
    meta.extras.pid = 999999999;
    await writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
    const err3 = await sessoes.matar(ws.path, r.id).catch((e) => e);
    expect(err3.message).toContain("não está mais vivo");
  });

  it("logDe lê a captura gravada; caminhoLog falha para sessão sem log", async () => {
    const { ws, sessoes } = await ambiente();
    execaMock.mockImplementation(() => fakeChild({ out: ["conteúdo do log\n"] }));
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "algo" });
    expect(await sessoes.logDe(ws.path, r.id)).toContain("conteúdo do log");
    const err = await sessoes.logDe(ws.path, "exec-fantasma").catch((e) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect(err.message).toContain("log não encontrado");
  });
});
