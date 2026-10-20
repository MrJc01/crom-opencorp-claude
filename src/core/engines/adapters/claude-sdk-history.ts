import type { MensagemHistorico } from "../event-log.js";

/** Subconjunto de `SessionMessage` do SDK que o conversor lê (o SDK tipa `message` como unknown). */
export interface MensagemTranscricaoSdk {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
}

const PREFIXO_CONTEXTO = "[CONTEXTO OPERACIONAL DO WORKSPACE";
const FIM_CONTEXTO = "\n---\n\n";

interface Bloco {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

function blocos(message: unknown): Bloco[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Bloco[]) : [];
}

/** O Secretário cola o contexto do workspace antes da mensagem; no histórico só interessa o que o dono escreveu. */
export function removerContextoWorkspace(texto: string): string {
  if (!texto.startsWith(PREFIXO_CONTEXTO)) return texto;
  const i = texto.lastIndexOf(FIM_CONTEXTO);
  return i < 0 ? texto : texto.slice(i + FIM_CONTEXTO.length);
}

function resumoFerramenta(nome: string, input: Record<string, unknown> | undefined): string {
  const comando = typeof input?.command === "string" ? input.command : undefined;
  if (comando) return `$ ${comando}`;
  const arquivo = (input?.file_path ?? input?.path ?? input?.pattern) as unknown;
  return typeof arquivo === "string" ? `${nome} ${arquivo}` : nome;
}

/**
 * Converte a transcrição do SDK (`getSessionMessages`) no formato de mensagens do histórico do Secretário.
 * Só conversas de antes do log de eventos passam por aqui; resultados de ferramenta entram como status das ações.
 */
export function converterTranscricaoSdk(mensagens: MensagemTranscricaoSdk[]): MensagemHistorico[] {
  const saida: MensagemHistorico[] = [];
  const acoes = new Map<string, NonNullable<MensagemHistorico["acoes"]>[number]>();
  let atual: MensagemHistorico | undefined;

  for (const m of mensagens) {
    const partes = blocos(m.message);
    if (m.type === "user") {
      for (const b of partes) {
        if (b.type === "tool_result" && b.tool_use_id) {
          const acao = acoes.get(b.tool_use_id);
          if (acao) {
            acao.status = b.is_error ? "failed" : "completed";
            acao.sucesso = !b.is_error;
          }
        }
      }
      const texto = partes.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
      const limpo = removerContextoWorkspace(texto).trim();
      if (!limpo) continue;
      atual = undefined;
      saida.push({ id: `u${saida.length}`, role: "user", content: limpo, criado_em: "" });
    } else if (m.type === "assistant") {
      if (!atual) {
        atual = { id: `a${saida.length}`, role: "assistant", content: "", criado_em: "", acoes: [], aprovacoes: [] };
        saida.push(atual);
      }
      for (const b of partes) {
        if (b.type === "text" && b.text) atual.content += (atual.content ? "\n\n" : "") + b.text;
        else if (b.type === "tool_use" && b.id && b.name) {
          const acao = { ferramenta: b.name, resumo: resumoFerramenta(b.name, b.input), status: "running" as const, sucesso: true };
          acoes.set(b.id, acao);
          atual.acoes!.push(acao);
        }
      }
    }
  }
  return saida;
}
