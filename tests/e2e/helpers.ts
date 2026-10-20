import { type Page, type APIRequestContext } from "@playwright/test";

export function logado(page: Page, token = "test-e2e", ws = "e2e-corp"): void {
  page.addInitScript(({ t, w }) => {
    window.localStorage.setItem("oc-token", t);
    window.localStorage.setItem("oc-ws", w);
  }, { t: token, w: ws });
}

export function api(page: Page): APIRequestContext {
  return page.request;
}

/** Erro de transporte (servidor ocupado/reiniciando), nunca falha de asserção nem resposta HTTP 4xx/5xx. */
function erroDeTransporte(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e);
  return /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|socket hang up|Timeout .*exceeded|timed out/i.test(m)
    && !/expect\(/.test(m);
}

/** Repete `fn` só para erros de transporte (com recuo), até `tentativas`. */
export async function comRetryTransporte<R>(fn: () => Promise<R>, tentativas = 5): Promise<R> {
  let ultimo: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!erroDeTransporte(e)) throw e;
      ultimo = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw ultimo;
}

/** Espera o servidor responder /health (e aceitar a API autenticada) antes de semear. */
export async function esperarServidorPronto(api: APIRequestContext, token = "test-e2e"): Promise<void> {
  await expectPollSimples(async () => {
    const r = await api.get("/workspaces", { headers: { authorization: `Bearer ${token}` }, timeout: T(10_000) });
    return r.ok();
  }, T(60_000));
}

async function expectPollSimples(cond: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const fim = Date.now() + timeoutMs;
  let ultimo: unknown;
  while (Date.now() < fim) {
    try {
      if (await cond()) return;
    } catch (e) {
      ultimo = e;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Servidor não ficou pronto em ${timeoutMs} ms: ${String((ultimo as Error)?.message ?? ultimo)}`);
}

export async function seederEmpresaBasica(api: APIRequestContext, token: string, wsId = "e2e-corp"): Promise<void> {
  await esperarServidorPronto(api);
  await comRetryTransporte(() => seederEmpresaBasicaUmaVez(api, token, wsId));
}

async function seederEmpresaBasicaUmaVez(api: APIRequestContext, token: string, wsId: string): Promise<void> {
  // 1. Criar/obter workspace
  let wsResp = await api.post("/workspaces", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { id: wsId },
  });
  // Ignora 4xx se já existe
  if (wsResp.status() >= 400) {
    wsResp = await api.get("/workspaces", {
      headers: { authorization: `Bearer ${token}` },
    });
    const workspaces = await wsResp.json();
    const existe = workspaces.find((w: { id: string }) => w.id === wsId);
    if (!existe) throw new Error(`Workspace ${wsId} não pôde ser criado nem encontrado`);
  }

  // 2. Criar 2 tasks (uma backlog, uma feito) — SEMPRE com workspace explícito (senão cai no ativo da produção)
  await api.post(`/tasks?workspace=${encodeURIComponent(wsId)}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { titulo: "Task backlog e2e", descricao: "Descrição backlog", coluna: "backlog", prioridade: "media" },
  });
  await api.post(`/tasks?workspace=${encodeURIComponent(wsId)}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: { titulo: "Task feito e2e", descricao: "Descrição feito", coluna: "feito", prioridade: "alta" },
  });

  // 3. Criar 1 team com pipeline válido — com workspace
  const teamSpec = {
    id: "e2e-pipe",
    titulo: "Pipe E2E",
    padrao: "pipeline",
    passos: [
      { agente: "a", ordem: "x" },
      { agente: "b", ordem: "y" },
    ],
    criado_em: new Date().toISOString(),
  };
  const teamResp = await api.post(`/teams?workspace=${encodeURIComponent(wsId)}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: teamSpec,
  });
  if (teamResp.status() >= 400 && teamResp.status() !== 409) {
    const body = await teamResp.text();
    console.warn(`Team creation failed: ${teamResp.status()} ${body}`);
  }

  // 4. Criar app com widget metrica — com workspace
  const appSpec = {
    id: "painel-tarefas",
    titulo: "Painel de Tarefas",
    paginas: [
      {
        titulo: "Visão",
        widgets: [
          { id: "m1", tipo: "metrica", titulo: "Tasks", fonte: { rota: "/tasks" } },
        ],
      },
    ],
  };
  const appResp = await api.post(`/apps?workspace=${encodeURIComponent(wsId)}`, {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: appSpec,
  });
  if (appResp.status() >= 400 && appResp.status() !== 409) {
    const body = await appResp.text();
    console.warn(`App creation failed: ${appResp.status()} ${body}`);
  }

  // 5. Rotina agendada = fluxo com nó cron (POST /schedules foi aposentado → 410).
  await api.post("/flows", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    data: {
      id: "job-e2e-corp",
      nome: "job-e2e-corp",
      nos: [
        { id: "gatilho", tipo: "cron", config: { expressao_cron: "0 * * * *" } },
        { id: "espera", tipo: "delay", config: { segundos: 1 } },
      ],
      arestas: [{ de: "gatilho", para: "espera" }],
    },
  });
}

export async function esperarNavegacao(page: Page, hash: string): Promise<void> {
  const caminho = hash.startsWith("/") ? hash : `/${hash}`;
  await page.goto(caminho);
  // Rotas legadas redirecionam para /w/<workspace>/<módulo>; a home é o índice /w/<workspace>.
  await page.waitForURL(
    (u) => (caminho === "/home" || caminho === "/" ? /^\/w\/[^/]+\/?$/.test(u.pathname) : u.pathname.endsWith(caminho)),
    { timeout: T(10000) },
  );
  // Aguarda a view ter conteúdo (não vazia) - espera renderização assíncrona
  await page.waitForFunction(
    (h) => {
      const view = document.getElementById(`view-${h}`) || document.querySelector("main");
      return view && view.innerHTML.trim().length > 0;
    },
    hash,
    { timeout: T(15000) }
  );
}

export async function esperarElementoTexto(page: Page, texto: string, timeout = T(10000)): Promise<void> {
  await page.getByText(texto, { exact: false }).first().waitFor({ state: "visible", timeout });
}

export async function preencherEEnviar(page: Page, seletor: string, texto: string): Promise<void> {
  await page.fill(seletor, texto);
  await page.press(seletor, "Enter");
}
/** Fator de tempo (E2E_TIMEOUT_FACTOR, padrão 3): máquina com carga alta de renderização de vídeo. */
export const FATOR_TEMPO = Math.max(1, Number(process.env.E2E_TIMEOUT_FACTOR ?? 3) || 3);

/** Escala um timeout explícito (ms) pelo fator de tempo. */
export function T(ms: number): number {
  return ms * FATOR_TEMPO;
}
