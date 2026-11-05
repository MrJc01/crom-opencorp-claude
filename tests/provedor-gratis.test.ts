import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lerConfigProvedores, ProvedorError } from "../src/core/engines/provedor-claude.js";
import {
  definirAtivoGratis,
  listarGratis,
  modeloEGratis,
  removerProvedorGratis,
  salvarPoolGratis,
  salvarProvedorGratis,
} from "../src/core/engines/provedores-gratis.js";

const raizes: string[] = [];
async function home(): Promise<string> {
  // /dev/shm para não escrever em disco lento (CLAUDE.md); cai no tmpdir se não existir.
  const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const h = await mkdtemp(join(base, "opencorp-gratis-"));
  raizes.push(h);
  await mkdir(join(h, ".opencorp"), { recursive: true });
  return h;
}
afterAll(async () => {
  for (const r of raizes) await rm(r, { recursive: true, force: true });
});

const openrouter = {
  id: "openrouter-1",
  nome: "OpenRouter conta 1",
  baseUrl: "https://openrouter.ai/api",
  modelos: { padrao: "nvidia/nemotron-3-super-120b-a12b:free" },
  chave: "sk-or-SEGREDO-1234",
};

describe("modeloEGratis", () => {
  it("aceita id com :free ou -free", () => {
    expect(modeloEGratis("nvidia/nemotron-3-super-120b-a12b:free")).toBe(true);
    expect(modeloEGratis("opencode/mimo-v2.6-flash-free")).toBe(true);
  });
  it("recusa modelo pago ou da Anthropic", () => {
    expect(modeloEGratis("claude-haiku-5-5")).toBe(false);
    expect(modeloEGratis("anthropic/claude-haiku-5-5")).toBe(false);
    expect(modeloEGratis("openai/gpt-4o")).toBe(false);
  });
});

describe("salvarProvedorGratis", () => {
  it("grava um provedor compatível e a listagem não devolve a chave", async () => {
    const h = await home();
    await salvarProvedorGratis(h, openrouter);
    const lista = listarGratis(h);
    expect(lista.provedores.map((p) => p.id)).toEqual(["openrouter-1"]);
    expect(lista.provedores[0]!.chaveDefinida).toBe(true);
    expect(JSON.stringify(lista)).not.toContain("SEGREDO");
    expect(lerConfigProvedores(h).provedores["openrouter-1"]!.chave).toBe("sk-or-SEGREDO-1234");
  });

  it("recusa modelo que não é grátis, com o nome do modelo na mensagem", async () => {
    const h = await home();
    await expect(
      salvarProvedorGratis(h, { ...openrouter, modelos: { padrao: "anthropic/claude-haiku-5-5" } }),
    ).rejects.toThrow(/anthropic\/claude-haiku-5-5.*não é grátis/);
  });

  it("recusa modelo pago numa família (haiku) mesmo com padrão grátis", async () => {
    const h = await home();
    await expect(
      salvarProvedorGratis(h, { ...openrouter, modelos: { padrao: "x/y:free", haiku: "claude-haiku-5-5" } }),
    ).rejects.toThrow(ProvedorError);
  });

  it("recusa URL sem https (exceto localhost)", async () => {
    const h = await home();
    await expect(salvarProvedorGratis(h, { ...openrouter, baseUrl: "http://exemplo.com" })).rejects.toThrow(/URL inválida/);
    await expect(salvarProvedorGratis(h, { ...openrouter, baseUrl: "não é url" })).rejects.toThrow(/URL inválida/);
    await expect(salvarProvedorGratis(h, { ...openrouter, baseUrl: "http://localhost:8080" })).resolves.toBeUndefined();
  });

  it("recusa id fora de kebab-case", async () => {
    const h = await home();
    await expect(salvarProvedorGratis(h, { ...openrouter, id: "Meu Provedor" })).rejects.toThrow(/kebab-case/);
  });

  it("exige chave gravada ou nome de variável de ambiente", async () => {
    const h = await home();
    await expect(salvarProvedorGratis(h, { ...openrouter, chave: undefined })).rejects.toThrow(/chave/);
    await expect(
      salvarProvedorGratis(h, { ...openrouter, chave: undefined, chaveEnv: "OPENROUTER_API_KEY" }),
    ).resolves.toBeUndefined();
  });

  it("editar sem digitar chave mantém a chave já gravada", async () => {
    const h = await home();
    await salvarProvedorGratis(h, openrouter);
    await salvarProvedorGratis(h, { ...openrouter, nome: "Renomeado", chave: "" });
    const cfg = lerConfigProvedores(h).provedores["openrouter-1"]!;
    expect(cfg.nome).toBe("Renomeado");
    expect(cfg.chave).toBe("sk-or-SEGREDO-1234");
  });

  it("não sobrescreve assinatura nem api que já existam com o mesmo id", async () => {
    const h = await home();
    await expect(salvarProvedorGratis(h, { ...openrouter, id: "assinatura" })).rejects.toThrow(/não é um provedor grátis/);
  });
});

describe("pools e ativo", () => {
  it("monta pool só com membros grátis cadastrados", async () => {
    const h = await home();
    await salvarProvedorGratis(h, openrouter);
    await salvarPoolGratis(h, { id: "rodizio", nome: "Rodízio grátis", membros: ["openrouter-1"] });
    const lista = listarGratis(h);
    expect(lista.pools).toEqual([{ id: "rodizio", nome: "Rodízio grátis", membros: ["openrouter-1"] }]);
    await expect(salvarPoolGratis(h, { id: "ruim", nome: "x", membros: ["assinatura"] })).rejects.toThrow(/não é um provedor grátis/);
    await expect(salvarPoolGratis(h, { id: "vazio", nome: "x", membros: [] })).rejects.toThrow(/pelo menos um/);
  });

  it("recusa remover o provedor ativo e tira o membro dos pools ao remover", async () => {
    const h = await home();
    await salvarProvedorGratis(h, openrouter);
    await salvarProvedorGratis(h, { ...openrouter, id: "zen-1", nome: "Zen", baseUrl: "https://opencode.ai/zen", chave: "public" });
    await salvarPoolGratis(h, { id: "rodizio", nome: "Rodízio", membros: ["openrouter-1", "zen-1"] });
    await definirAtivoGratis(h, "openrouter-1");
    await expect(removerProvedorGratis(h, "openrouter-1")).rejects.toThrow(/é o provedor ativo/);
    await removerProvedorGratis(h, "zen-1");
    expect(lerConfigProvedores(h).provedores["rodizio"]!.membros).toEqual(["openrouter-1"]);
    expect(lerConfigProvedores(h).provedores["zen-1"]).toBeUndefined();
  });

  it("define como ativo só provedor ou pool grátis", async () => {
    const h = await home();
    await salvarProvedorGratis(h, openrouter);
    await definirAtivoGratis(h, "openrouter-1");
    expect(lerConfigProvedores(h).ativo).toBe("openrouter-1");
    await expect(definirAtivoGratis(h, "assinatura")).rejects.toThrow(/não é um provedor ou pool grátis/);
  });

  it("listagem traz só compatível e pool, sem assinatura", async () => {
    const h = await home();
    await salvarProvedorGratis(h, openrouter);
    const ids = [...listarGratis(h).provedores.map((p) => p.id), ...listarGratis(h).pools.map((p) => p.id)];
    expect(ids).toEqual(["openrouter-1"]);
  });
});
