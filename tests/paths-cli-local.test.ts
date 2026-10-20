/**
 * O `oc` global pode ser de outra instalação do OpenCorp; processos filhos usam o deste checkout.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathComCliLocal, projectRoot } from "../src/utils/paths.js";

describe("pathComCliLocal", () => {
  const dir = join(projectRoot(), "bin", "path");

  it("põe bin/path deste checkout na frente do PATH", () => {
    expect(pathComCliLocal("/usr/bin:/outro/opencorp/bin")).toBe(`${dir}:/usr/bin:/outro/opencorp/bin`);
  });

  it("não duplica a entrada quando ela já está no PATH", () => {
    expect(pathComCliLocal(`/usr/bin:${dir}`)).toBe(`${dir}:/usr/bin`);
  });
});
