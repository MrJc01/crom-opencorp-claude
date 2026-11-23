/**
 * Rotação conservadora para agentes: modelos explícitos, com tool-calling e
 * diversidade de provedores. Roteadores cegos e modelos <4B ficam de fora.
 *
 * A descoberta completa continua dinâmica via `opencode models`; esta lista é
 * apenas o conjunto curado usado em novos workspaces e na recuperação de falhas.
 */
export const ROTACAO_AGENTES_RECOMENDADA = [
  "openrouter/nvidia/nemotron-3.5-super-vl:free",
  "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
  "openrouter/nvidia/nemotron-3.5-lightning:free",
  "openrouter/cohere/north-mini-code:free",
  "openrouter/inclusionai/ling-3.2-flash:free",
  "openrouter/baidu/ernie-5.5-flash-preview:free",
  "openrouter/particle-ai/particle-1:free",
  "openrouter/recursive/flint-v1.0:free",
  "openrouter/dots-studio/dots-3-note-preview:free",
  "openrouter/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "opencode/deepseek-v4.1-flash-free",
  "opencode/mimo-v2.6-flash-free",
  "opencode/nemotron-3.5-super-vl-free",
  "opencode/nemotron-3.5-lightning-free",
  "opencode/flint-40b-free",
] as const;

export const MODELOS_CATALOGO_BASE = [
  ...ROTACAO_AGENTES_RECOMENDADA,
  "openrouter/google/gemma-4-31b-it:free",
  "openrouter/google/gemma-4-26b-a4b-it:free",
  "opencode/longcat-2.5-free",
  "opencode/hy4-flash-free",
  "opencode/big-pickle",
  "openrouter/google/gemini-3.8-flash",
  "opencode-go/glm-5.3-flash",
  "opencode-go/qwen3.8-flash",
  "opencode-go/mimo-v2.6-flash",
  "opencode-go/deepseek-v4.1-flash",
  "opencode-go/qwen3.8-plus",
] as const;
