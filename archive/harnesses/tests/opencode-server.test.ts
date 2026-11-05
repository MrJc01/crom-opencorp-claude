import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpencodeServerManager, SecretarioError } from "../src/core/contexts/execution/opencode-server.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-opencode-server-"));
  raizes.push(dir);
  return dir;
}

describe("OpencodeServerManager", () => {
  let home: string;
  let manager: OpencodeServerManager;
  let resultado: { pid: number; porta: number };

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await chmod(join(__dirname, "fixtures", "fake-opencode.mjs"), 0o755);
  });

  afterAll(async () => {
    await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
  });

  beforeEach(async () => {
    // Limpar opencode.json se existir
    const configPath = join(home, "opencode.json");
    await unlink(configPath).catch(() => {});
    manager = new OpencodeServerManager({ homeDir: home, binario: join(__dirname, "fixtures", "fake-opencode.mjs") });
  });

  it("status() retorna rodando=false quando não há pidfile", async () => {
    const status = await manager.status();
    expect(status.rodando).toBe(false);
    expect(status.pid).toBeNull();
    expect(status.porta).toBeNull();
  });

  it("configurado() retorna false sem opencode.json", async () => {
    const configurado = await manager.configurado();
    expect(configurado).toBe(false);
  });

  it("iniciar() com binário fake grava pidfile e descobre porta", async () => {
    resultado = await manager.iniciar();
    expect(resultado.pid).toBeGreaterThan(0);
    expect(resultado.porta).toBeGreaterThan(0);

    const pidfilePath = join(home, ".opencorp", "opencode-server.json");
    const pidfile = JSON.parse(await readFile(pidfilePath, "utf8"));
    expect(pidfile.pid).toBe(resultado.pid);
    expect(pidfile.porta).toBe(resultado.porta);
    expect(pidfile.iniciado_em).toBeDefined();
  });

  it("status() retorna rodando=true após iniciar", async () => {
    const status = await manager.status();
    expect(status.rodando).toBe(true);
    expect(status.pid).toBe(resultado.pid);
    expect(status.porta).toBe(resultado.porta);
  });

  it("iniciar() é idempotente - retorna mesmo pid/porta se já rodando", async () => {
    const resultado2 = await manager.iniciar();
    expect(resultado2.pid).toBe(resultado.pid);
    expect(resultado2.porta).toBe(resultado.porta);
  });

  it("parar() remove pidfile e processo morre", async () => {
    await manager.parar();

    const status = await manager.status();
    expect(status.rodando).toBe(false);

    const pidfilePath = join(home, ".opencorp", "opencode-server.json");
    const exists = await stat(pidfilePath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("configurado() retorna true após criar opencode.json", async () => {
    await writeFile(join(home, "opencode.json"), "{}");
    const configurado = await manager.configurado();
    expect(configurado).toBe(true);
  });
});