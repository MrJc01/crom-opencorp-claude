import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Garante que o daemon do LLMs2API esteja em execução sob demanda (estilo cco garantir_daemon).
 * Se http://127.0.0.1:11435/health já responder, não faz nada.
 * Se não estiver rodando, inicia o daemon desacoplado (detached) em segundo plano e aguarda ficar saudável.
 */
export async function garantirLlms2apiDaemon(baseUrl = "http://127.0.0.1:11435"): Promise<boolean> {
  const saude = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/health`;
  try {
    const res = await fetch(saude, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return true;
  } catch {
    /* daemon parado — iniciaremos abaixo */
  }

  const caminhos = [
    process.env.LLMS2API_DIR ? join(process.env.LLMS2API_DIR, "bin", "llms2api.mjs") : null,
    join(homedir(), "Documentos", "GitHub", "LLMs2API", "bin", "llms2api.mjs"),
    join(homedir(), ".local", "bin", "llms2api"),
  ].filter(Boolean) as string[];

  const script = caminhos.find((c) => existsSync(c));
  if (!script) {
    return false;
  }

  try {
    const logDir = join(homedir(), ".local", "state", "llms2api");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "daemon.log");
    const out = openSync(logFile, "a");

    const args = script.endsWith(".mjs")
      ? [script, "serve", "--no-tray"]
      : ["serve", "--no-tray"];
    const bin = script.endsWith(".mjs") ? process.execPath : script;

    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
    });
    child.unref();

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(saude, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {}
    }
  } catch (erro) {
    console.error(`[llms2api] falha ao iniciar daemon sob demanda: ${String(erro)}`);
  }

  return false;
}

/**
 * Garante que o proxy local do Google Antigravity (agy, porta 4810 via cco) esteja rodando sob demanda.
 */
export async function garantirAgyDaemon(baseUrl = "http://127.0.0.1:4810"): Promise<boolean> {
  const saude = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/health`;
  try {
    const res = await fetch(saude, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return true;
  } catch {
    /* proxy parado — iniciaremos abaixo */
  }

  const caminhos = [
    process.env.CCO_DIR ? join(process.env.CCO_DIR, "proxy", "agy", "server.mjs") : null,
    join(homedir(), "Documentos", "GitHub", "claude-code-open", "proxy", "agy", "server.mjs"),
  ].filter(Boolean) as string[];

  const script = caminhos.find((c) => existsSync(c));
  if (!script) return false;

  try {
    const logDir = join(homedir(), ".local", "state", "cco");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "agy-proxy-opencorp.log");
    const out = openSync(logFile, "a");

    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, CCO_AGY_PORT: "4810" },
    });
    child.unref();

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(saude, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {}
    }
  } catch (erro) {
    console.error(`[agy-proxy] falha ao iniciar proxy sob demanda: ${String(erro)}`);
  }

  return false;
}

function lerChaveEnvCco(nomeVar: string): string {
  const doEnv = process.env[nomeVar]?.trim();
  if (doEnv) return doEnv;
  const caminhosEnv = [
    process.env.CCO_DIR ? join(process.env.CCO_DIR, ".env") : null,
    join(homedir(), "Documentos", "GitHub", "claude-code-open", ".env"),
  ].filter(Boolean) as string[];
  for (const arq of caminhosEnv) {
    if (!existsSync(arq)) continue;
    try {
      const linhas = readFileSync(arq, "utf8").split("\n");
      for (const linha of linhas) {
        const l = linha.trim();
        if (!l || l.startsWith("#")) continue;
        const i = l.indexOf("=");
        if (i <= 0) continue;
        if (l.slice(0, i).trim() === nomeVar) {
          const val = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
          if (val) return val;
        }
      }
    } catch {
      /* ignora erro de leitura */
    }
  }
  return "";
}

/**
 * Garante que o proxy local NVIDIA NIM (porta 4821 via cco proxy/openai) esteja rodando sob demanda.
 */
export async function garantirNvidiaDaemon(baseUrl = "http://127.0.0.1:4821"): Promise<boolean> {
  const saude = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/health`;
  try {
    const res = await fetch(saude, { signal: AbortSignal.timeout(1500) });
    if (res.ok) return true;
  } catch {
    /* proxy parado — iniciaremos abaixo */
  }

  const caminhos = [
    process.env.CCO_DIR ? join(process.env.CCO_DIR, "proxy", "openai", "server.mjs") : null,
    join(homedir(), "Documentos", "GitHub", "claude-code-open", "proxy", "openai", "server.mjs"),
  ].filter(Boolean) as string[];

  const script = caminhos.find((c) => existsSync(c));
  const chave = lerChaveEnvCco("NVIDIA_API_KEY");
  if (!script || !chave) return false;

  let porta = "4821";
  try {
    const u = new URL(baseUrl);
    if (u.port) porta = u.port;
  } catch {}

  try {
    const logDir = join(homedir(), ".local", "state", "cco");
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, "nvidia-proxy-opencorp.log");
    const out = openSync(logFile, "a");

    const child = spawn(process.execPath, [script], {
      detached: true,
      stdio: ["ignore", out, out],
      env: {
        ...process.env,
        NVIDIA_API_KEY: chave,
        CCO_OPENAI_PORT: porta,
        CCO_OPENAI_NOME: "nvidia",
        CCO_OPENAI_BASE: "https://integrate.api.nvidia.com/v1",
        CCO_OPENAI_KEY_VAR: "NVIDIA_API_KEY",
        CCO_OPENAI_CATALOGO: "nvidia",
      },
    });
    child.unref();

    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(saude, { signal: AbortSignal.timeout(1000) });
        if (res.ok) return true;
      } catch {}
    }
  } catch (erro) {
    console.error(`[nvidia-proxy] falha ao iniciar proxy sob demanda: ${String(erro)}`);
  }

  return false;
}

/**
 * Inicia sob demanda qualquer daemon/proxy local conhecido (LLMs2API na 11435, AGY na 4810 ou NVIDIA NIM na 4821).
 * Devolve `true` se não for daemon local ou se o daemon estiver saudável; `false` se o daemon local falhou ao subir.
 */
export async function garantirDaemonLocal(baseUrl?: string): Promise<boolean> {
  if (!baseUrl) return true;
  if (baseUrl.includes("11435") || /llms2api/i.test(baseUrl)) {
    return await garantirLlms2apiDaemon(baseUrl);
  }
  if (baseUrl.includes("4810") || /agy/i.test(baseUrl)) {
    return await garantirAgyDaemon(baseUrl);
  }
  if (baseUrl.includes("4821") || /nvidia/i.test(baseUrl)) {
    return await garantirNvidiaDaemon(baseUrl);
  }
  return true;
}
