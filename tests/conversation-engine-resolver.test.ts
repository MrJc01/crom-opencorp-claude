import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConversationRuntimeResolver,
  resolveConversationRuntime,
  EngineRegistry,
  EngineNotFoundError,
  EngineUnavailableError,
  EngineAuthRequiredError,
  PreflightBinaryMissingError,
  EngineCapabilityUnavailableError,
  type EngineAdapter,
  type EngineCapabilityManifest,
} from "../src/core/engines/index.js";
import { SettingsStore } from "../src/core/contexts/workspace/settings-store.js";

describe("ETAPA 5 — Resolução do Runtime Conversacional", () => {
  let tempHome: string;
  let workspaceDir: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "opencorp-resolver-home-"));
    workspaceDir = join(tempHome, "workspaces", "ws-teste");
    await mkdir(join(tempHome, ".opencorp"), { recursive: true });
    await mkdir(join(workspaceDir, ".opencorp"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it("herança global: resolve settings.default_conversation_engine quando o workspace não possui override", async () => {
    // Configura global como claude-sdk
    await writeFile(
      join(tempHome, ".opencorp", "settings.json"),
      JSON.stringify({ default_conversation_engine: "claude-sdk" }, null, 2),
      "utf8"
    );

    const store = new SettingsStore({ homeDir: tempHome });
    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      settingsStore: store,
    });

    const result = await resolver.resolve({
      workspaceDir,
      strict: false,
    });

    expect(result.engineId).toBe("claude-sdk");
    expect(result.source).toBe("global_default");
    expect(result.adapter).toBeDefined();
    expect(result.adapter.engineId).toBe("claude-sdk");
    expect(result.manifest.engineId).toBe("claude-sdk");
  });

  it("override por workspace: conversationEngineOverride tem precedência sobre o padrão global", async () => {
    // Global é opencode
    await writeFile(
      join(tempHome, ".opencorp", "settings.json"),
      JSON.stringify({ default_conversation_engine: "claude-code" }, null, 2),
      "utf8"
    );

    // Workspace define override como claude-sdk
    await writeFile(
      join(workspaceDir, ".opencorp", "config.json"),
      JSON.stringify({ conversationEngineOverride: "claude-sdk" }, null, 2),
      "utf8"
    );

    const store = new SettingsStore({ homeDir: tempHome });
    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      settingsStore: store,
    });

    const result = await resolver.resolve({
      workspaceDir,
      strict: false,
    });

    expect(result.engineId).toBe("claude-sdk");
    expect(result.source).toBe("workspace_override");
    expect(result.adapter.engineId).toBe("claude-sdk");
  });

  it("override pontual via opções tem precedência imediata", async () => {
    await writeFile(
      join(tempHome, ".opencorp", "settings.json"),
      JSON.stringify({ default_conversation_engine: "claude-code" }, null, 2),
      "utf8"
    );

    const resolver = new ConversationRuntimeResolver({ homeDir: tempHome });
    const result = await resolver.resolve({
      workspaceDir,
      engineOverride: "claude-code",
      strict: false,
    });

    expect(result.engineId).toBe("claude-code");
    expect(result.source).toBe("workspace_override");
    expect(result.adapter.engineId).toBe("claude-code");
  });

  it("motor inexistente: rejeita com EngineNotFoundError e nunca faz fallback para opencode", async () => {
    await writeFile(
      join(workspaceDir, ".opencorp", "config.json"),
      JSON.stringify({ conversationEngineOverride: "motor_fantasma_inexistente" }, null, 2),
      "utf8"
    );

    const store = new SettingsStore({ homeDir: tempHome });
    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      settingsStore: store,
    });

    await expect(
      resolver.resolve({ workspaceDir, strict: false })
    ).rejects.toThrow(EngineNotFoundError);

    // Garante que o erro cita especificamente o motor fantasma
    try {
      await resolver.resolve({ workspaceDir, strict: false });
    } catch (err) {
      expect(err).toBeInstanceOf(EngineNotFoundError);
      expect((err as EngineNotFoundError).message).toContain("motor_fantasma_inexistente");
    }
  });

  it("motor sem suporte conversacional (ex: claude-code): rejeita em modo strict com EngineCapabilityUnavailableError", async () => {
    await writeFile(
      join(workspaceDir, ".opencorp", "config.json"),
      JSON.stringify({ conversationEngineOverride: "claude-code" }, null, 2),
      "utf8"
    );

    const store = new SettingsStore({ homeDir: tempHome });
    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      settingsStore: store,
    });

    // Em modo strict deve estourar erro de capacidade
    await expect(
      resolver.resolve({ workspaceDir, strict: true })
    ).rejects.toThrow(EngineCapabilityUnavailableError);

    // Em modo não estrito, retorna diagnóstico estruturado sem trocar para opencode
    const result = await resolver.resolve({ workspaceDir, strict: false });
    expect(result.engineId).toBe("claude-code");
    expect(result.preflight.supportsConversation).toBe(false);
    expect(result.preflight.ok).toBe(false);
    expect(result.preflight.issues.some((i) => i.includes("capacidade conversacional"))).toBe(true);
    expect(result.adapter.engineId).toBe("claude-code"); // PROIBIDO fallback silencioso
  });

  it("motor customizado sem suporte a conversa registrado dinamicamente", async () => {
    const registry = EngineRegistry.getInstance();
    const manifestSemConversa: EngineCapabilityManifest = {
      engineId: "cli-one-shot-only",
      name: "One Shot Only CLI",
      transport: "spawn_cli",
      supportsConversation: false,
      features: {
        streaming: { level: "unsupported" },
        continuation: { level: "unsupported" },
        fork: { level: "unsupported" },
        hitl: { level: "unsupported" },
        tools: { level: "unsupported" },
        mcp: { level: "unsupported" },
        images: { level: "unsupported" },
        cancellation: { level: "integrated" },
      },
    };

    const mockAdapter: EngineAdapter = {
      engineId: "cli-one-shot-only",
      name: "One Shot Only CLI",
      manifest: manifestSemConversa,
      installer: {
        engineId: "cli-one-shot-only",
        status: async () => ({ installed: true, path: "/usr/bin/one-shot", isManaged: false }),
        install: async () => ({ success: true }),
      },
      authenticator: {
        engineId: "cli-one-shot-only",
        status: async () => ({ authenticated: true, method: "none" }),
        fetchTokens: async () => ({ totalTokens: 0 }),
      },
      runner: {
        engineId: "cli-one-shot-only",
        run: async function* () {},
      },
    };

    registry.registerAdapter(mockAdapter);

    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      registry,
    });

    // Em strict: erro de capacidade
    await expect(
      resolver.resolve({ engineOverride: "cli-one-shot-only", strict: true })
    ).rejects.toThrow(EngineCapabilityUnavailableError);

    // Em non-strict: diagnóstico acionável sem fallback
    const res = await resolver.resolve({ engineOverride: "cli-one-shot-only", strict: false });
    expect(res.engineId).toBe("cli-one-shot-only");
    expect(res.preflight.supportsConversation).toBe(false);
    expect(res.preflight.ok).toBe(false);
  });

  it("motor não autenticado: em modo strict lança EngineAuthRequiredError, em non-strict retorna diagnóstico", async () => {
    const registry = EngineRegistry.getInstance();
    const manifestComConversa: EngineCapabilityManifest = {
      engineId: "motor-deslogado",
      name: "Motor Sem Login",
      transport: "spawn_cli",
      supportsConversation: true,
      features: {
        streaming: { level: "integrated" },
        continuation: { level: "integrated" },
        fork: { level: "unsupported" },
        hitl: { level: "integrated" },
        tools: { level: "integrated" },
        mcp: { level: "unsupported" },
        images: { level: "unsupported" },
        cancellation: { level: "integrated" },
      },
    };

    const mockAdapter: EngineAdapter = {
      engineId: "motor-deslogado",
      name: "Motor Sem Login",
      manifest: manifestComConversa,
      installer: {
        engineId: "motor-deslogado",
        status: async () => ({ installed: true, path: "/bin/test", isManaged: false }),
        install: async () => ({ success: true }),
      },
      authenticator: {
        engineId: "motor-deslogado",
        status: async () => ({ authenticated: false, method: "token", details: "Execute 'motor login'" }),
        fetchTokens: async () => ({ totalTokens: 0 }),
      },
      runner: {
        engineId: "motor-deslogado",
        run: async function* () {},
      },
    };

    registry.registerAdapter(mockAdapter);

    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      registry,
    });

    // Em strict lança EngineAuthRequiredError
    await expect(
      resolver.resolve({ engineOverride: "motor-deslogado", strict: true })
    ).rejects.toThrow(EngineAuthRequiredError);

    // Em non-strict informa detalhes acionáveis
    const res = await resolver.resolve({ engineOverride: "motor-deslogado", strict: false });
    expect(res.engineId).toBe("motor-deslogado");
    expect(res.preflight.authenticated).toBe(false);
    expect(res.preflight.ok).toBe(false);
    expect(res.preflight.recommendation).toBeDefined();
  });

  it("motor sem binário: em modo strict lança PreflightBinaryMissingError", async () => {
    const registry = EngineRegistry.getInstance();
    const manifestSemBinario: EngineCapabilityManifest = {
      engineId: "motor-sem-binario",
      name: "Motor Sem Binário",
      transport: "spawn_cli",
      supportsConversation: true,
      features: {
        streaming: { level: "integrated" },
        continuation: { level: "integrated" },
        fork: { level: "unsupported" },
        hitl: { level: "integrated" },
        tools: { level: "integrated" },
        mcp: { level: "unsupported" },
        images: { level: "unsupported" },
        cancellation: { level: "integrated" },
      },
    };

    const mockAdapter: EngineAdapter = {
      engineId: "motor-sem-binario",
      name: "Motor Sem Binário",
      manifest: manifestSemBinario,
      installer: {
        engineId: "motor-sem-binario",
        status: async () => ({ installed: false, path: null, isManaged: false }),
        install: async () => ({ success: false, error: "falha no download" }),
      },
      authenticator: {
        engineId: "motor-sem-binario",
        status: async () => ({ authenticated: true, method: "none" }),
        fetchTokens: async () => ({ totalTokens: 0 }),
      },
      runner: {
        engineId: "motor-sem-binario",
        run: async function* () {},
      },
    };

    registry.registerAdapter(mockAdapter);

    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      registry,
    });

    await expect(
      resolver.resolve({ engineOverride: "motor-sem-binario", strict: true })
    ).rejects.toThrow(PreflightBinaryMissingError);

    const res = await resolver.resolve({ engineOverride: "motor-sem-binario", strict: false });
    expect(res.engineId).toBe("motor-sem-binario");
    expect(res.preflight.installed).toBe(false);
    expect(res.preflight.ok).toBe(false);
  });

  it("função helper resolveConversationRuntime funciona equivalentemente à classe", async () => {
    const res = await resolveConversationRuntime({
      homeDir: tempHome,
      engineOverride: "claude-sdk",
      strict: false,
    });

    expect(res.engineId).toBe("claude-sdk");
    expect(res.source).toBe("workspace_override");
    expect(res.adapter).toBeDefined();
    expect(res.manifest.features.continuation.level).toBe("integrated");
  });

  it("rejeita com EngineUnavailableError quando nem override nem padrão global estão definidos", async () => {
    // Config com default_conversation_engine vazio
    await writeFile(
      join(tempHome, ".opencorp", "settings.json"),
      JSON.stringify({ default_conversation_engine: "   " }, null, 2),
      "utf8"
    );

    const store = new SettingsStore({ homeDir: tempHome });
    const resolver = new ConversationRuntimeResolver({
      homeDir: tempHome,
      settingsStore: store,
    });

    await expect(
      resolver.resolve({ workspaceDir, strict: false })
    ).rejects.toThrow(EngineUnavailableError);
  });
});
