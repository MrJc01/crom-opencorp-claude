import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RegistryStore } from "../src/core/contexts/storage/registry-store.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";
import { SettingsStore } from "../src/core/contexts/workspace/settings-store.js";
import {
  MeetingManager,
  parseDecisaoModerador,
  type SessaoLike,
} from "../src/core/contexts/meetings/meeting-manager.js";
import type { OpcoesRun, ResultadoRun } from "../src/core/contexts/execution/session-manager.js";

const raizes: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  raizes.push(dir);
  return dir;
}

function resultadoFake(opcoes: OpcoesRun, captura: string): ResultadoRun {
  return {
    id: `exec-${Math.random().toString(36).slice(2, 8)}`,
    agente: opcoes.agente,
    modelo: opcoes.model ?? "opencode/hy3-free",
    ordem: opcoes.ordem ?? "",
    inicio: new Date().toISOString(),
    fim: new Date().toISOString(),
    status: "concluido",
    exit_code: 0,
    duracao_ms: 100,
    pid: 1,
    log: "logs/x.log",
    captura,
    custo_usd: 0.0005,
  };
}

interface Chamada {
  opcoes: OpcoesRun;
}

function stubSessao(roteiro: (chamada: Chamada, indice: number) => string): {
  sessao: SessaoLike;
  chamadas: Chamada[];
} {
  const chamadas: Chamada[] = [];
  return {
    chamadas,
    sessao: {
      rodar: vi.fn(async (opcoes: OpcoesRun) => {
        const captura = roteiro({ opcoes }, chamadas.length);
        chamadas.push({ opcoes });
        return resultadoFake(opcoes, captura);
      }) as unknown as SessaoLike["rodar"],
    },
  };
}

async function ambiente() {
  const home = await tmpDir("opencorp-meet-");
  const manager = new WorkspaceManager({ homeDir: home, cwd: home });
  const ws = await manager.criar("corp-meet");
  const registros = new RegistryStore();
  const settings = new SettingsStore({ homeDir: home, cwd: home });
  return { home, wsPath: ws.path, registros, settings };
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("parseDecisaoModerador", () => {
  it("parseia 'próximo: <agente> — instrução: <foco>'", () => {
    const d = parseDecisaoModerador("próximo: executor-padrao — instrução: detalhe os custos");
    expect(d).toEqual({ tipo: "proximo", agente: "executor-padrao", instrucao: "detalhe os custos" });
  });

  it("reconhece ENCERRAR e rejeita texto sem formato", () => {
    expect(parseDecisaoModerador("já decidimos tudo. ENCERRAR").tipo).toBe("encerrar");
    expect(parseDecisaoModerador("blá blá sem formato").tipo).toBe("indecifrado");
  });
});

describe("MeetingManager — rotação fixa (moderador fora da lista)", () => {
  it("alterniza participantes, corta por max_turnos e registra moderação no transcript", async () => {
    const { home, wsPath } = await ambiente();
    await new SettingsStore({ homeDir: home, cwd: home }).set("meeting.max_turns", "4", {
      scope: "workspace",
      workspaceDir: wsPath,
    });
    const { sessao, chamadas } = stubSessao((chamada) => `fala de ${chamada.opcoes.agente}`);
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const sala = await mm.iniciar({
      pauta: "como melhorar o registro de custos?",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });

    expect(sala.status).toBe("encerrada");
    expect(sala.motivo_fim).toContain("max_turnos");
    expect(sala.moderacao).toBe("rotacao-fixa");
    expect(sala.turno).toBe(4);
    const falas = chamadas.filter((c) => !c.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA"));
    expect(falas).toHaveLength(4);
    const falantes = falas.map((c) => c.opcoes.agente);
    expect(falantes).toEqual(["ceo-documentos", "executor-padrao", "ceo-documentos", "executor-padrao"]);
    for (const c of chamadas) {
      expect(c.opcoes.tags).toContain(`reuniao:${sala.id}`);
      expect(c.opcoes.ordem).toContain("TRANSCRIÇÃO");
      expect(c.opcoes.ordem).toContain("como melhorar o registro de custos?");
    }
    const { transcript } = await mm.mostrar(wsPath, sala.id);
    expect(transcript).toContain("## Turno 1 — ceo-documentos");
    expect(transcript).toContain("## Turno 2 — executor-padrao");
    expect(transcript).toContain("Status final: encerrada");
  });
});

describe("MeetingManager — moderador decide", () => {
  it("moderador escolhe o falante (com instrução) e depois declara ENCERRAR", { timeout: 90_000 }, async () => {
    const { home, wsPath } = await ambiente();
    let vezModerador = 0;
    const { sessao, chamadas } = stubSessao((chamada) => {
      if (chamada.opcoes.agente === "secretario") {
        vezModerador += 1;
        return vezModerador === 1
          ? "próximo: executor-padrao — instrução: detalhe os custos por agente"
          : "todos concordamos. ENCERRAR";
      }
      return `contribuição de ${chamada.opcoes.agente}`;
    });
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const sala = await mm.iniciar({
      pauta: "revisão do orçamento",
      agentes: "ceo-documentos,executor-padrao,secretario",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });

    expect(sala.moderacao).toBe("moderador");
    expect(sala.status).toBe("encerrada");
    expect(sala.motivo_fim).toContain("consenso");
    const falas = chamadas.filter((c) => !c.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA"));
    const falantes = falas.map((c) => c.opcoes.agente);
    expect(falantes[0]).toBe("secretario");
    expect(falantes[1]).toBe("executor-padrao");
    expect(falantes[falantes.length - 1]).toBe("secretario");
    const falaExecutor = falas.find((c) => c.opcoes.agente === "executor-padrao")!;
    expect(falaExecutor.opcoes.ordem).toContain("detalhe os custos por agente");
  });

  it("decisão indecifrável cai na rotação fixa com nota no transcript", async () => {
    const { home, wsPath } = await ambiente();
    await new SettingsStore({ homeDir: home, cwd: home }).set("meeting.max_turns", "2", {
      scope: "workspace",
      workspaceDir: wsPath,
    });
    const { sessao, chamadas } = stubSessao((chamada) => {
      if (chamada.opcoes.agente === "secretario") return "não sei do que você está falando";
      return `fala de ${chamada.opcoes.agente}`;
    });
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const sala = await mm.iniciar({
      pauta: "pauta qualquer",
      agentes: "ceo-documentos,executor-padrao,secretario",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.status).toBe("encerrada");
    const { transcript } = await mm.mostrar(wsPath, sala.id);
    expect(transcript).toContain("fallback para rotação fixa");
    expect(chamadas.length).toBeGreaterThanOrEqual(3);
  });
});

describe("MeetingManager — encerramentos", () => {
  it("orçamento estoura → encerra com motivo orçamento", async () => {
    const { home, wsPath } = await ambiente();
    const { sessao } = stubSessao((chamada) => `fala de ${chamada.opcoes.agente}`);
    const budgetFalso = {
      podeExecutar: vi
        .fn()
        .mockResolvedValueOnce({ ok: true })
        .mockResolvedValue({ ok: false, motivo: "orçamento estourou" }),
      registrarConsumo: vi.fn(),
    } as unknown as import("../src/core/contexts/platform/budget-manager.js").BudgetManager;
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao, budget: budgetFalso });
    const sala = await mm.iniciar({
      pauta: "pauta orçamento",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.status).toBe("encerrada");
    expect(sala.motivo_fim).toContain("orçamento");
    expect(sala.turno).toBe(1);
  });

  it("interrupção humana (SIGINT simulado) → encerrada-partial com transcript preservado", async () => {
    const { home, wsPath } = await ambiente();
    let interromper: (() => void) | null = null;
    const { sessao, chamadas } = stubSessao((chamada) => {
      if (chamadas.length === 0) interromper?.();
      return `fala de ${chamada.opcoes.agente}`;
    });
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    interromper = () => mm.solicitarInterrupcao();
    const sala = await mm.iniciar({
      pauta: "pauta interrompida",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.status).toBe("encerrada-partial");
    expect(sala.motivo_fim).toContain("SIGINT");
    expect(sala.turno).toBe(1);
    const { transcript } = await mm.mostrar(wsPath, sala.id);
    expect(transcript).toContain("Status final: encerrada-partial");
    expect(transcript).toContain("## Turno 1");
  });

  it("ata automática após encerramento (agente mock escreve o arquivo)", async () => {
    const { home, wsPath } = await ambiente();
    const { sessao, chamadas } = stubSessao((chamada) => {
      if (chamada.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA")) {
        const m = /\.opencorp\/registries\/documentos\/atas\/ATA-[\w-]+\.md/.exec(chamada.opcoes.ordem)!;
        mkdirSync(join(wsPath, ".opencorp", "registries", "documentos", "atas"), { recursive: true });
        writeFileSync(
          join(wsPath, m[0]!),
          "# ATA — Reunião\n\n## Pauta\nmelhorar custos\n\n## Participantes\nceo-documentos, executor-padrao\n\n## Decisões\nusar budget.json\n\n## Tarefas delegadas\n- @executor-padrao: revisar budget.json diariamente\n\n## Status da reunião\nencerrada\n",
        );
        return "ata escrita";
      }
      return `fala de ${chamada.opcoes.agente}`;
    });
    await new SettingsStore({ homeDir: home, cwd: home }).set("meeting.max_turns", "2", {
      scope: "workspace",
      workspaceDir: wsPath,
    });
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const sala = await mm.iniciar({
      pauta: "melhorar custos",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.ata).toContain("ATA-");

    const chamadasAta = chamadas.filter((c) => c.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA"));
    expect(chamadasAta).toHaveLength(1);
    expect(chamadasAta[0]!.opcoes.agente).toBe("ceo-documentos");
    expect(chamadasAta[0]!.opcoes.pularGuard).toBe(true);
    expect(chamadasAta[0]!.opcoes.ordem).toContain("TRANSCRIÇÃO DA REUNIÃO");

    const data = new Date().toISOString().slice(0, 10);
    const ata = readFileSync(join(wsPath, ".opencorp", "registries", "documentos", "atas", `ATA-${data}-${sala.id}.md`), "utf8");
    expect(ata).toContain("## Decisões");
    expect(existsSync(join(wsPath, ".opencorp", "registries", "documentos", `ata-${data}-${sala.id}`, "conteudo.md"))).toBe(true);
    const indice = readFileSync(join(wsPath, ".opencorp", "registries", "documentos", "atas-indice", "conteudo.md"), "utf8");
    expect(indice).toContain(`ATA-${data}-${sala.id}`);
    const audit = readFileSync(join(wsPath, ".opencorp", "registries", "logs", "audit-log", "journal.jsonl"), "utf8");
    expect(audit).toContain('"evento":"tarefa_delegada"');
    expect(audit).toContain('"dono":"executor-padrao"');
  });

  it("ata com provedor falho → rotação tenta próximo modelo e grava", async () => {
    const { home, wsPath } = await ambiente();
    const chamadas: Chamada[] = [];
    const sessao: SessaoLike = {
      rodar: vi.fn(async (opcoes: OpcoesRun) => {
        if (opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA")) {
          chamadas.push({ opcoes });
          if (opcoes.model === "opencode/hy3-free") {
            throw new Error('UnknownError — Unexpected server error. Check server logs for details. ref: err_x');
          }
          const m = /\.opencorp\/registries\/documentos\/atas\/ATA-[\w-]+\.md/.exec(opcoes.ordem)!;
          mkdirSync(join(wsPath, ".opencorp", "registries", "documentos", "atas"), { recursive: true });
          writeFileSync(join(wsPath, m[0]!), "# ATA\n\n## Decisões\nok via fallback\n\n## Tarefas delegadas\n(nenhuma)\n");
          return resultadoFake(opcoes, "ata escrita");
        }
        chamadas.push({ opcoes });
        return resultadoFake(opcoes, `fala de ${opcoes.agente}`);
      }),
    };
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const sala = await mm.iniciar({
      pauta: "rotação de ata",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.ata).toContain("ATA-");

    const ataChamadas = chamadas.filter((c) => c.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA"));
    expect(ataChamadas).toHaveLength(2);
    expect(ataChamadas[0]!.opcoes.model).toBe("opencode/hy3-free");
    expect(ataChamadas[1]!.opcoes.model).toBe("opencode/deepseek-v4.1-flash-free");
  });

  it("ata com recusa determinística (budget) → não roda rotação", async () => {
    const { home, wsPath } = await ambiente();
    const chamadas: Chamada[] = [];
    const sessao: SessaoLike = {
      rodar: vi.fn(async (opcoes: OpcoesRun) => {
        if (opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA")) {
          chamadas.push({ opcoes });
          throw new Error('recusada pelo BudgetManager: orçamento diário do agente "ceo-documentos" esgotado');
        }
        chamadas.push({ opcoes });
        return resultadoFake(opcoes, `fala de ${opcoes.agente}`);
      }),
    };
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const sala = await mm.iniciar({
      pauta: "recusa budget ata",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.ata).toBe("falhou");
    const ataChamadas = chamadas.filter((c) => c.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA"));
    expect(ataChamadas).toHaveLength(1);
  });

  it("meeting end em sala marcada em-andamento finaliza de forma controlada", async () => {
    const { home, wsPath, registros } = await ambiente();
    const { sessao, chamadas } = stubSessao((chamada) => {
      if (chamada.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA")) {
        const m = /\.opencorp\/registries\/documentos\/atas\/ATA-[\w-]+\.md/.exec(chamada.opcoes.ordem)!;
        mkdirSync(join(wsPath, ".opencorp", "registries", "documentos", "atas"), { recursive: true });
        writeFileSync(join(wsPath, m[0]!), "# ATA\n\n## Decisões\nnenhuma\n\n## Tarefas delegadas\n(nenhuma)\n");
        return "ata escrita";
      }
      return "fala";
    });
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const id = `reuniao-teste-end`;
    await registros.garantirCategorias(wsPath);
    await registros.criar(wsPath, {
      categoria: "chats",
      id,
      descricao: "Reunião: teste",
      criadoPor: "opencorp",
      tags: ["reuniao"],
      conteudo: "# Reunião teste\n",
      extras: {
        tipo: "reuniao",
        pauta: "teste",
        participantes: ["ceo-documentos", "executor-padrao"],
        moderator: "secretario",
        moderacao: "rotacao-fixa",
        modelo: "opencode/hy3-free",
        max_turnos: 12,
        turno: 0,
        status: "em-andamento",
        motivo_fim: null,
        encerrada_em: null,
        ata: null,
      },
    });
    const sala = await mm.encerrar(wsPath, id, "encerrada pelo humano (meeting end)");
    expect(sala.status).toBe("encerrada-partial");
    expect(sala.ata).toContain("ATA-");
    const ataChamadas = chamadas.filter((c) => c.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA"));
    expect(ataChamadas).toHaveLength(1);
    const err = await mm.encerrar(wsPath, id).catch((e) => e);
    expect(err.message).toContain("não está em andamento");
  });

  it("participante inexistente → erro claro", async () => {
    const { home, wsPath } = await ambiente();
    const { sessao } = stubSessao(() => "");
    const mm = new MeetingManager({ homeDir: home, cwd: home, sessoes: sessao });
    const err = await mm
      .iniciar({
        pauta: "x",
        agentes: "ceo-documentos,fantasma",
        model: "opencode/hy3-free",
        workspaceDir: wsPath,
      })
      .catch((e) => e);
    expect(err.message).toContain('participante "fantasma" não existe');
    expect(err.message).toContain("agent create");
  });
});

describe("MeetingManager — listar", () => {
  it("expõe criado_em em ISO que formata como data curta (coluna do meeting list)", async () => {
    const { wsPath } = await ambiente();
    const registros = new RegistryStore();
    const { writeFileAtomic } = await import("../src/utils/fs-safe.js");
    const dir = join(wsPath, ".opencorp", "registries", "chats", "reuniao-teste-001");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    await writeFileAtomic(
      join(dir, "meta.json"),
      JSON.stringify({
        id: "reuniao-teste-001",
        categoria: "chats",
        descricao: "pauta de teste",
        criado_por: "ceo-documentos",
        criado_em: "2026-08-28T14:30:11.000Z",
        atualizado_em: "2026-08-28T14:35:00.000Z",
        permissoes: { leitura: ["*"], escrita: ["ceo-documentos"], modificacao_meta: [] },
        tags: [],
        referencias: [],
        extras: {
          tipo: "reuniao",
          pauta: "pauta de teste",
          status: "encerrada",
          turno: 2,
          max_turnos: 6,
          participantes: ["ceo-documentos"],
          moderator: "ceo-documentos",
          moderacao: "fixa",
          modelo: "opencode/hy3-free",
          motivo_fim: "max_turnos",
          encerrada_em: "2026-08-28T14:35:00.000Z",
        },
      }, null, 2) + "\n",
    );
    const salas = await new MeetingManager().listar(wsPath);
    expect(salas).toHaveLength(1);
    const dataCurta = salas[0]!.criado_em.slice(0, 16).replace("T", " ");
    expect(dataCurta).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(salas[0]!.pauta).toBe("pauta de teste");
  });
});

describe("MeetingManager — teto de tempo (meeting.max_minutes)", () => {
  function stubAta(wsPath: string): ReturnType<typeof stubSessao> {
    return stubSessao((chamada) => {
      if (chamada.opcoes.ordem?.includes("TAREFA INTERNA DO SISTEMA")) {
        const m = /\.opencorp\/registries\/documentos\/atas\/ATA-[\w-]+\.md/.exec(chamada.opcoes.ordem)!;
        mkdirSync(join(wsPath, ".opencorp", "registries", "documentos", "atas"), { recursive: true });
        writeFileSync(join(wsPath, m[0]!), "# ATA — Reunião\n\n## Decisões\npor tempo\n");
        return "ata escrita";
      }
      return `fala de ${chamada.opcoes.agente}`;
    });
  }

  it("tempo esgotado antes de um turno → encerrada com motivo de tempo e ata gerada", async () => {
    const { home, wsPath } = await ambiente();
    const { sessao, chamadas } = stubAta(wsPath);
    await new SettingsStore({ homeDir: home, cwd: home }).set("meeting.max_minutes", "1", {
      scope: "workspace",
      workspaceDir: wsPath,
    });
    const base = new Date("2026-08-28T12:00:00Z");
    let chamadaRelogio = 0;
    const mm = new MeetingManager({
      homeDir: home,
      cwd: home,
      sessoes: sessao,
      agora: () => {
        chamadaRelogio += 1;
        return chamadaRelogio === 1 ? base : new Date(base.getTime() + 11 * 60000);
      },
    });
    const sala = await mm.iniciar({
      pauta: "pauta longa que não vai caber no tempo",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.status).toBe("encerrada");
    expect(sala.motivo_fim).toBe("tempo máximo (1 min) atingido");
    expect(sala.turno).toBe(0);
    expect(sala.ata).toContain("ATA-");
    expect(existsSync(join(wsPath, ".opencorp", "registries", "chats", sala.id))).toBe(true);
    expect(readFileSync(join(wsPath, ".opencorp", "registries", "chats", sala.id, "conteudo.md"), "utf8")).toContain("Status final: encerrada");
    expect(execaCallCount(chamadas)).toBe(1);
  });

  it("max_turnos vence quando o tempo não estoura (o que vier primeiro)", async () => {
    const { home, wsPath } = await ambiente();
    const { sessao } = stubAta(wsPath);
    const store = new SettingsStore({ homeDir: home, cwd: home });
    await store.set("meeting.max_turns", "2", { scope: "workspace", workspaceDir: wsPath });
    await store.set("meeting.max_minutes", "6", { scope: "workspace", workspaceDir: wsPath });
    const base = new Date("2026-08-28T12:00:00Z");
    const mm = new MeetingManager({
      homeDir: home,
      cwd: home,
      sessoes: sessao,
      agora: () => base,
    });
    const sala = await mm.iniciar({
      pauta: "pauta rápida",
      agentes: "ceo-documentos,executor-padrao",
      model: "opencode/hy3-free",
      workspaceDir: wsPath,
    });
    expect(sala.status).toBe("encerrada");
    expect(sala.motivo_fim).toBe("max_turnos (2) atingido");
    expect(sala.turno).toBe(2);
  });
});

function execaCallCount(chamadas: Chamada[]): number {
  return chamadas.length;
}
