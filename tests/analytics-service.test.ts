import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { OpencorpDb } from "../src/core/db/opencorp-db.js";
import { coletarAnalytics, JANELAS_ANALYTICS_MS } from "../src/core/contexts/analytics/analytics-service.js";

const raizes: string[] = [];
const AGORA = Date.UTC(2026, 9, 24, 15, 0, 0);
const HORA = 3_600_000;

async function novoWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-analytics-"));
  raizes.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("coletarAnalytics", () => {
  it("soma execuções, falhas, custo, tarefas e notificações de cada workspace e junta os totais", async () => {
    const a = await novoWorkspace();
    const dbA = new OpencorpDb(a);
    dbA.criarSessao({ id: "s1", agente: "roteirista", status: "concluido", inicio_ms: AGORA - 1 * HORA, fim_ms: AGORA - HORA + 60_000, duracao_ms: 60_000, custo_usd: 0.5 });
    dbA.criarSessao({ id: "s2", agente: "roteirista", status: "falhou", inicio_ms: AGORA - 2 * HORA, fim_ms: AGORA - 2 * HORA + 1000, duracao_ms: 1000, erro: "zumbi", custo_usd: 0.25 });
    dbA.criarSessao({ id: "s3", agente: "revisor", status: "executando", inicio_ms: AGORA - 5 * 60_000, fim_ms: null });
    dbA.criarSessao({ id: "velha", agente: "revisor", status: "concluido", inicio_ms: AGORA - 3 * 24 * HORA, fim_ms: AGORA - 3 * 24 * HORA + 1000, duracao_ms: 1000 });
    dbA.criarTask({ titulo: "aberta", coluna: "fazendo" });
    dbA.criarTask({ titulo: "pronta", coluna: "feito" });
    dbA.inserirNotificacao({ titulo: "n1", mensagem: "m" });
    dbA.fechar();

    const b = await novoWorkspace();
    const dbB = new OpencorpDb(b);
    dbB.criarSessao({ id: "b1", agente: "pautador", status: "concluido", inicio_ms: AGORA - 30 * 60_000, fim_ms: AGORA - 29 * 60_000, duracao_ms: 60_000, custo_usd: 1 });
    dbB.fechar();

    const sem = await novoWorkspace();
    await mkdir(join(sem, ".opencorp"), { recursive: true });

    const r = coletarAnalytics(
      [
        { id: "a", path: a, nome: "Canal A" },
        { id: "b", path: b, pausado: true, pausado_em: "2026-10-24T11:17:33.000Z" },
        { id: "sem-banco", path: sem },
      ],
      { janelaMs: JANELAS_ANALYTICS_MS["24h"]!, agora: AGORA },
    );

    const wa = r.workspaces.find((w) => w.id === "a")!;
    expect(wa.nome).toBe("Canal A");
    expect(wa.sessoes).toMatchObject({ total: 3, concluidas: 1, falhas: 1, executando: 1 });
    expect(wa.sessoes.taxa_falha).toBeCloseTo(1 / 3, 3);
    expect(wa.sessoes.custo_usd).toBeCloseTo(0.75, 4);
    expect(wa.agentes[0]).toMatchObject({ agente: "roteirista", total: 2, falhas: 1 });
    expect(wa.tarefas).toEqual({ fazendo: 1, feito: 1 });
    expect(wa.notificacoes_nao_lidas).toBe(1);
    expect(wa.erros_recentes[0]).toMatchObject({ id: "s2", erro: "zumbi" });
    expect(wa.por_tempo).toHaveLength(24);
    expect(wa.por_tempo.reduce((n, x) => n + x.total, 0)).toBe(3);

    const wb = r.workspaces.find((w) => w.id === "b")!;
    expect(wb.pausado).toBe(true);
    expect(wb.pausado_em).toBe("2026-10-24T11:17:33.000Z");
    expect(wb.nome).toBe("b");

    const ws = r.workspaces.find((w) => w.id === "sem-banco")!;
    expect(ws.banco_disponivel).toBe(false);
    expect(ws.sessoes.total).toBe(0);

    expect(r.totais).toMatchObject({ total: 4, concluidas: 2, falhas: 1, executando: 1, workspaces: 3, pausados: 1, tarefas_abertas: 1, notificacoes_nao_lidas: 1 });
    expect(r.totais.custo_usd).toBeCloseTo(1.75, 4);
    expect(r.por_tempo.reduce((n, x) => n + x.total, 0)).toBe(4);
    expect(r.linha_do_tempo.map((e) => e.quando)).toEqual([...r.linha_do_tempo.map((e) => e.quando)].sort().reverse());
    expect(new Set(r.linha_do_tempo.map((e) => e.workspace))).toEqual(new Set(["a", "b"]));
  });

  it("lê fluxos do journal só das últimas linhas e a janela exclui execuções antigas", async () => {
    const ws = await novoWorkspace();
    const db = new OpencorpDb(ws);
    db.criarSessao({ id: "antiga", agente: "x", status: "concluido", inicio_ms: AGORA - 2 * HORA, fim_ms: AGORA - 2 * HORA + 10, duracao_ms: 10 });
    db.fechar();
    const bruto = new Database(join(ws, ".opencorp", "opencorp.db"));
    const insere = bruto.prepare("INSERT INTO journal (registro_id, categoria, ts, por, evento, resumo) VALUES (?, 'flows', ?, 'sistema', 'execucao', ?)");
    insere.run("yt-producao", new Date(AGORA - 10 * 60_000).toISOString(), "flow yt-producao concluido");
    insere.run("yt-producao", new Date(AGORA - 5 * 60_000).toISOString(), "flow yt-producao falhou");
    insere.run("antigo", new Date(AGORA - 3 * 24 * HORA).toISOString(), "flow antigo concluido");
    bruto.close();

    const r = coletarAnalytics([{ id: "w", path: ws }], { janelaMs: HORA, agora: AGORA });
    const w = r.workspaces[0]!;
    expect(w.sessoes.total).toBe(0);
    expect(w.fluxos).toEqual([
      expect.objectContaining({ flow: "yt-producao", execucoes: 2, falhas: 1, ultimo_status: "falhou" }),
    ]);
    expect(r.linha_do_tempo.filter((e) => e.tipo === "fluxo")).toHaveLength(2);
  });
});
