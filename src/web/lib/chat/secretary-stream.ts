/**
 * @module secretary-stream — Processador de stream SSE e parser de raciocínio do Secretário.
 *
 * Provê parsing robusto de Server-Sent Events (SSE), máquina de estados para
 * segregação de tags <think>...</think> (raciocínio/pensamento) e tratamento de erros RFC 7807.
 */

import { ProblemDetailsError } from "@opencorp/sdk";

export interface StatusEvento {
  tipo: string;
  aviso?: string;
  modelo?: string;
  erro?: boolean;
}

export interface AcaoItem {
  ferramenta: string;
  resumo: string;
  sucesso: boolean;
}

export interface GitState {
  gitStatus?: any;
  gitDiff?: any;
}

export interface FimEvento {
  modelo?: string;
  resposta?: string;
  content?: string;
  gitStatus?: any;
  gitDiff?: any;
}

export interface StreamCallbacks {
  onDelta?: (delta: string, textoAcumulado: string) => void;
  onPensamento?: (delta: string, pensamentoAcumulado: string) => void;
  onPasso?: (passo: any) => void;
  onStatus?: (status: string, evento?: StatusEvento) => void;
  onHitl?: (hitlData: any) => void;
  onSessaoId?: (sessaoId: string) => void;
  onModelo?: (modelo: string) => void;
  onAcao?: (itens: AcaoItem[]) => void;
  onGitState?: (git: GitState) => void;
  onFim?: (dados?: FimEvento) => void;
  onError?: (erro: Error) => void;
}

export interface ExecutarStreamOptions {
  url: string;
  headers: Record<string, string>;
  body: any;
  signal?: AbortSignal;
  callbacks: StreamCallbacks;
}

/**
 * Máquina de estados para segregação em tempo real do conteúdo dentro e fora
 * de blocos <think>...</think> (Modelos com Chain-of-Thought como DeepSeek R1 / Nemotron Ultra).
 */
export class ThinkParser {
  private inThinking = false;

  reset(): void {
    this.inThinking = false;
  }

  processDelta(delta: string): { deltaConteudo: string; deltaPensamento: string } {
    let deltaConteudo = "";
    let deltaPensamento = "";
    let text = delta;

    while (text.length > 0) {
      if (!this.inThinking) {
        const startIdx = text.toLowerCase().indexOf("<think>");
        if (startIdx === -1) {
          deltaConteudo += text;
          text = "";
        } else {
          deltaConteudo += text.slice(0, startIdx);
          this.inThinking = true;
          text = text.slice(startIdx + 7);
        }
      } else {
        const endIdx = text.toLowerCase().indexOf("</think>");
        if (endIdx === -1) {
          deltaPensamento += text;
          text = "";
        } else {
          deltaPensamento += text.slice(0, endIdx);
          this.inThinking = false;
          text = text.slice(endIdx + 8);
        }
      }
    }

    return { deltaConteudo, deltaPensamento };
  }
}

/**
 * Converte respostas HTTP de erro para ProblemDetailsError conforme RFC 7807.
 */
export async function parseProblemDetails(resp: Response): Promise<ProblemDetailsError> {
  const status = resp.status;
  try {
    const data = await resp.json();
    return new ProblemDetailsError({
      status,
      type: data.type || `https://opencorp.dev/errors/http-${status}`,
      title: data.title || (data.erro || data.mensagem || `Erro HTTP ${status}`),
      detail: data.detail || data.erro || data.mensagem,
      instance: data.instance,
      invalidParams: data.invalidParams,
    });
  } catch {
    return new ProblemDetailsError({
      status,
      type: `https://opencorp.dev/errors/http-${status}`,
      title: `Erro HTTP ${status}`,
      detail: resp.statusText || `Servidor respondeu com status ${status}`,
    });
  }
}

/** Bloco SSE já separado em nome do evento e corpo (`data:` concatenado). */
export interface BlocoSse {
  evento: string;
  dados: string;
}

/** Lê um bloco SSE (texto entre linhas em branco). Devolve null se não houver `data:`. */
export function parsearBlocoSse(bloco: string): BlocoSse | null {
  let evento = "";
  const dataLinhas: string[] = [];
  for (const linha of bloco.split("\n")) {
    const trimmed = linha.trim();
    if (trimmed.startsWith("event:")) evento = trimmed.slice(6).trim();
    else if (trimmed.startsWith("data:")) dataLinhas.push(trimmed.slice(5).trim());
  }
  if (dataLinhas.length === 0) return null;
  return { evento, dados: dataLinhas.join("\n") };
}

/** Separa blocos SSE completos de um buffer parcial; `resto` é o pedaço ainda incompleto. */
export function separarBlocosSse(buffer: string): { blocos: string[]; resto: string } {
  const partes = buffer.replace(/\r\n/g, "\n").split("\n\n");
  const resto = partes.pop() ?? "";
  return { blocos: partes.filter((b) => b.trim()), resto };
}

/**
 * Executa o streaming SSE com consumo assíncrono e despacho reativo de eventos.
 */
export async function executarSecretarioStream(options: ExecutarStreamOptions): Promise<void> {
  const { url, headers, body, signal, callbacks } = options;

  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal,
  });

  if (!resp.ok) {
    const problem = await parseProblemDetails(resp);
    throw problem;
  }

  const reader = resp.body?.getReader();
  if (!reader) {
    const err = new Error("Stream indisponível ou corpo da resposta vazio");
    callbacks.onError?.(err);
    throw err;
  }

  const decoder = new TextDecoder();
  const thinkParser = new ThinkParser();
  let buffer = "";
  let textoAcumulado = "";
  let pensamentoAcumulado = "";

  const processarBlocoSse = (bloco: string) => {
    const parsed = parsearBlocoSse(bloco);
    if (!parsed) return;
    const currentEvent = parsed.evento;
    const jsonStr = parsed.dados;
    if (jsonStr === "[DONE]") return;

    try {
      const payload = JSON.parse(jsonStr);
      const evtType = currentEvent || payload.tipo || "";

      if (payload.gitStatus || payload.gitDiff) {
        callbacks.onGitState?.({
          gitStatus: payload.gitStatus,
          gitDiff: payload.gitDiff,
        });
      }

      if (evtType === "inicio" && payload.sessao_id) {
        callbacks.onSessaoId?.(payload.sessao_id);
      } else if (evtType === "status" || evtType === "fallback_modelo") {
        callbacks.onStatus?.(payload.aviso || payload.status || "", {
          tipo: evtType,
          aviso: payload.aviso,
          modelo: payload.modelo,
          erro: Boolean(payload.erro || payload.aviso?.includes("falhou") || payload.aviso?.includes("⚠️") || payload.aviso?.includes("erro")),
        });
        if (payload.modelo) {
          callbacks.onModelo?.(payload.modelo);
        }
      } else if (evtType === "passos" && Array.isArray(payload.passos)) {
        callbacks.onPasso?.(payload.passos);
      } else if (evtType === "delta") {
        const rawDelta = payload.delta || payload.texto || "";
        const { deltaConteudo, deltaPensamento } = thinkParser.processDelta(rawDelta);

        if (deltaPensamento) {
          pensamentoAcumulado += deltaPensamento;
          callbacks.onPensamento?.(deltaPensamento, pensamentoAcumulado);
        }
        if (deltaConteudo) {
          textoAcumulado += deltaConteudo;
          callbacks.onDelta?.(deltaConteudo, textoAcumulado);
        }
      } else if (evtType === "pensamento") {
        const deltaTxt = payload.delta || payload.pensamento || payload.texto || "";
        if (deltaTxt) {
          pensamentoAcumulado += deltaTxt;
          callbacks.onPensamento?.(deltaTxt, pensamentoAcumulado);
        }
      } else if (evtType === "acao") {
        const itens: AcaoItem[] = [];
        if (Array.isArray(payload.itens) && payload.itens.length > 0) {
          for (const item of payload.itens) {
            itens.push({
              ferramenta: item.ferramenta || item.tool || "ferramenta",
              resumo: item.resumo || item.summary || "executando...",
              sucesso: item.sucesso !== false,
            });
          }
        } else if (payload.ferramenta) {
          itens.push({
            ferramenta: payload.ferramenta,
            resumo: payload.resumo || "executando...",
            sucesso: payload.sucesso !== false,
          });
        }
        if (itens.length > 0) {
          callbacks.onAcao?.(itens);
        }
      } else if (evtType === "hitl") {
        callbacks.onHitl?.(payload.hitl || payload);
      } else if (evtType === "fim") {
        if (payload.modelo) {
          callbacks.onModelo?.(payload.modelo);
        }
        callbacks.onFim?.({
          modelo: payload.modelo,
          resposta: payload.resposta,
          content: payload.content,
          gitStatus: payload.gitStatus,
          gitDiff: payload.gitDiff,
        });
      } else if (evtType === "erro") {
        const msgErro = payload.erro || payload.mensagem || "Erro desconhecido";
        callbacks.onError?.(new Error(msgErro));
      }
    } catch {}
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundaryIndex: number;
      while ((boundaryIndex = buffer.indexOf("\n\n")) !== -1) {
        const bloco = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        if (bloco.trim()) {
          processarBlocoSse(bloco);
        }
      }
    }

    if (buffer.trim()) {
      processarBlocoSse(buffer);
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    const erroFinal = err instanceof Error ? err : new Error(String(err));
    callbacks.onError?.(erroFinal);
    throw erroFinal;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }
}
