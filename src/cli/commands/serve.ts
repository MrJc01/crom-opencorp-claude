import { mkdirRecursive, writeFileAtomic } from "../../utils/fs-safe.js";
import { opencorpHome } from "../../utils/paths.js";
import { tokenAleatorio } from "../../server/index.js";
import { WorkspaceManager } from "../../core/contexts/workspace/workspace-manager.js";
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { openSync } from "node:fs";

const PIDFILE = "api.pid";

function pidPath(home: string): string {
  return join(home, ".opencorp", PIDFILE);
}

interface ApiPidInfo {
  pid: number;
  porta: number;
  token: string;
  workspace?: string;
  iniciado_em: string;
}

async function lerPidfile(home: string): Promise<ApiPidInfo | null> {
  const path = pidPath(home);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as ApiPidInfo;
  } catch {
    return null;
  }
}

async function pidVivo(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gravarPidfile(home: string, info: ApiPidInfo): Promise<void> {
  await writeFileAtomic(pidPath(home), `${JSON.stringify(info, null, 2)}\n`);
}

async function removerPidfile(home: string): Promise<void> {
  const path = pidPath(home);
  if (existsSync(path)) {
    await rm(path, { force: true });
  }
}

async function spawnDaemon(argv: string[], logPath: string): Promise<number> {
  await mkdirRecursive(dirname(logPath));
  const logFd = openSync(logPath, "a");
  const child = spawn(process.execPath, argv, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  return child.pid ?? 0;
}

function dormir(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function esperarPorta(porta: number, timeoutMs = 5000): Promise<boolean> {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${porta}/health`);
      if (res.ok) return true;
    } catch {
      // ignorar e tentar novamente
    }
    await dormir(100);
  }
  return false;
}

export { spawnDaemon, pidPath as apiPidPath, lerPidfile as lerApiPidfile, pidVivo, gravarPidfile as gravarApiPidfile, removerPidfile as removerApiPidfile };

export function registerServeCommand(program: Command): void {
  const serve = program
    .command("serve")
    .description("API headless REST+SSE sobre o core (para a web da Fase C)")
    .option("--port <porta>", "porta (padrão 4100)", "4100")
    .option("--token [token]", "token de acesso — sem a flag: acesso ABERTO; --token (sem valor): gera aleatório e imprime; --token valor: usa o informado")
    .option("--workspace <id>", "workspace padrão da API")
    .option("--host <host>", "interface de escuta (padrão 127.0.0.1; use 0.0.0.0 para rede local)", "127.0.0.1")
    .option("--foreground", "roda em primeiro plano (debug) — padrão: daemonizado em background");

  serve
    .action(
      async (opts: { port?: string; token?: string | boolean; workspace?: string; host?: string; foreground?: boolean }) => {
        const home = opencorpHome();
        // padrão: acesso ABERTO (""). --token sem valor (boolean true) → gera aleatório e imprime.
        // --token valor → usa o informado. (secrets.json deixa de ser fonte do token da API)
        let token = "";
        if (opts.token === true) {
          token = tokenAleatorio();
          console.log(`──────────────────────────────────────────────`);
          console.log(`  token de acesso: ${token}`);
          console.log(`──────────────────────────────────────────────`);
        } else if (typeof opts.token === "string" && opts.token.length > 0) {
          token = opts.token;
        }
        if (token === "") {
          console.log("acesso ABERTO (sem token) — use --token para proteger a API");
        }

        // resolve workspace padrão (para o resolve do ativo funcionar fora de TTY)
        if (opts.workspace) {
          try {
            const manager = new WorkspaceManager();
            const ws = await manager.resolver(opts.workspace);
            process.env.OPENCORP_ACTIVE_WS = ws.id;
          } catch {
            /* segue sem padrão */
          }
        }

        const portaNum = Number(opts.port ?? 4100);

        if (!opts.foreground) {
          // Modo daemon: spawn detached child com --foreground
          const logPath = join(home, "logs", "api-daemon.log");
          const args = [process.argv[1]!, "serve", "--foreground", "--port", String(portaNum), "--host", opts.host ?? "127.0.0.1"];
          // token "" (aberto) não é passado — o filho já nasce aberto por padrão
          if (token !== "") args.push("--token", token);
          if (opts.workspace) args.push("--workspace", opts.workspace);
          const pid = await spawnDaemon(args, logPath);

          // Aguardar a API responder (poll até 5s)
          const ok = await esperarPorta(portaNum, 5000);
          if (!ok) {
            console.error(`erro: API não respondeu em http://127.0.0.1:${portaNum} após 5s — verifique ${logPath}`);
            process.exitCode = 1;
            return;
          }

          // Gravar pidfile
          await gravarPidfile(home, {
            pid,
            porta: portaNum,
            token,
            workspace: opts.workspace,
            iniciado_em: new Date().toISOString(),
          });

          console.log(`ok: API em background em http://127.0.0.1:${portaNum} (pid ${pid}) — logs: ${logPath}`);
          return;
        }

        // --foreground: comportamento atual (loop + SIGINT)
        const { createApiServer } = await import("../../server/index.js");
        const { server, token: tokenFinal, porta: portaPromessa } = createApiServer({
          token,
          workspace: opts.workspace,
        });
        server.listen(portaNum, opts.host ?? "127.0.0.1");
        // Se o event loop travar (CPU ou chamada síncrona), grava a pilha em logs/watchdog-*.json e sai ≠ 0
        // para o supervisor reiniciar. Desligar: OPENCORP_WATCHDOG=0.
        const { vigiarServidor } = await import("../../server/event-loop-watchdog.js");
        vigiarServidor(server, { home });
        const porta = await portaPromessa.catch(() => portaNum);
        console.log(`API em http://127.0.0.1:${porta}`);
        if (token === "") console.log("acesso ABERTO (sem token)");
        else console.log(`token: ${tokenFinal.slice(0, 6)}… (informado via --token)`);
        console.log("Ctrl+C para encerrar");
        process.on("SIGINT", () => {
          console.log("\n[serve] encerrando...");
          server.close(() => process.exit(0));
          setTimeout(() => process.exit(0), 1500).unref();
        });
      },
    );

  serve
    .command("stop")
    .description("envia SIGTERM ao servidor API e limpa o pidfile")
    .action(
      async () => {
        const home = opencorpHome();
        const info = await lerPidfile(home);
        if (!info) {
          console.log("servidor API não está rodando (nenhum pidfile)");
          return;
        }
        if (!(await pidVivo(info.pid))) {
          await removerPidfile(home);
          console.log(`pid ${info.pid} obsoleto — pidfile removido (servidor já estava parado)`);
          return;
        }
        process.kill(info.pid, "SIGTERM");
        for (let i = 0; i < 30; i++) {
          await dormir(100);
          if (!existsSync(pidPath(home))) break;
        }
        await removerPidfile(home);
        console.log(`ok: SIGTERM enviado ao pid ${info.pid} — servidor API parando`);
      },
    );
}