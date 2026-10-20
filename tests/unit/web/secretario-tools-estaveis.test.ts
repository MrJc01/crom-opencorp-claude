import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COMPONENTES_PARTES_ASSISTENTE } from "../../../src/web/features/chat/components/SecretarioChat.js";

describe("tool UIs do Secretário", () => {
  it("mapa de componentes tem identidade fixa e cobre as ferramentas interativas", () => {
    const nomes = Object.keys(COMPONENTES_PARTES_ASSISTENTE.tools.by_name);
    expect(nomes).toEqual(
      expect.arrayContaining(["ask_question", "question", "hitl_approval", "aprovacao_motor", "git_status", "terminal_exec"]),
    );
    for (const f of Object.values(COMPONENTES_PARTES_ASSISTENTE.tools.by_name)) expect(typeof f).toBe("function");
  });

  it("SecretarioChat não declara componentes de partes inline (remontariam a cada render)", () => {
    const src = readFileSync("src/web/features/chat/components/SecretarioChat.tsx", "utf8");
    expect(src).toContain("components={COMPONENTES_PARTES_ASSISTENTE}");
    expect(src).not.toMatch(/by_name:\s*\{\s*git_status:\s*\(/);
  });
});
