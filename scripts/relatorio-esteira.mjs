#!/usr/bin/env node
/**
 * Relatório de saúde da esteira dos canais: por agente, quantas execuções, quantas falharam (e por quê) e o tempo mediano.
 * Uso: node scripts/relatorio-esteira.mjs [--desde 2026-10-29T17:00] [--ws fundao,yt-factory-01]
 * Só lê os registros em ~/.opencorp/workspaces/<ws>/.opencorp/registries/execucoes.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (n, padrao) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : padrao;
};
const desde = arg("desde", new Date(Date.now() - 6 * 3600_000).toISOString());
const workspaces = arg("ws", "yt-factory-01,fundao").split(",");
const raiz = join(process.env.OPENCORP_HOME || homedir(), ".opencorp", "workspaces");

const mediana = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const porAgente = new Map();
for (const ws of workspaces) {
  const dir = join(raiz, ws, ".opencorp", "registries", "execucoes");
  if (!existsSync(dir)) continue;
  for (const id of readdirSync(dir)) {
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(dir, id, "meta.json"), "utf8"));
    } catch {
      continue;
    }
    const x = meta.extras ?? {};
    if (x.tipo !== "flow-no" || (meta.criado_em ?? "") < desde) continue;
    const chave = `${ws}/${meta.criado_por}`;
    const r = porAgente.get(chave) ?? { ok: 0, falhou: 0, ativo: 0, tempos: [], motivos: new Map() };
    if (x.status === "concluido") r.ok++;
    else if (x.status === "executando") r.ativo++;
    else {
      r.falhou++;
      let motivo = "sem motivo";
      try {
        const linhas = readFileSync(join(dir, id, "journal.jsonl"), "utf8").trim().split("\n");
        const fim = linhas.map((l) => JSON.parse(l)).find((e) => e.evento === "finalizado");
        motivo = (fim?.resumo ?? motivo).split(" — ")[0].slice(0, 60);
      } catch {}
      r.motivos.set(motivo, (r.motivos.get(motivo) ?? 0) + 1);
    }
    if (x.duracao_ms) r.tempos.push(x.duracao_ms);
    porAgente.set(chave, r);
  }
}
console.log(`Esteira desde ${desde}`);
let tot = 0;
let falhas = 0;
for (const [k, r] of [...porAgente].sort()) {
  const n = r.ok + r.falhou;
  tot += n;
  falhas += r.falhou;
  const m = [...r.motivos].map(([t, c]) => `${c}× ${t}`).join("; ");
  console.log(`${k.padEnd(34)} ok ${String(r.ok).padStart(3)}  falhou ${String(r.falhou).padStart(3)}  mediana ${Math.round(mediana(r.tempos) / 1000)}s${r.ativo ? `  (+${r.ativo} rodando)` : ""}${m ? `  [${m}]` : ""}`);
}
console.log(`TOTAL ${tot} execuções de agente, ${falhas} falhas (${tot ? Math.round((100 * falhas) / tot) : 0}%)`);
