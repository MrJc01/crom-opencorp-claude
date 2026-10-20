import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useExternalStoreRuntime, type AppendMessage, type AssistantRuntime, type ThreadMessageLike } from "@assistant-ui/react";
import type { SecretaryRuntimeOptions } from "../types.js";
import {
  atualizarMensagem,
  criarMensagemAssistente,
  criarMensagemUsuario,
  marcarAprovacao,
  podeSubstituirPeloServidor,
} from "./chat-store.js";
import { assinarTurno, obterTurno, publicarTurno } from "./live-turns.js";
import { buscarHistorico, buscarHistoricoComMeta, sessaoTemHistorico } from "./history-client.js";
import { estadoDaMensagemBackend, reassinarTurno } from "./reassinar.js";
import type { StatusAprovacao } from "./message-converter.js";
import { partesDoEstado, type EstadoTurno } from "./sse-reducer.js";
import { executarTerminalDireto, executarTurno } from "./turno-stream.js";

// Barrel: quem já importava daqui continua funcionando.
export { converterMensagensBackend, buildAssistantParts } from "./message-converter.js";
export { obterAuthHeaders } from "./auth-headers.js";

/** Store de cada runtime criado pelo hook, para os cards alterarem o estado das mensagens. */
const storesPorRuntime = new WeakMap<AssistantRuntime, { marcarAprovacao: (id: string, status: StatusAprovacao) => void }>();

/** Grava no store do runtime a decisão de uma aprovação. Devolve false se o runtime não é do hook. */
export function marcarAprovacaoNoRuntime(runtime: AssistantRuntime, aprovacaoId: string, status: StatusAprovacao): boolean {
  const store = storesPorRuntime.get(runtime);
  store?.marcarAprovacao(aprovacaoId, status);
  return !!store;
}

function textoDaMensagem(message: AppendMessage): string {
  return message.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof (p as any).text === "string")
    .map((p) => p.text)
    .join("\n");
}

/**
 * Runtime do Secretário sobre `useExternalStoreRuntime`: a lista de mensagens vive neste
 * store (React state), é alimentada ao vivo pelo SSE (`turno-stream`/`sse-reducer`) e
 * recarregada do servidor (log JSONL) ao fim do turno e ao voltar para a aba, o que traz
 * ids estáveis e o status real das aprovações.
 */
export function useOpenCorpSecretarioRuntime(options: SecretaryRuntimeOptions = {}): AssistantRuntime {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const sessaoIdRef = useRef<string | undefined>(options.sessaoId);
  if (options.sessaoId) sessaoIdRef.current = options.sessaoId;

  // Se o chat foi remontado no meio de um turno, adota o turno vivo da sessão.
  const vivoInicial = useRef(obterTurno(options.sessaoId)).current;
  const origem = useRef({}).current;
  const [messages, setMessages] = useState<readonly ThreadMessageLike[]>(vivoInicial?.messages ?? options.initialMessages ?? []);
  const [isRunning, setIsRunning] = useState(!!vivoInicial);
  const messagesRef = useRef(messages);
  const runningRef = useRef(!!vivoInicial);
  /** Mensagens enviadas durante um turno (ex.: clique numa opção antes do `fim`): rodam em seguida. */
  const filaRef = useRef<AppendMessage[]>([]);
  const abortRef = useRef<{ abort: () => void } | null>(vivoInicial ? { abort: vivoInicial.abort } : null);
  /** Turno reassinado pelo CONTRATO REATTACH: não publicado em live-turns e sem cancelamento no servidor. */
  const reassinandoRef = useRef(false);
  const estadoReassinadoRef = useRef<EstadoTurno | null>(null);

  const publicar = useCallback(
    (running: boolean) => {
      const id = sessaoIdRef.current;
      if (id) publicarTurno(id, { messages: messagesRef.current, running, origem, abort: () => abortRef.current?.abort() });
    },
    [origem],
  );

  const alterar = useCallback(
    (fn: (atual: readonly ThreadMessageLike[]) => ThreadMessageLike[]) => {
      messagesRef.current = fn(messagesRef.current);
      setMessages(messagesRef.current);
      if (runningRef.current && !reassinandoRef.current) publicar(true);
    },
    [publicar],
  );

  const recarregar = useCallback(async () => {
    const sid = sessaoIdRef.current;
    if (!sessaoTemHistorico(sid) || runningRef.current) return;
    const o = optionsRef.current;
    const servidor = await buscarHistorico(sid, o.workspaceId, o.headers);
    if (servidor && podeSubstituirPeloServidor(messagesRef.current, servidor, runningRef.current)) {
      alterar(() => servidor);
    }
  }, [alterar]);

  // Acompanha um turno que outra instância (já desmontada) ainda está consumindo.
  useEffect(() => {
    if (!options.sessaoId) return;
    return assinarTurno(options.sessaoId, (t) => {
      if (t.origem === origem) return;
      messagesRef.current = t.messages;
      setMessages(t.messages);
      runningRef.current = t.running;
      setIsRunning(t.running);
      abortRef.current = { abort: t.abort };
      if (!t.running) void recarregar();
    });
  }, [options.sessaoId, origem, recarregar]);

  // Voltou para uma conversa com turno vivo no servidor (ex.: saiu com aprovação pendente):
  // reassina os eventos e continua a MESMA mensagem do assistente, sem F5.
  const sessaoReassinar = options.sessaoId;
  const wsReassinar = options.workspaceId;
  useEffect(() => {
    if (!sessaoTemHistorico(sessaoReassinar) || runningRef.current) return;
    const controller = new AbortController();
    const { signal } = controller;
    let ativo = false;
    void (async () => {
      const o = optionsRef.current;
      const hist = await buscarHistoricoComMeta(sessaoReassinar, wsReassinar, o.headers, signal);
      if (signal.aborted || !hist?.emExecucao || hist.logEntradas === undefined || runningRef.current) return;

      const ultimaBruta = hist.brutas[hist.brutas.length - 1];
      const continua = !!ultimaBruta && ultimaBruta.role !== "user";
      const base = continua ? hist.mensagens : [...hist.mensagens, criarMensagemAssistente(`asst_reattach_${Date.now().toString(36)}`)];
      const alvo = base[base.length - 1]!;
      const asstId = String(alvo.id);
      ativo = true;
      reassinandoRef.current = true;
      runningRef.current = true;
      abortRef.current = controller;
      messagesRef.current = continua
        ? atualizarMensagem(base, asstId, { status: { type: "running" } } as any)
        : base;
      setMessages(messagesRef.current);
      setIsRunning(true);

      const escrever = (parts: any[]) => alterar((atual) => atualizarMensagem(atual, asstId, { content: parts } as any));
      let ultimo: EstadoTurno | undefined;
      try {
        for await (const estado of reassinarTurno({
          sessaoId: sessaoReassinar,
          opcoes: o,
          desde: hist.logEntradas,
          estadoInicial: () => estadoDaMensagemBackend(continua ? ultimaBruta : undefined),
          signal,
          aoEstado: (e) => {
            estadoReassinadoRef.current = e;
          },
        })) {
          if (signal.aborted) break;
          ultimo = estado;
          escrever(partesDoEstado(estado));
        }
        if (!signal.aborted && ultimo) {
          const finais = partesDoEstado(ultimo, true);
          if (finais.length > 0) escrever(finais);
        }
      } finally {
        estadoReassinadoRef.current = null;
        if (!signal.aborted) {
          alterar((atual) => atualizarMensagem(atual, asstId, { status: { type: "complete", reason: "stop" } } as any));
          reassinandoRef.current = false;
          runningRef.current = false;
          setIsRunning(false);
          abortRef.current = null;
          const proxima = filaRef.current.shift();
          if (proxima) void onNewRef.current(proxima);
          else void recarregar();
        }
      }
    })();
    return () => {
      controller.abort();
      if (ativo) {
        reassinandoRef.current = false;
        runningRef.current = false;
        estadoReassinadoRef.current = null;
        if (abortRef.current === controller) abortRef.current = null;
      }
    };
  }, [sessaoReassinar, wsReassinar, alterar, recarregar]);

  // Voltar para a aba/janela: o servidor pode ter decidido aprovações ou terminado turnos.
  useEffect(() => {
    const aoVoltar = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible") void recarregar();
    };
    document.addEventListener("visibilitychange", aoVoltar);
    window.addEventListener("focus", aoVoltar);
    return () => {
      document.removeEventListener("visibilitychange", aoVoltar);
      window.removeEventListener("focus", aoVoltar);
    };
  }, [recarregar]);

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const texto = textoDaMensagem(message);
      const trimmed = texto.trim();
      if (!trimmed) return;
      if (runningRef.current) {
        filaRef.current.push(message);
        return;
      }

      if (trimmed.toLowerCase() === "/clear") {
        alterar(() => []);
        return;
      }

      const opcoes = optionsRef.current;
      const primeira = messagesRef.current.length === 0;
      const agora = Date.now().toString(36);
      const asstId = `asst_${agora}`;
      alterar((atual) => [...atual, criarMensagemUsuario(`user_${agora}`, texto), criarMensagemAssistente(asstId)]);
      runningRef.current = true;
      setIsRunning(true);
      const controller = new AbortController();
      abortRef.current = controller;
      const escrever = (parts: any[]) => alterar((atual) => atualizarMensagem(atual, asstId, { content: parts } as any));

      try {
        if (trimmed.startsWith("!")) {
          for await (const bloco of executarTerminalDireto(trimmed.slice(1).trim(), opcoes, controller.signal)) {
            escrever([{ type: "text", text: bloco }]);
          }
        } else {
          if (primeira) opcoes.onPrimeiraMensagem?.(texto);
          let ultimo: EstadoTurno | undefined;
          for await (const estado of executarTurno({ texto, opcoes, sessaoIdRef, signal: controller.signal })) {
            ultimo = estado;
            escrever(partesDoEstado(estado));
          }
          // Emissão final sem o texto transitório de status ("Processando…").
          if (ultimo) {
            const finais = partesDoEstado(ultimo, true);
            if (finais.length > 0) escrever(finais);
          }
        }
      } finally {
        const cancelado = controller.signal.aborted;
        alterar((atual) =>
          atualizarMensagem(atual, asstId, {
            status: cancelado ? { type: "incomplete", reason: "cancelled" } : { type: "complete", reason: "stop" },
          } as any),
        );
        runningRef.current = false;
        setIsRunning(false);
        publicar(false);
        abortRef.current = null;
        const proxima = filaRef.current.shift();
        if (proxima && !cancelado) void onNewRef.current(proxima);
        else {
          filaRef.current = [];
          if (!trimmed.startsWith("!")) void recarregar();
        }
      }
    },
    [alterar, recarregar, publicar],
  );

  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  const onCancel = useCallback(async () => {
    // Turno reassinado: ainda não há endpoint para cancelar o turno do servidor (ver "Pedidos entre frentes");
    // fechar só o SSE faria a UI parecer parada com o turno vivo. Não faz nada.
    if (reassinandoRef.current) return;
    filaRef.current = [];
    abortRef.current?.abort();
  }, []);

  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning,
    convertMessage: (m) => m,
    onNew,
    onCancel,
  });

  const store = useMemo(
    () => ({
      marcarAprovacao: (id: string, status: StatusAprovacao) => {
        // Mantém o estado do turno reassinado em sincronia: o próximo evento reconstrói as partes dele.
        const alvo = estadoReassinadoRef.current?.aprovacoes.find((a) => a.id === id);
        if (alvo) alvo.status = status;
        alterar((atual) => marcarAprovacao(atual, id, status));
      },
    }),
    [alterar],
  );
  storesPorRuntime.set(runtime, store);

  return runtime;
}
