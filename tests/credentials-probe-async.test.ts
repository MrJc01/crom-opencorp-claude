import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkEngineAuthStatusAsync,
  probeCliLoginAsync,
  setCliLoginCommandRunner,
} from "../src/core/engines/credentials-bridge.js";

let home: string;
const salvo = { ...process.env };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oc-probe-"));
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CURSOR_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "OPENCORP_CLAUDE_CONFIG_DIR"]) delete process.env[k];
});

afterEach(() => {
  setCliLoginCommandRunner(undefined);
  Object.assign(process.env, salvo);
  rmSync(home, { recursive: true, force: true });
});

describe("probes de login assíncronos", () => {
  it("probeCliLoginAsync usa o mesmo executor e guarda em cache, com uma execução simultânea", async () => {
    let chamadas = 0;
    setCliLoginCommandRunner(() => {
      chamadas++;
      return { code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" }) };
    });
    const [a, b] = await Promise.all([probeCliLoginAsync("claude-code", home), probeCliLoginAsync("claude-code", home)]);
    expect(a).toMatchObject({ loggedIn: true, details: "max" });
    expect(b).toEqual(a);
    await probeCliLoginAsync("claude-code", home);
    expect(chamadas).toBe(1);
    expect(await probeCliLoginAsync("antigravity", home)).toBeUndefined();
  });

  it("checkEngineAuthStatusAsync devolve o mesmo que a versão síncrona", async () => {
    setCliLoginCommandRunner(() => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: "pro" }) }));
    expect(await checkEngineAuthStatusAsync("claude-code", home)).toMatchObject({ authenticated: true, details: "pro" });
    setCliLoginCommandRunner(() => ({ code: 1, stdout: "" }));
    expect(await checkEngineAuthStatusAsync("copilot", home)).toMatchObject({ authenticated: false });
    expect((await checkEngineAuthStatusAsync("openheinerss", home)).authenticated).toBe(true);
  });

  it("aceitarVencido devolve o último valor conhecido sem esperar o CLI", async () => {
    setCliLoginCommandRunner(() => ({ code: 0, stdout: JSON.stringify({ loggedIn: true }) }));
    await checkEngineAuthStatusAsync("claude-code", home);
    const lento = new Promise<void>(() => undefined);
    // CLI "travado": o cache é do runner antigo; a leitura com aceitarVencido não pode esperar nada
    const r = await Promise.race([checkEngineAuthStatusAsync("claude-code", home, { aceitarVencido: true }), lento.then(() => "travou")]);
    expect(r).toMatchObject({ authenticated: true });
  });

  it("CLI lento de verdade não congela o event loop (executor assíncrono padrão)", async () => {
    mkdirSync(join(home, ".opencorp", "bin"), { recursive: true });
    const bin = join(home, ".opencorp", "bin", "claude");
    writeFileSync(bin, '#!/bin/sh\nsleep 1.5\necho \'{"loggedIn":true,"subscriptionType":"pro"}\'\n');
    chmodSync(bin, 0o755);
    let maiorAtraso = 0;
    let ultimo = Date.now();
    const t = setInterval(() => {
      const agora = Date.now();
      maiorAtraso = Math.max(maiorAtraso, agora - ultimo - 20);
      ultimo = agora;
    }, 20);
    try {
      const r = await probeCliLoginAsync("claude-code", home);
      expect(r).toMatchObject({ loggedIn: true });
    } finally {
      clearInterval(t);
    }
    expect(maiorAtraso).toBeLessThan(400);
  });
});
