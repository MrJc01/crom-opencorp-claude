/**
 * Utilitários puros de formatação e escape de texto para a camada web
 */

export function escapeHtml(str: string): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatarDuracao(ms?: number | null): string {
  if (!ms || ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sResto = s % 60;
  return `${m}m ${sResto}s`;
}

export function formatarDataHora(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/** Data e hora completas (com dia da semana, ano e segundos), para `title` de tooltip. */
export function formatarDataHoraCompleta(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** "há 5 min", "há 2 h 10 min", "há 1 d 4 h": quanto tempo faz desde `iso` até `agora`. */
export function tempoDesde(iso?: string | null, agora: number = Date.now()): string {
  if (!iso) return "";
  const inicio = new Date(iso).getTime();
  if (Number.isNaN(inicio)) return "";
  const min = Math.max(0, Math.floor((agora - inicio) / 60_000));
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 === 0 ? `há ${h} h` : `há ${h} h ${min % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `há ${d} d` : `há ${d} d ${h % 24} h`;
}
