import { z } from "zod";
import { ROTACAO_AGENTES_RECOMENDADA } from "../core/contexts/agents/recommended-models.js";

export const settingsSchema = z.object({
  version: z.number().int().default(1),
  default_model: z.string().min(1).default("opencode/nemotron-3-ultra-free"),
  default_conversation_engine: z.string().trim().min(1).default("claude-sdk"),
  conversationEngineOverride: z.string().trim().min(1).optional(),
  engines: z
    .record(
      z.string().trim().min(1),
      z.object({
        binary_path: z.string().trim().min(1).optional(),
        /** Limites operacionais do motor (antes em runner.json `limits`). */
        limits: z
          .object({
            timeout_min: z.number().nonnegative().optional(),
            max_turns: z.number().int().nonnegative().optional(),
            rate_limit_rpm: z.number().nonnegative().optional(),
            daily_cost_usd: z.number().nonnegative().optional(),
            status_cota: z.enum(["normal", "alerta_80", "esgotado"]).optional(),
            fallback_action: z.enum(["rotate", "stop"]).optional(),
          })
          .optional(),
      }),
    )
    .default({}),
  /** Execuções one-shot (antes em runner.json). */
  run_engine: z
    .object({
      default: z.string().trim().min(1).optional(),
      timeout_min: z.number().positive().optional(),
      /** Cadeia explícita de motores para fallback; vazia = nunca trocar de motor. */
      fallback: z.array(z.string().trim().min(1)).default([]),
    })
    .optional(),
  test_model: z.string().min(1).default("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
  secretary: z
    .object({
      agent: z.string().min(1).default("secretario-exec"),
      /** override do modelo dos agentes secretário/secretário-exec (aceita vaga do provedor, id direto ou provider/model) */
      model: z
        .string()
        .trim()
        .min(1)
        .regex(/^[a-z0-9._:@/-]+$/i, "informe um identificador de modelo válido (ex.: padrao, gemini-4-argon-high ou provider/model)")
        .optional(),
    })
    .prefault({}),
  budget: z
    .object({
      daily_usd: z.number().nonnegative().default(5.0),
      per_agent_usd: z.number().nonnegative().default(1.0),
      pause_on_exceed: z.boolean().default(true),
      notify_registry: z.string().min(1).default("custos"),
    })
    .prefault({}),
  security: z
    .object({
      level: z.enum(["permissive", "standard", "strict"]).default("standard"),
      blocklist: z
        .array(z.string())
        .default(["rm -rf", "shutdown", "curl * | bash", "git push --force"]),
      hitl_patterns: z
        .array(z.string())
        .default(["git push", "npm publish", "DROP TABLE", "email*"]),
      network_allowlist: z.array(z.string()).default(["registry.npmjs.org", "github.com"]),
    })
    .prefault({}),
  paths: z
    .object({
      workspaces_root: z.string().min(1).default("~/.opencorp/workspaces"),
    })
    .prefault({}),
  prompts: z
    .object({
      /** Permite puxar prompts do global (~/.opencorp/prompts.json) em runtime quando
       *  o workspace não tem a chave. Default OFF (D1): por padrão só há seed na criação. */
      fallback_global: z.boolean().default(false),
    })
    .prefault({}),
  tests: z
    .object({
      blind: z.boolean().default(true),
      test_model: z.string().min(1).default("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"),
      reports_dir: z.string().min(1).default(".opencorp/reports/testes"),
      rotation: z
        .array(z.string().min(1))
        .default([...ROTACAO_AGENTES_RECOMENDADA]),
      timeout_minutes: z.number().int().min(1).default(25),
      health_check: z.boolean().default(true),
    })
    .prefault({}),
  cloud: z
    .object({
      enabled: z.boolean().default(false),
      mode: z.enum(["backup-local", "backup-nuvem", "mirror-remoto"]).default("backup-local"),
      targets: z.array(z.string()).default([]),
    })
    .prefault({}),
  ui: z
    .object({
      theme: z.enum(["dark", "light"]).default("dark"),
      verbose: z.boolean().default(false),
    })
    .prefault({}),
  meeting: z
    .object({
      max_turns: z.number().int().min(1).default(12),
      max_minutes: z.number().int().min(1).default(6),
      per_agent_usd: z.number().nonnegative().default(0.5),
      moderator: z.string().min(1).default("secretario"),
      ata_model_rotation: z
        .array(z.string().min(1))
        .default([...ROTACAO_AGENTES_RECOMENDADA]),
    })
    .prefault({}),
  supervisor: z
    .object({
      interval_minutes: z.number().int().min(1).default(15),
      enabled: z.boolean().default(false),
      max_orders_per_tick: z.number().int().min(1).default(3),
    })
    .prefault({}),
  healing: z
    .object({
      enabled: z.boolean().default(true),
      max_retries: z.number().int().min(0).default(2),
    })
    .prefault({}),
  scheduler: z
    .object({
      // catch-up: executa job atrasado (ex.: máquina dormindo) dentro da janela — senão pula com registro
      catch_up: z.boolean().default(false),
      catch_up_max_min: z.number().int().min(1).default(60),
      /** Fuso IANA para interpretar crons e exibir horários (ex.: America/Sao_Paulo).
       *  Override por workspace: scheduler.timezone no escopo workspace. */
      timezone: z.string().min(1).default("America/Sao_Paulo"),
    })
    .prefault({}),
});

export type Settings = z.infer<typeof settingsSchema>;
