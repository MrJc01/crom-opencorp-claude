import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer, type ApiServerOptions } from "../src/server/index.js";
import { OpencodeServerManager } from "../src/core/contexts/execution/opencode-server.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-secretario-erros-"));
  raizes.push(dir);
  return dir;
}

function makeFetch(port: number, token: string) {
  const base = `http://127.0.0.1:${port}`;
  return async (path: string, opts: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...opts,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...opts.headers,
      },
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, text };
  };
}

describe("Secretário — erros com retorno apropriado + truncar (edição)", () => {
  let home: string;
  let token = "test-token-erros";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let opencodeServer: OpencodeServerManager;

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await mkdir(join(home, "workspaces", "corp-teste", ".opencorp"), { recursive: true });
    await writeFile(join(home, "workspaces", "corp-teste", ".opencorp", "config.json"), "{}");
    await writeFile(join(home, ".opencorp", "workspaces.json"), JSON.stringify({
      version: 1,
      ativo: "corp-teste",
      workspaces: [{ id: "corp-teste", criado_em: new Date().toISOString() }],
    }));

    const fakeSessoes = {
      async rodar() { return { id: "exec-1", status: "concluido", captura: "ok" }; },
      async listarExecucoes() { return []; },
      async logDe() { return "fake log"; },
    };

    opencodeServer = new OpencodeServerManager({
      homeDir: home,
      binario: join(__dirname, "fixtures", "fake-opencode.mjs"),
    });
    const { server: srv, token: tk, porta } = createApiServer({
      homeDir: home,
      token,
      sessoes: fakeSessoes as any,
      instalarMencoes: false,
      opencodeServer,
    } as ApiServerOptions);
    server = srv;
    token = tk;
    server.listen(0, "127.0.0.1");
    port = await porta;
    fetchApi = makeFetch(port, token);
    // iniciar secretário para muitos testes
    await fetchApi("/secretario/start", { method: "POST" });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await opencodeServer?.parar();
    await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("POST /secretario/conversa sem mensagem → 400", async () => {
    const { status, json } = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "" }),
    });
    expect(status).toBe(400);
    expect(json).toHaveProperty("erro");
  });

  it("POST /secretario/conversa sem mensagem e sem imagens → 400", async () => {
    const { status, json } = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "   " }),
    });
    expect(status).toBe(400);
  });

  it("POST /secretario/conversa/stream sem mensagem → 400", async () => {
    const { status, json } = await fetchApi("/secretario/conversa/stream", {
      method: "POST",
      body: JSON.stringify({ mensagem: "" }),
    });
    expect(status).toBe(400);
  });

  it("POST /secretario/sessoes/:id/truncar sem manter_ate → 400", async () => {
    // cria sessão primeiro
    const conv = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "olá para truncar" }),
    });
    const sid = (conv.json as any).sessao_id;
    const { status, json } = await fetchApi(`/secretario/sessoes/${sid}/truncar`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(status).toBe(400);
    expect(json).toHaveProperty("erro");
  });

  it("POST /secretario/sessoes/:id/truncar com manter_ate negativo → 400", async () => {
    const conv = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "outra" }),
    });
    const sid = (conv.json as any).sessao_id;
    const { status, json } = await fetchApi(`/secretario/sessoes/${sid}/truncar`, {
      method: "POST",
      body: JSON.stringify({ manter_ate: -1 }),
    });
    expect(status).toBe(400);
    expect(json.erro).toMatch(/manter_ate/);
  });

  it("POST /secretario/sessoes/:id/truncar com manter_ate string → 400", async () => {
    const conv = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "teste string" }),
    });
    const sid = (conv.json as any).sessao_id;
    const { status } = await fetchApi(`/secretario/sessoes/${sid}/truncar`, {
      method: "POST",
      body: JSON.stringify({ manter_ate: "um" }),
    });
    expect(status).toBe(400);
  });

  it("POST /secretario/sessoes/:id/truncar com manter_ate > total → 400", async () => {
    const conv = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "para range" }),
    });
    const sid = (conv.json as any).sessao_id;
    // essa sessão tem 2 msgs (user+assistant), total 2
    const { status, json } = await fetchApi(`/secretario/sessoes/${sid}/truncar`, {
      method: "POST",
      body: JSON.stringify({ manter_ate: 999 }),
    });
    expect(status).toBe(400);
    expect(json.erro).toMatch(/fora do range/);
  });

  it("POST /secretario/sessoes/:id/truncar com sessão inexistente → 404 ou 502", async () => {
    const { status, json } = await fetchApi(`/secretario/sessoes/ses_inexistente_123/truncar`, {
      method: "POST",
      body: JSON.stringify({ manter_ate: 0 }),
    });
    expect([404, 502]).toContain(status);
    expect(json).toHaveProperty("erro");
  });

  it("POST /secretario/sessoes/:id/truncar válido → trunca e GET retorna truncado", async () => {
    // cria sessão com 2 mensagens (user+assistant) via 2 turnos
    const c1 = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "primeira" }),
    });
    const sid = (c1.json as any).sessao_id;
    await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "segunda", sessao_id: sid }),
    });
    const antes = await fetchApi(`/secretario/sessoes/${sid}/mensagens`);
    expect(antes.status).toBe(200);
    expect((antes.json as any[]).length).toBeGreaterThanOrEqual(2);

    // trunca mantendo só 1 (primeira user+assistant? Na verdade manter_ate 1 mantém 1 msg)
    // manter_ate 1 mantém a primeira mensagem (user da primeira)
    const trunc = await fetchApi(`/secretario/sessoes/${sid}/truncar`, {
      method: "POST",
      body: JSON.stringify({ manter_ate: 1 }),
    });
    if (trunc.status !== 200) console.log("TRUNC FAIL 1", trunc.status, trunc.json, "sid", sid);
    expect(trunc.status).toBe(200);
    expect(trunc.json).toHaveProperty("ok", true);

    const depois = await fetchApi(`/secretario/sessoes/${sid}/mensagens`);
    expect(depois.status).toBe(200);
    expect((depois.json as any[]).length).toBe(1);
    expect((depois.json as any[])[0].content).toMatch(/primeira/);
  });

  it("POST /secretario/sessoes/:id/truncar com manter_ate 0 → limpa tudo", async () => {
    const c1 = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "para limpar" }),
    });
    const sid = (c1.json as any).sessao_id;
    const trunc = await fetchApi(`/secretario/sessoes/${sid}/truncar`, {
      method: "POST",
      body: JSON.stringify({ manter_ate: 0 }),
    });
    expect(trunc.status).toBe(200);
    const depois = await fetchApi(`/secretario/sessoes/${sid}/mensagens`);
    expect((depois.json as any[]).length).toBe(0);
  });

  it("PUT /settings secretary.model inválido (sem provider/) → erro", async () => {
    const { status, json } = await fetchApi("/settings", {
      method: "PUT",
      body: JSON.stringify({ chave: "secretary.model", valor: "invalido-sem-barra", scope: "global" }),
    });
    expect(status).toBeGreaterThanOrEqual(400);
    expect(json).toHaveProperty("erro");
  });

  it("PUT /settings secretary.model válido → 200", async () => {
    const { status } = await fetchApi("/settings", {
      method: "PUT",
      body: JSON.stringify({ chave: "secretary.model", valor: "opencode/muse-spark-1.2-contributor-free", scope: "global" }),
    });
    expect(status).toBe(200);
    // limpa
    await fetchApi("/settings", {
      method: "PUT",
      body: JSON.stringify({ chave: "secretary.model", valor: "", scope: "global" }),
    });
  });

  it("GET /secretario/sessoes/:id/mensagens com sessão inexistente → 404/502", async () => {
    const { status, json } = await fetchApi("/secretario/sessoes/naoexiste123/mensagens");
    expect([404, 502]).toContain(status);
    expect(json).toHaveProperty("erro");
  });
});
