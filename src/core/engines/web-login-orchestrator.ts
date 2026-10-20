import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { engineRegistry } from "./registry.js";
import { checkEngineAuthStatusAsync } from "./credentials-bridge.js";
import { EngineAccountStore } from "./engine-account-store.js";

export interface WebLoginSession {
  sessionId: string;
  motorId: string;
  motorName: string;
  status: "iniciando" | "aguardando_usuario" | "concluido" | "erro" | "cancelado";
  authUrl?: string;
  userCode?: string;
  instrucoes: string;
  iniciadoEm: string;
  expiraEm?: string;
  erro?: string;
  autoInheritAvailable?: boolean;
  autoInheritAccount?: string;
  rawOutput?: string[];
}

interface ActiveProcess {
  session: WebLoginSession;
  child?: ChildProcess;
  timeoutTimer?: NodeJS.Timeout;
}

const activeSessions = new Map<string, ActiveProcess>();

/** execFile com timeout sem bloquear o event loop; devolve stdout+stderr mesmo com saída ≠ 0. */
function executar(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; saida: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true }, (erro, stdout, stderr) => {
      resolve({ ok: !erro, saida: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Localiza o binário mais adequado para o motor especificado
 */
async function findEngineBinary(motorId: string, homeDir: string): Promise<string | null> {
  const localBin = join(homeDir, ".opencorp", "bin", motorId === "cursor" ? "agent" : motorId);
  if (existsSync(localBin)) return localBin;

  const userLocal = join(homeDir, ".local", "bin", motorId === "cursor" ? "agent" : motorId);
  if (existsSync(userLocal)) return userLocal;

  const binName = motorId === "cursor" ? "agent" : motorId;
  const achado = await executar("which", [binName], 1500);
  const out = achado.ok ? achado.saida.trim() : "";
  if (out && existsSync(out)) return out;

  return null;
}

export class WebLoginOrchestrator {
  /**
   * Inicia o fluxo de login interativo web sem terminal para o motor solicitado
   */
  public static async iniciarLogin(motorId: string, homeDir: string): Promise<WebLoginSession> {
    const driver = engineRegistry.get(motorId);
    const motorName = driver?.name || motorId;
    const sessionId = randomUUID();
    const iniciadoEm = new Date().toISOString();

    const session: WebLoginSession = {
      sessionId,
      motorId,
      motorName,
      status: "iniciando",
      instrucoes: `Iniciando autenticação para ${motorName}...`,
      iniciadoEm,
      rawOutput: [],
    };

    const active: ActiveProcess = { session };
    activeSessions.set(sessionId, active);

    // Timeout de segurança: limpa a sessão após 15 minutos
    active.timeoutTimer = setTimeout(() => {
      if (active.child && !active.child.killed) {
        try {
          active.child.kill("SIGTERM");
        } catch {}
      }
      activeSessions.delete(sessionId);
    }, 15 * 60 * 1000);

    switch (motorId) {
      case "codex":
        return this.iniciarCodexLogin(active, homeDir);

      case "cursor":
        return this.iniciarCursorLogin(active, homeDir);

      case "copilot":
        return this.iniciarCopilotLogin(active, homeDir);

      case "claude-code":
        return this.iniciarClaudeLogin(active, homeDir);

      case "antigravity":
        session.status = "aguardando_usuario";
        session.authUrl = "https://aistudio.google.com/app/apikey";
        session.instrucoes = "Acesse o Google AI Studio para obter sua chave Gemini Flash ($0 custo) e insira abaixo.";
        return session;

      case "opencode":
      case "crom-agente":
      default:
        session.status = "aguardando_usuario";
        session.authUrl = "https://openrouter.ai/settings/keys";
        session.instrucoes = "Acesse o OpenRouter para gerar sua chave universal e adicione-a em Conectar Conta.";
        return session;
    }
  }

  /**
   * Codex: executa 'codex login --device-auth' e captura link e código único
   */
  private static async iniciarCodexLogin(active: ActiveProcess, homeDir: string): Promise<WebLoginSession> {
    const session = active.session;
    const bin = await findEngineBinary("codex", homeDir);

    if (!bin) {
      session.status = "aguardando_usuario";
      session.authUrl = "https://platform.openai.com/api-keys";
      session.instrucoes = "OpenAI Codex CLI não encontrado localmente. Acesse a plataforma da OpenAI para gerar sua chave.";
      return session;
    }

    try {
      const child = spawn(bin, ["login", "--device-auth"], {
        cwd: homeDir,
        env: {
          ...process.env,
          CI: "true",
          TERM: "xterm-256color",
        },
      });

      active.child = child;

      let buffer = "";

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        buffer += text;
        session.rawOutput?.push(text);

        const clean = stripAnsi(buffer);

        // Extrai URL: ex: https://auth.openai.com/codex/device
        const urlMatch = /https:\/\/auth\.openai\.com[^\s\)]+/.exec(clean) || /https:\/\/[^\s\)]+/.exec(clean);
        if (urlMatch && !session.authUrl) {
          session.authUrl = urlMatch[0].trim().replace(/[.,;:\u001b]+$/, "");
        }

        // Extrai código: ex: 1GAF-M476W
        const codeMatch = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(clean);
        if (codeMatch && !session.userCode) {
          session.userCode = codeMatch[1].trim();
        }

        if (session.authUrl) {
          session.status = "aguardando_usuario";
          session.instrucoes = session.userCode
            ? `Clique no link abaixo e insira o código ${session.userCode} na página da OpenAI.`
            : "Clique no link abaixo para autorizar no navegador.";
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        session.rawOutput?.push(data.toString());
      });

      child.on("exit", (code) => {
        if (code === 0) {
          session.status = "concluido";
          session.instrucoes = "OpenAI Codex autenticado com sucesso via navegador!";
          // Registra conta no store
          void this.persistirConta(session.motorId, "OpenAI Codex (Device)", homeDir);
        } else if (session.status !== "concluido") {
          void checkEngineAuthStatusAsync("codex", homeDir).then((auth) => {
            if (auth.authenticated && session.status !== "concluido") {
              session.status = "concluido";
              session.instrucoes = "OpenAI Codex autenticado com sucesso!";
            }
          });
        }
      });

      // Aguarda até 1.5s para capturar link e código
      await new Promise((r) => setTimeout(r, 1500));

      if (!session.authUrl) {
        session.authUrl = "https://auth.openai.com/codex/device";
        session.status = "aguardando_usuario";
        session.instrucoes = "Abra o link da OpenAI e verifique a autorização no navegador.";
      }

      return session;
    } catch (err: any) {
      session.status = "erro";
      session.erro = err.message;
      return session;
    }
  }

  /**
   * Cursor: executa 'NO_OPEN_BROWSER=1 agent login' e extrai a URL loginDeepControl
   */
  private static async iniciarCursorLogin(active: ActiveProcess, homeDir: string): Promise<WebLoginSession> {
    const session = active.session;
    const bin = await findEngineBinary("cursor", homeDir);

    if (!bin) {
      session.status = "aguardando_usuario";
      session.authUrl = "https://cursor.com/settings";
      session.instrucoes = "Cursor Agent CLI não detectado. Acesse as configurações da sua conta Cursor.";
      return session;
    }

    try {
      const child = spawn(bin, ["login"], {
        cwd: homeDir,
        env: {
          ...process.env,
          NO_OPEN_BROWSER: "1",
        },
      });

      active.child = child;
      let buffer = "";

      child.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        buffer += text;
        session.rawOutput?.push(text);

        const clean = stripAnsi(buffer);
        // Procura por https://cursor.com/loginDeepControl?...
        const match = /https:\/\/cursor\.com\/loginDeepControl[^\s\)]+/.exec(clean) ||
                      /https:\/\/cursor\.com\/[^\s\)]+/.exec(clean);
        if (match && !session.authUrl) {
          session.authUrl = match[0].trim().replace(/[.,;:\u001b]+$/, "");
          session.status = "aguardando_usuario";
          session.instrucoes = "Clique no link abaixo para fazer login com sua conta Cursor no navegador.";
        }
      });

      child.stderr.on("data", (data: Buffer) => {
        session.rawOutput?.push(data.toString());
      });

      child.on("exit", (code) => {
        if (code === 0) {
          session.status = "concluido";
          session.instrucoes = "Conta Cursor autenticada com sucesso!";
          void this.persistirConta(session.motorId, "Cursor Account (OAuth)", homeDir);
        } else {
          void checkEngineAuthStatusAsync("cursor", homeDir).then((auth) => {
            if (auth.authenticated) {
              session.status = "concluido";
              session.instrucoes = "Conta Cursor autenticada com sucesso!";
            }
          });
        }
      });

      await new Promise((r) => setTimeout(r, 1200));

      if (!session.authUrl) {
        session.authUrl = "https://cursor.com/settings";
        session.status = "aguardando_usuario";
        session.instrucoes = "Acesse o Cursor no link abaixo para autenticar sua conta.";
      }

      return session;
    } catch (err: any) {
      session.status = "erro";
      session.erro = err.message;
      return session;
    }
  }

  /**
   * Copilot: verifica herança imediata do GitHub CLI ou inicia login web via device code
   */
  private static async iniciarCopilotLogin(active: ActiveProcess, _homeDir: string): Promise<WebLoginSession> {
    const session = active.session;

    // 1. Checa se o usuário já tem login no GitHub CLI (`gh auth token`)
    try {
      const ghOut = (await executar("gh", ["auth", "status"], 2000)).saida;
      const contaMatch = /Logged in to github\.com account ([^\s\)]+)/.exec(ghOut);
      if (contaMatch) {
        session.autoInheritAvailable = true;
        session.autoInheritAccount = contaMatch[1];
      }
    } catch {}

    session.authUrl = "https://github.com/login/device";
    session.status = "aguardando_usuario";
    session.instrucoes = session.autoInheritAvailable
      ? `Detectamos sua conta GitHub @${session.autoInheritAccount} conectada via GitHub CLI! Você pode conectar com 1 clique ou autorizar via dispositivo.`
      : "Acesse o link do GitHub para autorizar o Copilot CLI.";

    return session;
  }

  /**
   * Claude: executa 'claude auth login' e extrai link OAuth real
   */
  private static async iniciarClaudeLogin(active: ActiveProcess, homeDir: string): Promise<WebLoginSession> {
    const session = active.session;
    const bin = await findEngineBinary("claude", homeDir);

    if (!bin) {
      session.status = "aguardando_usuario";
      session.authUrl = "https://claude.ai/login";
      session.instrucoes = "Claude Code não detectado localmente. Acesse https://claude.ai para entrar.";
      return session;
    }

    try {
      const statusOut = (await executar(bin, ["auth", "status"], 2000)).saida;
      if (statusOut.includes('"loggedIn":true')) {
        session.status = "concluido";
        session.instrucoes = "Claude Code já está autenticado!";
        return session;
      }
    } catch {}

    try {
      const child = spawn(bin, ["auth", "login"], {
        cwd: homeDir,
        env: {
          ...process.env,
          BROWSER: "echo",
          TERM: "xterm-256color",
        },
      });

      active.child = child;

      const handleData = (buffer: string) => {
        session.rawOutput?.push(buffer);
        const clean = stripAnsi(buffer);
        const urlMatch = /https:\/\/claude\.com\/cai\/oauth\/authorize[^\s\)]+/.exec(clean);
        if (urlMatch && !session.authUrl) {
          session.authUrl = urlMatch[0].trim().replace(/[.,;:\u001b]+$/, "");
          session.status = "aguardando_usuario";
          session.instrucoes = "Abra a URL de autenticação do Claude no navegador, autorize e cole o código retornado caso solicitado.";
        }
      };

      child.stdout.on("data", (data: Buffer) => handleData(data.toString()));
      child.stderr.on("data", (data: Buffer) => handleData(data.toString()));

      child.on("exit", (code) => {
        if (code === 0) {
          session.status = "concluido";
          session.instrucoes = "Claude Code autenticado com sucesso!";
          void this.persistirConta("claude-code", "Claude Code (OAuth)", homeDir);
        } else {
          void checkEngineAuthStatusAsync("claude-code", homeDir).then((auth) => {
            if (auth.authenticated) {
              session.status = "concluido";
              session.instrucoes = "Claude Code autenticado com sucesso!";
            }
          });
        }
      });

      await new Promise((r) => setTimeout(r, 1500));

      if (!session.authUrl) {
        session.authUrl = "https://claude.ai/login";
        session.status = "aguardando_usuario";
        session.instrucoes = "Acesse o link do Claude no navegador para autorizar sua conta Pro/Team.";
      }

      return session;
    } catch (err: any) {
      session.status = "erro";
      session.erro = err.message;
      return session;
    }
  }

  /**
   * Envia código / resposta para o processo de login ativo (ex.: Claude ou Device Code)
   */
  public static async enviarCodigo(sessionId: string, codigo: string): Promise<boolean> {
    const active = activeSessions.get(sessionId);
    if (!active || !active.child || !active.child.stdin || active.child.stdin.destroyed) {
      return false;
    }
    try {
      active.child.stdin.write(codigo.trim() + "\n");
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Consulta o status atual de uma sessão de login ativa
   */
  public static async verificarStatus(sessionId: string, homeDir: string): Promise<WebLoginSession> {
    const active = activeSessions.get(sessionId);
    if (!active) {
      throw new Error(`Sessão de login "${sessionId}" não encontrada ou expirada.`);
    }

    const session = active.session;

    if (session.status === "concluido") {
      return session;
    }

    // Checa se o motor já atingiu status autenticado no sistema
    const auth = await checkEngineAuthStatusAsync(session.motorId, homeDir);
    if (auth.authenticated) {
      session.status = "concluido";
      session.instrucoes = `Autenticado com sucesso! (${auth.method})`;
      if (active.child && !active.child.killed) {
        try {
          active.child.kill("SIGTERM");
        } catch {}
      }
      void this.persistirConta(session.motorId, `${session.motorName} (Web Auth)`, homeDir);
      return session;
    }

    // Se o processo filho terminou
    if (active.child && active.child.exitCode !== null) {
      if (active.child.exitCode === 0) {
        session.status = "concluido";
        session.instrucoes = "Autenticação concluída com sucesso!";
        void this.persistirConta(session.motorId, `${session.motorName} (Web Auth)`, homeDir);
      } else if (session.status !== "aguardando_usuario") {
        session.status = "erro";
        session.erro = `Processo encerrou com código ${active.child.exitCode}`;
      }
    }

    return session;
  }

  /**
   * Herda credencial automaticamente (ex.: do GitHub CLI para o Copilot) com 1 clique
   */
  public static async conectarAutomatico(motorId: string, homeDir: string): Promise<{ ok: boolean; message: string }> {
    if (motorId === "copilot") {
      try {
        const tk = await executar("gh", ["auth", "token"], 2500);
        if (!tk.ok) throw new Error("gh auth token falhou");
        const token = tk.saida.trim();
        if (token && token.startsWith("gh")) {
          const store = new EngineAccountStore({ homeDir });
          await store.adicionarConta("copilot", {
            nome: "GitHub CLI (Herdado)",
            authType: "token",
            tokenOuChave: token,
            limits: {
              timeout_min: 15,
              max_turns: 30,
              rate_limit_rpm: 30,
              daily_cost_usd: 10,
              fallback_action: "rotate",
            },
          });
          return { ok: true, message: "Token do GitHub CLI importado com sucesso para o Copilot!" };
        }
      } catch (err: any) {
        throw new Error(`Falha ao importar do GitHub CLI: ${err.message}`);
      }
    }

    throw new Error(`Conexão automática não disponível para o motor "${motorId}"`);
  }

  /**
   * Cancela uma sessão de login ativa
   */
  public static async cancelarLogin(sessionId: string): Promise<void> {
    const active = activeSessions.get(sessionId);
    if (active) {
      if (active.child && !active.child.killed) {
        try {
          active.child.kill("SIGTERM");
        } catch {}
      }
      if (active.timeoutTimer) clearTimeout(active.timeoutTimer);
      active.session.status = "cancelado";
      activeSessions.delete(sessionId);
    }
  }

  /**
   * Auxiliar para persistir conta caso não exista
   */
  private static async persistirConta(motorId: string, nome: string, homeDir: string): Promise<void> {
    try {
      const store = new EngineAccountStore({ homeDir });
      const existentes = await store.listar(motorId);
      if (existentes.length === 0) {
        await store.adicionarConta(motorId, {
          nome,
          authType: "deviceOAuth",
          limits: {
            timeout_min: 20,
            max_turns: 40,
            rate_limit_rpm: 30,
            daily_cost_usd: 15,
            fallback_action: "rotate",
          },
        });
      }
    } catch {}
  }
}
