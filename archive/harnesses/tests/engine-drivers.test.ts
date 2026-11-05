import { existsSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { engineRegistry, EngineNotFoundError } from "../src/core/engines/index.js";
import { createApiServer } from "../src/server/index.js";

describe("EngineRegistry & Multi-Engine Drivers", () => {
  let tempHome: string;
  let serverInstance: any;
  let serverPort: number;

  beforeAll(async () => {
    tempHome = join(tmpdir(), `opencorp-engines-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    mkdirSync(join(tempHome, ".opencorp", "bin"), { recursive: true });

    serverPort = 44700 + Math.floor(Math.random() * 200);
    const s = createApiServer({
      porta: serverPort,
      homeDir: tempHome,
      token: "",
    });
    serverInstance = s.server;
    serverInstance.listen(serverPort);
    await s.porta;
  });

  afterAll(async () => {
    if (serverInstance?.close) {
      await new Promise<void>((r) => serverInstance.close(() => r()));
    }
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("deve carregar todos os motores suportados no EngineRegistry", () => {
    const drivers = engineRegistry.list();
    const ids = drivers.map((d) => d.id);

    expect(ids).toContain("opencode");
    expect(ids).toContain("crom-agente");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("antigravity");
    expect(ids).toContain("cursor");
    expect(ids).toContain("copilot");
    expect(ids).toContain("codex");
    expect(ids).toContain("aider");
  });

  it("deve resolver aliases para motores corretamente", () => {
    expect(engineRegistry.resolveDriver("crom-agente").id).toBe("crom-agente");
    expect(engineRegistry.resolveDriver("crom").id).toBe("crom-agente");
    expect(engineRegistry.resolveDriver("claude").id).toBe("claude-code");
    expect(engineRegistry.resolveDriver("agy").id).toBe("antigravity");
    expect(() => engineRegistry.resolveDriver("desconhecido")).toThrow(EngineNotFoundError);
    expect(() => engineRegistry.resolveDriver("desconhecido")).toThrow(/não está registrado/);
  });

  it("não instala um wrapper AGY que executa outro motor", async () => {
    const agy = engineRegistry.get("antigravity")!;
    // Sem artefato verificado, a instalação é recusada — nunca um wrapper para outro motor.
    await expect(agy.install(tempHome)).rejects.toThrow(/Instalação gerenciada não suportada/);
    expect(existsSync(join(tempHome, ".opencorp", "bin", "agy"))).toBe(false);
  });

  it("deve listar summaries com status de instalação e isolamento", async () => {
    const summaries = await engineRegistry.listSummaries(tempHome, false);
    expect(Array.isArray(summaries)).toBe(true);
    expect(summaries.length).toBeGreaterThanOrEqual(4);

    const oc = summaries.find((s) => s.id === "opencode");
    expect(oc).toBeDefined();
    expect(oc?.name).toContain("OpenCode");

    const crom = summaries.find((s) => s.id === "crom-agente");
    expect(crom).toBeDefined();
    expect(crom?.maintainer).toBe("CromIA");
  });

  it("deve preparar execução com parâmetros isolados para crom-agente", async () => {
    const cromDriver = engineRegistry.get("crom-agente")!;
    const prep = await cromDriver.prepareExecution({
      workspaceId: "ws1",
      workspacePath: "/tmp/ws1",
      sessionId: "sess-123",
      agentId: "operario",
      model: "openrouter/google/gemini-3.8-flash",
      prompt: "Execute tarefa",
      homeDir: tempHome,
    });

    expect(prep.args).toContain("run");
    expect(prep.args).toContain("Execute tarefa");
    expect(prep.args).toContain("--workspace");
    expect(prep.args).toContain("/tmp/ws1");
    expect(prep.args).toContain("--permission-mode");
    expect(prep.args).toContain("total_access");
    expect(prep.args).toContain("--provider");
    expect(prep.args).toContain("openrouter");
    expect(prep.cwd).toBe("/tmp/ws1");
  });

  it("MiMo encaminha o modelo selecionado para o CLI", async () => {
    const mimo = engineRegistry.get("mimo")!;
    const prep = await mimo.prepareExecution({
      workspaceId: "ws1",
      workspacePath: "/tmp/ws1",
      sessionId: "sess-mimo",
      agentId: "operario",
      model: "mimo/MiMo-V2-Free",
      prompt: "Responda OK",
      homeDir: tempHome,
    });
    expect(prep.args).toEqual(expect.arrayContaining(["run", "--model", "mimo/MiMo-V2-Free", "Responda OK"]));
  });

  it("GET /modelos/catalogo agrega modelos de todos os motores", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/modelos/catalogo`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.total).toBeGreaterThan(0);
    expect(data.modelos.some((m: any) => m.motor === "antigravity" && m.id === "gemini-3.8-flash-high")).toBe(true);
    expect(data.modelos.some((m: any) => m.motor === "mimo" && m.id === "mimo/MiMo-V2-Free")).toBe(true);
  });

  it("GET /api/motores deve responder 200 com lista completa de motores e diagnósticos", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/motores`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.motores)).toBe(true);
    expect(data.motores.some((m: any) => m.id === "opencode")).toBe(true);
    expect(data.motores.some((m: any) => m.id === "crom-agente")).toBe(true);
    expect(data.motores.some((m: any) => m.id === "claude-code")).toBe(true);
    expect(data.motores.some((m: any) => m.id === "antigravity")).toBe(true);
  });

  it("POST /api/motores/:id/test deve executar verificação de saúde", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/motores/opencode/test`, {
      method: "POST",
    });
    const data = (await res.json()) as any;
    expect(data.motorId).toBe("opencode");
    expect(data.health).toBeDefined();
    expect(data.ok).toBe(data.health.healthy);
    expect(res.status).toBe(200);
    expect(data.relatorio.results.length).toBeGreaterThan(0);
    expect(typeof data.ms).toBe("number");
  });

  it("POST /api/motores/:id/test devolve relatório por nível sem inferência por padrão", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/motores/opencode/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nivel: "installed" }),
    });
    const data = (await res.json()) as any;
    expect(data.nivel).toBe("installed");
    expect(data.relatorio.requestedLevel).toBe("installed");
    expect(data.relatorio.results.map((r: any) => r.level)).toEqual(["installed"]);
    expect(data.relatorio.model).toBeNull();
  });

  it("POST /api/motores/:id/test recusa nível inválido e probe real sem confirmação ou modelo", async () => {
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${serverPort}/api/motores/opencode/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const invalido = await post({ nivel: "tudo" });
    expect(invalido.status).toBe(400);
    const semConfirmar = await post({ nivel: "inference", modelo: "openrouter/x/y" });
    expect(semConfirmar.status).toBe(400);
    expect(((await semConfirmar.json()) as any).requerConfirmacao).toBe(true);
    const semModelo = await post({ nivel: "inference", confirmarCusto: true });
    expect(semModelo.status).toBe(400);
    expect(((await semModelo.json()) as any).erro).toMatch(/modelo explícito/);
  });

  it("nunca deve expor tokenOuChave nos DTOs públicos de contas", async () => {
    const token = "sk-segredo-que-nao-pode-vazar";
    const createRes = await fetch(`http://127.0.0.1:${serverPort}/api/motores/opencode/contas`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: "Conta sanitizada", tokenOuChave: token }),
    });
    expect(createRes.status).toBe(201);
    const criada = (await createRes.json()) as any;
    expect(criada.conta.tokenOuChave).toBeUndefined();
    expect(criada.conta.possuiToken).toBe(true);
    expect(JSON.stringify(criada)).not.toContain(token);

    const listRes = await fetch(`http://127.0.0.1:${serverPort}/engine-accounts`);
    expect(listRes.status).toBe(200);
    const listada = (await listRes.json()) as any;
    expect(listada.contas[0].tokenOuChave).toBeUndefined();
    expect(listada.contas[0].possuiToken).toBe(true);
    expect(JSON.stringify(listada)).not.toContain(token);

    const statusRes = await fetch(`http://127.0.0.1:${serverPort}/api/motores`);
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as any;
    expect(JSON.stringify(status)).not.toContain(token);
  });

  it("cada módulo adaptador de motor deve implementar fetchLiveTokens sem cálculos cegos", async () => {
    const drivers = engineRegistry.list();
    for (const driver of drivers) {
      const liveUsage = await driver.fetchLiveTokens(tempHome);
      expect(liveUsage).toBeDefined();
      expect(liveUsage.motorId).toBe(driver.id);
      expect(liveUsage.motorName).toBe(driver.name);
      expect(["api_live", "cli_live", "oauth_session", "unconfigured", "error"]).toContain(liveUsage.source);
      expect(typeof liveUsage.mensagem).toBe("string");
      expect(liveUsage.consultadoEm).toBeDefined();
    }
  });

  it("GET /api/motores/tokens deve responder 200 com quotas e tokens reais de todos os motores", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/motores/tokens`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.tokens).toBeDefined();
    expect(data.tokens.opencode).toBeDefined();
    expect(data.tokens.copilot).toBeDefined();
    expect(data.tokens.antigravity).toBeDefined();
  });

  it("GET /api/motores/:id/tokens deve retornar cota e tokens do motor especificado", async () => {
    const res = await fetch(`http://127.0.0.1:${serverPort}/api/motores/copilot/tokens`);
    expect(res.status).toBe(200);

    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.motorId).toBe("copilot");
    expect(data.tokens).toBeDefined();
    expect(data.tokens.motorId).toBe("copilot");
  });
});
