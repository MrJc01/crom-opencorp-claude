import { join } from "node:path";
import type { Command } from "commander";
import {
  Scheduler,
  validarCron,
} from "../../core/contexts/scheduling/scheduler.js";
import { spawnDaemon, pidVivo } from "../../core/contexts/platform/supervisor.js";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { opencorpHome } from "../../utils/paths.js";

function reportar(erro: unknown): void {
  if (erro instanceof Error) {
    const exitCode = (erro as { exitCode?: number }).exitCode;
    console.error(`erro: ${erro.message}`);
    process.exitCode = exitCode ?? 1;
    return;
  }
  console.error(`erro inesperado: ${String(erro)}`);
  process.exitCode = 1;
}

async function comErros(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (erro) {
    reportar(erro);
  }
}

function pidPathScheduler(): string {
  return join(opencorpHome(), ".opencorp", "scheduler.pid");
}

async function lerPid(): Promise<{ pid: number } | null> {
  const path = pidPathScheduler();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as { pid: number };
  } catch {
    return null;
  }
}

export function registerScheduleCommands(program: Command): void {
  const scheduler = new Scheduler();

  const schedule = program
    .command("schedule")
    .description(
      "agendamentos baseados em fluxos — todo agendamento é um fluxo com nó cron. Use 'flow create' para criar novos agendamentos.",
    );

  schedule
    .command("list")
    .option("--workspace <id>", "filtrar por workspace")
    .description("lista os fluxos agendados (com nó cron) de todos os workspaces")
    .action((opts: { workspace?: string }) =>
      comErros(async () => {
        const agendamentos = await scheduler.listarAgendamentos();
        const filtrado = opts.workspace
          ? agendamentos.filter((a) => a.workspace === opts.workspace)
          : agendamentos;
        if (filtrado.length === 0) {
          console.log('nenhum fluxo agendado — crie um flow com nó "cron" via: opencorp flow create --nome "..." e adicione um nó cron');
          return;
        }
        for (const a of filtrado) {
          const status = a.ativo ? "ativo" : "inativo";
          const proxima = a.proxima_exec ? a.proxima_exec.slice(0, 16).replace("T", " ") : "-";
          console.log(`${a.id}  ${status.padEnd(8)}cron "${a.expressao_cron}"`.padEnd(40) + `próxima: ${proxima}  ${a.nome} [ws: ${a.workspace}]`);
        }
      }),
    );

  schedule
    .command("show")
    .argument("<id>", "id do fluxo agendado")
    .description("detalhes do agendamento de um fluxo")
    .action((id: string) =>
      comErros(async () => {
        const agendamentos = await scheduler.listarAgendamentos();
        const encontrado = agendamentos.find((a) => a.id === id);
        if (!encontrado) {
          console.error(`erro: fluxo agendado "${id}" não encontrado — veja "opencorp schedule list"`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(encontrado, null, 2));
      }),
    );

  // ── Daemon commands ─────────────────────────────────────────────────

  const daemon = program
    .command("scheduler")
    .description("daemon do scheduler — executa os fluxos agendados de todos os workspaces");

  daemon
    .command("start")
    .option("--intervalo-seg <n>", "período do tick em segundos (padrão 30)", Number, 30)
    .option("--foreground", "roda em primeiro plano (debug)")
    .description("inicia o daemon (padrão: background com logs)")
    .action((opts: { intervaloSeg: number; foreground?: boolean }) =>
      comErros(async () => {
        const home = opencorpHome();
        const pidfile = pidPathScheduler();
        const anterior = await lerPid();
        if (anterior && (await pidVivo(anterior.pid))) {
          console.log(`erro: scheduler já está rodando (pid ${anterior.pid}) — pare com "opencorp scheduler stop"`);
          process.exitCode = 1;
          return;
        }
        if (opts.foreground) {
          const s = new Scheduler({ homeDir: home });
          // Grava o pidfile antes de qualquer etapa assíncrona: o supervisor lê esse arquivo a cada tick.
          await writeFile(pidfile, JSON.stringify({ pid: process.pid, iniciado: new Date().toISOString() }), "utf8");
          s.iniciar(opts.intervaloSeg, true);
          const agendamentos = await s.listarAgendamentos();
          console.log(`[scheduler] foreground (pid ${process.pid}) — ${agendamentos.length} fluxo(s) agendado(s), tick ${opts.intervaloSeg}s`);
          process.on("SIGINT", () => {
            console.log("\n[scheduler] encerrando...");
            s.parar();
            void unlink(pidfile).then(() => process.exit(0));
          });
          return;
        }
        const bin = process.argv[1]!;
        const logPath = join(home, ".opencorp", "logs", "scheduler-daemon.log");
        const { dirname } = await import("node:path");
        const { mkdirRecursive } = await import("../../utils/fs-safe.js");
        await mkdirRecursive(dirname(logPath));
        const pid = await spawnDaemon(
          [bin, "scheduler", "start", "--foreground", "--intervalo-seg", String(opts.intervaloSeg)],
          logPath,
        );
        console.log(`ok: scheduler iniciado em background (pid ${pid}) — logs: ${logPath}`);
      }),
    );

  daemon
    .command("stop")
    .description("envia SIGTERM ao daemon e limpa o pidfile")
    .action(() =>
      comErros(async () => {
        const pid = await lerPid();
        if (!pid) {
          console.log("scheduler não está rodando");
          return;
        }
        if (!(await pidVivo(pid.pid))) {
          await unlink(pidPathScheduler());
          console.log(`[scheduler] pidfile obsoleto (pid ${pid.pid} não está vivo) — removido`);
          return;
        }
        process.kill(pid.pid, "SIGTERM");
        await unlink(pidPathScheduler());
        console.log(`ok: sinal enviado ao pid ${pid.pid}`);
      }),
    );

  daemon
    .command("status")
    .description("mostra se o daemon está vivo e os próximos fluxos agendados")
    .action(() =>
      comErros(async () => {
        const pid = await lerPid();
        const vivo = pid ? await pidVivo(pid.pid) : false;
        console.log(`daemon: ${pid ? (vivo ? `vivo (pid ${pid.pid})` : `morto (pid ${pid.pid} obsoleto)`) : "parado"}`);
        const agendamentos = await scheduler.listarAgendamentos();
        for (const a of agendamentos.slice(0, 5)) {
          const proxima = a.proxima_exec ? a.proxima_exec.slice(0, 16).replace("T", " ") : "-";
          console.log(`  ${a.id}  cron "${a.expressao_cron}"  próxima: ${proxima}  ${a.nome}`);
        }
      }),
    );
}

export { validarCron };
