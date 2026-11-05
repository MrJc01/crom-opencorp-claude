import { afterAll, describe, expect, it } from "vitest";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gerarAgenteOpencode, OpenCodeBridge } from "../src/core/contexts/execution/opencode-bridge.js";
import { parseAgenteMd } from "../src/schemas/agent.js";

const EXEMPLO_EXECUTOR = `---
id: executor-padrao
role: Operário
category: operario
model: opencode/grok-code
tools: [read, write, edit, bash, registry]
permissions: level-2
budget:
  daily_usd: 1.00
  max_turns: 40
memory:
  reads: [documentos]
  writes: [execucoes]
---

Você é o executor padrão do workspace {{workspace}}.
`;

const EXEMPLO_SECRETARIO = `---
id: secretario
role: Secretário
category: secretario
model: openrouter/google/gemini-2.5-flash
tools: [read, registry]
permissions: level-1
budget:
  daily_usd: 0.50
  max_turns: 30
memory:
  reads: [documentos]
  writes: []
---

Você é o Secretário.
`;

const raizes: string[] = [];

async function wsFalso(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-bridge-"));
  raizes.push(dir);
  await mkdir(join(dir, ".opencorp", "opencode"), { recursive: true });
  return dir;
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("gerarAgenteOpencode", () => {
  it("mapeia frontmatter opencorp → opencode (executor level-2)", () => {
    const ag = parseAgenteMd(EXEMPLO_EXECUTOR);
    const saida = gerarAgenteOpencode(ag.frontmatter, ag.corpo);
    expect(saida).toContain('description: "Operário (agente opencorp \\"executor-padrao\\", categoria operario)"');
    expect(saida).toContain("mode: all");
    expect(saida).toContain('model: "opencode/grok-code"');
    expect(saida).toContain("  bash: true");
    expect(saida).toContain("  read: true");
    expect(saida).toContain("  webfetch: false");
    expect(saida).toContain("permission:\n  edit: allow\n  bash: allow\n  webfetch: deny");
    // Etapa 7: guidance da tool notificar é injetado ao fim do system prompt
    expect(saida).toContain("Você é o executor padrão do workspace {{workspace}}.");
    expect(saida).toContain("chame a tool notificar");
    expect(saida.trimEnd().endsWith("para o painel mostrar ao usuário.")).toBe(true);
  });

  it("secretario (level-1, sem bash) tem ferramentas e permissões bloqueadas", () => {
    const ag = parseAgenteMd(EXEMPLO_SECRETARIO);
    const saida = gerarAgenteOpencode(ag.frontmatter, ag.corpo);
    expect(saida).toContain("  bash: false");
    expect(saida).toContain("  write: false");
    expect(saida).toContain("permission:\n  edit: deny\n  bash: deny\n  webfetch: deny");
  });

  it("level-1 com write nas tools (ceo-documentos) mantém edit: allow para produzir documentos", () => {
    const ceo = parseAgenteMd(`---
id: ceo-documentos
role: CEO Documentador
category: ceo
model: opencode/grok-code
tools: [read, write, registry]
permissions: level-1
budget:
  daily_usd: 2.00
  max_turns: 50
memory:
  reads: [documentos]
  writes: [documentos]
---

Você é o CEO Documentador.
`);
    const saida = gerarAgenteOpencode(ceo.frontmatter, ceo.corpo);
    expect(saida).toContain("  write: true");
    expect(saida).toContain("  bash: false");
    expect(saida).toContain("permission:\n  edit: allow\n  bash: deny\n  webfetch: deny");
  });
});

describe("OpenCodeBridge.sincronizarAgente", () => {
  it("grava em .opencorp/opencode/agent e cria symlink .opencode", async () => {
    const ws = await wsFalso();
    const bridge = new OpenCodeBridge();
    const ag = parseAgenteMd(EXEMPLO_EXECUTOR);
    const destino = await bridge.sincronizarAgente(ws, ag.frontmatter, ag.corpo);
    expect(existsSync(destino)).toBe(true);
    expect(lstatSync(join(ws, ".opencode")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(ws, ".opencode"))).toBe(join(".opencorp", "opencode"));
    expect(existsSync(join(ws, ".opencode", "agent", "executor-padrao.md"))).toBe(true);
    expect(readFileSync(join(ws, ".opencode", "agent", "executor-padrao.md"), "utf8")).toContain(
      "executor padrão",
    );
  });

  it("quando .opencode já é diretório real, copia o agente para dentro", async () => {
    const ws = await wsFalso();
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(ws, ".opencode", "agent"), { recursive: true });
    const bridge = new OpenCodeBridge();
    const ag = parseAgenteMd(EXEMPLO_SECRETARIO);
    await bridge.sincronizarAgente(ws, ag.frontmatter, ag.corpo);
    expect(lstatSync(join(ws, ".opencode")).isSymbolicLink()).toBe(false);
    expect(existsSync(join(ws, ".opencode", "agent", "secretario.md"))).toBe(true);
    expect(readFileSync(join(ws, ".opencode", "agent", "secretario.md"), "utf8")).toContain(
      "Secretário",
    );
  });

  it("segunda sincronização é idempotente", async () => {
    const ws = await wsFalso();
    const bridge = new OpenCodeBridge();
    const ag = parseAgenteMd(EXEMPLO_EXECUTOR);
    const a = await bridge.sincronizarAgente(ws, ag.frontmatter, ag.corpo);
    const b = await bridge.sincronizarAgente(ws, ag.frontmatter, ag.corpo);
    expect(a).toBe(b);
    expect(readlinkSync(join(ws, ".opencode"))).toBe(join(".opencorp", "opencode"));
  });

  it("substitui {{workspace}} pelo id real do workspace no corpo sincronizado", async () => {
    const ws = await wsFalso();
    const bridge = new OpenCodeBridge();
    const ag = parseAgenteMd(EXEMPLO_EXECUTOR);
    await bridge.sincronizarAgente(ws, ag.frontmatter, ag.corpo);
    const gerado = readFileSync(join(ws, ".opencorp", "opencode", "agent", "executor-padrao.md"), "utf8");
    expect(gerado).not.toContain("{{workspace}}");
    expect(gerado).toContain(basename(ws));
  });
});
