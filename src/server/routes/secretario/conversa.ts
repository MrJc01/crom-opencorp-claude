import { fetchOpencode } from "../../../core/contexts/execution/opencode-server.js";
import {
  limparPrefixoWorkspace,
  SecretarioError,
  type MensagemOc,
} from "../../../core/contexts/execution/opencode-server.js";
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
import { opencorpHome } from "../../../utils/paths.js";
import type { RouteContext } from "../types.js";

export async function handleConversaRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, resolverWs, lerCorpo, enviar } = ctx;

  if (rota === "/secretario/conversa" && req.method === "POST") {
    try {
      const corpo = (await lerCorpo(req)) as {
        mensagem?: string;
        sessao_id?: string;
        agente?: string;
        modelo?: string;
        model?: string;
        motor?: string;
        engine?: string;
        imagens?: Array<{ nome?: string; mime?: string; url?: string }>;
        contexto?: string[];
      };
      const mensagemBruta = limparPrefixoWorkspace(corpo.mensagem?.trim() || "");
      const imagens = (corpo.imagens ?? []).filter((i) => i && typeof i.url === "string" && i.url.startsWith("data:image/")).slice(0, 4);
      if (!mensagemBruta && imagens.length === 0) {
        enviar(res, 400, { erro: "mensagem obrigatória" });
        return true;
      }

      // Fast-path: git slash
      if (/^(\/git|\/restore|\/descartar|\/status-git|\/rollback)/i.test(mensagemBruta)) {
        const ws = await resolverWs(url);
        const { processarComandoGitSecretario } = await import("../../../core/contexts/workspace/secretario-git-slash.js");
        const resultadoGit = await processarComandoGitSecretario(mensagemBruta, ws.path, ws.id);
        if (resultadoGit.tratado) {
          enviar(res, 200, {
            ok: true,
            sessao_id: corpo.sessao_id || `sessao-git-${Date.now()}`,
            resposta: resultadoGit.mensagem,
            content: resultadoGit.mensagem,
            gitStatus: resultadoGit.gitStatus,
            gitDiff: resultadoGit.gitDiff,
          });
          return true;
        }
      }

      // Fast-path: slash actions
      if (/^\//.test(mensagemBruta)) {
        const ws = await resolverWs(url);
        const acao = await processarSlash(ctx, mensagemBruta, ws);
        if (acao.tratado) {
          enviar(res, 200, {
            ok: true,
            sessao_id: corpo.sessao_id || `sessao-acao-${Date.now()}`,
            resposta: acao.mensagem,
            content: acao.mensagem,
          });
          return true;
        }
        enviar(res, 200, {
          ok: true,
          sessao_id: corpo.sessao_id || `sessao-acao-${Date.now()}`,
          resposta: `Comando "${mensagemBruta.split(/\s+/)[0]}" não reconhecido.\n\n${textoAjudaSlash()}`,
          content: `Comando "${mensagemBruta.split(/\s+/)[0]}" não reconhecido.\n\n${textoAjudaSlash()}`,
        });
        return true;
      }

      const ws = await resolverWs(url);
      const resolvido = await resolverMencoes(ctx, {
        mensagemBruta,
        corpoContexto: corpo.contexto,
        agenteAtual: corpo.agente ?? "secretario",
        ws,
      });
      const mensagem = resolvido.mensagem;
      const agenteResolvido = resolvido.agente;

      const motorSolicitado = corpo.motor || corpo.engine;
      if (motorSolicitado === "direct-llm") {
        const { DirectLlmConversationDriver } = await import("../../../core/conversation/DirectLlmConversationDriver.js");
        const driverDirect = new DirectLlmConversationDriver({ homeDir: ctx.homeDir });
        const resDirect = await driverDirect.enviarMensagemSync({
          sessaoId: corpo.sessao_id || `ses_direct_${Date.now()}`,
          mensagem,
          agente: agenteResolvido,
          modelo: corpo.modelo || corpo.model,
          wsPath: ws.path,
          wsId: ws.id,
        });
        enviar(res, 200, {
          sessao_id: resDirect.sessaoId,
          resposta: resDirect.resposta,
          agente: agenteResolvido,
          modelo: resDirect.modelo,
          motor: "direct-llm",
        });
        return true;
      }

      const runtimeCtx = await obterRuntimeSecretario(ctx, ws, true);
      if (runtimeCtx.engineId !== "opencode") {
        const contextoWs = await construirContextoWorkspace(ws);
        const mensagemComWs = `${contextoWs}\n${mensagem}`;
        const home = ctx.homeDir ?? opencorpHome();

        const ref = await runtimeCtx.runtime.create({
          conversationId: idConversaNativo(corpo.sessao_id),
          workspaceId: ws.id,
          workspacePath: ws.path,
          model: corpo.modelo || corpo.model || "default",
          homeDir: home,
          title: mensagem.slice(0, 60),
        });

        let respostaTexto = "";
        const aprovacoesRecusadas: string[] = [];
        for await (const event of runtimeCtx.runtime.send(ref, { text: mensagemComWs })) {
          if (event.type === "message.delta") {
            respostaTexto += event.text;
          } else if (event.type === "approval.requested") {
            // O modo síncrono não tem canal para o usuário decidir; recusar evita
            // que o turno fique bloqueado indefinidamente. Use o stream para HITL.
            aprovacoesRecusadas.push(event.approval.description);
            await runtimeCtx.runtime.respondApproval?.(event.approval.id, "reject", { workspaceId: ws.id });
          } else if (event.type === "run.failed") {
            enviar(res, 502, { ok: false, erro: event.error.message, sessao_id: ref.id, motor: runtimeCtx.engineId });
            return true;
          } else if (event.type === "run.completed") {
            if (event.result.output && !respostaTexto) {
              respostaTexto = event.result.output;
            }
          }
        }

        enviar(res, 200, {
          ok: true,
          sessao_id: ref.id,
          resposta: respostaTexto,
          content: respostaTexto,
          agente: agenteResolvido,
          modelo: corpo.modelo || corpo.model || "default",
          motor: runtimeCtx.engineId,
          ...(aprovacoesRecusadas.length > 0 ? { aprovacoes_recusadas: aprovacoesRecusadas } : {}),
        });
        return true;
      }

      const porta = await obterPorta(ctx, true, ws.id);
      let sessaoId = corpo.sessao_id;
      const baseUrl = `http://127.0.0.1:${porta}`;

      const modeloSolicitado = corpo.modelo || corpo.model;
      const { modelos: modelosFallbackConv, motorPadrao } = await resolverModelos(ctx, {
        modeloRequisicao: modeloSolicitado,
        agenteId: agenteResolvido,
        wsPath: ws.path,
      });

      const modeloInicial = modelosFallbackConv[0]!;

      const { registros, workspaces } = ctx;
      if (sessaoId && registros && workspaces) {
        try {
          const todosWs = await workspaces.listar().catch(() => []);
          for (const outroWs of todosWs) {
            if (outroWs.id !== ws.id && outroWs.existe) {
              const msgsOutro = registros.corpDb(outroWs.path).listarMensagens(sessaoId);
              if (msgsOutro && msgsOutro.length > 0) {
                console.warn(`[secretario/conversa] Sessão ${sessaoId} pertence ao workspace "${outroWs.id}". Criando nova sessão para "${ws.id}".`);
                sessaoId = undefined;
                break;
              }
            }
          }
        } catch {}
      }

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
            agent: agenteResolvido,
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!createRes.ok) {
          enviar(res, 502, { erro: `falha ao criar sessão no motor: ${createRes.status}` });
          return true;
        }
        const sessionData = (await createRes.json()) as { id: string };
        sessaoId = sessionData.id;
        if (modeloInicial) {
          await trocarModeloEngine(baseUrl, sessaoId, modeloInicial);
        }
      } else if (modeloSolicitado) {
        await trocarModeloEngine(baseUrl, sessaoId, modeloSolicitado);
      }

      let respostaTexto = "";
      let modeloQueRespondeu = modeloInicial;
      const extrair = (m: { parts?: Array<{ type: string; text?: string }> }): string =>
        (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();

      const contextoWs = await construirContextoWorkspace(ws);
      const mensagemComWs = `${contextoWs}\n${mensagem}`;

      for (let mIdx = 0; mIdx < modelosFallbackConv.length; mIdx++) {
        const mod = modelosFallbackConv[mIdx]!;
        const { providerID: modProvider, modelID: modId } = parsearModelo(mod);
        const modelPayload = modProvider && modId ? { providerID: modProvider, modelID: modId } : undefined;

        if (mIdx > 0) {
          await fetchOpencode(`${baseUrl}/session/${sessaoId}/abort`, { method: "POST" }).catch(() => { });
          await sleep(300);
          await trocarModeloEngine(baseUrl, sessaoId, mod);
          await sleep(150);
        }

        const msgsAntes = (await fetchOpencode(`${baseUrl}/session/${sessaoId}/message`, { signal: AbortSignal.timeout(4000) })
          .then((r) => (r.ok ? r.json() : []))
          .catch(() => [])) as MensagemOc[];
        const idsAntes = new Set((Array.isArray(msgsAntes) ? msgsAntes : []).map((m) => m.info?.id).filter(Boolean));

        try {
          const msgRes = await fetchOpencode(`${baseUrl}/session/${sessaoId}/message`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              sessionID: sessaoId,
              agent: agenteResolvido ?? "secretario",
              ...(modelPayload ? { model: modelPayload } : {}),
              parts: [
                { type: "text", text: mensagemComWs },
                ...imagens.map((i) => ({ type: "file", mime: i.mime ?? "image/png", url: i.url! })),
              ],
            }),
            signal: AbortSignal.timeout(30_000),
          });

          if (msgRes.ok) {
            const msgData = (await msgRes.json()) as {
              info?: { role?: string };
              parts?: Array<{ type: string; text?: string }>;
            };
            if (msgData.info?.role === "assistant") {
              respostaTexto = extrair(msgData);
            }
            if (respostaTexto) {
              modeloQueRespondeu = mod;
              break;
            }
          }
        } catch { }

        // Se falhou e ainda temos outro modelo de contingência na rotação, remove a tentativa incompleta para não duplicar o prompt
        if (!respostaTexto && mIdx < modelosFallbackConv.length - 1) {
          await limparMensagensTentativaFalha(`${baseUrl}/session/${sessaoId}`, idsAntes, false);
        }
      }

      if (!respostaTexto) {
        const timeoutMs = 60_000;
        const inicio = Date.now();
        while (Date.now() - inicio < timeoutMs) {
          await sleep(2000);
          const getRes = await fetchOpencode(`${baseUrl}/session/${sessaoId}/message`, { signal: AbortSignal.timeout(5000) });
          if (!getRes.ok) continue;
          const msgs = (await getRes.json()) as Array<{
            info?: { role?: string; time?: { completed?: number } };
            parts?: Array<{ type: string; text?: string }>;
          }>;
          for (let i = (msgs ?? []).length - 1; i >= 0; i--) {
            const msg = msgs[i]!;
            if (msg.info?.role === "assistant" && msg.info?.time?.completed) {
              const textos = (msg.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
              if (textos.trim()) {
                respostaTexto = textos;
                break;
              }
            }
          }
          if (respostaTexto) break;
        }
      }

      if (!respostaTexto) {
        enviar(res, 504, { erro: "timeout aguardando resposta do modelo assistente (60s)", sessao_id: sessaoId });
        return true;
      }

      void sincronizarCorp(ctx, porta, sessaoId);
      enviar(res, 200, {
        sessao_id: sessaoId,
        resposta: respostaTexto,
        agente: agenteResolvido,
        modelo: modeloQueRespondeu,
        motor: corpo.motor || corpo.engine || motorPadrao,
      });
      return true;
    } catch (erro) {
      if (erro instanceof SecretarioError) {
        enviar(res, erro.status ?? 409, { erro: erro.message });
      } else {
        enviar(res, 502, { erro: `proxy do motor falhou: ${erro instanceof Error ? erro.message : String(erro)}` });
      }
      return true;
    }
  }

  return false;
}
