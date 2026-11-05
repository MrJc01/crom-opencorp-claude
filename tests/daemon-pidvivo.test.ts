import { afterAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { pidVivo } from "../src/cli/commands/daemon.js";

const filhos: ChildProcess[] = [];
afterAll(() => {
  for (const f of filhos) f.kill();
});

function processo(args: string[]): number {
  const f = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", ...args], { stdio: "ignore" });
  filhos.push(f);
  return f.pid!;
}

describe("pidVivo do daemon", () => {
  it("aceita um processo do OpenCorp vivo", async () => {
    const pid = processo(["opencorp-teste-daemon"]);
    await new Promise((r) => setTimeout(r, 150));
    expect(await pidVivo(pid)).toBe(true);
  });

  it("recusa um PID vivo que é de outro programa (pidfile obsoleto)", async () => {
    const pid = processo(["outro-programa-qualquer"]);
    await new Promise((r) => setTimeout(r, 150));
    expect(await pidVivo(pid)).toBe(false);
  });

  it("recusa um PID que não existe", async () => {
    expect(await pidVivo(2_000_000_000)).toBe(false);
  });
});
