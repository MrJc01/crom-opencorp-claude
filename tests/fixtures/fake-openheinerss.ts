/**
 * Servidor Openheinerss falso, em memória, que fala o protocolo JSON-RPC/NDJSON de
 * docs/02-protocol-spec.md. Vocabulário dos prompts: "lento" (só termina com session.abort),
 * "permissão" (pede aprovação), "erro" (agent.error), "ferramenta" (tool_call + tool_result),
 * "escreva" (tool_call de edição), "rpc-erro" (session.prompt devolve erro JSON-RPC).
 */
import { PassThrough } from "node:stream";
import type { JsonRpcTransport } from "../../src/core/engines/acp/json-rpc-connection.js";

export interface FakeOpenheinerssProcess extends JsonRpcTransport {
  pid: number;
  alive: boolean;
  /** Requisições recebidas, em ordem. */
  received: Array<{ method: string; params: any }>;
}

let nextPid = Number(process.env.FAKE_OPENHEINERSS_PID_BASE) || 7000;

export function createFakeOpenheinerss(): FakeOpenheinerssProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let resolveExit!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => { resolveExit = resolve; });
  const sessions = new Map<string, { harness: string; cwd: string }>();
  const aborted = new Set<string>();
  const waiting = new Map<string, (decision: string) => void>();
  let sessionCounter = 0;
  let buffer = "";

  const proc: FakeOpenheinerssProcess = {
    pid: ++nextPid,
    alive: true,
    received: [],
    stdout,
    stderr,
    exitCode,
    write(data: string) {
      buffer += data;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(JSON.parse(line));
      }
      return true;
    },
    kill() {
      if (!proc.alive) return;
      proc.alive = false;
      stdout.end();
      stderr.end();
      resolveExit(0);
    },
  };

  const emit = (obj: unknown) => { if (proc.alive) stdout.write(`${JSON.stringify(obj)}\n`); };
  const notify = (method: string, params: unknown) => emit({ jsonrpc: "2.0", geracao: "g1", method, params });
  const reply = (id: unknown, result: unknown) => emit({ jsonrpc: "2.0", id, geracao: "g1", result });
  const fail = (id: unknown, code: number, message: string) => emit({ jsonrpc: "2.0", id, geracao: "g1", error: { code, message } });
  const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

  async function turn(sessionId: string, text: string) {
    await tick();
    if (!proc.alive) return;
    notify("agent.thinking", { sessionId, delta: "pensando" });
    if (text.includes("lento")) {
      notify("agent.text", { sessionId, delta: "começando..." });
      while (!aborted.has(sessionId) && proc.alive) await tick(10);
      aborted.delete(sessionId);
      notify("agent.complete", { sessionId, reason: "aborted" });
      return;
    }
    if (text.includes("erro")) {
      notify("agent.error", { sessionId, message: "Model not found: fake", code: 4002, suggestedFix: "escolha outro modelo" });
      return;
    }
    if (text.includes("permissão")) {
      notify("agent.permission_request", { sessionId, requestId: `perm_${sessionId}`, tool: "Bash", command: "git status", risk: "medium" });
      const decision = await new Promise<string>((resolve) => waiting.set(`perm_${sessionId}`, resolve));
      if (decision === "deny") {
        notify("agent.text", { sessionId, delta: "negado" });
        notify("agent.complete", { sessionId, reason: "finished" });
        return;
      }
      notify("agent.tool_call", { sessionId, callId: "c1", tool: "Bash", input: { command: "git status" } });
      notify("agent.tool_result", { sessionId, callId: "c1", status: "success", output: "limpo" });
    }
    if (text.includes("ferramenta")) {
      notify("agent.tool_call", { sessionId, callId: "t1", tool: "Read", input: { path: "a.txt" } });
      notify("agent.tool_result", { sessionId, callId: "t1", status: "success", output: "conteúdo" });
    }
    if (text.includes("escreva")) {
      notify("agent.tool_call", { sessionId, callId: "w1", tool: "Write", input: { path: "out.md", content: "x" } });
      notify("agent.tool_result", { sessionId, callId: "w1", status: "success", output: "ok" });
    }
    notify("agent.raw", { sessionId, stream: "stderr", line: "ruído" });
    notify("agent.text", { sessionId, delta: "Resposta: " });
    notify("agent.text", { sessionId, delta: text });
    notify("agent.usage", { sessionId, inputTokens: 10, outputTokens: 5, totalTokens: 15, nativeSessionId: `nat-${sessionId}` });
    notify("agent.complete", { sessionId, reason: "finished", duration_ms: 12 });
  }

  function handle(msg: any) {
    proc.received.push({ method: msg.method, params: msg.params });
    const { id, method, params } = msg;
    switch (method) {
      case "session.create": {
        const sessionId = `sess_${++sessionCounter}_${proc.pid}`;
        sessions.set(sessionId, { harness: params.harness, cwd: params.cwd });
        reply(id, { sessionId, harness: params.harness, mode: "mock", cwd: params.cwd, status: "ready" });
        break;
      }
      case "session.resume": {
        if (String(params.sessionId).includes("..")) return fail(id, 4001, "SESSION_NOT_FOUND");
        sessions.set(params.sessionId, { harness: "mock", cwd: params.cwd });
        reply(id, { sessionId: params.sessionId, harness: "mock", mode: "mock", cwd: params.cwd, status: "ready" });
        break;
      }
      case "session.prompt": {
        if (!sessions.has(params.sessionId)) return fail(id, 4001, `Sessão '${params.sessionId}' não encontrada`);
        if (params.text.includes("rpc-erro")) return fail(id, 4011, "Chave de API ausente");
        reply(id, { sessionId: params.sessionId, accepted: true });
        void turn(params.sessionId, params.text);
        break;
      }
      case "session.permission_respond": {
        const resolve = waiting.get(params.requestId);
        if (!resolve) return fail(id, 4001, "pedido desconhecido");
        waiting.delete(params.requestId);
        reply(id, { sessionId: params.sessionId, requestId: params.requestId, resolved: true });
        resolve(params.decision);
        break;
      }
      case "session.abort": {
        aborted.add(params.sessionId);
        reply(id, { sessionId: params.sessionId, aborted: true });
        break;
      }
      default:
        fail(id, -32601, `Método desconhecido: ${method}`);
    }
  }

  return proc;
}
