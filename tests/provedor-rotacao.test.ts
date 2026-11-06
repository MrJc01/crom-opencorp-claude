import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gravarConfigProvedores,
  membrosPoolResolvidos,
  ProvedorError,
  resolverMembroPool,
  resolverProvedorClaude,
  traduzirModelo,
} from "../src/core/engines/provedor-claude.js";
import {
  classificarFalha,
  escolherMembro,
  estadoRotacaoVazio,
  lerEstadoRotacao,
  proximaMeiaNoiteUtc,
  registrarBloqueio,
} from "../src/core/engines/rotacao-provedores.js";
import { executarComRotacao, membrosDoAmbiente } from "../src/core/engines/runners/claude-sdk-cli.js";

const raizes: string[] = [];
async function home(): Promise<string> {
  const h = await mkdtemp(join(tmpdir(), "opencorp-rotacao-"));
  raizes.push(h);
  await mkdir(join(h, ".opencorp"), { recursive: true });
  return h;
}
afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

const AGORA = new Date("2026-10-31T15:00:00Z");

describe("classificarFalha", () => {
  it("cota diária: espera até a meia-noite UTC", () => {
    const f = classificarFalha("API Error: Request rejected (429) · Rate limit exceeded: limit_rpd/nvidia", AGORA);
    expect(f.classe).toBe("cota");
    expect(f.ate?.toISOString()).toBe(proximaMeiaNoiteUtc(AGORA).toISOString());
  });

  it("opencode zen: FreeUsageLimitError é cota diária", () => {
    expect(classificarFalha("FreeUsageLimitError: Free usage limit reached", AGORA).classe).toBe("cota");
  });

  it("429 comum: 15 minutos", () => {
    const f = classificarFalha("API Error: 429 Too Many Requests", AGORA);
    expect(f.classe).toBe("cota");
    expect(f.ate!.getTime() - AGORA.getTime()).toBe(15 * 60_000);
  });

  it("402 sem créditos: 6 horas", () => {
    const f = classificarFalha("API Error: 402 This request requires more credits", AGORA);
    expect(f.classe).toBe("cota");
    expect(f.ate!.getTime() - AGORA.getTime()).toBe(6 * 3_600_000);
  });

  it("403 modelo só para agentes: modelo indisponível por 12 horas", () => {
    const f = classificarFalha("thinkingmachines/inkling:free is only available on agentic harnesses", AGORA);
    expect(f.classe).toBe("modelo");
    expect(f.ate!.getTime() - AGORA.getTime()).toBe(12 * 3_600_000);
  });

  it("queda de rede não bloqueia a conta", () => {
    const f = classificarFalha("TypeError: fetch failed (ETIMEDOUT)", AGORA);
    expect(f.classe).toBe("transitoria");
    expect(f.ate).toBeUndefined();
  });

  it("erro que não depende da conta não rotaciona", () => {
    expect(classificarFalha("prompt too long for the context window", AGORA).classe).toBe("outra");
  });
});

describe("escolherMembro", () => {
  it("rodízio: cada escolha avança o cursor", () => {
    const e = estadoRotacaoVazio();
    const ordem = [1, 2, 3, 4].map(() => escolherMembro(["a", "b", "c"], e, AGORA).id);
    expect(ordem).toEqual(["a", "b", "c", "a"]);
  });

  it("pula membro em cooldown e informa quem está bloqueado", () => {
    const e = estadoRotacaoVazio();
    registrarBloqueio(e, "a", new Date(AGORA.getTime() + 60_000), "cota");
    const r = escolherMembro(["a", "b"], e, AGORA);
    expect(r.id).toBe("b");
    expect(r.bloqueados.map((b) => b.id)).toEqual(["a"]);
  });

  it("cooldown vencido libera o membro de novo", () => {
    const e = estadoRotacaoVazio();
    registrarBloqueio(e, "a", new Date(AGORA.getTime() - 1), "cota");
    expect(escolherMembro(["a"], e, AGORA).id).toBe("a");
  });

  it("sem membro livre devolve undefined", () => {
    const e = estadoRotacaoVazio();
    registrarBloqueio(e, "a", new Date(AGORA.getTime() + 60_000), "cota");
    expect(escolherMembro(["a"], e, AGORA).id).toBeUndefined();
  });

  it("excluir tira o membro da tentativa atual", () => {
    expect(escolherMembro(["a", "b"], estadoRotacaoVazio(), AGORA, ["a"]).id).toBe("b");
  });
});

async function poolEm(h: string) {
  await gravarConfigProvedores(h, {
    ativo: "rodizio",
    provedores: {
      conta1: { tipo: "compativel", baseUrl: "https://a.example", chave: "k1", modelos: { padrao: "modelo-a" } },
      conta2: { tipo: "compativel", baseUrl: "https://b.example", chave: "k2", modelos: { padrao: "modelo-b" } },
      rodizio: { tipo: "pool", membros: ["conta1", "conta2"] },
    },
  });
}

describe("pool de provedores", () => {
  it("resolve os membros em rodízio e pula o que está bloqueado", async () => {
    const h = await home();
    await poolEm(h);
    const primeiro = resolverProvedorClaude(h, {});
    expect(primeiro.membro).toBe("conta1");
    expect(primeiro.env.ANTHROPIC_BASE_URL).toBe("https://a.example");
    expect(resolverMembroPool(h, "rodizio").membro).toBe("conta2");
    // conta1 esgota: próxima escolha é conta2 mesmo com o cursor voltando
    const e = lerEstadoRotacao(h);
    registrarBloqueio(e, "conta2", new Date(Date.now() + 3_600_000), "cota");
    await mkdir(join(h, ".opencorp", "rotacao"), { recursive: true });
    await writeFile(join(h, ".opencorp", "rotacao", "estado.json"), JSON.stringify(e));
    expect(resolverMembroPool(h, "rodizio").membro).toBe("conta1");
  });

  it("todos em cooldown: erro com a hora em que volta", async () => {
    const h = await home();
    await poolEm(h);
    const e = estadoRotacaoVazio();
    registrarBloqueio(e, "conta1", new Date(Date.now() + 3_600_000), "cota diária esgotada");
    registrarBloqueio(e, "conta2", new Date(Date.now() + 3_600_000), "cota diária esgotada");
    await mkdir(join(h, ".opencorp", "rotacao"), { recursive: true });
    await writeFile(join(h, ".opencorp", "rotacao", "estado.json"), JSON.stringify(e));
    expect(() => resolverMembroPool(h, "rodizio")).toThrow(ProvedorError);
    expect(() => resolverMembroPool(h, "rodizio")).toThrow(/conta1 \(cota diária esgotada, volta/);
  });

  it("pool sem membros válidos é erro de configuração", async () => {
    const h = await home();
    await gravarConfigProvedores(h, { ativo: "p", provedores: { p: { tipo: "pool", membros: ["nao-existe"] } } });
    expect(() => resolverProvedorClaude(h, {})).toThrow(/não tem membros válidos/);
  });

  it("membro sem chave fica fora do rodízio; os outros seguem", async () => {
    const h = await home();
    await gravarConfigProvedores(h, {
      ativo: "p",
      provedores: {
        semchave: { tipo: "compativel", baseUrl: "https://a.example", chaveEnv: "VAR_QUE_NAO_EXISTE_XYZ" },
        comchave: { tipo: "compativel", baseUrl: "https://b.example", chave: "k" },
        p: { tipo: "pool", membros: ["semchave", "comchave"] },
      },
    });
    expect(membrosPoolResolvidos(h, "p", {}).map((m) => m.id)).toEqual(["comchave"]);
    expect(resolverMembroPool(h, "p", [], {}).membro).toBe("comchave");
  });

  it("traduz modelo pelo mapa do membro", () => {
    expect(traduzirModelo({ padrao: "x", haiku: "h" }, "claude-haiku-5-5")).toBe("h");
    expect(traduzirModelo({ padrao: "x" }, "default")).toBe("x");
    // id do OpenRouter só vale no OpenRouter; no zen vira o padrão do membro
    expect(traduzirModelo({ padrao: "z" }, "openrouter/nvidia/n:free", "https://opencode.ai/zen")).toBe("z");
    expect(traduzirModelo({ padrao: "z" }, "openrouter/nvidia/n:free", "https://openrouter.ai/api")).toBe("nvidia/n:free");
  });
});

describe("runner com rotação", () => {
  const membro = (id: string, base: string, modelo: string) => ({
    id,
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: `tok-${id}` },
    configDir: `/cfg/${id}`,
    modelos: { padrao: modelo, haiku: modelo },
  });

  function consultaFalsa(porTentativa: unknown[][], vistos: Array<{ base?: string; model?: string }>) {
    let n = 0;
    return ((params: { options: any }) => {
      vistos.push({ base: process.env.ANTHROPIC_BASE_URL, model: params.options.model });
      const mensagens = porTentativa[Math.min(n, porTentativa.length - 1)]!;
      n++;
      return (async function* () {
        for (const m of mensagens) yield m;
      })() as any;
    }) as any;
  }

  const erro429 = { type: "result", subtype: "success", is_error: true, result: "API Error: 429 Rate limit exceeded: limit_rpd", errors: [] };
  const sucesso = (t: string) => ({ type: "result", subtype: "success", is_error: false, result: t, errors: [] });

  it("cota esgotada numa conta: troca para a outra, grava cooldown e conta o uso", async () => {
    const h = await home();
    const vistos: Array<{ base?: string; model?: string }> = [];
    let out = "";
    let err = "";
    const codigo = await executarComRotacao(
      {
        cwd: "/ws",
        prompt: "oi",
        pool: { id: "rodizio", home: h, modeloPedido: "claude-haiku-5-5", membros: [membro("conta1", "https://a.example", "modelo-a"), membro("conta2", "https://b.example", "modelo-b")] },
      },
      { stdout: (t) => (out += t), stderr: (t) => (err += t) },
      consultaFalsa([[erro429], [sucesso("pronto")]], vistos) as any,
      () => AGORA,
    );
    expect(codigo).toBe(0);
    expect(out).toBe("pronto\n");
    expect(err).toContain("[rotação] conta1");
    expect(vistos.map((v) => v.base)).toEqual(["https://a.example", "https://b.example"]);
    expect(vistos.map((v) => v.model)).toEqual(["modelo-a", "modelo-b"]);
    const estado = JSON.parse(await readFile(join(h, ".opencorp", "rotacao", "estado.json"), "utf8"));
    expect(estado.bloqueios.conta1.motivo).toBe("cota diária esgotada");
    expect(estado.usos.conta2).toBe(1);
  });

  it("texto da conta que esgotou não vai para a saída do agente", async () => {
    const h = await home();
    const vistos: Array<{ base?: string; model?: string }> = [];
    let out = "";
    const codigo = await executarComRotacao(
      {
        cwd: "/ws",
        prompt: "oi",
        pool: { id: "rodizio", home: h, membros: [membro("conta1", "https://a.example", "a"), membro("conta2", "https://b.example", "b")] },
      },
      { stdout: (t) => (out += t), stderr: () => {} },
      consultaFalsa(
        [
          [{ type: "assistant", message: { content: [{ type: "text", text: "API Error: 429 limite" }] } }, erro429],
          [sucesso("resposta boa")],
        ],
        vistos,
      ) as any,
      () => AGORA,
    );
    expect(codigo).toBe(0);
    expect(out).toBe("resposta boa\n");
  });

  it("erro que não depende da conta para na primeira tentativa", async () => {
    const h = await home();
    const vistos: Array<{ base?: string; model?: string }> = [];
    let err = "";
    const codigo = await executarComRotacao(
      {
        cwd: "/ws",
        prompt: "oi",
        pool: { id: "rodizio", home: h, membros: [membro("conta1", "https://a.example", "a"), membro("conta2", "https://b.example", "b")] },
      },
      { stdout: () => {}, stderr: (t) => (err += t) },
      consultaFalsa([[{ type: "result", subtype: "success", is_error: true, result: "prompt too long", errors: [] }]], vistos) as any,
      () => AGORA,
    );
    expect(codigo).toBe(1);
    expect(vistos.length).toBe(1);
    expect(err).toContain("prompt too long");
  });

  it("todos os membros com cota esgotada: falha com mensagem e sem loop", async () => {
    const h = await home();
    const vistos: Array<{ base?: string; model?: string }> = [];
    let err = "";
    const codigo = await executarComRotacao(
      {
        cwd: "/ws",
        prompt: "oi",
        pool: { id: "rodizio", home: h, membros: [membro("conta1", "https://a.example", "a"), membro("conta2", "https://b.example", "b")] },
      },
      { stdout: () => {}, stderr: (t) => (err += t) },
      consultaFalsa([[erro429]], vistos) as any,
      () => AGORA,
    );
    expect(codigo).toBe(1);
    expect(vistos.length).toBe(2);
    expect(err).toContain("todos os membros falharam nesta chamada");
  });

  it("lê os membros do ambiente", () => {
    const m = membro("conta1", "https://a.example", "a");
    expect(membrosDoAmbiente(JSON.stringify([m]))[0]!.id).toBe("conta1");
    expect(membrosDoAmbiente("não é json")).toEqual([]);
    expect(membrosDoAmbiente(undefined)).toEqual([]);
  });
});
