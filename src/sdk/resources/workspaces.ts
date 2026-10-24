/**
 * @module sdk/resources/workspaces — Recurso Workspaces do OpenCorp SDK
 *
 * Encapsula endpoints de gerenciamento de workspaces corporativos.
 */

import type { HttpClient, RequestOptions } from "../http-client.js";

// ── Tipos ───────────────────────────────────────────────────────────

export interface WorkspaceResumo {
  id: string;
  /** Nome de exibição; sem ele a interface mostra o id. */
  nome?: string;
  /** Workspace em pausa: o agendador não dispara seus fluxos. */
  pausado?: boolean;
  /** ISO de quando a pausa começou (presente só enquanto pausado). */
  pausado_em?: string;
  path: string;
  ativo?: boolean;
  criado_em?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CriarWorkspacePayload {
  id: string;
  template?: string;
  path?: string;
}

export interface WorkspaceGitStatus {
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  files?: Array<{ path: string; status: string }>;
  [key: string]: unknown;
}

// ── Recurso ─────────────────────────────────────────────────────────

export class WorkspacesResource {
  constructor(private readonly http: HttpClient) {}

  /** GET /workspaces — lista todos os workspaces registrados. */
  async listar(opts?: RequestOptions): Promise<WorkspaceResumo[]> {
    return this.http.get<WorkspaceResumo[]>("/workspaces", opts);
  }

  /** GET /workspaces/current — retorna o workspace atualmente ativo. */
  async ativo(opts?: RequestOptions): Promise<WorkspaceResumo> {
    return this.http.get<WorkspaceResumo>("/workspaces/current", opts);
  }

  /** POST /workspaces/ativo — define o workspace ativo. */
  async definirAtivo(id: string, opts?: RequestOptions): Promise<{ ok: boolean; id: string }> {
    return this.http.post<{ ok: boolean; id: string }>("/workspaces/ativo", { id }, opts);
  }

  /** POST /workspaces/:id/pausa — pausa ou retoma o workspace (fluxos continuam ligados, mas não disparam). */
  async definirPausado(id: string, pausado: boolean, opts?: RequestOptions): Promise<{ ok: boolean; id: string; pausado: boolean }> {
    return this.http.post<{ ok: boolean; id: string; pausado: boolean }>(`/workspaces/${encodeURIComponent(id)}/pausa`, { pausado }, opts);
  }

  /** POST /workspaces — cria um novo workspace. */
  async criar(payload: CriarWorkspacePayload, opts?: RequestOptions): Promise<WorkspaceResumo> {
    return this.http.post<WorkspaceResumo>("/workspaces", payload, opts);
  }

  /** GET /workspaces/git/status — status do repositório Git do workspace ativo. */
  async gitStatus(opts?: RequestOptions): Promise<WorkspaceGitStatus> {
    return this.http.get<WorkspaceGitStatus>("/workspaces/git/status", opts);
  }
}
