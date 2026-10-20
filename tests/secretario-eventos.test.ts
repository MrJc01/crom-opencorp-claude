import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer, type ApiServerOptions } from "../src/server/index.js";
import { engineRegistry, type EngineAdapter, type ConversationRef, type AgentEvent } from "../src/core/engines/index.js";
import { streamsSecretarioAtivos } from "../src/server/routes/secretario/stream.js";
import { criarTradutorSse } from "../src/server/routes/secretario/sse-eventos.js";

interface EventoSse {
  evento: string;
  dados: any;
}

function parsear(texto: string): EventoSse[] {
  const saida: EventoSse[] = [];
  for (const bloco of texto.split("\n\n")) {
    const ev = /^event: (.+)$/m.exec(bloco)?.[1];
    const data = /^data: (.+)$/m.exec(bloco)?.[1];
    if (ev) saida.push({ evento: ev, dados: data ? JSON.parse(data) : undefined });
  }
  return saida;
}

/** Lê o corpo SSE até `ate(eventos)` ser verdadeiro (e então cancela) ou até o servidor fechar. */
async function lerSse(res: Response, ate?: (eventos: EventoSse[]) => boolean): Promise<{ eventos: EventoSse[]; fechou: boolean }> {
  const leitor = res.body!.getReader();
  const dec = new TextDecoder();
  let texto = "";
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) return { eventos: parsear(texto), fechou: true };
    texto += dec.decode(value, { stream: true });
    if (ate && ate(parsear(texto))) {
      await leitor.cancel();
      return { eventos: parsear(texto), fechou: false };
    }
  }
}

describe("Secretário: reattach (GET /secretario/sessoes/:id/eventos)", () => {
  let home: string;
  let token = "tok-eventos";
  let base: string;
  let server: ReturnType<typeof createApiServer>["server"];
  let liberarAprovacao: ((d: "approve" | "reject") => void) | undefined;
  let contador = 0;

  const adapter: EngineAdapter = {
    engineId: "mock-reattach",
    name: "Mock Reattach",
    manifest: {
      engineId: "mock-reattach",
      name: "Mock Reattach",
      transport: "embedded",
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
    },
    installer: {
      engineId: "mock-reattach",
      status: async () => ({ installed: true, isManaged: false, path: "/usr/bin/mock", version: "1.0.0" }),
      install: async () => ({ success: true, path: "/usr/bin/mock", version: "1.0.0", log: "" }),
    },
    authenticator: { engineId: "mock-reattach", status: async () => ({ authenticated: true, authType: "api_key" }) },
    runner: { engineId: "mock-reattach", run: async function* () {} },
    conversationRuntime: {
      engineId: "mock-reattach",
      create: async (input) => ({ id: input.conversationId || `reat-${++contador}`, engineId: "mock-reattach", workspaceId: input.workspaceId }),
      send: async function* (_ref: ConversationRef, _input, _signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const runId = "run-1";
        yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: "mock-reattach" };
        yield { type: "message.delta", runId, text: "antes " };
        yield { type: "tool.requested", runId, call: { id: "c1", name: "Bash", arguments: { command: "ls" } } };
        yield { type: "approval.requested", runId, approval: { id: "ap-reat", action: "Bash", description: "rodar ls" } };
        const decisao = await new Promise<"approve" | "reject">((r) => { liberarAprovacao = r; });
        yield { type: "tool.completed", runId, result: { id: "c1", name: "Bash", result: { ok: decisao === "approve" } } };
        yield { type: "message.delta", runId, text: "depois" };
        yield { type: "run.completed", runId, result: { output: "antes depois", stopReason: "completed" } };
      },
      resume: async (ref: ConversationRef) => ({ ref, status: "idle", lastActiveAt: new Date().toISOString() }),
      respondApproval: async (id, decisao) => {
        if (id !== "ap-reat" || !liberarAprovacao) return false;
        liberarAprovacao(decisao);
        return true;
      },
      close: async () => {},
    },
  };

  const api = (path: string, init: RequestInit = {}) =>
    fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers } });

  beforeAll(async () => {
    engineRegistry.registerAdapter(adapter);
    home = await mkdtemp(join(tmpdir(), "opencorp-secretario-eventos-"));
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await mkdir(join(home, "workspaces", "ws-reat", ".opencorp"), { recursive: true });
    await writeFile(join(home, "workspaces", "ws-reat", ".opencorp", "config.json"), JSON.stringify({ conversationEngineOverride: "mock-reattach" }));
    await writeFile(
      join(home, ".opencorp", "workspaces.json"),
      JSON.stringify({ version: 1, ativo: "ws-reat", workspaces: [{ id: "ws-reat", criado_em: new Date().toISOString(), path: join(home, "workspaces", "ws-reat") }] }),
    );
    const inst = createApiServer({ homeDir: home, token, instalarMencoes: false } as ApiServerOptions);
    server = inst.server;
    token = inst.token;
    server.listen(0, "127.0.0.1");
    base = `http://127.0.0.1:${await inst.porta}`;
  });

  afterAll(async () => {
    server?.close();
    await rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it("stream do turno continua emitindo inicio/delta/acao/aprovacao e, ao aprovar, delta/fim", async () => {
    const res = await api("/secretario/conversa/stream?workspace=ws-reat", { method: "POST", body: JSON.stringify({ mensagem: "oi" }) });
    const parte1 = await lerSse(res, (e) => e.some((x) => x.evento === "aprovacao"));
    const nomes = parte1.eventos.map((e) => e.evento);
    expect(nomes[0]).toBe("inicio");
    expect(nomes).toEqual(["inicio", "delta", "acao", "aprovacao"]);
    expect(parte1.eventos[2]!.dados.itens[0]).toMatchObject({ ferramenta: "Bash", resumo: "$ ls", status: "running" });
    expect(parte1.eventos[3]!.dados).toMatchObject({ id: "ap-reat", acao: "Bash", workspace: "ws-reat", motor: "mock-reattach" });
    // a decisão e o fim desta conversa são consumidos pelo teste de reattach abaixo (mesmo turno vivo)
    parte1.eventos.length = 0;
  });

  it("reattach: mensagens traz cabeçalhos, eventos reenvia desde N e acompanha ao vivo até o fim", async () => {
    const sessao = [...streamsSecretarioAtivos.keys()][0]!;
    expect(sessao).toMatch(/^reat-/);
    // o log é gravado em fila assíncrona: espera o pedido de aprovação aparecer
    let msgsRes!: Response;
    for (let i = 0; i < 50; i++) {
      msgsRes = await api(`/secretario/sessoes/${sessao}/mensagens?workspace=ws-reat`);
      if (Number(msgsRes.headers.get("x-oc-log-entradas")) >= 5) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(msgsRes.headers.get("x-oc-em-execucao")).toBe("1");
    expect(msgsRes.headers.get("access-control-expose-headers")).toContain("x-oc-log-entradas");
    const n = Number(msgsRes.headers.get("x-oc-log-entradas"));
    expect(Array.isArray(await msgsRes.json())).toBe(true);

    const completo = api(`/secretario/sessoes/${sessao}/eventos?workspace=ws-reat&desde=0`);
    const ao_vivo = api(`/secretario/sessoes/${sessao}/eventos?workspace=ws-reat&desde=${n}`);
    const [respCompleto, respVivo] = await Promise.all([completo, ao_vivo]);
    const leituraVivo = lerSse(respVivo);
    const leituraCompleto = lerSse(respCompleto);
    await new Promise((r) => setTimeout(r, 100));

    const dec = await api("/approvals/ap-reat/approve?workspace=ws-reat", { method: "POST", body: "{}" });
    expect(dec.status).toBe(200);

    const vivo = await leituraVivo;
    expect(vivo.fechou).toBe(true);
    const nomesVivo = vivo.eventos.map((e) => e.evento);
    expect(nomesVivo).toEqual(expect.arrayContaining(["aprovacao_resolvida", "delta", "fim"]));
    expect(nomesVivo.filter((x) => x === "fim")).toHaveLength(1);
    expect(nomesVivo.filter((x) => x === "aprovacao_resolvida")).toHaveLength(1);
    expect(nomesVivo).not.toContain("aprovacao");
    expect(vivo.eventos.find((e) => e.evento === "aprovacao_resolvida")!.dados).toEqual({ id: "ap-reat", status: "aprovado" });
    expect(vivo.eventos.find((e) => e.evento === "fim")!.dados.resposta).toContain("depois");

    const todos = (await leituraCompleto).eventos.map((e) => e.evento);
    expect(todos.slice(0, 3)).toEqual(["delta", "acao", "aprovacao"]);
    expect(todos[todos.length - 1]).toBe("fim");
    expect(nomesVivo[nomesVivo.length - 1]).toBe("fim");
    expect(todos).toContain("aprovacao");
    expect(todos.filter((x) => x === "fim")).toHaveLength(1);
    // sem duplicar: cada entrada do log aparece uma vez
    expect(todos.filter((x) => x === "aprovacao")).toHaveLength(1);
  });

  it("cancelar: com turno vivo aciona o abort do próprio turno (parar de quem reassinou), pela rota única de cancelar", async () => {
    let abortado = false;
    streamsSecretarioAtivos.set("sessao-cancelavel", { res: { destroyed: false, writableEnded: false }, cancelar: () => { abortado = true; } });
    try {
      const res = await api("/secretario/sessoes/sessao-cancelavel/cancelar?workspace=ws-reat", { method: "POST", body: "{}" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, cancelado: true });
      expect(abortado).toBe(true);
    } finally {
      streamsSecretarioAtivos.delete("sessao-cancelavel");
    }
  });

  it("sem turno vivo: event: inativo e fecha", async () => {
    const sessao = "reat-1";
    expect(streamsSecretarioAtivos.has(sessao)).toBe(false);
    const res = await api(`/secretario/sessoes/${sessao}/eventos?workspace=ws-reat&desde=999`);
    const { eventos, fechou } = await lerSse(res);
    expect(fechou).toBe(true);
    expect(eventos.map((e) => e.evento)).toEqual(["inativo"]);
  });
});

describe("criarTradutorSse", () => {
  it("traduz os mesmos eventos do stream e só emite aprovacao_resolvida quando pedido", () => {
    const evs: Array<[string, any]> = [];
    const comRes: Array<[string, any]> = [];
    const t = criarTradutorSse({ workspaceId: "w", motor: "m", sse: (e, d) => evs.push([e, d]) });
    const t2 = criarTradutorSse({ workspaceId: "w", motor: "m", sse: (e, d) => comRes.push([e, d]), incluirResolucoes: true });
    const resolvido: AgentEvent = { type: "approval.resolved", runId: "r", approvalId: "a", decision: "rejected" };
    t(resolvido);
    t2(resolvido);
    expect(evs).toEqual([]);
    expect(comRes).toEqual([["aprovacao_resolvida", { id: "a", status: "rejeitado" }]]);
  });
});
