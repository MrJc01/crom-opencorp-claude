import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { createApiServer } from "../src/server/index.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";

const raizes: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "opencorp-sec-docs-"));
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
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
}

describe("Rotas Modulares de Secretário e Documentos/Registries (Micro-Passo 14)", () => {
  let home: string;
  let wsDir: string;
  let token = "test-token-sec-docs";
  let port: number;
  let fetchApi: ReturnType<typeof makeFetch>;
  let server: ReturnType<typeof createApiServer>["server"];
  let fakeOpencode: Server;
  let fakeOpencodePort: number;

  beforeAll(async () => {
    home = await tmpDir();
    wsDir = join(home, "workspaces", "default");
    await mkdir(wsDir, { recursive: true });

    // Workspace padrão
    const wm = new WorkspaceManager({ homeDir: home, cwd: home });
    await wm.criar("default");
    await wm.usar("default");

    // Fake OpenCode Server
    fakeOpencode = createServer((req, res) => {
      if (req.url?.includes("/session")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "fake-session-123" }));
        return;
      }
      if (req.url?.includes("/prompt")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify([
            { info: { role: "user", id: "u1" }, parts: [{ type: "text", text: "teste" }] },
            {
              info: { role: "assistant", id: "a1", time: { completed: Date.now() } },
              parts: [{ type: "text", text: "Olá! Sou o Secretário." }],
            },
          ]),
        );
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    await new Promise<void>((res) => {
      fakeOpencode.listen(0, "127.0.0.1", () => {
        fakeOpencodePort = (fakeOpencode.address() as any).port;
        res();
      });
    });

    const fakeManager = {
      status: async () => ({ rodando: true, porta: fakeOpencodePort, pid: 9999 }),
      iniciar: async () => ({ pid: 9999, porta: fakeOpencodePort }),
      parar: async () => {},
      configurado: async () => true,
    } as any;

    const fakeSessoes = {
      async rodar(opcoes: any) {
        return {
          id: opcoes.execId ?? "exec-teste-sec",
          agente: opcoes.agente,
          ordem: opcoes.ordem,
          status: "concluido",
        };
      },
      async listarExecucoes() {
        return [];
      },
      async logDe() {
        return "log";
      },
    } as any;

    const apiInst = createApiServer({
      homeDir: home,
      token,
      porta: 0,
      opencodeServer: fakeManager,
      sessoes: fakeSessoes,
    });
    server = apiInst.server;

    await new Promise<void>((res) => {
      server.listen(0, "127.0.0.1", () => {
        port = (server.address() as any).port;
        fetchApi = makeFetch(port, token);
        res();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((res) => server.close(() => res()));
    if (fakeOpencode) await new Promise<void>((res) => fakeOpencode.close(() => res()));
    for (const r of raizes) {
      await rm(r, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe("Endpoints de Documentos e Registries (docs.ts)", () => {
    it("GET /docs lista catálogo de documentos do sistema", async () => {
      const res = await fetchApi("/docs");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      expect(res.json.length).toBeGreaterThan(0);
      expect(res.json[0]).toHaveProperty("slug");
      expect(res.json[0]).toHaveProperty("titulo");
    });

    it("GET /documentos funciona como alias para /docs e suporta filtro de busca", async () => {
      const res = await fetchApi("/documentos?q=visao");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
      const match = res.json.find((d: any) => d.slug.includes("visao"));
      expect(match).toBeDefined();
    });

    it("GET /docs/:slug retorna conteúdo e metadados de documento", async () => {
      const listRes = await fetchApi("/docs");
      const primeiro = listRes.json[0];
      const res = await fetchApi(`/docs/${primeiro.slug}`);
      expect(res.status).toBe(200);
      expect(res.json.slug).toBe(primeiro.slug);
      expect(typeof res.json.conteudo).toBe("string");
    });

    it("GET /docs/:slug inexistente retorna 404", async () => {
      const res = await fetchApi("/docs/documento-que-nao-existe-xyz-123");
      expect(res.status).toBe(404);
    });

    it("POST /docs cria documento markdown no workspace e PUT atualiza", async () => {
      const novoSlug = "doc-teste-integracao";
      const postRes = await fetchApi("/docs", {
        method: "POST",
        body: JSON.stringify({
          slug: novoSlug,
          titulo: "Documento de Teste",
          categoria: "Testes",
          conteudo: "# Documento de Teste\nCriado via teste unitário.",
        }),
      });
      expect(postRes.status).toBe(201);
      expect(postRes.json.ok).toBe(true);

      // Leitura
      const getRes = await fetchApi(`/docs/${novoSlug}`);
      expect(getRes.status).toBe(200);
      expect(getRes.json.conteudo).toContain("Criado via teste unitário");

      // Atualização
      const putRes = await fetchApi(`/docs/${novoSlug}`, {
        method: "PUT",
        body: JSON.stringify({
          conteudo: "# Atualizado\nConteúdo atualizado com sucesso.",
        }),
      });
      expect(putRes.status).toBe(200);
      expect(putRes.json.ok).toBe(true);

      // Remoção
      const delRes = await fetchApi(`/docs/${novoSlug}`, {
        method: "DELETE",
      });
      expect(delRes.status).toBe(200);
      expect(delRes.json.ok).toBe(true);
    });

    it("GET /registries/chats retorna registros ou lista vazia", async () => {
      const res = await fetchApi("/registries/chats");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.json)).toBe(true);
    });
  });

  describe("Endpoints do Secretário (secretario.ts)", () => {


    it("GET /secretario/contexto retorna resumo do workspace e sistema", async () => {
      const res = await fetchApi("/secretario/contexto");
      expect(res.status).toBe(200);
      expect(res.json).toHaveProperty("workspace");
    });

    it("GET /secretario/sugestoes retorna lista de propostas", async () => {
      const res = await fetchApi("/secretario/sugestoes");
      expect(res.status).toBe(200);
      expect(res.json).toHaveProperty("sugestoes");
      expect(Array.isArray(res.json.sugestoes)).toBe(true);
    });

    it("POST /secretario/conversa processa comando /status diretamente", async () => {
      const res = await fetchApi("/secretario/conversa", {
        method: "POST",
        body: JSON.stringify({
          mensagem: "/status",
        }),
      });
      expect(res.status).toBe(200);
      expect(res.json).toHaveProperty("resposta");
      expect(typeof res.json.resposta).toBe("string");
    });

    it("POST /secretario/conversa processa comando /ajuda diretamente", async () => {
      const res = await fetchApi("/secretario/conversa", {
        method: "POST",
        body: JSON.stringify({
          mensagem: "/help",
        }),
      });
      expect(res.status).toBe(200);
      expect(res.json.resposta).toContain("Comandos rápidos");
    });

    it("POST /secretario/git executa comando git do workspace", async () => {
      const res = await fetchApi("/secretario/git", {
        method: "POST",
        body: JSON.stringify({
          comando: "/git status",
        }),
      });
      expect(res.status).toBe(200);
      expect(res.json.ok).toBe(true);
      expect(res.json).toHaveProperty("mensagem");
    });

    it("POST /secretario/ordem valida obrigatoriedade de agente e ordem", async () => {
      const resInvalido = await fetchApi("/secretario/ordem", {
        method: "POST",
        body: JSON.stringify({}),
      });
      expect(resInvalido.status).toBe(400);

      const resValido = await fetchApi("/secretario/ordem", {
        method: "POST",
        body: JSON.stringify({
          agente: "dev",
          ordem: "teste de ordem direta",
        }),
      });
      expect(resValido.status).toBe(200);
      expect(resValido.json).toHaveProperty("id");
    });
  });
});
