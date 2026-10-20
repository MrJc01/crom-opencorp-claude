import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Agente } from "../../../schemas/agent.js";

export class ModelResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolverError";
  }
}

export interface ModeloParsed {
  providerID: string;
  modelID: string;
  modeloCompleto: string;
}

/**
 * Normaliza e parseia um identificador de modelo preservando SEMPRE o prefixo do provedor/motor.
 * Ex: "opencode/nemotron-3-ultra-free" -> { providerID: "opencode", modelID: "nemotron-3-ultra-free", modeloCompleto: "opencode/nemotron-3-ultra-free" }
 * Ex: "openrouter/liquid/lfm-2.5-2.6b:free" -> { providerID: "openrouter", modelID: "liquid/lfm-2.5-2.6b:free", ... }
 */
export function parsearModelo(modelo: string): ModeloParsed {
  const limpo = (modelo ?? "").trim();
  if (!limpo) {
    return { providerID: "", modelID: "", modeloCompleto: "" };
  }

  const primeiraBarra = limpo.indexOf("/");
  if (primeiraBarra === -1) {
    return { providerID: "", modelID: limpo, modeloCompleto: limpo };
  }

  const providerID = limpo.slice(0, primeiraBarra);
  const modelID = limpo.slice(primeiraBarra + 1);

  return {
    providerID,
    modelID,
    modeloCompleto: limpo,
  };
}

/**
 * Preserva o identificador canônico informado pelo catálogo atual.
 *
 * O OpenCode resolve provider/model diretamente. Reescrever modelos OpenRouter
 * válidos para aliases de outro provedor pode trocar uma rota saudável por uma
 * conta sem cota ou por um ID removido do catálogo.
 */
export function normalizarModelo(modelo: string): string {
  const m = (modelo ?? "").trim();
  return m;
}

/** Prefixos de modelo roteados por assinatura/cota do próprio motor (custo marginal zero). */
export const PREFIXOS_MODELO_SEM_CUSTO: readonly string[] = ["opencode-go/", "codex/", "antigravity/", "claude-code/"];

/** Famílias de modelo conhecidas com capacidade comprovada em tool-calling (metadados, não regra de motor). */
export const FAMILIAS_MODELO_CONHECIDAS: readonly string[] = [
  "nemotron", "gemini", "claude", "deepseek", "glm-", "qwen", "gemma",
  "mimo", "minimax", "ling-", "muse-", "big-pickle", "space-bunny",
  "north-mini-code", "inkling", "nex-n",
];

/**
 * Identifica se um modelo é de uso gratuito ou cota zero.
 */
export function ehModeloGratuito(modelo: string): boolean {
  const m = (modelo ?? "").trim().toLowerCase();
  if (!m) return false;
  if (m.endsWith(":free")) return true;
  if (PREFIXOS_MODELO_SEM_CUSTO.some((p) => m.startsWith(p))) return true;
  if (m.includes("free")) return true;
  return false;
}

/** Estimativa de parâmetros (B) por trecho do nome, na ordem de precedência. Dados, não regra de motor. */
export const PARAMETROS_ESTIMADOS_B: ReadonlyArray<readonly [string, number]> = [
  ["nemotron-3-ultra", 550],
  ["nemotron-3.5-lightning", 120],
  ["gemini-2.5-pro", 150],
  ["gemini", 70],
  ["glm-5.3", 30],
  ["minimax-m3", 230],
  ["claude-3", 200],
  ["deepseek-r1", 671],
];

/** Trechos de nome de modelos flagship (tier S) independentemente do tamanho declarado. */
export const TRECHOS_MODELO_TIER_S: readonly string[] = [
  "gemini-2.5", "gemini-3.8", "claude-3", "nemotron-3-ultra", "deepseek-r1",
];

/**
 * Extrai a contagem estimada de parâmetros em bilhões (xB).
 */
export function extrairParametrosB(modelo: string): number | null {
  const m = (modelo ?? "").trim().toLowerCase();
  if (!m) return null;
  const match = m.match(/(?:^|[^a-z0-9])(\d+(?:\.\d+)?)\s*b(?:[^a-z0-9]|$)/i);
  if (match && match[1]) {
    return parseFloat(match[1]);
  }
  for (const [trecho, b] of PARAMETROS_ESTIMADOS_B) if (m.includes(trecho)) return b;
  return null;
}

export interface QualidadeModelo {
  modelo: string;
  parametrosB: number | null;
  gratuito: boolean;
  tier: "S" | "A" | "B" | "NAO_RECOMENDADO";
  recomendado: boolean;
  categoria: "mini" | "medio" | "grande" | "inadequado";
  motivo: string;
}

/**
 * Classifica a qualidade e recomendações operacionais do modelo.
 */
export function classificarQualidadeModelo(modelo: string): QualidadeModelo {
  const m = (modelo ?? "").trim().toLowerCase();
  const parametrosB = extrairParametrosB(modelo);
  const gratuito = ehModeloGratuito(modelo);

  // Blacklist de modelos não recomendados para agentes com ferramentas
  if (
    m === "openrouter/openrouter/free" ||
    (parametrosB !== null && parametrosB < 4) ||
    m.includes("liquid/lfm-2.5-2.6b") ||
    m.includes("llama-3.2-1b") ||
    m.includes("llama-3.2-3b")
  ) {
    return {
      modelo,
      parametrosB: parametrosB ?? 2.6,
      gratuito,
      tier: "NAO_RECOMENDADO",
      recomendado: false,
      categoria: "inadequado",
      motivo: "Modelo muito pequeno (<4B) ou roteador cego. Falha em tool-calling e raciocínio multi-step.",
    };
  }

  const familiaConhecida = FAMILIAS_MODELO_CONHECIDAS.some((familia) => m.includes(familia));
  if (parametrosB === null && !familiaConhecida) {
    return {
      modelo,
      parametrosB: null,
      gratuito,
      tier: "NAO_RECOMENDADO",
      recomendado: false,
      categoria: "inadequado",
      motivo: "Modelo sem metadados de capacidade conhecidos; valide tool-calling antes de usá-lo em agentes.",
    };
  }

  // Tier S: Flagships e Raciocínio Profundo (>70B)
  if (
    TRECHOS_MODELO_TIER_S.some((t) => m.includes(t)) ||
    (parametrosB !== null && parametrosB >= 70)
  ) {
    return {
      modelo,
      parametrosB: parametrosB ?? 70,
      gratuito,
      tier: "S",
      recomendado: true,
      categoria: "grande",
      motivo: "Raciocínio profundo e tool-calling confiável. Ideal para Secretário e orquestração.",
    };
  }

  // Tier A: Especialistas e Redatores (14B a <70B)
  if (
    m.includes("glm-5.3") ||
    m.includes("qwen") ||
    m.includes("gemma-2-27b") ||
    (parametrosB !== null && parametrosB >= 14 && parametrosB < 70)
  ) {
    return {
      modelo,
      parametrosB: parametrosB ?? 27,
      gratuito,
      tier: "A",
      recomendado: true,
      categoria: "medio",
      motivo: "Excelente equilíbrio entre velocidade e redação estruturada.",
    };
  }

  // Tier B: Mini-agentes rápidos (7B a 14B)
  return {
    modelo,
    parametrosB: parametrosB ?? 8,
    gratuito,
    tier: "B",
    recomendado: true,
    categoria: "mini",
    motivo: "Ultrarrápido para tarefas pontuais (dedup, validação de JSON, sanitização).",
  };
}

export function filtrarModelosQualificados(
  modelos: string[],
  filtros: {
    apenasGratuitos?: boolean;
    minB?: number;
    maxB?: number;
    apenasRecomendados?: boolean;
  } = {},
): QualidadeModelo[] {
  const { apenasGratuitos = false, minB, maxB, apenasRecomendados = false } = filtros;

  return modelos
    .map((m) => classificarQualidadeModelo(m))
    .filter((q) => {
      if (apenasGratuitos && !q.gratuito) return false;
      if (apenasRecomendados && !q.recomendado) return false;
      if (minB !== undefined && (q.parametrosB === null || q.parametrosB < minB)) return false;
      if (maxB !== undefined && (q.parametrosB === null || q.parametrosB > maxB)) return false;
      return true;
    });
}

export interface OpcoesResolucaoModelos {
  agente?: Partial<Agente> & {
    model?: string;
    modelo?: string;
    rotation?: string[];
    model_fallback?: string[];
    workspace_rotation_fallback?: boolean;
    rotacao_global?: boolean;
    id?: string;
  };
  wsPath: string;
  wsId?: string;
  modeloSolicitado?: string;
}

export interface ResultadoCadeiaModelos {
  cadeia: string[];
  modeloPrimario: string;
  camada1Agente: string[];
  camada2Workspace: string[];
  herdarWorkspace: boolean;
}

/**
 * Lê exclusivamente o .opencorp/config.json ou .opencorp/settings.json do workspace informado.
 * REGRA DE OURO 1: NUNCA recorre ao global (~/.opencorp/settings.json) em tempo de execução.
 */
export function carregarConfigWorkspaceSozinho(wsPath: string): {
  modelos?: { padrao?: string; rotacao?: string[] };
  tests?: { rotation?: string[] };
  default_model?: string;
} | null {
  try {
    const configPath = join(wsPath, ".opencorp", "config.json");
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed.modelos || parsed.default_model || parsed.tests?.rotation) return parsed;
    }
    const settingsPath = join(wsPath, ".opencorp", "settings.json");
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, "utf8");
      return JSON.parse(raw);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a cadeia ordenada de modelos segundo a hierarquia das 4 camadas (Camadas 1 e 2):
 * - Camada 1: modeloSolicitado -> ag.model -> ag.rotation
 * - Camada 2: se workspace_rotation_fallback !== false -> workspace.modelos.rotacao
 * Se o workspace não tiver modelos configurados e for requerido o fallback, emite erro explícito.
 */
export function resolverCadeiaModelosAgente(opts: OpcoesResolucaoModelos): ResultadoCadeiaModelos {
  const { agente, wsPath, wsId, modeloSolicitado } = opts;

  const camada1: string[] = [];

  if (modeloSolicitado && modeloSolicitado.trim()) {
    camada1.push(modeloSolicitado.trim());
  }

  const modeloAgente = (agente?.model || agente?.modelo)?.trim();
  if (modeloAgente) {
    camada1.push(modeloAgente);
  }

  const rotAgente = agente?.rotation || agente?.model_fallback;
  if (Array.isArray(rotAgente)) {
    for (const m of rotAgente) {
      if (typeof m === "string" && m.trim()) {
        camada1.push(m.trim());
      }
    }
  }

  const herdarWorkspace =
    agente?.workspace_rotation_fallback !== undefined
      ? Boolean(agente.workspace_rotation_fallback)
      : agente?.rotacao_global !== undefined
        ? Boolean(agente.rotacao_global)
        : true;

  const camada2: string[] = [];

  if (herdarWorkspace && wsPath) {
    const wsCfg = carregarConfigWorkspaceSozinho(wsPath);
    const rotWs = wsCfg?.modelos?.rotacao || wsCfg?.tests?.rotation;
    const padraoWs = wsCfg?.modelos?.padrao || wsCfg?.default_model;

    if (padraoWs && typeof padraoWs === "string" && padraoWs.trim()) {
      camada2.push(padraoWs.trim());
    }
    if (Array.isArray(rotWs) && rotWs.length > 0) {
      for (const m of rotWs) {
        if (typeof m === "string" && m.trim()) {
          camada2.push(m.trim());
        }
      }
    }

    if (camada2.length === 0) {
      // O workspace não possui modelos configurados.
      // Se a Camada 1 for vazia, FALHA EXPLÍCITA obrigatória (Zero Fallback Global)
      if (camada1.length === 0) {
        const idWs = wsId || wsPath;
        throw new ModelResolverError(
          `Workspace "${idWs}" não possui lista 'modelos.rotacao' configurada em .opencorp/config.json (ou settings.json).`,
        );
      }
    }
  }

  const cadeiaUnica = [...new Set([...camada1, ...camada2])];
  if (cadeiaUnica.length === 0) {
    const idWs = wsId || wsPath;
    throw new ModelResolverError(
      `Nenhum modelo configurado para o agente "${agente?.id || 'desconhecido'}" e workspace "${idWs}" não possui modelos.rotacao.`,
    );
  }

  return {
    cadeia: cadeiaUnica,
    modeloPrimario: cadeiaUnica[0]!,
    camada1Agente: [...new Set(camada1)],
    camada2Workspace: [...new Set(camada2)],
    herdarWorkspace,
  };
}

/**
 * Determina o próximo modelo da cadeia a ser executado, evitando repetições
 * e permitindo filtragem de modelos gratuitos caso haja falha de créditos.
 */
export function proximoModeloDaCadeia(opts: {
  cadeia: string[];
  modeloAtual?: string;
  modelosJaTentados?: string[];
  apenasGratuitos?: boolean;
}): string | null {
  const { cadeia, modeloAtual, modelosJaTentados = [], apenasGratuitos = false } = opts;
  const tentados = new Set(modelosJaTentados.map((m) => m.trim().toLowerCase()));
  if (modeloAtual) {
    tentados.add(modeloAtual.trim().toLowerCase());
  }

  for (const modelo of cadeia) {
    const mTrim = modelo.trim();
    const mKey = mTrim.toLowerCase();
    if (tentados.has(mKey)) continue;

    if (apenasGratuitos && !ehModeloGratuito(mTrim)) {
      continue;
    }

    return mTrim;
  }

  return null;
}
