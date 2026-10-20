import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { opencorpHome } from "../../../utils/paths.js";
import { mascararChave } from "./opencode-server.js";
import { PROVIDER_DEFINITIONS, providerEnvVar, providersWithKeySources } from "../../models/providers.js";
import { EngineAccountStore, type EngineAccount } from "../../engines/engine-account-store.js";

export interface MensagemChat {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OpcoesCompletar {
  model: string;
  messages: MensagemChat[];
  temperature?: number;
  maxTokens?: number;
  homeDir?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RespostaCompletar {
  content: string;
  model: string;
  provider?: string;
  is_byok?: boolean;
  cost?: number;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  duration_ms: number;
}

export interface ResultadoTesteModelo {
  ok: boolean;
  status: number;
  ms: number;
  model: string;
  content?: string;
  error?: string;
  provider?: string;
  is_byok?: boolean;
  cost?: number;
}

export interface ProvedorInfo {
  id: string;
  nome: string;
  conectado: boolean;
  tipo: "api_key" | "local" | "oauth";
  previewChave?: string;
  fonte?: string;
  descricao: string;
  modelosSugeridos: string[];
}

/**
 * Resolve as chaves de API geridas pelo OpenCorp. Arquivos internos de CLIs de
 * terceiros (ex.: `~/.local/share/opencode/auth.json`) não são lidos (D4).
 */
export function obterChavesProvedores(homeDir?: string): Record<string, string> {
  const home = homeDir ?? opencorpHome();
  const chaves: Record<string, string> = {};

  const arquivosAuth = [
    join(home, ".opencorp", "opencode-data", "opencode", "auth.json"),
    join(home, ".opencorp", "opencode-home", ".opencode", "auth.json"),
  ];

  for (const arq of arquivosAuth) {
    if (existsSync(arq)) {
      try {
        const json = JSON.parse(readFileSync(arq, "utf8")) as Record<string, any>;
        for (const [prov, val] of Object.entries(json)) {
          if (!chaves[prov]) {
            if (typeof val === "string" && val.trim()) chaves[prov] = val.trim();
            else if (val && typeof val === "object" && typeof val.key === "string" && val.key.trim()) {
              chaves[prov] = val.key.trim();
            }
          }
        }
      } catch {}
    }
  }

  // secrets.json
  const secretsPath = join(home, ".opencorp", "secrets.json");
  if (existsSync(secretsPath)) {
    try {
      const sec = JSON.parse(readFileSync(secretsPath, "utf8")) as Record<string, any>;
      for (const prov of providersWithKeySources()) {
        if (chaves[prov.id]) continue;
        for (const k of prov.secretKeys ?? []) {
          if (sec[k]) { chaves[prov.id] = String(sec[k]).trim(); break; }
        }
      }
    } catch {}
  }

  // Variáveis de ambiente como fallback
  for (const prov of providersWithKeySources()) {
    const v = providerEnvVar(prov.id);
    const val = v ? process.env[v] : undefined;
    if (!chaves[prov.id] && val) chaves[prov.id] = val.trim();
  }

  return chaves;
}

/**
 * Retorna o status de conexão de cada provedor para exibição na UI
 */
export function listarProvedoresStatus(homeDir?: string): ProvedorInfo[] {
  const chaves = obterChavesProvedores(homeDir);

  const provedoresDefinidos = PROVIDER_DEFINITIONS;

  return provedoresDefinidos.map((p) => {
    const chave = chaves[p.id];
    const conectado = Boolean(chave && chave.length > 5);
    return {
      id: p.id,
      nome: p.nome,
      tipo: p.tipo,
      conectado,
      previewChave: conectado && chave ? mascararChave(chave) : undefined,
      descricao: p.descricao,
      modelosSugeridos: p.modelosSugeridos,
    };
  });
}

/**
 * Cliente Universal Leve para Inferência Direta de LLM.
 * Não inicializa processos do OpenCode, não cria sessões no corp.db e não usa watchdog.
 * Retorna o texto puro ou JSON diretamente da API do provedor em ~1-3s.
 */
export async function completarChatDirect(opcoes: OpcoesCompletar): Promise<RespostaCompletar> {
  const home = opcoes.homeDir ?? opencorpHome();
  const chaves = obterChavesProvedores(home);
  const timeoutMs = opcoes.timeoutMs ?? 60_000;
  const inicio = Date.now();

  let modelo = opcoes.model.trim();
  // Se começar com prefixo de harness ex: "opencode/openrouter/..." -> normaliza
  if (modelo.startsWith("opencode/")) modelo = modelo.slice("opencode/".length);
  if (modelo.startsWith("claude-code/")) modelo = modelo.slice("claude-code/".length);

  let url = "https://openrouter.ai/api/v1/chat/completions";
  let apiKey = chaves["openrouter"];
  let modelParam = modelo;
  const headersReq: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const acctStore = new EngineAccountStore({ homeDir: home });
  const todasContas: EngineAccount[] = await acctStore.listar();
  const contaComBaseUrl = todasContas.find((c: EngineAccount) => c.baseUrl && c.baseUrl.trim().length > 0 && c.ativa)
    || todasContas.find((c: EngineAccount) => c.baseUrl && c.baseUrl.trim().length > 0);

  let providerParam: string | undefined = undefined;
  let provedorNome: string | undefined = undefined;

  if (
    modelo.startsWith("custom/") ||
    modelo.startsWith("g4f/") ||
    modelo.startsWith("local/")
  ) {
    let prefixo = "custom/";
    if (modelo.startsWith("g4f/")) prefixo = "g4f/";
    else if (modelo.startsWith("local/")) prefixo = "local/";

    modelParam = modelo.slice(prefixo.length);
    const contaAlvo = todasContas.find((c: EngineAccount) => (c.provider === "custom" || c.provider === "g4f" || c.motorId === "custom") && c.baseUrl)
      || contaComBaseUrl;

    const baseUrl = contaAlvo?.baseUrl || "http://127.0.0.1:8080/v1";
    const baseLimpa = baseUrl.replace(/\/+$/, "");
    url = baseLimpa.endsWith("/chat/completions") ? baseLimpa : `${baseLimpa}/chat/completions`;
    apiKey = contaAlvo?.tokenOuChave || "g4f-local";
    provedorNome = contaAlvo?.nome || "GPT4Free";
    headersReq["Authorization"] = `Bearer ${apiKey}`;

    if (modelParam === "gpt-4o-mini" || modelParam === "default" || modelParam === "") {
      providerParam = "ChatGPTLightweight";
    }
  } else if (modelo.startsWith("opencode-go/")) {
    url = "https://opencode.ai/zen/go/v1/chat/completions";
    apiKey = chaves["opencode-go"] || chaves["opencode"];
    modelParam = modelo.slice("opencode-go/".length);
    if (!apiKey) {
      throw new Error("Nenhuma chave de API configurada para o provedor OpenCode-Go. Configure em Config → Motores & Provedores.");
    }
    headersReq["Authorization"] = `Bearer ${apiKey}`;
    headersReq["x-opencode-session"] = "ses_" + Math.random().toString(36).slice(2);
  } else {
    if (modelo.startsWith("openrouter/")) {
      modelParam = modelo.slice("openrouter/".length);
    } else if (modelo.startsWith("google/") || modelo.startsWith("nvidia/") || modelo.startsWith("minimax/") || modelo.startsWith("anthropic/") || modelo.startsWith("openai/")) {
      // Se foi passado sem openrouter/ mas tem formato org/model, usa OpenRouter como hub
      modelParam = modelo;
    }

    if (!apiKey) {
      throw new Error(
        "Nenhuma chave de API encontrada para o provedor OpenRouter. Configure em Config → Chaves ou em ~/.opencorp/secrets.json",
      );
    }
    headersReq["Authorization"] = `Bearer ${apiKey}`;
    headersReq["HTTP-Referer"] = "https://opencorp.local";
    headersReq["X-Title"] = "OpenCorp Direct Inference";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payloadReq: Record<string, any> = {
      model: modelParam,
      messages: opcoes.messages,
      temperature: opcoes.temperature ?? 0.7,
      max_tokens: opcoes.maxTokens ?? 1500,
    };
    if (providerParam) {
      payloadReq.provider = providerParam;
    }

    const res = await fetch(url, {
      method: "POST",
      headers: headersReq,
      body: JSON.stringify(payloadReq),
      signal: opcoes.signal ?? controller.signal,
    });

    const duration_ms = Date.now() - inicio;
    const data = (await res.json()) as any;

    if (!res.ok) {
      const errMsg = data?.error?.message || data?.message || `HTTP ${res.status}`;
      throw new Error(`Falha na chamada ao modelo (${modelParam}): ${errMsg}`);
    }

    const choice = data?.choices?.[0];
    const content = choice?.message?.content ?? "";

    return {
      content,
      model: data?.model || modelParam,
      provider: data?.provider || provedorNome,
      is_byok: data?.usage?.is_byok ?? false,
      cost: data?.usage?.cost ?? 0,
      usage: data?.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens ?? 0,
            completion_tokens: data.usage.completion_tokens ?? 0,
            total_tokens: data.usage.total_tokens ?? 0,
          }
        : undefined,
      duration_ms,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispara uma requisição de teste de 1 token para validar a chave e conexão com o modelo.
 */
export async function testarModeloDirect(
  model: string,
  homeDir?: string,
): Promise<ResultadoTesteModelo> {
  const inicio = Date.now();
  try {
    const resp = await completarChatDirect({
      model,
      messages: [{ role: "user", content: "Diga apenas: OK" }],
      maxTokens: 10,
      temperature: 0.1,
      homeDir,
      timeoutMs: 60_000,
    });

    return {
      ok: true,
      status: 200,
      ms: resp.duration_ms,
      model: resp.model,
      content: resp.content.trim(),
      provider: resp.provider,
      is_byok: resp.is_byok,
      cost: resp.cost,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 500,
      ms: Date.now() - inicio,
      model,
      error: err.message || String(err),
    };
  }
}
