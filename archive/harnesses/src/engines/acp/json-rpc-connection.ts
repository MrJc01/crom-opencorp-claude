/**
 * Conexão JSON-RPC 2.0 sobre stdio com framing por linha (NDJSON), usada pelo
 * ACP. Independente de fornecedor.
 *
 * - Correlação de requisições por ID, com tempo limite por operação.
 * - Notificações e requisições do agente entregues a handlers.
 * - Frames parciais e múltiplos frames por chunk; linha acima do limite
 *   derruba a conexão (proteção de memória).
 * - Fila de escrita respeita backpressure (`drain`) quando o transporte expõe.
 * - Encerramento do processo rejeita todas as requisições pendentes.
 */

export interface JsonRpcTransport {
  /** Linhas/chunks de stdout do processo. */
  stdout: AsyncIterable<string | Buffer>;
  stderr?: AsyncIterable<string | Buffer>;
  /** Escreve bytes; retorna `false` quando o buffer do SO está cheio. */
  write(data: string): boolean | void;
  /** Resolve quando o transporte pode receber mais dados após `write` → false. */
  waitDrain?(): Promise<void>;
  exitCode: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: JsonRpcErrorObject) {
    super(error.message);
    this.name = "JsonRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

export class JsonRpcConnectionClosedError extends Error {
  constructor(message = "Conexão JSON-RPC encerrada") {
    super(message);
    this.name = "JsonRpcConnectionClosedError";
  }
}

export type RequestHandler = (method: string, params: any) => Promise<unknown>;
export type NotificationHandler = (method: string, params: any) => void;

export interface JsonRpcConnectionOptions {
  requestTimeoutMs?: number;
  /** Tamanho máximo de uma linha (frame). Padrão 16 MiB. */
  maxFrameBytes?: number;
  /** Bytes finais de stderr preservados para diagnóstico. */
  stderrTailBytes?: number;
  onRequest?: RequestHandler;
  onNotification?: NotificationHandler;
}

interface Pending {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INTERNAL_ERROR = -32603;

export class JsonRpcConnection {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closeReason?: Error;
  private writeChain: Promise<void> = Promise.resolve();
  private stderrTail = "";
  private stderrTotal = 0;
  readonly finished: Promise<void>;

  constructor(private readonly transport: JsonRpcTransport, private readonly options: JsonRpcConnectionOptions = {}) {
    const reading = this.readLoop();
    const drainingStderr = this.drainStderr();
    this.finished = Promise.allSettled([reading, drainingStderr, transport.exitCode]).then(async () => {
      const code = await transport.exitCode.catch(() => -1);
      this.shutdown(new JsonRpcConnectionClosedError(`Processo do agente encerrou (código ${code})${this.stderrTail ? `: ${this.stderrTail.slice(-400)}` : ""}`));
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  /** Posição atual do stderr (bytes recebidos até agora). */
  get stderrOffset(): number {
    return this.stderrTotal;
  }

  /** Texto de stderr recebido desde `offset` (limitado à cauda preservada). */
  stderrSince(offset: number): string {
    const fresh = this.stderrTotal - offset;
    return fresh <= 0 ? "" : this.stderrTail.slice(-Math.min(fresh, this.stderrTail.length));
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = this.options.requestTimeoutMs ?? 60_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closeReason ?? new JsonRpcConnectionClosedError());
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { method, resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Tempo limite de ${timeoutMs} ms excedido em "${method}"`));
        }, timeoutMs);
        entry.timer.unref?.();
      }
      this.pending.set(id, entry);
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch((error) => {
        this.pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }).catch(() => {});
  }

  close(signal: NodeJS.Signals = "SIGTERM"): void {
    this.shutdown(new JsonRpcConnectionClosedError("Conexão encerrada pelo cliente"));
    try { this.transport.kill(signal); } catch { /* processo já encerrado */ }
  }

  private send(message: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    // Escritas serializadas: respeita backpressure sem intercalar frames.
    this.writeChain = this.writeChain.then(async () => {
      if (this.closed) throw this.closeReason ?? new JsonRpcConnectionClosedError();
      const ok = this.transport.write(line);
      if (ok === false && this.transport.waitDrain) await this.transport.waitDrain();
    });
    return this.writeChain;
  }

  private shutdown(reason: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [id, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
      this.pending.delete(id);
    }
  }

  private async readLoop(): Promise<void> {
    const max = this.options.maxFrameBytes ?? 16 * 1024 * 1024;
    let buffer = "";
    try {
      for await (const chunk of this.transport.stdout) {
        buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) this.dispatch(line);
        }
        if (buffer.length > max) {
          this.shutdown(new Error(`Frame JSON-RPC excede ${max} bytes; conexão encerrada`));
          try { this.transport.kill("SIGKILL"); } catch { /* já encerrado */ }
          return;
        }
      }
      if (buffer.trim()) this.dispatch(buffer.trim());
    } catch {
      // stdout encerrado de forma abrupta: tratado em `finished`
    }
  }

  private async drainStderr(): Promise<void> {
    if (!this.transport.stderr) return;
    const keep = this.options.stderrTailBytes ?? 8 * 1024;
    try {
      for await (const chunk of this.transport.stderr) {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        this.stderrTotal += text.length;
        this.stderrTail = (this.stderrTail + text).slice(-keep);
      }
    } catch {
      // ignorado
    }
  }

  private dispatch(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return; // linha que não é JSON (ex.: log acidental em stdout)
    }
    if (!message || typeof message !== "object") return;

    const hasId = message.id !== undefined && message.id !== null;
    if (hasId && (message.result !== undefined || message.error !== undefined) && message.method === undefined) {
      const entry = this.pending.get(Number(message.id));
      if (!entry) return; // resposta tardia (após timeout) ou desconhecida
      this.pending.delete(Number(message.id));
      if (entry.timer) clearTimeout(entry.timer);
      if (message.error) entry.reject(new JsonRpcError(message.error));
      else entry.resolve(message.result);
      return;
    }
    if (typeof message.method !== "string") return;
    if (hasId) {
      void this.answer(message.id, message.method, message.params);
    } else {
      try { this.options.onNotification?.(message.method, message.params); } catch { /* handler não derruba a conexão */ }
    }
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    if (!this.options.onRequest) {
      await this.send({ jsonrpc: "2.0", id, error: { code: JSON_RPC_METHOD_NOT_FOUND, message: `Método não suportado: ${method}` } }).catch(() => {});
      return;
    }
    try {
      const result = await this.options.onRequest(method, params);
      await this.send({ jsonrpc: "2.0", id, result: result ?? null }).catch(() => {});
    } catch (error) {
      const rpc = error instanceof JsonRpcError
        ? { code: error.code, message: error.message }
        : { code: JSON_RPC_INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) };
      await this.send({ jsonrpc: "2.0", id, error: rpc }).catch(() => {});
    }
  }
}
