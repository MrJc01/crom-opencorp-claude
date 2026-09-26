/**
 * POST /api/motores/:id/desconectar — nenhum motor padrão é escolhido
 * implicitamente (D1; pendência P-03).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server/index.js";

describe("desconectar motor", () => {
  let home: string;
  let server: ReturnType<typeof createApiServer>["server"];
  let port: number;
  const token = "desc-token";
  const settingsFile = () => join(home, ".opencorp", "settings.json");

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-desc-"));
    await mkdir(join(home, ".opencorp"), { recursive: true });
    server = createApiServer({ homeDir: home, porta: 0, token }).server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }));
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await writeFile(settingsFile(), JSON.stringify({ run_engine: { default: "codex" } }));
  });

  const desconectar = (motor: string, body: unknown = {}) =>
    fetch(`http://127.0.0.1:${port}/api/motores/${motor}/desconectar`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: (await r.json()) as any }));
  const padrao = async () => JSON.parse(await readFile(settingsFile(), "utf8")).run_engine?.default;

  it("motor padrão sem novoPadrao → 409 com candidatos, sem alterar nada", async () => {
    const r = await desconectar("codex");
    expect(r.status).toBe(409);
    expect(r.json.requerNovoPadrao).toBe(true);
    expect(r.json.candidatos).not.toContain("codex");
    expect(await padrao()).toBe("codex");
  });

  it("novoPadrao explícito vira o padrão (sem cair em opencode)", async () => {
    const r = await desconectar("codex", { novoPadrao: "claude" });
    expect(r.status).toBe(200);
    expect(r.json.runner.engine).toBe("claude-code");
    expect(await padrao()).toBe("claude-code");
  });

  it("novoPadrao inválido ou igual ao desconectado → 409", async () => {
    expect((await desconectar("codex", { novoPadrao: "codex" })).status).toBe(409);
    expect((await desconectar("codex", { novoPadrao: "inexistente" })).status).toBe(409);
    expect(await padrao()).toBe("codex");
  });

  it("motor que não é o padrão desconecta sem mexer no padrão", async () => {
    const r = await desconectar("copilot");
    expect(r.status).toBe(200);
    expect(r.json.runner.engine).toBe("codex");
    expect(await padrao()).toBe("codex");
  });
});
