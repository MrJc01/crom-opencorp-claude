import { describe, it, expect, beforeEach } from "vitest";
import { formatarTituloAba } from "../../../src/web/features/chat/components/OpenCodeTabsHeader.js";
import {
  atualizarAbaAtiva,
  carregarAbasWorkspace,
  deduplicarAbas,
  salvarAbasWorkspace,
} from "../../../src/web/features/chat/hooks/useAbasSecretario.js";
import { converterMensagensBackend } from "../../../src/web/features/chat/runtime/secretary-runtime-adapter.js";

if (typeof globalThis.localStorage === "undefined") {
  const store = new Map<string, string>();
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, String(v));
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as unknown as Storage;
}

describe("OpenCodeTabsHeader — Formatação de Títulos", () => {
  it("remove prefixos técnicos de workspace e sessão", () => {
    expect(formatarTituloAba('[WORKSPACE ATIVO: "yt-factory"] Análise')).toBe("Análise");
    expect(formatarTituloAba("[SESSÃO: 123] Revisão de Roteiros")).toBe("Revisão de Roteiros");
    expect(formatarTituloAba('[WORKSPACE "corp"]')).toBe("Conversa");
  });

  it("retorna 'Nova conversa' para valores nulos, vazios ou indefinidos", () => {
    expect(formatarTituloAba("")).toBe("Nova conversa");
    expect(formatarTituloAba(undefined)).toBe("Nova conversa");
    expect(formatarTituloAba("   ")).toBe("Nova conversa");
  });

  it("preserva títulos limpos definidos pelo usuário", () => {
    expect(formatarTituloAba("Auditoria SEO")).toBe("Auditoria SEO");
    expect(formatarTituloAba("Planejamento 2026")).toBe("Planejamento 2026");
  });
});

describe("SecretarioView — Persistência de Abas por Workspace", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("salva e recupera abas com chave isolada por workspace", () => {
    const abasWsA = [
      { id: "ses_1", titulo: "Aba Projeto A", criadoEm: 1000 },
    ];
    const abasWsB = [
      { id: "ses_2", titulo: "Aba Projeto B", criadoEm: 2000 },
    ];

    salvarAbasWorkspace("projeto-a", abasWsA);
    salvarAbasWorkspace("projeto-b", abasWsB);

    expect(carregarAbasWorkspace("projeto-a")).toEqual([
      { ...abasWsA[0], tabKey: "tab_ses_1" },
    ]);
    expect(carregarAbasWorkspace("projeto-b")).toEqual([
      { ...abasWsB[0], tabKey: "tab_ses_2" },
    ]);
  });

  it("retorna array vazio quando não há abas salvas para o workspace", () => {
    expect(carregarAbasWorkspace("inexistente")).toEqual([]);
  });

  it("deduplica IDs e tabKeys persistidos mantendo a primeira aba", () => {
    const abas = [
      { id: "ses_1", tabKey: "tab_a", titulo: "oi", criadoEm: 1 },
      { id: "ses_1", tabKey: "tab_b", titulo: "duplicada por id", criadoEm: 2 },
      { id: "ses_2", tabKey: "tab_a", titulo: "duplicada por tabKey", criadoEm: 3 },
    ];

    expect(deduplicarAbas(abas)).toEqual([abas[0]]);
  });

  it("promove a aba ativa in-place sem aumentar a lista", () => {
    const abas = [
      { id: "sessao-rascunho", tabKey: "tab_estavel", titulo: "ola", criadoEm: 1 },
      { id: "ses_anterior", tabKey: "tab_anterior", titulo: "anterior", criadoEm: 2 },
    ];

    const promovidas = atualizarAbaAtiva(abas, "sessao-rascunho", {
      id: "ses_real",
    });

    expect(promovidas).toHaveLength(2);
    expect(promovidas[0]).toEqual({
      ...abas[0],
      id: "ses_real",
    });
    expect(promovidas[0]?.tabKey).toBe("tab_estavel");
  });

  it("migra abas legadas automáticas preservando apenas a sessão ativa", () => {
    localStorage.setItem(
      "oc-secretario-abas:legado",
      JSON.stringify([
        { id: "ses_oi", titulo: "oi", criadoEm: 1 },
        { id: "ses_ola", titulo: "ola", criadoEm: 2 },
        { id: "ses_atual", titulo: "ola", criadoEm: 3 },
      ]),
    );
    localStorage.setItem("oc-secretario-sessao-ativa:legado", "ses_atual");

    expect(carregarAbasWorkspace("legado")).toEqual([
      {
        id: "ses_atual",
        tabKey: "tab_ses_atual",
        titulo: "ola",
        criadoEm: 3,
      },
    ]);
    expect(localStorage.getItem("oc-secretario-abas-schema:legado")).toBe("2");
  });
});

describe("secretary-runtime-adapter — Hidratação de Mensagens", () => {
  it("converte mensagens brutas do backend em ThreadMessageLike", () => {
    const backendMsgs = [
      {
        id: "msg_user_1",
        role: "user",
        content: "Qual o status do projeto?",
        criado_em: "2026-09-25T01:00:00.000Z",
      },
      {
        id: "msg_asst_1",
        role: "assistant",
        content: "O projeto está operacional.",
        pensamento: "Consultando tabela de status...",
        acoes: [
          { ferramenta: "git_status", resumo: "Branch limpa", sucesso: true },
        ],
        criado_em: "2026-09-25T01:00:05.000Z",
      },
    ];

    const convertidas = converterMensagensBackend(backendMsgs, "ses_test");

    expect(convertidas).toHaveLength(2);

    // Mensagem do usuário
    expect(convertidas[0].role).toBe("user");
    expect(convertidas[0].content).toEqual([
      { type: "text", text: "Qual o status do projeto?" },
    ]);

    // Mensagem do assistente estruturada com partes (reasoning, tool-call, text)
    expect(convertidas[1].role).toBe("assistant");
    const partes = convertidas[1].content as any[];
    expect(partes).toHaveLength(3);
    expect(partes[0]).toEqual({
      type: "reasoning",
      text: "Consultando tabela de status...",
    });
    expect(partes[1]).toMatchObject({
      type: "tool-call",
      toolName: "git_status",
      result: "Branch limpa",
      isError: false,
    });
    expect(partes[2]).toEqual({
      type: "text",
      text: "O projeto está operacional.",
    });
  });

  it("retorna array vazio se a lista de mensagens for inválida", () => {
    expect(converterMensagensBackend(null as any, "ses_test")).toEqual([]);
    expect(converterMensagensBackend(undefined as any, "ses_test")).toEqual([]);
    expect(converterMensagensBackend([] as any, "ses_test")).toEqual([]);
  });
});
