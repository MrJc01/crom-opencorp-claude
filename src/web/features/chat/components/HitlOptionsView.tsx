import React, { useState, type FC } from "react";
import { Sparkles, ArrowRight } from "lucide-react";

export interface ItemOpcaoPergunta {
  id: string;
  pergunta?: string;
  opcoes: string[];
}

/**
 * Analisa o texto em busca de perguntas com opções de escolha:
 * - 1. Opção A, 2. Opção B...
 * - (a) Opção A, (b) Opção B...
 * - [Sim / Não] ou (Sim / Não)
 */
export function extrairOpcoesDoTexto(texto?: string): ItemOpcaoPergunta | null {
  if (!texto || typeof texto !== "string") return null;

  const linhas = texto.split("\n").map((l) => l.trim()).filter(Boolean);
  if (linhas.length === 0) return null;

  // 1. Confirmação binária simples: [Sim / Não] ou (Sim/Não)
  if (/\b(sim\s*\/\s*n[ãa]o|deseja continuar\?|deseja prosseguir\?)\b/i.test(texto)) {
    return {
      id: "binaria",
      pergunta: "Confirmação rápida:",
      opcoes: ["Sim, prosseguir", "Não, cancelar"],
    };
  }

  // 2. Opções inline (a) ... (b) ...
  for (const l of linhas) {
    if (/\(a\)/i.test(l) && /\(b\)/i.test(l)) {
      const partes = l.split(/(?=\([a-d]\))/i);
      const opcoes: string[] = [];
      for (const p of partes) {
        const m = /^\(([a-d])\)\s*(.+)$/i.exec(p.trim());
        if (m && m[2]) {
          opcoes.push(m[2].trim().replace(/;$/, ""));
        }
      }
      if (opcoes.length >= 2 && opcoes.length <= 6) {
        return {
          id: "inline_letras",
          pergunta: "Selecione uma opção:",
          opcoes,
        };
      }
    }
  }

  // 3. Opções em lista numerada ou tópicos verticais
  const possiveisOpcoes: string[] = [];
  let perguntaDetectada: string | undefined;

  for (let i = 0; i < linhas.length; i++) {
    const l = linhas[i];
    if (!l) continue;
    const matchNum = /^(?:(?:\d+[\.\)]|\[\d+\]|[a-d][\.\)])\s+)(.+)$/i.exec(l);
    if (matchNum) {
      const itemTexto = matchNum[1]?.trim() || "";
      // Não confunde caminhos de arquivos ou código com opções de escolha
      const ehCaminhoArquivo = /\.(json|ts|tsx|js|jsx|py|sh|md|css|html)\b/i.test(itemTexto);
      const ehMuitoLongo = itemTexto.length > 120;
      if (!ehCaminhoArquivo && !ehMuitoLongo && itemTexto.length >= 2) {
        possiveisOpcoes.push(itemTexto);
        if (!perguntaDetectada && i > 0) {
          const linhaAnterior = linhas[i - 1];
          if (linhaAnterior && (linhaAnterior.includes("?") || /escolha|opç|selecione|deseja/i.test(linhaAnterior))) {
            perguntaDetectada = linhaAnterior;
          }
        }
      }
    }
  }

  if (possiveisOpcoes.length >= 2 && possiveisOpcoes.length <= 6) {
    return {
      id: "lista_numerada",
      pergunta: perguntaDetectada || "Selecione uma opção para prosseguir:",
      opcoes: possiveisOpcoes,
    };
  }

  return null;
}

export interface HitlOptionsViewProps {
  texto: string;
  onSelecionarOpcao: (opcao: string) => void;
  desabilitado?: boolean;
}

export const HitlOptionsView: FC<HitlOptionsViewProps> = ({
  texto,
  onSelecionarOpcao,
  desabilitado = false,
}) => {
  const dados = extrairOpcoesDoTexto(texto);
  // Depois da escolha o card some (a resposta já está no chat).
  const [respondido, setRespondido] = useState(false);
  if (respondido || !dados || dados.opcoes.length === 0) return null;

  return (
    <div
      className="chat-pergunta-card my-3 p-3 rounded-xl bg-purple-950/20 border border-purple-900/40 text-xs shadow-md"
      role="group"
      aria-label={dados.pergunta || "Opções de resposta rápida"}
    >
      <div className="flex items-center gap-1.5 text-purple-300 font-semibold mb-2 font-mono text-[11px]">
        <Sparkles size={12} className="text-purple-400 animate-pulse" />
        <span>{dados.pergunta || "Opções de resposta rápida:"}</span>
      </div>

      <div className="flex flex-wrap gap-2">
        {dados.opcoes.map((opcao, idx) => (
          <button
            key={`${dados.id}_${idx}`}
            type="button"
            disabled={desabilitado}
            onClick={() => {
              setRespondido(true);
              onSelecionarOpcao(opcao);
            }}
            data-testid="chat-opcao-btn"
            data-opcao={opcao}
            className="chat-opcao-btn flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-purple-950/60 hover:bg-purple-900/80 active:scale-95 border border-purple-800/60 text-purple-200 hover:text-white transition-all text-xs font-medium cursor-pointer shadow-xs disabled:opacity-50 disabled:cursor-not-allowed group text-left"
          >
            <span className="h-4 w-4 rounded-full bg-purple-900/80 text-[10px] font-bold flex items-center justify-center text-purple-300 group-hover:bg-purple-700 group-hover:text-white shrink-0">
              {idx + 1}
            </span>
            <span>{opcao}</span>
            <ArrowRight size={11} className="opacity-60 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all text-purple-300 shrink-0 ml-0.5" />
          </button>
        ))}
      </div>
    </div>
  );
};
