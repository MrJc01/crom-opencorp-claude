/**
 * Comando daemon — supervisor único do opencorp.
 *
 * `opencorp daemon start` sobe um processo supervisor que garante:
 *   - scheduler daemon vivo (tick das rotinas — o pulso diário)
 *   - API/serve vivo (opcional, --com-serve)
 * Health-check periódico + restart com backoff; mata órfãos de boot falho.
 *
 * Pidfile: ~/.opencorp/daemon.pid  ·  Log: ~/.opencorp/logs/daemon.log
 */

import type { Command } from "commander";
import { join, resolve } from "node:path";
import { existsSync, openSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { spawn, execSync } from "node:child_process";
import { mkdirRecursive, writeFileAtomic } from "../../utils/fs-safe.js";
import { opencorpHome, projectRoot } from "../../utils/paths.js";
import { spawnDaemon } from "./serve.js";

const PIDFILE = "daemon.pid";
const TICK_SEG = 15;

interface DaemonPidInfo {
  pid: number;
  iniciado_em: string;
}

function pidPath(home: string): string {
  return join(home, ".opencorp", PIDFILE);
}

function schedulerPidPath(home: string): string {
  return join(home, ".opencorp", "scheduler.pid");
}

async function pidVivo(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function lerJson<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function lerPidScheduler(home: string): Promise<number | null> {
  const info = await lerJson<{ pid?: number }>(schedulerPidPath(home));
  if (!info?.pid || !(await pidVivo(info.pid))) return null;
  return info.pid;
}

async function loopSupervisor(home: string, comServe: boolean, host?: string): Promise<void> {
  const reinicios = new Map<string, number>();
  const log = (msg: string): void => {
    console.log(`[daemon] ${new Date().toISOString()} ${msg}`);
  };
  log(`supervisor ativo (pid ${process.pid}) — tick a cada ${TICK_SEG}s${comServe ? " · com serve" : ""}`);

  // Pid e instante do último scheduler lançado por este supervisor. O pidfile é reescrito
  // pelo próprio scheduler e pode estar defasado; sem isso o supervisor lançava duplicatas.
  let filhoSchedulerPid: number | undefined;
  let filhoSchedulerEm = 0;
  const CARENCIA_SCHEDULER_MS = 90_000;

  setInterval(() => {
    void (async () => {
      // 1. scheduler (o pulso)
      const vivoPorPidfile = await lerPidScheduler(home);
      const vivoFilho = filhoSchedulerPid !== undefined && (await pidVivo(filhoSchedulerPid));
      const emCarencia = Date.now() - filhoSchedulerEm < CARENCIA_SCHEDULER_MS;
      if (!vivoPorPidfile && !vivoFilho && !emCarencia) {
        const tentativas = (reinicios.get("scheduler") ?? 0) + 1;
        reinicios.set("scheduler", tentativas);
        log(`scheduler morto — reiniciando (tentativa ${tentativas})`);
        try {
          let bin = process.argv[1];
          if (!bin || !existsSync(bin)) {
            bin = resolve(import.meta.dirname ?? ".", "..", "..", "..", "bin", "opencorp.mjs");
          }
          if (!existsSync(bin)) {
            const fallback = resolve(process.cwd(), "bin", "opencorp.mjs");
            if (existsSync(fallback)) bin = fallback;
          }
          const logFd = openSync(join(home, "logs", "scheduler-daemon.log"), "a");
          const filho = spawn(process.execPath, [bin, "scheduler", "start", "--foreground", "--intervalo-seg", "30"], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
          });
          filho.unref();
          filhoSchedulerPid = filho.pid;
          filhoSchedulerEm = Date.now();
          log(`scheduler reiniciado (pid ${filho.pid ?? 0})`);
        } catch (erro) {
          log(`falha ao reiniciar scheduler: ${erro instanceof Error ? erro.message : erro}`);
        }
      } else {
        reinicios.set("scheduler", 0);
      }
      // 2. serve (opcional)
      if (comServe) {
        const apiInfo = await lerJson<{ pid?: number }>(join(home, ".opencorp", "api.pid"));
        if (!apiInfo?.pid || !(await pidVivo(apiInfo.pid))) {
          log("serve morto — reiniciando");
          const serveArgs = [process.argv[1] ?? "opencorp", "serve", "--host", host ?? "0.0.0.0"];
          spawn(process.execPath, serveArgs, {
            detached: true,
            stdio: "ignore",
          }).unref();
        }
      }
    })();
  }, TICK_SEG * 1000);
}

export function registerDaemonCommand(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("supervisor único: mantém scheduler (+ serve opcional) vivos — o pulso diário à prova de reboot");

  daemon
    .command("start")
    .option("--foreground", "roda o supervisor em primeiro plano (debug)")
    .option("--com-serve", "também supervisiona a API/serve")
    .option("--host <host>", "interface de escuta do serve (ex: 0.0.0.0 para rede local)")
    .description("inicia o supervisor (padrão: background)")
    .action((opts: { foreground?: boolean; comServe?: boolean; host?: string }) =>
      (async () => {
        const home = opencorpHome();
        const existente = await lerJson<DaemonPidInfo>(pidPath(home));
        if (existente?.pid && (await pidVivo(existente.pid))) {
          console.log(`daemon já ativo (pid ${existente.pid})`);
          return;
        }
        if (opts.foreground) {
          const info: DaemonPidInfo = { pid: process.pid, iniciado_em: new Date().toISOString() };
          await writeFileAtomic(pidPath(home), `${JSON.stringify(info, null, 2)}\n`);
          await loopSupervisor(home, opts.comServe ?? false, opts.host);
          return; // setInterval mantém o processo vivo
        }
        const logPath = join(home, "logs", "daemon.log");
        await mkdirRecursive(join(home, "logs"));
        const argv = [process.argv[1] ?? "", "daemon", "start", "--foreground"];
        if (opts.comServe) argv.push("--com-serve");
        if (opts.host) argv.push("--host", opts.host);
        const pid = await spawnDaemon(argv.filter((a) => a), logPath);
        // o pidfile é gravado pelo próprio filho (foreground) — gravar aqui causa corrida
        // (filho vê o pidfile "já ativo" com o próprio pid e sai)
        console.log(`ok: daemon em background (pid ${pid}) — log: ${logPath}`);
      })().catch((erro: unknown) => {
        console.error(`erro: ${erro instanceof Error ? erro.message : erro}`);
        process.exitCode = 1;
      }),
    );

  daemon
    .command("install")
    .option("--com-serve", "também supervisiona a API/serve (padrão no serviço)")
    .option("--host <host>", "interface de escuta do serve (padrão 0.0.0.0)", "0.0.0.0")
    .description("instala e ativa serviço systemd do usuário — sobrevive a reboot/logout")
    .action((opts: { comServe?: boolean; host?: string }) =>
      (async () => {
        const home = opencorpHome();
        const workDir = projectRoot();
        const bin = join(workDir, "bin", "opencorp.mjs");
        if (!existsSync(bin)) {
          console.error(`erro: binário não encontrado em ${bin}`);
          process.exitCode = 1;
          return;
        }
        const unitDir = join(home, ".config", "systemd", "user");
        const unitPath = join(unitDir, "opencorp-daemon.service");
        await mkdirRecursive(unitDir);

        // para o daemon em background (o serviço systemd assume; pidfile único evita briga)
        const existente = await lerJson<DaemonPidInfo>(pidPath(home));
        if (existente?.pid && (await pidVivo(existente.pid))) {
          try {
            process.kill(existente.pid, "SIGTERM");
            await rm(pidPath(home), { force: true });
            console.log(`daemon em background (pid ${existente.pid}) parado — assume o serviço systemd`);
          } catch {
            /* já morreu */
          }
        }

        const args = ["daemon", "start", "--foreground"];
        if (opts.comServe !== false) args.push("--com-serve");
        args.push("--host", opts.host ?? "0.0.0.0");
        // PATH do processo que instala (inclui ~/.opencode/bin e node) — sem isso o scheduler
        // sob o systemd não encontra o binário `opencode` e todo agente falha em ~28ms (ENOENT)
        const pathDoAmbiente = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
        const unit = `# gerado por "opencorp daemon install" — edite com cuidado
[Unit]
Description=opencorp daemon (scheduler + serve supervisionados)
After=network-online.target

[Service]
Type=simple
ExecStart=${process.execPath} ${bin} ${args.join(" ")}
WorkingDirectory=${workDir}
Environment=OPENCORP_HOME=${home}
Environment=PATH=${pathDoAmbiente}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
        await writeFileAtomic(unitPath, unit);

        const systemctl = (a: string): string =>
          execSync(`env XDG_RUNTIME_DIR=/run/user/${process.getuid?.() ?? 1000} systemctl --user ${a}`, {
            encoding: "utf8",
          }).trim();

        systemctl("daemon-reload");
        systemctl("enable --now opencorp-daemon");
        console.log(`ok: serviço systemd instalado e ativo (${unitPath})`);

        // linger: mantém os serviços do usuário vivos mesmo sem sessão gráfica (best-effort)
        try {
          execSync(`loginctl enable-linger ${process.getuid?.() ?? 1000}`, { stdio: "ignore" });
          console.log("ok: linger ativado — serviços vivem mesmo sem sessão aberta");
        } catch {
          console.log("aviso: não consegui ativar linger (rode `sudo loginctl enable-linger $USER`) — serviços só sobem no login");
        }
        try {
          console.log("---");
          console.log(systemctl("status opencorp-daemon --no-pager -n 3"));
        } catch {
          /* status é informativo */
        }
      })().catch((erro: unknown) => {
        console.error(`erro: ${erro instanceof Error ? erro.message : erro}`);
        process.exitCode = 1;
      }),
    );

  daemon
    .command("uninstall")
    .description("remove o serviço systemd do usuário")
    .action(() =>
      (async () => {
        const home = opencorpHome();
        const unitPath = join(home, ".config", "systemd", "user", "opencorp-daemon.service");
        const systemctl = (a: string): string =>
          execSync(`env XDG_RUNTIME_DIR=/run/user/${process.getuid?.() ?? 1000} systemctl --user ${a}`, {
            encoding: "utf8",
          }).trim();
        try {
          systemctl("disable --now opencorp-daemon");
        } catch {
          /* serviço não existia */
        }
        await rm(unitPath, { force: true });
        try {
          systemctl("daemon-reload");
        } catch {
          /* best-effort */
        }
        console.log("ok: serviço systemd removido");
      })().catch((erro: unknown) => {
        console.error(`erro: ${erro instanceof Error ? erro.message : erro}`);
        process.exitCode = 1;
      }),
    );

  daemon
    .command("stop")
    .description("para o supervisor (os filhos continuam rodando)")
    .action(() =>
      (async () => {
        const home = opencorpHome();
        const info = await lerJson<DaemonPidInfo>(pidPath(home));
        if (!info?.pid || !(await pidVivo(info.pid))) {
          console.log("daemon não está rodando");
          await rm(pidPath(home), { force: true });
          return;
        }
        process.kill(info.pid, "SIGTERM");
        await rm(pidPath(home), { force: true });
        console.log(`ok: daemon (pid ${info.pid}) parado`);
      })().catch((erro: unknown) => {
        console.error(`erro: ${erro instanceof Error ? erro.message : erro}`);
        process.exitCode = 1;
      }),
    );

  daemon
    .command("status")
    .description("estado do supervisor e dos filhos")
    .action(() =>
      (async () => {
        const home = opencorpHome();
        const info = await lerJson<DaemonPidInfo>(pidPath(home));
        const daemonVivo = !!info?.pid && (await pidVivo(info.pid));
        const schedPid = await lerPidScheduler(home);
        console.log(`daemon: ${daemonVivo ? `ativo (pid ${info!.pid})` : "parado"}`);
        console.log(`scheduler: ${schedPid ? `vivo (pid ${schedPid})` : "morto"}`);
        const serveInfo = await lerJson<{ pid?: number; porta?: number }>(join(home, ".opencorp", "api.pid"));
        const serveVivo = !!serveInfo?.pid && (await pidVivo(serveInfo.pid));
        console.log(`serve: ${serveVivo ? `vivo (pid ${serveInfo!.pid}${serveInfo!.porta ? ", porta " + serveInfo!.porta : ""})` : "parado"}`);
      })().catch((erro: unknown) => {
        console.error(`erro: ${erro instanceof Error ? erro.message : erro}`);
        process.exitCode = 1;
      }),
    );
}
