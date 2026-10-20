import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Runner de agente do motor "claude-sdk". Roda como processo filho (o session-manager
 * espera stdout/stderr e código de saída) e usa `query()` do SDK em vez de `claude -p`.
 * Recebe o ambiente já resolvido pelo ClaudeSdkDriver (contas, login, sem chave do shell).
 */

/** Mesmo conjunto de ferramentas dos agentes (frontmatter `tools`). Sem prompt de permissão. */
export const FERRAMENTAS_AGENTE = ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebFetch", "WebSearch"];

/**
 * Só as configurações do workspace (cwd): CLAUDE.md e `.claude/skills/*` do workspace.
 * As do usuário (~/.claude) ficam de fora, para o agente não herdar o ambiente pessoal do dono.
 */
export const OPCOES_WORKSPACE_SDK: Pick<Options, "settingSources" | "skills"> = { settingSources: ["project"], skills: "all" };

export interface OpcoesRunnerCli {
  cwd: string;
  prompt: string;
  model?: string;
  claudePath?: string;
  /** Arquivo do agente montado pelo OpenCorp (.opencorp/opencode/agent/<id>.md): papel, regras e skills. */
  agentePath?: string;
}

/** Corpo do arquivo do agente, sem o frontmatter YAML. */
export function lerInstrucoesAgente(conteudo: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(conteudo);
  const corpo = (m ? m[1] : conteudo).trim();
  // O arquivo é montado para o opencode e termina com catálogo de skills, contexto adaptativo (Kanban, scripts,
  // documento "recente") e a instrução da tool `notificar`. No claude-sdk as skills vêm do SDK e o contexto do
  // CLAUDE.md do workspace; esse anexo só gasta tokens e confunde. Fica o papel do agente + skills declaradas.
  const corte = corpo.indexOf("\n## Available Skills (Progressive Disclosure)");
  return (corte >= 0 ? corpo.slice(0, corte) : corpo).trim();
}

export interface SaidasRunnerCli {
  stdout: (texto: string) => void;
  stderr: (texto: string) => void;
}

type Consulta = typeof query;

/** Lê `--cwd`, `--model`, `--claude-path`; o prompt vem depois de `--`. */
export function lerArgumentosCli(argv: string[]): OpcoesRunnerCli {
  const fim = argv.indexOf("--");
  const opcoes = fim === -1 ? argv : argv.slice(0, fim);
  const prompt = fim === -1 ? "" : argv.slice(fim + 1).join(" ");
  const valor = (nome: string): string | undefined => {
    const i = opcoes.indexOf(nome);
    return i === -1 ? undefined : opcoes[i + 1];
  };
  const cwd = valor("--cwd");
  if (!cwd) throw new Error("uso: claude-sdk-cli --cwd <dir> [--model <id>] [--claude-path <bin>] [--agente <arquivo.md>] -- <prompt>");
  return { cwd, prompt, model: valor("--model"), claudePath: valor("--claude-path"), agentePath: valor("--agente") };
}

/** Executa o agente e devolve o código de saída. A saída final vai para stdout, como no `claude -p`. */
export async function executarAgenteCli(
  opts: OpcoesRunnerCli,
  saidas: SaidasRunnerCli,
  consulta: Consulta = query,
): Promise<number> {
  let resposta: string | undefined;
  let falha: string | undefined;
  let escreveu = false;
  try {
    // Sem isto o agente recebia só a ordem do fluxo, sem o papel e as regras do .md dele.
    const instrucoes = opts.agentePath ? lerInstrucoesAgente(readFileSync(opts.agentePath, "utf8")) : "";
    const mensagens = consulta({
      prompt: opts.prompt,
      options: {
        cwd: opts.cwd,
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.claudePath ? { pathToClaudeCodeExecutable: opts.claudePath } : {}),
        permissionMode: "acceptEdits",
        allowedTools: FERRAMENTAS_AGENTE,
        ...OPCOES_WORKSPACE_SDK,
        ...(instrucoes ? { systemPrompt: { type: "preset", preset: "claude_code", append: instrucoes } } : {}),
      },
    });
    for await (const msg of mensagens as AsyncIterable<SDKMessage>) {
      // Texto do assistente sai à medida que chega: o session-manager mata a execução
      // após 60 s sem saída, e um agente pesquisando fica longos trechos sem terminar.
      if (msg.type === "assistant") {
        for (const bloco of msg.message?.content ?? []) {
          if (bloco.type !== "text" || !bloco.text) continue;
          saidas.stdout(`${bloco.text}\n`);
          escreveu = true;
        }
      }
      if (msg.type !== "result") continue;
      if (msg.subtype === "success" && !msg.is_error) resposta = msg.result;
      else falha = msg.subtype === "success" ? msg.result : msg.errors.join("; ") || msg.subtype;
    }
  } catch (err) {
    falha = err instanceof Error ? err.message : String(err);
  }
  if (falha !== undefined || resposta === undefined) {
    saidas.stderr(`${falha ?? "Claude Agent SDK encerrou sem resultado final"}\n`);
    return 1;
  }
  // Se o texto já saiu em tempo real, não repete o resultado final.
  if (!escreveu) saidas.stdout(`${resposta}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const opts = lerArgumentosCli(process.argv.slice(2));
  const codigo = await executarAgenteCli(opts, {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
  });
  process.exitCode = codigo;
}
