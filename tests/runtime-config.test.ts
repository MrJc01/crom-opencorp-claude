import { describe, expect, it } from "vitest";
import { settingsSchema } from "../src/schemas/settings.js";
import { parseRuntimeConfig, runtimeConfigSchema } from "../src/schemas/runtime-config.js";
import {
  EngineAuthRequiredError,
  EngineCapabilityUnavailableError,
  EngineUnavailableError,
  ModelIncompatibleError,
  PreflightBinaryMissingError,
} from "../src/core/engines/errors.js";

describe("RuntimeConfig", () => {
  it("separa motor, modo, provedor, modelo, conta e fallbacks", () => {
    const config = parseRuntimeConfig({
      engine: "codex",
      mode: "conversation",
      model: { provider: "openai", id: "gpt-5-codex", accountId: "principal" },
      fallback: {
        engines: ["claude-code", "opencode"],
        models: [{ provider: "openrouter", id: "qwen/qwen3.8-27b:free" }],
      },
    });

    expect(config.engine).toBe("codex");
    expect(config.model.provider).toBe("openai");
    expect(config.fallback?.engines).toEqual(["claude-code", "opencode"]);
  });

  it("rejeita campos canônicos vazios", () => {
    expect(() => runtimeConfigSchema.parse({
      engine: " ",
      mode: "conversation",
      model: { provider: "openai", id: "gpt" },
    })).toThrow();
  });
});

describe("configuração de runtimes", () => {
  it("usa claude-sdk como default explícito do runtime conversacional", () => {
    const settings = settingsSchema.parse({});
    expect(settings.default_conversation_engine).toBe("claude-sdk");
    expect(settings.engines).toEqual({});
    expect(settings.conversationEngineOverride).toBeUndefined();
  });

  it("aceita binary_path por motor e override do workspace", () => {
    const settings = settingsSchema.parse({
      conversationEngineOverride: "codex",
      engines: { codex: { binary_path: "/opt/codex/bin/codex" } },
    });
    expect(settings.conversationEngineOverride).toBe("codex");
    expect(settings.engines.codex?.binary_path).toBe("/opt/codex/bin/codex");
  });
});

describe("erros canônicos de motor", () => {
  it.each([
    [new EngineUnavailableError("codex"), "ENGINE_UNAVAILABLE"],
    [new PreflightBinaryMissingError("codex"), "PREFLIGHT_BINARY_MISSING"],
    [new EngineAuthRequiredError("codex"), "ENGINE_AUTH_REQUIRED"],
    [new ModelIncompatibleError("codex", "outro/modelo"), "MODEL_INCOMPATIBLE"],
    [new EngineCapabilityUnavailableError("codex", "fork"), "ENGINE_CAPABILITY_UNAVAILABLE"],
  ])("expõe código estável em %s", (error, code) => {
    expect(error.code).toBe(code);
    expect(error.engineId).toBe("codex");
    expect(error.name).toBe(error.constructor.name);
  });
});
