/**
 * Os modelos do modal "Novo Fluxo" precisam passar pela validação do backend.
 * Regressão: todos os quatro eram recusados (nó agente sem config.agente,
 * fanout/review/debate sem configuração) e a criação pela UI falhava.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowStore } from "../src/core/contexts/orchestration/flow-store.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";
import { montarTemplateFluxo, type TemplateFluxo } from "../src/web/features/workflows/templates.js";

describe("modelos de fluxo do modal Novo Fluxo", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-flow-tpl-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  for (const template of ["pipeline", "fanout", "review", "debate"] as TemplateFluxo[]) {
    it(`${template} é aceito pelo FlowStore`, async () => {
      const ws = await new WorkspaceManager({ homeDir: home, cwd: home }).criar(`ws-${template}`);
      const { nos, arestas } = montarTemplateFluxo(template);
      const flow = await new FlowStore({ homeDir: home }).salvarComId(ws.path, { id: `tpl-${template}`, nome: template, nos: nos as any, arestas: arestas as any, ativo: true });
      expect(flow.nos.length).toBe(3);
    });
  }
});
