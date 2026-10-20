import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, type EntradaLog } from "../src/core/engines/event-log.js";

const delta = (text: string, t = "2026-01-01T00:00:00Z"): EntradaLog => ({
  t,
  tipo: "evento",
  ev: { type: "message.delta", runId: "r", text },
});

describe("EventLog.assinar (reattach)", () => {
  let home: string;
  let log: EventLog;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "evlog-assinar-"));
    log = new EventLog(home);
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it("aciona o assinante a cada anexar, com o índice da entrada no log", async () => {
    await log.anexar("ws", "s", { t: "t", tipo: "user", text: "oi" });
    const vistos: Array<[string, number]> = [];
    const cancelar = log.assinar("ws", "s", (e, i) => vistos.push([e.tipo === "evento" && e.ev.type === "message.delta" ? e.ev.text : e.tipo, i]));
    await log.anexar("ws", "s", delta("a"));
    await log.anexar("ws", "s", delta("b"));
    expect(vistos).toEqual([["a", 1], ["b", 2]]);
    cancelar();
    await log.anexar("ws", "s", delta("c"));
    expect(vistos).toHaveLength(2);
  });

  it("é compartilhado entre instâncias de EventLog do mesmo home e isola conversas", async () => {
    const recebidos: number[] = [];
    const outras: number[] = [];
    const c1 = log.assinar("ws", "s", (_e, i) => recebidos.push(i));
    const c2 = log.assinar("ws", "outra", (_e, i) => outras.push(i));
    await new EventLog(home).anexar("ws", "s", delta("x"));
    expect(recebidos).toEqual([0]);
    expect(outras).toEqual([]);
    c1();
    c2();
  });

  it("dispara também em registrarAprovacaoResolvida", async () => {
    await log.anexar("ws", "s", {
      t: "t",
      tipo: "evento",
      ev: { type: "approval.requested", runId: "r", approval: { id: "ap1", action: "Bash", description: "ls" } },
    });
    const tipos: string[] = [];
    const cancelar = log.assinar("ws", "s", (e) => tipos.push(e.tipo === "evento" ? e.ev.type : e.tipo));
    expect(await log.registrarAprovacaoResolvida("ws", "ap1", "approved")).toBe(true);
    expect(tipos).toEqual(["approval.resolved"]);
    cancelar();
  });

  it("anexares concorrentes mantêm ordem do arquivo e índices consecutivos", async () => {
    const indices: number[] = [];
    const cancelar = log.assinar("ws", "s", (_e, i) => indices.push(i));
    await Promise.all(["a", "b", "c", "d"].map((x) => log.anexar("ws", "s", delta(x))));
    expect(indices).toEqual([0, 1, 2, 3]);
    expect((await log.ler("ws", "s")).length).toBe(4);
    cancelar();
  });

  it("reenvio sem perder nem duplicar: assina, lê o backlog e descarta índices já enviados", async () => {
    await log.anexar("ws", "s", delta("0"));
    await log.anexar("ws", "s", delta("1"));
    await log.anexar("ws", "s", delta("2"));
    const desde = 1;
    let proximo = desde;
    const enviados: string[] = [];
    const emitir = (e: EntradaLog, i: number): void => {
      if (i < proximo) return;
      proximo = i + 1;
      if (e.tipo === "evento" && e.ev.type === "message.delta") enviados.push(e.ev.text);
    };
    const fila: Array<[EntradaLog, number]> = [];
    const cancelar = log.assinar("ws", "s", (e, i) => fila.push([e, i]));
    // uma entrada chega enquanto o backlog ainda está sendo lido
    const gravando = log.anexar("ws", "s", delta("3"));
    const backlog = await log.ler("ws", "s");
    await gravando;
    await log.anexar("ws", "s", delta("4"));
    backlog.forEach((e, i) => emitir(e, i));
    fila.sort((a, b) => a[1] - b[1]).forEach(([e, i]) => emitir(e, i));
    expect(enviados).toEqual(["1", "2", "3", "4"]);
    cancelar();
  });

  it("encerrarTurno avisa os assinantes depois das entradas em voo; cancelar não deixa listeners", async () => {
    const ordem: string[] = [];
    const cancelar = log.assinar("ws", "s", {
      entrada: () => ordem.push("entrada"),
      fimTurno: () => ordem.push("fim"),
    });
    const g = log.anexar("ws", "s", delta("x"));
    await log.encerrarTurno("ws", "s");
    await g;
    expect(ordem).toEqual(["entrada", "fim"]);
    cancelar();
    await log.encerrarTurno("ws", "s");
    expect(ordem).toEqual(["entrada", "fim"]);
  });
});
