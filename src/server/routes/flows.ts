import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { eventBus } from "../../core/shared/event-bus.js";
import { migrarTeamsParaFlows } from "../../core/contexts/orchestration/flow-migrate.js";
import type { Flow } from "../../core/contexts/orchestration/flow-store.js";
import type { RouteContext } from "./types.js";

/** Rate limiter in-memory por IP para endpoints webhook fallback */
class LocalWebhookRateLimiter {
  private requests = new Map<string, number[]>();
  constructor(private limit: number = 30, private windowMs: number = 60_000) {}

  check(ip: string): { ok: boolean; retryAfter?: number } {
    const now = Date.now();
    const timestamps = (this.requests.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (timestamps.length >= this.limit) {
      const oldest = timestamps[0] ?? now;
      const retryAfter = Math.ceil((oldest + this.windowMs - now) / 1000);
      return { ok: false, retryAfter: Math.max(retryAfter, 1) };
    }
    timestamps.push(now);
    this.requests.set(ip, timestamps);
    return { ok: true };
  }
}

const fallbackLimiter = new LocalWebhookRateLimiter(30, 60_000);

export async function handleFlowRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, resolverWs, lerCorpo, enviar, flows, registros, teams } = ctx;
  if (!flows) return false;

  // Unifica rotas em português e inglês (/fluxos -> /flows)
  const rota = ctx.rota.replace(/^\/fluxos(\/|$)/, "/flows$1");

  // ── GET /flows ───────────────────────────────────────────────
  if (rota === "/flows" && req.method === "GET") {
    const ws = await resolverWs(url);
    enviar(res, 200, await flows.listar(ws.path));
    return true;
  }

  // ── POST /flows ──────────────────────────────────────────────
  if (rota === "/flows" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as {
      id?: string;
      nome?: string;
      nos?: Flow["nos"];
      arestas?: Flow["arestas"];
      ativo?: boolean;
    };
    const flowId = (corpo.id ?? "").trim();
    const jaExiste = flowId ? existsSync(flows.caminho(ws.path, flowId)) : false;

    // se o flow já existe no workspace e recebeu grafo completo, atualiza de forma idempotente (upsert)
    if (jaExiste && Array.isArray(corpo.nos)) {
      const atual = await flows.obter(ws.path, flowId);
      await flows.salvar(ws.path, {
        id: flowId,
        nome: corpo.nome ?? atual.nome,
        nos: corpo.nos,
        arestas: corpo.arestas ?? [],
        ativo: corpo.ativo ?? atual.ativo ?? true,
      });
      eventBus.emit("flow-salvo", { flow: flowId, workspace: ws.id });
      enviar(res, 200, await flows.obter(ws.path, flowId));
      return true;
    }

    // com grafo no corpo (editor da web), valida e salva inteiro — senão cria só o gatilho
    if (Array.isArray(corpo.nos) && corpo.nos.length > 0) {
      const f = await flows.salvarComId(ws.path, {
        id: flowId,
        nome: corpo.nome ?? flowId,
        nos: corpo.nos,
        arestas: corpo.arestas ?? [],
        ativo: corpo.ativo ?? true,
      });
      eventBus.emit("flow-salvo", { flow: f.id, workspace: ws.id });
      enviar(res, 201, f);
      return true;
    }
    const f = await flows.criar(ws.path, flowId, corpo.nome ?? flowId);
    eventBus.emit("flow-salvo", { flow: f.id, workspace: ws.id });
    enviar(res, 201, f);
    return true;
  }

  // ── POST /flows/import ─────────────────────────────────────────
  if (rota === "/flows/import" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as Record<string, unknown>;
    const payloadFlow =
      corpo && typeof corpo === "object" && "flow" in corpo
        ? corpo.flow
        : corpo && typeof corpo === "object" && "nos" in corpo
        ? corpo
        : corpo?.dados ?? corpo;

    const sobrescrever = Boolean(corpo?.sobrescrever ?? corpo?.force);
    const novoId = corpo?.novoId ?? corpo?.id;

    const importado = await flows.importar(ws.path, payloadFlow, {
      sobrescrever,
      novoId: typeof novoId === "string" && novoId.trim().length > 0 ? novoId.trim() : undefined,
    });
    eventBus.emit("flow-salvo", { flow: importado.id, workspace: ws.id });
    enviar(res, 201, { ok: true, flow: importado });
    return true;
  }

  // ── POST /flows/migrate-teams ──────────────────────────────────
  if (rota === "/flows/migrate-teams" && req.method === "POST") {
    const ws = await resolverWs(url);
    if (!teams) {
      enviar(res, 500, { erro: "TeamStore não configurado" });
      return true;
    }
    enviar(res, 200, await migrarTeamsParaFlows(ws.path, teams, flows));
    return true;
  }

  // ── /flows/:id (GET, PUT, DELETE) ──────────────────────────────
  const mFlow = /^\/flows\/([^/]+)$/.exec(rota);
  if (mFlow && req.method === "GET") {
    const ws = await resolverWs(url);
    enviar(res, 200, await flows.obter(ws.path, decodeURIComponent(mFlow[1]!)));
    return true;
  }

  if (mFlow && req.method === "PUT") {
    const ws = await resolverWs(url);
    const flowId = decodeURIComponent(mFlow[1]!);
    const corpo = (await lerCorpo(req)) as Record<string, unknown>;
    if (corpo.id && corpo.id !== flowId) {
      enviar(res, 422, { erro: `id do corpo ("${String(corpo.id)}") não bate com a rota ("${flowId}")` });
      return true;
    }
    const atual = await flows.obter(ws.path, flowId);
    const nos = Array.isArray(corpo.nos) ? corpo.nos : atual.nos;
    const arestas = Array.isArray(corpo.arestas) ? corpo.arestas : atual.arestas;
    await flows.salvar(ws.path, {
      ...atual,
      ...corpo,
      id: flowId,
      nos,
      arestas,
      nome: String(corpo.nome ?? atual.nome),
      ativo: typeof corpo.ativo === "boolean" ? corpo.ativo : (atual.ativo ?? true),
    } as Parameters<typeof flows.salvar>[1]);
    eventBus.emit("flow-salvo", { flow: flowId, workspace: ws.id });
    enviar(res, 200, await flows.obter(ws.path, flowId));
    return true;
  }

  if (mFlow && req.method === "DELETE") {
    const ws = await resolverWs(url);
    const flowId = decodeURIComponent(mFlow[1]!);
    await flows.deletar(ws.path, flowId);
    eventBus.emit("flow-excluido", { flow: flowId, workspace: ws.id });
    enviar(res, 200, { ok: true, id: flowId });
    return true;
  }

  // ── GET /flows/:id/export ──────────────────────────────────────
  const mFlowExport = /^\/flows\/([^/]+)\/export$/.exec(rota);
  if (mFlowExport && req.method === "GET") {
    const ws = await resolverWs(url);
    const flowId = decodeURIComponent(mFlowExport[1]!);
    const exportData = await flows.exportar(ws.path, flowId);
    if (url.searchParams.get("download") === "1") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="flow-${flowId}.json"`,
      });
      res.end(JSON.stringify(exportData, null, 2));
      return true;
    }
    enviar(res, 200, exportData);
    return true;
  }

  // ── GET /flows/:id/execucoes ou /historico ou /runs ────────────
  const mFlowExecucoes = /^\/flows\/([^/]+)\/(?:execucoes|historico|runs)$/.exec(rota);
  if (mFlowExecucoes && req.method === "GET") {
    const ws = await resolverWs(url);
    const flowId = decodeURIComponent(mFlowExecucoes[1]!);
    enviar(res, 200, await flows.listarExecucoes(ws.path, flowId));
    return true;
  }

  // ── GET /flows/:id/status ──────────────────────────────────────
  const mFlowStatus = /^\/flows\/([^/]+)\/status$/.exec(rota);
  if (mFlowStatus && req.method === "GET") {
    const ws = await resolverWs(url);
    enviar(res, 200, await flows.ultimaExecucao(ws.path, decodeURIComponent(mFlowStatus[1]!)));
    return true;
  }

  // ── POST /flows/:id/run ou /executar ───────────────────────────
  const mFlowRun = /^\/flows\/([^/]+)\/(?:run|executar)$/.exec(rota);
  if (mFlowRun && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { entrada?: string; model?: string; gatilho?: string };
    const flowId = decodeURIComponent(mFlowRun[1]!);
    const dono = flows.emExecucao(ws.path, flowId);
    if (dono) {
      // Sem isto o cliente recebia um exec_id de uma execução que nunca existe (a trava recusa o 2º disparo).
      enviar(res, 409, { erro: `flow "${flowId}" já está em execução (pid ${dono.pid}, desde ${dono.inicio ?? "?"})` });
      return true;
    }
    const execId = `exec-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    let gatilho: { tipo: string; origem: string } | undefined;
    if (typeof corpo.gatilho === "string" && corpo.gatilho.includes(":")) {
      const [tipo, ...resto] = corpo.gatilho.split(":");
      if (tipo && resto.length) gatilho = { tipo, origem: resto.join(":") };
    }
    void flows.executar(ws.path, flowId, { entrada: corpo.entrada, model: corpo.model, execId, gatilho: gatilho as any }).catch(() => undefined);
    enviar(res, 202, { status: "iniciado", flow: flowId, exec_id: execId });
    return true;
  }

  // ── POST /flows/:id/webhook ────────────────────────────────────
  const mFlowWebhook = /^\/flows\/([^/]+)\/webhook$/.exec(rota);
  if (mFlowWebhook && req.method === "POST") {
    const ip = req.socket.remoteAddress || "127.0.0.1";
    const limiter = ctx.webhookLimiter ?? fallbackLimiter;
    const rateCheck = limiter.check(ip);
    if (!rateCheck.ok) {
      res.setHeader("Retry-After", String(rateCheck.retryAfter));
      enviar(res, 429, {
        erro: "Too Many Requests — limite de 30 req/min atingido para webhooks",
        retry_after: rateCheck.retryAfter,
      });
      return true;
    }
    const ws = await resolverWs(url);
    const rawCorpo = await lerCorpo(req);
    const flowId = decodeURIComponent(mFlowWebhook[1]!);
    const entradaStr = typeof rawCorpo === "string" ? rawCorpo : JSON.stringify(rawCorpo ?? {});
    const donoWebhook = flows.emExecucao(ws.path, flowId);
    if (donoWebhook) {
      // Webhook tem que responder 2xx (o remetente reenvia qualquer outra coisa), mas a trava por flow recusa o
      // 2º disparo: dizemos que foi ignorado, sem um exec_id que nunca existirá.
      enviar(res, 202, { ok: true, status: "ignorado_em_execucao", flow: flowId, gatilho: "webhook", exec_id: null, motivo: `flow já está em execução (pid ${donoWebhook.pid}, desde ${donoWebhook.inicio ?? "?"})` });
      return true;
    }
    const execId = `exec-${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
    void flows.executar(ws.path, flowId, { entrada: entradaStr, execId, gatilho: { tipo: "webhook", origem: flowId } as any }).catch((err) => {
      console.error(`[flows] erro ao executar webhook do flow ${flowId}:`, err);
    });
    enviar(res, 202, { ok: true, status: "iniciado", flow: flowId, gatilho: "webhook", exec_id: execId });
    return true;
  }

  // ── POST /flows/:id/resume ─────────────────────────────────────
  const mFlowResume = /^\/flows\/([^/]+)\/resume$/.exec(rota);
  if (mFlowResume && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { exec_id?: string; model?: string };
    if (!corpo.exec_id) {
      enviar(res, 422, { erro: "corpo obrigatório: { exec_id } — id da execução falha a retomar" });
      return true;
    }
    const flowId = decodeURIComponent(mFlowResume[1]!);
    try {
      const meta = await registros.lerMeta(ws.path, "execucoes", corpo.exec_id);
      const ex = (meta.extras ?? {}) as Record<string, unknown>;
      if (ex.tipo !== "flow" || ex.flow !== flowId) {
        enviar(res, 422, { erro: `execução "${corpo.exec_id}" não pertence ao flow "${flowId}"` });
        return true;
      }
      if (ex.status !== "falhou") {
        enviar(res, 422, { erro: `execução "${corpo.exec_id}" está "${String(ex.status ?? "?")}" — só falhas podem ser retomadas` });
        return true;
      }
      const nos = (ex.nos ?? []) as Array<{ status?: string }>;
      if (!nos.some((n) => n.status !== "ok")) {
        enviar(res, 422, { erro: `execução "${corpo.exec_id}" não tem nós pendentes para retomar` });
        return true;
      }
    } catch (erro) {
      const msg = erro instanceof Error ? erro.message : String(erro);
      if (!msg.startsWith("execução")) {
        enviar(res, 404, { erro: `execução "${corpo.exec_id}" não encontrada` });
        return true;
      }
      enviar(res, 422, { erro: msg });
      return true;
    }
    void flows
      .executar(ws.path, flowId, { model: corpo.model, execId: corpo.exec_id, retomar: true })
      .catch((err) => {
        console.error(`[flows] erro ao retomar ${flowId}/${corpo.exec_id}:`, err);
      });
    enviar(res, 202, { status: "retomando", flow: flowId, exec_id: corpo.exec_id });
    return true;
  }

  // ── GET /webhooks ──────────────────────────────────────────────
  if (rota === "/webhooks" && req.method === "GET") {
    const ws = await resolverWs(url);
    const porta = ctx.serverPort ? String(ctx.serverPort) : "";
    const baseUrl = porta ? `http://localhost:${porta}` : "";
    const webhooks = await flows.listarWebhooks(ws.path, baseUrl);
    enviar(res, 200, webhooks);
    return true;
  }

  // ── GET /audit/flows ───────────────────────────────────────────
  if (rota === "/audit/flows" && req.method === "GET") {
    const ws = await resolverWs(url);
    const limite = Math.min(Math.max(parseInt(String(url.searchParams.get("limite") ?? "50"), 10) || 50, 1), 200);
    let eventos = await registros.lerJournal(ws.path, "logs", "audit-log");
    eventos = eventos.filter((e) => Boolean((e as Record<string, unknown>).flow_id) || String(e.por ?? "").startsWith("flow:") || String(e.evento ?? "").startsWith("flow_"));
    eventos.reverse();
    enviar(res, 200, { total: eventos.length, limite, eventos: eventos.slice(0, limite) });
    return true;
  }

  return false;
}
