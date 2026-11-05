/**
 * Probes reais dos agentes ACP (Copilot e MiMo). Desabilitados por padrão e no CI.
 *
 *   # handshake sem custo (initialize + session/new; sem prompt):
 *   OPENCORP_REAL_PROBES=copilot,mimo npm run test:real
 *   # conversa real (consome cota) — exige modelo explícito:
 *   OPENCORP_REAL_PROBES=mimo OPENCORP_PROBE_MIMO_MODEL=<modelo> npm run test:real
 *
 * Binário: OPENCORP_PROBE_<MOTOR>_BIN ou resolução normal (settings → PATH → gerenciada).
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpAdapter, AcpAgentClient, COPILOT_ACP, MIMO_ACP, engineRegistry, runConversationProbe, spawnAcpProcess } from "../../src/core/engines/index.js";
import { ProcessRegistry } from "../../src/core/runtime/index.js";
import { opencorpHome } from "../../src/utils/paths.js";

const enabled = (process.env.OPENCORP_REAL_PROBES ?? "").split(",").map((s) => s.trim());

for (const vendor of [COPILOT_ACP, MIMO_ACP]) {
  const upper = vendor.engineId.toUpperCase();
  const model = process.env[`OPENCORP_PROBE_${upper}_MODEL`]?.trim();
  const bin = process.env[`OPENCORP_PROBE_${upper}_BIN`]?.trim();

  describe.runIf(enabled.includes(vendor.engineId))(`Probe real ACP — ${vendor.engineId}`, () => {
    const registry = new ProcessRegistry({ idleTimeoutMs: 60_000 });
    const dirs: string[] = [];
    afterAll(async () => {
      await registry.shutdownAll();
      for (const d of dirs) await rm(d, { recursive: true, force: true });
    });

    const launcher: typeof spawnAcpProcess = (opts) => spawnAcpProcess(bin ? { ...opts, command: bin } : opts);

    it("handshake ACP v1 sem prompt", async () => {
      const ws = await mkdtemp(join(tmpdir(), `opencorp-acp-probe-${vendor.engineId}-`));
      dirs.push(ws);
      const command = bin || (await engineRegistry.get(vendor.engineId)!.isInstalled(opencorpHome())).path;
      expect(command, "binário não encontrado").toBeTruthy();
      const transport = await spawnAcpProcess({ command: command!, args: vendor.acpArgs, cwd: ws, env: process.env as Record<string, string> });
      const client = new AcpAgentClient({ engineId: vendor.engineId, transport, clientVersion: "probe" });
      try {
        await client.initialize();
        console.info(`[probe ${vendor.engineId}]`, JSON.stringify({ agent: client.agentInfo, capabilities: client.agentCapabilities }));
        const session = await client.newSession(ws).catch((e) => e);
        if (session instanceof Error) expect((session as any).code).toBe("ENGINE_AUTH_REQUIRED");
        else expect(session.sessionId).toBeTruthy();
      } finally {
        client.close();
      }
    }, 60_000);

    it.runIf(Boolean(model))("conversa com inferência, streaming e continuação sem deixar processo", async () => {
      const ws = await mkdtemp(join(tmpdir(), `opencorp-acp-probe-${vendor.engineId}-`));
      dirs.push(ws);
      const adapter = new AcpAdapter({ vendor, driver: engineRegistry.get(vendor.engineId)!, processRegistry: registry, launcher });
      const report = await runConversationProbe({
        runtime: adapter.conversationRuntime,
        workspaceId: `probe-${vendor.engineId}`,
        workspacePath: ws,
        homeDir: opencorpHome(),
        model: model!,
        maxTotalTokens: Number(process.env.OPENCORP_PROBE_MAX_TOKENS) || undefined,
      });
      console.info(`[probe ${vendor.engineId}]`, JSON.stringify(report));
      expect(report.checks.inference.status).toBe("passed");
      expect(report.checks.streaming.status).toBe("passed");
      expect(report.checks.conversation.status).toBe("passed");
      const pid = registry.get(`${vendor.engineId}::probe-${vendor.engineId}`)?.pid;
      await registry.shutdownAll();
      if (pid) expect(() => process.kill(pid, 0)).toThrow();
    }, 300_000);
  });
}
