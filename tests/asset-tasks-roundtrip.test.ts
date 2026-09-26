/**
 * Exportar/importar tasks em pacotes .corp usa o banco unificado (opencorp.db).
 * Regressão: o exportador lia o antigo tasks.db e não levava nenhuma task.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssetStore } from "../src/core/contexts/storage/asset-store.js";
import { TaskStore } from "../src/core/contexts/storage/task-store.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

describe("assets — tasks no banco unificado", () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-asset-tasks-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("exporta --somente tasks e importa preservando ids, mensagens e dependências", async () => {
    const wm = new WorkspaceManager({ homeDir: home, cwd: home });
    const origem = await wm.criar("ws-origem");
    const destino = await wm.criar("ws-destino");
    const tasks = new TaskStore();
    const a = await tasks.criar(origem.path, { titulo: "Base", prioridade: "alta" });
    const b = await tasks.criar(origem.path, { titulo: "Depende da base" });
    await tasks.definirDependencias(origem.path, b.id, [a.id]);
    await tasks.mensagem(origem.path, a.id, { autor: "humano", corpo: "comentário exportado" });

    const assets = new AssetStore({ homeDir: home });
    const pacote = join(home, "parcial.corp");
    await assets.exportar(origem.path, "workspace-parcial", pacote, { somente: ["tasks"] });

    const resultado = await assets.importar(pacote, { paraWorkspace: destino.path });
    expect(resultado.itens.some((i) => i.kind === "task")).toBe(true);

    const importadas = await tasks.listar(destino.path);
    expect(importadas.map((t) => t.id).sort()).toEqual([a.id, b.id].sort());
    expect(importadas.find((t) => t.id === a.id)).toMatchObject({ titulo: "Base", prioridade: "alta" });
    expect(importadas.find((t) => t.id === b.id)?.bloqueado_por).toEqual([a.id]);
    const msgs = await tasks.listarMensagens(destino.path, a.id);
    expect(msgs.some((m) => m.corpo === "comentário exportado")).toBe(true);

    // Reimportar sem sobrescrever não duplica.
    await assets.importar(pacote, { paraWorkspace: destino.path });
    expect(await tasks.listar(destino.path)).toHaveLength(2);
  });
});
