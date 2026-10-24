/**
 * Servidor HTTP Principal do OpenCorp
 * Atua exclusivamente como orquestrador de inicialização, injeção de dependências e pipeline de rotas.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { createRequire } from "node:module";
import { WorkspaceManager } from "../core/contexts/workspace/workspace-manager.js";
import { opencorpHome } from "../utils/paths.js";
import { AgentStore } from "../core/contexts/agents/agent-store.js";
import { TemplateStore } from "../core/contexts/platform/template-store.js";
import { SessionManager, type OpcoesRun, type ResultadoRun } from "../core/contexts/execution/session-manager.js";
import { RegistryStore } from "../core/contexts/storage/registry-store.js";
import { ApprovalsStore } from "../core/contexts/platform/approvals-store.js";
import { SettingsError, SettingsStore } from "../core/contexts/workspace/settings-store.js";
import { FlowStore, type SessaoFlow } from "../core/contexts/orchestration/flow-store.js";

import { MeetingManager } from "../core/contexts/meetings/meeting-manager.js";
import { TaskStore } from "../core/contexts/storage/task-store.js";
import { PromptStore } from "../core/contexts/agents/prompt-store.js";
import { Scheduler } from "../core/contexts/scheduling/scheduler.js";
import { HookStore } from "../core/contexts/scheduling/hook-store.js";
import { NotificationStore } from "../core/contexts/platform/notification-store.js";
import { AppStore } from "../core/contexts/platform/app-store.js";
import { TeamStore } from "../core/contexts/meetings/team-store.js";
import { OrquestradorDeTeams } from "../core/contexts/meetings/team-orchestrator.js";
import { instalarMencoes } from "../core/contexts/meetings/mention-runner.js";
import {
  TaskError,
  SchedulerError,
  HookError,
  AppError,
  TeamError,
  NotificationError,
  AgentError,
  OpencorpError,
  RegistryError,
  WorkspaceError,
  FlowError,
  ComponentError,
} from "../core/shared/errors.js";
import { OpencodeServerManager, SecretarioError } from "../core/contexts/execution/opencode-server.js";
import { SecretsStore } from "../core/contexts/storage/secrets-store.js";
import { EngineAccountStore } from "../core/engines/index.js";
import { ConversationRuntimeResolver } from "../core/engines/conversation-resolver.js";
import { processarCors, verificarAutenticacao, type OpcoesCors } from "./middleware/index.js";
import { criarHandlerEstatico, servirEstatico } from "./static.js";
import { enviarProblema } from "./http/problem-details.js";
import { validarCorpo as _validarCorpo } from "./http/validator.js";
import {
  handleSystemRoutes,
  handleTaskRoutes,
  handleNotificationRoutes,
  handleAnalyticsRoutes,
  handleMeetingRoutes,
  handleWorkspaceRoutes,
  handleFlowRoutes,
  handleSessionRoutes,
  handleAgentRoutes,
  handleSchedulerRoutes,
  handleConfigRoutes,
  handleDocsRoutes,
  handleSecretarioRoutes,
  handleLegacyRoutes,
  handleFilesRoutes,
  resolverCaminhoWorkspace,
  sugerirRotas,
  iniciarPollExecucoes,
  type RouteContext,
} from "./routes/index.js";

export { iniciarPollExecucoes };

const require = createRequire(import.meta.url);
const { version } = require("../../package.json") as { version: string };

export interface SessaoApi {
  rodar(opcoes: OpcoesRun): Promise<ResultadoRun>;
  listarExecucoes(wsPath: string, filtro?: { agente?: string }): Promise<unknown[]>;
  logDe(wsPath: string, id: string): Promise<string>;
  cancelar?(wsPath: string, id: string): Promise<boolean>;
  reconciliarZombieSeNecessario?(wsPath: string, id: string): Promise<unknown>;
  reconciliarZombies?(wsPath: string): Promise<string[]>;
  proximoModeloDaRotacao?(modeloFalho: string, wsPath?: string, agenteId?: string, modelosJaTentados?: string[], apenasGratuitos?: boolean): Promise<string | null>;
}

export interface ApiServerOptions {
  homeDir?: string;
  cwd?: string;
  sessoes?: SessaoApi;
  token?: string;
  workspace?: string;
  instalarMencoes?: boolean;
  opencodeServer?: OpencodeServerManager;
  conversationRuntimeResolver?: ConversationRuntimeResolver;
  cors?: OpcoesCors;
}

function statusHttpDe(erro: unknown): number {
  const code = (erro as { exitCode?: number }).exitCode;
  if (code === 3) return 403;
  if (code === 4) return 402;
  if (code === 5) return 409;
  if (erro instanceof TaskError) return (erro as TaskError).status ?? 400;
  if (erro instanceof TeamError) return (erro as TeamError).status ?? 400;
  if (erro instanceof SchedulerError) return ((erro as unknown as { status?: number }).status ?? 400);
  if (erro instanceof HookError) return ((erro as unknown as { status?: number }).status ?? 400);
  if (erro instanceof NotificationError) return ((erro as unknown as { status?: number }).status ?? 400);
  if (erro instanceof AppError) return ((erro as unknown as { status?: number }).status ?? 404);
  if (erro instanceof RegistryError || erro instanceof WorkspaceError || erro instanceof AgentError) return 422;
  if (erro instanceof ComponentError) return /não encontrado/i.test(erro.message) ? 404 : 400;
  if (erro instanceof FlowError) return /não encontrado/i.test(erro.message) ? 404 : 400;
  if (erro instanceof SecretarioError) return (erro as SecretarioError).status ?? 500;
  return 500;
}

function enviar(res: ServerResponse, status: number, corpo: unknown, headersExtras?: Record<string, string>): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headersExtras,
  });
  res.end(JSON.stringify(corpo));
}

function enviarErro(res: ServerResponse, erro: unknown): void {
  if (erro instanceof SyntaxError) {
    enviar(res, 422, { erro: `JSON inválido no corpo: ${erro.message}` });
    return;
  }
  if (erro instanceof SettingsError) {
    enviar(res, 404, { erro: erro.message, chave: erro.chave });
    return;
  }
  if (erro instanceof OpencorpError) {
    enviar(res, statusHttpDe(erro), { erro: erro.message });
    return;
  }
  enviar(res, 500, { erro: erro instanceof Error ? erro.message : String(erro) });
}

async function lerCorpo(req: IncomingMessage, maxBytes = 30 * 1024 * 1024): Promise<unknown> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const parte of req) {
    total += (parte as Buffer).length;
    if (total > maxBytes) {
      req.destroy();
      throw new Error(`corpo excede ${maxBytes} bytes`);
    }
    partes.push(parte as Buffer);
  }
  const texto = Buffer.concat(partes).toString("utf8").trim();
  if (!texto) return {};
  return JSON.parse(texto) as unknown;
}

function gerarIdExec(): string {
  return `exec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function createApiServer(opcoes: ApiServerOptions = {}): {
  server: Server;
  token: string;
  porta: Promise<number>;
} {
  const base = { homeDir: opcoes.homeDir, cwd: opcoes.cwd };
  const workspaces = new WorkspaceManager(base);
  const templates = new TemplateStore(base);
  const agentes = new AgentStore({ templatesDir: opcoes.homeDir ? join(opcoes.homeDir, "templates") : undefined });
  const registros = new RegistryStore();
  const approvals = new ApprovalsStore();
  const settings = new SettingsStore(base);
  const secretsStore = new SecretsStore(opcoes.homeDir ?? opencorpHome());
  const engineAccounts = new EngineAccountStore({ homeDir: opcoes.homeDir ?? opencorpHome() });
  const flows = new FlowStore({ ...base, sessoes: opcoes.sessoes as unknown as SessaoFlow | undefined });

  const meetings = new MeetingManager({ ...base, sessoes: opcoes.sessoes as never });
  const tasks = new TaskStore();
  const prompts = new PromptStore(base);
  const scheduler = new Scheduler({ homeDir: opcoes.homeDir });
  const apps = new AppStore();
  const teams = new TeamStore();
  const notificacoes = new NotificationStore();
  const orquestrador = new OrquestradorDeTeams();
  const sessoes: SessaoApi = opcoes.sessoes ?? (new SessionManager(base) as unknown as SessaoApi);

  const hooks = new HookStore({
    executores: {
      agentRun: async (agente: string, ordem: string, wsPath: string, gatilho?: { tipo: string; origem: string }) => {
        const r = await sessoes.rodar({
          agente,
          ordem,
          workspaceDir: wsPath,
          execId: gerarIdExec(),
          gatilho,
        } as OpcoesRun);
        return { id: r.id, captura: r.captura };
      },
      flowRun: async (flow: string, entrada: string, wsPath: string) => {
        const r = await flows.executar(wsPath, flow, { entrada });
        return { id: r.execId, captura: r.contextoFinal };
      },
    },
  });

  if (opcoes.instalarMencoes !== false) {
    instalarMencoes({
      executores: {
        rodar: async (agente: string, ordem: string, wsPath: string, gatilho?: { tipo: string; origem: string }) => {
          const r = await sessoes.rodar({
            agente,
            ordem,
            workspaceDir: wsPath,
            execId: gerarIdExec(),
            gatilho,
          } as OpcoesRun);
          return { id: r.id, captura: r.captura };
        },
      },
    });
  }

  const semAuth = opcoes.token === "";
  const token = opcoes.token === undefined ? randomBytes(24).toString("hex") : opcoes.token;
  const opencodeServer = opcoes.opencodeServer ?? new OpencodeServerManager({ homeDir: opcoes.homeDir });
  const conversationRuntimeResolver =
    opcoes.conversationRuntimeResolver ?? new ConversationRuntimeResolver({ homeDir: opcoes.homeDir });
  const handlerEstatico = criarHandlerEstatico();

  async function resolverWs(url: URL, req?: IncomingMessage): Promise<{ id: string; path: string }> {
    const headerWs = req?.headers["x-opencorp-workspace"] || req?.headers["x-workspace-id"];
    const idHeader = typeof headerWs === "string" ? headerWs.trim() : Array.isArray(headerWs) ? headerWs[0]?.trim() : undefined;
    const id = url.searchParams.get("workspace") ?? (idHeader && idHeader.length > 0 ? idHeader : undefined) ?? opcoes.workspace ?? undefined;
    return workspaces.resolver(id) as unknown as { id: string; path: string };
  }

  process.on("unhandledRejection", (motivo) => {
    console.error("[server] unhandledRejection:", motivo);
  });
  process.on("uncaughtException", (erro) => {
    console.error("[server] uncaughtException:", erro);
  });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://local");
      const rota = url.pathname;

      if (!processarCors(req, res, opcoes.cors)) return;
      if (await handlerEstatico(req, res, rota)) return;
      const auth = verificarAutenticacao(req, url, rota, { tokenEsperado: token, semAuth });
      if (!auth.autenticado) {
        enviar(res, 401, { erro: auth.motivo ?? "não autorizado" });
        return;
      }

      try {
        const routeCtx: RouteContext = {
          req,
          res,
          url,
          rota,
          resolverWs: (u: URL) => resolverWs(u, req),
          lerCorpo,
          enviar,
          tasks,
          scheduler,
          registros,
          sessoes,
          notificacoes,
          meetings,
          workspaces,
          flows,
          agentes,
          teams,
          templates,
          opencodeServer,
          conversationRuntimeResolver,
          hooks,
          settings,
          secretsStore,
          apps,
          engineAccounts,
          prompts,
          approvals,
          resolverCaminhoWorkspace,
          homeDir: opcoes.homeDir,
          version,
          orquestrador,
          enviarProblema,
          validarCorpo: (req, schema, instance) => _validarCorpo(lerCorpo, req, schema, instance),
        };

        if (await handleSystemRoutes(routeCtx)) return;
        if (await handleAnalyticsRoutes(routeCtx)) return;
        if (await handleTaskRoutes(routeCtx)) return;
        if (await handleNotificationRoutes(routeCtx)) return;
        if (await handleMeetingRoutes(routeCtx)) return;
        if (await handleWorkspaceRoutes(routeCtx)) return;
        if (await handleFlowRoutes(routeCtx)) return;
        if (await handleSessionRoutes(routeCtx)) return;
        if (await handleAgentRoutes(routeCtx)) return;
        if (await handleSchedulerRoutes(routeCtx)) return;
        if (await handleConfigRoutes(routeCtx)) return;
        if (await handleDocsRoutes(routeCtx)) return;
        if (await handleSecretarioRoutes(routeCtx)) return;
        if (await handleLegacyRoutes(routeCtx)) return;
        if (await handleFilesRoutes(routeCtx)) return;

        if ((req.method === "GET" || req.method === "HEAD") && rota !== "/events") {
          const estatico = servirEstatico(rota);
          if (estatico !== null) {
            res.writeHead(200, { "content-type": estatico.tipo, "access-control-allow-origin": "*", "cache-control": "no-cache" });
            if (req.method === "HEAD") res.end();
            else res.end(estatico.corpo);
            return;
          }
        }

        const sugestoes = sugerirRotas(rota);
        const msg = sugestoes.length > 0 ? `rota não encontrada: ${rota} — rotas similares: ${sugestoes.join(", ")}` : `rota não encontrada: ${rota}`;
        enviar(res, 404, { erro: msg, sugestoes });
      } catch (erro) {
        enviarErro(res, erro);
      }
    })().catch(() => undefined);
  });

  // Padrão do Node = 5 s: um cliente que reaproveita a conexão logo depois do fechamento recebe ECONNRESET
  // (visto no E2E e em qualquer cliente HTTP com keep-alive). headersTimeout deve ficar acima do keep-alive.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let resolvePorta!: (p: number) => void;
  const porta = new Promise<number>((r) => (resolvePorta = r));
  server.on("listening", () => {
    iniciarPollExecucoes(workspaces, registros);
    const addr = server.address();
    if (addr && typeof addr === "object") resolvePorta(addr.port);
  });

  return { server, token, porta };
}

export function tokenAleatorio(): string {
  return randomBytes(24).toString("hex");
}
