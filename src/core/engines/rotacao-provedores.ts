import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Rotação entre provedores de um pool (tipo `pool` em provedores.json).
 *
 * Cada membro do pool tem cota própria (ex.: uma chave do OpenRouter por conta). Quando um membro esgota a cota,
 * responde 402/403/429 ou fica indisponível, ele entra em cooldown até a cota voltar, e a chamada segue para o próximo.
 * O estado (cursor de rodízio e cooldowns) fica em `<home>/.opencorp/rotacao/estado.json`, para que processos diferentes
 * (canais, daemon, execuções manuais) vejam os mesmos bloqueios.
 */

export type ClasseFalha = "cota" | "modelo" | "transitoria" | "outra";

export interface BloqueioMembro {
  ate: string;
  motivo: string;
}

export interface EstadoRotacao {
  /** Próximo membro a tentar (rodízio): cada escolha avança o cursor, para a carga se espalhar entre as contas. */
  cursor: number;
  bloqueios: Record<string, BloqueioMembro>;
  /** Chamadas bem-sucedidas por membro (diagnóstico). */
  usos: Record<string, number>;
}

export function estadoRotacaoVazio(): EstadoRotacao {
  return { cursor: 0, bloqueios: {}, usos: {} };
}

/** Pasta própria do estado: é a única parte de ~/.opencorp que a sandbox do pool deixa gravar. */
export function pastaEstadoRotacao(homeDir: string): string {
  return join(homeDir, ".opencorp", "rotacao");
}

export function caminhoEstadoRotacao(homeDir: string): string {
  return join(pastaEstadoRotacao(homeDir), "estado.json");
}

export function lerEstadoRotacao(homeDir: string): EstadoRotacao {
  const caminho = caminhoEstadoRotacao(homeDir);
  if (!existsSync(caminho)) return estadoRotacaoVazio();
  try {
    const bruto = JSON.parse(readFileSync(caminho, "utf8")) as Partial<EstadoRotacao>;
    return {
      cursor: Number.isInteger(bruto.cursor) && (bruto.cursor as number) >= 0 ? (bruto.cursor as number) : 0,
      bloqueios: bruto.bloqueios && typeof bruto.bloqueios === "object" ? bruto.bloqueios : {},
      usos: bruto.usos && typeof bruto.usos === "object" ? bruto.usos : {},
    };
  } catch {
    return estadoRotacaoVazio();
  }
}

/** Grava de forma atômica (arquivo temporário único + rename): quem lê nunca pega o JSON pela metade. */
export function gravarEstadoRotacao(homeDir: string, estado: EstadoRotacao): void {
  const caminho = caminhoEstadoRotacao(homeDir);
  mkdirSync(pastaEstadoRotacao(homeDir), { recursive: true });
  const tmp = `${caminho}.${process.pid}-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(estado, null, 2)}\n`);
    renameSync(tmp, caminho);
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Ignora erro de remoção de temporário
    }
  }
}

/** Próxima meia-noite UTC: quando cotas diárias (ex.: 1000 chamadas grátis/dia do OpenRouter) renovam. */
export function proximaMeiaNoiteUtc(agora: Date): Date {
  const d = new Date(agora.getTime());
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

/**
 * Classifica a mensagem de erro de um membro. Só `cota`, `modelo` e `transitoria` justificam trocar de membro;
 * `outra` (erro de prompt, de ferramenta etc.) falha igual em qualquer conta, então não rotaciona.
 */
export function classificarFalha(texto: string, agora: Date): { classe: ClasseFalha; ate?: Date; motivo: string } {
  const t = texto.toLowerCase();
  const em = (minutos: number) => new Date(agora.getTime() + minutos * 60_000);

  if (/limit_rpd|daily limit|free usage limit|freeusagelimit|limite di[aá]rio|di[aá]ri[ao].*(limite|cota)/.test(t)) {
    return { classe: "cota", ate: proximaMeiaNoiteUtc(agora), motivo: "cota diária esgotada" };
  }
  if (/\b429\b|rate.?limit|too many requests/.test(t)) {
    return { classe: "cota", ate: em(15), motivo: "limite de requisições (429)" };
  }
  if (/\b402\b|requires more credits|insufficient (credit|balance|funds)|saldo insuficiente|sem saldo/.test(t)) {
    return { classe: "cota", ate: em(6 * 60), motivo: "sem créditos (402)" };
  }
  if (/econnrefused|connection refused|err_connection_refused|enotfound|ehostunreach|eai_again|cannot connect to api|unable to connect/.test(t)) {
    return { classe: "transitoria", ate: em(5), motivo: "serviço inacessível (ECONNREFUSED)" };
  }
  if (/temporarily unavailable|service unavailable|overloaded|high demand|timeout|timed out|etimedout|econnreset|fetch failed|socket hang up|\b5\d\d\b/.test(t)) {
    return { classe: "transitoria", motivo: "falha de rede ou servidor" };
  }
  if (/\b403\b|\b404\b|only available|not available|unavailable|model not found|not a valid model|does not exist|no endpoints/.test(t)) {
    return { classe: "modelo", ate: em(12 * 60), motivo: "modelo indisponível para esta conta" };
  }
  return { classe: "outra", motivo: "erro que não muda com a conta" };
}

/**
 * Escolhe o próximo membro livre a partir do cursor, pulando os que estão em cooldown e os já excluídos nesta chamada.
 * Avança o cursor; quem chama grava o estado. Devolve undefined se nenhum membro está livre.
 */
export function escolherMembro(
  membros: string[],
  estado: EstadoRotacao,
  agora: Date,
  excluir: string[] = [],
): { id: string | undefined; bloqueados: Array<{ id: string; ate: string; motivo: string }> } {
  const bloqueados: Array<{ id: string; ate: string; motivo: string }> = [];
  if (membros.length === 0) return { id: undefined, bloqueados };
  for (let passo = 0; passo < membros.length; passo++) {
    const indice = (estado.cursor + passo) % membros.length;
    const id = membros[indice]!;
    if (excluir.includes(id)) continue;
    const bloqueio = estado.bloqueios[id];
    if (bloqueio && new Date(bloqueio.ate).getTime() > agora.getTime()) {
      bloqueados.push({ id, ate: bloqueio.ate, motivo: bloqueio.motivo });
      continue;
    }
    estado.cursor = (indice + 1) % membros.length;
    return { id, bloqueados };
  }
  return { id: undefined, bloqueados };
}

export function registrarBloqueio(estado: EstadoRotacao, id: string, ate: Date, motivo: string): void {
  estado.bloqueios[id] = { ate: ate.toISOString(), motivo };
}

export function registrarUso(estado: EstadoRotacao, id: string): void {
  estado.usos[id] = (estado.usos[id] ?? 0) + 1;
}

/** Remove bloqueios já vencidos (para o diagnóstico não mostrar cooldown antigo). */
export function limparBloqueiosVencidos(estado: EstadoRotacao, agora: Date): void {
  for (const [id, b] of Object.entries(estado.bloqueios)) {
    if (new Date(b.ate).getTime() <= agora.getTime()) delete estado.bloqueios[id];
  }
}
