import { resolverModelos } from "./helpers.js";
import type { RouteContext } from "../types.js";
import { ConversationRuntimeResolver } from "../../../core/engines/conversation-resolver.js";
import { formatProcessKey, ProcessRegistry } from "../../../core/runtime/index.js";
import {
  obterRuntimeSecretario,
  statusRuntimeSecretario,
} from "./runtime-service.js";

export async function handleDaemonRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, resolverWs, enviar, tasks, agentes } = ctx;

  if (rota === "/secretario/status" && req.method === "GET") {
    let wsId: string | undefined;
    let wsPath: string | undefined;
    try {
      const ws = await resolverWs(url);
      wsId = ws?.id;
      wsPath = ws?.path;
    } catch {}

    const status = await statusRuntimeSecretario(ctx, wsId, wsPath);
    enviar(res, 200, status);
    return true;
  }

  if (rota === "/secretario/start" && req.method === "POST") {
    let ws: { id: string; path: string } | undefined;
    try {
      ws = await resolverWs(url);
    } catch {}

    if (!ws) {
      enviar(res, 500, { erro: "workspace não resolvido" });
      return true;
    }

    try {
      const { resolution, engineId } = await obterRuntimeSecretario(ctx, ws, false);
      const key = formatProcessKey({ engineId, workspaceId: ws.id });
      const proc = ProcessRegistry.getInstance().get(key);

      enviar(res, 200, {
        pid: proc?.pid ?? null,
        porta: proc?.port ?? null,
        agentes: resolution.preflight.ok ? "configurados" : 0,
        motor: engineId,
      });
    } catch (erro) {
      const mensagem = erro instanceof Error ? erro.message : String(erro);
      enviar(res, 500, { erro: `falha ao iniciar secretário: ${mensagem}` });
    }
    return true;
  }

  if (rota === "/secretario/stop" && req.method === "POST") {
    let ws: { id: string; path: string } | undefined;
    try {
      ws = await resolverWs(url);
    } catch {}

    if (ws) {
      try {
        const resolver = ctx.conversationRuntimeResolver ?? new ConversationRuntimeResolver({ homeDir: ctx.homeDir });
        const resolucao = await resolver.resolve({ workspaceId: ws.id, workspaceDir: ws.path, strict: false });
        if (resolucao?.engineId) {
          await ProcessRegistry.getInstance().terminate(
            { engineId: resolucao.engineId, workspaceId: ws.id },
            "stop"
          );
        }
      } catch {}
    }

    enviar(res, 200, { ok: true });
    return true;
  }

  if (rota === "/secretario/contexto" && req.method === "GET") {
    const ws = await resolverWs(url);
    const listaAgentes = agentes ? await agentes.listar(ws.path).catch(() => []) : [];
    const listaTasks = tasks ? await tasks.listar(ws.path).catch(() => []) : [];
    const { modelos, motorPadrao } = await resolverModelos(ctx, { wsPath: ws.path });

    let motorAtivo = motorPadrao;
    try {
      const resolver = ctx.conversationRuntimeResolver ?? new ConversationRuntimeResolver({ homeDir: ctx.homeDir });
      const resCtx = await resolver.resolve({ workspaceId: ws.id, workspaceDir: ws.path, strict: false });
      if (resCtx?.engineId) {
        motorAtivo = resCtx.engineId;
      }
    } catch {}

    enviar(res, 200, {
      workspace: { id: ws.id, path: ws.path },
      agentes: listaAgentes.map((a) => ({ id: a.id, role: a.role, ativo: a.ativo })),
      tasks_em_andamento: listaTasks.filter((t) => t.coluna === "fazendo").length,
      total_tasks: listaTasks.length,
      motor_ativo: motorAtivo,
      modelo_principal: modelos[0] ?? null,
      modelos_disponiveis: modelos,
    });
    return true;
  }

  if (rota === "/secretario/sugestoes" && req.method === "GET") {
    enviar(res, 200, {
      sugestoes: [
        "/status",
        "/task list",
        "/agents",
        "/doctor",
        "/git status",
        "/schedules",
      ],
    });
    return true;
  }

  return false;
}
