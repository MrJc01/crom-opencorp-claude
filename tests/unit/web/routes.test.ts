import { describe, expect, it } from "vitest";
import {
  ROTAS_GLOBAIS,
  extrairWorkspaceDaUrl,
  workspacePath,
} from "../../../src/web/lib/routes.js";

describe("rotas web por workspace", () => {
  it("mantém o catálogo de rotas globais", () => {
    expect(ROTAS_GLOBAIS).toEqual(["/", "/workspaces", "/analytics", "/config/global", "/docs"]);
  });

  it("monta caminhos canônicos sem barras duplicadas", () => {
    expect(workspacePath("corp alpha", "/tasks/")).toBe("/w/corp%20alpha/tasks");
    expect(workspacePath("corp-a")).toBe("/w/corp-a");
  });

  it("anexa apenas parâmetros definidos", () => {
    expect(
      workspacePath("corp-a", "historico", {
        run: "exec 1",
        vazio: "",
        ausente: undefined,
        nulo: null,
      }),
    ).toBe("/w/corp-a/historico?run=exec+1&vazio=");
  });

  it("extrai o workspace e rejeita caminhos fora do padrão", () => {
    expect(extrairWorkspaceDaUrl("/w/corp%20alpha/tasks")).toBe("corp alpha");
    expect(extrairWorkspaceDaUrl("/workspaces")).toBeNull();
    expect(extrairWorkspaceDaUrl("/w/%E0%A4%A/tasks")).toBeNull();
  });
});
