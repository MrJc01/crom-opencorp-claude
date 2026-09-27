import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { mkdtemp, rm, symlink, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { dirsDoBinario, SandboxDriver } from "../src/core/contexts/execution/execution-driver.js";
import { SessionManager, type OpcoesRun, type ResultadoRun } from "../src/core/contexts/execution/session-manager.js";
import { WorkspaceManager } from "../src/core/contexts/workspace/workspace-manager.js";
import { EngineAccountStore } from "../src/core/engines/engine-account-store.js";
import { FlowStore } from "../src/core/contexts/orchestration/flow-store.js";

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }));
vi.mock("execa", () => ({ execa: execaMock }));

const raizes: string[] = [];

function fakeChild(opts: { out?: string[]; err?: string[]; exitCode?: number; pid?: number }) {
  const base = Promise.resolve({
    exitCode: opts.exitCode ?? 0,
    killed: false,
    stdout: undefined,
    stderr: undefined,
  }) as Promise<{ exitCode: number; killed: boolean }> & {
    stdout: Readable;
    stderr: Readable;
    pid?: number;
    killed: boolean;
  };
  const child = base as typeof base & { pid?: number };
  child.stdout = Readable.from(opts.out ?? []);
  child.stderr = Readable.from(opts.err ?? []);
  child.pid = opts.pid ?? 424242;
  child.killed = false;
  return child;
}

async function criarAmbiente() {
  const home = await mkdtemp(join(tmpdir(), "sre-resilience-"));
  raizes.push(home);
  const manager = new WorkspaceManager({ homeDir: home, cwd: home });
  const ws = await manager.criar("corp-sre");
  const sessoes = new SessionManager({ homeDir: home, cwd: home });
  return { home, ws, sessoes };
}

afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("SRE Resilience & Hardening E2E", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execaMock.mockImplementation((cmd: string) => {
      if (cmd === "which") {
        return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/bwrap" });
      }
      return fakeChild({ out: ["ok\n"], exitCode: 0 });
    });
  });

  describe("1. dirsDoBinario: Resolução Recursiva de Symlinks e node_modules", () => {
    it("deve resolver symlinks intermediários (.bin) e montar node_modules raiz", async () => {
      const baseDir = await mkdtemp(join(tmpdir(), "symlink-test-"));
      raizes.push(baseDir);

      const binDir = join(baseDir, "bin");
      const dotBinDir = join(baseDir, "node_modules", ".bin");
      const pkgBinDir = join(baseDir, "node_modules", "@openai", "codex", "bin");

      await mkdir(binDir, { recursive: true });
      await mkdir(dotBinDir, { recursive: true });
      await mkdir(pkgBinDir, { recursive: true });

      const realScript = join(pkgBinDir, "codex.js");
      await writeFile(realScript, "#!/usr/bin/env node\nconsole.log('codex real');");

      const intermediateSymlink = join(dotBinDir, "codex");
      await symlink(realScript, intermediateSymlink);

      const primarySymlink = join(binDir, "codex");
      await symlink(intermediateSymlink, primarySymlink);

      const dirs = dirsDoBinario(primarySymlink);

      expect(dirs).toContain(binDir);
      expect(dirs).toContain(dotBinDir);
      expect(dirs).toContain(pkgBinDir);
      expect(dirs).toContain(join(baseDir, "node_modules"));
    });
  });

  describe("2. SandboxDriver: /dev/shm e Binds Essenciais", () => {
    it("deve incluir bind de /dev/shm se existir no sistema para estabilidade do Chromium", async () => {
      const driver = new SandboxDriver();
      const prep = await driver.preparar({
        binary: "node",
        args: ["-e", "1+1"],
        cwd: "/tmp",
        env: { PATH: "/usr/bin" },
        workspaceId: "ws-test",
        workspacePath: "/tmp",
      });

      if (existsSync("/dev/shm")) {
        const idx = prep.args.indexOf("/dev/shm");
        expect(idx).toBeGreaterThan(-1);
        expect(prep.args[idx - 1]).toBe("--bind");
        expect(prep.args[idx + 1]).toBe("/dev/shm");
      }
    });
  });

  describe("3. SessionManager: Watchdog e Timeout Padrão", () => {
    it("deve armar watchdog de segurança com timeout de 10 min por padrão se omitido", async () => {
      const { sessoes, ws } = await criarAmbiente();

      execaMock.mockImplementation((cmd: string) => {
        if (cmd === "which") return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/bwrap" });
        return fakeChild({ out: ["saida ok"], exitCode: 0 });
      });

      const res = await sessoes.rodar({
        agente: "executor-padrao",
        ordem: "teste timeout padrao",
        workspaceDir: ws.path,
      });

      expect(res.status).toBe("concluido");
      expect(res.exit_code).toBe(0);
    });
  });

  describe("4. SessionManager: Auto-Rotação de Contas por Esgotamento de Cota", () => {
    it("deve rotacionar para próxima conta quando atingir limite semanal/mensal de API", async () => {
      const { home, ws, sessoes } = await criarAmbiente();

      // Inicializa auth.json no home mockado
      const authDir = join(home, ".opencorp", "opencode-data", "opencode");
      await mkdir(authDir, { recursive: true });
      await writeFile(
        join(authDir, "auth.json"),
        JSON.stringify({ "opencode-go": { key: "sk-key-primaria" } }, null, 2),
      );

      // Configura duas contas para opencode-go
      const acctStore = new EngineAccountStore({ homeDir: home });
      const conta1 = await acctStore.adicionarConta("opencode-go", {
        nome: "Conta Principal 1",
        authType: "apiKey",
        tokenOuChave: "sk-key-primaria",
      });
      const conta2 = await acctStore.adicionarConta("opencode-go", {
        nome: "Conta Secundária 2",
        authType: "apiKey",
        tokenOuChave: "sk-key-secundaria",
      });

      // Garante conta1 ativa
      await acctStore.ativarConta("opencode-go", conta1.id);

      let chamadas = 0;
      execaMock.mockImplementation((cmd: string) => {
        if (cmd === "which") return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/bwrap" });
        chamadas++;
        if (chamadas === 1) {
          // Primeira chamada falha com erro de cota da API
          return fakeChild({
            out: ["AI_APICallError: Weekly usage limit reached. Resets in 7hr 22min."],
            exitCode: 1,
          });
        }
        // Segunda chamada (após rotação) sucede
        return fakeChild({
          out: ["Execução bem sucedida com a nova chave!"],
          exitCode: 0,
        });
      });

      const res = await sessoes.rodar({
        agente: "executor-padrao",
        ordem: "processar pauta",
        model: "opencode-go/glm-5.3-flash",
        workspaceDir: ws.path,
      });

      expect(chamadas).toBe(2);
      expect(res.status).toBe("concluido");

      // Verifica se a conta1 foi marcada como esgotada e conta2 ficou ativa
      const contasAtualizadas = await acctStore.listar();
      const c1 = contasAtualizadas.find((c) => c.id === conta1.id);
      const c2 = contasAtualizadas.find((c) => c.id === conta2.id);

      expect(c1?.limits.status_cota).toBe("esgotado");
      expect(c2?.ativa).toBe(true);

      // Verifica sincronização no auth.json
      const authPath = join(home, ".opencorp", "opencode-data", "opencode", "auth.json");
      expect(existsSync(authPath)).toBe(true);
      const authJson = JSON.parse(readFileSync(authPath, "utf8"));
      expect(authJson["opencode-go"].key).toBe("sk-key-secundaria");
    });
  });

  describe("5. Scheduler / SessionManager: Reaper de Zumbis com TTL", () => {
    it("deve finalizar processo vivo que ultrapassou o teto de 15 minutos", async () => {
      const { ws, sessoes } = await criarAmbiente();

      // Cria metadado e diretório no registry
      const inicio20MinAtras = new Date(Date.now() - 20 * 60_000).toISOString();
      await (sessoes as any).registros.criar(ws.path, {
        categoria: "execucoes",
        id: "exec-antiga-zumbi",
        descricao: "execução travada",
        criadoPor: "executor-padrao",
        eventoInicial: { evento: "iniciado", resumo: "inicio" },
        extras: {
          status: "executando",
          modelo: "opencode-go/glm-5.3-flash",
          pid: 424242, // process.kill é mockado abaixo: simula processo externo vivo
          fim: null,
          exit_code: null,
          duracao_ms: null,
        },
      });

      // Ajusta data criado_em para 20 minutos atrás
      const metaPath = join(ws.path, ".opencorp", "registries", "execucoes", "exec-antiga-zumbi", "meta.json");
      const meta = JSON.parse(readFileSync(metaPath, "utf8"));
      meta.criado_em = inicio20MinAtras;
      await writeFile(metaPath, JSON.stringify(meta, null, 2));

      const metaCarregada = await (sessoes as any).registros.lerMeta(ws.path, "execucoes", "exec-antiga-zumbi");
      const killSpy = vi.spyOn(process, "kill").mockImplementation((_pid, _signal) => true);

      await sessoes.reconciliarZombie(ws.path, metaCarregada);

      const metaFinal = await (sessoes as any).registros.lerMeta(ws.path, "execucoes", "exec-antiga-zumbi");
      expect(metaFinal.extras.status).toBe("falhou");
      expect(metaFinal.extras.duracao_ms).toBeGreaterThanOrEqual(20 * 60_000);
      expect(killSpy).toHaveBeenCalledWith(424242, "SIGTERM");

      killSpy.mockRestore();
    });

    it("não deve encerrar processo vivo que ainda está dentro da janela normal (<15 min)", async () => {
      const { ws, sessoes } = await criarAmbiente();

      const inicioRecente = new Date(Date.now() - 2 * 60_000).toISOString(); // 2 minutos atrás
      await (sessoes as any).registros.criar(ws.path, {
        categoria: "execucoes",
        id: "exec-recente-valida",
        descricao: "execução normal",
        criadoPor: "executor-padrao",
        eventoInicial: { evento: "iniciado", resumo: "inicio" },
        extras: {
          status: "executando",
          modelo: "opencode-go/glm-5.3-flash",
          pid: process.pid,
          fim: null,
          exit_code: null,
          duracao_ms: null,
        },
      });

      const metaCarregada = await (sessoes as any).registros.lerMeta(ws.path, "execucoes", "exec-recente-valida");
      await sessoes.reconciliarZombie(ws.path, metaCarregada);

      const metaFinal = await (sessoes as any).registros.lerMeta(ws.path, "execucoes", "exec-recente-valida");
      expect(metaFinal.extras.status).toBe("executando");
    });
  });

  describe("6. FlowStore: Propagação Obrigatória de timeoutMs para Execuções de Nós", () => {
    it("deve propagar timeout padrão (600_000 ms) quando nó agente não especifica timeout_ms", async () => {
      const chamadas: OpcoesRun[] = [];
      const store = new FlowStore({
        sessoes: {
          rodar: async (op: OpcoesRun) => {
            chamadas.push(op);
            return {
              id: "run-mock",
              status: "concluido",
              exit_code: 0,
              captura: "saida teste",
            } as ResultadoRun;
          },
        },
      });

      const { ws } = await criarAmbiente();
      const flow = {
        id: "flow-timeout-test",
        nome: "Flow Timeout Test",
        nos: [
          { id: "gatilho", tipo: "manual" as const, config: {} },
          { id: "passo1", tipo: "agente" as const, config: { agente: "executor-padrao", ordem: "tarefa" } },
        ],
        arestas: [{ de: "gatilho", para: "passo1" }],
      };

      await store.salvar(ws.path, flow);
      await store.executar(ws.path, flow.id, { tipo: "manual" });

      expect(chamadas).toHaveLength(1);
      expect(chamadas[0].timeoutMs).toBe(600_000);
    });

    it("deve respeitar timeout_ms customizado configurado no nó", async () => {
      const chamadas: OpcoesRun[] = [];
      const store = new FlowStore({
        sessoes: {
          rodar: async (op: OpcoesRun) => {
            chamadas.push(op);
            return {
              id: "run-mock",
              status: "concluido",
              exit_code: 0,
              captura: "saida teste",
            } as ResultadoRun;
          },
        },
      });

      const { ws } = await criarAmbiente();
      const flow = {
        id: "flow-custom-timeout",
        nome: "Flow Custom Timeout",
        nos: [
          { id: "gatilho", tipo: "manual" as const, config: {} },
          {
            id: "passo1",
            tipo: "agente" as const,
            config: { agente: "executor-padrao", ordem: "tarefa rapida", timeout_ms: 45_000 },
          },
        ],
        arestas: [{ de: "gatilho", para: "passo1" }],
      };

      await store.salvar(ws.path, flow);
      await store.executar(ws.path, flow.id, { tipo: "manual" });

      expect(chamadas).toHaveLength(1);
      expect(chamadas[0].timeoutMs).toBe(45_000);
    });
  });

  describe("7. E2E: Ciclo Completo de Fluxo com Falha de Cota e Auto-Recuperação", () => {
    it("deve executar fluxo completo, detectar 429/cota, rotacionar credencial e finalizar com sucesso", async () => {
      const { home, ws, sessoes } = await criarAmbiente();

      // Configuração multi-conta
      const authDir = join(home, ".opencorp", "opencode-data", "opencode");
      await mkdir(authDir, { recursive: true });
      await writeFile(
        join(authDir, "auth.json"),
        JSON.stringify({ "opencode-go": { key: "sk-esgotada" } }, null, 2),
      );

      const acctStore = new EngineAccountStore({ homeDir: home });
      const c1 = await acctStore.adicionarConta("opencode-go", {
        nome: "Conta 1 - Limite",
        authType: "apiKey",
        tokenOuChave: "sk-esgotada",
      });
      const c2 = await acctStore.adicionarConta("opencode-go", {
        nome: "Conta 2 - Reserva",
        authType: "apiKey",
        tokenOuChave: "sk-reserva-ativa",
      });
      await acctStore.ativarConta("opencode-go", c1.id);

      let tentativas = 0;
      execaMock.mockImplementation((cmd: string) => {
        if (cmd === "which") return Promise.resolve({ exitCode: 0, stdout: "/usr/bin/bwrap" });
        tentativas++;
        if (tentativas === 1) {
          // Primeira tentativa: erro de limite semanal
          return fakeChild({
            out: ["AI_RetryError: Weekly usage limit reached. Resets in 5hr 12min."],
            exitCode: 1,
          });
        }
        return fakeChild({
          out: ["Flow concluído com sucesso usando a conta de reserva!"],
          exitCode: 0,
        });
      });

      const store = new FlowStore({ sessoes, homeDir: home });
      const flow = {
        id: "flow-auto-recuperacao",
        nome: "Flow Auto Recuperação",
        nos: [
          { id: "gatilho", tipo: "manual" as const, config: {} },
          {
            id: "gerar-conteudo",
            tipo: "agente" as const,
            config: {
              agente: "executor-padrao",
              ordem: "gerar roteiro de youtube",
              modelo: "opencode-go/glm-5.3-flash",
            },
          },
        ],
        arestas: [{ de: "gatilho", para: "gerar-conteudo" }],
      };

      await store.salvar(ws.path, flow);
      const resultado = await store.executar(ws.path, flow.id, { tipo: "manual" });

      expect(resultado.status).toBe("concluido");
      expect(resultado.nos).toHaveLength(2); // gatilho + gerar-conteudo
      expect(tentativas).toBe(2);

      // Validação pós-execução
      const contas = await acctStore.listar();
      expect(contas.find((c) => c.id === c1.id)?.limits.status_cota).toBe("esgotado");
      expect(contas.find((c) => c.id === c2.id)?.ativa).toBe(true);
    });
  });
});
