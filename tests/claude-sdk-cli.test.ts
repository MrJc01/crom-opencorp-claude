/**
 * Runner de agente do motor claude-sdk: `query()` é falso, nenhum teste chama o modelo.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executarAgenteCli,
  FERRAMENTAS_AGENTE,
  lerArgumentosCli,
  lerInstrucoesAgente,
} from "../src/core/engines/runners/claude-sdk-cli.js";

function consultaFalsa(mensagens: unknown[], capturadas: { opcoes?: any } = {}) {
  return (params: { prompt: string; options: any }) => {
    capturadas.opcoes = params.options;
    return (async function* () {
      for (const m of mensagens) yield m;
    })() as any;
  };
}

const sucesso = (texto: string) => ({ type: "result", subtype: "success", is_error: false, result: texto, errors: [] });

describe("lerArgumentosCli", () => {
  it("lê cwd, modelo, caminho do claude e o prompt depois de --", () => {
    const opts = lerArgumentosCli(["--cwd", "/ws", "--model", "claude-haiku-5-5", "--claude-path", "/bin/claude", "--", "faça", "algo"]);
    expect(opts).toEqual({ cwd: "/ws", model: "claude-haiku-5-5", claudePath: "/bin/claude", prompt: "faça algo" });
  });

  it("exige --cwd", () => {
    expect(() => lerArgumentosCli(["--", "oi"])).toThrow(/uso:/);
  });
});

describe("executarAgenteCli", () => {
  it("usa query() com acceptEdits e as ferramentas dos agentes, e imprime a resposta final", async () => {
    const capturadas: { opcoes?: any } = {};
    let out = "";
    let err = "";
    const codigo = await executarAgenteCli(
      { cwd: "/ws", prompt: "oi", model: "claude-haiku-5-5", claudePath: "/bin/claude" },
      { stdout: (t) => (out += t), stderr: (t) => (err += t) },
      consultaFalsa([{ type: "assistant" }, sucesso("pronto")], capturadas) as any,
    );
    expect(codigo).toBe(0);
    expect(out).toBe("pronto\n");
    expect(err).toBe("");
    expect(capturadas.opcoes).toMatchObject({
      cwd: "/ws",
      model: "claude-haiku-5-5",
      pathToClaudeCodeExecutable: "/bin/claude",
      permissionMode: "acceptEdits",
      allowedTools: FERRAMENTAS_AGENTE,
      // Skills e CLAUDE.md do workspace; nada de ~/.claude do dono.
      settingSources: ["project"],
      skills: "all",
    });
  });

  it("resultado com erro vira código 1 e mensagem em stderr", async () => {
    let err = "";
    const codigo = await executarAgenteCli(
      { cwd: "/ws", prompt: "oi" },
      { stdout: () => {}, stderr: (t) => (err += t) },
      consultaFalsa([{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["sem cota"] }]) as any,
    );
    expect(codigo).toBe(1);
    expect(err).toContain("sem cota");
  });

  it("fim do stream sem resultado vira código 1", async () => {
    let err = "";
    const codigo = await executarAgenteCli(
      { cwd: "/ws", prompt: "oi" },
      { stdout: () => {}, stderr: (t) => (err += t) },
      consultaFalsa([{ type: "assistant" }]) as any,
    );
    expect(codigo).toBe(1);
    expect(err).toContain("sem resultado final");
  });

  it("exceção do SDK vira código 1", async () => {
    let err = "";
    const codigo = await executarAgenteCli(
      { cwd: "/ws", prompt: "oi" },
      { stdout: () => {}, stderr: (t) => (err += t) },
      (() => {
        throw new Error("boom");
      }) as any,
    );
    expect(codigo).toBe(1);
    expect(err).toContain("boom");
  });
});

describe("executarAgenteCli — texto em tempo real", () => {
  it("imprime o texto do assistente conforme chega e não repete o resultado final", async () => {
    let out = "";
    const codigo = await executarAgenteCli(
      { cwd: "/ws", prompt: "oi" },
      { stdout: (t) => (out += t), stderr: () => {} },
      consultaFalsa([
        { type: "assistant", message: { content: [{ type: "text", text: "lendo a pauta" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } },
        { type: "assistant", message: { content: [{ type: "text", text: "pronto" }] } },
        sucesso("pronto"),
      ]) as any,
    );
    expect(codigo).toBe(0);
    expect(out).toBe("lendo a pauta\npronto\n");
  });
});

describe("instruções do agente", () => {
  it("lê --agente e tira o frontmatter do arquivo", () => {
    expect(lerArgumentosCli(["--cwd", "/ws", "--agente", "/ws/a.md", "--", "oi"]).agentePath).toBe("/ws/a.md");
    expect(lerInstrucoesAgente("---\nid: x\nmodel: m\n---\n\n# Curador\nOlhe as fotos.\n")).toBe("# Curador\nOlhe as fotos.");
    expect(lerInstrucoesAgente("sem frontmatter")).toBe("sem frontmatter");
    // anexo do opencode (catálogo, contexto adaptativo, notificar) não vai para o claude-sdk
    expect(
      lerInstrucoesAgente("---\nid: x\n---\n# Curador\n## Skills (1)\n### s: d\ncorpo\n\n## Available Skills (Progressive Disclosure)\n- a\n## Contexto Operacional\nKanban"),
    ).toBe("# Curador\n## Skills (1)\n### s: d\ncorpo");
  });

  it("acrescenta o corpo do agente ao prompt de sistema do Claude Code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-agente-"));
    const arquivo = join(dir, "curador.md");
    writeFileSync(arquivo, "---\nid: curador\n---\n# Curador\nNunca use foto que não mostre o assunto.\n");
    const capturadas: { opcoes?: any } = {};
    const codigo = await executarAgenteCli(
      { cwd: "/ws", prompt: "cure a pauta-1", agentePath: arquivo },
      { stdout: () => {}, stderr: () => {} },
      consultaFalsa([sucesso("ok")], capturadas) as any,
    );
    expect(codigo).toBe(0);
    expect(capturadas.opcoes.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "# Curador\nNunca use foto que não mostre o assunto.",
    });
  });

  it("sem --agente não mexe no prompt de sistema", async () => {
    const capturadas: { opcoes?: any } = {};
    await executarAgenteCli({ cwd: "/ws", prompt: "oi" }, { stdout: () => {}, stderr: () => {} }, consultaFalsa([sucesso("ok")], capturadas) as any);
    expect(capturadas.opcoes.systemPrompt).toBeUndefined();
  });
});
