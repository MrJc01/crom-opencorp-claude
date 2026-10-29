import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gravarConfigProvedores,
  lerConfigProvedores,
  ProvedorError,
  resolverProvedorClaude,
} from "../src/core/engines/provedor-claude.js";
import { normalizeEngineError } from "../src/core/engines/error-normalizer.js";
import { EngineAuthRequiredError } from "../src/core/engines/errors.js";

const raizes: string[] = [];
async function home(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), "opencorp-provedor-"));
  raizes.push(h);
  await mkdir(join(h, ".opencorp"), { recursive: true });
  return h;
}
afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("provedor do claude-sdk", () => {
  it("sem arquivo: assinatura, sem variáveis extras e modelo inalterado", async () => {
    const h = await home();
    const r = resolverProvedorClaude(h, {});
    expect(r.id).toBe("assinatura");
    expect(r.env).toEqual({});
    expect(r.modelo("claude-haiku-5-5")).toBe("claude-haiku-5-5");
    expect(r.modelo("default")).toBeUndefined();
    expect(r.modelo(undefined)).toBeUndefined();
  });

  it("api: chave vai para ANTHROPIC_API_KEY e usa pasta de configuração própria", async () => {
    const h = await home();
    await gravarConfigProvedores(h, { ativo: "minha-api", provedores: { "minha-api": { tipo: "api", chaveEnv: "MINHA_CHAVE" } } });
    const r = resolverProvedorClaude(h, { MINHA_CHAVE: "sk-teste-123" });
    expect(r.env.ANTHROPIC_API_KEY).toBe("sk-teste-123");
    expect(r.env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(r.configDir).toBe(join(h, ".opencorp", "claude-provedor-minha-api"));
    expect((await stat(r.configDir as string)).isDirectory()).toBe(true);
  });

  it("api sem chave falha cedo, dizendo qual variável falta", async () => {
    const h = await home();
    await gravarConfigProvedores(h, { ativo: "x", provedores: { x: { tipo: "api", chaveEnv: "FALTA_ESTA" } } });
    expect(() => resolverProvedorClaude(h, {})).toThrow(ProvedorError);
    expect(() => resolverProvedorClaude(h, {})).toThrow(/FALTA_ESTA/);
  });

  it("compativel: URL base, token, mapa de modelos por id e por família", async () => {
    const h = await home();
    await gravarConfigProvedores(h, {
      ativo: "or",
      provedores: {
        or: {
          tipo: "compativel",
          baseUrl: "https://openrouter.ai/api",
          chave: "or-abc",
          modelos: { haiku: "z-ai/glm-5.2", sonnet: "qwen/qwen3.8", "claude-opus-5-5": "deepseek/r2", padrao: "z-ai/glm-5.2" },
        },
      },
    });
    const r = resolverProvedorClaude(h, {});
    expect(r.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
      ANTHROPIC_AUTH_TOKEN: "or-abc",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "z-ai/glm-5.2",
      ANTHROPIC_SMALL_FAST_MODEL: "z-ai/glm-5.2",
    });
    expect(r.modelo("claude-haiku-5-5")).toBe("z-ai/glm-5.2");
    expect(r.modelo("claude-sonnet-5-5")).toBe("qwen/qwen3.8");
    expect(r.modelo("claude-opus-5-5")).toBe("deepseek/r2");
    expect(r.modelo("default")).toBe("z-ai/glm-5.2");
    expect(r.modelo("modelo-que-o-provedor-ja-conhece")).toBe("modelo-que-o-provedor-ja-conhece");
  });

  it("compativel sem baseUrl é erro de configuração", async () => {
    const h = await home();
    await gravarConfigProvedores(h, { ativo: "c", provedores: { c: { tipo: "compativel", chave: "k" } } });
    expect(() => resolverProvedorClaude(h, {})).toThrow(/baseUrl/);
  });

  it("OPENCORP_PROVEDOR vence o arquivo; id inexistente lista os disponíveis", async () => {
    const h = await home();
    await gravarConfigProvedores(h, { ativo: "assinatura", provedores: { a: { tipo: "api", chave: "k1" } } });
    expect(resolverProvedorClaude(h, { OPENCORP_PROVEDOR: "a" }).env.ANTHROPIC_API_KEY).toBe("k1");
    expect(() => resolverProvedorClaude(h, { OPENCORP_PROVEDOR: "nao-existe" })).toThrow(/assinatura, a/);
  });

  it("arquivo com entrada inválida ou JSON quebrado não derruba: ignora a entrada / volta à assinatura", async () => {
    const h = await home();
    const arq = join(h, ".opencorp", "provedores.json");
    await writeFile(arq, JSON.stringify({ ativo: "assinatura", provedores: { ruim: { tipo: "nada" }, bom: { tipo: "api", chave: "k" } } }));
    expect(Object.keys(lerConfigProvedores(h).provedores).sort()).toEqual(["assinatura", "bom"]);
    await writeFile(arq, "{quebrado");
    expect(lerConfigProvedores(h).ativo).toBe("assinatura");
  });

  it("grava o arquivo com permissão 600 (pode ter chave)", async () => {
    const h = await home();
    await gravarConfigProvedores(h, { ativo: "assinatura", provedores: { a: { tipo: "api", chave: "k" } } });
    expect(((await stat(join(h, ".opencorp", "provedores.json"))).mode & 0o777).toString(8)).toBe("600");
  });
});

describe("erro de conta sem acesso por assinatura", () => {
  it("vira falha de autenticação do motor", () => {
    const err = normalizeEngineError(
      new Error("Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead"),
      { engineId: "claude-sdk", modelId: "claude-haiku-5-5" },
    );
    expect(err).toBeInstanceOf(EngineAuthRequiredError);
  });
});
