import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlowStore } from "../src/core/contexts/orchestration/flow-store.js";
import type { OpcoesRun, ResultadoRun } from "../src/core/contexts/execution/session-manager.js";

// F9-T01/F9-T02 — execução end-to-end dos nós fundidos fanout/review/debate no
// flow-store + paridade com o team-orchestrator legado ({{anterior}}/{{ajustes}},
// moderador.ordem e passagem da saída COMPLETA entre passos).

const raizes: string[] = [];

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

async function wsNovo(): Promise<{ home: string; ws: string }> {
  const home = await mkdtemp(join(tmpdir(), "opencorp-fanout-"));
  raizes.push(home);
  const { WorkspaceManager } = await import("../src/core/contexts/workspace/workspace-manager.js");
  const ws = await new WorkspaceManager({ homeDir: home, cwd: home }).criar("corp-fanout");
  return { home, ws: ws.path };
}

function sessaoFalsa(resposta: (op: OpcoesRun) => ResultadoRun) {
  const chamadas: OpcoesRun[] = [];
  return {
    chamadas,
    store: new FlowStore({
      sessoes: {
        rodar: async (op: OpcoesRun) => {
          chamadas.push(op);
          return resposta(op);
        },
      },
    }),
  };
}

function ok(id: string, captura: string): ResultadoRun {
  return { id, status: "concluido", exit_code: 0, captura } as ResultadoRun;
}

describe("nós fundidos — fanout (F9-T01/T02)", () => {
  it("executa paralelos em paralelo e a síntese recebe a saída COMPLETA via {{anterior}}", async () => {
    const { ws } = await wsNovo();
    const saidaLonga = "A".repeat(1200) + "\nMARCADOR_FIM_PARALELO";
    const flow = {
      id: "fanout-completo",
      nome: "Fanout completo",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        {
          id: "disparar",
          tipo: "fanout",
          config: {
            paralelos: [
              { agente: "a", ordem: "analise A de {{entrada}} e {{anterior}}" },
              { agente: "b", ordem: "analise B de {{entrada}}" },
            ],
            sintese: { agente: "sint", ordem: "sintetize apenas: {{anterior}}" },
          },
        },
        { id: "fim", tipo: "saida", config: { registro: "documentos/fanout" } },
      ],
      arestas: [
        { de: "gatilho", para: "disparar" },
        { de: "disparar", para: "fim" },
      ],
    };
    const { store, chamadas } = sessaoFalsa((op) => {
      if (op.agente === "a") return ok("e-a", saidaLonga);
      if (op.agente === "b") return ok("e-b", "saida curta do B");
      if (op.agente === "sint") return ok("e-sint", "SINTESE-FINAL");
      return ok("e-?", "");
    });
    await store.salvar(ws, flow as never);
    const r = await store.executar(ws, "fanout-completo", { entrada: "contexto inicial" });

    expect(r.status).toBe("concluido");
    const agentes = chamadas.map((c) => c.agente);
    expect(agentes).toEqual(expect.arrayContaining(["a", "b", "sint"]));
    expect(agentes.filter((a) => a === "a" || a === "b")).toHaveLength(2);

    const ordemSint = chamadas.find((c) => c.agente === "sint")!.ordem!;
    // Saída COMPLETA (marcador no fim da saída longa) chega à síntese — sem truncar.
    expect(ordemSint).toContain("MARCADOR_FIM_PARALELO");
    expect(ordemSint).toContain("saida curta do B");
    expect(ordemSint).not.toContain("{{anterior}}");
    expect(r.contextoFinal).toContain("SINTESE-FINAL");
  });
});

describe("nós fundidos — fanout sem placeholder na síntese", () => {
  it("anexa as saídas dos paralelos quando a ordem da síntese não usa {{entrada}}/{{anterior}}", async () => {
    const { ws } = await wsNovo();
    const flow = {
      id: "fanout-sem-placeholder",
      nome: "Fanout sem placeholder",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        {
          id: "disparar",
          tipo: "fanout",
          config: {
            paralelos: [
              { agente: "a", ordem: "A {{entrada}}" },
              { agente: "b", ordem: "B {{entrada}}" },
            ],
            sintese: { agente: "sint", ordem: "concatene as duas saídas" },
          },
        },
      ],
      arestas: [{ de: "gatilho", para: "disparar" }],
    };
    const { store, chamadas } = sessaoFalsa((op) => ok(`e-${op.agente}`, op.agente === "sint" ? "OK" : `SAIDA-${op.agente}`));
    await store.salvar(ws, flow as never);
    const r = await store.executar(ws, "fanout-sem-placeholder", { entrada: "x" });

    expect(r.status).toBe("concluido");
    const ordemSint = chamadas.find((c) => c.agente === "sint")!.ordem!;
    expect(ordemSint.startsWith("concatene as duas saídas")).toBe(true);
    expect(ordemSint).toContain("SAIDA-a");
    expect(ordemSint).toContain("SAIDA-b");
  });
});

describe("nós fundidos — review (F9-T01/T02)", () => {
  it("executor recebe {{ajustes}} e revisor recebe saída completa até APROVADO", async () => {
    const { ws } = await wsNovo();
    const flow = {
      id: "review-ok",
      nome: "Review ok",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        {
          id: "revisar",
          tipo: "review",
          config: {
            executor: { agente: "exec", ordem: "produza: {{entrada}} (ajustes: {{ajustes}})" },
            revisor: { agente: "rev", ordem: "revise: {{anterior}}" },
            turnos: 2,
          },
        },
        { id: "fim", tipo: "saida", config: { registro: "documentos/review" } },
      ],
      arestas: [
        { de: "gatilho", para: "revisar" },
        { de: "revisar", para: "fim" },
      ],
    };
    const saidaExec = "X".repeat(900) + "\nCONTEUDO-FIM-EXEC";
    let turnoExec = 0;
    const { store, chamadas } = sessaoFalsa((op) => {
      if (op.agente === "exec") {
        turnoExec++;
        return ok(`e-exec-${turnoExec}`, turnoExec === 1 ? saidaExec : "versao corrigida final");
      }
      if (op.agente === "rev") {
        return ok("e-rev", turnoExec === 1 ? "AJUSTES: melhore a conclusão" : "APROVADO");
      }
      return ok("e-?", "");
    });
    await store.salvar(ws, flow as never);
    const r = await store.executar(ws, "review-ok", { entrada: "pedido" });

    expect(r.status).toBe("concluido");
    const execChamadas = chamadas.filter((c) => c.agente === "exec");
    const revChamadas = chamadas.filter((c) => c.agente === "rev");
    expect(execChamadas).toHaveLength(2);
    expect(revChamadas).toHaveLength(2);

    expect(execChamadas[0]!.ordem).toContain("primeira rodada");
    expect(execChamadas[1]!.ordem).toContain("melhore a conclusão");
    // Revisor recebe a saída COMPLETA do executor (marcador no fim).
    expect(revChamadas[0]!.ordem).toContain("CONTEUDO-FIM-EXEC");
    expect(r.contextoFinal).toContain("versao corrigida final");
  });

  it("revisor nunca aprova → falha com 'escala humano' após os turnos", async () => {
    const { ws } = await wsNovo();
    const flow = {
      id: "review-esgotado",
      nome: "Review esgotado",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        {
          id: "revisar",
          tipo: "review",
          config: {
            executor: { agente: "exec", ordem: "produza" },
            revisor: { agente: "rev", ordem: "revise" },
            turnos: 2,
          },
        },
        { id: "fim", tipo: "saida", config: { registro: "documentos/review" } },
      ],
      arestas: [
        { de: "gatilho", para: "revisar" },
        { de: "revisar", para: "fim" },
      ],
    };
    const { store } = sessaoFalsa((op) => {
      if (op.agente === "exec") return ok("e-exec", "conteudo");
      return ok("e-rev", "AJUSTES: sempre");
    });
    await store.salvar(ws, flow as never);
    await expect(store.executar(ws, "review-esgotado", { entrada: "x" })).rejects.toThrow(/escala humano/);
  });
});

describe("nós fundidos — debate (F9-T01/T02)", () => {
  it("proponentes em paralelo; moderador.ordem decide com DECISÃO:", async () => {
    const { ws } = await wsNovo();
    const flow = {
      id: "debate-ok",
      nome: "Debate ok",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        {
          id: "debatendo",
          tipo: "debate",
          config: {
            proponentes: [
              { agente: "p1", ordem: "proposta um para {{entrada}}" },
              { agente: "p2", ordem: "proposta dois para {{entrada}}" },
            ],
            moderador: { agente: "mod", ordem: "decida entre:\n{{anterior}}" },
          },
        },
        { id: "fim", tipo: "saida", config: { registro: "documentos/debate" } },
      ],
      arestas: [
        { de: "gatilho", para: "debatendo" },
        { de: "debatendo", para: "fim" },
      ],
    };
    const { store, chamadas } = sessaoFalsa((op) => {
      if (op.agente === "p1") return ok("e-p1", "proposta detalhada do P1");
      if (op.agente === "p2") return ok("e-p2", "proposta detalhada do P2");
      if (op.agente === "mod") return ok("e-mod", "DECISÃO: P1\nporque é superior");
      return ok("e-?", "");
    });
    await store.salvar(ws, flow as never);
    const r = await store.executar(ws, "debate-ok", { entrada: "questão" });

    expect(r.status).toBe("concluido");
    const ordemMod = chamadas.find((c) => c.agente === "mod")!.ordem!;
    // Usou moderador.ordem (não o prompt fixo legado).
    expect(ordemMod).toContain("decida entre:");
    expect(ordemMod).not.toContain("Propostas dos proponentes");
    // Saída COMPLETA das propostas no {{anterior}}.
    expect(ordemMod).toContain("proposta detalhada do P1");
    expect(ordemMod).toContain("proposta detalhada do P2");
    expect(r.contextoFinal).toContain("DECISÃO: P1");
  });

  it("sem moderador.ordem mantém o contrato fixo de moderação (retrocompatível)", async () => {
    const { ws } = await wsNovo();
    const flow = {
      id: "debate-legado",
      nome: "Debate legado",
      nos: [
        { id: "gatilho", tipo: "manual", config: {} },
        {
          id: "debatendo",
          tipo: "debate",
          config: {
            proponentes: [
              { agente: "p1", ordem: "proposta um" },
              { agente: "p2", ordem: "proposta dois" },
            ],
            moderador: { agente: "mod" },
          },
        },
        { id: "fim", tipo: "saida", config: { registro: "documentos/debate" } },
      ],
      arestas: [
        { de: "gatilho", para: "debatendo" },
        { de: "debatendo", para: "fim" },
      ],
    };
    const { store, chamadas } = sessaoFalsa((op) => {
      if (op.agente === "p1") return ok("e-p1", "proposta um detalhada");
      if (op.agente === "p2") return ok("e-p2", "proposta dois detalhada");
      if (op.agente === "mod") return ok("e-mod", "DECISÃO: P2\njustificativa");
      return ok("e-?", "");
    });
    await store.salvar(ws, flow as never);
    const r = await store.executar(ws, "debate-legado", { entrada: "q" });

    expect(r.status).toBe("concluido");
    const ordemMod = chamadas.find((c) => c.agente === "mod")!.ordem!;
    expect(ordemMod).toContain("Propostas dos proponentes");
    expect(ordemMod).toContain("DECISÃO:");
    expect(r.contextoFinal).toContain("DECISÃO: P2");
  });
});
