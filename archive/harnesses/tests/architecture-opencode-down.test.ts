/**
 * Teste arquitetural definitivo (Etapa 15):
 *
 * > Com OpenCode indisponível, somente execuções configuradas para OpenCode
 * > devem falhar. O OpenCorp, scheduler, fluxos e Secretário usando outro
 * > runtime compatível devem continuar funcionando.
 *
 * O PATH do processo passa a conter só um `claude` falso — nenhum `opencode`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server/index.js";
import { CodexAdapter, ConversationRuntimeResolver, EngineRegistry, resolveEngineBinary } from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";
import { SessionManager } from "../src/core/contexts/execution/session-manager.js";
import { createFakeCodex } from "./fixtures/fake-codex-app-server.js";

describe("ETAPA 15 — teste arquitetural definitivo: OpenCode indisponível", () => {
  let home: string;
  let binDir: string;
  let pathOriginal: string | undefined;
  let server: ReturnType<typeof createApiServer>["server"];
  let port: number;
  let registry: ProcessRegistry;
  let wsCodex: { id: string; path: string };
  let wsOpencode: { id: string; path: string };
  const token = "arq-token";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-arq-"));
    binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "claude"), '#!/bin/sh\necho "claude 9.9.9-test"\necho "tarefa concluída pelo claude-code"\n');
    await chmod(join(binDir, "claude"), 0o755);
    pathOriginal = process.env.PATH;
    process.env.PATH = [binDir, "/usr/bin", "/bin"].join(":");

    const manager = new WorkspaceManager({ homeDir: home, cwd: home });
    const a = await manager.criar("ws-codex");
    const b = await manager.criar("ws-opencode");
    wsCodex = { id: a.id, path: a.path };
    wsOpencode = { id: b.id, path: b.path };
    const cfg = (engine: string) => JSON.stringify({ conversationEngineOverride: engine, execution_driver: "host" });
    await writeFile(join(wsCodex.path, ".opencorp", "config.json"), cfg("codex"));
    await writeFile(join(wsOpencode.path, ".opencorp", "config.json"), cfg("opencode"));
    await writeFile(join(home, ".opencorp", "settings.json"), JSON.stringify({ execution_driver: "host" }));
    await writeFile(join(home, ".opencorp", "config.json"), JSON.stringify({ execution_driver: "host" }));

    const dead = new Set<number>();
    registry = new ProcessRegistry({ idleTimeoutMs: 60_000, killer: (pid) => { dead.add(pid); }, isPidRunning: (pid) => !dead.has(pid) });
    const fakeCodex = createFakeCodex();
    const engines = new EngineRegistry();
    engines.registerAdapter(new CodexAdapter({
      homeDir: home,
      processRegistry: registry,
      appServerLauncher: fakeCodex.appServerLauncher,
      installStatusProbe: async () => ({ installed: true, isManaged: false, path: "/fake/codex", version: "codex-cli test" }),
      authStatusProbe: async () => ({ authenticated: true, method: "test" }),
    }));
    const app = createApiServer({ homeDir: home, porta: 0, token, conversationRuntimeResolver: new ConversationRuntimeResolver({ homeDir: home, registry: engines }) });
    server = app.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; resolve(); }));
  });

  afterAll(async () => {
    process.env.PATH = pathOriginal;
    await new Promise((r) => server.close(r));
    await registry.shutdownAll();
    await rm(home, { recursive: true, force: true });
  });

  const api = (path: string, body?: unknown) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, json: (await r.json().catch(() => null)) as any }));

  it("pré-condição: o OpenCode não está disponível", async () => {
    const r = await resolveEngineBinary("opencode", { homeDir: home });
    expect(r.installed).toBe(false);
  });

  it("Secretário com Codex continua funcionando", async () => {
    const r = await api(`/secretario/conversa?workspace=${wsCodex.id}`, { mensagem: "status do dia" });
    expect(r.status).toBe(200);
    expect(r.json.resposta).toContain("Olá, resposta para:");
  });

  it("Secretário configurado para OpenCode falha explicitamente, sem cair em outro motor", async () => {
    const status = await api(`/secretario/status?workspace=${wsOpencode.id}`);
    expect(status.json.motor.engineId).toBe("opencode");
    expect(status.json.motor.preflight.ok).toBe(false);
    const conversa = await api(`/secretario/conversa?workspace=${wsOpencode.id}`, { mensagem: "oi" });
    expect(conversa.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(conversa.json)).not.toContain("Olá, resposta para:");
  });

  it("job one-shot de outro motor (Claude Code) roda sem iniciar servidor residente", async () => {
    const sessoes = new SessionManager({ homeDir: home, cwd: wsCodex.path });
    const r = await sessoes.rodar({ agente: "executor-padrao", ordem: "resuma", engine: "claude-code", model: "claude-code/sonnet", workspaceDir: wsCodex.path, workspaceId: wsCodex.id });
    expect(r.status).toBe("concluido");
    expect(r.captura).toContain("tarefa concluída pelo claude-code");
    expect(registry.list().filter((p) => p.key.engineId === "opencode")).toEqual([]);
  });

  it("job configurado para OpenCode falha no preflight, sem instalar nada", async () => {
    const sessoes = new SessionManager({ homeDir: home, cwd: wsOpencode.path });
    await expect(
      sessoes.rodar({ agente: "executor-padrao", ordem: "resuma", engine: "opencode", workspaceDir: wsOpencode.path, workspaceId: wsOpencode.id })
    ).rejects.toThrow(/não encontrado no preflight/);
    const managed = await resolveEngineBinary("opencode", { homeDir: home });
    expect(managed.installed).toBe(false);
  });
});
