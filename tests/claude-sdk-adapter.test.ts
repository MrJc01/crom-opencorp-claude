/**
 * Motor "claude-sdk" (Claude Agent SDK). `query()` é mockado: nenhum teste
 * chama o modelo. Home e workspace são temporários, para não ler o login real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSdkAdapter,
  ClaudeSdkDriver,
  CLAUDE_SDK_MANIFEST,
  EngineError,
  engineRegistry,
  OpenCodeAdapter,
  traduzirMensagemSdk,
  validateEngineCapabilityManifest,
  type AgentEvent,
  type AgentRunInput,
} from "../src/core/engines/index.js";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));

interface Ambiente {
  homeDir: string;
  workspacePath: string;
}

let ambiente: Ambiente;

beforeEach(async () => {
  ambiente = {
    homeDir: await mkdtemp(join(tmpdir(), "claude-sdk-home-")),
    workspacePath: await mkdtemp(join(tmpdir(), "claude-sdk-ws-")),
  };
  queryMock.mockReset();
});

afterEach(async () => {
  await rm(ambiente.homeDir, { recursive: true, force: true });
  await rm(ambiente.workspacePath, { recursive: true, force: true });
});

const WORKSPACE = "ws-1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function entrada(extra: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: "run-teste",
    workspaceId: WORKSPACE,
    workspacePath: ambiente.workspacePath,
    sessionId: "sessao-1",
    agentId: "agente-1",
    model: "claude-haiku-5-5",
    prompt: "Diga ok",
    homeDir: ambiente.homeDir,
    ...extra,
  };
}

async function coletar(fluxo: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const eventos: AgentEvent[] = [];
  for await (const evento of fluxo) eventos.push(evento);
  return eventos;
}

/** Espera um evento aparecer na lista que está sendo preenchida por outro fluxo. */
async function esperarEvento(eventos: AgentEvent[], tipo: AgentEvent["type"]): Promise<AgentEvent> {
  for (let tentativa = 0; tentativa < 400; tentativa++) {
    const achado = eventos.find((e) => e.type === tipo);
    if (achado) return achado;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`evento "${tipo}" não chegou`);
}

const sdk = (msg: object) => msg as unknown as SDKMessage;

function assistente(...blocos: object[]): SDKMessage {
  return sdk({ type: "assistant", message: { content: blocos }, error: undefined });
}

function inicializacao(sessionId: string): SDKMessage {
  return sdk({ type: "system", subtype: "init", session_id: sessionId });
}

function usuarioComResultado(id: string, conteudo: string, isError = false): SDKMessage {
  return sdk({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: conteudo, is_error: isError }] },
  });
}

function resultadoSucesso(texto: string): SDKMessage {
  return sdk({
    type: "result",
    subtype: "success",
    is_error: false,
    result: texto,
    total_cost_usd: 0.002,
    modelUsage: {
      "claude-haiku-5-5": {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: 20,
        costUSD: 0.001,
      },
      "claude-sonnet-5-5": {
        inputTokens: 3,
        outputTokens: 7,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        costUSD: 0.001,
      },
    },
  });
}

/** Faz `query()` devolver as mensagens dadas e terminar. */
function sdkRespondeCom(...mensagens: SDKMessage[]): void {
  queryMock.mockImplementation(() => (async function* () {
    for (const msg of mensagens) yield msg;
  })());
}

/** Faz `query()` ficar preso até o AbortController ser acionado, como o SDK real. */
function sdkPresoAteAbortar(): void {
  queryMock.mockImplementation((params: { options: { abortController: AbortController } }) => (async function* () {
    const sinal = params.options.abortController.signal;
    await new Promise<void>((_, rejeitar) => {
      const erro = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      if (sinal.aborted) rejeitar(erro);
      else sinal.addEventListener("abort", () => rejeitar(erro), { once: true });
    });
  })());
}

function opcoesDaUltimaChamada(): Record<string, any> {
  const chamada = queryMock.mock.calls.at(-1);
  if (!chamada) throw new Error("query() não foi chamado");
  return chamada[0].options;
}

async function criarConversa(adapter: ClaudeSdkAdapter, extra: { conversationId?: string } = {}) {
  return adapter.conversationRuntime.create({
    ...extra,
    workspaceId: WORKSPACE,
    workspacePath: ambiente.workspacePath,
    model: "default",
    homeDir: ambiente.homeDir,
    title: "Conversa de teste",
  });
}

describe("ClaudeSdkAdapter — identidade e registro", () => {
  it("expõe manifesto válido com id claude-sdk e ConversationRuntime", () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    expect(adapter.engineId).toBe("claude-sdk");
    expect(adapter.manifest.engineId).toBe("claude-sdk");
    expect(adapter.manifest.supportsConversation).toBe(true);
    expect(adapter.conversationRuntime?.engineId).toBe("claude-sdk");
    expect(() => validateEngineCapabilityManifest(CLAUDE_SDK_MANIFEST)).not.toThrow();
  });

  it("installer e authenticator reaproveitam o driver e assinam com o engineId do adaptador", () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    expect(adapter.installer.engineId).toBe("claude-sdk");
    expect(adapter.authenticator.engineId).toBe("claude-sdk");
    expect(typeof adapter.installer.status).toBe("function");
    expect(typeof adapter.authenticator.status).toBe("function");
  });

  it("fica registrado no EngineRegistry sem mudar o motor padrão nem os demais", () => {
    expect(engineRegistry.getAdapter("claude-sdk")).toBeInstanceOf(ClaudeSdkAdapter);
    expect(engineRegistry.resolveAdapter("claude-sdk")).toBeInstanceOf(ClaudeSdkAdapter);
    expect(engineRegistry.resolveAdapter()).toBeInstanceOf(OpenCodeAdapter);
    expect(engineRegistry.resolveAdapter("claude-code").engineId).toBe("claude-code");
    // Diferente da etapa anterior: o driver delegador entra na lista de motores (UI), por isso aparece aqui.
    expect(engineRegistry.list().map((d) => d.id)).toContain("claude-sdk");
  });
});

describe("ClaudeSdkDriver", () => {
  it("aparece na lista de motores como conversacional, com instalação do Claude Code", async () => {
    const resumos = await engineRegistry.listSummaries(ambiente.homeDir, false);
    const sdkResumo = resumos.find((s) => s.id === "claude-sdk");
    expect(sdkResumo).toBeDefined();
    expect(sdkResumo?.supportsConversation).toBe(true);
    expect(typeof sdkResumo?.installed).toBe("boolean");
  });

  it("fetchLiveTokens devolve a identidade do motor claude-sdk, com a cota do login do Claude Code", async () => {
    const uso = await new ClaudeSdkDriver().fetchLiveTokens(ambiente.homeDir);
    expect(uso.motorId).toBe("claude-sdk");
    expect(uso.motorName).toBe("Claude Agent SDK");
  });

  it("prepara o agente como processo do runner do SDK, sem chave do shell e com caminhos do sandbox", async () => {
    const prep = await new ClaudeSdkDriver().prepareExecution({
      workspaceId: WORKSPACE,
      workspacePath: ambiente.workspacePath,
      sessionId: "s",
      agentId: "a",
      model: "claude-haiku-5-5",
      prompt: "faça algo",
      homeDir: ambiente.homeDir,
    });
    expect(prep.binary).toBe(process.execPath);
    expect(prep.args[0]).toMatch(/runners\/claude-sdk-cli\.js$/);
    expect(prep.args).toEqual(expect.arrayContaining(["--cwd", ambiente.workspacePath, "--model", "claude-haiku-5-5", "--claude-path", "--"]));
    expect(prep.args.at(-1)).toBe("faça algo");
    expect(prep.cwd).toBe(ambiente.workspacePath);
    expect(prep.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(prep.env.OPENCORP_SANDBOX_RW_BIND).toMatch(/\.claude/);
    expect(prep.env.OPENCORP_SANDBOX_RO_BIND).toContain("package.json");
  });
});

describe("ClaudeSdkAdapter — execução pontual (runner)", () => {
  it("chama query() com cwd, modelo, acceptEdits e AbortController, sem sessão", async () => {
    sdkRespondeCom(resultadoSucesso("ok"));

    await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada()));

    const chamada = queryMock.mock.calls.at(-1)![0];
    expect(chamada.prompt).toBe("Diga ok");
    const opcoes = chamada.options;
    expect(opcoes.cwd).toBe(ambiente.workspacePath);
    expect(opcoes.model).toBe("claude-haiku-5-5");
    expect(opcoes.permissionMode).toBe("acceptEdits");
    expect(opcoes.abortController).toBeInstanceOf(AbortController);
    expect(opcoes.sessionId).toBeUndefined();
    expect(opcoes.resume).toBeUndefined();
  });

  it("nega aprovações explicitamente: execução pontual não tem canal de resposta", async () => {
    // Antes desta etapa canUseTool não era passado e valia o padrão do SDK. Agora a negação é explícita.
    sdkRespondeCom(resultadoSucesso("ok"));
    await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada()));

    const decisao = await opcoesDaUltimaChamada().canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
    expect(decisao.behavior).toBe("deny");
  });

  it("não usa ANTHROPIC_API_KEY do shell (login local) e desliga a telemetria", async () => {
    const anterior = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "chave-de-teste-nao-real";
    try {
      sdkRespondeCom(resultadoSucesso("ok"));
      await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada()));

      const env = opcoesDaUltimaChamada().env as Record<string, string>;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_DISABLE_TELEMETRY).toBe("1");
    } finally {
      if (anterior === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = anterior;
    }
  });

  it("emite run.started primeiro e run.completed com saída e uso acumulado", async () => {
    sdkRespondeCom(assistente({ type: "text", text: "ok" }), resultadoSucesso("ok"));

    const eventos = await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada()));

    expect(eventos.map((e) => e.type)).toEqual([
      "run.started",
      "message.delta",
      "usage.updated",
      "run.completed",
    ]);
    expect(eventos[0]).toMatchObject({ type: "run.started", runId: "run-teste", engineId: "claude-sdk" });

    const concluido = eventos.at(-1) as Extract<AgentEvent, { type: "run.completed" }>;
    expect(concluido.result.output).toBe("ok");
    expect(concluido.result.stopReason).toBe("completed");
    // promptTokens inclui cache: (10+100+20) + (3+0+0); completionTokens: 5+7.
    expect(concluido.result.usage).toEqual({
      promptTokens: 133,
      completionTokens: 12,
      totalTokens: 145,
      costUsd: 0.002,
    });
  });
});

describe("traduzirMensagemSdk", () => {
  const estadoNovo = () => ({
    runId: "r1",
    engineId: "claude-sdk",
    modelId: "claude-haiku-5-5",
    output: "",
    nomesFerramentas: new Map<string, string>(),
  });

  it("traduz tool_use e tool_result com o nome da ferramenta correspondente", () => {
    const estado = estadoNovo();
    const pedido = traduzirMensagemSdk(
      assistente({ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.md" } }),
      estado
    );
    const resposta = traduzirMensagemSdk(usuarioComResultado("t1", "conteúdo"), estado);

    expect(pedido).toEqual([
      {
        type: "tool.requested",
        runId: "r1",
        call: { id: "t1", name: "Read", arguments: { file_path: "a.md" } },
        timestamp: expect.any(String),
      },
    ]);
    expect(resposta).toEqual([
      {
        type: "tool.completed",
        runId: "r1",
        result: { id: "t1", name: "Read", result: "conteúdo", isError: false },
        timestamp: expect.any(String),
      },
    ]);
  });

  it("marca tool_result com is_error e usa 'desconhecida' quando o tool_use não foi visto", () => {
    const eventos = traduzirMensagemSdk(usuarioComResultado("x9", "negado", true), estadoNovo());
    expect(eventos[0]).toMatchObject({
      type: "tool.completed",
      result: { id: "x9", name: "desconhecida", isError: true },
    });
  });

  it("result com is_error vira run.failed com erro normalizado (auth)", () => {
    const eventos = traduzirMensagemSdk(
      sdk({ type: "result", subtype: "success", is_error: true, result: "invalid token", total_cost_usd: 0, modelUsage: {} }),
      estadoNovo()
    );
    expect(eventos).toHaveLength(1);
    expect(eventos[0].type).toBe("run.failed");
    const erro = (eventos[0] as Extract<AgentEvent, { type: "run.failed" }>).error;
    expect(erro).toBeInstanceOf(EngineError);
    expect(erro.code).toBe("ENGINE_AUTH_REQUIRED");
  });

  it("result de erro de execução usa errors e vira ENGINE_UNAVAILABLE", () => {
    const eventos = traduzirMensagemSdk(
      sdk({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["falha de rede"],
        total_cost_usd: 0,
        modelUsage: {},
      }),
      estadoNovo()
    );
    const erro = (eventos[0] as Extract<AgentEvent, { type: "run.failed" }>).error;
    expect(erro.code).toBe("ENGINE_UNAVAILABLE");
    expect(erro.message).toContain("falha de rede");
  });
});

describe("ClaudeSdkAdapter — falhas e cancelamento na execução pontual", () => {
  it("erro de conta inexistente falha antes de chamar query()", async () => {
    const eventos = await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada({ accountId: "conta-inexistente" })));

    expect(queryMock).not.toHaveBeenCalled();
    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.failed" }>;
    expect(ultimo.type).toBe("run.failed");
    expect(ultimo.error.code).toBe("ENGINE_AUTH_REQUIRED");
  });

  it("exceção do SDK vira run.failed normalizado", async () => {
    queryMock.mockImplementation(() => (async function* () {
      throw new Error("boom");
    })());

    const eventos = await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada()));

    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.failed" }>;
    expect(ultimo.type).toBe("run.failed");
    expect(ultimo.error.code).toBe("ENGINE_UNAVAILABLE");
    expect(ultimo.error.message).toContain("boom");
  });

  it("fim do stream sem resultado final vira run.failed", async () => {
    sdkRespondeCom(assistente({ type: "text", text: "parcial" }));

    const eventos = await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada()));

    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.failed" }>;
    expect(ultimo.type).toBe("run.failed");
    expect(ultimo.error.message).toContain("sem resultado final");
  });

  it("timeoutMs aborta o query() e termina com run.completed stopReason 'timeout'", async () => {
    sdkPresoAteAbortar();

    const eventos = await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada({ timeoutMs: 30 })));

    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.completed" }>;
    expect(ultimo.type).toBe("run.completed");
    expect(ultimo.result.stopReason).toBe("timeout");
    expect(opcoesDaUltimaChamada().abortController.signal.aborted).toBe(true);
    expect(eventos.some((e) => e.type === "run.failed")).toBe(false);
  });

  it("AbortSignal cancela o query() e termina com run.completed stopReason 'cancelled'", async () => {
    sdkPresoAteAbortar();
    const controle = new AbortController();
    const fluxo = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada(), controle.signal)[Symbol.asyncIterator]();

    const inicio = await fluxo.next();
    expect(inicio.value).toMatchObject({ type: "run.started" });
    controle.abort();

    const eventos: AgentEvent[] = [];
    for (let passo = await fluxo.next(); !passo.done; passo = await fluxo.next()) eventos.push(passo.value);

    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.completed" }>;
    expect(ultimo.type).toBe("run.completed");
    expect(ultimo.result.stopReason).toBe("cancelled");
    expect(eventos.some((e) => e.type === "run.failed")).toBe(false);
  });

  it("signal já abortado antes da chamada não chega a iniciar o query() preso", async () => {
    sdkPresoAteAbortar();
    const controle = new AbortController();
    controle.abort();

    const eventos = await coletar(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }).runner.run(entrada(), controle.signal));

    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.completed" }>;
    expect(ultimo.result.stopReason).toBe("cancelled");
  });
});

describe("ClaudeSdkAdapter — conversa (ConversationRuntime)", () => {
  it("cria conversa com id UUID, mesmo quando o pedido traz id que não é UUID", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter, { conversationId: "sessao-nao-uuid" });

    expect(ref.id).toMatch(UUID_RE);
    expect(ref).toEqual({ id: ref.id, engineId: "claude-sdk", workspaceId: WORKSPACE });
  });

  it("primeiro turno cria a sessão com o id da conversa; os seguintes retomam com resume", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter);
    queryMock.mockImplementation((params: { options: { sessionId?: string; resume?: string } }) => (async function* () {
      yield inicializacao(params.options.sessionId ?? params.options.resume ?? "");
      yield resultadoSucesso("ok");
    })());

    await coletar(adapter.conversationRuntime.send(ref, { text: "primeiro" }));
    await coletar(adapter.conversationRuntime.send(ref, { text: "segundo" }));

    const [primeiro, segundo] = queryMock.mock.calls.map((c) => c[0].options);
    expect(primeiro.sessionId).toBe(ref.id);
    expect(primeiro.resume).toBeUndefined();
    expect(segundo.resume).toBe(ref.id);
    expect(segundo.sessionId).toBeUndefined();
    expect(primeiro.model).toBeUndefined(); // "default" vira modelo padrão do SDK
  });

  it("a conversa sobrevive a um novo adaptador com o mesmo home (reinício)", async () => {
    const ref = await criarConversa(new ClaudeSdkAdapter({ homeDir: ambiente.homeDir }));

    const reiniciado = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const estado = await reiniciado.conversationRuntime.resume(ref);

    expect(estado.status).toBe("idle");
    expect(estado.metadata).toMatchObject({ nativeSessionId: ref.id, title: "Conversa de teste" });
  });

  it("pergunta por aprovação e segue a decisão recebida pelo respondApproval", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter);
    let decisaoRecebida: unknown;
    queryMock.mockImplementation((params: { options: { canUseTool: any } }) => (async function* () {
      decisaoRecebida = await params.options.canUseTool("Bash", { command: "npm test" }, { signal: new AbortController().signal });
      yield resultadoSucesso(decisaoRecebida && (decisaoRecebida as { behavior: string }).behavior === "allow" ? "permitido" : "negado");
    })());

    const eventos: AgentEvent[] = [];
    const turno = (async () => {
      for await (const ev of adapter.conversationRuntime.send(ref, { text: "rode os testes" })) eventos.push(ev);
    })();

    const pedido = (await esperarEvento(eventos, "approval.requested")) as Extract<AgentEvent, { type: "approval.requested" }>;
    expect(pedido.approval.action).toBe("Bash");
    expect(pedido.approval.description).toContain("npm test");

    expect(await adapter.conversationRuntime.respondApproval!(pedido.approval.id, "approve", { workspaceId: WORKSPACE })).toBe(true);
    await turno;

    expect(decisaoRecebida).toEqual({ behavior: "allow", updatedInput: { command: "npm test" } });
    const concluido = eventos.at(-1) as Extract<AgentEvent, { type: "run.completed" }>;
    expect(concluido.result.output).toBe("permitido");
  });

  it("rejeitar uma aprovação nega a ferramenta", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter);
    let decisaoRecebida: any;
    queryMock.mockImplementation((params: { options: { canUseTool: any } }) => (async function* () {
      decisaoRecebida = await params.options.canUseTool("Edit", { file_path: "/tmp/x.md" }, { signal: new AbortController().signal });
      yield resultadoSucesso("negado");
    })());

    const eventos: AgentEvent[] = [];
    const turno = (async () => {
      for await (const ev of adapter.conversationRuntime.send(ref, { text: "edite" })) eventos.push(ev);
    })();
    const pedido = (await esperarEvento(eventos, "approval.requested")) as Extract<AgentEvent, { type: "approval.requested" }>;
    expect(pedido.approval.description).toContain("/tmp/x.md");

    await adapter.conversationRuntime.respondApproval!(pedido.approval.id, "reject", { workspaceId: WORKSPACE });
    await turno;

    expect(decisaoRecebida.behavior).toBe("deny");
  });

  it("respondApproval de outro workspace não responde a aprovação", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter);
    queryMock.mockImplementation((params: { options: { canUseTool: any } }) => (async function* () {
      await params.options.canUseTool("Bash", { command: "ls" }, { signal: new AbortController().signal });
      yield resultadoSucesso("ok");
    })());

    const eventos: AgentEvent[] = [];
    const turno = (async () => {
      for await (const ev of adapter.conversationRuntime.send(ref, { text: "liste" })) eventos.push(ev);
    })();
    const pedido = (await esperarEvento(eventos, "approval.requested")) as Extract<AgentEvent, { type: "approval.requested" }>;

    expect(await adapter.conversationRuntime.respondApproval!(pedido.approval.id, "approve", { workspaceId: "outro-ws" })).toBe(false);
    expect(await adapter.conversationRuntime.respondApproval!(pedido.approval.id, "approve", { workspaceId: WORKSPACE })).toBe(true);
    await turno;
  });

  it("close interrompe o turno ativo com stopReason 'cancelled' e a conversa fica fechada", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter);
    sdkPresoAteAbortar();

    const eventos: AgentEvent[] = [];
    const turno = (async () => {
      for await (const ev of adapter.conversationRuntime.send(ref, { text: "espere" })) eventos.push(ev);
    })();
    await esperarEvento(eventos, "run.started");
    await adapter.conversationRuntime.close(ref);
    await turno;

    const concluido = eventos.at(-1) as Extract<AgentEvent, { type: "run.completed" }>;
    expect(concluido.result.stopReason).toBe("cancelled");
    expect((await adapter.conversationRuntime.resume(ref)).status).toBe("closed");
  });

  it("enviar para conversa desconhecida ou fechada falha sem chamar o SDK", async () => {
    const adapter = new ClaudeSdkAdapter({ homeDir: ambiente.homeDir });
    const ref = await criarConversa(adapter);
    await adapter.conversationRuntime.close(ref);

    const eventos = await coletar(adapter.conversationRuntime.send(ref, { text: "oi" }));

    expect(queryMock).not.toHaveBeenCalled();
    const ultimo = eventos.at(-1) as Extract<AgentEvent, { type: "run.failed" }>;
    expect(ultimo.type).toBe("run.failed");
    expect(ultimo.error.message).toContain("não encontrada");
  });
});
