import { afterEach, describe, expect, it } from "vitest";
import {
  clearEngineCredentialPolicies,
  engineCredentialVars,
  isKnownSecretEnvVar,
  registerEngineCredentialPolicy,
} from "../src/core/credentials/credentials-store.js";
import { PROVIDER_DEFINITIONS, providersWithKeySources } from "../src/core/models/providers.js";

afterEach(() => clearEngineCredentialPolicies());

describe("política de credenciais por motor", () => {
  it("usa a tabela legada sem registro e o manifest quando registrado", () => {
    expect(engineCredentialVars("codex")).toEqual(["OPENAI_API_KEY"]);
    expect(engineCredentialVars("novo-motor")).toEqual([]);
    registerEngineCredentialPolicy("novo-motor", { envVars: ["NOVO_API_KEY"] });
    expect(engineCredentialVars("novo-motor")).toEqual(["NOVO_API_KEY"]);
    expect(isKnownSecretEnvVar("NOVO_API_KEY")).toBe(true);
  });
});

describe("catálogo de provedores", () => {
  it("opencode-go não lê chave do ambiente (reaproveita a do OpenRouter)", () => {
    expect(PROVIDER_DEFINITIONS.some((p) => p.id === "anthropic")).toBe(true);
    expect(providersWithKeySources().map((p) => p.id)).not.toContain("opencode-go");
  });
});
