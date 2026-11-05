import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "../src/core/contexts/execution/session-manager.js";
import { harnessRegistry } from "../src/core/harness/index.js";

describe("Agente — Rotação Própria e Harness", () => {
  let tempHome: string;
  let wsPath: string;

  beforeEach(() => {
    tempHome = join(tmpdir(), `opencorp-rot-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    wsPath = join(tempHome, "workspace-teste");
    mkdirSync(join(wsPath, ".opencorp", "agents"), { recursive: true });
    mkdirSync(join(wsPath, ".opencorp", "registries"), { recursive: true });
    mkdirSync(join(tempHome, ".opencorp"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("proximoModeloDaRotacao prioriza a rotation do próprio agente", async () => {
    const conteudoAgente = `---
id: especialista-rot
role: Especialista em Testes
category: operario
model: openrouter/google/gemini-3.8-flash
tools: [ler_arquivo]
permissions: level-1
budget:
  daily_usd: 1.00
  max_turns: 10
memory:
  reads: []
  writes: []
rotation: [openrouter/google/gemini-3.8-flash, openrouter/nvidia/nemotron-3.5-lightning:free, openrouter/minimax/minimax-m3:free]
ativo: true
---

Você é um agente especialista em testes.`;

    writeFileSync(join(wsPath, ".opencorp", "agents", "especialista-rot.md"), conteudoAgente, "utf8");

    const sessoes = new SessionManager({ homeDir: tempHome });
    const proximo = await (sessoes as any).proximoModeloDaRotacao(
      "openrouter/google/gemini-3.8-flash",
      wsPath,
      "especialista-rot"
    );

    expect(proximo).toBe("openrouter/nvidia/nemotron-3.5-lightning:free");
  });

  it("HarnessRegistry permite registrar e obter motores", () => {
    expect(harnessRegistry.obterPadrao()).toBe("claude-sdk");
  });
});
