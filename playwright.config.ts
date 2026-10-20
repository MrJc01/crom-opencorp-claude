import { defineConfig, devices } from "@playwright/test";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fakeOpencodePath = resolve(__dirname, "tests", "fixtures", "fake-opencode.mjs");
// `opencode` falso com o protocolo atual (prompt_async + SSE), resolvido via PATH
// como o binário real (settings.binary_path → PATH → instalação gerenciada).
const fakeEngineBin = resolve(__dirname, "tests", "e2e", "fixtures", "bin");

// A máquina do dono roda renderização de vídeo o tempo todo (carga média 12–17 em 24 núcleos).
// Todos os tempos de espera escalam por um fator único (padrão 3); retries ficam em 0 para não esconder flake.
const fator = Math.max(1, Number(process.env.E2E_TIMEOUT_FACTOR ?? 3) || 3);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000 * fator,
  expect: { timeout: 5_000 * fator },
  retries: 0,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4399",
    headless: true,
    trace: "retain-on-failure",
    actionTimeout: 10_000 * fator,
    navigationTimeout: 30_000 * fator,
  },
  webServer: {
    command: "node bin/opencorp.mjs serve --port 4399 --token test-e2e --foreground",
    url: "http://127.0.0.1:4399/health",
    reuseExistingServer: !process.env.CI,
    env: {
      OPENCORP_HOME: "/dev/shm/opencorp-e2e",
      OPENCODE_SERVER_BIN: fakeOpencodePath,
      OPENHEINERSS_BIN: resolve(fakeEngineBin, "openheinerss"),
      PATH: `${fakeEngineBin}:${process.env.PATH ?? ""}`,
      // Chave fictícia: o preflight exige credencial do OpenCode; o fake nunca a usa.
      OPENROUTER_API_KEY: "sk-or-e2e-fake-key",
    },
    timeout: 120_000,
  },
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Permite usar um Chromium já instalado (ex.: PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome).
        ...(process.env.PW_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } } : {}),
      },
    },
  ],
});