import { describe, expect, it } from "vitest";
import { aplicarEventoSse, criarEstadoTurno, partesDoEstado } from "../../../src/web/features/chat/runtime/sse-reducer.js";
import {
  criarMensagemAssistente,
  marcarAprovacao,
  podeSubstituirPeloServidor,
  atualizarMensagem,
} from "../../../src/web/features/chat/runtime/chat-store.js";
import { converterMensagensBackend } from "../../../src/web/features/chat/runtime/message-converter.js";
import { parsearBlocoSse, separarBlocosSse } from "../../../src/web/lib/chat/secretary-stream.js";

describe("sse-reducer", () => {
  it("acumula inicio, delta, acao, aprovacao e fim", () => {
    const e = criarEstadoTurno();
    expect(aplicarEventoSse(e, "inicio", { sessao_id: " ses_1 " }, "ws").sessaoId).toBe("ses_1");
    expect(partesDoEstado(e)[0].text).toContain("Processando");
    aplicarEventoSse(e, "delta", { delta: "<think>hm</think>Olá" }, "ws");
    aplicarEventoSse(e, "acao", { itens: [{ ferramenta: "Bash", resumo: "ls", status: "running" }] }, "ws");
    aplicarEventoSse(e, "aprovacao", { id: "a1", acao: "commandExecution", descricao: "rm x" }, "ws");
    aplicarEventoSse(e, "aprovacao", { id: "a1" }, "ws");
    aplicarEventoSse(e, "fim", {}, "ws");
    const partes = partesDoEstado(e, true);
    expect(partes.map((p) => p.type)).toEqual(["reasoning", "tool-call", "tool-call", "text"]);
    expect(partes[2].args).toMatchObject({ id: "a1", workspace: "ws", status: "pendente" });
    expect(partes[3].text).toBe("Olá");
  });

  it("fim com resposta genérica vira aviso de modelo sem texto; erro anexa mensagem", () => {
    const e = criarEstadoTurno();
    aplicarEventoSse(e, "fim", { resposta: "Ação concluída." }, "ws");
    expect(e.texto).toContain("não retornou texto");
    aplicarEventoSse(e, "erro", { erro: "boom" }, "ws");
    expect(e.texto).toContain("⚠️ boom");
  });
});

describe("chat-store", () => {
  const hist = converterMensagensBackend(
    [
      { id: "u1", role: "user", content: "oi" },
      { id: "a1", role: "assistant", content: "ok", aprovacoes: [{ id: "x", status: "pendente" }, { id: "y", status: "aprovado" }] },
    ],
    "s",
  );

  it("marcarAprovacao muda só a aprovação alvo e preserva identidade do resto", () => {
    const novo = marcarAprovacao(hist, "x", "rejeitado");
    expect(novo[0]).toBe(hist[0]);
    const tools = (novo[1]!.content as any[]).filter((p) => p.type === "tool-call");
    expect(tools.find((p) => p.toolCallId === "aprovacao_x").args.status).toBe("rejeitado");
    expect(tools.find((p) => p.toolCallId === "aprovacao_y").args.status).toBe("aprovado");
    expect(marcarAprovacao(novo, "x", "rejeitado")).toEqual(novo);
  });

  it("histórico recarregado só substitui sem turno em curso e sem perder mensagens", () => {
    expect(podeSubstituirPeloServidor(hist, hist, false)).toBe(true);
    expect(podeSubstituirPeloServidor(hist, hist, true)).toBe(false);
    expect(podeSubstituirPeloServidor(hist, hist.slice(0, 1), false)).toBe(false);
    expect(podeSubstituirPeloServidor(hist, [], false)).toBe(false);
  });

  it("atualizarMensagem altera apenas o id pedido", () => {
    const a = criarMensagemAssistente("n");
    const [r] = atualizarMensagem([a], "n", { status: { type: "complete", reason: "stop" } } as any);
    expect(r!.status).toEqual({ type: "complete", reason: "stop" });
  });
});

describe("blocos SSE", () => {
  it("separa blocos completos e guarda o resto", () => {
    const { blocos, resto } = separarBlocosSse('event: delta\ndata: {"a":1}\n\nevent: fim\ndata: {');
    expect(blocos).toHaveLength(1);
    expect(parsearBlocoSse(blocos[0]!)).toEqual({ evento: "delta", dados: '{"a":1}' });
    expect(resto).toContain("event: fim");
    expect(parsearBlocoSse(": ping")).toBeNull();
  });
});

describe("sequência sem delta (inicio → acao → aprovacao)", () => {
  it("produz assistente com tool-call e aprovação pendente antes de qualquer texto", () => {
    const e = criarEstadoTurno();
    aplicarEventoSse(e, "inicio", { sessao_id: "s1" }, "ws");
    aplicarEventoSse(e, "acao", { itens: [{ ferramenta: "Bash", resumo: "touch x", status: "running" }] }, "ws");
    aplicarEventoSse(e, "aprovacao", { id: "ap1", acao: "commandExecution", descricao: "touch x" }, "ws");
    const partes = partesDoEstado(e);
    expect(partes.map((p) => p.type)).toEqual(["tool-call", "tool-call", "text"]);
    expect(partes[0].toolName).toBe("Bash");
    expect(partes[1]).toMatchObject({ toolName: "aprovacao_motor", args: { id: "ap1", status: "pendente" } });
  });
});

describe("live-turns", () => {
  it("instância remontada adota o turno vivo e recebe as atualizações", async () => {
    const { publicarTurno, obterTurno, assinarTurno } = await import("../../../src/web/features/chat/runtime/live-turns.js");
    const origem = {};
    const recebidos: boolean[] = [];
    const off = assinarTurno("s9", (t) => recebidos.push(t.running));
    publicarTurno("s9", { messages: [], running: true, origem, abort: () => {} });
    expect(obterTurno("s9")?.running).toBe(true);
    publicarTurno("s9", { messages: [], running: false, origem, abort: () => {} });
    expect(obterTurno("s9")).toBeUndefined();
    expect(recebidos).toEqual([true, false]);
    off();
  });
});

describe("recarga do servidor não regride a resposta", () => {
  it("não substitui se a última resposta do servidor está mais curta que a local", () => {
    const local = converterMensagensBackend([{ id: "u", role: "user", content: "x" }, { id: "a", role: "assistant", content: "resposta longa com opções" }], "s");
    const servidor = converterMensagensBackend([{ id: "u", role: "user", content: "x" }, { id: "a", role: "assistant", content: "" }], "s");
    expect(podeSubstituirPeloServidor(local, servidor, false)).toBe(false);
    expect(podeSubstituirPeloServidor(servidor, local, false)).toBe(true);
  });
});
