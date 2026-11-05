/**
 * Fornecedores ACP. Diferenças entre agentes ficam só aqui (Etapa 12).
 *
 * Handshakes reais conferidos em 26/09/2026, sem prompt e sem custo:
 * - `copilot --acp` 1.0.88: loadSession, session/close, session/list; sem fork/resume;
 *   `session/new` exige login (-32000 "Authentication required").
 * - `mimo acp` 0.1.15 (derivado do OpenCode): loadSession, session/fork,
 *   session/resume, session/list; modelo selecionável por `configOptions` (`model`).
 */
import { CANONICAL_ENGINE_MANIFESTS } from "../manifests.js";
import type { AcpVendorConfig } from "./acp-adapter.js";

export const COPILOT_ACP: AcpVendorConfig = {
  engineId: "copilot",
  name: "GitHub Copilot CLI",
  binaryName: "copilot",
  acpArgs: ["--acp"],
  // `copilot --model <modelo>`: seleção por configOptions ainda não verificada (exige login).
  launchModelArgs: (model) => ["--model", model],
  manifest: CANONICAL_ENGINE_MANIFESTS.copilot!,
};

export const MIMO_ACP: AcpVendorConfig = {
  engineId: "mimo",
  name: "Xiaomi MiMo Code",
  binaryName: "mimo",
  acpArgs: ["acp"],
  manifest: CANONICAL_ENGINE_MANIFESTS.mimo!,
};
