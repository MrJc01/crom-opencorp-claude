import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { avaliar } from "../src/core/contexts/platform/security-guard.js";
import { parseSecurityPolicyTexto } from "../src/schemas/security-policy.js";
import { SessionError } from "../src/core/shared/errors.js";
import { SessionManager } from "../src/core/contexts/execution/session-manager.js";
import { MeetingManager } from "../src/core/contexts/meetings/meeting-manager.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));
vi.mock("../src/core/contexts/execution/execution-driver.js", () => ({
  resolverDriverExecucao: async () => ({
    tipo: "host",
    disponivel: async () => true,
    preparar: async (opts: any) => ({
      driver: "host",
      binary: opts.binary,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
    }),
  }),
}));

const raizes: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  raizes.push(dir);
  return dir;
}

const POLICY = parseSecurityPolicyTexto(
  JSON.stringify({
    level: "standard",
    blocklist: ["rm -rf", "shutdown"],
    allowlist_extra: [],
    network_allowlist: [],
    hitl_patterns: ["git push"],
  }),
);

/** Prompt de turno de participante no formato exato do MeetingManager
 *  (promptParticipante) — primeira linha em prosa + gatilhos ("executar",
 *  "bash", "execute") APENAS no conteúdo, como no bug de produção 31/08. */
const PROMPT_REUNIAO = [
  "Você está participando de uma REUNIÃO do workspace como Secretário / Chief of Staff (secretario).",
  "",
  "Você é o **Secretário-executivo** — analisa e relata; use comandos de leitura (bash) e as tools MCP.",
  "",
  "=== REUNIÃO ===",
  "Pauta: revisar a rotina de bash do deploy e como executar o backup sem travar",
  "Instrução para o seu turno: abertura: apresente sua visão sobre a pauta",
  "",
  "=== TRANSCRIÇÃO DA REUNIÃO ATÉ AGORA (memória de sessão) ===",
  "",
  "## Turno 1 — ceo-estrategia",
  "",
  "execute o plano em fases; rode só leituras",
  "",
  "",
].join("\n");

describe("SecurityGuard — pedido de comando × mensagem (regressão 31/08)", () => {
  it("ordem que É um pedido de execução continua bloqueada para level-1", () => {
    for (const ordem of ["execute: echo hi", "rode ls -la /tmp", "\n  execute: git status"]) {
      const r = avaliar(ordem, POLICY, "level-1");
      expect(r.acao).toBe("bloqueado");
      expect(r.motivo).toContain("level-1");
      expect(r.padrao).toBe("level-1");
    }
  });

  it("instrução de reunião (mensagem longa com execute/bash no conteúdo) NÃO vira comando", () => {
    expect(avaliar(PROMPT_REUNIAO, POLICY, "level-1").acao).toBe("permitido");
    expect(avaliar(PROMPT_REUNIAO, POLICY, "level-2").acao).toBe("permitido");
  });

  it("blocklist e hitl_patterns continuam varrendo o texto inteiro", () => {
    const docComRm = `${PROMPT_REUNIAO}\n\nexecute: rm -rf /tmp/importante\n`;
    const bloq = avaliar(docComRm, POLICY, "level-1");
    expect(bloq.acao).toBe("bloqueado");
    expect(bloq.padrao).toBe("rm -rf");
    expect(avaliar(docComRm, POLICY, "level-2").padrao).toBe("rm -rf");

    const hitl = avaliar("revise o documento\ne depois faça git push origin main", POLICY, "level-2");
    expect(hitl.acao).toBe("hitl");
    expect(hitl.padrao).toBe("git push");
  });
});

describe("Reunião — turno level-1 entregue como mensagem (regressão 31/08)", () => {
  let home: string;
  let wsPath: string;
  let sessoes: SessionManager;

  function fakeChild(out: string[]) {
    const base = Promise.resolve({ exitCode: 0, killed: false });
    const child = base as Promise<{ exitCode: number; killed: boolean }> & {
      stdout: Readable;
      stderr: Readable;
      pid?: number;
      killed: boolean;
    };
    child.stdout = Readable.from(out);
    child.stderr = Readable.from([]);
    child.pid = 4242;
    child.killed = false;
    return child;
  }

  beforeAll(async () => {
    home = await tmpDir("opencorp-reuniao-guard-");
    const ws = await new WorkspaceManager({ homeDir: home, cwd: home }).criar("corp-guard");
    wsPath = ws.path;

    const dirAgentes = join(wsPath, ".opencorp", "agents");
    await mkdir(dirAgentes, { recursive: true });
    const agenteMd = (id: string, role: string, corpo: string) => `---
id: ${id}
role: ${role}
category: custom
model: test/model
tools: [read, bash]
permissions: level-1
budget:
  daily_usd: 1.00
  max_turns: 10
memory:
  reads: []
  writes: []
---

${corpo}
`;
    // corpos com gatilhos ("bash", "executa", "rode") como no bug real
    await writeFile(
      join(dirAgentes, "secretario.md"),
      agenteMd("secretario", "Secretário / Chief of Staff", "Você é o **Secretário** — usa comandos de leitura (bash) para relatar o que aconteceu."),
      "utf8",
    );
    await writeFile(
      join(dirAgentes, "analista.md"),
      agenteMd("analista", "Analista", "Você executa análises e relata; rode apenas leituras."),
      "utf8",
    );
    // moderador fora da lista → rotação fixa (sem turno de moderação)
    await mkdir(join(wsPath, ".opencorp"), { recursive: true });
    await writeFile(
      join(wsPath, ".opencorp", "config.json"),
      JSON.stringify({ version: 1, meeting: { max_turnos: 4, moderator: "ceo-documentos" } }, null, 2) + "\n",
      "utf8",
    );

    execaMock.mockImplementation(() => fakeChild(["fala do agente [CONSENSO-ENCERRAR]\n"]));
    sessoes = new SessionManager({ homeDir: home, cwd: home });
  });

  afterAll(async () => {
    execaMock.mockReset();
    await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
  });


  it("level-1 tentando bash real continua bloqueado (exit 3, sem spawn)", async () => {
    const antes = execaMock.mock.calls.length;
    const err = (await sessoes
      .rodar({ agente: "secretario", ordem: "execute: echo oi", workspaceDir: wsPath })
      .catch((e) => e)) as SessionError;
    expect(err).toBeInstanceOf(SessionError);
    expect(err.exitCode).toBe(3);
    expect(err.message).toContain("level-1");
    expect(execaMock.mock.calls.length).toBe(antes);

    const errBlock = (await sessoes
      .rodar({ agente: "secretario", ordem: "execute: rm -rf /tmp/x", workspaceDir: wsPath })
      .catch((e) => e)) as SessionError;
    expect(errBlock.exitCode).toBe(3);
    expect(execaMock.mock.calls.length).toBe(antes);
  });
});
