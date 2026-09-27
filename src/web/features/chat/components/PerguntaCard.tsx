import React, { useState, type FC, type FormEvent } from "react";
import { ArrowRight, HelpCircle, PencilLine, Send } from "lucide-react";

/**
 * Card da ferramenta de pergunta da IA (`ask_question` / `question` do OpenCode).
 * Aceita uma pergunta (`{ question, options }`) ou várias (`{ questions: [...] }`).
 * Uma pergunta: o clique envia a resposta. Várias: cada escolha avança e ao final
 * "Enviar respostas" manda tudo junto. Sempre há "Outro" para resposta livre.
 * Depois de respondido, o card some.
 */
export interface PerguntaIA {
  header?: string;
  question: string;
  options: string[];
}

export function normalizarPerguntas(args: unknown): PerguntaIA[] {
  const a = (args ?? {}) as Record<string, any>;
  const lista: any[] = Array.isArray(a.questions) ? a.questions : a.question || a.pergunta ? [a] : [];
  return lista
    .map((q) => ({
      header: typeof q.header === "string" ? q.header : undefined,
      question: String(q.question ?? q.pergunta ?? "").trim(),
      options: (Array.isArray(q.options) ? q.options : Array.isArray(q.opcoes) ? q.opcoes : [])
        .map((o: any) => (typeof o === "string" ? o : String(o?.label ?? o?.value ?? "")))
        .filter(Boolean),
    }))
    .filter((q) => q.question.length > 0);
}

export const PerguntaCard: FC<{ args: unknown; onResponder: (texto: string) => void; respondida?: boolean }> = ({ args, onResponder, respondida = false }) => {
  const perguntas = normalizarPerguntas(args);
  const [indice, setIndice] = useState(0);
  const [respostas, setRespostas] = useState<Record<number, string>>({});
  const [livre, setLivre] = useState(false);
  const [textoLivre, setTextoLivre] = useState("");
  const [respondido, setRespondido] = useState(false);

  if (respondida || respondido || perguntas.length === 0) return null;

  const total = perguntas.length;
  const atual = perguntas[Math.min(indice, total - 1)]!;

  const concluir = (finais: Record<number, string>) => {
    const texto =
      total === 1
        ? finais[0]!
        : perguntas.map((p, i) => `${p.header ? `${p.header} — ` : ""}${p.question}: ${finais[i] ?? "(sem resposta)"}`).join("\n");
    setRespondido(true);
    onResponder(texto);
  };

  const escolher = (valor: string) => {
    const novas = { ...respostas, [indice]: valor };
    setRespostas(novas);
    setLivre(false);
    setTextoLivre("");
    if (total === 1) concluir(novas);
    else if (indice < total - 1) setIndice(indice + 1);
  };

  const enviarLivre = (e: FormEvent) => {
    e.preventDefault();
    const valor = textoLivre.trim();
    if (!valor) return;
    // Resposta livre na última pergunta envia todas as respostas de uma vez.
    if (total > 1 && indice === total - 1) concluir({ ...respostas, [indice]: valor });
    else escolher(valor);
  };

  const respondidas = Object.keys(respostas).length;

  return (
    <div
      className="chat-pergunta-card my-3 space-y-2.5 rounded-xl border border-purple-900/40 bg-purple-950/20 p-3 text-xs shadow-md"
      role="group"
      aria-label={atual.question}
    >
      <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-purple-300">
        <span className="flex items-center gap-1.5 font-semibold">
          <HelpCircle size={12} aria-hidden="true" />
          {atual.header ?? "Pergunta da IA"}
        </span>
        {total > 1 && <span aria-live="polite">Pergunta {indice + 1} de {total}</span>}
      </div>

      {total > 1 && (
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Perguntas">
          {perguntas.map((p, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === indice}
              onClick={() => setIndice(i)}
              className={`rounded-full border px-2 py-0.5 text-[10px] ${
                i === indice ? "border-purple-500 bg-purple-900/60 text-purple-100" : "border-purple-900/60 text-purple-300"
              }`}
            >
              {p.header ?? `Pergunta ${i + 1}`}
              {respostas[i] ? " ✓" : ""}
            </button>
          ))}
        </div>
      )}

      <p className="text-sm text-zinc-100">{atual.question}</p>

      <div className="flex flex-wrap gap-2">
        {atual.options.map((opcao) => (
          <button
            key={opcao}
            type="button"
            data-testid="chat-opcao-btn"
            data-opcao={opcao}
            aria-pressed={respostas[indice] === opcao}
            onClick={() => escolher(opcao)}
            className={`chat-opcao-btn flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-left text-xs font-medium transition-all ${
              respostas[indice] === opcao
                ? "border-purple-500 bg-purple-800/70 text-white"
                : "border-purple-800/60 bg-purple-950/60 text-purple-200 hover:bg-purple-900/80 hover:text-white"
            }`}
          >
            <span>{opcao}</span>
            <ArrowRight size={11} aria-hidden="true" className="opacity-60" />
          </button>
        ))}
        <button
          type="button"
          onClick={() => setLivre(true)}
          className="flex items-center gap-1.5 rounded-xl border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          <PencilLine size={11} aria-hidden="true" />
          Outro: digitar resposta personalizada...
        </button>
      </div>

      {livre && (
        <form onSubmit={enviarLivre} className="flex gap-2">
          <input
            autoFocus
            value={textoLivre}
            onChange={(e) => setTextoLivre(e.target.value)}
            placeholder="Digite sua resposta personalizada"
            aria-label="Resposta personalizada"
            className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 focus:border-purple-500 focus:outline-none"
          />
          <button type="submit" className="flex items-center gap-1 rounded-lg bg-purple-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-600">
            <Send size={11} aria-hidden="true" />
            Enviar
          </button>
        </form>
      )}

      {total > 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={respondidas === 0}
            onClick={() => concluir(respostas)}
            className="rounded-lg bg-purple-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-purple-600 disabled:opacity-50"
          >
            Enviar respostas ({respondidas}/{total})
          </button>
        </div>
      )}
    </div>
  );
};
