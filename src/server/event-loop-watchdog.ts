import { monitorEventLoopDelay } from "node:perf_hooks";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Watchdog do event loop do servidor.
 *
 * A thread principal grava um batimento (timestamp) numa memória compartilhada a cada 1 s. Um Worker
 * separado confere o batimento; se passar de `limiteMs` sem atualização (loop travado por CPU ou por
 * chamada síncrona), ele captura a PILHA da thread principal pelo inspetor (`Debugger.pause`), grava
 * `<home>/.opencorp/logs/watchdog-<timestamp>.json` e encerra o processo com código ≠ 0 para o
 * supervisor (daemon/systemd) reiniciar. Pausas curtas (GC, build) não disparam: o limite padrão é 20 s.
 *
 * Desligar: OPENCORP_WATCHDOG=0. Limite: OPENCORP_WATCHDOG_MS.
 */

export const WATCHDOG_LIMITE_PADRAO_MS = 20_000;
export const WATCHDOG_CODIGO_SAIDA = 86;
const BATIMENTO_MS = 1000;
const ROTAS_RECENTES_MAX = 30;
const LAG_P99_AVISO_MS = 1000;

export interface OpcoesWatchdog {
  /** home do OpenCorp (o diagnóstico vai em `<home>/.opencorp/logs`). */
  home: string;
  /** padrão: OPENCORP_WATCHDOG_MS ou 20 s. */
  limiteMs?: number;
  /** intervalo de conferência do worker (knob de teste). */
  conferirACadaMs?: number;
  /** false = só registra o diagnóstico e não mata o processo (testes). */
  encerrar?: boolean;
}

export interface WatchdogHandle {
  /** Registra a requisição para o diagnóstico (últimas rotas e as em andamento). */
  registrarRequisicao(req: IncomingMessage, res: ServerResponse): void;
  parar(): void;
}

export function watchdogHabilitado(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.OPENCORP_WATCHDOG?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

export function watchdogLimiteMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.OPENCORP_WATCHDOG_MS);
  return Number.isFinite(n) && n >= 1000 ? n : WATCHDOG_LIMITE_PADRAO_MS;
}

interface RotaRegistro {
  metodo: string;
  rota: string;
  inicio: string;
  inicioMs: number;
  fimMs?: number;
  status?: number;
}

/** Código do Worker (CJS, inline: funciona igual em dist/ e sob tsx/vitest). */
const CODIGO_WORKER = String.raw`
const { workerData, parentPort } = require("node:worker_threads");
const { Session } = require("node:inspector");
const fs = require("node:fs");
const path = require("node:path");
const { limiteMs, conferirMs, dir, pid, encerrar, batimento } = workerData;
const hb = new BigInt64Array(batimento);
// console.* do worker passa pela thread principal (travada): escreve direto no stderr
const err = (...a) => { try { fs.writeSync(2, a.map(String).join(" ") + "\n"); } catch {} };
let rotas = [];
let emAndamento = [];
parentPort.on("message", (m) => { if (m && m.rotas) { rotas = m.rotas; emAndamento = m.emAndamento || []; } });
let ultimaConferencia = Date.now();
let disparado = false;

function frames(callFrames) {
  return callFrames.map((f) => (f.functionName || "(anônima)") + " (" + (f.url || "?") + ":" + (f.location.lineNumber + 1) + ":" + (f.location.columnNumber + 1) + ")");
}

function capturarPilha() {
  return new Promise((resolve) => {
    let feito = false;
    const fim = (v) => { if (!feito) { feito = true; resolve(v); } };
    const timer = setTimeout(() => fim({ pilha: null, erro: "inspetor não pausou a thread principal em 3 s" }), 3000);
    try {
      const s = new Session();
      s.connectToMainThread();
      s.on("Debugger.paused", (m) => {
        clearTimeout(timer);
        const pilha = frames(m.params.callFrames);
        // a thread principal fica pausada; o encerramento é pedido por dentro DEPOIS de gravar o diagnóstico
        const sair = () => s.post("Debugger.evaluateOnCallFrame", { callFrameId: m.params.callFrames[0].callFrameId, expression: "process.reallyExit(" + ${WATCHDOG_CODIGO_SAIDA} + ")" }, () => {});
        fim({ pilha, sair });
      });
      s.post("Debugger.enable", (e) => {
        if (e) { clearTimeout(timer); return fim({ pilha: null, erro: String(e.message || e) }); }
        s.post("Debugger.pause");
      });
    } catch (e) {
      clearTimeout(timer);
      fim({ pilha: null, erro: String((e && e.message) || e) });
    }
  });
}

async function disparar(semBatimentoMs) {
  disparado = true;
  const cpu = process.cpuUsage();
  const mem = process.memoryUsage();
  const captura = await capturarPilha();
  const agora = new Date();
  const arquivo = path.join(dir, "watchdog-" + agora.toISOString().replace(/[:.]/g, "-") + ".json");
  const diag = {
    quando: agora.toISOString(),
    motivo: "event loop sem batimento por " + Math.round(semBatimentoMs) + " ms (limite " + limiteMs + " ms)",
    pid,
    semBatimentoMs: Math.round(semBatimentoMs),
    pilhaThreadPrincipal: captura.pilha,
    erroCaptura: captura.erro || null,
    uptimeProcessoS: Math.round(process.uptime()),
    cpuUsuarioMs: Math.round(cpu.user / 1000),
    cpuSistemaMs: Math.round(cpu.system / 1000),
    memoria: { rssMB: Math.round(mem.rss / 1048576), heapUsadoMB: Math.round(mem.heapUsed / 1048576), heapTotalMB: Math.round(mem.heapTotal / 1048576) },
    ultimasRotas: rotas,
    rotasEmAndamento: emAndamento,
    versaoNode: process.version,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(diag, null, 2) + "\n");
  } catch (e) { err("[watchdog] não gravou o diagnóstico:", e); }
  err("[watchdog] event loop travado por " + Math.round(semBatimentoMs / 1000) + " s — diagnóstico em " + arquivo + (encerrar ? " — encerrando o processo" : ""));
  if (captura.pilha) err("[watchdog] pilha:\n  " + captura.pilha.slice(0, 12).join("\n  "));
  parentPort.postMessage({ tipo: "diagnostico", arquivo });
  if (encerrar) {
    if (captura.sair) captura.sair();
    // Se o evaluate não derrubou a thread principal, SIGKILL (o supervisor reinicia do mesmo jeito)
    setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch {} }, 2000);
  }
}

setInterval(() => {
  const agora = Date.now();
  // O próprio worker atrasou (máquina suspensa/sobrecarregada): não é culpa do event loop principal
  const atrasoProprio = agora - ultimaConferencia - conferirMs;
  ultimaConferencia = agora;
  if (disparado) return;
  if (atrasoProprio > 5000) { Atomics.store(hb, 0, BigInt(agora)); return; }
  const semBatimento = agora - Number(Atomics.load(hb, 0));
  if (semBatimento > limiteMs) void disparar(semBatimento);
}, conferirMs);
`;

/** Liga o watchdog. Devolve `null` quando desligado por OPENCORP_WATCHDOG=0. */
export function iniciarWatchdog(opcoes: OpcoesWatchdog): WatchdogHandle | null {
  if (!watchdogHabilitado()) return null;
  const limiteMs = opcoes.limiteMs ?? watchdogLimiteMs();
  const dir = join(opcoes.home, ".opencorp", "logs");

  const batimento = new SharedArrayBuffer(8);
  const hb = new BigInt64Array(batimento);
  Atomics.store(hb, 0, BigInt(Date.now()));

  const rotas: RotaRegistro[] = [];
  const emAndamento = new Set<RotaRegistro>();
  let mudou = true;

  const worker = new Worker(CODIGO_WORKER, {
    eval: true,
    workerData: {
      limiteMs,
      conferirMs: opcoes.conferirACadaMs ?? 1000,
      dir,
      pid: process.pid,
      encerrar: opcoes.encerrar !== false,
      batimento,
    },
  });
  worker.unref();
  worker.on("error", (erro) => console.error("[watchdog] worker falhou (watchdog inativo):", erro));

  const snapshot = (): { rotas: unknown[]; emAndamento: unknown[] } => {
    const agora = Date.now();
    const fmt = (r: RotaRegistro) => ({
      metodo: r.metodo,
      rota: r.rota,
      inicio: r.inicio,
      duracaoMs: (r.fimMs ?? agora) - r.inicioMs,
      status: r.status ?? null,
    });
    return { rotas: rotas.map(fmt), emAndamento: [...emAndamento].map(fmt) };
  };

  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let ultimoAvisoLag = 0;

  const timer = setInterval(() => {
    Atomics.store(hb, 0, BigInt(Date.now()));
    if (mudou || emAndamento.size > 0) {
      mudou = false;
      worker.postMessage(snapshot());
    }
    // lag observável: p99 do atraso do loop na janela desde o último batimento
    const p99ms = lag.percentile(99) / 1e6;
    lag.reset();
    if (p99ms > LAG_P99_AVISO_MS && Date.now() - ultimoAvisoLag > 10_000) {
      ultimoAvisoLag = Date.now();
      const ativas = [...emAndamento].map((r) => `${r.metodo} ${r.rota}`).slice(0, 5).join(", ") || "nenhuma";
      console.warn(`[watchdog] lag do event loop: p99 ${Math.round(p99ms)} ms (> ${LAG_P99_AVISO_MS} ms) — requisições em andamento: ${ativas}`);
    }
  }, BATIMENTO_MS);
  timer.unref();

  return {
    registrarRequisicao(req, res) {
      const reg: RotaRegistro = {
        metodo: req.method ?? "?",
        rota: (req.url ?? "").split("?")[0] ?? "",
        inicio: new Date().toISOString(),
        inicioMs: Date.now(),
      };
      rotas.push(reg);
      if (rotas.length > ROTAS_RECENTES_MAX) rotas.shift();
      emAndamento.add(reg);
      mudou = true;
      res.once("close", () => {
        reg.fimMs = Date.now();
        reg.status = res.statusCode;
        emAndamento.delete(reg);
        mudou = true;
      });
    },
    parar() {
      clearInterval(timer);
      lag.disable();
      void worker.terminate();
    },
  };
}

/** Liga o watchdog e registra as requisições do servidor HTTP. */
export function vigiarServidor(server: Server, opcoes: OpcoesWatchdog): WatchdogHandle | null {
  const handle = iniciarWatchdog(opcoes);
  if (!handle) return null;
  server.prependListener("request", (req, res) => handle.registrarRequisicao(req, res));
  server.once("close", () => handle.parar());
  return handle;
}
