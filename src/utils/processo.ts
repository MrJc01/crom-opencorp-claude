import { readFileSync } from "node:fs";

/**
 * PID existe E é um processo do OpenCorp (opcionalmente de um papel: "daemon", "scheduler", "serve").
 * Pidfiles e travas sobrevivem a um reinício do PC, e depois do boot o mesmo número pode ser de outro programa;
 * sem esta checagem o sistema acha que já está rodando e não sobe (em 2026-10-30 isso parou os canais por 3 h).
 * Sem /proc (ex.: macOS) vale só a existência do PID.
 */
export function processoOpencorpVivo(pid: number, papel?: string): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return /opencorp|\/oc(\.mjs)?\b/.test(cmd) && (!papel || cmd.includes(papel));
  } catch {
    return true;
  }
}

/** Instante em que o processo começou (ms), ou null sem /proc. */
function inicioDoProcesso(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const campos = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(campos[19]);
    const btime = Number(/^btime (\d+)$/m.exec(readFileSync("/proc/stat", "utf8"))?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(btime)) return null;
    return (btime + ticks / 100) * 1000; // USER_HZ é 100 no Linux
  } catch {
    return null;
  }
}

/** Dono de uma trava continua válido: processo do OpenCorp vivo que já existia quando a trava foi criada. */
export function donoDeTravaVivo(pid: number, inicioTrava?: string): boolean {
  if (!processoOpencorpVivo(pid)) return false;
  const criada = inicioTrava ? Date.parse(inicioTrava) : NaN;
  const inicio = inicioDoProcesso(pid);
  if (Number.isNaN(criada) || inicio === null) return true;
  return inicio <= criada + 5_000; // PID reaproveitado por um processo mais novo que a trava: trava órfã
}
