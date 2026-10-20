import { randomUUID } from "node:crypto";
import {
  getSessionMessages,
  query,
  type CanUseTool,
  type PermissionResult,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { opencorpHome, pathComCliLocal } from "../../../utils/paths.js";
import { claudeConfigDirOpencorp } from "../drivers/claude-config-dir.js";
import { resolveEngineSpawnEnv } from "../../credentials/credentials-store.js";
import { LegacyDriverAdapter } from "../adapter-compat.js";
import { ClaudeCodeDriver } from "../drivers/claude-code-driver.js";
import { normalizeEngineError } from "../error-normalizer.js";
import type { AgentEvent, AgentUsage } from "../events.js";
import type { EngineCapabilityManifest } from "../manifests.js";
import type {
  AgentRunInput,
  AgentRunner,
  ConversationCreateInput,
  ConversationMessageInput,
  ConversationRef,
  ConversationRuntime,
  ConversationState,
  EngineAdapter,
  ModelCatalogSource,
  EngineAuthenticator,
  EngineInstaller,
} from "../ports.js";
import { ClaudeSdkSessionStore } from "./claude-sdk-session-store.js";
import { converterTranscricaoSdk } from "./claude-sdk-history.js";
import { OPCOES_WORKSPACE_SDK } from "../runners/claude-sdk-cli.js";

export const CLAUDE_SDK_ENGINE_ID = "claude-sdk";

/** Modelos Claude listados no seletor. */
export const CLAUDE_SDK_MODELOS = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

/**
 * Instalação, login e contas continuam as do Claude Code: é o mesmo login do
 * claude.ai e as mesmas contas cadastradas em `claude-code`.
 */
const CREDENTIALS_ENGINE_ID = "claude-code";

/** Sem resposta do usuário, a aprovação é negada: o turno não fica preso para sempre. */
const APROVACAO_TIMEOUT_MS = 10 * 60_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const CLAUDE_SDK_MANIFEST: EngineCapabilityManifest = {
  engineId: CLAUDE_SDK_ENGINE_ID,
  name: "Claude Agent SDK",
  transport: "embedded",
  supportsConversation: true,
  limits: { tetoMs: 1_800_000, inatividadeMs: 300_000 },
  modelPrefixes: ["claude-"],
  instructionFiles: ["CLAUDE.md"],
  // Sem credentialEnvVars de propósito: o claude-sdk usa o login do plano (Pro), nunca ANTHROPIC_API_KEY.
  toolPolicyModes: ["ask", "auto-edits"],
  features: {
    streaming: { level: "declared", notes: "Texto entregue por mensagem completa do assistente, sem delta por token" },
    continuation: {
      level: "integrated",
      flags: ["sessionId", "resume"],
      notes: "Sessão do SDK criada com o id da conversa e retomada com resume",
    },
    fork: { level: "unsupported" },
    hitl: {
      level: "integrated",
      notes: "Conversa: canUseTool vira approval.requested. Execução pontual: negada, sem canal de resposta",
    },
    tools: { level: "declared", notes: "Ferramentas nativas do SDK com permissionMode acceptEdits" },
    mcp: { level: "unsupported" },
    images: { level: "unsupported" },
    cancellation: { level: "integrated", notes: "AbortController do SDK, acionado por signal, timeoutMs e close" },
  },
};

interface TradutorEstado {
  runId: string;
  engineId: string;
  modelId: string;
  /** Texto do assistente até agora; usado como saída se a execução for interrompida. */
  output: string;
  /** tool_use.id → nome da ferramenta, para rotular o tool_result correspondente. */
  nomesFerramentas: Map<string, string>;
}

/**
 * Converte uma mensagem do SDK em zero ou mais eventos canônicos.
 * Função pura sobre o estado do run: não faz I/O.
 */
export function traduzirMensagemSdk(msg: SDKMessage, estado: TradutorEstado): AgentEvent[] {
  const { runId } = estado;
  const timestamp = new Date().toISOString();

  switch (msg.type) {
    case "assistant": {
      // Erro de API chega como mensagem de assistente; o texto fica para o run.failed do result.
      if (msg.error) return [];
      const eventos: AgentEvent[] = [];
      for (const bloco of msg.message.content) {
        if (bloco.type === "text" && bloco.text) {
          estado.output += bloco.text;
          eventos.push({ type: "message.delta", runId, text: bloco.text, timestamp });
        } else if (bloco.type === "tool_use") {
          estado.nomesFerramentas.set(bloco.id, bloco.name);
          eventos.push({
            type: "tool.requested",
            runId,
            call: { id: bloco.id, name: bloco.name, arguments: (bloco.input ?? {}) as Record<string, unknown> },
            timestamp,
          });
        }
      }
      return eventos;
    }

    case "user": {
      const conteudo = msg.message.content;
      if (typeof conteudo === "string") return [];
      const eventos: AgentEvent[] = [];
      for (const bloco of conteudo) {
        if (bloco.type !== "tool_result") continue;
        eventos.push({
          type: "tool.completed",
          runId,
          result: {
            id: bloco.tool_use_id,
            name: estado.nomesFerramentas.get(bloco.tool_use_id) ?? "desconhecida",
            result: bloco.content,
            isError: bloco.is_error === true,
          },
          timestamp,
        });
      }
      return eventos;
    }

    case "result":
      return traduzirResultado(msg, estado, timestamp);

    default:
      return [];
  }
}

function traduzirResultado(msg: SDKResultMessage, estado: TradutorEstado, timestamp: string): AgentEvent[] {
  const { runId, engineId, modelId } = estado;
  const usage = usoDoResultado(msg);

  if (msg.subtype === "success" && !msg.is_error) {
    return [
      { type: "usage.updated", runId, usage, timestamp },
      {
        type: "run.completed",
        runId,
        result: { output: msg.result || estado.output, usage, stopReason: "completed" },
        timestamp,
      },
    ];
  }

  const motivo = msg.subtype === "success"
    ? msg.result
    : msg.errors.length > 0 ? msg.errors.join("; ") : `Execução terminou com "${msg.subtype}"`;
  return [
    {
      type: "run.failed",
      runId,
      error: normalizeEngineError(new Error(motivo || "Falha desconhecida no Claude Agent SDK"), { engineId, modelId }),
      timestamp,
    },
  ];
}

/** Soma `modelUsage` (inclui subagentes e chamadas auxiliares). `promptTokens` inclui os tokens de cache. */
function usoDoResultado(msg: SDKResultMessage): AgentUsage {
  let promptTokens = 0;
  let completionTokens = 0;
  for (const uso of Object.values(msg.modelUsage)) {
    promptTokens += uso.inputTokens + uso.cacheReadInputTokens + uso.cacheCreationInputTokens;
    completionTokens += uso.outputTokens;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: msg.total_cost_usd,
  };
}

/** Canal assíncrono de um produtor para um consumidor, na ordem de chegada. */
class FilaAssincrona<T> {
  private readonly itens: T[] = [];
  private espera: (() => void) | null = null;
  private fechada = false;

  push(item: T): void {
    if (this.fechada) return;
    this.itens.push(item);
    this.acordar();
  }

  fechar(): void {
    this.fechada = true;
    this.acordar();
  }

  private acordar(): void {
    const acordar = this.espera;
    this.espera = null;
    acordar?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      const item = this.itens.shift();
      if (item !== undefined) {
        yield item;
        continue;
      }
      if (this.fechada) return;
      await new Promise<void>((resolver) => {
        this.espera = resolver;
      });
    }
  }
}

interface PendenteAprovacao {
  workspaceId: string;
  input: Record<string, unknown>;
  decidir: (decisao: PermissionResult) => void;
}

interface OpcoesTurno {
  runId: string;
  modelId: string;
  prompt: string;
  workspaceId: string;
  workspacePath: string;
  homeDir: string;
  /** Ausente: o SDK usa o modelo padrão. */
  model?: string;
  accountId?: string;
  envOverrides?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Controle do turno: `close` e o consumidor que para de ler acionam este abort. */
  controle: AbortController;
  /** Sessão do SDK: `retomar` usa `resume`; senão a sessão nasce com este id. */
  sessao?: { id: string; retomar: boolean; aoIniciar?: () => void };
  /** Presente: `canUseTool` pergunta ao usuário. Ausente: a ferramenta que precisa de permissão é negada. */
  aprovacoes?: Map<string, PendenteAprovacao>;
}

/** Executa um turno no SDK e produz os eventos canônicos, sem `run.started`. */
async function* executarTurno(opts: OpcoesTurno): AsyncGenerator<AgentEvent> {
  const { runId, controle } = opts;
  const estado: TradutorEstado = {
    runId,
    engineId: CLAUDE_SDK_ENGINE_ID,
    modelId: opts.modelId,
    output: "",
    nomesFerramentas: new Map(),
  };
  const fila = new FilaAssincrona<AgentEvent>();
  const pendentesDoTurno = new Set<string>();

  // O sinal do controle é a fonte de verdade: cancelamento pelo signal, por close ou pelo timeout.
  let expirou = false;
  const interrompido = () => controle.signal.aborted;
  const aoCancelar = () => controle.abort();
  if (opts.signal?.aborted) aoCancelar();
  else opts.signal?.addEventListener("abort", aoCancelar, { once: true });
  const temporizador = opts.timeoutMs && opts.timeoutMs > 0
    ? setTimeout(() => {
        expirou = true;
        controle.abort();
      }, opts.timeoutMs)
    : undefined;

  const perguntarAprovacao: CanUseTool = (nome, input, { signal: sinalFerramenta }) =>
    new Promise<PermissionResult>((resolver) => {
      const id = randomUUID();
      const aoAbortar = () => decidir({ behavior: "deny", message: "Turno interrompido." });
      const prazo = setTimeout(() => decidir({ behavior: "deny", message: "Aprovação expirou sem resposta." }), APROVACAO_TIMEOUT_MS);
      const decidir = (decisao: PermissionResult) => {
        if (!opts.aprovacoes?.delete(id)) return;
        pendentesDoTurno.delete(id);
        clearTimeout(prazo);
        sinalFerramenta.removeEventListener("abort", aoAbortar);
        resolver(decisao);
      };
      opts.aprovacoes!.set(id, { workspaceId: opts.workspaceId, input, decidir });
      pendentesDoTurno.add(id);
      sinalFerramenta.addEventListener("abort", aoAbortar, { once: true });
      fila.push({
        type: "approval.requested",
        runId,
        approval: { id, action: nome, description: descreverFerramenta(nome, input) },
        timestamp: new Date().toISOString(),
      });
    });

  const negarAprovacao: CanUseTool = async (): Promise<PermissionResult> => ({
    behavior: "deny",
    message: "Aprovação não disponível em execução pontual.",
  });

  const falha = (erro: unknown): AgentEvent => ({
    type: "run.failed",
    runId,
    error: normalizeEngineError(erro, { engineId: CLAUDE_SDK_ENGINE_ID, modelId: opts.modelId }),
    timestamp: new Date().toISOString(),
  });

  const produtor = (async () => {
    let terminou = false;
    try {
      // Mesmo env do ClaudeCodeDriver, com uma diferença: a ANTHROPIC_API_KEY do shell/host
      // não entra, para manter o login local do claude.ai (CLAUDE.md). Chaves configuradas
      // no OpenCorp (conta, segredo, chave gerida) continuam valendo.
      const env = await resolveEngineSpawnEnv(
        CREDENTIALS_ENGINE_ID,
        { homeDir: opts.homeDir, workspaceId: opts.workspaceId, workspacePath: opts.workspacePath, accountId: opts.accountId },
        {
          ANTHROPIC_DISABLE_TELEMETRY: "1",
          PATH: pathComCliLocal(),
          ...(claudeConfigDirOpencorp() ? { CLAUDE_CONFIG_DIR: claudeConfigDirOpencorp() as string } : {}),
          ...opts.envOverrides,
        },
        { ...process.env, ANTHROPIC_API_KEY: undefined }
      );

      const sessao = opts.sessao;
      const mensagens = query({
        prompt: opts.prompt,
        options: {
          cwd: opts.workspacePath,
          ...(opts.model ? { model: opts.model } : {}),
          permissionMode: "acceptEdits",
          // Secretário e conversas: CLAUDE.md e skills do workspace, sem as configurações do usuário.
          ...OPCOES_WORKSPACE_SDK,
          env,
          abortController: controle,
          canUseTool: opts.aprovacoes ? perguntarAprovacao : negarAprovacao,
          ...(sessao ? (sessao.retomar ? { resume: sessao.id } : { sessionId: sessao.id }) : {}),
        },
      });

      for await (const msg of mensagens) {
        if (sessao?.aoIniciar && ehInicializacao(msg)) sessao.aoIniciar();
        for (const evento of traduzirMensagemSdk(msg, estado)) {
          if (evento.type !== "run.completed" && evento.type !== "run.failed") {
            fila.push(evento);
            continue;
          }
          // Interrompido: o stopReason do finally decide o final, não o erro que o SDK devolve ao abortar.
          if (interrompido()) continue;
          terminou = true;
          fila.push(evento);
        }
      }
      if (!terminou && !interrompido()) {
        terminou = true;
        fila.push(falha(new Error("Claude Agent SDK encerrou sem resultado final")));
      }
    } catch (err) {
      if (!interrompido() && !terminou) {
        terminou = true;
        fila.push(falha(err));
      }
    } finally {
      if (temporizador) clearTimeout(temporizador);
      opts.signal?.removeEventListener("abort", aoCancelar);
      for (const id of [...pendentesDoTurno]) {
        opts.aprovacoes?.get(id)?.decidir({ behavior: "deny", message: "Turno encerrado." });
      }
      if (!terminou && interrompido()) {
        fila.push({
          type: "run.completed",
          runId,
          result: { output: estado.output, stopReason: expirou ? "timeout" : "cancelled" },
          timestamp: new Date().toISOString(),
        });
      }
      fila.fechar();
    }
  })();

  try {
    yield* fila;
  } finally {
    // Quem parou de ler (ou o turno terminou) não deixa o SDK rodando.
    if (!controle.signal.aborted) controle.abort();
  }
  await produtor;
}

function ehInicializacao(msg: SDKMessage): boolean {
  return msg.type === "system" && (msg as { subtype?: unknown }).subtype === "init";
}

/** Texto curto para a pergunta de aprovação: comando, arquivo ou nome da ferramenta. */
function descreverFerramenta(nome: string, input: Record<string, unknown>): string {
  const texto = (valor: unknown): string | undefined => (typeof valor === "string" ? valor : undefined);
  const comando = texto(input.command);
  if (nome === "Bash" && comando) return `Executar comando: ${comando.slice(0, 300)}`;
  const arquivo = texto(input.file_path) ?? texto(input.path) ?? texto(input.notebook_path);
  if (arquivo) return `${nome} em ${arquivo}`;
  return `Usar a ferramenta ${nome}`;
}

/** "default" (padrão do Secretário) significa modelo padrão do SDK. */
function modeloDe(model: string | undefined): string | undefined {
  return model && model !== "default" ? model : undefined;
}

function gerarId(prefixo: string): string {
  return `${prefixo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

class ClaudeSdkRunner implements AgentRunner {
  readonly engineId = CLAUDE_SDK_ENGINE_ID;

  async *run(input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const runId = input.runId || gerarId("run");
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: CLAUDE_SDK_ENGINE_ID };
    yield* executarTurno({
      runId,
      modelId: input.model,
      prompt: input.prompt,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      homeDir: input.homeDir,
      model: modeloDe(input.model),
      accountId: input.accountId,
      envOverrides: input.envOverrides,
      timeoutMs: input.timeoutMs,
      signal,
      controle: new AbortController(),
    });
  }
}

/**
 * Motor "claude-sdk": execução e conversa via `query()` do Claude Agent SDK.
 * Instalação e autenticação vêm do ClaudeCodeDriver (ver CREDENTIALS_ENGINE_ID).
 */
export class ClaudeSdkAdapter implements EngineAdapter {
  readonly engineId = CLAUDE_SDK_ENGINE_ID;
  readonly name = "Claude Agent SDK";
  readonly manifest = CLAUDE_SDK_MANIFEST;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner = new ClaudeSdkRunner();
  readonly conversationRuntime: ConversationRuntime;
  readonly modelCatalog: ModelCatalogSource;
  private readonly homeDir: string;
  private readonly sessoes: ClaudeSdkSessionStore;
  private readonly aprovacoesPendentes = new Map<string, PendenteAprovacao>();
  private readonly turnosAtivos = new Map<string, AbortController>();

  constructor(options: { homeDir?: string } = {}) {
    this.homeDir = options.homeDir ?? opencorpHome();
    this.sessoes = new ClaudeSdkSessionStore(this.homeDir);

    const legacy = new LegacyDriverAdapter(new ClaudeCodeDriver());
    // Reaproveita as funções do driver; o engineId exposto passa a ser o deste adaptador.
    this.installer = { ...legacy.installer, engineId: CLAUDE_SDK_ENGINE_ID };
    this.authenticator = { ...legacy.authenticator, engineId: CLAUDE_SDK_ENGINE_ID };

    this.modelCatalog = {
      engineId: CLAUDE_SDK_ENGINE_ID,
      listModels: async () =>
        CLAUDE_SDK_MODELOS.map((id) => ({ id, name: `Claude ${id.replace("claude-", "")}`, provider: CLAUDE_SDK_ENGINE_ID })),
    };

    this.conversationRuntime = {
      engineId: CLAUDE_SDK_ENGINE_ID,
      create: (input) => this.criarConversa(input),
      send: (ref, input, signal) => this.enviarMensagem(ref, input, signal),
      resume: (ref) => this.retomarConversa(ref),
      respondApproval: (approvalId, decision, scope) => this.responderAprovacao(approvalId, decision, scope),
      history: (ref) => this.historicoDaTranscricao(ref),
      close: (ref) => this.fecharConversa(ref),
    };
  }

  /** Lê a transcrição que o SDK guarda na pasta de login do OpenCorp (a mesma usada pelo runner). */
  private async historicoDaTranscricao(ref: ConversationRef) {
    const dir = claudeConfigDirOpencorp();
    const anterior = process.env.CLAUDE_CONFIG_DIR;
    if (dir) process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      return converterTranscricaoSdk(await getSessionMessages(ref.id));
    } catch {
      return [];
    } finally {
      if (dir) {
        if (anterior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = anterior;
      }
    }
  }

  private referencia(meta: { id: string; workspaceId: string }): ConversationRef {
    return { id: meta.id, engineId: CLAUDE_SDK_ENGINE_ID, workspaceId: meta.workspaceId };
  }

  private async criarConversa(input: ConversationCreateInput): Promise<ConversationRef> {
    const existente = input.conversationId ? this.sessoes.get(input.conversationId) : undefined;
    if (existente && existente.workspaceId === input.workspaceId) return this.referencia(existente);

    // O id da conversa vira o id da sessão no SDK, que exige UUID.
    const id = input.conversationId && UUID_RE.test(input.conversationId) && !existente
      ? input.conversationId
      : randomUUID();
    const agora = new Date().toISOString();
    const meta = {
      id,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      model: input.model,
      title: input.title ?? "Conversa",
      createdAt: agora,
      updatedAt: agora,
      iniciada: false,
    };
    this.sessoes.set(meta);
    return this.referencia(meta);
  }

  private async *enviarMensagem(
    ref: ConversationRef,
    input: ConversationMessageInput,
    signal?: AbortSignal
  ): AsyncGenerator<AgentEvent> {
    const runId = gerarId("run");
    yield { type: "run.started", runId, timestamp: new Date().toISOString(), engineId: CLAUDE_SDK_ENGINE_ID };

    const meta = this.sessoes.get(ref.id);
    if (!meta || meta.workspaceId !== ref.workspaceId) {
      yield {
        type: "run.failed",
        runId,
        error: normalizeEngineError(new Error(`Conversa "${ref.id}" não encontrada ou já fechada.`), {
          engineId: CLAUDE_SDK_ENGINE_ID,
        }),
        timestamp: new Date().toISOString(),
      };
      return;
    }
    if (this.turnosAtivos.has(ref.id)) {
      yield {
        type: "run.failed",
        runId,
        error: normalizeEngineError(new Error("Já existe um turno em andamento nesta conversa."), {
          engineId: CLAUDE_SDK_ENGINE_ID,
        }),
        timestamp: new Date().toISOString(),
      };
      return;
    }

    const controle = new AbortController();
    this.turnosAtivos.set(ref.id, controle);
    try {
      yield* executarTurno({
        runId,
        modelId: meta.model,
        prompt: input.text,
        workspaceId: meta.workspaceId,
        workspacePath: meta.workspacePath,
        homeDir: this.homeDir,
        model: modeloDe(meta.model),
        signal,
        controle,
        aprovacoes: this.aprovacoesPendentes,
        sessao: {
          id: meta.id,
          retomar: meta.iniciada,
          aoIniciar: () => {
            meta.iniciada = true;
            this.sessoes.touch(meta);
          },
        },
      });
    } finally {
      this.turnosAtivos.delete(ref.id);
      this.sessoes.touch(meta);
    }
  }

  private async retomarConversa(ref: ConversationRef): Promise<ConversationState> {
    const meta = this.sessoes.get(ref.id);
    return {
      ref,
      status: !meta ? "closed" : this.turnosAtivos.has(ref.id) ? "active" : "idle",
      lastActiveAt: meta?.updatedAt ?? new Date().toISOString(),
      metadata: meta ? { nativeSessionId: meta.id, model: meta.model, title: meta.title } : undefined,
    };
  }

  private async fecharConversa(ref: ConversationRef): Promise<void> {
    this.turnosAtivos.get(ref.id)?.abort();
    this.sessoes.delete(ref.id);
  }

  private async responderAprovacao(
    approvalId: string,
    decision: "approve" | "reject",
    scope: { workspaceId: string }
  ): Promise<boolean> {
    const pendente = this.aprovacoesPendentes.get(approvalId);
    if (!pendente || pendente.workspaceId !== scope.workspaceId) return false;
    pendente.decidir(
      decision === "approve"
        ? { behavior: "allow", updatedInput: pendente.input }
        : { behavior: "deny", message: "Recusado pelo usuário." }
    );
    return true;
  }
}
