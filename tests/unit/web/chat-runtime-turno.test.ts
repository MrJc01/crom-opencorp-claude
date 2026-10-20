import { afterEach, describe, expect, it, vi } from "vitest";
import { executarTurno } from "../../../src/web/features/chat/runtime/turno-stream.js";
import { partesDoEstado } from "../../../src/web/features/chat/runtime/sse-reducer.js";

function respostaSse(pedacos: string[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const p of pedacos) c.enqueue(enc.encode(p));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
}

afterEach(() => vi.unstubAllGlobals());

describe("executarTurno", () => {
  it("consome SSE fragmentado, promove a sessão e emite estados acumulados", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      respostaSse([
        'event: inicio\ndata: {"sessao_id":"ses_9"}\n\nevent: del',
        'ta\ndata: {"delta":"Oi"}\n\nevent: aprovacao\ndata: {"id":"p1","acao":"fileChange"}\n\n',
        'event: fim\ndata: {}\n\n',
      ]),
    ));
    const ref = { current: undefined as string | undefined };
    const onSessaoCriada = vi.fn();
    let ultimo;
    for await (const e of executarTurno({
      texto: "oi",
      opcoes: { workspaceId: "ws", onSessaoCriada },
      sessaoIdRef: ref,
      signal: new AbortController().signal,
    })) ultimo = e;
    expect(ref.current).toBe("ses_9");
    expect(onSessaoCriada).toHaveBeenCalledWith("ses_9");
    const partes = partesDoEstado(ultimo!, true);
    expect(partes.map((p) => p.type)).toEqual(["tool-call", "text"]);
    expect(partes[0].args).toMatchObject({ id: "p1", status: "pendente" });
  });

  it("HTTP de erro vira mensagem de aviso e chama onErro", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ title: "Falhou", detail: "x" }), { status: 500 })));
    const onErro = vi.fn();
    const estados = [];
    for await (const e of executarTurno({
      texto: "oi",
      opcoes: { onErro },
      sessaoIdRef: { current: undefined },
      signal: new AbortController().signal,
    })) estados.push(e);
    expect(onErro).toHaveBeenCalled();
    expect(estados[0]!.texto).toContain("Falhou");
  });
});
