/**
 * Cancelar uma execução de fluxo nunca pode sinalizar o próprio OpenCorp.
 * Fluxos rodam no processo do servidor e registram `pid: process.pid`; antes,
 * POST /execucoes/:id/cancelar mandava SIGTERM para esse pid e derrubava o servidor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pidSinalizavel, SessionManager } from "../src/core/contexts/execution/session-manager.js";
import { RegistryStore } from "../src/core/contexts/storage/registry-store.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

describe("cancelamento seguro de execuções", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-cancel-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  it("pidSinalizavel recusa o próprio processo, o pai e pids inválidos", () => {
    expect(pidSinalizavel(process.pid)).toBe(false);
    expect(pidSinalizavel(process.ppid)).toBe(false);
    expect(pidSinalizavel(1)).toBe(false);
    expect(pidSinalizavel(0)).toBe(false);
    expect(pidSinalizavel(null)).toBe(false);
    expect(pidSinalizavel("123")).toBe(false);
    expect(pidSinalizavel(987654)).toBe(true);
  });

  it("cancelar execução de fluxo (pid = OpenCorp) marca cancelado sem enviar sinal", async () => {
    const ws = await new WorkspaceManager({ homeDir: home, cwd: home }).criar("ws-cancel");
    await new RegistryStore().criar(ws.path, {
      categoria: "execucoes",
      id: "exec-flow-1",
      descricao: "flow em andamento",
      criadoPor: "flow:teste",
      tipo: "flow",
      extras: { status: "executando", tipo: "flow", pid: process.pid },
    } as any);
    const kill = vi.spyOn(process, "kill");

    const matou = await new SessionManager({ homeDir: home, cwd: ws.path }).cancelar(ws.path, "exec-flow-1");

    expect(matou).toBe(false);
    expect(kill.mock.calls.filter(([pid, sinal]) => pid === process.pid && sinal !== 0)).toEqual([]);
    const meta = await new RegistryStore().lerMeta(ws.path, "execucoes", "exec-flow-1");
    expect((meta.extras as any).status).toBe("cancelado");
  });
});
