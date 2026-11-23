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
    nome: "CCO (Anthropic)",
    tipo: "api_key",
    descricao: "Acesso direto à API da Anthropic via CCO para modelos Sonnet/Haiku/Opus 5.5.",
    modelosSugeridos: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    secretKeys: ["anthropic_api_key"],
  },
  {
    id: "google",
    nome: "Google AI Studio Direto",
    tipo: "api_key",
    descricao: "Chave direta do Google AI Studio para Gemini 3.8 e 4 Flash/Pro.",
    modelosSugeridos: ["gemini-4-argon-high", "gemini-3.8-flash"],
    secretKeys: ["google_api_key"],
  },
  {
    id: "agy",
    nome: "Google Antigravity (AGY / CCO Proxy)",
    tipo: "local",
    descricao: "Proxy local CCO AGY com rotação entre contas Google Antigravity em http://127.0.0.1:4810.",
    modelosSugeridos: [
      "gemini-4-argon-high",
      "gemini-4-neon-high",
      "gemini-4-hydrogen-high",
      "claude-sonnet-5-5-high",
      "claude-opus-5-5-high",
      "gemini-3.8-flash-high",
    ],
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
  {
    id: "llms2api",
    nome: "LLMs2API (Local Gateway)",
    tipo: "local",
    descricao: "Gateway local OpenAI-compatível conectado a ChatGPT, DeepSeek, Qwen e Gemini em http://127.0.0.1:11435/v1.",
    modelosSugeridos: [
      "gemini/gemini-pro",
      "gemini/gemini-preview",
      "gemini/gemini-reasoning",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-v3.2-thinking",
      "qwen/qwen3-max",
      "qwen/qwen3-coder",
    ],
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
