/**
 * Servidor falso que reproduz o contrato do `opencode serve` 1.18.32
 * (conferido na OpenAPI `/doc` e em servidor real):
 *
 *   - HTTP Basic `opencode:<OPENCODE_SERVER_PASSWORD>` em todas as rotas;
 *   - `POST /session/:id/message` e `prompt_async` exigem `parts`;
 *   - streaming via `prompt_async` (204) + SSE `GET /event`;
 *   - permissões em `POST /session/:id/permissions/:permissionID`.
 *
 * Vocabulário de cenários pelo texto da mensagem: contém "erro" → session.error;
 * "lento" → só termina se abortado; "permissão" → pede aprovação antes de responder.
 * Caso contrário responde "Olá, resposta para: <texto>" em deltas, com uma ferramenta.
 */
import { createServer, type Server, type ServerResponse } from "node:http";

export interface FakeOpenCode {
  server: Server;
  port: number;
  requests: Array<{ method: string; url: string; body: any }>;
  permissionReplies: Array<{ id: string; response: string }>;
  sessions: Set<string>;
  close(): Promise<void>;
}

/** `replyPrefix` troca o início da resposta (o E2E usa o texto do fake antigo). */
export function startFakeOpenCode(
  port: number,
  password: string,
  replyPrefix = "Olá, resposta para: ",
  /** Resposta alternativa por texto (o E2E usa para perguntas com opções). */
  customReply?: (text: string) => string | undefined,
): Promise<FakeOpenCode> {
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const subscribers = new Set<ServerResponse>();
  const pendingPermission = new Map<string, () => void>();
  let seq = 0;
  const fake: FakeOpenCode = {
    server: undefined as unknown as Server,
    port,
    requests: [],
    permissionReplies: [],
    sessions: new Set(),
    close: () => new Promise<void>((resolve) => {
      fake.server.closeAllConnections?.();
      fake.server.close(() => resolve());
    }),
  };

  const emit = (type: string, properties: Record<string, unknown>) => {
    const data = JSON.stringify({ id: `evt_${++seq}`, type, properties });
    for (const res of subscribers) res.write(`data: ${data}\n\n`);
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  // Um turno: busy → mensagem do assistente → texto em deltas → ferramenta → idle.
  const runTurn = async (sessionID: string, text: string) => {
    const messageID = `msg_a${++seq}`;
    const partID = `prt_t${seq}`;
    // Evento de outra sessão: deve ser ignorado pelo adaptador.
    emit("message.part.delta", { sessionID: "ses_outra", messageID: "msg_x", partID: "prt_x", field: "text", delta: "VAZOU" });
    emit("session.status", { sessionID, status: { type: "busy" } });
    emit("message.updated", { sessionID, info: { id: messageID, sessionID, role: "assistant", time: { created: Date.now() } } });

    if (text.includes("erro")) {
      emit("session.error", { sessionID, error: { name: "ProviderAuthError", data: { message: "Model not found: x/y" } } });
      emit("session.idle", { sessionID });
      return;
    }
    if (text.includes("lento")) return; // só termina se for abortado

    if (text.includes("permissão")) {
      const permissionID = `per_${seq}`;
      await new Promise<void>((resolve) => {
        pendingPermission.set(permissionID, resolve);
        emit("permission.asked", { id: permissionID, sessionID, permission: "bash", patterns: ["git push origin main"], metadata: {}, always: [] });
      });
    }

    emit("message.part.updated", { sessionID, time: Date.now(), part: { id: partID, sessionID, messageID, type: "text", text: "" } });
    const corpo = customReply?.(text) ?? `${replyPrefix}${text}`;
    for (const delta of [corpo.slice(0, 5), corpo.slice(5, 20), corpo.slice(20)]) {
      emit("message.part.delta", { sessionID, messageID, partID, field: "text", delta });
    }
    // Atualização final da parte com o texto completo: não pode duplicar.
    emit("message.part.updated", { sessionID, time: Date.now(), part: { id: partID, sessionID, messageID, type: "text", text: corpo } });
    emit("message.part.updated", {
      sessionID,
      time: Date.now(),
      part: { id: `prt_tool${seq}`, sessionID, messageID, type: "tool", callID: "call_1", tool: "read", state: { status: "completed", input: { filePath: "a.txt" }, output: "conteúdo", title: "a.txt", metadata: {}, time: { start: 1, end: 2 } } },
    });
    emit("message.updated", {
      sessionID,
      info: { id: messageID, sessionID, role: "assistant", time: { created: 1, completed: 2 }, cost: 0.001, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 0, write: 0 } } },
    });
    emit("session.idle", { sessionID });
  };

  fake.server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url || "";
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
      fake.requests.push({ method: req.method || "", url, body });

      if (req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" });
      if (url === "/health") return json(res, 200, { ok: true });

      if (url === "/event" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", properties: {} })}\n\n`);
        subscribers.add(res);
        res.on("close", () => subscribers.delete(res));
        return;
      }
      if (url === "/session" && req.method === "POST") {
        const id = `ses_${fake.sessions.size + 1}${port}`;
        fake.sessions.add(id);
        return json(res, 200, { id, title: body?.title });
      }
      const m = /^\/session\/([^/]+)(\/[^?]*)?$/.exec(url);
      if (!m) return json(res, 404, { error: "not found" });
      const sessionID = decodeURIComponent(m[1]!);
      const rest = m[2] ?? "";
      if (!fake.sessions.has(sessionID)) return json(res, 404, { name: "NotFoundError" });

      if (rest === "" && req.method === "GET") return json(res, 200, { id: sessionID });
      if (rest === "/message" && req.method === "POST") {
        if (!Array.isArray(body?.parts)) return json(res, 400, { name: "BadRequest", data: { message: 'Missing key\n  at ["parts"]' } });
        return json(res, 200, { info: { role: "assistant" }, parts: [] });
      }
      if (rest === "/prompt_async" && req.method === "POST") {
        if (!Array.isArray(body?.parts)) return json(res, 400, { name: "BadRequest", data: { message: 'Missing key\n  at ["parts"]' } });
        res.writeHead(204);
        res.end();
        const text = String(body.parts.find((p: any) => p.type === "text")?.text ?? "");
        setTimeout(() => void runTurn(sessionID, text), 5);
        return;
      }
      if (rest === "/abort" && req.method === "POST") {
        emit("session.error", { sessionID, error: { name: "MessageAbortedError", data: { message: "aborted" } } });
        emit("session.idle", { sessionID });
        return json(res, 200, true);
      }
      if (rest === "/fork" && req.method === "POST") {
        const id = `ses_fork${fake.sessions.size + 1}`;
        fake.sessions.add(id);
        return json(res, 200, { id });
      }
      const perm = /^\/permissions\/([^/]+)$/.exec(rest);
      if (perm && req.method === "POST") {
        const id = decodeURIComponent(perm[1]!);
        const resume = pendingPermission.get(id);
        if (!resume) return json(res, 404, { name: "NotFoundError" });
        fake.permissionReplies.push({ id, response: body?.response });
        pendingPermission.delete(id);
        json(res, 200, true);
        resume();
        return;
      }
      if (rest === "" && req.method === "DELETE") return json(res, 200, true);
      return json(res, 404, { error: "not found" });
    });
  });

  return new Promise((resolve) => {
    fake.server.listen(port, "127.0.0.1", () => resolve(fake));
  });
}
