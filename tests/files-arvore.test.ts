import { afterAll, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { construirArvore } from "../src/server/routes/files.js";

const raizes: string[] = [];
afterAll(async () => {
  await Promise.all(raizes.map((r) => rm(r, { recursive: true, force: true })));
});

describe("construirArvore", () => {
  it("o teto de nós corta os níveis fundos, não as pastas da raiz", async () => {
    const raiz = await mkdtemp(join(tmpdir(), "opencorp-arvore-"));
    raizes.push(raiz);
    // "a" (primeira na ordem alfabética) tem 40 subpastas; "z" tem só um arquivo.
    for (let i = 0; i < 40; i++) {
      await mkdir(join(raiz, "a", `sub${i}`), { recursive: true });
      await writeFile(join(raiz, "a", `sub${i}`, "x.txt"), "x");
    }
    await mkdir(join(raiz, "z"), { recursive: true });
    await writeFile(join(raiz, "z", "importante.txt"), "x");

    const { arvore, truncado } = await construirArvore(raiz, 6, 20);

    const z = arvore.find((n) => n.nome === "z");
    expect(z?.filhos?.map((f) => f.nome)).toEqual(["importante.txt"]);
    expect(truncado).toBe(true);
  });

  it("sem teto atingido devolve a árvore inteira e não marca truncado", async () => {
    const raiz = await mkdtemp(join(tmpdir(), "opencorp-arvore-"));
    raizes.push(raiz);
    await mkdir(join(raiz, "p", "q"), { recursive: true });
    await writeFile(join(raiz, "p", "q", "f.txt"), "x");
    const { arvore, truncado } = await construirArvore(raiz, 6);
    expect(arvore[0]?.filhos?.[0]?.filhos?.[0]?.nome).toBe("f.txt");
    expect(truncado).toBe(false);
  });
});
