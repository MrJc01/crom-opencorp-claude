import { afterEach, describe, expect, it, vi } from "vitest";
import { estadoDaMensagemBackend, reassinarTurno } from "../../../src/web/features/chat/runtime/reassinar.js";
import { buscarHistoricoComMeta } from "../../../src/web/features/chat/runtime/history-client.js";
import { aplicarEventoSse, criarEstadoTurno, partesDoEstado } from "../../../src/web/features/chat/runtime/sse-reducer.js";
import { marcarAprovacao } from "../../../src/web/features/chat/runtime/chat-store.js";
import { converterMensagensBackend } from "../../../src/web/features/chat/runtime/message-converter.js";

const enc = new TextEncoder();
const sse = (evento: string, dados: unknown) => `event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`;

function resposta(pedacos: string[], aoCancelar?: () => void): Response {
  const corpo = new ReadableStream({
    start(c) {
      for (const p of pedacos) c.enqueue(enc.encode(p));
      c.close();
    },
    cancel: aoCancelar,
  });
  return new Response(corpo, { status: 200 });
}

/** Stream que nunca fecha sozinho: simula turno vivo esperando aprovação. */
function respostaAberta(pedacos: string[], aoCancelar: () => void): Response {
  return new Response(
    new ReadableStream({
      start(c) {
        for (const p of pedacos) c.enqueue(enc.encode(p));
      },
      cancel: aoCancelar,
    }),
    { status: 200 },
  );
}

afterEach(() => vi.unstubAllGlobals());

const bruta = {
  id: "a1",
  role: "assistant",
  content: "Vou editar",
  pensamento: "pensando",
  acoes: [{ ferramenta: "Bash", resumo: "ls", sucesso: true }],
  aprovacoes: [{ id: "p1", acao: "fileChange", workspace: "ws", status: "pendente" }],
};

describe("reducer — eventos do reattach", () => {
  it("aprovacao_resolvida atualiza o cartão; inativo/fim/erro marcam término", () => {
    const e = estadoDaMensagemBackend(bruta);
    aplicarEventoSse(e, "aprovacao", { id: "p1" }, "ws");
    expect(e.aprovacoes).toHaveLength(1);
    aplicarEventoSse(e, "aprovacao_resolvida", { id: "p1", status: "aprovado" }, "ws");
    expect(e.aprovacoes[0]!.status).toBe("aprovado");
    aplicarEventoSse(e, "aprovacao_resolvida", { id: "inexistente", status: "aprovado" }, "ws");
    aplicarEventoSse(e, "aprovacao_resolvida", { id: "p1", status: "lixo" }, "ws");
    expect(e.aprovacoes[0]!.status).toBe("aprovado");
    expect(aplicarEventoSse(e, "inativo", {}, "ws").terminou).toBe(true);
    expect(aplicarEventoSse(criarEstadoTurno(), "fim", {}, "ws").terminou).toBe(true);
    expect(aplicarEventoSse(criarEstadoTurno(), "erro", { erro: "x" }, "ws").terminou).toBe(true);
    expect(aplicarEventoSse(criarEstadoTurno(), "delta", { delta: "a" }, "ws").terminou).toBeUndefined();
  });

  it("estado semeado do histórico continua a mesma mensagem e preserva o cartão pendente", () => {
    const e = estadoDaMensagemBackend(bruta);
    aplicarEventoSse(e, "delta", { delta: " agora" }, "ws");
    const partes = partesDoEstado(e, true);
    expect(partes.map((p) => p.type)).toEqual(["reasoning", "tool-call", "tool-call", "text"]);
    expect(partes[2].args).toMatchObject({ id: "p1", status: "pendente" });
    expect(partes[3].text).toBe("Vou editar agora");
  });

  it("decisão local no store sobrevive e o status resolvido é refletido nas partes", () => {
    const msgs = converterMensagensBackend([bruta], "s");
    const marcadas = marcarAprovacao(msgs, "p1", "aprovado");
    const card = (marcadas[0]!.content as any[]).find((p) => p.toolCallId === "aprovacao_p1");
    expect(card.args.status).toBe("aprovado");
  });
});

describe("buscarHistoricoComMeta", () => {
  it("lê x-oc-log-entradas e x-oc-em-execucao", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify([bruta]), { status: 200, headers: { "x-oc-log-entradas": "7", "x-oc-em-execucao": "1" } }),
    ));
    const h = await buscarHistoricoComMeta("s1", "ws");
    expect(h).toMatchObject({ logEntradas: 7, emExecucao: true });
    expect(h!.mensagens).toHaveLength(1);
  });

  it("servidor antigo (sem cabeçalhos): emExecucao=false e logEntradas indefinido", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    const h = await buscarHistoricoComMeta("s1", "ws");
    expect(h).toMatchObject({ emExecucao: false, logEntradas: undefined });
  });

  it("erro HTTP devolve null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x", { status: 500 })));
    expect(await buscarHistoricoComMeta("s1")).toBeNull();
  });
});

describe("reassinarTurno", () => {
  const base = (signal: AbortSignal) => ({
    sessaoId: "s 1",
    opcoes: { workspaceId: "ws" },
    desde: 5,
    estadoInicial: () => estadoDaMensagemBackend(bruta),
    signal,
  });

  it("pede /eventos com workspace e desde, ignora duplicado e termina em fim", async () => {
    const f = vi.fn(async () =>
      resposta([
        sse("aprovacao", { id: "p1" }),
        sse("aprovacao_resolvida", { id: "p1", status: "aprovado" }),
        sse("del", {}).slice(0, 6),
        "ta\n\n",
        sse("delta", { delta: " pronto" }),
        sse("fim", {}),
        sse("delta", { delta: " NUNCA" }),
      ]),
    );
    vi.stubGlobal("fetch", f);
    let ultimo;
    for await (const e of reassinarTurno(base(new AbortController().signal))) ultimo = e;
    const url = String((f.mock.calls[0] as any)[0]);
    expect(url).toContain("/secretario/sessoes/s%201/eventos?");
    expect(url).toContain("workspace=ws");
    expect(url).toContain("desde=5");
    expect(ultimo!.texto).toBe("Vou editar pronto");
    expect(ultimo!.aprovacoes).toHaveLength(1);
    expect(ultimo!.aprovacoes[0]!.status).toBe("aprovado");
  });

  it("inativo encerra sem alterar o texto", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => resposta([sse("inativo", {})])));
    const estados = [];
    for await (const e of reassinarTurno(base(new AbortController().signal))) estados.push(e);
    expect(estados.at(-1)!.texto).toBe("Vou editar");
  });

  it("erro de rede: repete UMA vez recomeçando do estado inicial (sem duplicar) e não entra em loop", async () => {
    let n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("rede");
      return resposta([sse("delta", { delta: " ok" }), sse("fim", {})]);
    }));
    let ultimo;
    for await (const e of reassinarTurno(base(new AbortController().signal))) ultimo = e;
    expect(n).toBe(2);
    expect(ultimo!.texto).toBe("Vou editar ok");

    n = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { n++; throw new Error("rede"); }));
    const estados = [];
    for await (const e of reassinarTurno(base(new AbortController().signal))) estados.push(e);
    expect(n).toBe(2);
    expect(estados).toHaveLength(0);
  });

  it("HTTP de erro também conta como falha de rede (uma repetição)", async () => {
    const f = vi.fn(async () => new Response("x", { status: 502 }));
    vi.stubGlobal("fetch", f);
    for await (const _ of reassinarTurno(base(new AbortController().signal))) void _;
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("abortar (desmontar/trocar de sessão) cancela o corpo do SSE e para de emitir", async () => {
    const cancelado = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => respostaAberta([sse("delta", { delta: " a" })], cancelado)));
    const ac = new AbortController();
    const estados: string[] = [];
    const it = reassinarTurno(base(ac.signal));
    const primeiro = await it.next();
    estados.push(primeiro.value!.texto);
    ac.abort();
    const proximo = await it.next();
    expect(proximo.done).toBe(true);
    expect(cancelado).toHaveBeenCalled();
    expect(estados).toEqual(["Vou editar a"]);
  });
});
