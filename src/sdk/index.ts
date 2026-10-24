/**
 * @module @opencorp/sdk — Cliente unificado do OpenCorp
 *
 * Ponto de entrada principal do SDK. Instancia um `HttpClient` e expõe
 * recursos tipados para cada domínio da API:
 * - system: status e saúde do servidor
 * - secretary: chat, sessões e histórico do Secretário Executivo
 * - tasks: tarefas do Kanban operacional
 * - flows: motor de fluxos declarativos (n8n-inspired)
 * - workspaces: workspaces e status Git
 * - agents: catálogo de agentes, skills e tools
 *
 * Uso:
 * ```ts
 * import { OpenCorpClient } from "../sdk/index.js";
 *
 * const client = new OpenCorpClient({ token: "abc" });
 * const saude = await client.system.getHealth();
 * const fluxos = await client.flows.listar();
 * ```
 *
 * @see docs/PADRONIZACAO_ARQUITETURAL_OPENCORP.md (Passo 3)
 */

import { HttpClient, type HttpClientOptions } from "./http-client.js";
import { SystemResource } from "./resources/system.js";
import { SecretaryResource } from "./resources/secretary.js";
import { TasksResource } from "./resources/tasks.js";
import { FlowsResource } from "./resources/flows.js";
import { WorkspacesResource } from "./resources/workspaces.js";
import { AgentsResource } from "./resources/agents.js";
import { TeamsResource } from "./resources/teams.js";
import { AnalyticsResource } from "./resources/analytics.js";

// ── Re-exports ──────────────────────────────────────────────────────

export { ProblemDetailsError, OpenCorpNetworkError } from "./errors.js";
export type { InvalidParam } from "./errors.js";

export { HttpClient, type HttpClientOptions } from "./http-client.js";
export type { RequestOptions } from "./http-client.js";

export { SystemResource, type SaudeResponse, type HealthResponse } from "./resources/system.js";
export {
  SecretaryResource,
  type SecretarioStatus,
  type SessaoResumo,
  type ConversaResponse,
  type HistoricoResponse,
  type EnviarMensagemPayload,
} from "./resources/secretary.js";
export {
  TasksResource,
  type Task,
  type TaskResumo,
  type TaskDetalhada,
  type MensagemTask,
  type ExecucaoVinculada,
  type ListarTasksOpts,
  type CriarTaskInput,
  type AtualizarTaskInput,
  type MoverTaskInput,
  type TaskOptions,
} from "./resources/tasks.js";
export {
  FlowsResource,
  type FlowResumo,
  type FlowNode,
  type FlowEdge,
  type FlowExecucao,
  type FlowImportPayload,
  type FlowOptions,
} from "./resources/flows.js";
export {
  WorkspacesResource,
  type WorkspaceResumo,
  type CriarWorkspacePayload,
  type WorkspaceGitStatus,
} from "./resources/workspaces.js";
export {
  AgentsResource,
  type AgentResumo,
  type SkillResumo,
  type ToolResumo,
  type AgentOptions,
} from "./resources/agents.js";
export {
  TeamsResource,
  type TeamSpec,
  type TeamPasso,
  type TeamOptions,
} from "./resources/teams.js";

export {
  AnalyticsResource,
  type AnalyticsResposta,
  type AnalyticsWorkspace,
  type AnalyticsEvento,
  type AnalyticsServicos,
  type JanelaAnalytics,
} from "./resources/analytics.js";

// ── Classe principal ────────────────────────────────────────────────

/**
 * Cliente unificado do OpenCorp SDK.
 *
 * Agrega todos os recursos da API em uma interface coesa.
 * Injeção de token, base URL, workspace e timeouts são gerenciados
 * centralmente pelo `HttpClient` interno.
 */
export class OpenCorpClient {
  /** Cliente HTTP de baixo nível (exposto para uso avançado). */
  readonly http: HttpClient;

  /** Endpoints de status e saúde do servidor. */
  readonly system: SystemResource;

  /** Endpoints do Secretário Executivo (chat, sessões, histórico). */
  readonly secretary: SecretaryResource;

  /** Endpoints de tarefas do Kanban. */
  readonly tasks: TasksResource;

  /** Endpoints do motor de fluxos declarativos. */
  readonly flows: FlowsResource;

  /** Endpoints de gestão de workspaces. */
  readonly workspaces: WorkspacesResource;

  /** Endpoints de catálogo e gestão de agentes, skills e tools. */
  readonly agents: AgentsResource;

  /** Endpoints de equipes autônomas multi-agente. */
  readonly teams: TeamsResource;

  /** Analytics unificado de todos os workspaces. */
  readonly analytics: AnalyticsResource;

  constructor(opts: HttpClientOptions = {}) {
    this.http = new HttpClient(opts);
    this.system = new SystemResource(this.http);
    this.secretary = new SecretaryResource(this.http);
    this.tasks = new TasksResource(this.http);
    this.flows = new FlowsResource(this.http);
    this.workspaces = new WorkspacesResource(this.http);
    this.agents = new AgentsResource(this.http);
    this.teams = new TeamsResource(this.http);
    this.analytics = new AnalyticsResource(this.http);
  }
}
