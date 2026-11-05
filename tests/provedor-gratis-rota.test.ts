import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleConfigRoutes } from "../src/server/routes/config.js";
import type { RouteContext } from "../src/server/routes/types.js";

const raizes: string[] = [];
async function home(): Promise<string> {
  const base = existsSync("/dev/shm") ? "/dev/shm" : tmpdir();
  const h = await mkdtemp(join(base, "opencorp-gratis-rota-"));
  raizes.push(h);
  await mkdir(join(h, ".opencorp"), { recursive: true });
  return h;
}
afterAll(async () => {
  for (const r of raizes) await rm(r, { recursive: true, force: true });
});

/** Chama o handler de configuração como o servidor faria, sem subir o HTTP. */
async function chamar(h: string, metodo: string, rota: string, corpo?: unknown) {
  const resposta = { status: 0, corpo: undefined as any };
  const ctx = {
    req: { method: metodo },
    res: {},
    url: new URL(`http://localhost${rota}`),
    rota,
    resolverWs: async () => ({ id: "default", path: h }),
    lerCorpo: async () => corpo ?? {},
    enviar: (_res: unknown, status: number, body: unknown) => {
      resposta.status = status;
      resposta.corpo = body;
    },
    homeDir: h,
  } as unknown as RouteContext;
  const tratada = await handleConfigRoutes(ctx);
  return { tratada, ...resposta };
}

const openrouter = {
  id: "openrouter-1",
  nome: "OpenRouter conta 1",
  baseUrl: "https://openrouter.ai/api",
  modelos: { padrao: "nvidia/nemotron-3-super-120b-a12b:free" },
  chave: "sk-or-SEGREDO-1234",
};

describe("rota /api/provedores-gratis", () => {
  it("cadastra um provedor grátis e a listagem não devolve a chave", async () => {
    const h = await home();
    const salvo = await chamar(h, "POST", "/api/provedores-gratis/provedor", openrouter);
    expect(salvo.tratada).toBe(true);
    expect(salvo.status).toBe(200);
    expect(salvo.corpo.provedores.map((p: { id: string }) => p.id)).toEqual(["openrouter-1"]);
    expect(JSON.stringify(salvo.corpo)).not.toContain("SEGREDO");

    const lista = await chamar(h, "GET", "/api/provedores-gratis");
    expect(lista.status).toBe(200);
    expect(JSON.stringify(lista.corpo)).not.toContain("SEGREDO");
  });

  it("devolve 400 com a mensagem quando o modelo não é grátis", async () => {
    const h = await home();
    const r = await chamar(h, "POST", "/api/provedores-gratis/provedor", {
      ...openrouter,
      modelos: { padrao: "anthropic/claude-haiku-5-5" },
    });
    expect(r.status).toBe(400);
    expect(r.corpo.erro).toMatch(/não é grátis/);
  });

  it("recusa remover o provedor ativo e aceita trocar o ativo por um grátis", async () => {
    const h = await home();
    await chamar(h, "POST", "/api/provedores-gratis/provedor", openrouter);
    const ativo = await chamar(h, "POST", "/api/provedores-gratis/ativo", { id: "openrouter-1" });
    expect(ativo.status).toBe(200);
    expect(ativo.corpo.ativo).toBe("openrouter-1");

    const remover = await chamar(h, "DELETE", "/api/provedores-gratis/provedor/openrouter-1");
    expect(remover.status).toBe(400);
    expect(remover.corpo.erro).toMatch(/é o provedor ativo/);
  });

  it("recusa definir como ativo a assinatura do Claude", async () => {
    const h = await home();
    const r = await chamar(h, "POST", "/api/provedores-gratis/ativo", { id: "assinatura" });
    expect(r.status).toBe(400);
    expect(r.corpo.erro).toMatch(/não é um provedor ou pool grátis/);
  });

  it("monta pool de rodízio com membros grátis e remove o pool depois de desativá-lo", async () => {
    const h = await home();
    await chamar(h, "POST", "/api/provedores-gratis/provedor", openrouter);
    const pool = await chamar(h, "POST", "/api/provedores-gratis/pool", {
      id: "rodizio",
      nome: "Rodízio grátis",
      membros: ["openrouter-1"],
    });
    expect(pool.status).toBe(200);
    expect(pool.corpo.pools).toEqual([{ id: "rodizio", nome: "Rodízio grátis", membros: ["openrouter-1"] }]);

    const semMembros = await chamar(h, "POST", "/api/provedores-gratis/pool", { id: "vazio", nome: "x", membros: [] });
    expect(semMembros.status).toBe(400);

    const removido = await chamar(h, "DELETE", "/api/provedores-gratis/pool/rodizio");
    expect(removido.status).toBe(200);
    expect(removido.corpo.pools).toEqual([]);
  });

  it("não trata rotas que não são de provedores grátis", async () => {
    const h = await home();
    const r = await chamar(h, "GET", "/api/outra-coisa-qualquer");
    expect(r.tratada).toBe(false);
  });
});
