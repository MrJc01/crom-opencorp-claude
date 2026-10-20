import { describe, expect, it } from "vitest";
import { idConversaNativo } from "../src/server/routes/secretario/runtime-service.js";

describe("idConversaNativo", () => {
  it("ids de rascunho do front não chegam ao motor", () => {
    expect(idConversaNativo("sessao-1792500610534")).toBeUndefined();
    expect(idConversaNativo("draft-abc")).toBeUndefined();
    expect(idConversaNativo("SESSAO-1")).toBeUndefined();
  });

  it("id nativo passa intacto; vazio vira undefined", () => {
    expect(idConversaNativo("9887dbe2-52b7-4e90-8ecc-a0c58bee1f79")).toBe("9887dbe2-52b7-4e90-8ecc-a0c58bee1f79");
    expect(idConversaNativo(" thread-nativa-1 ")).toBe("thread-nativa-1");
    expect(idConversaNativo("")).toBeUndefined();
    expect(idConversaNativo(null)).toBeUndefined();
    expect(idConversaNativo(undefined)).toBeUndefined();
  });
});
