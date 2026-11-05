import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApiServer, type ApiServerOptions } from "../src/server/index.js";
import { OpencodeServerManager } from "../src/core/contexts/execution/opencode-server.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-secretario-proxy-"));
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
    return { status: res.status, json, headers: res.headers };
  };
}

describe("Secretário Proxy — /secretario/*", () => {
  let home: string;
  let token = "test-token-secretario";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let opencodeServer: OpencodeServerManager;

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    // Criar workspace para testes
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

    // OpencodeServerManager real (usa portaLivre, spawn, etc.)
    // O test vai chamar /secretario/start que vai spawnear o fake-opencode
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
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await opencodeServer?.parar();
    await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("GET /secretario/status sem iniciar → rodando=false, configurado=false", async () => {
    const { status, json } = await fetchApi("/secretario/status");
    expect(status).toBe(200);
    expect(json).toEqual(expect.objectContaining({ rodando: false, configurado: false }));
  });

  it("POST /secretario/start → inicia fake opencode, retorna pid/porta", async () => {
    const { status, json } = await fetchApi("/secretario/start", { method: "POST" });
    expect(status).toBe(200);
    expect(json).toHaveProperty("pid");
    expect(json).toHaveProperty("porta");
    expect(typeof json.pid).toBe("number");
    expect(typeof json.porta).toBe("number");
  });

  it("GET /secretario/status após start → rodando=true, configurado=true", async () => {
    const { status, json } = await fetchApi("/secretario/status");
    expect(status).toBe(200);
    expect(json.rodando).toBe(true);
    expect(json.configurado).toBe(true);
    expect(json.pid).toBeGreaterThan(0);
    expect(json.porta).toBeGreaterThan(0);
  });

  it("GET /secretario/sessoes (proxy) → lista sessões do fake", async () => {
    const { status, json } = await fetchApi("/secretario/sessoes");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it("POST /secretario/conversa sem sessao_id → cria sessão, envia mensagem, retorna resposta", async () => {
    const { status, json } = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Olá, secretário!" }),
    });
    expect(status).toBe(200);
    expect(json).toHaveProperty("sessao_id");
    expect(json).toHaveProperty("resposta");
    expect(typeof json.resposta).toBe("string");
    expect(json.resposta.length).toBeGreaterThan(0);
  });

  it("POST /secretario/conversa com sessao_id existente → continua conversa", async () => {
    const first = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Primeira mensagem" }),
    });
    expect(first.status).toBe(200);
    const sessaoId = (first.json as any).sessao_id;

    const { status, json } = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Segunda mensagem", sessao_id: sessaoId }),
    });
    expect(status).toBe(200);
    expect(json.sessao_id).toBe(sessaoId);
    expect(json.resposta).toBeDefined();
  });

  it("GET /secretario/sessoes/:id → detalhe da sessão", async () => {
    const first = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Para detalhe" }),
    });
    const sessaoId = (first.json as any).sessao_id;

    const { status, json } = await fetchApi(`/secretario/sessoes/${sessaoId}`);
    expect(status).toBe(200);
    expect(json.id).toBe(sessaoId);
    expect(json.messages).toBeDefined();
  });

  it("POST /secretario/stop → para o servidor", async () => {
    const { status, json } = await fetchApi("/secretario/stop", { method: "POST" });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it("GET /secretario/status após stop → rodando=false", async () => {
    const { status, json } = await fetchApi("/secretario/status");
    expect(status).toBe(200);
    expect(json.rodando).toBe(false);
  });

  it("POST /secretario/conversa sem iniciar → 409", async () => {
    // O servidor já foi parado no teste anterior
    const { status, json } = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "teste" }),
    });
    expect(status).toBe(409);
    expect(json).toHaveProperty("erro");
  });

  it("GET /secretario/sessoes sem iniciar → 200 resiliente (fallback local)", async () => {
    const { status, json } = await fetchApi("/secretario/sessoes");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });
});
