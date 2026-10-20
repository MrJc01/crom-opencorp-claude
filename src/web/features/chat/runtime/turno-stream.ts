import { parseProblemDetails } from "../../../lib/chat/secretary-stream.js";
import type { SecretaryRuntimeOptions } from "../types.js";
import { obterAuthHeaders, originAtual } from "./auth-headers.js";
import { lerEventosSse } from "./sse-consumidor.js";
import { aplicarEventoSse, criarEstadoTurno, type EstadoTurno } from "./sse-reducer.js";

export interface ExecucaoTurno {
  texto: string;
  opcoes: SecretaryRuntimeOptions;
  sessaoIdRef: { current: string | undefined };
  signal: AbortSignal;
}

function montarCorpo(texto: string, opcoes: SecretaryRuntimeOptions, sessaoId?: string): Record<string, unknown> {
  const extra = opcoes.obterContextoEnvio?.();
  const body: Record<string, unknown> = {
    cliente_id: `react_${Date.now().toString(36)}`,
    mensagem: texto,
    prompt: texto,
    agente: extra?.agente ?? opcoes.agente ?? "secretario",
  };
  if (sessaoId) body.sessao_id = sessaoId;
  const modelo = extra?.modelo ?? opcoes.modelo;
  if (modelo) {
    body.modelo = modelo;
    body.model = modelo;
  }
  if (extra?.imagens?.length) body.imagens = extra.imagens;
  if (extra?.contexto?.length) body.contexto = extra.contexto;
  return body;
}

function falha(estado: EstadoTurno, texto: string): EstadoTurno {
  estado.texto = texto;
  return estado;
}

/**
 * Envia a mensagem ao Secretário e emite o estado acumulado do turno a cada evento SSE.
 * O chamador converte cada estado em partes (`partesDoEstado`) e grava no store.
 */
export async function* executarTurno(exec: ExecucaoTurno): AsyncGenerator<EstadoTurno> {
  const { texto, opcoes, sessaoIdRef, signal } = exec;
  const origin = originAtual();
  const wsId = opcoes.workspaceId || "default";
  const estado = criarEstadoTurno();

  const query = new URLSearchParams();
  if (sessaoIdRef.current) query.set("sessao", sessaoIdRef.current);
  if (wsId) query.set("workspace", wsId);
  const url = `${opcoes.url ?? "/secretario/conversa/stream"}?${query.toString()}`;
  const body = JSON.stringify(montarCorpo(texto, opcoes, sessaoIdRef.current));
  const headers = { "Content-Type": "application/json", ...obterAuthHeaders(), ...(opcoes.headers ?? {}) };
  const enviar = () => fetch(url, { method: "POST", headers, body, signal });

  let resp: Response;
  try {
    resp = await enviar();
  } catch (err: any) {
    if (signal.aborted) return;
    yield falha(estado, `⚠️ Erro de conexão com o Secretário: ${err.message}`);
    return;
  }

  // Secretário parado (409): inicia e repete uma vez.
  if (resp.status === 409) {
    try {
      await fetch(`${origin}/secretario/start`, { method: "POST", headers, signal });
      await new Promise((r) => setTimeout(r, 600));
      resp = await enviar();
    } catch {}
  }

  if (!resp.ok) {
    const problem = await parseProblemDetails(resp);
    opcoes.onErro?.(problem);
    yield falha(estado, `⚠️ ${problem.title || "Erro"}: ${problem.detail || problem.message}`);
    return;
  }

  if (!resp.body) {
    yield falha(estado, "⚠️ Resposta vazia recebida do servidor.");
    return;
  }

  try {
    for await (const { evento, dados } of lerEventosSse(resp, signal)) {
      const { sessaoId } = aplicarEventoSse(estado, evento, dados, wsId);
      if (sessaoId && sessaoIdRef.current !== sessaoId) {
        sessaoIdRef.current = sessaoId;
        opcoes.onSessaoCriada?.(sessaoId);
      }
      yield estado;
    }
  } catch (err: any) {
    if (!signal.aborted) yield falha(estado, `${estado.texto}\n\n⚠️ Conexão interrompida: ${err.message}`);
  } finally {
    opcoes.onLimparContextoEnvio?.();
  }
}

/** `!comando`: executa direto no terminal do workspace (POST /terminal) e emite o bloco de saída. */
export async function* executarTerminalDireto(
  comando: string,
  opcoes: SecretaryRuntimeOptions,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const wsId = opcoes.workspaceId || "default";
  const bloco = (linhas: string) => `\`\`\`terminal\n$ !${comando}\n${linhas}\n\`\`\``;
  yield bloco(`[executando comando no terminal do workspace ${wsId}...]`);
  try {
    const res = await fetch(`${originAtual()}/terminal?workspace=${encodeURIComponent(wsId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...obterAuthHeaders(), ...(opcoes.headers ?? {}) },
      body: JSON.stringify({ comando, workspace: wsId }),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    yield bloco(
      data.saida ||
        (data.erro
          ? `Erro: ${data.erro}`
          : !res.ok
            ? `Erro HTTP ${res.status}: falha na execução do comando`
            : "(Comando executado com sucesso)"),
    );
  } catch (err: any) {
    if (!signal.aborted) yield bloco(`Falha de conexão com terminal: ${err.message}`);
  }
}
