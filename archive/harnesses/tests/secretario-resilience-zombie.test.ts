import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { createApiServer } from "../src/server/index.js";
import { streamsSecretarioAtivos } from "../src/server/routes/secretario/stream.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-sec-zombie-"));
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
    return { status: res.status, json, text, headers: res.headers };
  };
}

describe("Secretário — Resiliência, Detecção de Zumbis e Prevenção de Travamento", () => {
  let home: string;
  let token = "test-token-sec-zombie";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let fakeOpencode: Server;
  let fakeOpencodePort: number;
  let abortCount = 0;
  let fakeBusySessions = new Set<string>();
  let fakeMessagesMap = new Map<string, any[]>();
  let postMessageAttempts = 0;

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await mkdir(join(home, "workspaces", "ws-resilience", ".opencorp"), { recursive: true });
    await writeFile(
      join(home, "workspaces", "ws-resilience", ".opencorp", "config.json"),
      JSON.stringify({
        modelos: {
          padrao: "openrouter/fail-1:free",
          rotacao: ["openrouter/fail-1:free", "openrouter/fail-2:free"],
        },
      }),
    );
    await writeFile(
      join(home, ".opencorp", "workspaces.json"),
      JSON.stringify({
        version: 1,
        ativo: "ws-resilience",
        workspaces: [{ id: "ws-resilience", path: join(home, "workspaces", "ws-resilience"), criado_em: new Date().toISOString() }],
      }),
    );
    await writeFile(
      join(home, ".opencorp", "settings.json"),
      JSON.stringify({
        default_model: "openrouter/fail-1:free",
        tests: {
          rotation: ["openrouter/fail-1:free", "openrouter/fail-2:free"],
        },
      }),
    );

    fakeOpencode = createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/session" && req.method === "POST") {
        const id = `ses_fake_zombie_${Date.now()}`;
        fakeMessagesMap.set(id, []);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id }));
        return;
      }
      if (url === "/session/status" && req.method === "GET") {
        const statusMap: Record<string, any> = {};
        for (const sid of fakeBusySessions) {
          statusMap[sid] = { type: "busy" };
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(statusMap));
        return;
      }
      const abortMatch = url.match(/\/session\/([^/]+)\/abort/);
      if (abortMatch && req.method === "POST") {
        abortCount++;
        fakeBusySessions.delete(abortMatch[1]);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(true));
        return;
      }
      if (url.includes("/model") && req.method === "POST") {
        res.writeHead(204);
        res.end();
        return;
      }
      const msgMatch = url.match(/\/session\/([^/]+)\/message/);
      if (msgMatch && req.method === "GET") {
        const sid = msgMatch[1];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fakeMessagesMap.get(sid) ?? []));
        return;
      }
      if (msgMatch && req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (msgMatch && req.method === "POST") {
        postMessageAttempts++;
        const sid = msgMatch[1];
        // Simula falha imediata 500 para testar fallback de erro
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "all models fail simulation" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      fakeOpencode.listen(0, "127.0.0.1", () => {
        const addr = fakeOpencode.address() as any;
        fakeOpencodePort = addr.port;
        resolve();
      });
    });

    const fakeServerManager = {
      async status() {
        return { rodando: true, pid: 99999, porta: fakeOpencodePort, agente: "secretario" };
      },
      async configurado() { return true; },
      async iniciar() { return { pid: 99999, porta: fakeOpencodePort }; },
      async parar() {},
    } as any;

    const app = createApiServer({
      homeDir: home,
      porta: 0,
      token,
      opencodeServer: fakeServerManager,
    });
    server = app.server;
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        port = addr.port;
        fetchApi = makeFetch(port, token);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => fakeOpencode.close(r));
    for (const r of raizes) {
      await rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("recupera sessão zumbi que ficou travada em 'busy' sem stream ativo", async () => {
    const sid = "ses_zombie_stuck_test";
    abortCount = 0;
    fakeBusySessions.add(sid);

    // Mensagem criada há mais de 45 segundos sem completed e sem conteúdo
    fakeMessagesMap.set(sid, [
      {
        info: { id: "msg_user_1", role: "user", time: { created: Date.now() - 55_000 } },
        parts: [{ type: "text", text: "pergunta que travou" }],
      },
      {
        info: { id: "msg_asst_1", role: "assistant", time: { created: Date.now() - 50_000 } },
        parts: [{ type: "step-start" }],
      },
    ]);

    expect(streamsSecretarioAtivos.has(sid)).toBe(false);

    // Consulta mensagens da sessão pelo endpoint do Secretário
    const res = await fetchApi(`/secretario/sessoes/${sid}/mensagens`);
    expect(res.status).toBe(200);

    const msgs = (res.json as any).mensagens ?? res.json;
    expect(Array.isArray(msgs)).toBe(true);
    expect(msgs.length).toBe(2);

    const asst = msgs[1];
    expect(asst.role).toBe("assistant");
    // Deve ter sido marcado como concluída (não pendente indefinidamente)
    expect(asst.concluida).toBe(true);
    // Deve conter aviso textual informando a interrupção/timeout
    expect(asst.content).toContain("interrompida");

    // Deve ter chamado /abort no motor opencode para liberar o estado busy
    expect(abortCount).toBeGreaterThanOrEqual(1);
    expect(fakeBusySessions.has(sid)).toBe(false);
  });

  it("POST /secretario/sessoes/:id/abort aborta sessão travada diretamente", async () => {
    const sid = "ses_manual_abort_test";
    fakeBusySessions.add(sid);
    const res = await fetchApi(`/secretario/sessoes/${sid}/abort`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(fakeBusySessions.has(sid)).toBe(false);
  });

  it("limita tentativas de fallback ao número de modelos sem loop 3x", async () => {
    postMessageAttempts = 0;
    const res = await fetch(`http://127.0.0.1:${port}/secretario/conversa/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mensagem: "teste limite tentativas" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    // O stream deve terminar com evento de erro, não com timeout de 10 minutos
    expect(text).toContain("event: erro");
    // O número de tentativas deve respeitar a quantidade de modelos candidatos na cadeia (sem loop infinito repetido por modelo)
    expect(postMessageAttempts).toBeLessThanOrEqual(3);
    expect(postMessageAttempts).toBeGreaterThanOrEqual(2);
  });
});
