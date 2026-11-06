import type { NoGrafo } from "./types.js";

const texto = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const corta = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Explicação automática do nó quando ele não tem `comentario` escrito: tipo + o que a configuração diz. */
export function descreverNo(no: NoGrafo): string {
  const c = (no.config ?? {}) as Record<string, unknown>;
  switch (no.tipo) {
    case "cron":
      return `Gatilho por horário: dispara o fluxo em "${texto(c.expressao_cron) ?? texto(c.expressao) ?? "horário configurado"}".`;
    case "webhook":
      return "Gatilho por chamada HTTP: o fluxo roda quando algo envia uma requisição para ele.";
    case "manual":
      return "Gatilho manual: o fluxo só roda quando você clica em Executar.";
    case "agente":
      return `Chama o agente "${texto(c.agente) ?? "?"}" com a ordem abaixo e passa a resposta ao próximo nó.${texto(c.prompt) ? `\n\nOrdem: ${corta(texto(c.prompt)!)}` : ""}`;
    case "script":
      return `Roda um comando no workspace${texto(c.comando) ? `:\n${corta(texto(c.comando)!)}` : "."}`;
    case "condicao":
      return `Decide o caminho: se "${texto(c.chave) ?? "a chave"}" for verdadeira segue para "${texto(c.entao) ?? "então"}", senão para "${texto(c.senao) ?? "senão"}".`;
    case "delay":
      return "Espera um tempo antes de seguir para o próximo nó.";
    case "loop":
      return "Repete uma parte do fluxo até a condição de parada.";
    case "subflow":
      return `Executa outro fluxo${texto(c.flow) ?? texto(c.fluxo_id) ? ` ("${texto(c.flow) ?? texto(c.fluxo_id)}")` : ""} como etapa.`;
    case "fanout":
      return "Dispara vários agentes em paralelo e junta as respostas.";
    case "review":
      return "Um agente revisor avalia o resultado anterior e aprova ou pede correção.";
    case "debate":
      return "Agentes debatem a questão e um moderador fecha a decisão.";
    case "http_request":
      return `Faz uma chamada HTTP${texto(c.url) ? ` para ${corta(texto(c.url)!, 90)}` : ""}.`;
    case "componente":
      return "Executa um componente pronto da biblioteca.";
    case "task_create":
      return "Cria uma tarefa no quadro (Kanban).";
    case "registro":
      return "Grava um registro do que aconteceu.";
    case "reuniao":
      return "Abre uma reunião entre agentes.";
    case "saida":
      return "Fim do caminho: entrega o resultado final do fluxo.";
    default:
      return `Nó do tipo "${no.tipo}".`;
  }
}
