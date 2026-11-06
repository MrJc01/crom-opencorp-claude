import type { ArestaGrafo, NoGrafo } from "./types.js";

const LARGURA_COLUNA = 340;
const ESPACO_VERTICAL = 40;
const MARGEM = 80;

/** Altura aproximada do cartão de cada tipo de nó (só para espaçar; o React Flow mede o real). */
function alturaDe(no: NoGrafo): number {
  if (no.tipo === "condicao" || no.tipo === "decisao") return 190;
  if (no.tipo === "agente" || no.tipo === "review" || no.tipo === "debate" || no.tipo === "fanout") return 170;
  return 140;
}

/**
 * Organiza o grafo em colunas da esquerda para a direita (camadas por caminho mais longo, ciclos ignorados),
 * ordena cada coluna pela posição média dos vizinhos para reduzir cruzamentos e centraliza as colunas.
 * Funciona com loops (arestas de retorno não entram no cálculo) e com nós soltos.
 */
export function organizarNos(nos: NoGrafo[], arestas: ArestaGrafo[]): NoGrafo[] {
  const ids = new Set(nos.map((n) => n.id));
  const validas = arestas.filter((a) => ids.has(a.de) && ids.has(a.para) && a.de !== a.para);
  const saidas = new Map<string, string[]>();
  nos.forEach((n) => saidas.set(n.id, []));
  validas.forEach((a) => saidas.get(a.de)!.push(a.para));

  // Remove arestas de retorno (ciclos) com uma busca em profundidade.
  const estado = new Map<string, 0 | 1 | 2>();
  const retorno = new Set<string>();
  const visitar = (id: string) => {
    estado.set(id, 1);
    for (const p of saidas.get(id) ?? []) {
      const e = estado.get(p) ?? 0;
      if (e === 1) retorno.add(`${id}>${p}`);
      else if (e === 0) visitar(p);
    }
    estado.set(id, 2);
  };
  const temEntrada = new Set(validas.map((a) => a.para));
  nos.filter((n) => !temEntrada.has(n.id)).forEach((n) => (estado.get(n.id) ? undefined : visitar(n.id)));
  nos.forEach((n) => (estado.get(n.id) ? undefined : visitar(n.id)));
  const dag = validas.filter((a) => !retorno.has(`${a.de}>${a.para}`));

  // Camada = caminho mais longo desde uma raiz (iterativo, ordem topológica de Kahn).
  const entradas = new Map<string, string[]>();
  nos.forEach((n) => entradas.set(n.id, []));
  dag.forEach((a) => entradas.get(a.para)!.push(a.de));
  const grau = new Map(nos.map((n) => [n.id, entradas.get(n.id)!.length]));
  const camada = new Map<string, number>();
  const fila = nos.filter((n) => grau.get(n.id) === 0).map((n) => n.id);
  fila.forEach((id) => camada.set(id, 0));
  while (fila.length) {
    const id = fila.shift()!;
    for (const a of dag.filter((x) => x.de === id)) {
      camada.set(a.para, Math.max(camada.get(a.para) ?? 0, (camada.get(id) ?? 0) + 1));
      grau.set(a.para, grau.get(a.para)! - 1);
      if (grau.get(a.para) === 0) fila.push(a.para);
    }
  }

  const colunas: string[][] = [];
  nos.forEach((n) => {
    const c = camada.get(n.id) ?? 0;
    (colunas[c] ??= []).push(n.id);
  });

  // Ordem inicial: a do arquivo; depois varreduras pela posição média dos vizinhos.
  const ordem = new Map<string, number>();
  colunas.forEach((col) => col?.forEach((id, i) => ordem.set(id, i)));
  const media = (id: string, vizinhos: string[]) => {
    const v = vizinhos.map((x) => ordem.get(x)).filter((x): x is number => x !== undefined);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : (ordem.get(id) ?? 0);
  };
  for (let volta = 0; volta < 4; volta++) {
    const indices = colunas.map((_, i) => i);
    for (const c of volta % 2 === 0 ? indices : indices.reverse()) {
      const col = colunas[c];
      if (!col) continue;
      const usaEntradas = volta % 2 === 0;
      col.sort((a, b) => media(a, usaEntradas ? entradas.get(a)! : (saidas.get(a) ?? [])) - media(b, usaEntradas ? entradas.get(b)! : (saidas.get(b) ?? [])));
      col.forEach((id, i) => ordem.set(id, i));
    }
  }

  // Coordenadas: cada coluna centralizada na maior coluna.
  const porId = new Map(nos.map((n) => [n.id, n]));
  const alturaColuna = (col: string[]) => col.reduce((s, id) => s + alturaDe(porId.get(id)!) + ESPACO_VERTICAL, -ESPACO_VERTICAL);
  const maior = Math.max(0, ...colunas.map((c) => (c ? alturaColuna(c) : 0)));
  const pos = new Map<string, { x: number; y: number }>();
  colunas.forEach((col, c) => {
    if (!col) return;
    let y = MARGEM + (maior - alturaColuna(col)) / 2;
    for (const id of col) {
      pos.set(id, { x: MARGEM + c * LARGURA_COLUNA, y: Math.round(y) });
      y += alturaDe(porId.get(id)!) + ESPACO_VERTICAL;
    }
  });
  return nos.map((n) => ({ ...n, pos: pos.get(n.id) ?? n.pos }));
}
