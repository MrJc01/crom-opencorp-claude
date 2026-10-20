/**
 * Catálogo de provedores de inferência direta (chave de API ou local).
 * Dados, não regra de motor: o llm-client e a UI de "Chaves de API" leem daqui.
 * A variável de ambiente de cada provedor vem de `PROVIDER_ENV_VARS` (credentials-store).
 */
import { PROVIDER_ENV_VARS } from "../credentials/credentials-store.js";

export interface ProviderDefinition {
  id: string;
  nome: string;
  tipo: "api_key" | "local" | "oauth";
  descricao: string;
  modelosSugeridos: string[];
  /** Chaves legadas em `~/.opencorp/secrets.json` (ordem de preferência). */
  secretKeys?: string[];
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = Object.freeze([
  {
    id: "openrouter",
    nome: "OpenRouter (Universal & BYOK)",
    tipo: "api_key",
    descricao: "Roteador universal com suporte a BYOK Google AI Studio (custo $0), NVIDIA e centenas de modelos.",
    modelosSugeridos: [
      "google/gemini-3.8-flash",
      "nvidia/nemotron-3.5-lightning:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "minimax/minimax-m3:free",
      "anthropic/claude-3.5-haiku",
    ],
    secretKeys: ["openrouter_api_key", "openrouter"],
  },
  {
    id: "opencode-go",
    nome: "OpenCode-Go Native",
    tipo: "api_key",
    descricao: "Backend oficial de inferência rápida do OpenCode.",
    modelosSugeridos: ["glm-5.3-flash", "deepseek-v3"],
  },
  {
    id: "anthropic",
    nome: "Anthropic API Direta",
    tipo: "api_key",
    descricao: "Acesso direto à API da Anthropic para Claude Sonnet/Haiku/Opus.",
    modelosSugeridos: ["claude-3-7-sonnet", "claude-3-5-haiku"],
    secretKeys: ["anthropic_api_key"],
  },
  {
    id: "google",
    nome: "Google AI Studio Direto",
    tipo: "api_key",
    descricao: "Chave direta do Google AI Studio para Gemini 2.5/3.8 Flash e Pro.",
    modelosSugeridos: ["gemini-2.5-flash", "gemini-3.8-flash"],
    secretKeys: ["google_api_key"],
  },
  {
    id: "openai",
    nome: "OpenAI API Direta",
    tipo: "api_key",
    descricao: "Acesso direto à API da OpenAI para GPT-4o, o3-mini e embeddings.",
    modelosSugeridos: ["gpt-4o-mini", "o3-mini"],
    secretKeys: ["openai_api_key"],
  },
  {
    id: "ollama",
    nome: "Ollama (Modelos Locais)",
    tipo: "local",
    descricao: "Servidor local Ollama rodando em http://localhost:11434.",
    modelosSugeridos: ["llama3.2:latest", "qwen2.5-coder:latest"],
  },
]);

/** Primeira variável de ambiente do provedor (ex.: `anthropic` → `ANTHROPIC_API_KEY`), se houver. */
export function providerEnvVar(providerId: string): string | undefined {
  return PROVIDER_ENV_VARS[providerId]?.[0];
}

/** Provedores com chave de API que têm variável de ambiente e/ou segredo legado. */
export function providersWithKeySources(): ProviderDefinition[] {
  const seenEnv = new Set<string>();
  return PROVIDER_DEFINITIONS.filter((p) => {
    if (p.tipo !== "api_key") return false;
    const v = providerEnvVar(p.id);
    // Provedor que só reaproveita a variável de outro (ex.: opencode-go → OpenRouter) não lê chave do ambiente.
    const dup = v ? seenEnv.has(v) : false;
    if (v) seenEnv.add(v);
    return (v && !dup) || Boolean(p.secretKeys?.length);
  });
}
