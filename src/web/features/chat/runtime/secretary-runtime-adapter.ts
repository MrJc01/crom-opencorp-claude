import { useState, useRef, useEffect, useMemo } from "react";
import type {
  ChatModelAdapter,
  ChatModelRunOptions,
  ThreadMessageLike,
  AssistantRuntime,
} from "@assistant-ui/react";
import { useLocalRuntime } from "@assistant-ui/react";
import { ThinkParser, parseProblemDetails } from "../../../lib/chat/secretary-stream.js";
import { ProblemDetailsError } from "@opencorp/sdk";
import type { SecretaryRuntimeOptions } from "../types.js";

/**
 * Converte mensagens retornadas da API /secretario/sessoes/:id/mensagens
 * para o formato ThreadMessageLike do @assistant-ui/react.
 */
export function converterMensagensBackend(
  mensagens: any[],
  sessaoId: string,
): ThreadMessageLike[] {
  if (!Array.isArray(mensagens)) return [];

  return mensagens.map((m: any, idx: number) => {
    if (m.role === "user") {
      return {
        id: m.id || `user_${sessaoId}_${idx}`,
        role: "user",
        content: [{ type: "text", text: m.content || "" }],
        createdAt: m.criado_em ? new Date(m.criado_em) : new Date(),
      };
    }

    // Ações com pergunta (ask_question) guardam as opções em `passos`.
    const acoes: any[] = Array.isArray(m.acoes) ? m.acoes.map((a: any) => ({ ...a })) : [];
    for (const passo of Array.isArray(m.passos) ? m.passos : []) {
      if (passo?.tipo !== "acao" || !(passo.pergunta || passo.opcoes || passo.perguntas)) continue;
      const extra = { pergunta: passo.pergunta, opcoes: passo.opcoes, perguntas: passo.perguntas };
      const alvo = acoes.find((a) => (a.ferramenta || a.tool) === passo.ferramenta && a.resumo === passo.resumo);
      if (alvo) Object.assign(alvo, extra);
      else acoes.push({ ferramenta: passo.ferramenta, resumo: passo.resumo || "", sucesso: passo.sucesso !== false, status: passo.status, ...extra });
    }
    const partes = buildAssistantParts(
      m.pensamento || "",
      acoes,
      m.content || "",
    );

    return {
      id: m.id || `asst_${sessaoId}_${idx}`,
      role: "assistant",
      content: partes,
      createdAt: m.criado_em ? new Date(m.criado_em) : new Date(),
    };
  });
}

/**
 * Constrói ordenadamente as partes internas da mensagem do assistente:
 * 1. Raciocínio (reasoning / think block)
 * 2. Chamadas de ferramentas (tool-calls)
 * 3. Texto visível (text response)
 */
export function buildAssistantParts(
  pensamento: string,
  ferramentas: Array<{
    ferramenta: string;
    resumo: string;
    sucesso: boolean;
    status?: string;
    pergunta?: string;
    opcoes?: string[];
    perguntas?: Array<{ header?: string; pergunta: string; opcoes: string[] }>;
  }>,
  texto: string,
  aprovacoes: Array<{
    id: string;
    acao?: string;
    descricao?: string;
    workspace?: string;
    motor?: string;
  }> = [],
): any[] {
  const partes: any[] = [];

  if (pensamento && pensamento.trim().length > 0) {
    partes.push({
      type: "reasoning",
      text: pensamento,
    });
  }

  if (ferramentas && ferramentas.length > 0) {
    for (let i = 0; i < ferramentas.length; i++) {
      const item = ferramentas[i];
      partes.push({
        type: "tool-call",
        toolName: item.ferramenta || "ferramenta",
        toolCallId: `tool_${i}_${item.ferramenta}`,
        args: {
          resumo: item.resumo || "Executando inspeção de workspace...",
          statusOperacional: item.status || "completed",
          // Ferramentas de pergunta (ask_question/question) levam o conteúdo para o card.
          ...(item.perguntas?.length
            ? { questions: item.perguntas.map((q) => ({ header: q.header, question: q.pergunta, options: q.opcoes })) }
            : item.pergunta || item.opcoes?.length
              ? { question: item.pergunta, options: item.opcoes ?? [] }
              : {}),
        },
        result: item.resumo || "Concluído",
        isError: item.sucesso === false,
      });
    }
  }

  for (const aprovacao of aprovacoes) {
    partes.push({
      type: "tool-call",
      toolName: "aprovacao_motor",
      toolCallId: `aprovacao_${aprovacao.id}`,
      args: aprovacao,
    });
  }

  if (texto && texto.length > 0) {
    partes.push({
      type: "text",
      text: texto,
    });
  }

  return partes;
}

export function obterAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof window !== "undefined") {
    const t =
      localStorage.getItem("oc-token") ||
      localStorage.getItem("opencorp_token");
    if (t) {
      headers["Authorization"] = `Bearer ${t.trim()}`;
    }
  }
  return headers;
}

/**
 * Cria o ChatModelAdapter idiomático do Secretário Executivo com suporte a:
 * - Streaming contínuo via gerador assíncrono (async *run)
 * - Cancelamento nativo com abortSignal
 * - Segregação em tempo real de blocos <think> (Reasoning / Chain-of-Thought)
 * - Chamadas de ferramentas nativas (tool-call)
 * - Execução direta de shell via "!comando"
 */
export function criarSecretarioModelAdapter(
  options: SecretaryRuntimeOptions | (() => SecretaryRuntimeOptions),
  sessaoIdRef: React.MutableRefObject<string | undefined>,
): ChatModelAdapter {
  return {
    async *run({ messages, abortSignal }: ChatModelRunOptions) {
      // O adapter permanece estável durante uma promoção de sessão, mas cada
      // envio precisa enxergar callbacks, anexos e contexto do render atual.
      const optionsAtuais =
        typeof options === "function" ? options() : options;
      const lastMsg = messages[messages.length - 1];
      let userText = "";

      if (lastMsg) {
        if (typeof lastMsg.content === "string") {
          userText = lastMsg.content;
        } else if (Array.isArray(lastMsg.content)) {
          userText = lastMsg.content
            .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("\n");
        }
      }

      const trimmed = userText.trim();
      if (!trimmed) return;

      // ── /clear: Limpeza de histórico ──
      if (trimmed.toLowerCase() === "/clear") {
        yield { content: [] };
        return;
      }

      const origin =
        typeof window !== "undefined"
          ? window.location.origin
          : "http://127.0.0.1:4100";
      const wsId = optionsAtuais.workspaceId || "default";

      // ── !comando: Execução Direta de Shell (POST /terminal) ──
      if (trimmed.startsWith("!")) {
        const comandoBruto = trimmed.slice(1).trim();

        yield {
          content: [
            {
              type: "text",
              text: `\`\`\`terminal\n$ !${comandoBruto}\n[executando comando no terminal do workspace ${wsId}...]\n\`\`\``,
            },
          ],
        };

        try {
          const authHeaders = obterAuthHeaders();
          const res = await fetch(
            `${origin}/terminal?workspace=${encodeURIComponent(wsId)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...authHeaders,
                ...(optionsAtuais.headers ?? {}),
              },
              body: JSON.stringify({ comando: comandoBruto, workspace: wsId }),
              signal: abortSignal,
            },
          );

          const data = await res.json().catch(() => ({}));
          let saida = "";
          if (data.saida) {
            saida = data.saida;
          } else if (data.erro) {
            saida = `Erro: ${data.erro}`;
          } else if (!res.ok) {
            saida = `Erro HTTP ${res.status}: falha na execução do comando`;
          } else {
            saida = "(Comando executado com sucesso)";
          }

          yield {
            content: [
              {
                type: "text",
                text: `\`\`\`terminal\n$ !${comandoBruto}\n${saida}\n\`\`\``,
              },
            ],
          };
        } catch (err: any) {
          if (abortSignal.aborted) return;
          yield {
            content: [
              {
                type: "text",
                text: `\`\`\`terminal\n$ !${comandoBruto}\nFalha de conexão com terminal: ${err.message}\n\`\`\``,
              },
            ],
          };
        }
        return;
      }

      // Notifica a primeira mensagem para renomear aba
      if (messages.length <= 1) {
        optionsAtuais.onPrimeiraMensagem?.(userText);
      }

      const queryParams = new URLSearchParams();
      if (sessaoIdRef.current) queryParams.set("sessao", sessaoIdRef.current);
      if (wsId) queryParams.set("workspace", wsId);
      const urlBase = optionsAtuais.url ?? "/secretario/conversa/stream";
      const urlFinal = `${urlBase}?${queryParams.toString()}`;

      const extra = optionsAtuais.obterContextoEnvio?.();
      const body: Record<string, unknown> = {
        cliente_id: `react_${Date.now().toString(36)}`,
        mensagem: userText,
        prompt: userText,
        agente: extra?.agente ?? optionsAtuais.agente ?? "secretario",
      };
      if (sessaoIdRef.current) body.sessao_id = sessaoIdRef.current;
      const modeloEfetivo = extra?.modelo ?? optionsAtuais.modelo;
      if (modeloEfetivo) {
        body.modelo = modeloEfetivo;
        body.model = modeloEfetivo;
      }
      if (extra?.imagens && extra.imagens.length > 0) {
        body.imagens = extra.imagens;
      }
      if (extra?.contexto && extra.contexto.length > 0) {
        body.contexto = extra.contexto;
      }

      let resp: Response;
      try {
        resp = await fetch(urlFinal, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...obterAuthHeaders(),
            ...(optionsAtuais.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: abortSignal,
        });
      } catch (err: any) {
        if (abortSignal.aborted) return;
        yield {
          content: [
            {
              type: "text",
              text: `⚠️ Erro de conexão com o Secretário: ${err.message}`,
            },
          ],
        };
        return;
      }

      // Se o secretário não estiver rodando (409), tenta iniciar e repetir uma vez
      if (resp.status === 409) {
        try {
          await fetch(`${origin}/secretario/start`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...obterAuthHeaders(),
              ...(optionsAtuais.headers ?? {}),
            },
            signal: abortSignal,
          });
          await new Promise((r) => setTimeout(r, 600));
          resp = await fetch(urlFinal, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...obterAuthHeaders(),
              ...(optionsAtuais.headers ?? {}),
            },
            body: JSON.stringify(body),
            signal: abortSignal,
          });
        } catch {}
      }

      if (!resp.ok) {
        const problem = await parseProblemDetails(resp);
        optionsAtuais.onErro?.(problem);
        yield {
          content: [
            {
              type: "text",
              text: `⚠️ ${problem.title || "Erro"}: ${problem.detail || problem.message}`,
            },
          ],
        };
        return;
      }

      const reader = resp.body?.getReader();
      if (!reader) {
        yield {
          content: [{ type: "text", text: "⚠️ Resposta vazia recebida do servidor." }],
        };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let textoAcumulado = "";
      let pensamentoAcumulado = "";
      let statusAtual = "";
      const thinkParser = new ThinkParser();
      const aprovacoes: Array<{
        id: string;
        acao?: string;
        descricao?: string;
        workspace?: string;
        motor?: string;
      }> = [];
      const acoesAcumuladas: Array<{
        ferramenta: string;
        resumo: string;
        sucesso: boolean;
        status?: string;
        pergunta?: string;
        opcoes?: string[];
        perguntas?: Array<{ header?: string; pergunta: string; opcoes: string[] }>;
      }> = [];

      try {
        while (true) {
          if (abortSignal.aborted) break;
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const linhas = buffer.split("\n");
          buffer = linhas.pop() || "";

          let evento = "mensagem";
          let dados = "";

          for (const linha of linhas) {
            if (linha.startsWith("event: ")) {
              evento = linha.slice(7).trim();
            } else if (linha.startsWith("data: ")) {
              dados = linha.slice(6);
            } else if (linha === "" && dados) {
              try {
                const parsed = JSON.parse(dados);

                if ((evento === "inicio" || evento === "sessao") && parsed.sessao_id) {
                  const realId = String(parsed.sessao_id).trim();
                  if (realId && sessaoIdRef.current !== realId) {
                    sessaoIdRef.current = realId;
                    optionsAtuais.onSessaoCriada?.(realId);
                  }
                  statusAtual = parsed.modelo
                    ? `⏳ Processando com ${parsed.modelo}...`
                    : "⏳ Processando...";
                } else if (evento === "status" || evento === "fallback_modelo") {
                  statusAtual = parsed.aviso || parsed.status || "";
                } else if (evento === "passos" && Array.isArray(parsed.passos)) {
                  const pensamentos = parsed.passos
                    .filter((passo: any) => passo?.tipo === "pensamento" && passo.texto)
                    .map((passo: any) => String(passo.texto));
                  if (pensamentos.length > 0) {
                    pensamentoAcumulado = pensamentos.join("\n\n");
                  }
                  // Ferramentas de pergunta: o evento "acao" não traz as opções; "passos" traz.
                  for (const passo of parsed.passos) {
                    if (passo?.tipo !== "acao" || !(passo.pergunta || passo.opcoes || passo.perguntas)) continue;
                    const ferramenta = String(passo.ferramenta || "ferramenta");
                    const resumo = String(passo.resumo || "");
                    const extra = { pergunta: passo.pergunta, opcoes: passo.opcoes, perguntas: passo.perguntas };
                    const idx = acoesAcumuladas.findIndex((a) => a.ferramenta === ferramenta && a.resumo === resumo);
                    if (idx >= 0) acoesAcumuladas[idx] = { ...acoesAcumuladas[idx]!, ...extra };
                    else acoesAcumuladas.push({ ferramenta, resumo, status: String(passo.status || "completed"), sucesso: passo.sucesso !== false, ...extra });
                  }
                } else if (evento === "pensamento") {
                  pensamentoAcumulado =
                    parsed.acumulado || pensamentoAcumulado + (parsed.delta || "");
                } else if (evento === "delta") {
                  statusAtual = "";
                  const deltaStr = parsed.delta || "";
                  const { deltaConteudo, deltaPensamento } = thinkParser.processDelta(deltaStr);
                  if (deltaPensamento) pensamentoAcumulado += deltaPensamento;
                  if (deltaConteudo) textoAcumulado += deltaConteudo;
                } else if (evento === "acao") {
                  const itens = Array.isArray(parsed)
                    ? parsed
                    : Array.isArray(parsed.itens)
                      ? parsed.itens
                      : parsed.ferramenta
                        ? [parsed]
                        : [];
                  for (const it of itens) {
                    const ferramenta = it.ferramenta || it.tool || "ferramenta";
                    const resumo = it.resumo || "Executando inspeção de workspace...";
                    const status = String(it.status || "completed");
                    const atualizada = {
                      ferramenta,
                      resumo,
                      status,
                      sucesso:
                        it.sucesso !== false &&
                        !["error", "failed", "falha"].includes(status.toLowerCase()),
                    };
                    const idxExistente = acoesAcumuladas.findIndex(
                      (acao) =>
                        acao.ferramenta === ferramenta && acao.resumo === resumo,
                    );
                    if (idxExistente >= 0) {
                      acoesAcumuladas[idxExistente] = { ...acoesAcumuladas[idxExistente]!, ...atualizada };
                    } else {
                      acoesAcumuladas.push(atualizada);
                    }
                    if (["pending", "running"].includes(status.toLowerCase())) {
                      statusAtual = `⚡ Executando ${resumo}`;
                    }
                  }
                } else if (evento === "aprovacao" && parsed.id) {
                  if (!aprovacoes.some((a) => a.id === parsed.id)) {
                    aprovacoes.push({
                      id: String(parsed.id),
                      acao: parsed.acao,
                      descricao: parsed.descricao,
                      workspace: parsed.workspace ?? wsId,
                      motor: parsed.motor,
                    });
                  }
                  statusAtual = "⏸ Aguardando sua aprovação...";
                } else if (evento === "fim") {
                  statusAtual = "";
                  if (parsed.resposta && !textoAcumulado) {
                    const resposta = String(parsed.resposta).trim();
                    textoAcumulado = ["Processamento concluído.", "Ação concluída."].includes(
                      resposta,
                    )
                      ? "⚠️ O modelo não retornou texto. Tente reenviar ou selecione outro modelo."
                      : resposta;
                  }
                } else if (evento === "erro") {
                  const msgErro = parsed.mensagem || parsed.erro || "Erro interno no agente";
                  textoAcumulado += `\n\n⚠️ ${msgErro}`;
                }
              } catch {}

              dados = "";
              evento = "mensagem";

              // Despacha atualização imediata das partes para o runtime
              const partes = buildAssistantParts(
                pensamentoAcumulado,
                acoesAcumuladas,
                textoAcumulado || statusAtual,
                aprovacoes,
              );
              if (partes.length > 0) {
                yield { content: partes };
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
        optionsAtuais.onLimparContextoEnvio?.();
      }

      // Emissão final garantida
      const partesFinais = buildAssistantParts(
        pensamentoAcumulado,
        acoesAcumuladas,
        textoAcumulado,
        aprovacoes,
      );
      if (partesFinais.length > 0) {
        yield { content: partesFinais };
      }
    },
  };
}

/**
 * Hook oficial do OpenCorp que implementa a arquitetura nativa com useLocalRuntime
 * e ChatModelAdapter, eliminando a necessidade de loops manuais e permitindo
 * streaming fluido em tempo real sem F5.
 */
export function useOpenCorpSecretarioRuntime(
  options: SecretaryRuntimeOptions = {},
): AssistantRuntime {
  const sessaoIdRef = useRef<string | undefined>(options.sessaoId);
  const optionsRef = useRef<SecretaryRuntimeOptions>(options);
  optionsRef.current = options;
  if (options.sessaoId) {
    sessaoIdRef.current = options.sessaoId;
  }

  // Adapter gerador com streaming contínuo. Mantém a mesma instância mesmo se o sessaoId
  // for promovido durante a conversa, lendo o ID atualizado diretamente via sessaoIdRef.
  const chatModelAdapter = useMemo(
    () => criarSecretarioModelAdapter(() => optionsRef.current, sessaoIdRef),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.workspaceId, options.agente, options.modelo],
  );

  return useLocalRuntime(chatModelAdapter, {
    initialMessages: options.initialMessages,
  });
}
