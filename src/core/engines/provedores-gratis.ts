import { gravarConfigProvedores, lerConfigProvedores, ProvedorError, type ProvedorClaude } from "./provedor-claude.js";

/**
 * Provedores e pools GRÁTIS do motor claude-sdk, geridos pela tela de Configurações.
 * Só entram provedores `compativel` (endpoint que fala o protocolo da Anthropic: OpenRouter, opencode zen...) e
 * modelos grátis (id terminando em `:free` ou `-free`). Nenhuma conta ou modelo da Anthropic passa por aqui.
 * A chave nunca sai desta API: a listagem só diz se ela está definida.
 */

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ProvedorGratisEntrada {
  id: string;
  nome: string;
  baseUrl: string;
  modelos: { padrao: string; haiku?: string; sonnet?: string; opus?: string };
  /** Chave digitada. Vazia numa edição mantém a chave já gravada. */
  chave?: string;
  /** Nome da variável de ambiente que guarda a chave (alternativa à chave gravada). */
  chaveEnv?: string;
}

export interface ProvedorGratisPublico {
  id: string;
  nome: string;
  baseUrl: string;
  modelos: Record<string, string>;
  chaveDefinida: boolean;
  chaveEnv?: string;
}

export interface PoolGratisPublico {
  id: string;
  nome: string;
  membros: string[];
}

/** Modelo é grátis quando o id termina em `:free` ou `-free` (convenção do OpenRouter e do opencode zen). */
export function modeloEGratis(modelo: string): boolean {
  return /(:free|-free)$/i.test(modelo.trim());
}

function urlValida(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1"));
  } catch {
    return false;
  }
}

export function listarGratis(homeDir: string): { ativo: string; provedores: ProvedorGratisPublico[]; pools: PoolGratisPublico[] } {
  const config = lerConfigProvedores(homeDir);
  const provedores: ProvedorGratisPublico[] = [];
  const pools: PoolGratisPublico[] = [];
  for (const [id, p] of Object.entries(config.provedores)) {
    if (p.tipo === "compativel") {
      provedores.push({
        id,
        nome: p.nome ?? id,
        baseUrl: p.baseUrl ?? "",
        modelos: { ...(p.modelos ?? {}) },
        chaveDefinida: !!p.chave || !!(p.chaveEnv && process.env[p.chaveEnv]),
        ...(p.chaveEnv ? { chaveEnv: p.chaveEnv } : {}),
      });
    } else if (p.tipo === "pool") {
      pools.push({ id, nome: p.nome ?? id, membros: [...(p.membros ?? [])] });
    }
  }
  return { ativo: config.ativo, provedores, pools };
}

export async function salvarProvedorGratis(homeDir: string, e: ProvedorGratisEntrada): Promise<void> {
  if (typeof e.id !== "string" || !ID_RE.test(e.id)) throw new ProvedorError("id em kebab-case (ex.: openrouter-conta2)");
  if (!e.nome?.trim()) throw new ProvedorError("informe o nome do provedor");
  if (!urlValida(e.baseUrl ?? "")) throw new ProvedorError("URL inválida: use https:// (ou http://localhost para teste local)");
  const modelos = { ...e.modelos };
  if (!modelos.padrao?.trim()) throw new ProvedorError("informe o modelo padrão");
  for (const [familia, modelo] of Object.entries(modelos)) {
    if (!modelo) continue;
    if (!modeloEGratis(modelo)) {
      throw new ProvedorError(`o modelo "${modelo}" (${familia}) não é grátis: o id precisa terminar em :free ou -free`);
    }
  }
  const config = lerConfigProvedores(homeDir);
  const anterior = config.provedores[e.id];
  if (anterior && anterior.tipo !== "compativel") {
    throw new ProvedorError(`"${e.id}" já existe e não é um provedor grátis editável por esta tela`);
  }
  const chaveGravada = e.chave?.trim() || anterior?.chave;
  const chaveEnv = e.chaveEnv?.trim() || undefined;
  if (!chaveGravada && !chaveEnv) throw new ProvedorError("informe a chave do provedor ou o nome da variável de ambiente que a guarda");
  const novo: ProvedorClaude = {
    tipo: "compativel",
    nome: e.nome.trim(),
    baseUrl: e.baseUrl.trim(),
    modelos,
    ...(chaveGravada ? { chave: chaveGravada } : {}),
    ...(chaveEnv ? { chaveEnv } : {}),
  };
  await gravarConfigProvedores(homeDir, { ...config, provedores: { ...config.provedores, [e.id]: novo } });
}

export async function salvarPoolGratis(homeDir: string, pool: { id: string; nome: string; membros: string[] }): Promise<void> {
  if (typeof pool.id !== "string" || !ID_RE.test(pool.id)) throw new ProvedorError("id do pool em kebab-case");
  if (!Array.isArray(pool.membros) || pool.membros.length === 0) throw new ProvedorError("o pool precisa de pelo menos um provedor grátis");
  const config = lerConfigProvedores(homeDir);
  for (const m of pool.membros) {
    if (config.provedores[m]?.tipo !== "compativel") throw new ProvedorError(`"${m}" não é um provedor grátis cadastrado`);
  }
  const anterior = config.provedores[pool.id];
  if (anterior && anterior.tipo !== "pool") throw new ProvedorError(`"${pool.id}" já existe e não é um pool`);
  await gravarConfigProvedores(homeDir, {
    ...config,
    provedores: { ...config.provedores, [pool.id]: { tipo: "pool", nome: pool.nome.trim() || pool.id, membros: [...pool.membros] } },
  });
}

export async function removerProvedorGratis(homeDir: string, id: string): Promise<void> {
  const config = lerConfigProvedores(homeDir);
  if (config.provedores[id]?.tipo !== "compativel") throw new ProvedorError(`"${id}" não é um provedor grátis`);
  if (config.ativo === id) throw new ProvedorError(`"${id}" é o provedor ativo; escolha outro antes de remover`);
  const provedores: Record<string, ProvedorClaude> = { ...config.provedores };
  delete provedores[id];
  for (const [pid, p] of Object.entries(provedores)) {
    if (p.tipo === "pool" && p.membros?.includes(id)) provedores[pid] = { ...p, membros: p.membros.filter((m) => m !== id) };
  }
  await gravarConfigProvedores(homeDir, { ...config, provedores });
}

export async function removerPoolGratis(homeDir: string, id: string): Promise<void> {
  const config = lerConfigProvedores(homeDir);
  if (config.provedores[id]?.tipo !== "pool") throw new ProvedorError(`"${id}" não é um pool grátis`);
  if (config.ativo === id) throw new ProvedorError(`"${id}" é o provedor ativo; escolha outro antes de remover`);
  const provedores: Record<string, ProvedorClaude> = { ...config.provedores };
  delete provedores[id];
  await gravarConfigProvedores(homeDir, { ...config, provedores });
}

/** Define o provedor ativo do motor claude-sdk. Só aceita provedor grátis ou pool grátis. */
export async function definirAtivoGratis(homeDir: string, id: string): Promise<void> {
  const config = lerConfigProvedores(homeDir);
  const tipo = config.provedores[id]?.tipo;
  if (tipo !== "compativel" && tipo !== "pool") throw new ProvedorError(`"${id}" não é um provedor ou pool grátis`);
  await gravarConfigProvedores(homeDir, { ...config, ativo: id });
}
