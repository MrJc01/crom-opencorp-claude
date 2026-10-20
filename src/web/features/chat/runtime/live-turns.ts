import type { ThreadMessageLike } from "@assistant-ui/react";

/**
 * Turnos em andamento por sessão, fora do React. Se o componente do chat for remontado
 * no meio de um turno (ex.: a aba é promovida de rascunho para o id real e o pai troca a
 * `key`), o novo runtime adota as mensagens do turno vivo e continua recebendo as
 * atualizações do SSE que a instância antiga ainda consome.
 */
export interface TurnoVivo {
  messages: readonly ThreadMessageLike[];
  running: boolean;
  /** Quem publicou: a própria instância ignora as suas publicações. */
  origem: object;
  abort: () => void;
}

const vivos = new Map<string, TurnoVivo>();
const ouvintes = new Map<string, Set<(t: TurnoVivo) => void>>();

export function publicarTurno(sessaoId: string, turno: TurnoVivo): void {
  if (turno.running) vivos.set(sessaoId, turno);
  else vivos.delete(sessaoId);
  for (const fn of ouvintes.get(sessaoId) ?? []) fn(turno);
}

export function obterTurno(sessaoId?: string): TurnoVivo | undefined {
  return sessaoId ? vivos.get(sessaoId) : undefined;
}

export function assinarTurno(sessaoId: string, fn: (t: TurnoVivo) => void): () => void {
  const set = ouvintes.get(sessaoId) ?? new Set();
  set.add(fn);
  ouvintes.set(sessaoId, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) ouvintes.delete(sessaoId);
  };
}
