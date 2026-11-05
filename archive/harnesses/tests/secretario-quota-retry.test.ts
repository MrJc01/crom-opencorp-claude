import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { createApiServer } from "../src/server/index.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-sec-quota-"));
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

describe("Secretário — Resiliência a Cota Excedida e Detecção de Retry Status", () => {
  let home: string;
  let token = "test-token-sec-quota";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let fakeOpencode: Server;
  let fakeOpencodePort: number;
  let sessionStatusMock: Record<string, any> = {};
  let switchedModels: string[] = [];

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await mkdir(join(home, "workspaces", "corp-quota", ".opencorp"), { recursive: true });
    await writeFile(
      join(home, "workspaces", "corp-quota", ".opencorp", "config.json"),
      JSON.stringify({
        modelos: {
          padrao: "opencode-go/glm-5.3-flash",
          rotacao: [
            "opencode-go/glm-5.3-flash",
            "google/gemini-3.6-flash",
          ],
        },
      }),
    );
    await writeFile(
      join(home, ".opencorp", "workspaces.json"),
      JSON.stringify({
        version: 1,
        ativo: "corp-quota",
        workspaces: [{ id: "corp-quota", path: join(home, "workspaces", "corp-quota"), criado_em: new Date().toISOString() }],
      }),
    );
    await writeFile(
      join(home, ".opencorp", "settings.json"),
      JSON.stringify({
        secretary: {
          model: "opencode-go/glm-5.3-flash",
        },
        tests: {
          rotation: [
            "opencode-go/glm-5.3-flash",
            "google/gemini-3.6-flash",
          ],
        },
      }),
    );

    // Mock OpenCode Server
    fakeOpencode = createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/session" && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ses-quota-test-1" }));
        return;
      }
      if (url === "/session/status" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(sessionStatusMock));
        return;
      }
      if (url.includes("/model") && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");
        if (parsed.model) {
          switchedModels.push(`${parsed.model.providerID}/${parsed.model.id}`);
        }
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.includes("/abort") && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("true");
        return;
      }
      if (url.includes("/message") && req.method === "DELETE") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.includes("/message") && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body || "{}");

        // Se o modelo for opencode-go, simula que colocou a sessão em retry de cota e pendurou
        if (parsed.model?.providerID === "opencode-go" || (!parsed.model && switchedModels.length === 0)) {
          sessionStatusMock["ses-quota-test-1"] = {
            type: "retry",
            attempt: 1,
            message: "monthly usage limit reached. It will reset in 19 days.",
          };
          // Não responde imediatamente para simular o comportamento real do daemon do opencode
          await new Promise((r) => setTimeout(r, 2500));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ info: { role: "assistant" }, parts: [] }));
          return;
        }

        // Se for o modelo de fallback (google/gemini-3.6-flash), limpa o status e responde sucesso
        sessionStatusMock["ses-quota-test-1"] = { type: "busy" };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            info: { role: "assistant", time: { completed: Date.now() } },
            parts: [{ type: "text", text: "Olá! Respondendo via Google Gemini fallback após cota excedida." }],
          }),
        );
        delete sessionStatusMock["ses-quota-test-1"];
        return;
      }
      if (url.includes("/message") && req.method === "GET") {
        // Mensagens simuladas
        if (sessionStatusMock["ses-quota-test-1"]?.type === "retry") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify([
              { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "teste cota" }] },
              { info: { role: "assistant", id: "a1" }, parts: [] },
            ]),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "teste cota" }] },
            {
              info: { role: "assistant", id: "a2", time: { completed: Date.now() } },
              parts: [{ type: "text", text: "Resposta completa pós-fallback" }],
            },
          ]),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      fakeOpencode.listen(0, "127.0.0.1", () => {
        const addr = fakeOpencode.address() as { port: number };
        fakeOpencodePort = addr.port;
        resolve();
      });
    });

    const fakeManager = {
      status: async () => ({ rodando: true, porta: fakeOpencodePort, pid: 1234 }),
      iniciar: async () => ({ pid: 1234, porta: fakeOpencodePort }),
      parar: async () => {},
      configurado: async () => true,
    } as any;

    const apiInst = createApiServer({
      homeDir: home,
      token,
      porta: 0,
      opencodeServer: fakeManager,
    });
    server = apiInst.server;
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
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fakeOpencode) await new Promise<void>((resolve) => fakeOpencode.close(() => resolve()));
    await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
  });

  it("GET /secretario/sessoes/:id/mensagens expõe aviso amigável quando opencode daemon está em status retry por cota", async () => {
    sessionStatusMock["ses-quota-test-1"] = {
      type: "retry",
      attempt: 1,
      message: "monthly usage limit reached. Resets in 19 days.",
    };

    const res = await fetchApi("/secretario/sessoes/ses-quota-test-1/mensagens");
    expect(res.status).toBe(200);
    const msgs = res.json as any[];
    expect(Array.isArray(msgs)).toBe(true);

    // O assistente não deve desaparecer nem ficar em branco; deve expor o aviso de cota
    const assistente = msgs.find((m) => m.role === "assistant");
    expect(assistente).toBeDefined();
    expect(assistente.content).toContain("Limite de Cota");
    expect(assistente.concluida).toBe(true);
  });

  it("POST /secretario/conversa/stream detecta status retry, aborta sessão travada e faz fallback para o próximo modelo", async () => {
    sessionStatusMock = {};
    switchedModels = [];

    const res = await fetch(`http://127.0.0.1:${port}/secretario/conversa/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        mensagem: "testando contingência automática",
      }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();

    // Deve conter emissão de status fallback_modelo avisando a troca automática devido à cota
    expect(text).toContain("fallback_modelo");
    expect(text).toContain("monthly usage limit reached");
    expect(text).toContain("delta");
    expect(text).toContain("Respondendo via Google Gemini fallback após cota excedida");
    expect(text).toContain("event: fim");
  });
});
