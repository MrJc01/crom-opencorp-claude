import { spawn } from "node:child_process";

export interface ResultadoSpawn {
  /** código de saída; null quando morto por sinal/timeout */
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/**
 * Equivalente assíncrono de `spawnSync` para caminhos de requisição HTTP: o event loop segue livre
 * enquanto `git clone`/`tar`/`gh` rodam. `timeoutMs` mata o processo (SIGKILL) e devolve `status: null`.
 */
export function spawnAsync(
  bin: string,
  args: string[],
  opcoes: { timeoutMs?: number; cwd?: string } = {},
): Promise<ResultadoSpawn> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let terminou = false;
    const fim = (r: ResultadoSpawn) => {
      if (terminou) return;
      terminou = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn(bin, args, { cwd: opcoes.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fim({ status: null, stdout, stderr, error: new Error(`${bin} excedeu ${opcoes.timeoutMs} ms`) });
    }, opcoes.timeoutMs ?? 5 * 60_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => fim({ status: null, stdout, stderr, error }));
    child.on("close", (status) => fim({ status, stdout, stderr }));
  });
}
