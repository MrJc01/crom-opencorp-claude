import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ClaudeSdkSessionMeta {
  /** Também é o id da sessão no SDK (UUID). */
  id: string;
  workspaceId: string;
  workspacePath: string;
  model: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Sessão já criada no SDK: os próximos turnos usam `resume` em vez de `sessionId`. */
  iniciada: boolean;
}

/**
 * Metadados das conversas em `<home>/.opencorp/claude-sdk-sessions.json`.
 * O histórico fica nas transcrições do próprio SDK; aqui só o necessário para
 * retomar a conversa depois de um reinício.
 */
export class ClaudeSdkSessionStore {
  private readonly file: string;
  private cache: Map<string, ClaudeSdkSessionMeta> | null = null;

  constructor(homeDir: string) {
    this.file = join(homeDir, ".opencorp", "claude-sdk-sessions.json");
  }

  private load(): Map<string, ClaudeSdkSessionMeta> {
    if (this.cache) return this.cache;
    this.cache = new Map();
    try {
      if (existsSync(this.file)) {
        const data = JSON.parse(readFileSync(this.file, "utf8")) as Record<string, ClaudeSdkSessionMeta>;
        for (const [id, meta] of Object.entries(data)) {
          if (meta && meta.id === id && meta.workspaceId) this.cache.set(id, meta);
        }
      }
    } catch {
      // arquivo corrompido: recomeça vazio (o histórico continua no SDK)
    }
    return this.cache;
  }

  private persist(): void {
    const data = Object.fromEntries(this.load());
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get(id: string): ClaudeSdkSessionMeta | undefined {
    return this.load().get(id);
  }

  set(meta: ClaudeSdkSessionMeta): void {
    this.load().set(meta.id, meta);
    this.persist();
  }

  /** Atualiza só conversas que ainda existem: não ressuscita uma conversa já fechada. */
  touch(meta: ClaudeSdkSessionMeta): void {
    if (!this.load().has(meta.id)) return;
    meta.updatedAt = new Date().toISOString();
    this.set(meta);
  }

  delete(id: string): void {
    if (this.load().delete(id)) this.persist();
  }
}
