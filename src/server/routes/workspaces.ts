/**
 * Rotas de Workspaces — Extração Modular (MICRO-PASSO 10)
 */

import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { writeFileAtomic } from "../../utils/fs-safe.js";
import type { RouteContext } from "./types.js";

const SUBROTAS_RESERVADAS = new Set([
  "current",
  "ativo",
  "import-corp",
  "driver-info",
  "driver-config",
  "git",
]);

export async function handleWorkspaceRoutes(ctx: RouteContext): Promise<boolean> {
  const { req, res, url, rota, resolverWs, lerCorpo, enviar, workspaces, templates } = ctx;

  // ── 1. GET /workspaces — lista workspaces disponíveis ──
  if (rota === "/workspaces" && req.method === "GET") {
    enviar(res, 200, await workspaces.listar());
    return true;
  }

  // ── 2. POST /workspaces — cria novo workspace ──
  if (rota === "/workspaces" && req.method === "POST") {
    const corpo = (await lerCorpo(req)) as {
      id?: string;
      template?: string;
      path?: string;
      perfil?: {
        empresa?: string;
        nicho?: string;
        publico?: string;
        tom?: string;
        tom_evitar?: unknown[];
        topicos?: unknown[];
        diferenciais?: unknown[];
      };
    };

    const criado = await workspaces.criar(corpo.id ?? "", {
      template: corpo.template,
      path: corpo.path,
    });

    // Perfil editorial opcional → grava .opencorp/projeto.json no workspace
    if (corpo.perfil && typeof corpo.perfil === "object") {
      const p = corpo.perfil;
      const projeto: Record<string, unknown> = {
        empresa: String(p.empresa ?? criado.id),
        nicho: String(p.nicho ?? ""),
        publico: String(p.publico ?? ""),
        tom: String(p.tom ?? ""),
        tom_evitar: Array.isArray(p.tom_evitar) ? p.tom_evitar.map(String) : [],
        topicos_editoriais: Array.isArray(p.topicos) ? p.topicos.map(String) : [],
      };
      if (Array.isArray(p.diferenciais)) projeto.diferenciais = p.diferenciais.map(String);
      await writeFileAtomic(join(criado.path, ".opencorp", "projeto.json"), `${JSON.stringify(projeto, null, 2)}\n`);
    }

    enviar(res, 201, { id: criado.id, caminho: criado.path });
    return true;
  }

  // ── 3. POST /workspaces/import-corp — importa template e cria workspace ──
  if (rota === "/workspaces/import-corp" && req.method === "POST") {
    const corpo = (await lerCorpo(req)) as {
      id?: string;
      nome_arquivo?: string;
      arquivo_base64: string;
      path?: string;
    };
    if (!corpo.arquivo_base64 || typeof corpo.arquivo_base64 !== "string") {
      enviar(res, 400, { erro: "arquivo_base64 obrigatório" });
      return true;
    }

    const nomeLimpo = (corpo.nome_arquivo || "workspace.corp")
      .replace(/\.corp$/i, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-");
    const idAlvo = (corpo.id ? String(corpo.id).trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-") : "") || nomeLimpo || `ws-${Date.now()}`;

    const tmpPath = join(tmpdir(), `opencorp-import-${Date.now()}-${randomBytes(4).toString("hex")}.corp`);
    try {
      const b64Limpo = corpo.arquivo_base64.replace(/^data:[^;]+;base64,/, "");
      writeFileSync(tmpPath, Buffer.from(b64Limpo, "base64"));

      const templateId = `import-${idAlvo}-${Date.now()}`;
      if (templates) {
        await templates.importar(tmpPath, templateId);
      }
      const criado = await workspaces.criar(idAlvo, { template: templateId, path: corpo.path });
      enviar(res, 201, { ok: true, id: criado.id, caminho: criado.path });
    } catch (err: unknown) {
      const mensagem = err instanceof Error ? err.message : String(err);
      enviar(res, 500, { erro: `Falha ao importar .corp: ${mensagem}` });
    } finally {
      try {
        if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
      } catch {}
    }
    return true;
  }

  // ── 4. GET /workspaces/current ou /workspaces/ativo — retorna workspace atual ──
  if ((rota === "/workspaces/current" || rota === "/workspaces/ativo") && req.method === "GET") {
    const ws = await resolverWs(url);
    const atual = await workspaces.atual();
    enviar(res, 200, { id: ws.id, caminho: ws.path, ativo: atual?.id === ws.id });
    return true;
  }

  // ── 5. POST /workspaces/ativo — seleciona/troca o workspace ativo ──
  if ((rota === "/workspaces/ativo" || rota === "/workspaces/current") && req.method === "POST") {
    const corpo = (await lerCorpo(req)) as { id?: string };
    if (!corpo.id) {
      enviar(res, 400, { erro: "id do workspace obrigatório" });
      return true;
    }
    const ativado = await workspaces.usar(corpo.id);
    enviar(res, 200, { ok: true, id: ativado.id, caminho: ativado.path });
    return true;
  }

  // ── 5b. POST /workspaces/:id/pausa — pausa/retoma o workspace (agendador não dispara fluxos) ──
  const mPausa = /^\/workspaces\/([^/]+)\/pausa$/.exec(rota);
  if (mPausa && req.method === "POST") {
    const id = decodeURIComponent(mPausa[1]!);
    const corpo = (await lerCorpo(req)) as { pausado?: boolean };
    if (typeof corpo.pausado !== "boolean") {
      enviar(res, 400, { erro: "campo 'pausado' (booleano) é obrigatório" });
      return true;
    }
    const info = await workspaces.definirPausado(id, corpo.pausado);
    enviar(res, 200, { ok: true, id: info.id, pausado: info.pausado === true });
    return true;
  }

  // ── 6. Rotas por ID: GET /workspaces/:id e DELETE /workspaces/:id ──
  const mWs = /^\/workspaces\/([^/]+)$/.exec(rota);
  if (mWs) {
    const id = decodeURIComponent(mWs[1]!);
    if (SUBROTAS_RESERVADAS.has(id)) {
      return false;
    }

    if (req.method === "GET") {
      const detalhes = await workspaces.detalhar(id);
      enviar(res, 200, detalhes);
      return true;
    }

    if (req.method === "DELETE") {
      const resultado = await workspaces.deletar(id, { sim: true });
      enviar(res, 200, { ok: true, id, ...resultado });
      return true;
    }
  }

  // ── 7. workspace driver info (isolation mode) ─────────────────
  if (rota === "/workspaces/driver-info" && req.method === "GET") {
    const ws = await resolverWs(url);
    try {
      const { readFile } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      let driverTipo = "sandbox"; // padrão de fábrica
      let limites: { ramMb?: number; cpuPct?: number; redeIsolada?: boolean; dominiosPermitidos?: string[] } = {};

      // 1. Config global
      const globalConfigPath = join(process.env.HOME || "", ".opencorp", "config.json");
      if (existsSync(globalConfigPath)) {
        try {
          const gc = JSON.parse(await readFile(globalConfigPath, "utf8"));
          if (gc.execution_driver) driverTipo = gc.execution_driver;
          if (gc.limites) limites = gc.limites;
        } catch {}
      }

      // 2. Config do workspace (override)
      const wsConfigPath = join(ws.path, ".opencorp", "config.json");
      if (existsSync(wsConfigPath)) {
        try {
          const wc = JSON.parse(await readFile(wsConfigPath, "utf8"));
          if (wc.execution_driver) driverTipo = wc.execution_driver;
          if (wc.limites) limites = { ...limites, ...wc.limites };
        } catch {}
      }

      // 3. Verifica disponibilidade real do driver
      const { resolverDriverExecucao } = await import("../../core/contexts/execution/execution-driver.js");
      const driver = await resolverDriverExecucao(driverTipo);

      enviar(res, 200, {
        ok: true,
        workspace: ws.id,
        driver_configurado: driverTipo,
        driver_ativo: driver.tipo,
        limites,
      });
    } catch {
      enviar(res, 200, { ok: true, workspace: ws.id, driver_configurado: "sandbox", driver_ativo: "host", limites: {} });
    }
    return true;
  }

  if (rota === "/workspaces/driver-config" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as {
      driver?: string;
      limites?: { ramMb?: number; cpuPct?: number; redeIsolada?: boolean; dominiosPermitidos?: string[] };
    };

    try {
      const { readFile, writeFile, mkdir } = await import("node:fs/promises");
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");

      const dirConfig = join(ws.path, ".opencorp");
      if (!existsSync(dirConfig)) {
        await mkdir(dirConfig, { recursive: true });
      }
      const wsConfigPath = join(dirConfig, "config.json");
      let wc: Record<string, any> = {};
      if (existsSync(wsConfigPath)) {
        try {
          wc = JSON.parse(await readFile(wsConfigPath, "utf8"));
        } catch {}
      }

      if (corpo.driver) {
        wc.execution_driver = corpo.driver;
      }
      if (corpo.limites !== undefined) {
        wc.limites = {
          ramMb: corpo.limites.ramMb ? Number(corpo.limites.ramMb) : undefined,
          cpuPct: corpo.limites.cpuPct ? Number(corpo.limites.cpuPct) : undefined,
          redeIsolada: corpo.limites.redeIsolada === true ? true : undefined,
          dominiosPermitidos: Array.isArray(corpo.limites.dominiosPermitidos)
            ? corpo.limites.dominiosPermitidos.map(String)
            : undefined,
        };
      }

      await writeFile(wsConfigPath, JSON.stringify(wc, null, 2), "utf8");

      enviar(res, 200, {
        ok: true,
        workspace: ws.id,
        driver_configurado: wc.execution_driver,
        limites: wc.limites,
        mensagem: "Configurações de isolamento e limites salvas com sucesso",
      });
    } catch (e: any) {
      enviar(res, 500, { erro: `Falha ao salvar configuração: ${e.message || String(e)}` });
    }
    return true;
  }

  // ── 8. workspace git ───────────────────────────────────────────
  if (rota === "/workspaces/git/log" && req.method === "GET") {
    const ws = await resolverWs(url);
    const limite = Number(url.searchParams.get("limite") || "30");
    const arquivo = url.searchParams.get("arquivo") || undefined;
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const commits = await wsGit.listarHistorico(ws.path, limite, arquivo);
    enviar(res, 200, { ok: true, workspace: ws.id, arquivo, commits });
    return true;
  }
  if (rota === "/workspaces/git/diff" && req.method === "GET") {
    const ws = await resolverWs(url);
    const hash = url.searchParams.get("hash") || undefined;
    const arquivo = url.searchParams.get("arquivo") || undefined;
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const diff = await wsGit.obterDiff(ws.path, hash, arquivo);
    enviar(res, 200, { ok: true, workspace: ws.id, hash, arquivo, diff });
    return true;
  }
  if (rota === "/workspaces/git/status" && req.method === "GET") {
    const ws = await resolverWs(url);
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const status = await wsGit.obterStatusArquivos(ws.path);
    enviar(res, 200, { ok: true, workspace: ws.id, ...status });
    return true;
  }
  if (rota === "/workspaces/git/restore" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { arquivo?: string; commit?: string };
    if (!corpo.arquivo) {
      enviar(res, 400, { ok: false, erro: "campo 'arquivo' é obrigatório" });
      return true;
    }
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.restaurarArquivo(ws.path, corpo.arquivo, corpo.commit);
    enviar(res, resultado.sucesso ? 200 : 400, resultado);
    return true;
  }
  if (rota === "/workspaces/git/branches" && req.method === "GET") {
    const ws = await resolverWs(url);
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const info = await wsGit.listarBranches(ws.path);
    enviar(res, 200, { ok: true, workspace: ws.id, ...info });
    return true;
  }
  if (rota === "/workspaces/git/branch" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { nome?: string; criarNova?: boolean };
    if (!corpo.nome) {
      enviar(res, 400, { ok: false, erro: "campo 'nome' é obrigatório" });
      return true;
    }
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.criarOuAlternarBranch(ws.path, corpo.nome, corpo.criarNova);
    enviar(res, resultado.sucesso ? 200 : 400, resultado);
    return true;
  }
  if (rota === "/workspaces/git/init" && req.method === "POST") {
    const ws = await resolverWs(url);
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.inicializar(ws.path);
    enviar(res, 200, { ok: resultado.inicializado, ...resultado });
    return true;
  }
  if (rota === "/workspaces/git/rollback" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { alvo?: string };
    if (!corpo.alvo) {
      enviar(res, 400, { ok: false, erro: "campo 'alvo' é obrigatório (hash, tag ou execId)" });
      return true;
    }
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.reverter(ws.path, corpo.alvo);
    enviar(res, resultado.sucesso ? 200 : 400, resultado);
    return true;
  }
  if (rota === "/workspaces/git/checkpoints" && req.method === "GET") {
    const ws = await resolverWs(url);
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const checkpoints = await wsGit.listarCheckpoints(ws.path);
    enviar(res, 200, { ok: true, workspace: ws.id, checkpoints });
    return true;
  }
  if (rota === "/workspaces/git/task-branch" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { tarefa?: string; taskId?: string };
    const id = corpo.tarefa ?? corpo.taskId;
    if (!id) {
      enviar(res, 400, { ok: false, erro: "campo 'tarefa' é obrigatório" });
      return true;
    }
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.criarBranchTarefa(ws.path, id);
    enviar(res, resultado.sucesso ? 200 : 400, { ok: resultado.sucesso, ...resultado });
    return true;
  }
  if (rota === "/workspaces/git/worktrees" && req.method === "GET") {
    const ws = await resolverWs(url);
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const worktrees = await wsGit.listarWorktrees(ws.path);
    enviar(res, 200, { ok: true, workspace: ws.id, worktrees });
    return true;
  }
  if (rota === "/workspaces/git/worktrees" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { branch?: string; caminho?: string };
    if (!corpo.branch) {
      enviar(res, 400, { ok: false, erro: "campo 'branch' é obrigatório" });
      return true;
    }
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.criarWorktree(ws.path, corpo.branch, corpo.caminho);
    enviar(res, resultado.sucesso ? 200 : 400, { ok: resultado.sucesso, ...resultado });
    return true;
  }
  if (rota === "/workspaces/git/worktrees" && req.method === "DELETE") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { caminho?: string };
    const caminho = corpo.caminho ?? url.searchParams.get("caminho") ?? undefined;
    if (!caminho) {
      enviar(res, 400, { ok: false, erro: "campo 'caminho' é obrigatório" });
      return true;
    }
    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    const resultado = await wsGit.removerWorktree(ws.path, caminho);
    enviar(res, resultado.sucesso ? 200 : 400, { ok: resultado.sucesso, ...resultado });
    return true;
  }

  return false;
}
