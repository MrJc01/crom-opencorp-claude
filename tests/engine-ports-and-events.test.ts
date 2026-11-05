import { describe, expect, it } from "vitest";
import {
  engineRegistry,
  CANONICAL_ENGINE_MANIFESTS,
  validateEngineCapabilityManifest,
  isCapabilityAvailable,
  InvalidEngineManifestError,
  normalizeEngineError,
  LegacyDriverAdapter,
  PreflightBinaryMissingError,
  EngineAuthRequiredError,
  ModelIncompatibleError,
  EngineCapabilityUnavailableError,
  EngineUnavailableError,
  type EngineAdapter,
  type AgentEvent,
} from "../src/core/engines/index.js";
import { CapabilitiesPara, CAPACIDADES } from "../src/core/engines/capabilities.js";

describe("ETAPA 3 — Manifestos e Domínio de Capacidades", () => {
  it("fornece um manifesto válido e compilável para todos os motores registrados (claude-code e claude-sdk; os demais estão arquivados)", () => {
    const drivers = engineRegistry.list();
    expect(drivers.length).toBeGreaterThanOrEqual(2);

    for (const driver of drivers) {
      const manifest = engineRegistry.getManifest(driver.id);
      expect(manifest).toBeDefined();
      expect(manifest?.engineId).toBe(driver.id);
      expect(() => validateEngineCapabilityManifest(manifest)).not.toThrow();
    }
  });

  it("garante que capacidade não integrada não aparece como disponível", () => {
    const aiderManifest = CANONICAL_ENGINE_MANIFESTS["aider"];
    expect(aiderManifest).toBeDefined();
    // Aider possui continuation: unsupported
    expect(isCapabilityAvailable(aiderManifest, "continuation")).toBe(false);
    expect(isCapabilityAvailable(aiderManifest, "fork")).toBe(false);

    // Claude Code possui streaming: declared (não integrado nem verificado ainda no adapter)
    const claudeManifest = CANONICAL_ENGINE_MANIFESTS["claude-code"];
    expect(isCapabilityAvailable(claudeManifest, "streaming")).toBe(false);

    // Codex possui streaming e cancelamento integrados na Etapa 8
    const codexManifest = CANONICAL_ENGINE_MANIFESTS["codex"];
    expect(isCapabilityAvailable(codexManifest, "streaming")).toBe(true);
    expect(isCapabilityAvailable(codexManifest, "cancellation")).toBe(true);

    // OpenCode possui streaming e fork integrados
    const opencodeManifest = CANONICAL_ENGINE_MANIFESTS["opencode"];
    expect(isCapabilityAvailable(opencodeManifest, "streaming")).toBe(true);
    expect(isCapabilityAvailable(opencodeManifest, "fork")).toBe(true);
  });

  it("trata 'unsupported' como valor válido e não como simulação cega", () => {
    const copilotManifest = CANONICAL_ENGINE_MANIFESTS["copilot"];
    expect(copilotManifest.features.fork.level).toBe("unsupported");
    expect(isCapabilityAvailable(copilotManifest, "fork")).toBe(false);
  });

  it("valida e adiciona MiMo ao domínio de capacidades", () => {
    const mimoCap = CapabilitiesPara("mimo");
    expect(mimoCap).toBeDefined();
    expect(mimoCap.continuaNativo).toBe(false);
    expect(mimoCap.duplicaNativo).toBe(false);
    expect(CAPACIDADES["mimo"]).toBeDefined();

    const mimoManifest = engineRegistry.getManifest("mimo");
    expect(mimoManifest).toBeDefined();
    // Etapa 12: MiMo passou a usar ACP (`mimo acp`), com continuação por session/resume.
    expect(mimoManifest?.transport).toBe("stdio_jsonrpc");
    expect(isCapabilityAvailable(mimoManifest!, "cancellation")).toBe(true);
    expect(isCapabilityAvailable(mimoManifest!, "continuation")).toBe(true);
  });

  it("validador de manifesto rejeita manifesto inválido", () => {
    expect(() => validateEngineCapabilityManifest(null)).toThrow(InvalidEngineManifestError);
    expect(() => validateEngineCapabilityManifest({})).toThrow(/campo 'engineId' é obrigatório/);
    expect(() =>
      validateEngineCapabilityManifest({
        engineId: "teste",
        transport: "invalido",
      })
    ).toThrow(/campo 'transport' deve ser um dos/);
    expect(() =>
      validateEngineCapabilityManifest({
        engineId: "teste",
        transport: "spawn_cli",
        features: {
          streaming: { level: "invalido" },
        },
      })
    ).toThrow(/feature 'streaming' deve possuir nível válido/);
  });
});

describe("ETAPA 3 — EngineRegistry e Portas Canônicas", () => {
  it("rejeita registro de adaptador sem manifesto", () => {
    const invalidAdapter: any = {
      engineId: "sem-manifesto",
      name: "Sem Manifesto",
    };

    expect(() => engineRegistry.registerAdapter(invalidAdapter)).toThrow(InvalidEngineManifestError);
    expect(() => engineRegistry.registerAdapter(invalidAdapter)).toThrow(/manifesto ausente/);
  });

  it("permite registrar adaptador válido e recuperá-lo", () => {
    const mockAdapter: EngineAdapter = {
      engineId: "custom-engine",
      name: "Custom Engine",
      manifest: {
        engineId: "custom-engine",
        name: "Custom Engine",
        transport: "spawn_cli",
        features: {
          streaming: { level: "integrated" },
          continuation: { level: "unsupported" },
          fork: { level: "unsupported" },
          hitl: { level: "declared" },
          tools: { level: "declared" },
          mcp: { level: "unsupported" },
          images: { level: "unsupported" },
          cancellation: { level: "integrated" },
        },
      },
      installer: {
        engineId: "custom-engine",
        status: async () => ({ installed: true, isManaged: false, path: "/bin/custom", version: "1.0" }),
        install: async () => ({ success: true, path: "/bin/custom", version: "1.0", log: "" }),
      },
      authenticator: {
        engineId: "custom-engine",
        status: async () => ({ authenticated: true, method: "none" }),
      },
      runner: {
        engineId: "custom-engine",
        run: async function* () {},
      },
    };

    engineRegistry.registerAdapter(mockAdapter);
    expect(engineRegistry.getAdapter("custom-engine")).toBe(mockAdapter);
    expect(engineRegistry.getManifest("custom-engine")).toEqual(mockAdapter.manifest);
  });

  it("resolveAdapter resolve todos os motores e aliases para EngineAdapter", () => {
    const sdk = engineRegistry.resolveAdapter("claude-sdk");
    expect(sdk.engineId).toBe("claude-sdk");
    expect(sdk.installer).toBeDefined();
    expect(sdk.authenticator).toBeDefined();
    expect(sdk.runner).toBeDefined();

    expect(engineRegistry.resolveAdapter("sdk").engineId).toBe("claude-sdk");
    expect(engineRegistry.resolveAdapter("claude").engineId).toBe("claude-code");
  });
});

describe("ETAPA 3 — Normalização de Erros de Fornecedor", () => {
  it("normaliza ENOENT e command not found para PreflightBinaryMissingError", () => {
    const err = normalizeEngineError(new Error("spawn codex ENOENT"), { engineId: "codex" });
    expect(err).toBeInstanceOf(PreflightBinaryMissingError);
    expect(err.code).toBe("PREFLIGHT_BINARY_MISSING");
    expect(err.engineId).toBe("codex");
  });

  it("normaliza HTTP 401 e mensagens de autenticação para EngineAuthRequiredError", () => {
    const httpErr = { status: 401, message: "Unauthorized access" };
    const err = normalizeEngineError(httpErr, { engineId: "opencode" });
    expect(err).toBeInstanceOf(EngineAuthRequiredError);
    expect(err.code).toBe("ENGINE_AUTH_REQUIRED");
    expect(err.engineId).toBe("opencode");
  });

  it("normaliza incompatibilidade de modelo para ModelIncompatibleError", () => {
    const raw = new Error("Model not supported by this engine");
    const err = normalizeEngineError(raw, { engineId: "claude-code", modelId: "gpt-4o" });
    expect(err).toBeInstanceOf(ModelIncompatibleError);
    expect(err.code).toBe("MODEL_INCOMPATIBLE");
    expect(err.details).toMatchObject({ modelId: "gpt-4o" });
  });

  it("normaliza capacidade não suportada para EngineCapabilityUnavailableError", () => {
    const raw = new Error("Unsupported capability: fork");
    const err = normalizeEngineError(raw, { engineId: "copilot", capability: "fork" });
    expect(err).toBeInstanceOf(EngineCapabilityUnavailableError);
    expect(err.code).toBe("ENGINE_CAPABILITY_UNAVAILABLE");
    expect(err.details).toMatchObject({ capability: "fork" });
  });

  it("mantém EngineError preexistente sem reembrulhar", () => {
    const orig = new EngineUnavailableError("codex", "serviço fora do ar");
    const res = normalizeEngineError(orig);
    expect(res).toBe(orig);
  });
});

describe("ETAPA 3 — Eventos Canônicos e Adaptador de Compatibilidade", () => {
  it("LegacyDriverAdapter executa runner e emite fluxo canônico de AgentEvent", async () => {
    const mockDriver: any = {
      id: "fake-engine",
      name: "Fake Engine",
      category: "cli",
      maintainer: "Test",
      supportedModelsHint: ["fake/model-v1"],
      isInstalled: async () => ({ installed: true, isManaged: false, path: "/bin/echo", version: "1.0" }),
      install: async () => ({ success: true, path: "/bin/echo", version: "1.0", log: "" }),
      checkHealth: async () => ({ healthy: true, statusText: "OK" }),
      prepareExecution: async () => ({
        binary: "node",
        args: ["-e", "console.log('Mensagem de teste do agente');"],
        env: process.env,
        cwd: process.cwd(),
      }),
      fetchLiveTokens: async () => ({
        motorId: "fake-engine",
        motorName: "Fake Engine",
        source: "cli_live",
        provedor: "Test",
        tokensDisponiveis: 1000,
        statusCota: "normal",
        mensagem: "OK",
        consultadoEm: new Date().toISOString(),
      }),
    };

    const adapter = new LegacyDriverAdapter(mockDriver);
    expect(adapter.engineId).toBe("fake-engine");

    const events: AgentEvent[] = [];
    for await (const evt of adapter.runner.run({
      workspaceId: "ws-test",
      workspacePath: process.cwd(),
      sessionId: "sess-1",
      agentId: "operario",
      model: "fake/model-v1",
      prompt: "Olá",
      homeDir: process.cwd(),
    })) {
      events.push(evt);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("message.delta");
    expect(types).toContain("run.completed");

    const delta = events.find((e) => e.type === "message.delta") as any;
    expect(delta.text).toContain("Mensagem de teste do agente");

    const completed = events.find((e) => e.type === "run.completed") as any;
    expect(completed.result.output).toContain("Mensagem de teste do agente");
  });

  it("LegacyDriverAdapter emite run.failed com EngineError normalizado se o processo falhar", async () => {
    const failingDriver: any = {
      id: "failing-engine",
      name: "Failing Engine",
      category: "cli",
      supportedModelsHint: [],
      isInstalled: async () => ({ installed: false, isManaged: false, path: null, version: null }),
      install: async () => ({ success: false, path: "", version: "", log: "failed" }),
      checkHealth: async () => ({ healthy: false, statusText: "Error" }),
      prepareExecution: async () => ({
        binary: "binario-totalmente-inexistente-12345",
        args: [],
        env: {},
        cwd: process.cwd(),
      }),
      fetchLiveTokens: async () => ({} as any),
    };

    const adapter = new LegacyDriverAdapter(failingDriver);

    const events: AgentEvent[] = [];
    for await (const evt of adapter.runner.run({
      workspaceId: "ws-test",
      workspacePath: process.cwd(),
      sessionId: "sess-1",
      agentId: "operario",
      model: "test/model",
      prompt: "Falha",
      homeDir: process.cwd(),
    })) {
      events.push(evt);
    }

    const failEvent = events.find((e) => e.type === "run.failed") as any;
    expect(failEvent).toBeDefined();
    expect(failEvent.error).toBeInstanceOf(PreflightBinaryMissingError);
    expect(failEvent.error.code).toBe("PREFLIGHT_BINARY_MISSING");
  });
});
