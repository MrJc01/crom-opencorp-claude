import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  readFirstDeprecationNotice,
  readRunEngineConfig,
  translateRunnerJson,
  writeRunEngineConfig,
} from "../src/core/config/run-engine-config.js";
import { applyMigration, listBackups, MigrationValidationError, planMigration, rollbackMigration } from "../src/core/config/config-migrator.js";
import { defaultDeprecationEmitter } from "../src/core/engines/legacy-config-translator.js";
import { parseAgenteMd } from "../src/schemas/agent.js";

const execFileAsync = promisify(execFile);

const RUNNER = { engine: "claude", timeout_min: 30, harness_fallback: ["agy", "codex"], binary_path: "/opt/claude/bin/claude", limits: { codex: { rate_limit_rpm: 10 } } };
const AGENTE_LEGADO = `---
id: redator
role: Redator
category: operario
ativo: true
model: opencode-go/glm-5.3-flash
harness: claude
harness_fallback: [agy]
model_fallback: [openrouter/qwen/qwen3.8-27b:free]
tools: [read]
permissions: level-1
budget:
  daily_usd: 1.00
  max_turns: 10
memory:
  reads: []
  writes: []
---

Você escreve textos.
`;

/** Mapa caminho → bytes de todos os arquivos sob `dir` (snapshot byte a byte). */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

describe("ETAPA 14 — configuração de execução e migração", () => {
  let home: string;
  let ws: string;
  const logs: string[] = [];

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-migr-"));
    ws = join(home, "ws");
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(ws, ".opencorp", "agents"), { recursive: true });
    defaultDeprecationEmitter.clear();
    logs.length = 0;
    defaultDeprecationEmitter.setLogger((m) => logs.push(m));
  });

  afterEach(async () => {
    defaultDeprecationEmitter.setLogger((m) => console.warn(m));
    defaultDeprecationEmitter.clear();
    await rm(home, { recursive: true, force: true });
  });

  const writeRunner = (data: unknown = RUNNER) => writeFile(join(home, ".opencorp", "runner.json"), JSON.stringify(data, null, 2));
  const writeAgent = (text = AGENTE_LEGADO) => writeFile(join(ws, ".opencorp", "agents", "redator.md"), text);

  it("traduz runner.json para settings (aliases canônicos, caminho absoluto, limites)", () => {
    const { settingsPatch, warnings } = translateRunnerJson({ ...RUNNER, extra: 1 });
    expect(settingsPatch).toEqual({
      run_engine: { default: "claude-code", timeout_min: 30, fallback: ["antigravity", "codex"] },
      engines: { "claude-code": { binary_path: "/opt/claude/bin/claude" }, codex: { limits: { rate_limit_rpm: 10 } } },
    });
    expect(warnings).toContain('campo desconhecido "extra" em runner.json não foi migrado.');
    expect(translateRunnerJson({ engine: "opencode", binary_path: "opencode" }).warnings[0]).toMatch(/não é um caminho absoluto/);
  });

  it("precedência: settings novo > runner.json legado > padrão; aviso só para o legado, uma vez por campo", async () => {
    expect(readRunEngineConfig(home)).toMatchObject({ engine: "claude-sdk", source: "default", fallbackEngines: [] });
    expect(logs).toEqual([]);

    await writeRunner();
    expect(readRunEngineConfig(home)).toMatchObject({ engine: "claude-code", source: "runner.json", fallbackEngines: ["antigravity", "codex"] });
    const avisos = logs.length;
    expect(avisos).toBeGreaterThan(0);
    readRunEngineConfig(home);
    expect(logs.length).toBe(avisos); // não duplica
    await new Promise((r) => setTimeout(r, 20));
    expect(readFirstDeprecationNotice(home)).toBeTruthy();

    logs.length = 0;
    defaultDeprecationEmitter.clear();
    await writeFile(join(home, ".opencorp", "settings.json"), JSON.stringify({ run_engine: { default: "codex" } }));
    expect(readRunEngineConfig(home)).toMatchObject({ engine: "codex", source: "settings" });
    expect(logs).toEqual([]); // configuração nova não emite aviso legado
  });

  it("escrita vai para settings.json, preserva o que o runner.json definia e nunca grava runner.json", async () => {
    await writeRunner();
    const runnerAntes = readFileSync(join(home, ".opencorp", "runner.json"));
    await writeRunEngineConfig(home, { engine: "codex" });
    expect(readFileSync(join(home, ".opencorp", "runner.json"))).toEqual(runnerAntes);
    const settings = JSON.parse(await readFile(join(home, ".opencorp", "settings.json"), "utf8"));
    expect(settings.run_engine).toEqual({ default: "codex", timeout_min: 30, fallback: ["antigravity", "codex"] });
    expect(settings.engines.codex.limits).toEqual({ rate_limit_rpm: 10 });
  });

  it("dry-run lista mudanças sem escrever nada", async () => {
    await writeRunner();
    await writeAgent();
    const antes = snapshot(home);
    const plan = planMigration(home, { workspacePaths: [ws] });
    expect(snapshot(home)).toEqual(antes);
    expect(plan.pending).toBe(true);
    expect(plan.changes.map((c) => [c.kind, c.action])).toEqual([["settings.json", "create"], ["runner.json", "delete"], ["agent", "update"]]);
    const agente = plan.changes.find((c) => c.kind === "agent")!;
    expect(agente.transformations).toEqual(expect.arrayContaining(["harness → engine", "harness_fallback → engine_fallback", "model_fallback → rotation"]));
  });

  it("aplica com backup íntegro, resultado canônico e é idempotente", async () => {
    await writeRunner();
    await writeAgent();
    const r = await applyMigration(home, { workspacePaths: [ws] });
    expect(r.backup!.entries).toHaveLength(3);
    expect(existsSync(join(home, ".opencorp", "runner.json"))).toBe(false);
    expect(readRunEngineConfig(home)).toMatchObject({ engine: "claude-code", source: "settings" });

    const agente = await readFile(join(ws, ".opencorp", "agents", "redator.md"), "utf8");
    expect(agente).toContain("engine: claude-code");
    expect(agente).toContain("engine_fallback: [antigravity]");
    expect(agente).toContain("rotation: [openrouter/qwen/qwen3.8-27b:free]");
    expect(agente).not.toMatch(/^harness:|^model_fallback:|^harness_fallback:/m);
    expect(parseAgenteMd(agente).frontmatter).toMatchObject({ engine: "claude-code", harness: "claude-code" });

    expect(planMigration(home, { workspacePaths: [ws] }).pending).toBe(false);
    const segunda = await applyMigration(home, { workspacePaths: [ws] });
    expect(segunda.applied).toEqual([]);
    expect(listBackups(home)).toHaveLength(1);
  });

  it("rollback restaura byte a byte e remove o que a migração criou", async () => {
    await writeRunner();
    await writeAgent();
    const antes = snapshot(join(home, ".opencorp"));
    const agenteAntes = snapshot(ws);
    const r = await applyMigration(home, { workspacePaths: [ws] });
    await rollbackMigration(home, r.backup!.id);
    const depois = snapshot(join(home, ".opencorp"));
    for (const [k, v] of Object.entries(antes)) expect(depois[k], k).toBe(v);
    expect(Object.keys(depois).filter((k) => !k.startsWith("backups/") && !(k in antes))).toEqual([]);
    expect(snapshot(ws)).toEqual(agenteAntes);
  });

  it("resultado inválido não substitui nenhum original", async () => {
    await writeRunner();
    await writeFile(join(home, ".opencorp", "settings.json"), JSON.stringify({ budget: { daily_usd: "caro" } }));
    const antes = snapshot(home);
    await expect(applyMigration(home, { workspacePaths: [ws] })).rejects.toBeInstanceOf(MigrationValidationError);
    expect(snapshot(home)).toEqual(antes);
    expect(listBackups(home)).toEqual([]);
  });

  it("CLI: --check sinaliza pendência (3), --apply migra e --rollback restaura", async () => {
    await writeRunner();
    const cli = join(process.cwd(), "src", "cli", "index.ts");
    const run = (args: string[]) =>
      execFileAsync(process.execPath, ["--import", "tsx", cli, "migrate-configs", ...args], { env: { ...process.env, OPENCORP_HOME: home }, timeout: 60_000 })
        .then(() => 0)
        .catch((e: { code?: number }) => e.code ?? -1);
    expect(await run(["--check"])).toBe(3);
    expect(existsSync(join(home, ".opencorp", "runner.json"))).toBe(true);
    expect(await run(["--apply"])).toBe(0);
    expect(existsSync(join(home, ".opencorp", "runner.json"))).toBe(false);
    expect(await run(["--check"])).toBe(0);
    expect(await run(["--rollback"])).toBe(0);
    expect(existsSync(join(home, ".opencorp", "runner.json"))).toBe(true);
    expect(await run(["--rollback", "inexistente"])).toBe(4);
  }, 120_000);
});
