import React, { useState, useEffect, useMemo, type FC } from "react";
import { useNavigate } from "react-router-dom";
import {
  AssistantRuntimeProvider,
  useAuiState,
  ThreadPrimitive,
  MessagePrimitive,
  type ThreadMessageLike,
  type AssistantRuntime,
} from "@assistant-ui/react";
import {
  MarkdownTextPrimitive,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  User,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Terminal,
  GitBranch,
  Wrench,
  CheckCircle2,
  AlertCircle,
  Brain,
  Copy,
  Check,
  FileText,
  ExternalLink,
} from "lucide-react";
import {
  useOpenCorpSecretarioRuntime,
  marcarAprovacaoNoRuntime,
} from "../runtime/secretary-runtime-adapter.js";
import { buscarHistorico, sessaoTemHistorico } from "../runtime/history-client.js";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { SUGESTOES_RAPIDAS } from "../../../lib/chat/constants.js";
import type { SecretaryRuntimeOptions } from "../types.js";
import { GitStatusCard, parsearSaidaGitStatus } from "./GitStatusCard.js";
import { HitlOptionsView } from "./HitlOptionsView.js";
import { PerguntaCard } from "./PerguntaCard.js";
import { EngineApprovalCard } from "./EngineApprovalCard.js";
import {
  ChatComposer,
  type ContextChip,
  type AnexoImagem,
} from "./ChatComposer.js";

/**
 * Componente de exibição de blocos de raciocínio (Chain of Thought).
 * Suporta expansão/colapso suave e tipografia monoespaçada discreta com estilo roxo/zinco.
 */
export const ReasoningView: FC<{ text?: string; tempoFmt?: string }> = ({
  text = "",
  tempoFmt,
}) => {
  const [expandido, setExpandido] = useState(false);

  if (!text || text.trim().length === 0) return null;

  return (
    <div className="my-2.5 rounded-xl border border-purple-900/40 bg-purple-950/20 text-xs overflow-hidden transition-all shadow-sm">
      <button
        type="button"
        onClick={() => setExpandido((prev) => !prev)}
        className="w-full flex items-center justify-between px-3.5 py-2 bg-purple-950/30 hover:bg-purple-950/50 text-purple-300 hover:text-purple-100 transition-colors text-left font-mono cursor-pointer select-none border-b border-transparent group"
      >
        <div className="flex items-center gap-2">
          <Brain size={14} className="text-purple-400 animate-pulse" />
          <span className="font-semibold text-purple-200">Processo de Raciocínio</span>
          <span className="text-[10px] px-1.5 py-0.2 rounded bg-purple-900/50 border border-purple-700/40 text-purple-300">
            Chain of Thought
          </span>
          {tempoFmt && (
            <span className="text-[10px] text-zinc-400 font-mono">
              ({tempoFmt})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-purple-400/80 group-hover:text-purple-200 text-[11px]">
          <span>{expandido ? "Ocultar" : "Inspecionar"}</span>
          {expandido ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
      </button>

      {expandido && (
        <div className="p-3.5 bg-black/50 font-mono text-[11px] text-zinc-300 leading-relaxed whitespace-pre-wrap border-t border-purple-900/30 max-h-72 overflow-y-auto scrollbar-thin select-text">
          {text}
        </div>
      )}
    </div>
  );
};

/**
 * Cabeçalho de bloco de código com Handoff para Workspace IDE e botão Copiar
 */
export const CodeHeaderWithHandoff: FC<
  CodeHeaderProps & { workspaceId?: string }
> = ({ language, code, workspaceId = "default" }) => {
  const navigate = useNavigate();
  const [copiado, setCopiado] = useState(false);

  // Extrai possível caminho de arquivo da primeira linha do código
  const caminhoArquivo = useMemo(() => {
    if (!code) return null;
    const primeiraLinha = code.trim().split("\n")[0] || "";
    const m = primeiraLinha.match(
      /^(?:\/\/\s*|#\s*|\/\*\s*|<!--\s*|(?:file|arquivo):\s*)([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)/,
    );
    if (m && m[1] && !m[1].startsWith("http")) {
      return m[1].replace(/\*\/|-->/, "").trim();
    }
    return null;
  }, [code]);

  const copiar = () => {
    if (navigator.clipboard) {
      void navigator.clipboard.writeText(code);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    }
  };

  const abrirNoWorkspace = () => {
    if (caminhoArquivo) {
      navigate(
        `/w/${encodeURIComponent(workspaceId)}/workspace?file=${encodeURIComponent(caminhoArquivo)}`,
      );
    }
  };

  return (
    <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-900 border-b border-zinc-800 text-[11px] font-mono text-zinc-400 select-none">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-zinc-500 uppercase text-[10px] font-bold">
          {language || "código"}
        </span>
        {caminhoArquivo && (
          <span className="flex items-center gap-1 text-emerald-400 font-mono text-[11px] truncate">
            <FileText size={11} />
            <span className="truncate">{caminhoArquivo}</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {caminhoArquivo && (
          <button
            type="button"
            onClick={abrirNoWorkspace}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px]"
            title={`Abrir ${caminhoArquivo} na Workspace IDE`}
          >
            <ExternalLink size={11} />
            <span>Abrir no Workspace</span>
          </button>
        )}

        <button
          type="button"
          onClick={copiar}
          className="flex items-center gap-1 px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px]"
          title="Copiar código"
        >
          {copiado ? (
            <Check size={11} className="text-emerald-400" />
          ) : (
            <Copy size={11} />
          )}
          <span>{copiado ? "Copiado" : "Copiar"}</span>
        </button>
      </div>
    </div>
  );
};

/**
 * Componente para exibição de invocações de ferramentas (bash, git, MCP, etc.)
 */
export const ToolCallView: FC<{
  toolName?: string;
  result?: unknown;
  isError?: boolean;
  status?: string;
}> = ({ toolName = "ferramenta", result, isError, status }) => {
  const nomeLower = toolName.toLowerCase();
  const emExecucao = ["pending", "running"].includes(
    String(status || "").toLowerCase(),
  );

  const IconeFerramenta = nomeLower.includes("git")
    ? GitBranch
    : nomeLower.includes("bash") ||
      nomeLower.includes("sh") ||
      nomeLower.includes("terminal")
    ? Terminal
    : Wrench;

  const resultadoTexto =
    typeof result === "string"
      ? result
      : result !== undefined && result !== null
      ? JSON.stringify(result, null, 2)
      : null;

  return (
    <div className="my-2 rounded-xl border border-zinc-800 bg-zinc-900/50 text-xs overflow-hidden shadow-sm">
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/60 bg-zinc-900/70">
        <div className="flex items-center gap-2 font-mono">
          <IconeFerramenta size={14} className="text-emerald-400" />
          <span className="font-semibold text-zinc-200">{toolName}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {emExecucao ? (
            <span className="flex items-center gap-1 text-[10px] text-amber-300 bg-amber-950/40 border border-amber-800/40 px-2 py-0.5 rounded-full">
              <Sparkles size={10} className="animate-pulse" /> Executando
            </span>
          ) : isError ? (
            <span className="flex items-center gap-1 text-[10px] text-rose-400 bg-rose-950/40 border border-rose-800/40 px-2 py-0.5 rounded-full">
              <AlertCircle size={10} /> Falha
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2 py-0.5 rounded-full">
              <CheckCircle2 size={10} /> Executado
            </span>
          )}
        </div>
      </div>

      {resultadoTexto && (
        <div className="p-2.5 bg-black/60 font-mono text-[11px] text-zinc-300 max-h-48 overflow-x-auto overflow-y-auto whitespace-pre">
          {resultadoTexto}
        </div>
      )}
    </div>
  );
};

/**
 * Contexto dos tool UIs e das partes do assistente. Os componentes abaixo ficam FORA do
 * render porque `components={{...}}` com arrows inline cria um tipo novo a cada render e o
 * React remonta os cards, perdendo o estado local (ex.: respostas do PerguntaCard).
 */
interface ChatToolsCtx {
  runtime?: AssistantRuntime;
  workspaceId: string;
}
const ChatToolsContext = React.createContext<ChatToolsCtx>({ workspaceId: "default" });

function useEnviarComoUsuario(): (texto: string) => void {
  const { runtime } = React.useContext(ChatToolsContext);
  return (texto) => {
    void runtime?.thread.append({ role: "user", content: [{ type: "text", text: texto }] });
  };
}

function textoOpcoes(args: any): string {
  return (
    args?.pergunta ||
    (args?.opcoes ? args.opcoes.map((o: string, idx: number) => `${idx + 1}. ${o}`).join("\n") : "")
  );
}

const TextoAssistente: FC<{ text?: string }> = ({ text }) => {
  const { workspaceId } = React.useContext(ChatToolsContext);
  if (text && text.startsWith("```terminal\n")) {
    const limpo = text.replace(/^```terminal\n/, "").replace(/\n```$/, "");
    return (
      <div className="bg-zinc-950 text-emerald-400 font-mono p-3 rounded-lg border border-zinc-800 text-xs overflow-x-auto whitespace-pre leading-relaxed shadow-inner">
        {limpo}
      </div>
    );
  }
  return (
    <MarkdownTextPrimitive
      className="oc-markdown text-sm text-zinc-100"
      remarkPlugins={[remarkGfm]}
      components={{ CodeHeader: (props) => <CodeHeaderWithHandoff {...props} workspaceId={workspaceId} /> }}
    />
  );
};

const RaciocinioAssistente: FC<{ text?: string }> = ({ text }) => <ReasoningView text={text} />;

const ToolGitStatus: FC<any> = ({ args, result }) => {
  const { workspaceId } = React.useContext(ChatToolsContext);
  const arquivos =
    args?.arquivos || (result && typeof result === "object" && "arquivos" in result ? result.arquivos : []);
  return <GitStatusCard arquivos={arquivos} workspaceId={workspaceId} />;
};

const ToolAprovacaoMotor: FC<any> = ({ args }) => {
  const { runtime } = React.useContext(ChatToolsContext);
  return (
    <EngineApprovalCard
      args={args}
      onDecidido={(id, status) => runtime && marcarAprovacaoNoRuntime(runtime, id, status)}
    />
  );
};

const ToolOpcoes: FC<any> = ({ args }) => {
  const enviar = useEnviarComoUsuario();
  return <HitlOptionsView texto={textoOpcoes(args)} onSelecionarOpcao={enviar} />;
};

const ToolPergunta: FC<any> = ({ args }) => {
  const enviar = useEnviarComoUsuario();
  const messageId = useAuiState((st) => st.message.id);
  // Respondida = existe mensagem do usuário depois desta (reativo a novas mensagens).
  const respondida = useAuiState((st) => {
    const msgs = st.thread.messages;
    const i = msgs.findIndex((x) => x.id === messageId);
    return i >= 0 && msgs.slice(i + 1).some((x) => x.role === "user");
  });
  return <PerguntaCard args={args} respondida={respondida} onResponder={enviar} />;
};

const ToolTerminal: FC<any> = ({ args, result }) => {
  const cmd = args?.comando || "";
  const out = String(result ?? args?.saida ?? "");
  return (
    <div className="bg-zinc-950 text-emerald-400 font-mono p-3 rounded-lg border border-zinc-800 text-xs overflow-x-auto whitespace-pre leading-relaxed shadow-inner my-2">
      {cmd ? `$ !${cmd}\n` : ""}
      {out}
    </div>
  );
};

const ToolFallback: FC<any> = ({ toolName, result, isError, args, status }) => (
  <ToolCallView
    toolName={toolName}
    result={result ?? args?.resumo}
    isError={isError}
    status={args?.statusOperacional ?? status?.type}
  />
);

/** Mapa estável (identidade fixa entre renders) das partes da mensagem do assistente. */
export const COMPONENTES_PARTES_ASSISTENTE = {
  Text: TextoAssistente,
  Reasoning: RaciocinioAssistente,
  tools: {
    by_name: {
      git_status: ToolGitStatus,
      aprovacao_motor: ToolAprovacaoMotor,
      hitl_approval: ToolOpcoes,
      pergunta_opcoes: ToolOpcoes,
      ask_question: ToolPergunta,
      question: ToolPergunta,
      terminal_exec: ToolTerminal,
    },
    Fallback: ToolFallback,
  },
} as const;

export interface SecretarioChatProps {
  runtime?: AssistantRuntime;
  options?: SecretaryRuntimeOptions;
  sessaoId?: string;
  aoAtualizarTitulo?: (sessaoId: string, titulo: string) => void;
  aoSessaoCriada?: (sid: string) => void;
  contextoInicial?: ContextChip[];
  className?: string;
  /** Renderizado no dock lateral: usa ids próprios no composer (sem duplicar os da página). */
  emDock?: boolean;
}

/**
 * Componente interno conectado ao AssistantRuntimeProvider
 */
const SecretarioChatInterno: FC<{
  runtimeProp?: AssistantRuntime;
  workspaceId: string;
  sessaoId?: string;
  initialMessages?: ThreadMessageLike[];
  aoAtualizarTitulo?: (sessaoId: string, titulo: string) => void;
  aoSessaoCriada?: (sid: string) => void;
  contextoInicial?: ContextChip[];
  options?: SecretaryRuntimeOptions;
  className?: string;
  emDock?: boolean;
}> = ({
  runtimeProp,
  workspaceId,
  sessaoId,
  initialMessages,
  aoAtualizarTitulo,
  aoSessaoCriada,
  contextoInicial = [],
  options,
  className = "",
  emDock = false,
}) => {
  const [agenteAtivo, setAgenteAtivo] = useState<string | null>(null);
  const [chipsContexto, setChipsContexto] = useState<ContextChip[]>(contextoInicial);
  const [anexosImagens, setAnexosImagens] = useState<AnexoImagem[]>([]);

  const chaveContextoInicial = contextoInicial.map((chip) => `${chip.id}:${chip.rotulo}`).join("|");
  useEffect(() => {
    if (contextoInicial.length === 0) return;
    setChipsContexto((atuais) => {
      const mapa = new Map(
        atuais.filter((chip) => chip.tipo !== "flow").map((chip) => [chip.id, chip]),
      );
      for (const chip of contextoInicial) mapa.set(chip.id, chip);
      return Array.from(mapa.values());
    });
  }, [chaveContextoInicial]);

  const runtimeInterno = useOpenCorpSecretarioRuntime({
    workspaceId,
    sessaoId,
    agente: agenteAtivo ?? options?.agente ?? "secretario",
    initialMessages,
    obterContextoEnvio: () => ({
      agente: agenteAtivo ?? undefined,
      imagens: anexosImagens,
      contexto: chipsContexto.map((c) => c.rotulo),
    }),
    onLimparContextoEnvio: () => {
      setChipsContexto([]);
      setAnexosImagens([]);
    },
    onSessaoCriada: (sid) => {
      options?.onSessaoCriada?.(sid);
      aoSessaoCriada?.(sid);
    },
    onPrimeiraMensagem: (texto) => {
      options?.onPrimeiraMensagem?.(texto);
      if (sessaoId) {
        const tituloFormatado = texto.slice(0, 30).trim();
        aoAtualizarTitulo?.(sessaoId, tituloFormatado || "Conversa");
      }
    },
    ...options,
  });

  const runtime = runtimeProp ?? runtimeInterno;
  const ctxTools = useMemo(() => ({ runtime, workspaceId }), [runtime, workspaceId]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatToolsContext.Provider value={ctxTools}>
      <div
        className={`flex flex-col h-full w-full bg-zinc-950 text-zinc-100 font-sans select-text overflow-hidden ${className}`}
      >
        <ThreadPrimitive.Root className="flex flex-col flex-1 h-full min-h-0 overflow-hidden">
          {/* Viewport rolável com scroll suave automático */}
          <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto px-4 md:px-8 py-6 space-y-6">
            <ThreadPrimitive.Empty>
              <div className="flex flex-col items-center justify-center h-full min-h-[360px] text-center p-8 space-y-4">
                <div className="h-16 w-16 rounded-2xl bg-emerald-950/60 border border-emerald-800/40 flex items-center justify-center shadow-lg shadow-emerald-950/20">
                  <Bot size={32} className="text-emerald-400" />
                </div>
                <div className="max-w-md space-y-1.5">
                  <h3 className="text-lg font-semibold text-zinc-100 flex items-center justify-center gap-2">
                    Secretário Executivo
                    <Sparkles size={16} className="text-emerald-400" />
                  </h3>
                  <p className="text-xs text-zinc-400 leading-relaxed">
                    Orquestrador residente do workspace OpenCorp. Capaz de executar ferramentas,
                    gerenciar o Kanban, planejar automações e coordenar agentes de IA.
                  </p>
                </div>

                {/* Sugestões Rápidas (Chips Clicáveis) */}
                <div className="flex flex-wrap items-center justify-center gap-2 pt-2 max-w-lg">
                  {SUGESTOES_RAPIDAS.map((sugestao) => (
                    <button
                      key={sugestao}
                      type="button"
                      onClick={() => {
                        const inputEl = document.getElementById(
                          "chat-input",
                        ) as HTMLTextAreaElement | null;
                        if (inputEl) {
                          const protoSetter = Object.getOwnPropertyDescriptor(
                            window.HTMLTextAreaElement.prototype,
                            "value",
                          )?.set;
                          if (protoSetter) {
                            protoSetter.call(inputEl, sugestao);
                          } else {
                            inputEl.value = sugestao;
                          }
                          inputEl.dispatchEvent(
                            new Event("input", { bubbles: true }),
                          );
                          inputEl.dispatchEvent(
                            new Event("change", { bubbles: true }),
                          );
                          setTimeout(() => {
                            const btnEnviar = document.getElementById(
                              "btn-enviar",
                            ) as HTMLButtonElement | null;
                            btnEnviar?.click();
                          }, 50);
                        }
                      }}
                      className="px-3 py-1.5 rounded-full bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 hover:border-emerald-500/50 text-xs text-zinc-300 hover:text-emerald-300 transition-all cursor-pointer shadow-xs active:scale-95"
                    >
                      {sugestao}
                    </button>
                  ))}
                </div>
              </div>
            </ThreadPrimitive.Empty>

            {/* Lista de Mensagens do Chat com função children */}
            <ThreadPrimitive.Messages>
              {({ message }) => {
                if (message.role === "user") {
                  const textoUsuario = message.content
                    .filter(
                      (p): p is { type: "text"; text: string } =>
                        p.type === "text",
                    )
                    .map((p) => p.text)
                    .join("\n");

                  return (
                    <div className="flex justify-end my-4 oc-user group">
                      <div className="flex items-start gap-2 max-w-[85%] lg:max-w-[75%]">
                        <button
                          type="button"
                          title="Copiar prompt"
                          onClick={() => {
                            if (navigator.clipboard) {
                              void navigator.clipboard.writeText(textoUsuario);
                            }
                          }}
                          className="opacity-70 hover:opacity-100 p-1 text-zinc-500 hover:text-zinc-300 rounded transition-opacity cursor-pointer mt-2"
                        >
                          <Copy size={13} />
                        </button>
                        <div className="rounded-2xl rounded-tr-sm bg-emerald-950/40 border border-emerald-800/40 text-emerald-100 px-4 py-3 text-sm shadow-sm leading-relaxed whitespace-pre-wrap">
                          <MessagePrimitive.Parts
                            components={{
                              Text: () => (
                                <MarkdownTextPrimitive
                                  className="oc-markdown text-sm text-emerald-100"
                                  remarkPlugins={[remarkGfm]}
                                />
                              ),
                            }}
                          />
                        </div>
                        <div className="h-8 w-8 rounded-lg bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-300 flex-shrink-0 mt-0.5">
                          <User size={16} />
                        </div>
                      </div>
                    </div>
                  );
                }

                const textoAssistente = (message.content as any[])
                  .filter((p) => p && p.type === "text" && typeof p.text === "string")
                  .map((p) => p.text as string)
                  .join("\n");
                const temTextoVisivel = textoAssistente.trim().length > 0;
                const respostaVazia = textoAssistente.trim() ===
                  "⚠️ O modelo não retornou texto. Tente reenviar ou selecione outro modelo.";
                const temConteudoEstruturado = (message.content as any[]).some(
                  (parte) => {
                    if (!parte) return false;
                    if (parte.type === "text" || parte.type === "reasoning") {
                      return typeof parte.text === "string" && parte.text.trim().length > 0;
                    }
                    return parte.type === "tool-call";
                  },
                );
                const emExecucao = message.status?.type === "running";
                // Pergunta já respondida = existe mensagem do usuário depois desta.
                const respondida = (() => {
                  const msgs = runtime.thread.getState().messages;
                  const i = msgs.findIndex((x) => x.id === message.id);
                  return i >= 0 && msgs.slice(i + 1).some((x) => x.role === "user");
                })();

                const arquivosGit = parsearSaidaGitStatus(textoAssistente);

                return (
                  <div className="flex justify-start my-4 oc-assistant">
                    <div className="flex items-start gap-3 max-w-[95%] lg:max-w-[88%] w-full">
                      <div className="h-8 w-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white flex-shrink-0 shadow-md shadow-emerald-900/40 mt-0.5">
                        <Bot size={18} />
                      </div>
                      <div className="flex-1 min-w-0 rounded-2xl rounded-tl-sm bg-zinc-900/50 border border-zinc-800/80 px-4 py-3.5 text-sm shadow-sm space-y-2">
                        {!temConteudoEstruturado && emExecucao && (
                          <div
                            data-testid="assistant-typing-indicator"
                            className="flex items-center gap-2 text-zinc-300"
                            role="status"
                            aria-live="polite"
                          >
                            <span className="flex gap-1" aria-hidden="true">
                              {[0, 1, 2].map((indice) => (
                                <span
                                  key={indice}
                                  className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
                                  style={{ animationDelay: `${indice * 140}ms` }}
                                />
                              ))}
                            </span>
                            <span>Pensando...</span>
                          </div>
                        )}

                        {!respostaVazia && (
                          <MessagePrimitive.Parts components={COMPONENTES_PARTES_ASSISTENTE} />
                        )}

                        {!emExecucao && (!temTextoVisivel || respostaVazia) && (
                          <div
                            data-testid="assistant-empty-response"
                            className="flex items-start gap-2 rounded-lg border border-amber-800/50 bg-amber-950/30 px-3 py-2.5 text-amber-200"
                            role="alert"
                          >
                            <AlertCircle size={15} className="mt-0.5 shrink-0" />
                            <span>
                              O modelo não retornou texto. Tente reenviar ou selecione outro modelo.
                            </span>
                          </div>
                        )}

                        {/* Card Interativo de Git Status se houver alterações detectadas */}
                        {arquivosGit.length > 0 && (
                          <GitStatusCard
                            workspaceId={workspaceId}
                            arquivos={arquivosGit}
                          />
                        )}

                        {/* Opções Interativas da LLM (Interactive HITL) para resposta em 1 clique */}
                        <HitlOptionsView
                          texto={respondida ? "" : textoAssistente}
                          onSelecionarOpcao={(opcao) => {
                            void runtime.thread.append({
                              role: "user",
                              content: [{ type: "text", text: opcao }],
                            });
                          }}
                        />
                      </div>
                    </div>
                  </div>
                );
              }}
            </ThreadPrimitive.Messages>

            {/* O composer pertence ao viewport da thread para preservar o
                auto-scroll, o foco e o estado running/cancel do assistant-ui. */}
            <ThreadPrimitive.ViewportFooter className="sticky bottom-0 z-20 -mx-4 md:-mx-8 mt-6 bg-linear-to-t from-zinc-950 via-zinc-950 to-transparent px-4 pb-4 pt-8 md:px-8">
              <ThreadPrimitive.ScrollToBottom
                className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full border border-zinc-700 bg-zinc-900 p-1.5 text-zinc-400 shadow-lg hover:text-zinc-100 disabled:hidden"
                aria-label="Ir para a mensagem mais recente"
              >
                <ChevronDown size={14} />
              </ThreadPrimitive.ScrollToBottom>
              <ChatComposer
                inputId={emDock ? "secretario-dock-input" : "chat-input"}
                enviarId={emDock ? "secretario-dock-btn-enviar" : "btn-enviar"}
                agenteAtivo={agenteAtivo}
                onDefinirAgente={(ag) => setAgenteAtivo(ag)}
                chipsContexto={chipsContexto}
                onAdicionarChip={(c) =>
                  setChipsContexto((prev) => [...prev, c])
                }
                onRemoverChip={(id) =>
                  setChipsContexto((prev) => prev.filter((c) => c.id !== id))
                }
                anexosImagens={anexosImagens}
                onAdicionarImagem={(img) =>
                  setAnexosImagens((prev) => [...prev, img])
                }
                onRemoverImagem={(id) =>
                  setAnexosImagens((prev) => prev.filter((i) => i.id !== id))
                }
              />
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </div>
      </ChatToolsContext.Provider>
    </AssistantRuntimeProvider>
  );
};

/**
 * Componente visual Flagship do Secretário Executivo com @assistant-ui/react
 */
export const SecretarioChat: FC<SecretarioChatProps> = ({
  runtime: runtimeProp,
  options,
  sessaoId,
  aoAtualizarTitulo,
  aoSessaoCriada,
  contextoInicial,
  className = "",
  emDock = false,
}) => {
  const { workspaceId } = useOpenCorp();
  const wsId = options?.workspaceId ?? workspaceId ?? "default";
  const idSessaoAtiva = sessaoId ?? options?.sessaoId;

  // Guarda se este componente montou originalmente como um draft (nova conversa)
  const iniciouComoDraftRef = React.useRef<boolean>(
    !idSessaoAtiva ||
      idSessaoAtiva.startsWith("sessao-") ||
      idSessaoAtiva.startsWith("draft-"),
  );

  // Carregamento de mensagens iniciais persistidas (hidratação no F5 ou troca de aba)
  const [mensagensIniciais, setMensagensIniciais] = useState<
    ThreadMessageLike[] | undefined
  >(() => options?.initialMessages);
  const [carregandoHistorico, setCarregandoHistorico] = useState<boolean>(() => {
    if (options?.initialMessages) return false;
    const sid = idSessaoAtiva?.trim();
    if (!sid) return false;
    if (sid.startsWith("sessao-") || sid.startsWith("draft-")) return false;
    return true;
  });

  useEffect(() => {
    if (options?.initialMessages) {
      setMensagensIniciais(options.initialMessages);
      setCarregandoHistorico(false);
      return;
    }

    // Se este componente montou como um draft na aba ativa, as mensagens estão
    // vivas no runtime local em memória. A promoção para o ID definitivo gerado
    // pelo backend NÃO deve fazer fetch no servidor nem zerar a conversa.
    if (iniciouComoDraftRef.current) {
      return;
    }

    const sid = idSessaoAtiva?.trim();
    if (!sessaoTemHistorico(sid)) {
      setMensagensIniciais([]);
      setCarregandoHistorico(false);
      return;
    }

    let cancelado = false;
    void buscarHistorico(sid, wsId).then((conv) => {
      if (cancelado) return;
      setMensagensIniciais(conv ?? []);
      setCarregandoHistorico(false);
    });

    return () => {
      cancelado = true;
    };
  }, [idSessaoAtiva, wsId, options?.initialMessages]);

  if (carregandoHistorico) {
    return (
      <div className="flex items-center justify-center h-full w-full bg-zinc-950 text-zinc-500 font-mono text-xs">
        <span className="animate-pulse">Carregando histórico da conversa...</span>
      </div>
    );
  }

  // Se iniciou como draft, mantemos uma key interna imutável "chat-ativo" para que a
  // promoção de ID não desmonte o runtime interno em voo.
  const chaveInterna = iniciouComoDraftRef.current
    ? "chat-ativo"
    : `${idSessaoAtiva || "draft"}-${mensagensIniciais ? mensagensIniciais.length : 0}`;

  return (
    <SecretarioChatInterno
      key={chaveInterna}
      runtimeProp={runtimeProp}
      workspaceId={wsId}
      sessaoId={idSessaoAtiva}
      initialMessages={mensagensIniciais}
      aoAtualizarTitulo={aoAtualizarTitulo}
      aoSessaoCriada={aoSessaoCriada}
      contextoInicial={contextoInicial}
      options={options}
      className={className}
      emDock={emDock}
    />
  );
};
