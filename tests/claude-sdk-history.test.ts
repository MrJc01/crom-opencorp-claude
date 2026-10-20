import { describe, expect, it } from "vitest";
import { converterTranscricaoSdk, removerContextoWorkspace } from "../src/core/engines/adapters/claude-sdk-history.js";

const contexto = '[CONTEXTO OPERACIONAL DO WORKSPACE: "ws"]\nCaminho Base: /x\n- Tarefa "a --- b"\n---\n\n';

describe("converterTranscricaoSdk", () => {
  it("remove o contexto do workspace e mantém só o que o dono escreveu", () => {
    expect(removerContextoWorkspace(`${contexto}oi`)).toBe("oi");
    expect(removerContextoWorkspace("sem contexto")).toBe("sem contexto");
  });

  it("monta mensagens, ações e status das ferramentas", () => {
    const msgs = converterTranscricaoSdk([
      { type: "user", uuid: "1", message: { content: [{ type: "text", text: `${contexto}rode date` }] } },
      { type: "assistant", uuid: "2", message: { content: [{ type: "text", text: "Vou rodar." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "date" } }] } },
      { type: "user", uuid: "3", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: false }] } },
      { type: "assistant", uuid: "4", message: { content: [{ type: "text", text: "Pronto." }] } },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[0]!.content).toBe("rode date");
    expect(msgs[1]!.content).toBe("Vou rodar.\n\nPronto.");
    expect(msgs[1]!.acoes).toEqual([{ ferramenta: "Bash", resumo: "$ date", status: "completed", sucesso: true }]);
  });

  it("resultado com erro marca a ação como falha", () => {
    const msgs = converterTranscricaoSdk([
      { type: "user", uuid: "1", message: { content: "x" } },
      { type: "assistant", uuid: "2", message: { content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a" } }] } },
      { type: "user", uuid: "3", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] } },
    ]);
    expect(msgs[1]!.acoes![0]).toMatchObject({ resumo: "Read /a", status: "failed", sucesso: false });
  });
});
