import { fetchOpencode } from "../../../core/contexts/execution/opencode-server.js";
import type { ServerResponse } from "node:http";
import { opencorpHome } from "../../../utils/paths.js";
import { eventBus } from "../../../core/shared/event-bus.js";
import {
  limparPrefixoWorkspace,
  extrairPassosMensagens,
  extrairAcoesMensagens,
  SecretarioError,
  type MensagemOc,
} from "../../../core/contexts/execution/opencode-server.js";
import { EngineAccountStore } from "../../../core/engines/index.js";
import { EventLog, type EntradaLog } from "../../../core/engines/event-log.js";
import type { AgentEvent } from "../../../core/engines/events.js";
import { TelemetryCollector, gerarTraceId, type TraceContext } from "../../../core/contexts/platform/telemetry-collector.js";
import {
  sleep,
  parsearModelo,
  trocarModeloEngine,
  obterPorta,
  sincronizarCorp,
  resolverModelos,
  limparMensagensTentativaFalha,
} from "./helpers.js";
import { construirContextoWorkspace } from "./context-builder.js";
import { resolverMencoes } from "./mentions.js";
import { processarSlash, textoAjudaSlash } from "./slash.js";
import { idConversaNativo, obterRuntimeSecretario } from "./runtime-service.js";
import { criarTradutorSse, resumirFerramenta } from "./sse-eventos.js";
import type { RouteContext } from "../types.js";

/** Streams `/secretario/conversa/stream` em voo por sessão. */
export const streamsSecretarioAtivos = new Map<string, { res: { destroyed: boolean; writableEnded: boolean } }>();
/** Timers de grace period antes de abortar caso o cliente reconecte (ex: F5 / refresh). */
export const timersGraceAbort = new Map<string, NodeJS.Timeout>();

interface StreamEnfileirado {
  sessaoId: string;
  res: ServerResponse;
  run: () => void | Promise<void>;
  expiraEm: number;
  timer: NodeJS.Timeout | null;
}
export const filaStreamsSecretario = new Map<string, StreamEnfileirado[]>();
export const LEASE_STREAM_MS = 60_000;

export function enfileirarStreamSecretario(
  sessaoId: string,
  res: ServerResponse,
  run: () => void | Promise<void>,
): number {
  const lista = filaStreamsSecretario.get(sessaoId) ?? [];
  const posicao = lista.length;
  const entrada: StreamEnfileirado = { sessaoId, res, run, expiraEm: Date.now() + LEASE_STREAM_MS, timer: null };
  entrada.timer = setTimeout(() => {
    removerDaFilaStream(sessaoId, entrada);
    try {
      if (!res.destroyed && !res.writableEnded) {
        res.writeHead(503, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ erro: "tempo de espera na fila esgotado — tente novamente" }));
      }
    } catch { }
  }, LEASE_STREAM_MS);
  lista.push(entrada);
  filaStreamsSecretario.set(sessaoId, lista);
  return posicao;
}

export function removerDaFilaStream(sessaoId: string, entrada: StreamEnfileirado): void {
  const lista = filaStreamsSecretario.get(sessaoId);
  if (!lista) return;
  const idx = lista.indexOf(entrada);
  if (idx >= 0) lista.splice(idx, 1);
  if (lista.length === 0) filaStreamsSecretario.delete(sessaoId);
  if (entrada.timer) clearTimeout(entrada.timer);
}

export function liberarStreamSecretario(sessaoId: string, res: { destroyed: boolean; writableEnded: boolean }): void {
  const timerGrace = timersGraceAbort.get(sessaoId);
  if (timerGrace) {
    clearTimeout(timerGrace);
    timersGraceAbort.delete(sessaoId);
  }
  if (streamsSecretarioAtivos.get(sessaoId)?.res === res) {
    streamsSecretarioAtivos.delete(sessaoId);
    const lista = filaStreamsSecretario.get(sessaoId);
    const proximo = lista?.[0];
    if (proximo) {
      removerDaFilaStream(sessaoId, proximo);
      void Promise.resolve()
        .then(() => proximo.run())
        .catch(() => undefined);
    }
  }
}

export async function handleStreamRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, resolverWs, lerCorpo, enviar, registros, homeDir, workspaces } = ctx;
  const home = homeDir ?? opencorpHome();

  if (rota === "/secretario/conversa/stream" && req.method === "POST") {
    let chaveStreamRegistrada: string | undefined;
    const sse = (evento: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${evento}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const corpo = (await lerCorpo(req)) as {
        mensagem?: string;
        prompt?: string;
        sessao_id?: string;
        agente?: string;
        modelo?: string;
        model?: string;
        motor?: string;
        engine?: string;
        imagens?: Array<{ nome?: string; mime?: string; url?: string }>;
        contexto?: string[];
        workspace?: string;
      };
      if (corpo.workspace && !url.searchParams.has("workspace")) {
        url.searchParams.set("workspace", String(corpo.workspace));
      }
      const mensagemBruta = limparPrefixoWorkspace((corpo.mensagem ?? corpo.prompt ?? "").trim());
      const imagens = (corpo.imagens ?? []).filter((i) => i && typeof i.url === "string" && i.url.startsWith("data:image/")).slice(0, 4);
      if (!mensagemBruta && imagens.length === 0) {
        enviar(res, 400, { erro: "mensagem obrigatória" });
        return true;
      }

      const ws = await resolverWs(url);
      let sessaoCandidata = corpo.sessao_id || url.searchParams.get("sessao") || undefined;

      // Isolamento estrito de Workspace:
      // Se a sessão possui mensagens registradas no corpDb de outro workspace,
      // não contamina o histórico anterior e inicia uma nova sessão dedicada neste workspace.
      if (sessaoCandidata && registros && workspaces) {
        try {
          const todosWs = await workspaces.listar().catch(() => []);
          for (const outroWs of todosWs) {
            if (outroWs.id !== ws.id && outroWs.existe) {
              const msgsOutro = registros.corpDb(outroWs.path).listarMensagens(sessaoCandidata);
              if (msgsOutro && msgsOutro.length > 0) {
                console.warn(`[secretario/stream] Sessão ${sessaoCandidata} pertence ao workspace "${outroWs.id}". Isolando e criando nova sessão para "${ws.id}".`);
                sessaoCandidata = undefined;
                if (corpo.sessao_id) delete corpo.sessao_id;
                break;
              }
            }
          }
        } catch {}
      }

      const executarStream = async (): Promise<void> => {
        const emSegundoPlano = res.writableEnded;
        let onClientClose: (() => void) | null = null;
        try {
          if (sessaoCandidata) {
            const ocupante = streamsSecretarioAtivos.get(sessaoCandidata);
            if (ocupante) {
              if (ocupante.res.destroyed || ocupante.res.writableEnded) {
                streamsSecretarioAtivos.delete(sessaoCandidata);
              } else {
                const posicao = enfileirarStreamSecretario(sessaoCandidata, res, executarStream);
                enviar(res, 429, { erro: "sessão ocupada em outra execução — requisição enfileirada", posicao });
                return;
              }
            }
            streamsSecretarioAtivos.set(sessaoCandidata, { res });
            chaveStreamRegistrada = sessaoCandidata;
          }

          // FAST-PATH: Comandos Git Slash
          if (/^(\/git|\/restore|\/descartar|\/status-git|\/rollback)/i.test(mensagemBruta)) {
            const ws = await resolverWs(url);
            const { processarComandoGitSecretario } = await import("../../../core/contexts/workspace/secretario-git-slash.js");
            const resultadoGit = await processarComandoGitSecretario(mensagemBruta, ws.path, ws.id);
            if (resultadoGit.tratado) {
              if (!res.headersSent && !res.writableEnded) {
                res.writeHead(200, {
                  "content-type": "text/event-stream; charset=utf-8",
                  "cache-control": "no-cache",
                  "connection": "keep-alive",
                  "access-control-allow-origin": "*",
                  "x-accel-buffering": "no",
                });
              }
              const sId = corpo.sessao_id || url.searchParams.get("sessao") || `sessao-git-${Date.now()}`;
              sse("inicio", { sessao_id: sId });
              sse("delta", {
                delta: resultadoGit.mensagem,
                gitStatus: resultadoGit.gitStatus,
                gitDiff: resultadoGit.gitDiff,
              });
              sse("fim", {
                content: resultadoGit.mensagem,
                resposta: resultadoGit.mensagem,
                gitStatus: resultadoGit.gitStatus,
                gitDiff: resultadoGit.gitDiff,
              });
              if (chaveStreamRegistrada) liberarStreamSecretario(chaveStreamRegistrada, res);
              res.end();
              return;
            }
          }

          // FAST-PATH: ações `/` whitelistadas
          if (/^\//.test(mensagemBruta)) {
            const ws = await resolverWs(url);
            const acao = await processarSlash(ctx, mensagemBruta, ws);
            const respostaAcao = acao.tratado
              ? acao.mensagem
              : `Comando "${mensagemBruta.split(/\s+/)[0]}" não reconhecido.\n\n${textoAjudaSlash()}`;
            if (!res.headersSent && !res.writableEnded) {
              res.writeHead(200, {
                "content-type": "text/event-stream; charset=utf-8",
                "cache-control": "no-cache",
                "connection": "keep-alive",
                "access-control-allow-origin": "*",
                "x-accel-buffering": "no",
              });
            }
            const sId = corpo.sessao_id || url.searchParams.get("sessao") || `sessao-acao-${Date.now()}`;
            sse("inicio", { sessao_id: sId });
            sse("delta", { delta: respostaAcao });
            sse("fim", { content: respostaAcao, resposta: respostaAcao });
            if (chaveStreamRegistrada) liberarStreamSecretario(chaveStreamRegistrada, res);
            res.end();
            return;
          }

          const ws = await resolverWs(url);
          const resolvido = await resolverMencoes(ctx, {
            mensagemBruta,
            corpoContexto: corpo.contexto,
            agenteAtual: corpo.agente ?? "secretario-exec",
            ws,
          });
          const mensagem = resolvido.mensagem;
          const fluxosContexto = (corpo.contexto ?? [])
            .map((item) => String(item).match(/^#?(?:flow|fluxo):(.+)$/i)?.[1]?.trim())
            .filter((id): id is string => Boolean(id));

          if (!res.headersSent && !res.writableEnded) {
            res.writeHead(200, {
              "content-type": "text/event-stream; charset=utf-8",
              "cache-control": "no-cache",
              "connection": "keep-alive",
              "access-control-allow-origin": "*",
              "x-accel-buffering": "no",
            });
          }

          const motorSolicitado = corpo.motor || corpo.engine;
          if (motorSolicitado === "direct-llm") {
            const { DirectLlmConversationDriver } = await import("../../../core/conversation/DirectLlmConversationDriver.js");
            const driverDirect = new DirectLlmConversationDriver({ homeDir: ctx.homeDir });
            const sId = corpo.sessao_id || url.searchParams.get("sessao") || `ses_direct_${Date.now()}`;
            await driverDirect.enviarMensagemStream(
              {
                sessaoId: sId,
                mensagem,
                agente: resolvido.agente ?? "secretario-exec",
                modelo: corpo.modelo || corpo.model,
                wsPath: ws.path,
                wsId: ws.id,
              },
              (evento) => sse(evento.tipo, evento.dados),
            );
            if (chaveStreamRegistrada) liberarStreamSecretario(chaveStreamRegistrada, res);
            res.end();
            return;
          }

          const runtimeCtx = await obterRuntimeSecretario(ctx, ws, true);
          if (runtimeCtx.engineId !== "opencode") {
            const contextoWs = await construirContextoWorkspace(ws);
            const mensagemStreamComWs = `${contextoWs}\n${mensagem}`;
            // Sem ID, o runtime cria a conversa e devolve o ID nativo; inventar um
            // ID aqui faria motores com threads nativas tentarem retomar algo inexistente.
            const sId = idConversaNativo(corpo.sessao_id || url.searchParams.get("sessao"));
            const agente = resolvido.agente ?? "secretario-exec";
            const modelo = corpo.modelo || corpo.model || "default";

            const ref = await runtimeCtx.runtime.create({
              conversationId: sId,
              workspaceId: ws.id,
              workspacePath: ws.path,
              model: modelo,
              homeDir: home,
              title: mensagem.slice(0, 60),
            });

            if (chaveStreamRegistrada && chaveStreamRegistrada !== ref.id) {
              streamsSecretarioAtivos.delete(chaveStreamRegistrada);
              streamsSecretarioAtivos.set(ref.id, { res });
              chaveStreamRegistrada = ref.id;
            } else if (!chaveStreamRegistrada) {
              streamsSecretarioAtivos.set(ref.id, { res });
              chaveStreamRegistrada = ref.id;
            }

            sse("inicio", {
              sessao_id: ref.id,
              agente,
              modelo,
              motor: runtimeCtx.engineId,
            });

            const traduzir = criarTradutorSse({ workspaceId: ws.id, motor: runtimeCtx.engineId, sse });
            const log = new EventLog(home);
            let filaLog: Promise<void> = Promise.resolve();
            const gravar = (entrada: EntradaLog): void => {
              filaLog = filaLog
                .then(() => log.anexar(ws.id, ref.id, entrada))
                .catch((e) => console.warn(`[secretario/log] ${e instanceof Error ? e.message : String(e)}`));
            };
            let deltaPendente = "";
            const gravarEvento = (ev: AgentEvent, resumo?: string): void => {
              if (ev.type === "message.delta") {
                deltaPendente += ev.text;
                return;
              }
              if (deltaPendente) {
                gravar({ t: new Date().toISOString(), tipo: "evento", ev: { type: "message.delta", runId: ev.runId, text: deltaPendente } });
                deltaPendente = "";
              }
              gravar({ t: new Date().toISOString(), tipo: "evento", ev, ...(resumo ? { resumo } : {}) });
            };
            gravar({ t: new Date().toISOString(), tipo: "user", text: mensagem });
            const ac = new AbortController();
            // Com uma aprovação pendente, sair da tela não pode matar o turno: o dono volta, vê o cartão
            // no histórico e decide. O prazo da própria aprovação (10 min) limita a espera.
            let aguardandoAprovacao = false;
            onClientClose = () => {
              if (!res.writableEnded && !aguardandoAprovacao) ac.abort();
            };
            res.on("close", onClientClose);

            try {
              for await (const ev of runtimeCtx.runtime.send(ref, { text: mensagemStreamComWs }, ac.signal)) {
                if (ev.type === "approval.requested") aguardandoAprovacao = true;
                else if (ev.type === "tool.completed" || ev.type === "message.delta" || ev.type === "run.completed" || ev.type === "run.failed") aguardandoAprovacao = false;
                gravarEvento(ev, ev.type === "tool.requested" ? resumirFerramenta(ev.call.name, ev.call.arguments) : undefined);
                traduzir(ev);
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              sse("erro", { erro: msg });
            } finally {
              if (deltaPendente) {
                gravar({ t: new Date().toISOString(), tipo: "evento", ev: { type: "message.delta", runId: ref.id, text: deltaPendente } });
                deltaPendente = "";
              }
              if (chaveStreamRegistrada) liberarStreamSecretario(chaveStreamRegistrada, res);
              if (!res.writableEnded) res.end();
              // Quem reassinou o log (GET /secretario/sessoes/:id/eventos) fecha ao fim do turno.
              void filaLog.then(() => log.encerrarTurno(ws.id, ref.id));
            }
            return;
          }

          const porta = await obterPorta(ctx, true, ws.id);
          const baseUrl = `http://127.0.0.1:${porta}`;
          const agente = resolvido.agente ?? "secretario-exec";
          let sessaoId = corpo.sessao_id || url.searchParams.get("sessao") || undefined;

          const modeloSolicitado = corpo.modelo || corpo.model;
          const { modelos: modelosFallback, motorPadrao } = await resolverModelos(ctx, {
            modeloRequisicao: modeloSolicitado,
            agenteId: agente,
            wsPath: ws.path,
          });

          const modeloInicial = modelosFallback[0]!;

          let sessaoExiste = false;
          if (sessaoId) {
            try {
              const checkRes = await fetchOpencode(`${baseUrl}/session/${encodeURIComponent(sessaoId)}`, {
                signal: AbortSignal.timeout(3000),
              });
              if (checkRes.ok) sessaoExiste = true;
            } catch { }
          }

          if (!sessaoId || !sessaoExiste) {
            const createRes = await fetchOpencode(`${baseUrl}/session`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                title: mensagem.slice(0, 60),
                agent: agente,
              }),
              signal: AbortSignal.timeout(10000),
            });
            if (!createRes.ok) {
              sse("erro", { erro: `falha ao criar sessão no motor: ${createRes.status}` });
              res.end();
              return;
            }
            const sessionData = (await createRes.json()) as { id: string };
            sessaoId = sessionData.id;
            if (modeloInicial) {
              await trocarModeloEngine(baseUrl, sessaoId, modeloInicial);
            }
          } else if (modeloSolicitado) {
            await trocarModeloEngine(baseUrl, sessaoId, modeloSolicitado);
          }

          sse("inicio", {
            sessao_id: sessaoId,
            agente,
            modelo: modeloInicial,
            motor: motorSolicitado || motorPadrao,
          });
          eventBus.emit("secretario.mensagem", {
            sessao_id: sessaoId,
            fase: "inicio",
            agente,
            modelo: modeloInicial,
            workspace: ws.id,
            fluxos: fluxosContexto,
          });

          // Limpa timer de grace period pendente desta sessão se cliente reconectou
          const timerGracePendente = timersGraceAbort.get(sessaoId);
          if (timerGracePendente) {
            clearTimeout(timerGracePendente);
            timersGraceAbort.delete(sessaoId);
          }

          if (chaveStreamRegistrada && chaveStreamRegistrada !== sessaoId) {
            streamsSecretarioAtivos.delete(chaveStreamRegistrada);
            streamsSecretarioAtivos.set(sessaoId, { res });
            chaveStreamRegistrada = sessaoId;
          } else if (!chaveStreamRegistrada) {
            streamsSecretarioAtivos.set(sessaoId, { res });
            chaveStreamRegistrada = sessaoId;
          }

          const baseUrlSessao = `${baseUrl}/session/${sessaoId}`;
          const listarMensagens = async (): Promise<MensagemOc[] | null> => {
            try {
              const getRes = await fetchOpencode(`${baseUrlSessao}/message`, { signal: AbortSignal.timeout(5000) });
              if (!getRes.ok) return null;
              const msgs = (await getRes.json()) as MensagemOc[];
              return Array.isArray(msgs) ? msgs : null;
            } catch {
              return null;
            }
          };
          const passosM = (m: MensagemOc) => extrairPassosMensagens([m]);
          const textoDe = (m: MensagemOc): string =>
            passosM(m).filter((p) => p.tipo === "texto").map((p) => p.texto ?? "").join("\n");
          const pensamentoDe = (m: MensagemOc): string =>
            passosM(m).filter((p) => p.tipo === "pensamento").map((p) => p.texto ?? "").join("\n\n---\n\n");

          const baseMsgs = (await listarMensagens()) ?? [];
          const baseAssistant = [...baseMsgs].reverse().find((m) => m.info?.role === "assistant");
          const baselineId = baseAssistant?.info?.id ?? null;
          const idsBaseInicial = new Set(baseMsgs.map((m) => m.info?.id).filter(Boolean));

          let modeloIdx = 0;
          let tentativasTotais = 0;
          const maxTentativas = Math.max(1, modelosFallback.length);
          let concluida = false;

          onClientClose = () => {
            if (!concluida && !emSegundoPlano) {
              // Tolerância de 25s para recarregamento de página (F5) ou oscilações de rede sem matar o modelo
              const t = setTimeout(() => {
                timersGraceAbort.delete(sessaoId);
                const streamAtual = streamsSecretarioAtivos.get(sessaoId);
                if (!concluida && (!streamAtual || streamAtual.res.destroyed || streamAtual.res.writableEnded)) {
                  void fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => {});
                }
              }, 25_000);
              timersGraceAbort.set(sessaoId, t);
            }
          };
          res.on("close", onClientClose);
          let postData: MensagemOc | null = null;
          let enviado = "";
          let enviadoPensamento = "";
          let acoesAvisadas = 0;
          let itensAssinatura = "";
          let modeloAtivoFinal = modeloInicial;

          while (tentativasTotais < maxTentativas && !concluida) {
            const modeloAtual = modelosFallback[modeloIdx % modelosFallback.length]!;
            modeloAtivoFinal = modeloAtual;
            const { providerID: modProvider, modelID: modId } = parsearModelo(modeloAtual);
            const modelPayload = modProvider && modId ? { providerID: modProvider, modelID: modId } : undefined;

            if (tentativasTotais > 0) {
              sse("status", {
                tipo: "fallback_modelo",
                modelo: modeloAtual,
                aviso: `⚡ Alternando automaticamente para ${modeloAtual}...`,
              });
              eventBus.emit("secretario.mensagem", {
                sessao_id: sessaoId,
                fase: "alternando_modelo",
                modelo: modeloAtual,
              });

              await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
              await sleep(350);
              await trocarModeloEngine(baseUrl, sessaoId, modeloAtual);
              await sleep(200);
            }

            const contextoWs = await construirContextoWorkspace(ws);
            const mensagemStreamComWs = `${contextoWs}\n${mensagem}`;

            const msgsPreExistentes = (await listarMensagens()) ?? [];
            const idsMensagensAntesTentativa = new Set(msgsPreExistentes.map((m) => m.info?.id).filter(Boolean));

            const inicioTurnoIdx = baselineId ? msgsPreExistentes.findIndex((m) => m.info?.id === baselineId) : -1;
            const msgsDesteTurno = inicioTurnoIdx >= 0 ? msgsPreExistentes.slice(inicioTurnoIdx + 1) : msgsPreExistentes;
            const assistentesDesteTurno = msgsDesteTurno.filter((m) => m.info?.role === "assistant");
            const temTextoPrevioSubstancial = assistentesDesteTurno.some((a) => (textoDe(a) || "").trim().length > 20);

            const hasExistingContinuation = msgsDesteTurno.some((m) => {
              if (m.info?.role !== "user") return false;
              const textPart = m.parts?.find((p) => p.type === "text");
              const content = textPart?.text ?? "";
              return typeof content === "string" && content.startsWith("Continue a execução");
            });
            const textoParaEnvio = temTextoPrevioSubstancial && tentativasTotais > 0 && !hasExistingContinuation
              ? "Continue a execução anterior exatamente de onde parou. Conclua todas as análises e ações pendentes até finalizar a demanda por completo."
              : mensagemStreamComWs;

            let postConcluido = false;
            let postErro: string | null = null;
            void fetchOpencode(`${baseUrlSessao}/message`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                sessionID: sessaoId,
                agent: agente,
                ...(modelPayload ? { model: modelPayload } : {}),
                parts: [
                  { type: "text", text: textoParaEnvio },
                  ...imagens.map((i) => ({ type: "file", mime: i.mime ?? "image/png", url: i.url! })),
                ],
              }),
              signal: AbortSignal.timeout(3_600_000),
            }).then(async (r) => {
              if (!r.ok) {
                postErro = `motor /message respondeu HTTP ${r.status}`;
              } else {
                try {
                  postData = (await r.json()) as MensagemOc;
                } catch { }
              }
              postConcluido = true;
            }).catch((err) => {
              postErro = `motor /message falhou (${err.name === "AbortError" ? "timeout" : "conexão"})`;
              postConcluido = true;
            });

            let inicioTentativa = Date.now();
            const tentativaTimeoutMs = 3_600_000;
            let vazioDesde: number | null = null;
            let tentouFallback = false;

            while (Date.now() - inicioTentativa < tentativaTimeoutMs) {
              await sleep(700);
              if (!emSegundoPlano && (res.destroyed || res.writableEnded)) {
                void fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
                liberarStreamSecretario(sessaoId, res);
                return;
              }

              if (!postErro) {
                try {
                  const statusRes = await fetchOpencode(`${baseUrl}/session/status`, { signal: AbortSignal.timeout(2000) });
                  if (statusRes.ok) {
                    const statusMap = (await statusRes.json()) as Record<string, any>;
                    const sessStatus = statusMap[sessaoId];
                    if (sessStatus?.type === "retry") {
                      const msgRetry = sessStatus.message || sessStatus.action?.message || "limite de cota atingido";
                      postErro = `motor status retry: ${msgRetry}`;
                      await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
                    }
                  }
                } catch { }
              }

              if (postErro && !concluida) {
                if (modeloAtual.startsWith("opencode-go/") && postErro.includes("limit")) {
                  try {
                    const acctStore = new EngineAccountStore({ homeDir: home });
                    const proxConta = await acctStore.rotacionarProximaConta("opencode-go", ws.id);
                    if (proxConta) {
                      await fetchOpencode(`${baseUrl}/abort`, { method: "POST" }).catch(() => { });
                      await sleep(500);
                    }
                  } catch { }
                }

                if (tentativasTotais < maxTentativas - 1) {
                  const proximo = modelosFallback[(modeloIdx + 1) % modelosFallback.length]!;
                  console.warn(`[secretario] Modelo ${modeloAtual} falhou (${postErro}). Alternando para ${proximo}...`);
                  sse("status", {
                    tipo: "fallback_modelo",
                    modelo: proximo,
                    aviso: `⚠️ O modelo ${modeloAtual} falhou (${postErro}). Alternando automaticamente para ${proximo}...`,
                    erro: true,
                  });
                  tentouFallback = true;
                  if ((modeloIdx + 1) % modelosFallback.length === 0) {
                    await sleep(2000);
                  }
                  break;
                } else {
                  await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
                  await limparMensagensTentativaFalha(baseUrlSessao, idsMensagensAntesTentativa, false);
                  sse("erro", { erro: `Falha ao conectar com o modelo (${postErro}). Todos os modelos de contingência foram tentados sem sucesso.`, sessao_id: sessaoId });
                  eventBus.emit("secretario.mensagem", { sessao_id: sessaoId, fase: "erro" });
                  liberarStreamSecretario(sessaoId, res);
                  res.end();
                  return;
                }
              }

              const msgs = await listarMensagens();
              if (msgs) {
                const inicioIdx = baselineId ? msgs.findIndex((m) => m.info?.id === baselineId) : -1;
                const novasMsgs = inicioIdx >= 0 ? msgs.slice(inicioIdx + 1) : msgs;
                const assistentesNovas = novasMsgs.filter((m) => m.info?.role === "assistant");

                const msgComErro = assistentesNovas.find((m) => {
                  if (!Boolean((m.info as any)?.error)) return false;
                  if (m.info?.id && idsMensagensAntesTentativa.has(m.info.id)) return false;
                  return true;
                });
                if (msgComErro && !postErro) {
                  const errObj = (msgComErro.info as any).error;
                  const desc = errObj?.data?.message || errObj?.message || errObj?.name || "erro na chamada de API do modelo";
                  postErro = `erro no modelo: ${desc}`;
                  await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
                  continue;
                }

                if (assistentesNovas.length > 0) {
                  const passosEmTempoReal = extrairPassosMensagens(assistentesNovas);
                  if (passosEmTempoReal.length > 0) {
                    sse("passos", { passos: passosEmTempoReal });
                  }

                  const { total: novas, itens } = extrairAcoesMensagens(msgs, baselineId);
                  const assinatura = JSON.stringify(itens);
                  if (novas > acoesAvisadas || assinatura !== itensAssinatura) {
                    acoesAvisadas = Math.max(acoesAvisadas, novas);
                    itensAssinatura = assinatura;
                    sse("acao", { acoes: novas, itens });
                  }

                  const pensamentoAcumulado = assistentesNovas
                    .map((m) => pensamentoDe(m))
                    .filter(Boolean)
                    .join("\n\n---\n\n");
                  if (pensamentoAcumulado.length > enviadoPensamento.length) {
                    vazioDesde = null;
                    sse("pensamento", { delta: pensamentoAcumulado.slice(enviadoPensamento.length) });
                    enviadoPensamento = pensamentoAcumulado;
                    eventBus.emit("secretario.mensagem", { sessao_id: sessaoId, fase: "pensamento" });
                  }

                  const textoAcumulado = assistentesNovas
                    .map((m) => textoDe(m))
                    .filter(Boolean)
                    .join("\n\n");
                  if (textoAcumulado.length > enviado.length) {
                    vazioDesde = null;
                    sse("delta", { delta: textoAcumulado.slice(enviado.length) });
                    enviado = textoAcumulado;
                    eventBus.emit("secretario.mensagem", { sessao_id: sessaoId, fase: "delta" });
                  }

                  const temToolEmCurso = assistentesNovas.some((m) =>
                    (m.parts ?? []).some((p) => (p.type === "tool" || p.type === "tool-call" || p.type === "tool-invocation") && p.state?.status !== "completed")
                  );
                  const temProgresso = textoAcumulado.length > 0 ||
                    pensamentoAcumulado.length > 0 ||
                    novas > 0 ||
                    passosEmTempoReal.length > 0 ||
                    temToolEmCurso;

                  if (temProgresso) {
                    inicioTentativa = Date.now();
                    vazioDesde = null;
                  } else {
                    if (vazioDesde === null) vazioDesde = Date.now();
                    else if (Date.now() - vazioDesde > 20_000) {
                      postErro = `modelo ${modeloAtual} não gerou resposta após 20s`;
                      await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
                    }
                  }
                } else {
                  if (vazioDesde === null) vazioDesde = Date.now();
                  else if (Date.now() - vazioDesde > 20_000) {
                    postErro = `modelo ${modeloAtual} não iniciou após 20s`;
                    await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
                  }
                }
              }

              if (postConcluido && !postErro) {
                concluida = true;
                break;
              }
            }

            if (concluida) break;
            modeloIdx++;
            tentativasTotais++;
            if (tentouFallback) {
              await limparMensagensTentativaFalha(baseUrlSessao, idsMensagensAntesTentativa, true);
              continue;
            }
          }

          if (!concluida) {
            res.off("close", onClientClose);
            await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => { });
            await limparMensagensTentativaFalha(baseUrlSessao, idsBaseInicial, false);
            sse("erro", { erro: "Todos os modelos candidatos esgotaram timeout ou falharam. Tente novamente em instantes.", sessao_id: sessaoId });
            eventBus.emit("secretario.mensagem", { sessao_id: sessaoId, fase: "erro" });
            liberarStreamSecretario(sessaoId, res);
            res.end();
            return;
          }

          const msgsFinais = (await listarMensagens()) ?? [];
          const inicioFinalIdx = baselineId ? msgsFinais.findIndex((m) => m.info?.id === baselineId) : -1;
          const novasFinais = (inicioFinalIdx >= 0 ? msgsFinais.slice(inicioFinalIdx + 1) : msgsFinais).filter((m) => m.info?.role === "assistant");

          const textoFinal = novasFinais.map((m) => textoDe(m)).filter(Boolean).join("\n\n") || (postData ? textoDe(postData) : "");
          if (textoFinal.length > enviado.length) {
            sse("delta", { delta: textoFinal.slice(enviado.length) });
            enviado = textoFinal;
          }

          const pensamentoFinal = novasFinais.map((m) => pensamentoDe(m)).filter(Boolean).join("\n\n---\n\n") || (postData ? pensamentoDe(postData) : "");
          if (pensamentoFinal.length > enviadoPensamento.length) {
            sse("pensamento", { delta: pensamentoFinal.slice(enviadoPensamento.length) });
            enviadoPensamento = pensamentoFinal;
          }

          const { total: totalAcoes, itens: itensFinais } = extrairAcoesMensagens(msgsFinais, baselineId);
          if (totalAcoes > acoesAvisadas) {
            sse("acao", { acoes: totalAcoes, itens: itensFinais });
          }

          const passosFinais = extrairPassosMensagens(novasFinais);
          if (passosFinais.length > 0) {
            sse("passos", { passos: passosFinais });

            try {
              const tc = TelemetryCollector.obter();
              const wsStream = ws;
              const db = registros.corpDb(wsStream.path);
              tc.conectar(db);
              const traceCtx: TraceContext = {
                trace_id: gerarTraceId(),
                sessao_id: sessaoId!,
                agente,
                modelo: modeloAtivoFinal,
                workspace: wsStream.path,
              };
              tc.registrarPassos(traceCtx, passosFinais);
              tc.flush();
            } catch (telErr) {
              console.warn("[telemetria] falha ao registrar passos:", telErr);
            }
          }

          const respostaFinal = enviado || (totalAcoes > 0 ? "Ação concluída." : "Processamento concluído.");
          sse("fim", {
            sessao_id: sessaoId,
            resposta: respostaFinal,
            agente,
            modelo: modeloAtivoFinal,
            motor: motorSolicitado || motorPadrao,
          });
          eventBus.emit("secretario.mensagem", {
            sessao_id: sessaoId,
            fase: "fim",
            agente,
            modelo: modeloAtivoFinal,
            workspace: ws.id,
            fluxos: fluxosContexto,
          });
          if (onClientClose) res.off("close", onClientClose);
          liberarStreamSecretario(sessaoId, res);
          res.end();
          void sincronizarCorp(ctx, porta, sessaoId);
          return;
        } catch (erro) {
          if (onClientClose) { try { res.off("close", onClientClose); } catch {} }
          if (chaveStreamRegistrada) liberarStreamSecretario(chaveStreamRegistrada, res);
          if (!res.headersSent) {
            if (erro instanceof SecretarioError) {
              enviar(res, erro.status ?? 409, { erro: erro.message });
            } else {
              enviar(res, 502, { erro: `proxy do motor falhou: ${erro instanceof Error ? erro.message : String(erro)}` });
            }
          } else {
            sse("erro", { erro: erro instanceof Error ? erro.message : String(erro) });
            res.end();
          }
        }
      };

      await executarStream();
      return true;
    } catch (erro) {
      if (chaveStreamRegistrada) liberarStreamSecretario(chaveStreamRegistrada, res);
      if (!res.headersSent) {
        if (erro instanceof SecretarioError) {
          enviar(res, erro.status ?? 409, { erro: erro.message });
        } else {
          enviar(res, 502, { erro: `proxy do motor falhou: ${erro instanceof Error ? erro.message : String(erro)}` });
        }
      } else {
        sse("erro", { erro: erro instanceof Error ? erro.message : String(erro) });
        res.end();
      }
      return true;
    }
  }

  return false;
}
