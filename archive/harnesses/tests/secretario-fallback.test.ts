import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { createApiServer } from "../src/server/index.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-sec-fallback-"));
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

describe("Secretário — Fallback e Hot-Swap Automático de Modelo", () => {
  let home: string;
  let token = "test-token-sec-fallback";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let fakeOpencode: Server;
  let fakeOpencodePort: number;
  let switchedModels: string[] = [];
  let messageAttempts = 0;

  beforeAll(async () => {
    home = await tmpDir();
    await mkdir(join(home, ".opencorp"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });
    await mkdir(join(home, "workspaces", "corp-teste", ".opencorp"), { recursive: true });
    await writeFile(
      join(home, "workspaces", "corp-teste", ".opencorp", "config.json"),
      JSON.stringify({
        modelos: {
          padrao: "openrouter/fail-first:free",
          rotacao: [
            "openrouter/fail-first:free",
            "openrouter/minimax/minimax-m3:free",
          ],
        },
      }),
    );
    await writeFile(
      join(home, ".opencorp", "workspaces.json"),
      JSON.stringify({
        version: 1,
        ativo: "corp-teste",
        workspaces: [{ id: "corp-teste", path: join(home, "workspaces", "corp-teste"), criado_em: new Date().toISOString() }],
      }),
    );
    // Configura rotação com 2 modelos no settings.json
    await writeFile(
      join(home, ".opencorp", "settings.json"),
      JSON.stringify({
        default_model: "openrouter/fail-first:free",
        tests: {
          rotation: [
            "openrouter/fail-first:free",
            "openrouter/minimax/minimax-m3:free",
          ],
        },
      }),
    );

    // Fake OpenCode Server que simula:
    // - POST /session: cria sessão
    // - POST /api/session/:id/model: registra troca de modelo
    // - POST /session/:id/message:
    //     se modelo for "fail-first", responde HTTP 500 / 429
    //     se modelo for "minimax-m3", responde com sucesso
    let fakeMessages: any[] = [];
    fakeOpencode = createServer(async (req, res) => {
      const url = req.url ?? "/";
      if (url === "/session" && req.method === "POST") {
        fakeMessages = [];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "ses-fake-fallback-1" }));
        return;
      }
      if (url.includes("/model") && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = JSON.parse(body);
        switchedModels.push(`${parsed.model.providerID}/${parsed.model.id}`);
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.includes("/abort") && req.method === "POST") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(true));
        return;
      }
      if (url.includes("/message") && req.method === "DELETE") {
        const idToDelete = url.split("/").pop();
        fakeMessages = fakeMessages.filter((m) => m.info?.id !== idToDelete);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.includes("/message") && req.method === "POST") {
        messageAttempts++;
        let body = "";
        for await (const chunk of req) body += chunk;
        const parsed = body ? JSON.parse(body) : {};
        const userMsg = {
          info: { id: `msg-usr-${messageAttempts}`, role: "user", time: { created: Date.now() } },
          parts: parsed.parts || [{ type: "text", text: "" }],
        };
        fakeMessages.push(userMsg);

        const currentModel = switchedModels[switchedModels.length - 1];
        if (!currentModel || currentModel.includes("fail-first")) {
          // Primeiro modelo falha imediatamente
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "rate limit or provider failure" }));
          return;
        }
        // Modelo secundário responde sucesso
        const asstMsg = {
          info: { id: `msg-asst-${messageAttempts}`, role: "assistant", time: { completed: Date.now() } },
          parts: [{ type: "text", text: "Resposta recuperada via fallback!" }],
        };
        fakeMessages.push(asstMsg);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(asstMsg));
        return;
      }
      if (url.includes("/message") && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(fakeMessages));
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

    // Mock OpencodeServerManager apontando para a porta do fakeOpencode
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

  it("POST /secretario/conversa cai no fallback e responde quando o primeiro modelo falha", async () => {
    switchedModels = [];
    messageAttempts = 0;

    const res = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "Olá teste de fallback" }),
    });

    expect(res.status).toBe(200);
    const data = res.json as any;
    expect(data.resposta).toBe("Resposta recuperada via fallback!");
    expect(messageAttempts).toBeGreaterThanOrEqual(2);
    expect(switchedModels).toContain("openrouter/minimax/minimax-m3:free");
  });

  it("POST /secretario/conversa/stream emite evento de status e conclui via fallback", async () => {
    switchedModels = [];
    messageAttempts = 0;

    const res = await fetch(`http://127.0.0.1:${port}/secretario/conversa/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ mensagem: "Olá stream fallback" }),
    });

    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: status");
    expect(text).toContain("fallback_modelo");
    expect(text).toContain("event: fim");
    expect(switchedModels).toContain("openrouter/minimax/minimax-m3:free");
  });

  it("não duplica prompt do usuário no histórico quando ocorre fallback e reenvio de modelo", async () => {
    switchedModels = [];
    messageAttempts = 0;

    const res = await fetchApi("/secretario/conversa", {
      method: "POST",
      body: JSON.stringify({ mensagem: "prompt com contingencia sem duplicar" }),
    });

    expect(res.status).toBe(200);
    expect(messageAttempts).toBeGreaterThanOrEqual(2);

    const sId = (res.json as any).sessao_id;
    const msgRes = await fetchApi(`/secretario/sessoes/${encodeURIComponent(sId)}/mensagens`);
    expect(msgRes.status).toBe(200);
    const msgs = (msgRes.json as any).mensagens ?? msgRes.json;
    const userMsgs = (Array.isArray(msgs) ? msgs : []).filter((m: any) => m.role === "user");

    // O prompt do usuário deve constar exatamente 1 vez, sem duplicatas
    expect(userMsgs.length).toBe(1);
    expect(userMsgs[0].content).toBe("prompt com contingencia sem duplicar");
  });
});
