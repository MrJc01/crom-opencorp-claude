/**
 * Catálogo soberano de modelos (Etapa 13).
 *
 * O OpenCorp agrega modelos de várias origens sem que nenhuma delas (inclusive
 * o OpenCode) seja dona do catálogo. Cada entrada guarda:
 *   - proveniência (todas as origens que a listaram, sem apagar nenhuma);
 *   - motores compatíveis, derivados só de evidência (a origem que listou o
 *     modelo para aquele motor, ou um prefixo explícito de motor), nunca de
 *     inferência por provedor (`openrouter/*` não implica OpenCode);
 *   - disponibilidade catalogada separada do probe aprovado;
 *   - governança (tier, recomendação, bloqueio para agentes autônomos).
 */
import { engineRegistry } from "../engines/registry.js";
import { classificarQualidadeModelo, ehModeloGratuito, extrairParametrosB } from "../contexts/agents/model-resolver.js";

export type CatalogSourceKind = "live" | "engine-hint" | "curated" | "settings";

export interface CatalogProvenance {
  sourceId: string;
  kind: CatalogSourceKind;
  /** Motor em nome do qual a origem listou o modelo, quando houver. */
  engineId?: string;
  observedAt: string;
}

export interface CatalogProbe {
  engineId: string;
  status: "passed" | "failed";
  at: string;
  level?: string;
}

export interface CatalogGovernance {
  tier: "S" | "A" | "B" | "NAO_RECOMENDADO";
  recommended: boolean;
  /** Pode entrar em rotação/fallback de agentes autônomos. */
  allowedAutonomous: boolean;
  reason: string;
}

export interface CatalogModel {
  /** Identificador completo usado na execução (ex.: `openrouter/nvidia/x:free`). */
  modelId: string;
  providerId: string;
  accountId?: string;
  compatibleEngineIds: string[];
  parametersB: number | null;
  contextWindow?: number;
  free: boolean;
  sources: CatalogProvenance[];
  /** Presente em alguma origem (não significa que funciona). */
  catalogedAt: string;
  /** Resultados de probe real por motor; ausente = nunca verificado. */
  probes: CatalogProbe[];
  governance: CatalogGovernance;
}

export interface RawCatalogEntry {
  modelId: string;
  sourceId: string;
  kind: CatalogSourceKind;
  engineId?: string;
  contextWindow?: number;
  accountId?: string;
}

export interface CatalogSource {
  readonly id: string;
  list(): Promise<RawCatalogEntry[]>;
}

/**
 * Prefixos que nomeiam um motor (ou um provedor exclusivo de um motor, como os
 * namespaces `opencode/` e `opencode-go/` do OpenCode). Provedores genéricos
 * — `openrouter/`, `anthropic/`, `mimo/`, `xiaomi/` — não implicam motor.
 */
export const ENGINE_MODEL_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  opencode: "opencode",
  "opencode-go": "opencode",
  "claude-code": "claude-code",
  claude: "claude-code",
  "claude-sdk": "claude-sdk",
  antigravity: "antigravity",
  "crom-agente": "crom-agente",
  crom: "crom-agente",
  cursor: "cursor",
  copilot: "copilot",
  codex: "codex",
  aider: "aider",
});

/** Prefixos que são só roteamento de motor e saem do ID antes da execução. */
const STRIPPED_ENGINE_PREFIXES = new Set(["claude-code", "claude", "claude-sdk", "antigravity", "crom-agente", "crom", "cursor", "copilot", "codex", "aider"]);

/** Motor explicitamente nomeado no prefixo do modelo (ex.: `codex/…`), ou `undefined`. */
export function explicitEngineOfModel(modelId: string): string | undefined {
  const i = modelId.indexOf("/");
  if (i <= 0) return undefined;
  return ENGINE_MODEL_PREFIXES[modelId.slice(0, i).trim().toLowerCase()];
}

/** ID do modelo como o motor o recebe (sem o prefixo de roteamento de motor). */
export function modelIdForEngine(modelId: string): string {
  const i = modelId.indexOf("/");
  if (i <= 0) return modelId;
  return STRIPPED_ENGINE_PREFIXES.has(modelId.slice(0, i).trim().toLowerCase()) ? modelId.slice(i + 1) : modelId;
}

export function providerOfModel(modelId: string): string {
  const i = modelId.indexOf("/");
  return i > 0 ? modelId.slice(0, i).toLowerCase() : "desconhecido";
}

export function governanceOf(modelId: string): CatalogGovernance {
  const q = classificarQualidadeModelo(modelId);
  return {
    tier: q.tier,
    recommended: q.recomendado,
    allowedAutonomous: q.tier !== "NAO_RECOMENDADO",
    reason: q.motivo,
  };
}

/**
 * Agrega entradas brutas deduplicando por `modelId` (e conta, quando houver),
 * preservando todas as origens e unindo os motores compatíveis.
 */
export function aggregateCatalog(entries: RawCatalogEntry[], probes: Array<CatalogProbe & { modelId: string }> = [], now = new Date()): CatalogModel[] {
  const byKey = new Map<string, CatalogModel>();
  const at = now.toISOString();
  for (const raw of entries) {
    const modelId = raw.modelId.trim();
    if (!modelId) continue;
    const key = raw.accountId ? `${modelId}#${raw.accountId}` : modelId;
    let model = byKey.get(key);
    if (!model) {
      model = {
        modelId,
        providerId: providerOfModel(modelId),
        ...(raw.accountId ? { accountId: raw.accountId } : {}),
        compatibleEngineIds: [],
        parametersB: extrairParametrosB(modelId),
        free: ehModeloGratuito(modelId),
        sources: [],
        catalogedAt: at,
        probes: [],
        governance: governanceOf(modelId),
      };
      byKey.set(key, model);
    }
    if (raw.contextWindow && !model.contextWindow) model.contextWindow = raw.contextWindow;
    if (!model.sources.some((s) => s.sourceId === raw.sourceId && s.engineId === raw.engineId)) {
      model.sources.push({ sourceId: raw.sourceId, kind: raw.kind, ...(raw.engineId ? { engineId: raw.engineId } : {}), observedAt: at });
    }
    const engines = new Set(model.compatibleEngineIds);
    if (raw.engineId) engines.add(raw.engineId);
    const explicit = explicitEngineOfModel(modelId);
    if (explicit) engines.add(explicit);
    model.compatibleEngineIds = [...engines].sort();
  }
  for (const probe of probes) {
    for (const model of byKey.values()) {
      if (probe.modelId === model.modelId) model.probes.push({ engineId: probe.engineId, status: probe.status, at: probe.at, ...(probe.level ? { level: probe.level } : {}) });
    }
  }
  return [...byKey.values()].sort((a, b) =>
    Number(b.governance.recommended) - Number(a.governance.recommended) ||
    Number(b.free) - Number(a.free) ||
    a.modelId.localeCompare(b.modelId)
  );
}

export async function collectCatalog(sources: CatalogSource[], probes: Array<CatalogProbe & { modelId: string }> = []): Promise<{ models: CatalogModel[]; errors: Array<{ sourceId: string; message: string }> }> {
  const entries: RawCatalogEntry[] = [];
  const errors: Array<{ sourceId: string; message: string }> = [];
  const results = await Promise.allSettled(sources.map((s) => s.list()));
  results.forEach((r, i) => {
    if (r.status === "fulfilled") entries.push(...r.value);
    else errors.push({ sourceId: sources[i]!.id, message: r.reason instanceof Error ? r.reason.message : String(r.reason) });
  });
  return { models: aggregateCatalog(entries, probes), errors };
}

/** Prefixos de modelo que o motor declara executar (`EngineDriver.modelPrefixes`); `undefined` = qualquer modelo. */
function modelPrefixesDoMotor(engineId: string): string[] | undefined {
  try {
    return engineRegistry.resolveDriver(engineId).modelPrefixes;
  } catch {
    return undefined;
  }
}

export type CompatibilityVerdict =
  | { compatible: true; basis: "catalog" | "unknown-model" }
  | { compatible: false; reason: string };

/**
 * Compatibilidade motor-modelo para o preflight. Bloqueia apenas com
 * evidência: prefixo que nomeia outro motor, ou modelo catalogado cujas
 * origens não incluem o motor. Modelos fora do catálogo passam (o catálogo não
 * é exaustivo), sem inferir motor pelo provedor.
 */
export function checkModelEngineCompatibility(engineId: string, modelId: string, catalog: CatalogModel[] = []): CompatibilityVerdict {
  const explicit = explicitEngineOfModel(modelId);
  // Motor que declara `modelPrefixes` (EngineDriver) só executa esses modelos: sem prefixo de motor, outro provedor não serve.
  const prefixos = modelPrefixesDoMotor(engineId);
  if (prefixos && explicit !== engineId) {
    const semMotor = modelId.replace(new RegExp(`^${engineId}/`), "");
    if (!prefixos.some((p) => semMotor.startsWith(p))) {
      return { compatible: false, reason: `o motor "${engineId}" só executa modelos ${prefixos.map((p) => `${p}*`).join(", ")}, não "${modelId}"` };
    }
  }
  if (explicit && explicit !== engineId) {
    return { compatible: false, reason: `o modelo "${modelId}" pertence ao motor "${explicit}", não a "${engineId}"` };
  }
  const known = catalog.filter((m) => m.modelId === modelId);
  if (known.length === 0) return { compatible: true, basis: "unknown-model" };
  if (known.some((m) => m.compatibleEngineIds.includes(engineId))) return { compatible: true, basis: "catalog" };
  const engines = [...new Set(known.flatMap((m) => m.compatibleEngineIds))];
  return { compatible: false, reason: `o catálogo só registra "${modelId}" para ${engines.length ? engines.join(", ") : "nenhum motor"}` };
}

/** Pesquisa simples por texto, provedor, motor e filtros de governança. */
export function searchCatalog(
  models: CatalogModel[],
  query: { text?: string; engineId?: string; providerId?: string; onlyFree?: boolean; onlyAutonomous?: boolean; onlyProbed?: boolean } = {}
): CatalogModel[] {
  const text = query.text?.trim().toLowerCase();
  return models.filter((m) =>
    (!text || m.modelId.toLowerCase().includes(text)) &&
    (!query.engineId || m.compatibleEngineIds.includes(query.engineId)) &&
    (!query.providerId || m.providerId === query.providerId) &&
    (!query.onlyFree || m.free) &&
    (!query.onlyAutonomous || m.governance.allowedAutonomous) &&
    (!query.onlyProbed || m.probes.some((p) => p.status === "passed" && (!query.engineId || p.engineId === query.engineId)))
  );
}
