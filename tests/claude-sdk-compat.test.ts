/**
 * O motor claude-sdk só executa modelos claude-*: modelos de outros provedores ficam fora,
 * mesmo sem prefixo de motor (que é o caso do openrouter/*).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkModelEngineCompatibility } from "../src/core/models/catalog.js";

describe("compatibilidade do motor claude-sdk", () => {
  const anterior = process.env.OPENCORP_PROVEDOR;
  beforeEach(() => { process.env.OPENCORP_PROVEDOR = "assinatura"; });
  afterEach(() => {
    if (anterior === undefined) delete process.env.OPENCORP_PROVEDOR; else process.env.OPENCORP_PROVEDOR = anterior;
  });

  it("aceita modelos Claude, com ou sem o prefixo do motor", () => {
    expect(checkModelEngineCompatibility("claude-sdk", "claude-sdk/claude-haiku-5-5").compatible).toBe(true);
    expect(checkModelEngineCompatibility("claude-sdk", "claude-haiku-5-5").compatible).toBe(true);
  });

  it("recusa modelos de outros provedores, mesmo sem prefixo de motor", () => {
    const verdict = checkModelEngineCompatibility("claude-sdk", "openrouter/nvidia/nemotron-3.5-lightning:free");
    expect(verdict.compatible).toBe(false);
    expect(verdict.reason).toContain("só executa modelos claude-*");
  });

  it("recusa modelo de outro motor explícito", () => {
    expect(checkModelEngineCompatibility("claude-sdk", "opencode/nemotron-3-ultra-free").compatible).toBe(false);
  });
});
