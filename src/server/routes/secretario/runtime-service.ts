import { EventLog } from "../../../core/engines/event-log.js";
import { opencorpHome } from "../../../utils/paths.js";
import { formatProcessKey, ProcessRegistry } from "../../../core/runtime/index.js";
import {
  ConversationRuntimeResolver,
  type ConversationResolutionResult,
  type ConversationPreflightResult,
} from "../../../core/engines/conversation-resolver.js";
import type {
  ConversationRef,
  ConversationRuntime,
} from "../../../core/engines/ports.js";
import type { AgentEvent } from "../../../core/engines/events.js";
import { SecretarioError } from "../../../core/contexts/execution/opencode-server.js";
import type { RouteContext } from "../types.js";

export interface SecretaryRuntimeContext {
  resolution: ConversationResolutionResult;
  runtime: ConversationRuntime;
  engineId: string;
}

/**
 * Resolve o runtime conversacional configurado para o workspace do Secretário.
 */
/**
 * O front numera abas novas como `sessao-<ts>`/`draft-<ts>` até o motor devolver o id real. Esses ids de rascunho
 * nunca podem chegar ao motor como conversa a retomar: o histórico ficaria sob o id de rascunho e a aba nunca seria
 * promovida. Devolve undefined para eles, e o runtime cria a conversa e devolve o id nativo.
 */
export function idConversaNativo(id: string | null | undefined): string | undefined {
  const limpo = id?.trim();
  return limpo && !/^(sessao|draft)-/i.test(limpo) ? limpo : undefined;
}

export async function obterRuntimeSecretario(
  ctx: RouteContext,
  ws: { id: string; path: string },
  strict = true
): Promise<SecretaryRuntimeContext> {
  const resolver = ctx.conversationRuntimeResolver ?? new ConversationRuntimeResolver({ homeDir: ctx.homeDir });

  let resolution: ConversationResolutionResult;
  try {
    resolution = await resolver.resolve({
      workspaceId: ws.id,
      workspaceDir: ws.path,
      strict: false,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if ((err as { code?: string })?.code === "ENGINE_CAPABILITY_UNAVAILABLE") {
      throw new SecretarioError(`O motor selecionado não oferece runtime conversacional: ${msg}`, { status: 409 });
    }
    throw new SecretarioError(`Falha ao resolver motor conversacional do Secretário: ${msg}`, { status: 409 });
  }

  let legacyOpenCodeGerenciado = false;
  if (resolution.engineId === "opencode" && ctx.opencodeServer) {
    try {
      legacyOpenCodeGerenciado = Boolean((await ctx.opencodeServer.status()).rodando);
    } catch {
      legacyOpenCodeGerenciado = false;
    }
  }
  if (strict && !resolution.preflight.ok && !legacyOpenCodeGerenciado) {
    if (!resolution.preflight.supportsConversation) {
      throw new SecretarioError(
        `O motor "${resolution.engineId}" não oferece runtime conversacional.`,
        { status: 409 }
      );
    }
    const detalhes = resolution.preflight.issues.join(" ") || "preflight indisponível";
    throw new SecretarioError(
      `Motor conversacional "${resolution.engineId}" indisponível: ${detalhes}`,
      { status: 409 }
    );
  }

  const runtime = resolution.adapter.conversationRuntime;
  if (!runtime) {
    throw new SecretarioError(
      `O motor "${resolution.engineId}" selecionado para o Secretário não oferece runtime conversacional.`,
      { status: 409 }
    );
  }

  return {
    resolution,
    runtime,
    engineId: resolution.engineId,
  };
}

/**
 * Cria ou recupera uma referência de sessão conversacional através da porta ConversationRuntime
 */
export async function adquirirSessaoSecretario(
  ctx: RouteContext,
  ws: { id: string; path: string },
  options: {
    conversationId?: string;
    title?: string;
    model?: string;
  } = {}
): Promise<{ ref: ConversationRef; runtime: ConversationRuntime; engineId: string }> {
  const { runtime, engineId } = await obterRuntimeSecretario(ctx, ws, true);
  const home = ctx.homeDir ?? opencorpHome();

  const ref = await runtime.create({
    conversationId: idConversaNativo(options.conversationId),
    workspaceId: ws.id,
    workspacePath: ws.path,
    model: options.model || "default",
    homeDir: home,
    title: options.title || "Conversa com Secretário",
  });

  return { ref, runtime, engineId };
}

/**
 * Envia uma mensagem através da porta canônica ConversationRuntime e gera eventos AgentEvent
 */
export function enviarMensagemSecretario(
  runtime: ConversationRuntime,
  ref: ConversationRef,
  mensagem: string,
  signal?: AbortSignal
): AsyncIterable<AgentEvent> {
  return runtime.send(ref, { text: mensagem }, signal);
}

/**
 * Encerra uma sessão conversacional liberando os recursos associados
 */
export async function encerrarSessaoSecretario(
  runtime: ConversationRuntime,
  ref: ConversationRef
): Promise<void> {
  try {
    await runtime.close(ref);
  } catch (err) {
    console.error(`[secretario] erro ao fechar sessão ${ref.id} no motor ${ref.engineId}:`, err);
  }
}

/**
 * Diagnostica o status de execução do motor do Secretário para o workspace
 */
export async function statusRuntimeSecretario(
  ctx: RouteContext,
  wsId?: string,
  wsPath?: string
): Promise<{
  rodando: boolean;
  configurado: boolean;
  porta: number | null;
  pid: number | null;
  motor: {
    engineId: string;
    nome?: string;
    origem?: string;
    suportaConversa?: boolean;
    preflight?: ConversationPreflightResult | Record<string, unknown>;
    erro?: string;
  };
}> {
  const resolver = ctx.conversationRuntimeResolver ?? new ConversationRuntimeResolver({ homeDir: ctx.homeDir });

  let resolution: ConversationResolutionResult | null = null;
  let erroResolucao: string | null = null;

  try {
    resolution = await resolver.resolve({
      workspaceId: wsId,
      workspaceDir: wsPath,
      strict: false,
    });
  } catch (err) {
    erroResolucao = err instanceof Error ? err.message : String(err);
  }

  const engineId = resolution?.engineId ?? "opencode";
  const processKey = wsId ? formatProcessKey({ engineId, workspaceId: wsId }) : null;
  const proc = processKey ? ProcessRegistry.getInstance().get(processKey) : undefined;

  let rodando = Boolean(proc && proc.state !== "stopped" && proc.state !== "crashed");
  let pid: number | null = proc?.pid ?? null;
  let porta: number | null = proc?.port ?? null;

  // Fallback para servidor OpenCode legado caso o motor resolvido seja OpenCode e opencodeServer esteja ativo
  if (!rodando && ctx.opencodeServer && engineId === "opencode") {
    try {
      const st = await ctx.opencodeServer.status();
      if (st.rodando) {
        rodando = true;
        pid = st.pid ?? null;
        porta = st.porta ?? null;
      }
    } catch {}
  }

  return {
    rodando,
    configurado: resolution ? resolution.preflight.ok || (resolution.engineId === "opencode" && rodando) : false,
    porta,
    pid,
    motor: resolution
      ? {
          engineId: resolution.engineId,
          nome: resolution.adapter.name,
          origem: resolution.source,
          suportaConversa: resolution.preflight.supportsConversation,
          preflight: resolution.preflight,
        }
      : {
          engineId: "unknown",
          erro: erroResolucao ?? undefined,
        },
  };
}

/**
 * Entrega uma decisão HITL ao runtime conversacional do workspace, quando a
 * aprovação foi solicitada pelo motor (ex.: Codex app-server). Retorna `false`
 * se o runtime não reconhece o ID, para que o chamador use o ApprovalsStore.
 * O escopo é sempre o workspace da requisição: um workspace nunca responde
 * aprovações de outro.
 */
export async function responderAprovacaoDoRuntime(
  ctx: RouteContext,
  ws: { id: string; path: string },
  id: string,
  acao: "approve" | "reject"
): Promise<boolean> {
  try {
    const { runtime } = await obterRuntimeSecretario(ctx, ws, false);
    if (!runtime.respondApproval) return false;
    const respondida = await runtime.respondApproval(id, acao, { workspaceId: ws.id });
    // Ponto único das rotas de aprovação (/approvals/... e /secretario/hitl/...): a decisão vai para o log
    // da conversa, que é de onde o histórico lê o status do cartão.
    if (respondida) {
      await new EventLog(ctx.homeDir ?? opencorpHome())
        .registrarAprovacaoResolvida(ws.id, id, acao === "approve" ? "approved" : "rejected")
        .catch(() => false);
    }
    return respondida;
  } catch (erro) {
    console.warn(
      `[secretario/hitl] runtime indisponível para a aprovação ${id}; usando o armazenamento HITL: ${erro instanceof Error ? erro.message : String(erro)}`
    );
    return false;
  }
}
