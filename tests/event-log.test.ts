import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EventLog, reduzirHistorico } from "../src/core/engines/event-log.js";

describe("EventLog", () => {
  let home: string;
  let log: EventLog;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "evlog-"));
    log = new EventLog(home);
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  async function conversaComAprovacao() {
    await log.anexar("ws", "s1", { t: "2026-01-01T00:00:00Z", tipo: "user", text: "oi" });
    await log.anexar("ws", "s1", { t: "2026-01-01T00:00:01Z", tipo: "evento", ev: { type: "message.delta", runId: "r", text: "olá" } });
    await log.anexar("ws", "s1", {
      t: "2026-01-01T00:00:02Z",
      tipo: "evento",
      ev: { type: "approval.requested", runId: "r", approval: { id: "ap1", action: "Bash", description: "rodar ls" } },
    });
  }

  it("reconstrói histórico com aprovação pendente enquanto o stream está ativo", async () => {
    await conversaComAprovacao();
    const msgs = reduzirHistorico(await log.ler("ws", "s1"), true);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content).toBe("olá");
    expect(msgs[1]!.aprovacoes![0]!.status).toBe("pendente");
  });

  it("aprovação sem stream ativo vira expirada", async () => {
    await conversaComAprovacao();
    expect(reduzirHistorico(await log.ler("ws", "s1"), false)[1]!.aprovacoes![0]!.status).toBe("expirada");
  });

  it("registra a decisão e o histórico mostra aprovado, sem pedir aprovar de novo", async () => {
    await conversaComAprovacao();
    expect(await log.registrarAprovacaoResolvida("ws", "ap1", "approved")).toBe(true);
    expect(reduzirHistorico(await log.ler("ws", "s1"), false)[1]!.aprovacoes![0]!.status).toBe("aprovado");
  });

  it("decisão de aprovação desconhecida devolve false", async () => {
    expect(await log.registrarAprovacaoResolvida("ws", "nada", "rejected")).toBe(false);
  });

  it("ferramenta termina com status e sucesso corretos", () => {
    const msgs = reduzirHistorico(
      [
        { t: "t", tipo: "user", text: "x" },
        { t: "t", tipo: "evento", ev: { type: "tool.requested", runId: "r", call: { id: "c1", name: "Read", arguments: {} } }, resumo: "ler a.ts" },
        { t: "t", tipo: "evento", ev: { type: "tool.completed", runId: "r", result: { id: "c1", name: "Read", result: "", isError: true } } },
      ],
      false,
    );
    expect(msgs[1]!.acoes![0]).toMatchObject({ resumo: "ler a.ts", status: "failed", sucesso: false });
  });
});
