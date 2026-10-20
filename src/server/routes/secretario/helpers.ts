import { fetchOpencode } from "../../../core/contexts/execution/opencode-server.js";
import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { opencorpHome } from "../../../utils/paths.js";
import { resolveEngineCredentials } from "../../../core/engines/credentials-bridge.js";
import { WorkspaceError } from "../../../core/shared/errors.js";
import {
  SecretarioError,
  extrairPassosMensagens,
  type MensagemOc,
} from "../../../core/contexts/execution/opencode-server.js";
import { formatProcessKey, ProcessRegistry } from "../../../core/runtime/index.js";
import { resolverCadeiaModelosAgente } from "../../../core/contexts/agents/model-resolver.js";
import type { RouteContext } from "../types.js";

/** Modelo de contingência quando só há chave direta da Anthropic (provedor, não motor). */
export const MODELO_CONTINGENCIA_ANTHROPIC = process.env.OPENCORP_MODELO_CONTINGENCIA_ANTHROPIC?.trim() || "anthropic/claude-3-7-sonnet";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function normalizarNomeModelo(modelo: string): string {
  const m = String(modelo ?? "").trim();
  if (!m) return "";
  if (!m.includes("/")) {
    if (m.startsWith("gemini-") || m.startsWith("gemma-")) {
      return `google/${m}`;
    }
    if (m.startsWith("claude-")) {
      return `anthropic/${m}`;
    }
    if (m.startsWith("gpt-") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4")) {
      return `openai/${m}`;
    }
    if (m.startsWith("glm-")) {
      return `opencode-go/${m}`;
    }
  }
  return m;
}

export function parsearModelo(modelo: string): { providerID: string; modelID: string } {
  const m = normalizarNomeModelo(modelo);
  if (!m) return { providerID: "opencode", modelID: "default" };
  if (!m.includes("/")) {
    return { providerID: "opencode", modelID: m };
  }
  const idx = m.indexOf("/");
  const providerID = m.slice(0, idx).trim();
  let modelID = m.slice(idx + 1).trim();
  // Defesa contra entradas já compostas duas vezes, por exemplo
  // google/google/gemini-2.5-flash ou openrouter/openrouter/nvidia/...
  if (modelID.startsWith(`${providerID}/`)) {
    modelID = modelID.slice(providerID.length + 1);
  }
  return {
    providerID,
    modelID,
  };
}

export async function trocarModeloEngine(baseUrl: string, sessaoId: string, modeloCompleto: string): Promise<boolean> {
  try {
    const { providerID, modelID } = parsearModelo(modeloCompleto);
    const [res1, res2] = await Promise.all([
      fetchOpencode(`${baseUrl}/api/session/${encodeURIComponent(sessaoId)}/model`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { id: modelID, providerID } }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
      fetchOpencode(`${baseUrl}/session/${encodeURIComponent(sessaoId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: { id: modelID, providerID } }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null),
    ]);
    return Boolean((res1 && (res1.ok || res1.status === 204)) || (res2 && res2.ok));
  } catch {
    return false;
  }
}

export async function resolverCaminhoLocal(wsPath: string, pathParam: string): Promise<string> {
  const base = resolve(wsPath);
  const solicitado = pathParam ?? "";
  const normalizado = solicitado.replace(/^\.\//, "").replace(/\/+/g, "/");
  const alvo = resolve(base, normalizado);
  const relativo = relative(base, alvo);
  if (relativo.startsWith("..") || isAbsolute(relativo)) {
    throw new WorkspaceError("caminho fora do workspace (path traversal bloqueado)", { exitCode: 3 });
  }
  return alvo;
}

export async function obterPorta(ctx: RouteContext, autoIniciar = false, wsId?: string): Promise<number> {
  const { portaOpencodeOuErro, opencodeServer } = ctx;
  if (portaOpencodeOuErro) return portaOpencodeOuErro(autoIniciar);

  if (wsId) {
    const key = formatProcessKey({ engineId: "opencode", workspaceId: wsId });
    const proc = ProcessRegistry.getInstance().get(key);
    if (proc && proc.port && proc.state !== "stopped" && proc.state !== "crashed") {
      return proc.port;
    }
  }

  if (!opencodeServer) throw new SecretarioError("servidor do motor de IA não configurado", { status: 500 });
  let st = await opencodeServer.status();
  if (autoIniciar && (!st.rodando || !st.porta)) {
    try {
      const res = await opencodeServer.iniciar();
      if (res.porta) return res.porta;
      st = await opencodeServer.status();
    } catch (err) {
      console.error("[secretario] falha ao auto-iniciar opencode server:", err);
    }
  }
  if (!st.rodando || !st.porta) {
    throw new SecretarioError("motor do secretário não iniciado — execute POST /secretario/start", { status: 409 });
  }
  return st.porta;
}

export async function sincronizarCorp(ctx: RouteContext, porta: number, sessaoId: string): Promise<void> {
  if (ctx.sincronizarSessaoNoCorp) {
    await ctx.sincronizarSessaoNoCorp(porta, sessaoId);
  }
}

export function obterModelosDefensivos(
  homeDir: string,
  modeloSolicitado?: string,
): { modelos: string[]; motorPadrao: string } {
  const creds = resolveEngineCredentials(homeDir);
  const modelos: string[] = [];

  // 1. Se o usuário solicitou um modelo específico, ele é prioridade número 1
  if (modeloSolicitado && modeloSolicitado.trim()) {
    modelos.push(normalizarNomeModelo(modeloSolicitado.trim()));
  }

  // 2. Lê auth.json para checar provedores configurados
  const authPath = join(homeDir, ".opencorp", "opencode-data", "opencode", "auth.json");
  let authData: Record<string, any> = {};
  if (existsSync(authPath)) {
    try {
      authData = JSON.parse(readFileSync(authPath, "utf8"));
    } catch {}
  }

  // 3. Lê engine-accounts.json para checar contas ativas
  const acctPath = join(homeDir, ".opencorp", "engine-accounts.json");
  let contasAtivas: any[] = [];
  if (existsSync(acctPath)) {
    try {
      const parsed = JSON.parse(readFileSync(acctPath, "utf8"));
      if (Array.isArray(parsed)) {
        contasAtivas = parsed.filter(
          (c: any) => c && c.ativa !== false && c.limits?.status_cota !== "esgotado",
        );
      }
    } catch {}
  }

  // 4. Prioridade 1: cadeia OpenRouter gratuita comprovada por probes reais.
  const temOpenRouter = Boolean(
    creds.OPENROUTER_API_KEY ||
      authData.openrouter?.key ||
      process.env.OPENROUTER_API_KEY,
  );
  if (temOpenRouter) {
    modelos.push(
      "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      "openrouter/thinkingmachines/inkling:free",
      "openrouter/nvidia/nemotron-3.5-lightning:free",
      "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
      "openrouter/qwen/qwen3.8-27b:free",
    );
  }

  // 5. Google direto somente com credencial Google AI Studio real.
  // A credencial do runtime Antigravity não é uma GEMINI_API_KEY.
  const temGoogle = Boolean(
    creds.GEMINI_API_KEY ||
      process.env.GEMINI_API_KEY ||
      authData.google?.key,
  );
  if (temGoogle) {
    modelos.push("google/gemini-2.5-flash");
  }

  // 6. Contas locais só entram quando o provider está explícito e registrado.
  // O provider custom/GPT4Free responde direto, mas ainda não consta no catálogo
  // conectado do OpenCode; não deve contaminar a rotação defensiva.
  for (const c of contasAtivas) {
    if (
      c.provider &&
      c.provider !== "custom" &&
      c.modeloPadrao &&
      typeof c.modeloPadrao === "string"
    ) {
      const modeloConta = c.modeloPadrao.includes("/")
        ? c.modeloPadrao
        : `${c.provider}/${c.modeloPadrao}`;
      modelos.push(normalizarNomeModelo(modeloConta));
    }
  }

  // 7. Contingência final: OpenAI ou Anthropic diretos.
  if (creds.OPENAI_API_KEY || authData.openai?.key) {
    modelos.push("openai/gpt-4o-mini");
  }
  if (creds.ANTHROPIC_API_KEY || authData.anthropic?.key) {
    modelos.push(MODELO_CONTINGENCIA_ANTHROPIC);
  }

  const modelosUnicos = [...new Set(modelos.filter(Boolean))];

  if (modelosUnicos.length === 0) {
    throw new SecretarioError(
      "Nenhum provedor de IA com credenciais válidas configurado. Acesse Configurações > Motores (TabEngines) ou configure uma chave GEMINI_API_KEY ou OPENROUTER_API_KEY.",
      { status: 400 },
    );
  }

  return { modelos: modelosUnicos, motorPadrao: "opencode" };
}

export async function resolverModelos(
  ctx: RouteContext,
  opts: {
    modeloRequisicao?: string;
    agenteId?: string;
    wsPath?: string;
  },
): Promise<{ modelos: string[]; motorPadrao: string }> {
  const { modeloRequisicao, agenteId, wsPath } = opts;
  const { agentes, homeDir } = ctx;
  const home = homeDir ?? opencorpHome();

  let ag: any = undefined;
  if (agenteId && agentes && wsPath) {
    try {
      ag = await agentes.carregar(wsPath, agenteId);
    } catch {}
  }

  const modReq = modeloRequisicao ? normalizarNomeModelo(modeloRequisicao) : undefined;

  // Obtém modelos defensivos reais a partir das credenciais do usuário
  let defensivos: { modelos: string[]; motorPadrao: string };
  try {
    defensivos = obterModelosDefensivos(home, modReq);
  } catch (err) {
    // Fallback permissivo para desenvolvimento com modelo solicitado
    defensivos = {
      modelos: [modReq || "google/gemini-2.5-flash"].filter(Boolean),
      motorPadrao: "opencode",
    };
  }

  try {
    const { cadeia } = resolverCadeiaModelosAgente({
      agente: ag?.frontmatter || ag,
      wsPath: wsPath || "",
      modeloSolicitado: modReq,
    });
    const cadeiaNormalizada = cadeia.map((m) => normalizarNomeModelo(m));
    // Mescla cadeia do agente com contingência defensiva real sem duplicatas
    const listaFinal = [...new Set([...cadeiaNormalizada, ...defensivos.modelos])];
    return { modelos: listaFinal, motorPadrao: "opencode" };
  } catch {
    return defensivos;
  }
}

export async function limparMensagensTentativaFalha(
  baseUrlSessao: string,
  idsAntes: Set<string | undefined>,
  manterSeTiverTextoSubstancial: boolean = true,
): Promise<void> {
  try {
    await fetchOpencode(`${baseUrlSessao}/abort`, { method: "POST" }).catch(() => {});
    const getRes = await fetchOpencode(`${baseUrlSessao}/message`, { signal: AbortSignal.timeout(4000) });
    if (!getRes.ok) return;
    const msgs = (await getRes.json()) as MensagemOc[];
    if (!Array.isArray(msgs)) return;

    const novas = msgs.filter((m) => m.info?.id && !idsAntes.has(m.info.id));
    if (novas.length === 0) return;

    if (manterSeTiverTextoSubstancial) {
      const assistentesNovas = novas.filter((m) => m.info?.role === "assistant");
      const temSubstancial = assistentesNovas.some((a) => {
        const passos = extrairPassosMensagens([a]);
        const txt = passos.filter((p) => p.tipo === "texto").map((p) => p.texto ?? "").join("\n").trim();
        return txt.length > 20;
      });
      if (temSubstancial) return;
    }

    for (const m of novas) {
      if (m.info?.id) {
        await fetchOpencode(`${baseUrlSessao}/message/${encodeURIComponent(m.info.id)}`, {
          method: "DELETE",
          signal: AbortSignal.timeout(3000),
        }).catch(() => {});
      }
    }
  } catch {}
}
