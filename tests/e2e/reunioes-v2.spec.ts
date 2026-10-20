import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { logado, seederEmpresaBasica, api, esperarElementoTexto } from "./helpers.js";
import { T } from "./helpers.js";

/** Reuniões: convocar pela UI + API, sala semeada no histórico e agendamento via scheduler. */
test.describe("Reuniões (sala + histórico + agendamento)", () => {
  const sufixo = Date.now().toString(36);
  const HDR = { authorization: "Bearer test-e2e", "content-type": "application/json" };

  test.beforeEach(async ({ page }) => {
    logado(page, "test-e2e");
    await seederEmpresaBasica(api(page), "test-e2e");
    await page.goto("/");
    await esperarElementoTexto(page, "Governança da Empresa Autônoma");
  });

  test("(a) Convocar pela UI abre a sala; POST /meetings responde 202 com id", async ({ page }) => {
    const pauta = `Pauta v2 e2e-${sufixo}`;
    await page.goto("/reunioes");
    await page.getByRole("button", { name: "Nova Reunião" }).first().click();
    await page.getByPlaceholder(/Definir linha editorial/).fill(pauta);
    await page.locator("button[aria-pressed]", { hasText: /@/ }).first().click();
    await page.getByRole("button", { name: "Iniciar Deliberação" }).click();

    await page.waitForURL(/reuniao=/, { timeout: T(15000) });
    await expect(page.getByText(pauta).first()).toBeVisible({ timeout: T(15000) });

    const resp = await api(page).post("/meetings?workspace=e2e-corp", {
      headers: HDR,
      data: { pauta: `Pauta v2 API e2e-${sufixo}` },
    });
    expect(resp.status()).toBe(202);
    const corpo = await resp.json();
    expect(corpo.status).toBe("iniciado");
    expect(String(corpo.id)).toMatch(/^reuniao-/);
  });

  test("(b) Sala semeada aparece no histórico e abre pelo modal", async ({ page }) => {
    const salaId = "reuniao-e2e-viva";
    const dir = join("/dev/shm/opencorp-e2e", ".opencorp", "workspaces", "e2e-corp", ".opencorp", "registries", "chats", salaId);
    await mkdir(dir, { recursive: true });
    const meta = {
      id: salaId,
      categoria: "chats",
      descricao: "Reunião: pauta da sala viva e2e",
      criado_por: "opencorp",
      criado_em: new Date().toISOString(),
      atualizado_em: new Date().toISOString(),
      permissoes: { leitura: ["*"], escrita: ["opencorp"], modificacao_meta: [] },
      tags: ["reuniao"],
      referencias: [],
      extras: {
        tipo: "reuniao",
        pauta: "pauta da sala viva e2e",
        participantes: ["ag-alice", "ag-beto"],
        status: "em-andamento",
      },
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    await writeFile(join(dir, "conteudo.md"), `# Reunião ${salaId}\n\n- Pauta: pauta da sala viva e2e\n`, "utf8");

    const lista = await api(page).get("/meetings?workspace=e2e-corp", { headers: HDR });
    expect(lista.status()).toBe(200);
    const salas = await lista.json();
    expect(salas.some((s: any) => s.id === salaId)).toBe(true);

    await page.goto("/reunioes");
    await expect(page.getByRole("button", { name: /Histórico \(\d+\)/ })).toBeVisible({ timeout: T(15000) });
    await expect(page.getByText("pauta da sala viva e2e").first()).toBeVisible({ timeout: T(10000) });
    await page.getByText("pauta da sala viva e2e").first().click();
    await page.waitForURL(new RegExp(`reuniao=${salaId}`), { timeout: T(10000) });
  });

  test("(c) Agendar reunião = fluxo cron + nó reunião; aparece na agenda e excluir remove", async ({ page }) => {
    const pauta = `revisao agendada e2e-${sufixo}`;
    const fid = `reuniao-agendada-${sufixo}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const criado = await api(page).post("/flows", {
      headers: HDR,
      data: {
        id: fid,
        nome: `Reunião agendada ${sufixo}`,
        nos: [
          { id: "gatilho", tipo: "cron", config: { expressao_cron: "0 9 * * 1" } },
          { id: "reuniao", tipo: "reuniao", config: { pauta } },
        ],
        arestas: [{ de: "gatilho", para: "reuniao" }],
      },
    });
    expect([200, 201]).toContain(criado.status());

    const doFluxo = (j: { id: string; nome?: string }) => j.id === `flow:${fid}` || j.id === fid || j.nome === fid;
    const jobs = (await (await api(page).get("/schedules?workspace=e2e-corp", { headers: HDR })).json()) as Array<{ id: string; nome?: string }>;
    expect(jobs.some(doFluxo)).toBe(true);

    // aparece na agenda (/agenda → fluxos filtrados por cron)
    await page.goto("/agenda");
    await expect(page.getByTestId(`fluxo-card-${fid}`)).toBeVisible({ timeout: T(15000) });

    const del = await api(page).delete(`/flows/${fid}`, { headers: HDR });
    expect(del.ok()).toBe(true);
    const depois = (await (await api(page).get("/schedules?workspace=e2e-corp", { headers: HDR })).json()) as Array<{ id: string; nome?: string }>;
    expect(depois.some(doFluxo)).toBe(false);
  });
});
