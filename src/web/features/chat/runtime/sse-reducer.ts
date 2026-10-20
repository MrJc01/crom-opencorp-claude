import { ThinkParser } from "../../../lib/chat/secretary-stream.js";
import { buildAssistantParts, type AcaoMensagem, type AprovacaoMotor } from "./message-converter.js";

/** Acumulador de um turno do assistente alimentado pelos eventos SSE do servidor. */
export interface EstadoTurno {
  texto: string;
  pensamento: string;
  /** Texto transitório ("Processando…") mostrado só enquanto não há resposta. */
  status: string;
  acoes: AcaoMensagem[];
  aprovacoes: AprovacaoMotor[];
  think: ThinkParser;
}

export function criarEstadoTurno(): EstadoTurno {
  return { texto: "", pensamento: "", status: "", acoes: [], aprovacoes: [], think: new ThinkParser() };
}

export interface ResultadoEvento {
  /** Id real da sessão informado pelo evento `inicio`/`sessao`. */
  sessaoId?: string;
  /** O servidor encerrou o turno (`fim`/`erro`) ou não há turno vivo (`inativo`). */
  terminou?: boolean;
}

const SEM_TEXTO = "⚠️ O modelo não retornou texto. Tente reenviar ou selecione outro modelo.";

function mesclarAcao(estado: EstadoTurno, nova: AcaoMensagem): void {
  const i = estado.acoes.findIndex((a) => a.ferramenta === nova.ferramenta && a.resumo === nova.resumo);
  if (i >= 0) estado.acoes[i] = { ...estado.acoes[i]!, ...nova };
  else estado.acoes.push(nova);
}

/**
 * Aplica um evento SSE (inicio/status/passos/pensamento/delta/acao/aprovacao/fim/erro)
 * ao estado do turno. Muta `estado` (é local ao turno) e devolve efeitos para o chamador.
 */
export function aplicarEventoSse(
  estado: EstadoTurno,
  evento: string,
  dados: any,
  workspaceId: string,
): ResultadoEvento {
  const out: ResultadoEvento = {};

  if ((evento === "inicio" || evento === "sessao") && dados.sessao_id) {
    const id = String(dados.sessao_id).trim();
    if (id) out.sessaoId = id;
    estado.status = dados.modelo ? `⏳ Processando com ${dados.modelo}...` : "⏳ Processando...";
  } else if (evento === "status" || evento === "fallback_modelo") {
    estado.status = dados.aviso || dados.status || "";
  } else if (evento === "passos" && Array.isArray(dados.passos)) {
    const pensamentos = dados.passos
      .filter((p: any) => p?.tipo === "pensamento" && p.texto)
      .map((p: any) => String(p.texto));
    if (pensamentos.length > 0) estado.pensamento = pensamentos.join("\n\n");
    // Ferramentas de pergunta: o evento "acao" não traz as opções; "passos" traz.
    for (const p of dados.passos) {
      if (p?.tipo !== "acao" || !(p.pergunta || p.opcoes || p.perguntas)) continue;
      mesclarAcao(estado, {
        ferramenta: String(p.ferramenta || "ferramenta"),
        resumo: String(p.resumo || ""),
        status: String(p.status || "completed"),
        sucesso: p.sucesso !== false,
        pergunta: p.pergunta,
        opcoes: p.opcoes,
        perguntas: p.perguntas,
      });
    }
  } else if (evento === "pensamento") {
    estado.pensamento = dados.acumulado || estado.pensamento + (dados.delta || "");
  } else if (evento === "delta") {
    estado.status = "";
    const { deltaConteudo, deltaPensamento } = estado.think.processDelta(dados.delta || "");
    if (deltaPensamento) estado.pensamento += deltaPensamento;
    if (deltaConteudo) estado.texto += deltaConteudo;
  } else if (evento === "acao") {
    const itens = Array.isArray(dados)
      ? dados
      : Array.isArray(dados.itens)
        ? dados.itens
        : dados.ferramenta
          ? [dados]
          : [];
    for (const it of itens) {
      const status = String(it.status || "completed");
      const resumo = it.resumo || "Executando inspeção de workspace...";
      mesclarAcao(estado, {
        ferramenta: it.ferramenta || it.tool || "ferramenta",
        resumo,
        status,
        sucesso: it.sucesso !== false && !["error", "failed", "falha"].includes(status.toLowerCase()),
      });
      if (["pending", "running"].includes(status.toLowerCase())) estado.status = `⚡ Executando ${resumo}`;
    }
  } else if (evento === "aprovacao" && dados.id) {
    if (!estado.aprovacoes.some((a) => a.id === dados.id)) {
      estado.aprovacoes.push({
        id: String(dados.id),
        acao: dados.acao,
        descricao: dados.descricao,
        workspace: dados.workspace ?? workspaceId,
        motor: dados.motor,
        status: "pendente",
      });
    }
    estado.status = "⏸ Aguardando sua aprovação...";
  } else if (evento === "aprovacao_resolvida" && dados.id) {
    // Decisão tomada em outra aba/Dock (ou expirada): o cartão atualiza ao vivo.
    const alvo = estado.aprovacoes.find((a) => a.id === String(dados.id));
    const status = ["aprovado", "rejeitado", "expirada"].includes(dados.status) ? dados.status : undefined;
    if (alvo && status) alvo.status = status;
    if (estado.status.startsWith("⏸")) estado.status = "";
  } else if (evento === "inativo") {
    estado.status = "";
    out.terminou = true;
  } else if (evento === "fim") {
    out.terminou = true;
    estado.status = "";
    if (dados.resposta && !estado.texto) {
      const resposta = String(dados.resposta).trim();
      estado.texto = ["Processamento concluído.", "Ação concluída."].includes(resposta) ? SEM_TEXTO : resposta;
    }
  } else if (evento === "erro") {
    out.terminou = true;
    estado.texto += `\n\n⚠️ ${dados.mensagem || dados.erro || "Erro interno no agente"}`;
  }

  return out;
}

/** Partes do Assistant UI para o estado atual; `final` omite o texto transitório de status. */
export function partesDoEstado(estado: EstadoTurno, final = false): any[] {
  return buildAssistantParts(
    estado.pensamento,
    estado.acoes,
    final ? estado.texto : estado.texto || estado.status,
    estado.aprovacoes,
  );
}
