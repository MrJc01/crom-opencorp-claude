import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TSX = resolve("node_modules/.bin/tsx");
const FIXTURE = resolve("tests/fixtures/watchdog-travado.ts");
const homes: string[] = [];

afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function rodar(args: string[], env: Record<string, string> = {}, ate?: (proc: ReturnType<typeof spawn>, out: () => string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), "oc-wd-"));
  homes.push(home);
  const proc = spawn(TSX, [FIXTURE, home, ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => (out += d));
  proc.stderr.on("data", (d) => (out += d));
  const saida = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((ok) => proc.on("exit", (code, signal) => ok({ code, signal })));
  return { home, proc, saida, out: () => out, ate };
}

function diagnosticos(home: string): string[] {
  const dir = join(home, ".opencorp", "logs");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("watchdog-")) : [];
}

describe("watchdog do event loop", () => {
  it("event loop travado: grava diagnóstico com pilha e encerra com código ≠ 0", async () => {
    const r = rodar(["travar", "2000"], { OPENCORP_WATCHDOG_MS: "2000" });
    const { code, signal } = await r.saida;
    expect(code !== 0 || signal !== null).toBe(true);
    const arquivos = diagnosticos(r.home);
    expect(arquivos.length, r.out()).toBe(1);
    const diag = JSON.parse(readFileSync(join(r.home, ".opencorp", "logs", arquivos[0]!), "utf8"));
    expect(diag.motivo).toContain("event loop sem batimento");
    expect(diag.semBatimentoMs).toBeGreaterThanOrEqual(2000);
    expect(Array.isArray(diag.pilhaThreadPrincipal), JSON.stringify(diag)).toBe(true);
    expect(diag.pilhaThreadPrincipal.join("\n")).toContain("processTimers");
    expect(diag.memoria.rssMB).toBeGreaterThan(0);
    expect(r.out()).toContain("[watchdog]");
  }, 30_000);

  it("pausa curta abaixo do limite não mata o processo", async () => {
    const r = rodar(["pausa", "4000"]);
    const { code } = await r.saida;
    expect(code, r.out()).toBe(0);
    expect(diagnosticos(r.home)).toEqual([]);
  }, 30_000);

  it("OPENCORP_WATCHDOG=0 desliga", async () => {
    const r = rodar(["travar", "2000"], { OPENCORP_WATCHDOG: "0" });
    const { code } = await r.saida;
    expect(code).toBe(0);
    expect(r.out()).toContain("desligado");
  }, 30_000);

  it("servidor ocioso e atendendo requisições normalmente não é morto", async () => {
    const r = rodar(["servidor", "2000"], { OPENCORP_WATCHDOG_MS: "2000" });
    const porta = await new Promise<number>((ok, falha) => {
      const t = setInterval(() => {
        const m = /porta:(\d+)/.exec(r.out());
        if (m) { clearInterval(t); ok(Number(m[1])); }
      }, 100);
      setTimeout(() => { clearInterval(t); falha(new Error(`servidor não subiu: ${r.out()}`)); }, 15_000);
    });
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`http://127.0.0.1:${porta}/health`);
      expect(res.status).toBe(200);
      await new Promise((ok) => setTimeout(ok, 700));
    }
    expect(r.proc.exitCode).toBeNull();
    expect(diagnosticos(r.home)).toEqual([]);
    r.proc.kill("SIGTERM");
    await r.saida;
  }, 40_000);
});
