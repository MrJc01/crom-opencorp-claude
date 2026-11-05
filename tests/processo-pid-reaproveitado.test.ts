import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { donoDeTravaVivo, processoOpencorpVivo } from "../src/utils/processo.js";
import { FlowStore } from "../src/core/contexts/orchestration/flow-store.js";

const filhos: ChildProcess[] = [];
function outroPrograma(): number {
  const f = spawn("sleep", ["30"], { stdio: "ignore" });
  filhos.push(f);
  return f.pid!;
}
afterEach(() => {
  for (const f of filhos.splice(0)) f.kill();
});

describe("PID reaproveitado depois de reiniciar o PC", () => {
  it("processo de outro programa não conta como OpenCorp", () => {
    expect(processoOpencorpVivo(outroPrograma())).toBe(false);
  });

  it("papel diferente não conta (pidfile do daemon apontando para outro processo do OpenCorp)", () => {
    expect(processoOpencorpVivo(process.pid, "papel-que-nao-existe")).toBe(false);
  });

  it("trava criada antes de o processo existir é órfã", () => {
    expect(donoDeTravaVivo(process.pid, "2020-01-01T00:00:00.000Z")).toBe(false);
    expect(donoDeTravaVivo(process.pid, new Date().toISOString())).toBe(true);
  });

  it("flow não fica preso em trava cujo PID virou outro programa", () => {
    const ws = mkdtempSync(join(tmpdir(), "oc-trava-"));
    mkdirSync(join(ws, ".opencorp", "locks"), { recursive: true });
    writeFileSync(join(ws, ".opencorp", "locks", "executando-f.json"), JSON.stringify({ pid: outroPrograma(), inicio: new Date().toISOString() }));
    expect(new FlowStore().emExecucao(ws, "f")).toBeNull();
    rmSync(ws, { recursive: true, force: true });
  });
});
