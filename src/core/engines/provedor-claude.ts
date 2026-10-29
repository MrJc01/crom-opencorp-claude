import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../utils/fs-safe.js";
import { expandTilde } from "../../utils/paths.js";
import { claudeConfigDirOpencorp } from "./drivers/claude-config-dir.js";

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
export type TipoProvedor = "assinatura" | "api" | "compativel";

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
  if (p.tipo !== "assinatura" && p.tipo !== "api" && p.tipo !== "compativel") return undefined;
  const texto = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const modelos: Record<string, string> = {};
  if (p.modelos && typeof p.modelos === "object") {
    for (const [k, v] of Object.entries(p.modelos as Record<string, unknown>)) if (texto(v)) modelos[k] = texto(v) as string;
  }
  return {
    tipo: p.tipo,
    ...(texto(p.nome) ? { nome: texto(p.nome) } : {}),
    ...(texto(p.configDir) ? { configDir: texto(p.configDir) } : {}),
    ...(texto(p.baseUrl) ? { baseUrl: texto(p.baseUrl) } : {}),
    ...(texto(p.chave) ? { chave: texto(p.chave) } : {}),
    ...(texto(p.chaveEnv) ? { chaveEnv: texto(p.chaveEnv) } : {}),
    ...(Object.keys(modelos).length ? { modelos } : {}),
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

  const modelo = (pedido: string | undefined): string | undefined => {
    const sem = !pedido || pedido === "default";
    if (sem) return mapa.padrao;
    const familia = familiaDe(pedido);
    return mapa[pedido] ?? (familia ? mapa[familia] : undefined) ?? pedido;
  };

  return { id, tipo: p.tipo, env, configDir, modelo };
}

/** Pasta de configuração do Claude Code em uso (para ler histórico de sessões do mesmo lugar onde elas são gravadas). */
export function configDirClaudeAtivo(homeDir: string, hostEnv: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return resolverProvedorClaude(homeDir, hostEnv).configDir;
  } catch {
    return claudeConfigDirOpencorp();
  }
}
