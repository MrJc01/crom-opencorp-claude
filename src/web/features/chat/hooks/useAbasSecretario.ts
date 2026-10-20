import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTab } from "../components/OpenCodeTabsHeader.js";

export const PREFIXO_SESSAO = "sessao-";
export const PREFIXO_RASCUNHO = "draft-";
const SCHEMA_ABAS = "2";

export const chaveAbas = (ws: string) => `oc-secretario-abas:${ws}`;
export const chaveSchemaAbas = (ws: string) => `oc-secretario-abas-schema:${ws}`;
export const chaveSessaoAtiva = (ws: string) => `oc-secretario-sessao-ativa:${ws}`;

export function gerarTabKey(): string {
  return `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Aba nova (rascunho local até o backend devolver o id real da sessão). */
export function criarAba(): ChatTab {
  return {
    id: `${PREFIXO_SESSAO}${Date.now()}`,
    tabKey: gerarTabKey(),
    titulo: "Nova conversa",
    criadoEm: Date.now(),
  };
}

/** Mantém uma única aba por sessão e por identidade visual persistente. */
export function deduplicarAbas(abas: ChatTab[]): ChatTab[] {
  const ids = new Set<string>();
  const tabKeys = new Set<string>();

  return abas.filter((aba) => {
    if (!aba || typeof aba.id !== "string" || !aba.id.trim()) return false;
    const tabKey = aba.tabKey || `tab_${aba.id}`;
    if (ids.has(aba.id) || tabKeys.has(tabKey)) return false;
    ids.add(aba.id);
    tabKeys.add(tabKey);
    return true;
  });
}

/**
 * Promove/atualiza a aba ativa sem criar uma conversa implicitamente.
 * Novas abas são responsabilidade exclusiva do botão `+`.
 */
export function atualizarAbaAtiva(
  abas: ChatTab[],
  sessaoAtivaId: string | null,
  mudancas: Partial<Pick<ChatTab, "id" | "titulo">>,
): ChatTab[] {
  if (abas.length === 0) return abas;
  let idx = sessaoAtivaId
    ? abas.findIndex((aba) => aba.id === sessaoAtivaId)
    : -1;
  if (idx < 0) {
    idx = abas.findIndex(
      (aba) =>
        aba.id.startsWith(PREFIXO_SESSAO) || aba.id.startsWith(PREFIXO_RASCUNHO),
    );
  }
  if (idx < 0) idx = 0;

  const copia = [...abas];
  copia[idx] = { ...copia[idx]!, ...mudancas };
  return deduplicarAbas(copia);
}

/** Lê o id da sessão ativa persistido do workspace. */
export function lerSessaoAtiva(workspaceId: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(chaveSessaoAtiva(workspaceId));
  } catch {
    return null;
  }
}

function salvarSessaoAtiva(workspaceId: string, id: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(chaveSessaoAtiva(workspaceId), id);
  } catch {}
}

/** Lê as abas salvas do workspace no localStorage. */
export function carregarAbasWorkspace(workspaceId: string): ChatTab[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const versaoAtual = localStorage.getItem(chaveSchemaAbas(workspaceId));
    const raw = localStorage.getItem(chaveAbas(workspaceId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const normalizadas = parsed
          .filter((t) => t && typeof t.id === "string")
          .map((t) => ({
            ...t,
            tabKey: t.tabKey || `tab_${t.id}`,
          }));
        let unicas = deduplicarAbas(normalizadas);

        // Migração única: versões antigas criavam uma aba a cada promoção de
        // sessão. Preserva a aba ativa; as demais sessões seguem no histórico.
        if (versaoAtual !== SCHEMA_ABAS && unicas.length > 1) {
          const ativaId = lerSessaoAtiva(workspaceId);
          const ativa = unicas.find((aba) => aba.id === ativaId) || unicas.at(-1)!;
          unicas = [ativa];
        }
        salvarAbasWorkspace(workspaceId, unicas);
        return unicas;
      }
    }
  } catch {}
  return [];
}

/** Persiste as abas do workspace no localStorage. */
export function salvarAbasWorkspace(workspaceId: string, abas: ChatTab[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      chaveAbas(workspaceId),
      JSON.stringify(deduplicarAbas(abas)),
    );
    localStorage.setItem(chaveSchemaAbas(workspaceId), SCHEMA_ABAS);
  } catch {}
}

/** Carrega as abas do workspace; sem nenhuma salva, cria e grava uma inicial. */
function abasIniciais(workspaceId: string): ChatTab[] {
  const salvas = carregarAbasWorkspace(workspaceId);
  if (salvas.length > 0) return salvas;
  const inicial = [criarAba()];
  salvarAbasWorkspace(workspaceId, inicial);
  return inicial;
}

/**
 * Onde mora a "sessão ativa": a View usa `?sessao=` da URL, o Dock usa estado
 * local. `ativaId` é `null` quando ainda não há valor definido.
 */
export interface AdaptadorSessaoAtiva {
  ativaId: string | null;
  definirAtiva: (id: string, opcoes: { substituir: boolean }) => void;
}

export function useAbasSecretario(
  wsId: string,
  adaptador: AdaptadorSessaoAtiva,
) {
  const [abas, setAbasEstado] = useState<ChatTab[]>(() => abasIniciais(wsId));
  const abasRef = useRef(abas);
  const adaptadorRef = useRef(adaptador);
  adaptadorRef.current = adaptador;

  const sessaoAtivaId = adaptador.ativaId || abas[0]?.id || null;
  const ativaRef = useRef(sessaoAtivaId);
  ativaRef.current = sessaoAtivaId;

  const aplicar = useCallback(
    (proximas: ChatTab[]) => {
      abasRef.current = proximas;
      setAbasEstado(proximas);
      salvarAbasWorkspace(wsId, proximas);
    },
    [wsId],
  );

  const ativar = useCallback(
    (id: string, substituir: boolean) => {
      salvarSessaoAtiva(wsId, id);
      adaptadorRef.current.definirAtiva(id, { substituir });
    },
    [wsId],
  );

  // Troca de workspace (e montagem): recarrega as abas e define a ativa.
  useEffect(() => {
    let lista = abasIniciais(wsId);
    const ativa = adaptadorRef.current.ativaId;
    if (ativa && !lista.some((a) => a.id === ativa)) {
      lista = atualizarAbaAtiva(lista, null, { id: ativa });
    }
    abasRef.current = lista;
    setAbasEstado(lista);
    salvarAbasWorkspace(wsId, lista);

    if (ativa) {
      salvarSessaoAtiva(wsId, ativa);
    } else {
      const persistida = lerSessaoAtiva(wsId);
      ativar(
        persistida && lista.some((a) => a.id === persistida)
          ? persistida
          : lista[0]!.id,
        true,
      );
    }
  }, [wsId, ativar]);

  // Sessão ativa mudou por fora (URL): promove a aba, nunca cria uma implícita.
  useEffect(() => {
    const ativa = adaptador.ativaId;
    if (!ativa) return;
    salvarSessaoAtiva(wsId, ativa);
    if (abasRef.current.some((a) => a.id === ativa)) return;
    aplicar(atualizarAbaAtiva(abasRef.current, null, { id: ativa }));
  }, [adaptador.ativaId, wsId, aplicar]);

  const selecionar = useCallback((id: string) => ativar(id, false), [ativar]);

  const nova = useCallback(() => {
    const aba = criarAba();
    aplicar([...abasRef.current, aba]);
    ativar(aba.id, false);
  }, [aplicar, ativar]);

  const fechar = useCallback(
    (id: string) => {
      const atuais = abasRef.current;
      const idx = atuais.findIndex((a) => a.id === id);
      const restantes = atuais.filter((a) => a.id !== id);

      if (restantes.length === 0) {
        const inicial = criarAba();
        aplicar([inicial]);
        ativar(inicial.id, true);
        return;
      }
      aplicar(restantes);
      // Fechou a ativa: foca na vizinha.
      if (ativaRef.current === id) {
        const prox = Math.max(0, Math.min(idx - 1, restantes.length - 1));
        ativar(restantes[prox]!.id, true);
      }
    },
    [aplicar, ativar],
  );

  const atualizarTitulo = useCallback(
    (sid: string, titulo: string) => {
      aplicar(
        atualizarAbaAtiva(abasRef.current, sid || ativaRef.current, { titulo }),
      );
    },
    [aplicar],
  );

  const aoSessaoCriada = useCallback(
    (sidBackend: string) => {
      const realId = String(sidBackend || "").trim();
      if (!realId || ativaRef.current === realId) return;
      aplicar(atualizarAbaAtiva(abasRef.current, ativaRef.current, { id: realId }));
      ativar(realId, true);
    },
    [aplicar, ativar],
  );

  return {
    abas,
    sessaoAtivaId,
    selecionar,
    nova,
    fechar,
    atualizarTitulo,
    aoSessaoCriada,
  };
}
