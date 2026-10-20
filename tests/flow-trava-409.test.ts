import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FlowStore } from "../src/core/contexts/orchestration/flow-store.js";

describe("FlowStore.emExecucao", () => {
  let ws: string;
  beforeEach(async () => {
    ws = await mkdtemp(join(tmpdir(), "flowlock-"));
    await mkdir(join(ws, ".opencorp", "locks"), { recursive: true });
  });
  afterEach(() => rm(ws, { recursive: true, force: true }));

  const store = () => new FlowStore();

  it("sem trava: não está em execução", () => {
    expect(store().emExecucao(ws, "f")).toBeNull();
  });

  it("trava de processo vivo: devolve o dono", async () => {
    await writeFile(join(ws, ".opencorp", "locks", "executando-f.json"), JSON.stringify({ pid: process.pid, inicio: "agora" }));
    expect(store().emExecucao(ws, "f")).toEqual({ pid: process.pid, inicio: "agora" });
  });

  it("trava de processo morto: é ignorada", async () => {
    await writeFile(join(ws, ".opencorp", "locks", "executando-f.json"), JSON.stringify({ pid: 2 ** 22 + 12345 }));
    expect(store().emExecucao(ws, "f")).toBeNull();
  });
});
