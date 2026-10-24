/**
 * Rotas de Analytics — visão unificada de todos os workspaces (ou dos escolhidos).
 *
 *   GET /analytics/resumo?ws=a,b&janela=1h|6h|24h|7d
 *
 * `ws` vazio = todos. Não depende do workspace atual: serve a página global /analytics.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coletarAnalytics, JANELAS_ANALYTICS_MS, type WorkspaceAnalyticsEntrada } from "../../core/contexts/analytics/analytics-service.js";
import { opencorpHome } from "../../utils/paths.js";
import type { RouteContext } from "./types.js";

function pidVivo(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lerPid(arquivo: string): number | null {
  try {
    const info = JSON.parse(readFileSync(arquivo, "utf8")) as { pid?: number };
    return typeof info.pid === "number" ? info.pid : null;
  } catch {
    return null;
  }
}

export async function handleAnalyticsRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, enviar, workspaces, homeDir, version, serverPort, opencodeServer } = ctx;
  if (rota !== "/analytics/resumo" || req.method !== "GET") return false;

  const janela = JANELAS_ANALYTICS_MS[url.searchParams.get("janela") ?? "24h"] ?? JANELAS_ANALYTICS_MS["24h"]!;
  const pedidos = (url.searchParams.get("ws") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const todos = await workspaces.listar();
  const escolhidos = pedidos.length > 0 ? todos.filter((w) => pedidos.includes(w.id)) : todos;
  const entradas: WorkspaceAnalyticsEntrada[] = escolhidos.map((w) => ({
    id: w.id,
    path: w.path,
    nome: w.nome,
    pausado: w.pausado,
    pausado_em: w.pausado_em,
  }));

  const resumo = coletarAnalytics(entradas, { janelaMs: janela });

  const home = homeDir ?? opencorpHome();
  const pidScheduler = lerPid(join(home, ".opencorp", "scheduler.pid"));
  let secretarioRodando = false;
  try {
    secretarioRodando = opencodeServer ? (await opencodeServer.status()).rodando === true : false;
  } catch {}

  enviar(res, 200, {
    ...resumo,
    disponiveis: todos.map((w) => ({ id: w.id, nome: w.nome || w.id, pausado: w.pausado === true })),
    selecionados: escolhidos.map((w) => w.id),
    servicos: {
      servidor: {
        rodando: true,
        pid: process.pid,
        porta: serverPort ?? (Number(String(req.headers.host ?? "").split(":")[1]) || null),
        versao: version ?? null,
        uptime_s: Math.round(process.uptime()),
        memoria_mb: Math.round(process.memoryUsage().rss / 1_048_576),
      },
      agendador: { rodando: pidVivo(pidScheduler), pid: pidScheduler },
      secretario: { rodando: secretarioRodando },
    },
  });
  return true;
}
