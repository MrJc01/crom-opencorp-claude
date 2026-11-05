import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FlowStore } from "../src/core/contexts/orchestration/flow-store.js";
import { RegistryStore } from "../src/core/contexts/storage/registry-store.js";

describe("flow: falha de etapa não deixa a hora sem publicar", () => {
  let wsDir: string;
  let homeDir: string;
  let store: FlowStore;

  const script = (id: string, config: Record<string, unknown>) => ({ id, tipo: "script", config });
  const execucaoFalha = async (fn: () => Promise<unknown>): Promise<string> => {
    const erro = await fn().then(() => null, (e: Error) => e);
    expect(erro).not.toBeNull();
    return /exec ([^)]+)\)/.exec(erro!.message)![1]!;
  };

  beforeEach(() => {
    wsDir = mkdtempSync(join(tmpdir(), "opencorp-aofalhar-ws-"));
    homeDir = mkdtempSync(join(tmpdir(), "opencorp-aofalhar-home-"));
    store = new FlowStore({ homeDir });
  });

  afterEach(() => {
    rmSync(wsDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("roda ao_falhar, guarda a saída e o motivo, e o flow continua falhou", async () => {
    await store.salvar(wsDir, {
      id: "f", nome: "f", ativo: true,
      nos: [{ id: "ini", tipo: "manual", config: {} }, script("quebra", { comando: "echo erro-real >&2; exit 3" })],
      arestas: [{ de: "ini", para: "quebra" }],
      ao_falhar: { comando: "echo publicou > publicado.txt; echo feito" },
    } as never);
    const execId = await execucaoFalha(() => store.executar(wsDir, "f"));
    expect(readFileSync(join(wsDir, "publicado.txt"), "utf8").trim()).toBe("publicou");
    const extras = (await new RegistryStore({ homeDir }).lerMeta(wsDir, "execucoes", execId)).extras as Record<string, unknown>;
    expect(extras.status).toBe("falhou");
    expect(String(extras.motivo)).toContain("erro-real");
    expect(extras.ao_falhar).toEqual({ ok: true, saida: "feito" });
  });

  it("ao_falhar que falha não esconde a falha original", async () => {
    await store.salvar(wsDir, {
      id: "f", nome: "f", ativo: true,
      nos: [{ id: "ini", tipo: "manual", config: {} }, script("quebra", { comando: "exit 3" })],
      arestas: [{ de: "ini", para: "quebra" }],
      ao_falhar: { comando: "exit 9" },
    } as never);
    const execId = await execucaoFalha(() => store.executar(wsDir, "f"));
    const extras = (await new RegistryStore({ homeDir }).lerMeta(wsDir, "execucoes", execId)).extras as Record<string, unknown>;
    expect(String(extras.motivo)).toContain("quebra");
    expect((extras.ao_falhar as { ok: boolean }).ok).toBe(false);
  });

  it("não roda ao_falhar quando o flow conclui", async () => {
    await store.salvar(wsDir, {
      id: "f", nome: "f", ativo: true,
      nos: [{ id: "ini", tipo: "manual", config: {} }, script("bom", { comando: "echo ok" })],
      arestas: [{ de: "ini", para: "bom" }],
      ao_falhar: { comando: "touch nao-devia.txt" },
    } as never);
    const r = await store.executar(wsDir, "f");
    expect(r.status).toBe("concluido");
    expect(existsSync(join(wsDir, "nao-devia.txt"))).toBe(false);
  });

  it("tentativas repete o comando até dar certo", async () => {
    await store.salvar(wsDir, {
      id: "f", nome: "f", ativo: true,
      nos: [{ id: "ini", tipo: "manual", config: {} }, script("instavel", {
        comando: "if [ -f marca ]; then echo certo; else touch marca; exit 1; fi",
        tentativas: 2,
        espera_tentativa_ms: 1,
      })],
      arestas: [{ de: "ini", para: "instavel" }],
    } as never);
    const r = await store.executar(wsDir, "f");
    expect(r.status).toBe("concluido");
    expect(r.contextoFinal).toBe("certo");
  });

  it("sem tentativas, falha na primeira", async () => {
    await store.salvar(wsDir, {
      id: "f", nome: "f", ativo: true,
      nos: [{ id: "ini", tipo: "manual", config: {} }, script("instavel", { comando: "if [ -f marca ]; then echo certo; else touch marca; exit 1; fi" })],
      arestas: [{ de: "ini", para: "instavel" }],
    } as never);
    await expect(store.executar(wsDir, "f")).rejects.toThrow(/instavel/);
  });
});
