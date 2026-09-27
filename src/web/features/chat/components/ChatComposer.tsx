import React, {
  useState,
  useRef,
  useCallback,
  useEffect,
  useMemo,
  type FC,
} from "react";
import { ComposerPrimitive, ThreadPrimitive } from "@assistant-ui/react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import {
  Send,
  Square,
  Sparkles,
  Bot,
  Terminal,
  Stethoscope,
  Paperclip,
  X,
  FileText,
  CheckSquare,
} from "lucide-react";

export interface AutocompleteItem {
  id: string;
  tipo: "slash" | "at" | "bang";
  gatilho: string;
  titulo: string;
  descricao: string;
  categoria: string;
  icone: React.ComponentType<{ size?: number; className?: string }>;
}

export interface ContextChip {
  id: string;
  tipo: "arquivo" | "task" | "flow";
  rotulo: string;
  detalhe?: string;
}

export interface AnexoImagem {
  id: string;
  nome: string;
  mime: string;
  url: string; // Data URL Base64
}

export const SLASH_COMMANDS: AutocompleteItem[] = [
  {
    id: "slash-status",
    tipo: "slash",
    gatilho: "/status",
    titulo: "/status",
    descricao: "Verifica integridade dos workspaces, rotação de modelos e agentes",
    categoria: "Sistema",
    icone: Sparkles,
  },
  {
    id: "slash-doctor",
    tipo: "slash",
    gatilho: "/doctor",
    titulo: "/doctor",
    descricao: "Diagnóstico profundo de portas, daemon OpenCode e conexões",
    categoria: "Sistema",
    icone: Stethoscope,
  },
  {
    id: "slash-agents",
    tipo: "slash",
    gatilho: "/agents",
    titulo: "/agents",
    descricao: "Lista catálogo de agentes disponíveis e seus papéis",
    categoria: "Agentes",
    icone: Bot,
  },
  {
    id: "slash-tasks",
    tipo: "slash",
    gatilho: "/tasks",
    titulo: "/tasks",
    descricao: "Exibe quadro Kanban de tarefas da fábrica YouTube",
    categoria: "Kanban",
    icone: CheckSquare,
  },
  {
    id: "slash-git-status",
    tipo: "slash",
    gatilho: "/git status",
    titulo: "/git status",
    descricao: "Exibe arquivos modificados e branch ativa",
    categoria: "Git",
    icone: Terminal,
  },
  {
    id: "slash-clear",
    tipo: "slash",
    gatilho: "/clear",
    titulo: "/clear",
    descricao: "Limpa visualização de histórico visível da sessão",
    categoria: "Chat",
    icone: X,
  },
];

export const MENTIONS_PADRAO: AutocompleteItem[] = [
  {
    id: "at-secretario",
    tipo: "at",
    gatilho: "@secretario-exec",
    titulo: "@agente:secretario-exec",
    descricao: "Orquestrador mestre e supervisor residente",
    categoria: "Agentes",
    icone: Bot,
  },
  {
    id: "at-redator",
    tipo: "at",
    gatilho: "@redator-roteirista",
    titulo: "@agente:redator-roteirista",
    descricao: "Especialista em redação, roteirização e copywriting",
    categoria: "Agentes",
    icone: Bot,
  },
  {
    id: "at-auditor",
    tipo: "at",
    gatilho: "@workspace-auditor",
    titulo: "@agente:workspace-auditor",
    descricao: "Auditor técnico de código e sanidade da esteira",
    categoria: "Agentes",
    icone: Bot,
  },
];

export interface ChatComposerProps {
  placeholder?: string;
  /** Ids do campo e do botão de envio (o dock usa ids próprios). */
  inputId?: string;
  enviarId?: string;
  modeloAtivo?: string;
  onTrocarModelo?: (modelo: string) => void;
  agenteAtivo?: string | null;
  onDefinirAgente?: (agente: string | null) => void;
  chipsContexto?: ContextChip[];
  onAdicionarChip?: (chip: ContextChip) => void;
  onRemoverChip?: (id: string) => void;
  anexosImagens?: AnexoImagem[];
  onAdicionarImagem?: (imagem: AnexoImagem) => void;
  onRemoverImagem?: (id: string) => void;
  onLimparHistorico?: () => void;
  onEnviar?: (dados: {
    texto: string;
    agente?: string;
    modelo?: string;
    imagens?: AnexoImagem[];
    contexto?: string[];
  }) => void;
  isProcessando?: boolean;
  onCancelar?: () => void;
}

export const ChatComposer: FC<ChatComposerProps> = ({
  placeholder = "Pergunte ao Secretário ou digite / para comandos...",
  inputId = "chat-input",
  enviarId = "btn-enviar",
  agenteAtivo,
  onDefinirAgente,
  chipsContexto = [],
  onRemoverChip,
  anexosImagens = [],
  onAdicionarImagem,
  onRemoverImagem,
}) => {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Menções `@` vêm dos agentes ativos do workspace (não de uma lista fixa).
  const { client } = useOpenCorp();
  const [mencoes, setMencoes] = useState<AutocompleteItem[]>([]);
  useEffect(() => {
    let vivo = true;
    client.agents
      .listar()
      .then((lista: any[]) => {
        if (!vivo || !Array.isArray(lista)) return;
        setMencoes(
          lista
            .filter((a) => a?.id && a.ativo !== false && a.active !== false)
            .map((a) => ({
              id: `at-${a.id}`,
              tipo: "at" as const,
              gatilho: `@${a.id}`,
              titulo: `@${a.id}`,
              descricao: a.role || a.descricao || a.nome || "Agente do workspace",
              categoria: "Agentes",
              icone: Bot,
            })),
        );
      })
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [client]);

  // Estados de gatilhos (/ @ !) e popover de sugestões
  const [popoverAberto, setPopoverAberto] = useState<boolean>(false);
  const [tipoGatilho, setTipoGatilho] = useState<"slash" | "at" | "bang" | null>(null);
  const [termoFiltro, setTermoFiltro] = useState<string>("");
  const [indiceFocado, setIndiceFocado] = useState<number>(0);

  // Lista de itens filtrados para o popover ativo
  const itensFiltrados = useMemo(() => {
    if (!popoverAberto || !tipoGatilho) return [];
    const termo = termoFiltro.toLowerCase().trim();

    if (tipoGatilho === "slash") {
      return SLASH_COMMANDS.filter(
        (cmd) =>
          cmd.gatilho.toLowerCase().includes(termo) ||
          cmd.descricao.toLowerCase().includes(termo),
      );
    }
    if (tipoGatilho === "at") {
      return (mencoes.length > 0 ? mencoes : MENTIONS_PADRAO).filter(
        (m) =>
          m.titulo.toLowerCase().includes(termo) ||
          m.descricao.toLowerCase().includes(termo) ||
          m.gatilho.toLowerCase().includes(termo),
      );
    }
    if (tipoGatilho === "bang") {
      return [
        {
          id: "bang-status",
          tipo: "bang" as const,
          gatilho: "!status",
          titulo: "!status",
          descricao: "Executa verificação rápida de status do sistema",
          categoria: "Shell",
          icone: Terminal,
        },
        {
          id: "bang-git",
          tipo: "bang" as const,
          gatilho: "!git status --short",
          titulo: "!git status",
          descricao: "Executa git status no terminal do workspace",
          categoria: "Shell",
          icone: Terminal,
        },
      ].filter((cmd) => cmd.gatilho.toLowerCase().includes(termo));
    }
    return [];
  }, [popoverAberto, tipoGatilho, termoFiltro, mencoes]);

  const aplicarTextoNoInput = useCallback((novoTexto: string) => {
    const inputEl = document.getElementById(inputId) as HTMLTextAreaElement | null;
    if (!inputEl) return;
    const protoSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    if (protoSetter) {
      protoSetter.call(inputEl, novoTexto);
    } else {
      inputEl.value = novoTexto;
    }
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new Event("change", { bubbles: true }));
    inputEl.focus();
  }, [inputId]);

  const selecionarItemAutocomplete = useCallback(
    (item: AutocompleteItem) => {
      setPopoverAberto(false);
      setTipoGatilho(null);
      setTermoFiltro("");

      if (item.tipo === "at") {
        const idAgente = item.gatilho.replace(/^@/, "");
        onDefinirAgente?.(idAgente);
        const inputEl = document.getElementById(inputId) as HTMLTextAreaElement | null;
        if (inputEl) {
          const valAtual = inputEl.value;
          const limpo = valAtual.replace(/@[a-zA-Z0-9_-]*$/, "").trim();
          aplicarTextoNoInput(limpo ? `${limpo} ` : "");
        }
        return;
      }

      // / ou !: deixa um espaço para os argumentos do comando.
      aplicarTextoNoInput(`${item.gatilho} `);
    },
    [aplicarTextoNoInput, onDefinirAgente, inputId],
  );

  const verificarGatilhos = useCallback((texto: string, posCursor: number) => {
    const textoAteCursor = texto.slice(0, posCursor);
    const ultimoToken = textoAteCursor.split(/\s+/).pop() || "";

    if (ultimoToken.startsWith("/")) {
      setTipoGatilho("slash");
      setTermoFiltro(ultimoToken);
      setPopoverAberto(true);
      setIndiceFocado(0);
      return;
    }
    if (ultimoToken.startsWith("@")) {
      setTipoGatilho("at");
      setTermoFiltro(ultimoToken.slice(1));
      setPopoverAberto(true);
      setIndiceFocado(0);
      return;
    }
    if (ultimoToken.startsWith("!")) {
      setTipoGatilho("bang");
      setTermoFiltro(ultimoToken);
      setPopoverAberto(true);
      setIndiceFocado(0);
      return;
    }

    setPopoverAberto(false);
    setTipoGatilho(null);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (popoverAberto && itensFiltrados.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setIndiceFocado((prev) => (prev + 1) % itensFiltrados.length);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setIndiceFocado((prev) => (prev - 1 + itensFiltrados.length) % itensFiltrados.length);
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          if (!e.shiftKey) {
            e.preventDefault();
            const escolhido = itensFiltrados[indiceFocado];
            if (escolhido) {
              selecionarItemAutocomplete(escolhido);
              return;
            }
          }
        }
      }

      if (e.key === "Escape") {
        if (popoverAberto) {
          e.preventDefault();
          e.stopPropagation();
          setPopoverAberto(false);
          setTipoGatilho(null);
          return;
        }
      }
    },
    [popoverAberto, itensFiltrados, indiceFocado, selecionarItemAutocomplete],
  );

  const inserirGatilhoRapido = useCallback(
    (gatilho: "/" | "@" | "!") => {
      const inputEl = document.getElementById(inputId) as HTMLTextAreaElement | null;
      if (!inputEl) return;
      const atual = inputEl.value;
      const prefixo = atual.length > 0 && !atual.endsWith(" ") ? `${atual} ` : atual;
      aplicarTextoNoInput(`${prefixo}${gatilho}`);
      verificarGatilhos(`${prefixo}${gatilho}`, `${prefixo}${gatilho}`.length);
    },
    [aplicarTextoNoInput, verificarGatilhos, inputId],
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files || []);
      if (files.length === 0) return;

      for (const file of files) {
        if (file.type.startsWith("image/")) {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result === "string") {
              onAdicionarImagem?.({
                id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                nome: file.name,
                mime: file.type,
                url: reader.result,
              });
            }
          };
          reader.readAsDataURL(file);
        }
      }
      e.target.value = "";
    },
    [onAdicionarImagem],
  );

  return (
    <ComposerPrimitive.Root className="relative flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 p-2 shadow-sm focus-within:border-emerald-500/60 transition-colors">
      {/* ─────────────────────────────────────────────────────────────
          POPOVER DE AUTOCOMPLETE FLUTUANTE (/, @, !)
         ───────────────────────────────────────────────────────────── */}
      {popoverAberto && itensFiltrados.length > 0 && (
        <div
          data-autocomplete-popover
          className="absolute bottom-full left-0 mb-2 w-72 sm:w-84 max-h-64 overflow-y-auto rounded-xl bg-zinc-950/95 border border-zinc-800 p-1.5 shadow-2xl z-50 text-xs backdrop-blur-md animate-in fade-in slide-in-from-bottom-2 duration-150 scrollbar-thin"
        >
          <div className="px-2 py-1 mb-1 text-[10px] font-semibold text-zinc-500 uppercase tracking-wider border-b border-zinc-800/80 flex items-center justify-between">
            <span>
              {tipoGatilho === "slash"
                ? "Comandos do Sistema (/)"
                : tipoGatilho === "at"
                ? "Mencionar Agente (@)"
                : "Terminal Shell (!)"}
            </span>
            <span className="text-[9px] text-zinc-500 font-mono">Esc para fechar</span>
          </div>

          <div className="space-y-0.5">
            {itensFiltrados.map((item, idx) => {
              const focado = idx === indiceFocado;
              const Icone = item.icone;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => selecionarItemAutocomplete(item)}
                  onMouseEnter={() => setIndiceFocado(idx)}
                  className={`w-full flex items-start gap-2.5 px-2.5 py-1.5 rounded-lg text-left transition-colors cursor-pointer ${
                    focado
                      ? "bg-zinc-850 text-zinc-100 border border-zinc-700/60"
                      : "text-zinc-300 hover:bg-zinc-900 border border-transparent"
                  }`}
                >
                  <div className="p-1 rounded bg-zinc-800 text-emerald-400 shrink-0 mt-0.5">
                    <Icone size={12} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="font-mono font-medium text-emerald-300 text-xs truncate">
                        {item.titulo}
                      </span>
                      <span className="text-[9px] text-zinc-500 font-mono shrink-0">
                        {item.categoria}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 line-clamp-1 leading-snug">
                      {item.descricao}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          PÍLULAS DE CONTEXTO, DESTINATÁRIO E ANEXOS
         ───────────────────────────────────────────────────────────── */}
      {(agenteAtivo || chipsContexto.length > 0 || anexosImagens.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-2 pt-1 pb-2 border-b border-zinc-800/60 text-xs">
          {agenteAtivo && (
            <div className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-950/60 border border-emerald-700/50 text-emerald-300 text-[11px] font-mono">
              <Bot size={11} className="text-emerald-400" />
              <span>para @{agenteAtivo}</span>
              <button
                type="button"
                onClick={() => onDefinirAgente?.(null)}
                title="Remover destinatário (voltar ao Secretário padrão)"
                className="hover:text-emerald-100 p-0.5 cursor-pointer ml-0.5"
              >
                <X size={10} />
              </button>
            </div>
          )}

          {chipsContexto.map((chip) => (
            <div
              key={chip.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 text-[11px] border border-zinc-700/60"
            >
              <FileText size={11} className="text-zinc-400" />
              <span className="font-mono truncate max-w-[120px]">{chip.rotulo}</span>
              <button
                type="button"
                onClick={() => onRemoverChip?.(chip.id)}
                className="hover:text-zinc-100 p-0.5 cursor-pointer"
              >
                <X size={10} />
              </button>
            </div>
          ))}

          {anexosImagens.map((img) => (
            <div
              key={img.id}
              className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-zinc-800 text-zinc-300 text-[11px] border border-zinc-700/60"
            >
              <img
                src={img.url}
                alt={img.nome}
                className="h-4 w-4 rounded object-cover"
              />
              <span className="truncate max-w-[100px]">{img.nome}</span>
              <button
                type="button"
                onClick={() => onRemoverImagem?.(img.id)}
                className="hover:text-zinc-100 p-0.5 cursor-pointer"
              >
                <X size={10} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ─────────────────────────────────────────────────────────────
          INPUT PRIMITIVO DO ASSISTANT-UI COM AUTORESIZE E EVENTOS
         ───────────────────────────────────────────────────────────── */}
      <ComposerPrimitive.Input
        id={inputId}
        aria-label="Mensagem para o Secretário"
        autoFocus
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        onInput={(e) => {
          const el = e.currentTarget;
          verificarGatilhos(el.value, el.selectionStart ?? el.value.length);
        }}
        className="w-full bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none resize-none min-h-[44px] max-h-36 px-2 py-1 font-sans"
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.txt,.md,.json,.py,.ts,.js,.cjs,.mjs"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* ─────────────────────────────────────────────────────────────
          TOOLBAR LIMPA: GATILHOS [/] [@] [!], ANEXO, CANCELAR E ENVIAR
          (Sem dropdown manual de modelo - rotação autônoma no backend)
         ───────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between pt-2 px-1 text-[11px] text-zinc-500 border-t border-zinc-800/40 mt-1 select-none">
        <div className="flex items-center gap-1.5 font-mono">
          <button
            type="button"
            onClick={() => inserirGatilhoRapido("/")}
            title="Comandos rápidos (/)"
            className="px-1.5 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-purple-400 hover:text-purple-300 font-bold text-[10px] transition-colors cursor-pointer border border-zinc-700/60"
          >
            [/]
          </button>
          <button
            type="button"
            onClick={() => inserirGatilhoRapido("@")}
            title="Mencionar agente, arquivo ou task (@)"
            className="px-1.5 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-emerald-400 hover:text-emerald-300 font-bold text-[10px] transition-colors cursor-pointer border border-zinc-700/60"
          >
            [@]
          </button>
          <button
            type="button"
            onClick={() => inserirGatilhoRapido("!")}
            title="Execução shell direta (!)"
            className="px-1.5 py-0.5 rounded bg-zinc-800/80 hover:bg-zinc-700 text-amber-400 hover:text-amber-300 font-bold text-[10px] transition-colors cursor-pointer border border-zinc-700/60"
          >
            [!]
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Anexar arquivo ou imagem"
            className="p-1 rounded text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer ml-1"
          >
            <Paperclip size={13} />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Botão de Cancelar nativo exibido apenas durante execução */}
          <ThreadPrimitive.If running={true}>
            <ComposerPrimitive.Cancel
              className="flex items-center justify-center h-8 w-8 rounded-xl bg-rose-600/80 hover:bg-rose-500 active:scale-95 text-white transition-all cursor-pointer shadow-md shadow-rose-950/50"
              title="Interromper processamento"
            >
              <Square size={13} />
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>

          {/* Botão de Enviar nativo exibido quando o chat está ocioso */}
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send
              id={enviarId}
              data-testid={enviarId}
              aria-label="Enviar mensagem"
              className="flex items-center justify-center h-8 w-8 rounded-xl bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white transition-all cursor-pointer shadow-md shadow-emerald-950/50"
              title="Enviar (Enter)"
            >
              <Send size={14} />
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
};
