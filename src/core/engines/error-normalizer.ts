import { redactKnownSecrets } from "../credentials/credentials-store.js";
import {
  EngineAuthRequiredError,
  EngineCapabilityUnavailableError,
  EngineError,
  EngineNotFoundError,
  EngineUnavailableError,
  ModelIncompatibleError,
  PreflightBinaryMissingError,
} from "./errors.js";

export interface ErrorNormalizationOptions {
  engineId?: string;
  modelId?: string;
  capability?: string;
  defaultMessage?: string;
}

export function normalizeEngineError(raw: unknown, options: ErrorNormalizationOptions = {}): EngineError {
  if (raw instanceof EngineError) {
    return raw;
  }

  const engineId = options.engineId || "unknown";
  const err = raw as any;
  // Mensagens de fornecedor podem ecoar chaves (ex.: "invalid key sk-..."); nunca propagar.
  const message = redactKnownSecrets(String(err?.message || err || options.defaultMessage || "Erro desconhecido do motor"));
  const lowerMessage = message.toLowerCase();
  const code = String(err?.code || "").toLowerCase();

  // 1. Falha de binário ausente no PATH / preflight
  if (
    code === "enoent" ||
    lowerMessage.includes("enoent") ||
    lowerMessage.includes("command not found") ||
    lowerMessage.includes("binário") && lowerMessage.includes("não encontrado") ||
    lowerMessage.includes("not found on path")
  ) {
    return new PreflightBinaryMissingError(engineId, {
      cause: raw,
      details: { rawMessage: message },
    });
  }

  // 2. Falha de autenticação ou autorização do motor
  if (
    err?.status === 401 ||
    err?.statusCode === 401 ||
    err?.status === 403 ||
    err?.statusCode === 403 ||
    lowerMessage.includes("unauthorized") ||
    lowerMessage.includes("autenticação") ||
    lowerMessage.includes("auth required") ||
    lowerMessage.includes("api key missing") ||
    lowerMessage.includes("invalid token") ||
    // Conta sem acesso por assinatura ao Claude Code: só resolve com outro provedor (opencorp provedor usar ...).
    lowerMessage.includes("disabled claude subscription access")
  ) {
    return new EngineAuthRequiredError(engineId, {
      cause: raw,
      details: { rawMessage: message },
    });
  }

  // 3. Incompatibilidade de modelo
  if (
    lowerMessage.includes("model not supported") ||
    lowerMessage.includes("incompatible model") ||
    lowerMessage.includes("modelo incompatível") ||
    lowerMessage.includes("unknown model")
  ) {
    return new ModelIncompatibleError(engineId, options.modelId || "desconhecido", {
      cause: raw,
      details: { rawMessage: message },
    });
  }

  // 4. Capacidade ausente ou não suportada
  if (
    lowerMessage.includes("not supported") ||
    lowerMessage.includes("capacidade não disponível") ||
    lowerMessage.includes("unsupported capability")
  ) {
    return new EngineCapabilityUnavailableError(engineId, options.capability || "funcionalidade", {
      cause: raw,
      details: { rawMessage: message },
    });
  }

  // 5. Motor não registrado
  if (lowerMessage.includes("não está registrado")) {
    return new EngineNotFoundError(engineId);
  }

  // 6. Motor indisponível padrão
  return new EngineUnavailableError(engineId, message, {
    cause: raw,
    details: { rawMessage: message },
  });
}
