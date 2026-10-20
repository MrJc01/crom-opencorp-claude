import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Pasta de login do Claude Code só do OpenCorp (OPENCORP_CLAUDE_CONFIG_DIR, ex.: ~/.opencorp/claude-conta), para os
 * agentes usarem uma conta fixa, independente da conta logada no Claude desktop/CLI do dono. Só vale depois do login
 * nela (`CLAUDE_CONFIG_DIR=<pasta> claude` e /login): sem `.credentials.json` lá, volta para o ~/.claude padrão.
 */
export function claudeConfigDirOpencorp(): string | undefined {
  const dir = process.env.OPENCORP_CLAUDE_CONFIG_DIR?.trim();
  return dir && existsSync(join(dir, ".credentials.json")) ? dir : undefined;
}
