import { expect, test } from "@playwright/test";
import { api, logado, seederEmpresaBasica } from "../helpers.js";

const TOKEN = "test-e2e";
const WORKSPACE = "e2e-corp";

test.describe("Roteamento canônico por workspace", () => {
  test.beforeEach(async ({ page }) => {
    logado(page, TOKEN, WORKSPACE);
    await seederEmpresaBasica(api(page), TOKEN, WORKSPACE);
  });

  test("aceita deep links diretos em todos os módulos scoped", async ({ page }) => {
    const modulos = [
      "",
      "workspace",
      "tasks",
      "secretario",
      "agentes",
      "fluxos",
      "reunioes",
      "historico",
      "apps",
      "ativos",
      "notificacoes",
      "config",
    ];

    for (const modulo of modulos) {
      const path = `/w/${WORKSPACE}${modulo ? `/${modulo}` : ""}`;
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}/?(\\?.*)?$`));
      await expect(page.locator("main").first()).toBeVisible();
    }
  });

  test("rotas legadas preservam queries e aplicam defaults sem sobrescrever", async ({ page }) => {
    await page.goto("/tasks?task=tsk-123&filtro=aberto&filtro=urgente");
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}/tasks\\?`));

    let url = new URL(page.url());
    expect(url.searchParams.get("task")).toBe("tsk-123");
    expect(url.searchParams.getAll("filtro")).toEqual(["aberto", "urgente"]);

    await page.goto("/agenda?origem=legado");
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}/fluxos\\?`));
    url = new URL(page.url());
    expect(url.searchParams.get("origem")).toBe("legado");
    expect(url.searchParams.get("filtro")).toBe("cron");
  });

  test("trata workspace inválido, inexistente e raiz sem seleção", async ({ page, browser }) => {
    await page.goto("/w/ID_INVALIDO/tasks");
    await expect(page).toHaveURL(/\/workspaces$/);

    await page.goto("/w/workspace-inexistente/tasks");
    await expect(page.getByText("Workspace não encontrado", { exact: true })).toBeVisible();

    const contextoSemWorkspace = await browser.newContext();
    const paginaSemWorkspace = await contextoSemWorkspace.newPage();
    const requisicoesGlobais: Array<{ path: string; workspace?: string }> = [];
    paginaSemWorkspace.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/workspaces" || path === "/events") {
        requisicoesGlobais.push({
          path,
          workspace: request.headers()["x-opencorp-workspace"],
        });
      }
    });
    await paginaSemWorkspace.addInitScript((token) => {
      localStorage.setItem("oc-token", token);
    }, TOKEN);
    await paginaSemWorkspace.goto("/");
    await expect(paginaSemWorkspace).toHaveURL(/\/workspaces$/);
    await expect.poll(() => requisicoesGlobais.some((item) => item.path === "/workspaces")).toBe(true);
    expect(requisicoesGlobais.filter((item) => item.path === "/workspaces"))
      .toEqual(expect.arrayContaining([{ path: "/workspaces", workspace: undefined }]));
    expect(requisicoesGlobais.some((item) => item.path === "/events")).toBe(false);
    await contextoSemWorkspace.close();
  });

  test("duas abas mantêm o client da URL após o storage compartilhado mudar", async ({ page }) => {
    const outroWorkspace = "e2e-corp-b";
    await seederEmpresaBasica(api(page), TOKEN, outroWorkspace);

    const paginaB = await page.context().newPage();
    await paginaB.addInitScript((token) => {
      localStorage.setItem("oc-token", token);
    }, TOKEN);

    const workspacesPaginaA: string[] = [];
    const workspacesPaginaB: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/tasks") {
        workspacesPaginaA.push(request.headers()["x-opencorp-workspace"] ?? "");
      }
    });
    paginaB.on("request", (request) => {
      if (new URL(request.url()).pathname === "/tasks") {
        workspacesPaginaB.push(request.headers()["x-opencorp-workspace"] ?? "");
      }
    });

    await page.goto(`/w/${WORKSPACE}/tasks`);
    await expect.poll(() => workspacesPaginaA.includes(WORKSPACE)).toBe(true);

    await paginaB.goto(`/w/${outroWorkspace}/tasks`);
    await expect.poll(() => workspacesPaginaB.includes(outroWorkspace)).toBe(true);

    // A aba B sobrescreveu o storage compartilhado; a URL da aba A continua soberana.
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/w/${WORKSPACE}/tasks$`));
    await expect.poll(() => workspacesPaginaA.at(-1)).toBe(WORKSPACE);

    await paginaB.close();
  });
});
