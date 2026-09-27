import type { NoGrafo } from "./types.js";

export type TemplateFluxo = "pipeline" | "fanout" | "review" | "debate";

/**
 * Nós e arestas iniciais de cada modelo do modal "Novo Fluxo". Cada modelo
 * precisa passar pela validação do FlowStore (ver tests/flow-templates.test.ts).
 */
export function montarTemplateFluxo(template: TemplateFluxo): { nos: NoGrafo[]; arestas: Array<{ de: string; para: string }> } {
  let nos: NoGrafo[] = [];
  let arestas: any[] = [];

  if (template === "pipeline") {
    nos = [
      { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
      {
        id: "agente-executor",
        tipo: "agente",
        // O backend exige config.agente (ou prompt_sistema) no nó agente.
        config: { agente: "executor-padrao", ordem: "{{entrada}}" },
        pos: { x: 380, y: 140 },
      },
      { id: "saida", tipo: "saida", config: { registro: "documentos/resultados" }, pos: { x: 680, y: 140 } },
    ];
    arestas = [
      { de: "gatilho-manual", para: "agente-executor" },
      { de: "agente-executor", para: "saida" },
    ];
  } else if (template === "fanout") {
    nos = [
      { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
      {
        id: "equipe-fanout",
        tipo: "fanout",
        config: {
          paralelos: [
            { agente: "executor-padrao", ordem: "Parte 1: {{entrada}}" },
            { agente: "executor-padrao", ordem: "Parte 2: {{entrada}}" },
          ],
        },
        pos: { x: 380, y: 140 },
      },
      { id: "saida", tipo: "saida", config: { registro: "documentos/resultados" }, pos: { x: 680, y: 140 } },
    ];
    arestas = [
      { de: "gatilho-manual", para: "equipe-fanout" },
      { de: "equipe-fanout", para: "saida" },
    ];
  } else if (template === "review") {
    nos = [
      { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
      {
        id: "equipe-review",
        tipo: "review",
        config: {
          executor: { agente: "executor-padrao", ordem: "{{entrada}}" },
          revisor: { agente: "auditor", ordem: "Revise o resultado e aponte correções." },
        },
        pos: { x: 380, y: 140 },
      },
      { id: "saida", tipo: "saida", config: { registro: "documentos/resultados" }, pos: { x: 680, y: 140 } },
    ];
    arestas = [
      { de: "gatilho-manual", para: "equipe-review" },
      { de: "equipe-review", para: "saida" },
    ];
  } else {
    nos = [
      { id: "gatilho-manual", tipo: "manual", pos: { x: 80, y: 140 } },
      {
        id: "equipe-debate",
        tipo: "debate",
        config: {
          proponentes: [
            { agente: "executor-padrao", ordem: "Defenda uma proposta para: {{entrada}}" },
            { agente: "auditor", ordem: "Defenda uma alternativa para: {{entrada}}" },
          ],
          moderador: { agente: "executor-padrao", ordem: "Sintetize a melhor decisão." },
        },
        pos: { x: 380, y: 140 },
      },
      { id: "saida", tipo: "saida", config: { registro: "documentos/resultados" }, pos: { x: 680, y: 140 } },
    ];
    arestas = [
      { de: "gatilho-manual", para: "equipe-debate" },
      { de: "equipe-debate", para: "saida" },
    ];
  }
  return { nos, arestas };
}
