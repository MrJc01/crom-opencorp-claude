import { opencorpHome } from "../../../utils/paths.js";
import { EventLog, type EntradaLog } from "../../../core/engines/event-log.js";
import { criarTradutorSse } from "./sse-eventos.js";
import { obterRuntimeSecretario } from "./runtime-service.js";
import { streamsSecretarioAtivos } from "./stream.js";
import type { RouteContext } from "../types.js";

/** Intervalo do comentário SSE que mantém a conexão aberta durante esperas longas (aprovação). */
export const HEARTBEAT_EVENTOS_MS = 15_000;

/**
 * GET /secretario/sessoes/:id/eventos?workspace=<ws>&desde=<N>
 * Reassina um turno que continuou vivo depois que a conexão original caiu: reenvia as entradas do log a
 * partir do índice N e acompanha as novas até o turno terminar. Mesmos nomes de evento do stream do turno
 * (+ `aprovacao_resolvida`). Sem turno vivo: `event: inativo` e fecha.
 */
export async function handleEventosRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, resolverWs, homeDir } = ctx;

  const m = /^\/secretario\/sessoes\/([^/]+)\/eventos$/.exec(rota);
  if (!m || req.method !== "GET") return false;

  const sessaoId = decodeURIComponent(m[1]!);
  const desdeBruto = Number.parseInt(url.searchParams.get("desde") ?? "0", 10);
  const desde = Number.isFinite(desdeBruto) && desdeBruto > 0 ? desdeBruto : 0;
  const ws = await resolverWs(url);
  const log = new EventLog(homeDir ?? opencorpHome());

  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
    "x-accel-buffering": "no",
  });
  const escrever = (texto: string): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(texto);
  };
  const sse = (evento: string, dados: unknown): void => escrever(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  escrever(": ok\n\n");

  const motor = await obterRuntimeSecretario(ctx, ws, false).then((r) => r.engineId).catch(() => "");
  const traduzir = criarTradutorSse({ workspaceId: ws.id, motor, sse, incluirResolucoes: true });
  let proximo = desde;
  const emitir = (entrada: EntradaLog, indice: number): void => {
    if (indice < proximo) return;
    proximo = indice + 1;
    if (entrada.tipo === "evento") traduzir(entrada.ev, entrada.resumo);
  };

  let encerrada = false;
  let cancelar: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const encerrar = (): void => {
    if (encerrada) return;
    encerrada = true;
    cancelar?.();
    if (heartbeat) clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  };
  res.on("close", encerrar);

  // Assina ANTES de ler o backlog; o índice descarta o que as duas fontes entregarem em duplicidade.
  // Entradas que chegam durante a leitura ficam em fila e só saem depois do backlog, em ordem.
  let backlogPronto = false;
  let fimPendente = false;
  const espera: Array<[EntradaLog, number]> = [];
  cancelar = log.assinar(ws.id, sessaoId, {
    entrada: (e, i) => (backlogPronto ? emitir(e, i) : espera.push([e, i])),
    fimTurno: () => (backlogPronto ? encerrar() : (fimPendente = true)),
  });

  const entradas = await log.ler(ws.id, sessaoId);
  if (encerrada) return true;
  entradas.forEach((e, i) => emitir(e, i));
  backlogPronto = true;
  espera.sort((a, b) => a[1] - b[1]).forEach(([e, i]) => emitir(e, i));
  espera.length = 0;

  if (!streamsSecretarioAtivos.has(sessaoId) || fimPendente) {
    sse("inativo", { sessao_id: sessaoId });
    encerrar();
    return true;
  }
  heartbeat = setInterval(() => escrever(": ping\n\n"), HEARTBEAT_EVENTOS_MS);
  heartbeat.unref?.();
  return true;
}
