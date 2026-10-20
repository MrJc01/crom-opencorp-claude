import { parsearBlocoSse, separarBlocosSse } from "../../../lib/chat/secretary-stream.js";

export interface EventoSse {
  evento: string;
  dados: unknown;
}

/**
 * Lê o corpo de uma resposta SSE e emite cada evento com o JSON já decodificado (blocos
 * sem JSON válido são ignorados). Consumidor único: o stream do turno (`turno-stream`) e a
 * reassinatura (`reassinar`) passam por aqui. Erros de leitura propagam ao chamador.
 */
export async function* lerEventosSse(resp: Response, signal: AbortSignal): AsyncGenerator<EventoSse> {
  const reader = resp.body?.getReader();
  if (!reader) throw new Error("Resposta vazia recebida do servidor.");
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      const { blocos, resto } = separarBlocosSse(buffer + decoder.decode(value, { stream: true }));
      buffer = resto;
      for (const bloco of blocos) {
        const sse = parsearBlocoSse(bloco);
        if (!sse) continue;
        let dados: unknown;
        try {
          dados = JSON.parse(sse.dados);
        } catch {
          continue;
        }
        yield { evento: sse.evento || "mensagem", dados };
      }
    }
  } finally {
    // Fecha a conexão (libera o socket) mesmo se o consumidor parar no meio.
    await reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {}
  }
}
