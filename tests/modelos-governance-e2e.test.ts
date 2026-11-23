import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";
import {
  extrairParametrosB,
  classificarQualidadeModelo,
  filtrarModelosQualificados,
  resolverCadeiaModelosAgente,
} from "../src/core/contexts/agents/model-resolver.js";

const raizes: string[] = [];

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

let home = "";
let bin = "";

function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [bin, ...args], {
      env: { ...process.env, OPENCORP_HOME: home, ...env },
      cwd: process.cwd(),
      timeout: 30_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "opencorp-modelos-e2e-"));
  raizes.push(home);
  // Catálogo determinístico: o modelo <4B vem da rotação do settings do home
  // temporário, não do binário opencode instalado na máquina.
  await mkdir(join(home, ".opencorp"), { recursive: true });
  await writeFile(
    join(home, ".opencorp", "settings.json"),
    JSON.stringify({ modelos: { rotacao: ["openrouter/liquid/lfm-2.5-2.6b:free"] } })
  );
  bin = join(process.cwd(), "bin", "opencorp.mjs");
});

describe("E2E — Governança de Modelos, CLI e Dimensionamento xB", () => {
  describe("1. Comando CLI 'oc modelos' (Flags e Formatação)", () => {
    it("oc modelos --help exibe flags de xB, free e recommended com exit 0", async () => {
      const { code, stdout } = await runCli(["modelos", "--help"]);
      expect(code).toBe(0);
      expect(stdout).toContain("--free");
      expect(stdout).toContain("--recommended");
      expect(stdout).toContain("--size <spec>");
      expect(stdout).toContain("--min-b <n>");
      expect(stdout).toContain("--max-b <n>");
      expect(stdout).toContain("--json");
    });

    it("oc modelos --size '>30b' --json retorna apenas modelos com B >= 30", async () => {
      const { code, stdout } = await runCli(["modelos", "--size", ">30b", "--json"]);
      expect(code).toBe(0);
      const data = JSON.parse(stdout);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      for (const item of data) {
        expect(item.parametrosB).toBeGreaterThanOrEqual(30);
        expect(["S", "A"]).toContain(item.tier);
      }

      const temUltra = data.some((m: any) => m.modelo.includes("nemotron-3-ultra"));
      expect(temUltra).toBe(true);
    });

    it("oc modelos --size '<14b' --free --recommended --json retorna apenas mini-agentes seguros e gratuitos", async () => {
      const { code, stdout } = await runCli([
        "modelos",
        "--size",
        "<14b",
        "--free",
        "--recommended",
        "--json",
      ]);
      expect(code).toBe(0);
      const data = JSON.parse(stdout);
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      for (const item of data) {
        expect(item.parametrosB).toBeLessThanOrEqual(14);
        expect(item.gratuito).toBe(true);
        expect(item.recomendado).toBe(true);
        expect(item.tier).toBe("B");
        expect(item.modelo).not.toContain("liquid/lfm-2.5-2.6b");
        expect(item.modelo).not.toBe("openrouter/openrouter/free");
      }
    });

    it("oc modelos --size '<4b' exibe seção visual de advertência ⛔ NÃO RECOMENDADOS", async () => {
      const { code, stdout } = await runCli(["modelos", "--size", "<4b"]);
      expect(code).toBe(0);
      expect(stdout).toContain("⛔ NÃO RECOMENDADOS");
      expect(stdout).toContain("liquid/lfm-2.5-2.6b:free");
      expect(stdout).toContain("[TIER NAO_RECOMENDADO]");
    });
  });

  describe("2. Integração E2E com Isolamento de Workspace e Resolução de Cadeia", () => {
    it("cria novo workspace e resolve cadeia com modelos saneados sem 'liquid 2.6b'", async () => {
      const wm = new WorkspaceManager({ homeDir: home, cwd: home });
      const ws = await wm.criar("ws-modelos-governance-e2e");
      raizes.push(ws.path);

      // Agente com papel de mini-agente (validação/sanitização)
      const miniAgente = {
        name: "validador-dados",
        model: "openrouter/meta-llama/llama-3.1-8b-instruct:free",
        rotation: ["opencode/mimo-v2.5-free"],
        workspace_rotation_fallback: true,
      };

      const resMini = resolverCadeiaModelosAgente({
        agente: miniAgente,
        wsPath: ws.path,
        wsId: ws.id,
      });

      expect(resMini.modeloPrimario).toBe("openrouter/meta-llama/llama-3.1-8b-instruct:free");
      const paramMini = extrairParametrosB(resMini.modeloPrimario);
      expect(paramMini).toBe(8);
      const qualMini = classificarQualidadeModelo(resMini.modeloPrimario);
      expect(qualMini.tier).toBe("B");
      expect(qualMini.categoria).toBe("mini");
      expect(qualMini.recomendado).toBe(true);

      // Agente Secretário Executivo (>70B)
      const secretarioAgente = {
        name: "secretario-exec",
        model: "opencode/nemotron-3-ultra-free",
        rotation: ["openrouter/google/gemini-2.5-flash"],
        workspace_rotation_fallback: true,
      };

      const resSec = resolverCadeiaModelosAgente({
        agente: secretarioAgente,
        wsPath: ws.path,
        wsId: ws.id,
      });

      expect(resSec.modeloPrimario).toBe("opencode/nemotron-3-ultra-free");
      const paramSec = extrairParametrosB(resSec.modeloPrimario);
      expect(paramSec).toBe(550);
      const qualSec = classificarQualidadeModelo(resSec.modeloPrimario);
      expect(qualSec.tier).toBe("S");
      expect(qualSec.categoria).toBe("grande");
      expect(qualSec.recomendado).toBe(true);
    });

    it("filtra adequadamente uma lista mista de modelos de fluxo com regras estritas de governança", () => {
      const modelosFluxo = [
        "openrouter/liquid/lfm-2.5-2.6b:free",
        "openrouter/meta-llama/llama-3.2-1b-instruct",
        "openrouter/meta-llama/llama-3.1-8b-instruct:free",
        "opencode-go/glm-5.3-flash",
        "opencode/nemotron-3-ultra-free",
      ];

      // Filtro para nó de mini-agente
      const miniCandidatos = filtrarModelosQualificados(modelosFluxo, {
        apenasRecomendados: true,
        apenasGratuitos: true,
        maxB: 14,
      });
      expect(miniCandidatos.map((m) => m.modelo)).toEqual([
        "openrouter/meta-llama/llama-3.1-8b-instruct:free",
      ]);

      // Filtro para nó de roteirista/redator (14B a 35B)
      const redatorCandidatos = filtrarModelosQualificados(modelosFluxo, {
        apenasRecomendados: true,
        minB: 14,
        maxB: 35,
      });
      expect(redatorCandidatos.map((m) => m.modelo)).toEqual([
        "opencode-go/glm-5.3-flash",
      ]);

      // Filtro para nó de raciocínio/secretário (>70B)
      const raciocinioCandidatos = filtrarModelosQualificados(modelosFluxo, {
        apenasRecomendados: true,
        minB: 70,
      });
      expect(raciocinioCandidatos.map((m) => m.modelo)).toEqual([
        "opencode/nemotron-3-ultra-free",
      ]);
    });
  });
});
