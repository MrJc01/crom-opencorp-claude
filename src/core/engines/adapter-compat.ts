import { checkEngineAuthStatusAsync, probeCliLoginAsync } from "./credentials-bridge.js";
import { spawn } from "node:child_process";
import type { AgentEvent } from "./events.js";
import { normalizeEngineError } from "./error-normalizer.js";
import {
  CANONICAL_ENGINE_MANIFESTS,
  validateEngineCapabilityManifest,
  type EngineCapabilityManifest,
} from "./manifests.js";
import type {
  AgentRunInput,
  AgentRunner,
  EngineAdapter,
  EngineAuthenticator,
  EngineAuthStatus,
  EngineInstaller,
  EngineInstallResult,
  ModelCatalogSource,
  ModelDescriptor,
} from "./ports.js";
import type { EngineDriver, EngineInstallStatus, EngineTokenUsage } from "./types.js";

export class LegacyDriverAdapter implements EngineAdapter {
  readonly engineId: string;
  readonly name: string;
  readonly manifest: EngineCapabilityManifest;
  readonly installer: EngineInstaller;
  readonly authenticator: EngineAuthenticator;
  readonly runner: AgentRunner;
  readonly modelCatalog?: ModelCatalogSource;

  constructor(
    readonly driver: EngineDriver,
    customManifest?: EngineCapabilityManifest
  ) {
    this.engineId = driver.id;
    this.name = driver.name;

    const manifestCandidate =
      customManifest ||
      CANONICAL_ENGINE_MANIFESTS[driver.id] || {
        engineId: driver.id,
        name: driver.name,
        transport: driver.category === "daemon" ? "http_server" : "spawn_cli",
        features: {
          streaming: { level: "declared" },
          continuation: { level: "unsupported" },
          fork: { level: "unsupported" },
          hitl: { level: "declared" },
          tools: { level: "declared" },
          mcp: { level: "unsupported" },
          images: { level: "unsupported" },
          cancellation: { level: "integrated" },
        },
      };

    this.manifest = validateEngineCapabilityManifest(manifestCandidate);

    // 1. Porta de Instalação
    this.installer = {
      engineId: this.engineId,
      status: async (homeDir: string): Promise<EngineInstallStatus> => {
        return this.driver.isInstalled(homeDir);
      },
      install: async (
        homeDir: string,
        onProgress?: (msg: string) => void
      ): Promise<EngineInstallResult> => {
        return this.driver.install(homeDir, onProgress);
      },
    };

    // 2. Porta de Autenticação / Tokens
    this.authenticator = {
      engineId: this.engineId,
      // Autenticação ≠ saúde do binário: usa chaves/contas do OpenCorp e o
      // comando oficial de status do CLI, sem ler arquivos internos.
      status: (homeDir: string): Promise<EngineAuthStatus> => checkEngineAuthStatusAsync(this.engineId, homeDir),
      isLoggedIn: async (homeDir: string) => (await probeCliLoginAsync(this.engineId, homeDir))?.loggedIn,
      fetchTokens: async (
        homeDir: string,
        creds?: { tokenOuChave?: string; authType?: string }
      ): Promise<EngineTokenUsage> => {
        return this.driver.fetchLiveTokens(homeDir, creds);
      },
    };

    // 3. Porta de Execução Pontual (AgentRunner com eventos canônicos)
    this.runner = {
      engineId: this.engineId,
      run: async function* (input: AgentRunInput, signal?: AbortSignal): AsyncIterable<AgentEvent> {
        const runId = input.runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const timestamp = new Date().toISOString();

        yield {
          type: "run.started",
          runId,
          timestamp,
          engineId: driver.id,
        };

        let prepared: { binary: string; args: string[]; env: Record<string, string>; cwd: string };
        try {
          prepared = await driver.prepareExecution({
            workspaceId: input.workspaceId,
            workspacePath: input.workspacePath,
            sessionId: input.sessionId,
            agentId: input.agentId,
            model: input.model,
            prompt: input.prompt,
            homeDir: input.homeDir,
            envOverrides: input.envOverrides,
            timeoutMs: input.timeoutMs,
            accountId: input.accountId,
          });
        } catch (err: any) {
          const error = normalizeEngineError(err, { engineId: driver.id, modelId: input.model });
          yield {
            type: "run.failed",
            runId,
            error,
            timestamp: new Date().toISOString(),
          };
          return;
        }

        let fullOutput = "";

        try {
          const eventsQueue: AgentEvent[] = [];
          let isDone = false;
          let processError: Error | null = null;

          const child = spawn(prepared.binary, prepared.args, {
            cwd: prepared.cwd,
            env: prepared.env,
            signal,
            stdio: ["ignore", "pipe", "pipe"],
          });

          child.stdout?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            fullOutput += text;
            eventsQueue.push({
              type: "message.delta",
              runId,
              text,
              timestamp: new Date().toISOString(),
            });
          });

          child.stderr?.on("data", (chunk: Buffer) => {
            const text = chunk.toString();
            fullOutput += text;
          });

          const closePromise = new Promise<number>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve(code ?? 0));
          });

          while (!isDone || eventsQueue.length > 0) {
            if (eventsQueue.length > 0) {
              const evt = eventsQueue.shift()!;
              yield evt;
            } else {
              // Verifica se processo encerrou
              const finished = await Promise.race([
                closePromise.then((code) => ({ done: true, code })),
                new Promise<{ done: false }>((r) => setTimeout(() => r({ done: false }), 20)),
              ]).catch((err) => {
                processError = err;
                return { done: true, code: 1 };
              });

              if (finished.done) {
                isDone = true;
                // Esvazia fila restante
                while (eventsQueue.length > 0) {
                  yield eventsQueue.shift()!;
                }

                if (processError) {
                  const error = normalizeEngineError(processError, {
                    engineId: driver.id,
                    modelId: input.model,
                  });
                  yield {
                    type: "run.failed",
                    runId,
                    error,
                    timestamp: new Date().toISOString(),
                  };
                  return;
                }

                if (finished.code !== 0) {
                  const error = normalizeEngineError(
                    new Error(`Processo encerrou com código de saída ${finished.code}: ${fullOutput.slice(-300)}`),
                    { engineId: driver.id, modelId: input.model }
                  );
                  yield {
                    type: "run.failed",
                    runId,
                    error,
                    timestamp: new Date().toISOString(),
                  };
                  return;
                }

                yield {
                  type: "run.completed",
                  runId,
                  result: {
                    output: fullOutput,
                    stopReason: "completed",
                  },
                  timestamp: new Date().toISOString(),
                };
                return;
              }
            }
          }
        } catch (err: any) {
          const error = normalizeEngineError(err, { engineId: driver.id, modelId: input.model });
          yield {
            type: "run.failed",
            runId,
            error,
            timestamp: new Date().toISOString(),
          };
        }
      },
    };

    // 4. Catálogo de Modelos (a partir de hints do driver)
    this.modelCatalog = {
      engineId: this.engineId,
      listModels: async (): Promise<ModelDescriptor[]> => {
        return (driver.supportedModelsHint || []).map((hint) => {
          const slash = hint.indexOf("/");
          const provider = slash !== -1 ? hint.slice(0, slash) : driver.id;
          const id = slash !== -1 ? hint.slice(slash + 1) : hint;
          return {
            id,
            name: hint,
            provider,
            isFree: hint.toLowerCase().includes("free"),
          };
        });
      },
    };
  }
}
