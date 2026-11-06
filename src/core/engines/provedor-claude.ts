import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs-safe.js";
import { expandTilde } from "../../utils/paths.js";
import { claudeConfigDirOpencorp } from "./drivers/claude-config-dir.js";
import { escolherMembro, gravarEstadoRotacao, lerEstadoRotacao, limparBloqueiosVencidos } from "./rotacao-provedores.js";

/**
 * Provedor do motor "claude-sdk": de onde vêm a autenticação e os modelos que o Claude Agent SDK usa.
 *
 *  - `assinatura`: login do claude.ai (plano Pro/Max), o padrão histórico do projeto.
 *  - `api`: API da Anthropic com chave (cobrança por token).
 *  - `compativel`: qualquer endpoint que fale o protocolo da Anthropic (OpenRouter, Z.ai/GLM, DeepSeek, Kimi, Ollama,
 *    LiteLLM...). Informa `baseUrl`, chave e o mapa de modelos.
 *
 * A escolha mora em `<home>/.opencorp/provedores.json`; `OPENCORP_PROVEDOR=<id>` vence o arquivo (útil em um processo só).
 * Trocar de provedor ou de modelo é editar esse arquivo, ou `opencorp provedor ...`; nenhum código muda.
 */
export type TipoProvedor = "assinatura" | "api" | "compativel" | "pool";

export interface ProvedorClaude {
  nome?: string;
  tipo: TipoProvedor;
  /**
   * Só para `assinatura`: pasta de login (CLAUDE_CONFIG_DIR) de outra conta do Claude Code, ex.: ~/.claude-conta2.
   * Sem ela vale OPENCORP_CLAUDE_CONFIG_DIR (conta própria do OpenCorp) ou o ~/.claude padrão.
   */
  configDir?: string;
  /** Só para `compativel`: URL base do endpoint (sem /v1/messages). */
  baseUrl?: string;
  /** Chave direta no arquivo (o arquivo é gravado com permissão 600). Prefira `chaveEnv`. */
  chave?: string;
  /** Nome da variável de ambiente que guarda a chave. */
  chaveEnv?: string;
  /**
   * Tradução de modelos. A chave é um id completo ("claude-haiku-5-5"), uma família ("haiku", "sonnet", "opus")
   * ou "padrao" (usado quando nenhum modelo é pedido). O valor é o id real no provedor.
   */
  modelos?: Record<string, string>;
  /** Só para `pool`: ids de provedores `compativel`/`api` que se revezam quando uma conta esgota a cota. */
  membros?: string[];
}

export interface ConfigProvedores {
  ativo: string;
  provedores: Record<string, ProvedorClaude>;
}

export interface ResolucaoProvedor {
  id: string;
  tipo: TipoProvedor;
  /** Variáveis a juntar ao ambiente do SDK (autenticação, URL base, modelos padrão por família). */
  env: Record<string, string>;
  /** Pasta CLAUDE_CONFIG_DIR: login do OpenCorp (assinatura) ou uma pasta própria do provedor. */
  configDir: string | undefined;
  /** Traduz o modelo pedido pelo agente/Secretário para o id do provedor; undefined = padrão do SDK. */
  modelo: (pedido: string | undefined) => string | undefined;
  /** Só em pool: o membro escolhido (o `id` é o do pool). */
  membro?: string;
}

export class ProvedorError extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "ProvedorError";
  }
}

export const CONFIG_PROVEDORES_PADRAO: ConfigProvedores = {
  ativo: "assinatura",
  provedores: { assinatura: { nome: "Assinatura Claude (login do claude.ai)", tipo: "assinatura" } },
};

const FAMILIAS = ["haiku", "sonnet", "opus"] as const;

export function caminhoConfigProvedores(homeDir: string): string {
  return join(homeDir, ".opencorp", "provedores.json");
}

function provedorValido(bruto: unknown): ProvedorClaude | undefined {
  if (!bruto || typeof bruto !== "object") return undefined;
  const p = bruto as Record<string, unknown>;
  if (p.tipo !== "assinatura" && p.tipo !== "api" && p.tipo !== "compativel" && p.tipo !== "pool") return undefined;
  const membros = Array.isArray(p.membros) ? p.membros.filter((m): m is string => typeof m === "string" && m.trim() !== "") : undefined;
  const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const modelos: Record<string, string> = {};
  if (p.modelos && typeof p.modelos === "object") {
    for (const [k, v] of Object.entries(p.modelos as Record<string, unknown>)) if (texto(v)) modelos[k] = texto(v) as string;
  }
  return {
    tipo: p.tipo as TipoProvedor,
    ...(texto(p.nome) ? { nome: texto(p.nome) } : {}),
    ...(texto(p.configDir) ? { configDir: texto(p.configDir) } : {}),
    ...(texto(p.baseUrl) ? { baseUrl: texto(p.baseUrl) } : {}),
    ...(texto(p.chave) ? { chave: texto(p.chave) } : {}),
    ...(texto(p.chaveEnv) ? { chaveEnv: texto(p.chaveEnv) } : {}),
    ...(Object.keys(modelos).length ? { modelos } : {}),
    ...(membros?.length ? { membros } : {}),
  };
}

/** Lê o arquivo; ausente ou ilegível = só a assinatura (o comportamento de sempre). Entradas inválidas são ignoradas. */
export function lerConfigProvedores(homeDir: string): ConfigProvedores {
  const caminho = caminhoConfigProvedores(homeDir);
  if (!existsSync(caminho)) return structuredClone(CONFIG_PROVEDORES_PADRAO);
  try {
    const bruto = JSON.parse(readFileSync(caminho, "utf8")) as { ativo?: unknown; provedores?: Record<string, unknown> };
    const provedores: Record<string, ProvedorClaude> = { ...CONFIG_PROVEDORES_PADRAO.provedores };
    for (const [id, valor] of Object.entries(bruto.provedores ?? {})) {
      const p = provedorValido(valor);
      if (p) provedores[id] = p;
    }
    const ativo = typeof bruto.ativo === "string" && bruto.ativo.trim() ? bruto.ativo.trim() : "assinatura";
    return { ativo, provedores };
  } catch {
    return structuredClone(CONFIG_PROVEDORES_PADRAO);
  }
}

export async function gravarConfigProvedores(homeDir: string, config: ConfigProvedores): Promise<void> {
  const caminho = caminhoConfigProvedores(homeDir);
  mkdirSync(join(homeDir, ".opencorp"), { recursive: true });
  await writeFileAtomic(caminho, `${JSON.stringify(config, null, 2)}\n`);
  // pode conter chave de API
  chmodSync(caminho, 0o600);
}

/** Traduz o modelo pedido pelo mapa do provedor (id, família ou padrão). Sem pedido, usa o padrão do mapa. */
export function traduzirModelo(mapa: Record<string, string>, pedido: string | undefined, baseUrl?: string, outros: Record<string, string>[] = []): string | undefined {
  const sem = !pedido || pedido === "default";
  if (sem) return mapa.padrao;
  if (mapa[pedido]) return mapa[pedido];
  // Id real de OUTRO membro do pool: vira o equivalente (mesma vaga) neste membro, ou o padrão.
  if (!Object.values(mapa).includes(pedido)) {
    for (const o of outros) {
      const vaga = Object.keys(o).find((k) => o[k] === pedido);
      if (vaga) return mapa[vaga] ?? mapa.padrao ?? pedido;
    }
  }
  // Ids de outros harnesses (arquivados) não existem no provedor: usam o modelo padrão do provedor.
  if (/^(opencode|opencode-go|codex|crom-agente|crom|antigravity|cursor|copilot|aider)\//i.test(pedido)) return mapa.padrao;
  // "openrouter/<modelo>" é a forma do harness antigo; o endpoint do OpenRouter recebe só "<modelo>".
  // Fora do OpenRouter (ex.: opencode zen) esse id não existe: usa o modelo padrão do provedor.
  if (/^openrouter\//i.test(pedido) && baseUrl && !/openrouter/i.test(baseUrl)) return mapa.padrao ?? pedido;
  if (/^openrouter\//i.test(pedido)) return pedido.replace(/^openrouter\//i, "");
  const familia = familiaDe(pedido);
  return mapa[pedido] ?? (familia ? mapa[familia] : undefined) ?? pedido;
}

/** Id de um modelo → família ("claude-haiku-5-5" → "haiku"). */
function familiaDe(modelo: string): string | undefined {
  const m = modelo.toLowerCase();
  return FAMILIAS.find((f) => m.includes(f));
}

function chaveDe(id: string, p: ProvedorClaude, hostEnv: NodeJS.ProcessEnv): string {
  const chave = p.chave ?? (p.chaveEnv ? hostEnv[p.chaveEnv]?.trim() : undefined);
  if (chave) return chave;
  const onde = p.chaveEnv ? `defina a variável ${p.chaveEnv} no ambiente do daemon` : 'informe "chave" ou "chaveEnv"';
  throw new ProvedorError(`provedor "${id}" sem chave de API: ${onde} (arquivo: provedores.json).`);
}

/**
 * Decide o provedor ativo e devolve o que o SDK precisa: ambiente, pasta de configuração e tradutor de modelos.
 * Erros de configuração viram `ProvedorError` com a causa em português (a execução falha cedo e claro).
 */
export function resolverProvedorClaude(homeDir: string, hostEnv: NodeJS.ProcessEnv = process.env): ResolucaoProvedor {
  const config = lerConfigProvedores(homeDir);
  const id = hostEnv.OPENCORP_PROVEDOR?.trim() || config.ativo;
  const p = config.provedores[id];
  if (!p) {
    throw new ProvedorError(`provedor "${id}" não existe em provedores.json (disponíveis: ${Object.keys(config.provedores).join(", ")}).`);
  }
  if (p.tipo === "pool") return resolverMembroPool(homeDir, id, [], hostEnv);
  return resolverDireto(homeDir, id, p, hostEnv);
}

/** O provedor ativo traduz qualquer modelo (endpoint compatível ou pool)? Então o motor não restringe a claude-*. */
export function provedorAtivoTraduzModelos(homeDir: string, hostEnv: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const config = lerConfigProvedores(homeDir);
    const id = hostEnv.OPENCORP_PROVEDOR?.trim() || config.ativo;
    const tipo = config.provedores[id]?.tipo;
    return tipo === "compativel" || tipo === "pool";
  } catch {
    return false;
  }
}

/** Resolve um provedor que não é pool: ambiente, pasta de configuração e tradução de modelos. */
export function resolverDireto(homeDir: string, id: string, p: ProvedorClaude, hostEnv: NodeJS.ProcessEnv = process.env): ResolucaoProvedor {
  const env: Record<string, string> = {};
  let configDir: string | undefined;
  if (p.tipo === "assinatura") {
    const propria = p.configDir ? expandTilde(p.configDir, homeDir) : undefined;
    if (propria && !existsSync(join(propria, ".credentials.json"))) {
      throw new ProvedorError(`provedor "${id}": a pasta ${propria} não tem login do Claude Code (.credentials.json); faça /login nela.`);
    }
    configDir = propria ?? claudeConfigDirOpencorp();
  } else {
    // Pasta própria: não mistura sessões nem o login da assinatura com este provedor.
    configDir = join(homeDir, ".opencorp", `claude-provedor-${id}`);
    mkdirSync(configDir, { recursive: true });
    const chave = chaveDe(id, p, hostEnv);
    if (p.tipo === "api") {
      env.ANTHROPIC_API_KEY = chave;
    } else {
      if (!p.baseUrl) throw new ProvedorError(`provedor "${id}" (compativel) precisa de "baseUrl".`);
      env.ANTHROPIC_BASE_URL = p.baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = chave;
      env.ANTHROPIC_API_KEY = "";
    }
  }

  const mapa = p.modelos ?? {};
  for (const familia of FAMILIAS) {
    if (mapa[familia]) env[`ANTHROPIC_DEFAULT_${familia.toUpperCase()}_MODEL`] = mapa[familia];
  }
  // Tarefas auxiliares (títulos, resumos) usam o modelo "rápido": sem mapa, o provedor receberia um id que não conhece.
  const rapido = mapa.haiku ?? mapa.padrao;
  if (p.tipo === "compativel" && rapido) env.ANTHROPIC_SMALL_FAST_MODEL = rapido;

  return { id, tipo: p.tipo, env, configDir, modelo: (pedido) => traduzirModelo(mapa, pedido, env.ANTHROPIC_BASE_URL) };
}

/** Pasta de configuração do Claude Code em uso (para ler histórico de sessões do mesmo lugar onde elas são gravadas). */
export function configDirClaudeAtivo(homeDir: string, hostEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return resolverProvedorClaude(homeDir, hostEnv).configDir;
  } catch {
    return claudeConfigDirOpencorp();
  }
}

/** Pasta de configuração que um provedor `compativel`/`api` usa (CLAUDE_CONFIG_DIR próprio, sem misturar logins). */
export function configDirDeProvedor(homeDir: string, id: string): string {
  return join(homeDir, ".opencorp", `claude-provedor-${id}`);
}

function membrosValidos(config: ConfigProvedores, poolId: string): string[] {
  const pool = config.provedores[poolId];
  return (pool?.membros ?? []).filter((m) => {
    const p = config.provedores[m];
    return p !== undefined && (p.tipo === "compativel" || p.tipo === "api");
  });
}

/** Pastas que o pool pode usar (para o sandbox liberar escrita). */
export function configDirsDoPool(homeDir: string, poolId: string): string[] {
  const dirs = membrosPoolResolvidos(homeDir, poolId).map((m) => m.configDir).filter((d): d is string => !!d);
  for (const d of dirs) mkdirSync(d, { recursive: true });
  return dirs;
}

/** Id do pool ativo (ou de OPENCORP_PROVEDOR), se o provedor escolhido for um pool; senão undefined. Não consome o rodízio. */
export function poolAtivo(homeDir: string, hostEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = lerConfigProvedores(homeDir);
  const id = hostEnv.OPENCORP_PROVEDOR?.trim() || config.ativo;
  return config.provedores[id]?.tipo === "pool" ? id : undefined;
}

/** Membro de um pool já resolvido: o que o runner precisa para usar a conta, sem ler provedores.json lá dentro. */
export interface MembroPoolResolvido {
  id: string;
  env: Record<string, string>;
  configDir?: string;
  modelos: Record<string, string>;
  /** Mapas dos outros membros do pool: um id real de outra conta vira o equivalente deste membro. */
  outros?: Record<string, string>[];
}

/** Resolve todos os membros válidos do pool (não consome o rodízio). */
export function membrosPoolResolvidos(homeDir: string, poolId: string, hostEnv: NodeJS.ProcessEnv = process.env): MembroPoolResolvido[] {
  const config = lerConfigProvedores(homeDir);
  // Membro que não resolve (ex.: variável de chave ausente) fica de fora; os outros continuam no rodízio.
  const prontos: MembroPoolResolvido[] = [];
  for (const m of membrosValidos(config, poolId)) {
    try {
      const r = resolverDireto(homeDir, m, config.provedores[m]!, hostEnv);
      prontos.push({ id: m, env: r.env, configDir: r.configDir, modelos: config.provedores[m]!.modelos ?? {} });
    } catch {
      /* conta sem chave ou sem URL: não entra no rodízio até ser corrigida */
    }
  }
  return prontos.map((m) => ({ ...m, outros: prontos.filter((o) => o.id !== m.id).map((o) => o.modelos) }));
}

/**
 * Escolhe o próximo membro livre do pool e resolve esse membro (uso no processo principal, p.ex. Secretário).
 * O runner de agentes faz o mesmo a cada tentativa, com retry: ver runners/claude-sdk-cli.ts.
 */
export function resolverMembroPool(
  homeDir: string,
  poolId: string,
  excluir: string[] = [],
  hostEnv: NodeJS.ProcessEnv = process.env,
): ResolucaoProvedor {
  if (lerConfigProvedores(homeDir).provedores[poolId]?.tipo !== "pool") throw new ProvedorError(`"${poolId}" não é um pool de provedores.`);
  const membros = membrosPoolResolvidos(homeDir, poolId, hostEnv);
  if (membros.length === 0) throw new ProvedorError(`pool "${poolId}" não tem membros válidos (compativel ou api) em provedores.json.`);

  const agora = new Date();
  const estado = lerEstadoRotacao(homeDir);
  limparBloqueiosVencidos(estado, agora);
  const { id, bloqueados } = escolherMembro(
    membros.map((m) => m.id),
    estado,
    agora,
    excluir,
  );
  gravarEstadoRotacao(homeDir, estado);
  if (!id) {
    const motivos = bloqueados.map((b) => `${b.id} (${b.motivo}, volta ${b.ate})`).join("; ");
    throw new ProvedorError(`pool "${poolId}" sem membro disponível: ${motivos || "todos os membros já falharam nesta chamada"}.`);
  }
  const m = membros.find((x) => x.id === id)!;
  return {
    id: poolId,
    tipo: "compativel",
    env: m.env,
    configDir: m.configDir,
    modelo: (pedido) => traduzirModelo(m.modelos, pedido, m.env.ANTHROPIC_BASE_URL, m.outros),
    membro: id,
  };
}

/** Provedores predefinidos: `opencorp provedor conta <predefinido> <id> --chave ...` cria uma conta com URL e modelos prontos. */
export interface PredefinidoProvedor {
  nome: string;
  baseUrl: string;
  /** Onde pegar a chave (ou a conta) do provedor. */
  onde: string;
  modelos: Record<string, string>;
}

export const PREDEFINIDOS: Record<string, PredefinidoProvedor> = {
  "openrouter-free": {
    nome: "OpenRouter (grátis, 1000 chamadas/dia por chave)",
    baseUrl: "https://openrouter.ai/api",
    onde: "https://openrouter.ai/keys",
    modelos: {
      padrao: "nvidia/nemotron-3.5-super-vl:free",
      haiku: "nvidia/nemotron-3.5-super-vl:free",
      sonnet: "nvidia/nemotron-3.5-super-vl:free",
      opus: "nvidia/nemotron-3-ultra-550b-a55b:free",
    },
  },
  "opencode-zen-free": {
    nome: "opencode zen (modelos grátis, cota própria)",
    baseUrl: "https://opencode.ai/zen",
    onde: "https://opencode.ai/auth (chave; sem chave o endpoint responde com a cota anônima)",
    modelos: {
      padrao: "deepseek-v4.1-flash-free",
      haiku: "deepseek-v4.1-flash-free",
      sonnet: "glm-5.3-flash-free",
      opus: "nemotron-3.5-super-vl-free",
    },
  },
};
