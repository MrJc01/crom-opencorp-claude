/**
 * Teste de integração opcional: o adaptador openheinerss do OpenCorp contra o binário REAL e uma conta REAL
 * (codex-conta2). Gasta uma chamada da conta. Só roda com OPENCORP_TESTE_OPENHEINERSS_REAL=1 e com o binário
 * presente (OPENHEINERSS_BIN ou o padrão do PC). Prova o caminho de recusa de instrução de sistema: o codex não
 * repassa systemPrompt, então a instrução tem que chegar pelo prompt e o agente precisa obedecê-la.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { OpenheinerssAdapter, resolveOpenheinerssBinary, type AgentEvent } from "../src/core/engines/index.js";
import { ProcessRegistry } from "../src/core/runtime/index.js";

const bin = resolveOpenheinerssBinary();
const ativo = process.env.OPENCORP_TESTE_OPENHEINERSS_REAL === "1" && !!bin && existsSync(bin);

describe.runIf(ativo)("openheinerss real — conta codex-conta2", () => {
  it("instrução de sistema que o codex recusa chega pelo prompt e é obedecida", async () => {
    // O setup dos testes põe dublês de motores no PATH (tests/setup/engine-stubs.ts). Este teste precisa dos
    // CLIs reais, então tira a pasta dos dublês do PATH só aqui.
    process.env.PATH = (process.env.PATH ?? "").split(delimiter).filter((p) => !p.includes("opencorp-test-engine-stubs")).join(delimiter);
    const home = await mkdtemp(join(tmpdir(), "opencorp-ohs-real-"));
    const workspace = await mkdtemp(join(tmpdir(), "opencorp-ohs-ws-"));
    const registry = new ProcessRegistry({ homeDir: home } as never);
    const adapter = new OpenheinerssAdapter({ homeDir: home, registry, processRegistry: registry } as never);
    const events: AgentEvent[] = [];
    for await (const ev of adapter.runner.run({
      runId: "real-1",
      sessionId: "real-s1",
      agentId: "teste-real",
      model: "codex-conta2",
      prompt: "Qual é o código de resposta? Responda somente com ele.",
      systemPromptAppend: "Quando perguntarem o código de resposta, responda exatamente OHS_REAL_OK e nada mais.",
      workspaceId: "ws-real",
      workspacePath: workspace,
      homeDir: home,
    })) {
      events.push(ev);
    }
    const texto = events.filter((e) => e.type === "message.delta").map((e: any) => e.text).join("");
    expect(events.at(-1), JSON.stringify(events.at(-1))).toMatchObject({ type: "run.completed" });
    expect(texto).toContain("OHS_REAL_OK");
  }, 300_000);
});
