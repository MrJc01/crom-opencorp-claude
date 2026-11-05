import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { traduzirModelo, type MembroPoolResolvido } from "../provedor-claude.js";
import { classificarFalha, escolherMembro, gravarEstadoRotacao, lerEstadoRotacao, limparBloqueiosVencidos, registrarBloqueio, registrarUso } from "../rotacao-provedores.js";

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
  /** Pool de provedores: uma conta por tentativa, com troca automática quando uma esgota a cota. */
  pool?: { id: string; home: string; modeloPedido?: string; membros: MembroPoolResolvido[] };
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
  /**
   * Sinal de vida a cada ferramenta que o agente aciona (vai para o stderr no processo real). Um agente que lê
   * arquivos e roda comandos por minutos sem escrever texto não pode parecer "travado" ao session-manager (180 s).
   */
  atividade?: (texto: string) => void;
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
  if (!cwd) throw new Error("uso: claude-sdk-cli --cwd <dir> [--model <id>] [--pool <id> --home <dir>] [--claude-path <bin>] [--agente <arquivo.md>] -- <prompt>");
  const poolId = valor("--pool");
  const home = valor("--home");
  // Os membros (com credenciais) chegam por OPENCORP_POOL_MEMBROS; main() preenche. Aqui fica só o pedido.
  const pool = poolId && home ? { id: poolId, home, modeloPedido: valor("--model-pedido"), membros: [] } : undefined;
  return { cwd, prompt, model: valor("--model"), claudePath: valor("--claude-path"), agentePath: valor("--agente"), pool };
}

/** Variáveis que definem a conta do provedor: são trocadas a cada tentativa do pool. */
const VARIAVEIS_CONTA = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CONFIG_DIR",
];

export function aplicarContaDoMembro(membro: MembroPoolResolvido, alvo: NodeJS.ProcessEnv = process.env): void {
  for (const v of VARIAVEIS_CONTA) delete alvo[v];
  Object.assign(alvo, membro.env);
  if (membro.configDir) alvo.CLAUDE_CONFIG_DIR = membro.configDir;
}

/**
 * Roda o agente com rodízio entre as contas do pool: uma tentativa por membro. Cota esgotada (429, 402, cota diária)
 * ou modelo indisponível (403) põe o membro em cooldown e a tentativa segue para outro. Erro de rede tenta outro sem
 * bloquear. Erro que não depende da conta (prompt, ferramenta) para na hora.
 */
export async function executarComRotacao(
  opts: OpcoesRunnerCli,
  saidas: SaidasRunnerCli,
  consulta: Consulta = query,
  agora: () => Date = () => new Date(),
): Promise<number> {
  const pool = opts.pool;
  if (!pool) return executarAgenteCli(opts, saidas, consulta);
  const excluir: string[] = [];
  for (let tentativa = 0; tentativa < pool.membros.length; tentativa++) {
    const estado = lerEstadoRotacao(pool.home);
    limparBloqueiosVencidos(estado, agora());
    const { id, bloqueados } = escolherMembro(
      pool.membros.map((m) => m.id),
      estado,
      agora(),
      excluir,
    );
    gravarEstadoRotacao(pool.home, estado);
    if (!id) {
      const motivos = bloqueados.map((b) => `${b.id} (${b.motivo}, volta ${b.ate})`).join("; ");
      saidas.stderr(`pool "${pool.id}" sem membro disponível: ${motivos || "todos os membros já falharam nesta chamada"}\n`);
      return 1;
    }
    const membro = pool.membros.find((m) => m.id === id)!;
    aplicarContaDoMembro(membro);
    // Saída da tentativa fica guardada até saber se ela deu certo: a mensagem de cota de uma conta não pode virar
    // resposta do agente. Só a atividade (ferramentas usadas, no stderr) segue em tempo real para o watchdog.
    let erro = "";
    let texto = "";
    const codigo = await executarAgenteCli(
      { ...opts, model: traduzirModelo(membro.modelos, pool.modeloPedido) },
      { stdout: (t) => (texto += t), stderr: (t) => (erro += t), atividade: saidas.atividade },
      consulta,
    );
    const depois = lerEstadoRotacao(pool.home);
    if (codigo === 0) {
      saidas.stdout(texto);
      registrarUso(depois, id);
      gravarEstadoRotacao(pool.home, depois);
      return 0;
    }
    const falha = classificarFalha(erro, agora());
    if (falha.classe === "outra") {
      saidas.stdout(texto);
      saidas.stderr(erro);
      return codigo;
    }
    if (falha.ate) registrarBloqueio(depois, id, falha.ate, falha.motivo);
    gravarEstadoRotacao(pool.home, depois);
    const fim = falha.ate ? `, fora até ${falha.ate.toISOString()}` : "";
    saidas.stderr(`[rotação] ${id}: ${falha.motivo}${fim}; tentando outro membro\n`);
    excluir.push(id);
  }
  saidas.stderr(`pool "${pool.id}": todos os membros falharam nesta chamada\n`);
  return 1;
}

/** Membros do pool, com credenciais, vindos do ambiente (passado pelo driver). */
export function membrosDoAmbiente(bruto: string | undefined): MembroPoolResolvido[] {
  if (!bruto) return [];
  try {
    const lista = JSON.parse(bruto) as MembroPoolResolvido[];
    return Array.isArray(lista) ? lista : [];
  } catch {
    return [];
  }
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
          if (bloco.type === "tool_use") saidas.atividade?.(`· ${bloco.name}\n`);
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
  if (opts.pool) opts.pool.membros = membrosDoAmbiente(process.env.OPENCORP_POOL_MEMBROS);
  const codigo = await executarComRotacao(opts, {
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    atividade: (t) => process.stderr.write(t),
  });
  process.exitCode = codigo;
}
