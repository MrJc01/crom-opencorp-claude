import { fetchOpencode } from "../../core/contexts/execution/opencode-server.js";
import { join } from "node:path";
import { eventBus } from "../../core/shared/event-bus.js";
import {
  PADRAO_ERRO_MODELO,
  PADRAO_ERRO_CREDITOS,
  type OpcoesRun,
} from "../../core/contexts/execution/session-manager.js";
import {
  SecretarioError,
  extrairPassosMensagens,
  limparPrefixoWorkspace,
  dirOpencodeData,
  type MensagemOc,
  type ParteOc,
  type PassoChat,
} from "../../core/contexts/execution/opencode-server.js";
import { opencorpHome } from "../../utils/paths.js";
import type { MetaRegistro } from "../../core/contexts/storage/registry-store.js";
import type { RouteContext } from "./types.js";
import { streamsSecretarioAtivos } from "./secretario/stream.js";
import { obterRuntimeSecretario } from "./secretario/runtime-service.js";
import { EventLog, reduzirHistorico } from "../../core/engines/event-log.js";

function fallbackGerarIdExec(): string {
  return `exec-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function handleSessionRoutes(ctx: RouteContext): Promise<boolean> {
  const {
    req,
    res,
    url,
    rota,
    resolverWs,
    lerCorpo,
    enviar,
    sessoes,
    registros,
    workspaces,
    agentes,
    opencodeServer,
    homeDir,
  } = ctx;

  // Normaliza aliases comuns: /sessoes -> /sessions
  const rotaNormal = rota.replace(/^\/sessoes(\/|$)/, "/sessions$1");

  async function getPortaOpencode(autoIniciar = false): Promise<number> {
    if (ctx.portaOpencodeOuErro) return await ctx.portaOpencodeOuErro(autoIniciar);
    if (!opencodeServer) {
      throw new SecretarioError("secretário não iniciado — POST /secretario/start", { status: 409 });
    }
    let status = await opencodeServer.status();
    if (autoIniciar && (!status.rodando || !status.porta)) {
      try {
        const res = await opencodeServer.iniciar();
        if (res.porta) return res.porta;
        status = await opencodeServer.status();
      } catch (err) {
        console.error("[secretario] falha ao auto-iniciar opencode server:", err);
      }
    }
    if (!status.rodando || !status.porta) {
      throw new SecretarioError("secretário não iniciado — POST /secretario/start", { status: 409 });
    }
    return status.porta;
  }

  async function syncSessaoNoCorp(porta: number, sessaoId: string): Promise<void> {
    if (ctx.sincronizarSessaoNoCorp) {
      await ctx.sincronizarSessaoNoCorp(porta, sessaoId);
      return;
    }
    try {
      const res = await fetchOpencode(`http://127.0.0.1:${porta}/session/${sessaoId}/message`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return;
      const msgs = (await res.json()) as Array<{
        info?: { id?: string; role?: string; agent?: string; time?: { created?: number; completed?: number } };
        parts?: Array<{ type: string; text?: string }>;
      }>;
      if (!Array.isArray(msgs) || msgs.length === 0) return;
      const ws = await resolverWs(url);
      const db = registros.corpDb(ws.path);
      const agente = msgs.find((m) => m.info?.agent)?.info?.agent ?? "secretario";
      const iso = (ms?: number): string | undefined => (ms ? new Date(ms).toISOString() : undefined);
      const primeira = iso(msgs[0]?.info?.time?.created);
      const ultima = [...msgs].reverse().find((m) => m.info?.time?.completed)?.info?.time?.completed;
      db.upsertSessao({
        id: sessaoId,
        agente,
        modelo: "",
        inicio: primeira ?? new Date().toISOString(),
        fim: iso(ultima) ?? new Date().toISOString(),
        custo_usd: null,
        status: "concluida",
      });
      for (const m of msgs) {
        const role = m.info?.role;
        const id = m.info?.id;
        if (!id || (role !== "user" && role !== "assistant")) continue;
        const texto = (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim();
        if (!texto) continue;
        db.inserirMensagem({ id, sessao_id: sessaoId, agente, role, conteudo: texto, criado_em: iso(m.info?.time?.created) ?? null });
      }
    } catch {
      /* espelho best-effort */
    }
  }

  // ── GET /sessions ou /sessoes ──────────────────────────────────
  if (rotaNormal === "/sessions" && req.method === "GET") {
    const ws = await resolverWs(url);
    const agente = url.searchParams.get("agent") ?? undefined;
    enviar(res, 200, await sessoes.listarExecucoes(ws.path, agente ? { agente } : undefined));
    return true;
  }

  // ── GET /sessions/:id/log ou /sessoes/:id/log ──────────────────
  const mSessaoLog = /^\/sessions\/([^/]+)\/log$/.exec(rotaNormal);
  if (mSessaoLog && req.method === "GET") {
    const ws = await resolverWs(url);
    const id = decodeURIComponent(mSessaoLog[1]!);
    try {
      enviar(res, 200, { id, log: await sessoes.logDe(ws.path, id) });
      return true;
    } catch {
      const todosWs = await workspaces.listar();
      for (const outro of todosWs) {
        if (outro.path === ws.path) continue;
        try {
          const log = await sessoes.logDe(outro.path, id);
          enviar(res, 200, { id, log });
          return true;
        } catch { }
      }
      try {
        const reg = await registros.obter(ws.path, "execucoes", id);
        if (reg.conteudo && reg.conteudo.trim()) {
          enviar(res, 200, { id, log: reg.conteudo });
          return true;
        }
      } catch { }
      for (const outro of todosWs) {
        try {
          const reg = await registros.obter(outro.path, "execucoes", id);
          if (reg.conteudo && reg.conteudo.trim()) {
            enviar(res, 200, { id, log: reg.conteudo });
            return true;
          }
        } catch { }
      }
      enviar(res, 200, { id, log: "(Nenhuma saída de log capturada para esta execução)" });
      return true;
    }
  }

  // ── POST/DELETE /execucoes/:id/cancelar ou /abort ou /parar ────
  const mExecCancelar = /^(?:\/secretario)?\/(?:execucoes|sessions|sessoes)\/([^/]+)\/(?:cancelar|cancel|abort|parar)$/.exec(rota);
  if (mExecCancelar && (req.method === "POST" || req.method === "DELETE")) {
    const ws = await resolverWs(url);
    const id = decodeURIComponent(mExecCancelar[1]!);

    // Turno de conversa do Secretário ainda vivo (inclusive o de quem reassinou depois de sair da tela, cuja
    // conexão original já caiu): aborta pelo próprio turno.
    const turnoVivo = streamsSecretarioAtivos.get(id);
    if (turnoVivo?.cancelar) {
      turnoVivo.cancelar();
      enviar(res, 200, { ok: true, id, status: "cancelado", cancelado: true, mensagem: "Turno encerrado com sucesso." });
      return true;
    }

    let cancelado = false;
    let wsAlvo = ws.path;

    if (id.startsWith("ses_")) {
      try {
        const porta = await getPortaOpencode();
        await fetchOpencode(`http://127.0.0.1:${porta}/session/${encodeURIComponent(id)}/abort`, { method: "POST" });
        cancelado = true;
      } catch { }
    } else {
      try {
        cancelado = (await sessoes.cancelar?.(ws.path, id)) ?? false;
      } catch { }

      const todosWs = await workspaces.listar();
      for (const outro of todosWs) {
        try {
          const meta = await registros.lerMeta(outro.path, "execucoes", id);
          if (meta) {
            wsAlvo = outro.path;
            if (!cancelado) {
              cancelado = (await sessoes.cancelar?.(outro.path, id)) ?? false;
            }
            break;
          }
        } catch { }
      }
    }

    const atualizarMetaExec = async (caminhoWs: string) => {
      try {
        const meta = await registros.lerMeta(caminhoWs, "execucoes", id);
        const extras = (meta.extras ?? {}) as Record<string, unknown>;
        const inicio = Date.parse(meta.criado_em);
        const fim = new Date().toISOString();
        const duracao = Number.isFinite(inicio) ? Date.now() - inicio : 0;
        meta.extras = {
          ...extras,
          status: "cancelado",
          fim,
          duracao_ms: (extras.duracao_ms as number | null) ?? duracao,
          pid: null,
        };
        await registros.salvarMeta(caminhoWs, "execucoes", id, meta);
        return true;
      } catch {
        return false;
      }
    };

    await atualizarMetaExec(wsAlvo);
    if (wsAlvo !== ws.path) {
      await atualizarMetaExec(ws.path);
    }

    try {
      registros.corpDb(wsAlvo).atualizarStatusExecucao(id, "cancelado");
    } catch { }
    if (wsAlvo !== ws.path) {
      try {
        registros.corpDb(ws.path).atualizarStatusExecucao(id, "cancelado");
      } catch { }
    }

    eventBus.emit("execucao.cancelada", { id });
    enviar(res, 200, { ok: true, id, status: "cancelado", cancelado: true, mensagem: "Execução encerrada com sucesso." });
    return true;
  }

  // ── POST /execucoes/:id/retry ou /sessions/:id/retry ───────────
  const mExecRetry = /^\/(?:execucoes|sessions|sessoes)\/([^/]+)\/retry$/.exec(rota);
  if (mExecRetry && req.method === "POST") {
    const ws = await resolverWs(url);
    const idOriginal = decodeURIComponent(mExecRetry[1]!);
    let meta: MetaRegistro | null = null;
    let wsEfetivo = ws;

    try {
      meta = await registros.lerMeta(ws.path, "execucoes", idOriginal);
    } catch {
      const todosWs = await workspaces.listar();
      for (const outro of todosWs) {
        if (outro.path === ws.path) continue;
        try {
          meta = await registros.lerMeta(outro.path, "execucoes", idOriginal);
          wsEfetivo = { id: outro.id, path: outro.path };
          break;
        } catch { }
      }
    }

    if (!meta) {
      enviar(res, 404, { erro: `Execução "${idOriginal}" não encontrada` });
      return true;
    }

    const extras = (meta.extras ?? {}) as Record<string, unknown>;
    const agenteOriginal = meta.criado_por || String(extras.agente ?? "executor-padrao");
    const ordemOriginal = String(extras.ordem || meta.descricao?.replace(/^Ordem:\s*/i, "") || "");
    let modeloParaExecutar = extras.modelo ? String(extras.modelo) : undefined;
    if (modeloParaExecutar === "-") modeloParaExecutar = undefined;

    if (modeloParaExecutar && sessoes.proximoModeloDaRotacao) {
      let logOriginal = "";
      try {
        logOriginal = await sessoes.logDe(wsEfetivo.path, idOriginal);
      } catch { }
      const erroOriginal = String(extras.erro ?? "");
      const erroCreditos = PADRAO_ERRO_CREDITOS.test(erroOriginal) || PADRAO_ERRO_CREDITOS.test(logOriginal);
      if (PADRAO_ERRO_MODELO.test(erroOriginal) || PADRAO_ERRO_MODELO.test(logOriginal) || extras.status === "falhou") {
        const prox = await sessoes.proximoModeloDaRotacao(
          modeloParaExecutar,
          wsEfetivo.path,
          agenteOriginal,
          [modeloParaExecutar],
          erroCreditos,
        );
        if (prox && prox !== modeloParaExecutar) {
          modeloParaExecutar = prox;
        }
      }
    }

    if (agentes) {
      try {
        const alvo = await agentes.carregar(wsEfetivo.path, agenteOriginal);
        if (alvo.frontmatter.ativo === false) {
          enviar(res, 409, { erro: `Agente '${agenteOriginal}' está desativado — ative no painel de agentes` });
          return true;
        }
      } catch { }
    }

    const novoExecId = ctx.gerarIdExec ? ctx.gerarIdExec() : fallbackGerarIdExec();
    const opcoesRun: OpcoesRun = {
      agente: agenteOriginal,
      ordem: ordemOriginal,
      model: modeloParaExecutar,
      workspaceDir: wsEfetivo.path,
      workspaceId: wsEfetivo.id,
      execId: novoExecId,
      gatilho: { tipo: "manual", origem: `retry:${idOriginal}` },
      retryDe: {
        de_modelo: String(extras.modelo || modeloParaExecutar || ""),
        de_exec: idOriginal,
      },
    };
    void sessoes.rodar(opcoesRun).catch(() => undefined);
    enviar(res, 202, {
      ok: true,
      exec_id: novoExecId,
      exec_id_original: idOriginal,
      agente: agenteOriginal,
      modelo: modeloParaExecutar,
      ordem: ordemOriginal.slice(0, 200),
      status: "iniciado",
      mensagem: `Execução reenviada como ${novoExecId} (clone de ${idOriginal}${modeloParaExecutar ? ` com modelo ${modeloParaExecutar}` : ""})`,
    });
    return true;
  }

  // ── GET /execucoes/:id/diff ou /sessions/:id/diff ──────────────
  const mExecDiff = /^\/(?:execucoes|sessions|sessoes)\/([^/]+)\/diff$/.exec(rota);
  if (mExecDiff && req.method === "GET") {
    const ws = await resolverWs(url);
    const idExec = decodeURIComponent(mExecDiff[1]!);
    let wsEfetivo = ws;

    try {
      await registros.lerMeta(ws.path, "execucoes", idExec);
    } catch {
      const todosWs = await workspaces.listar();
      for (const outro of todosWs) {
        if (outro.path === ws.path) continue;
        try {
          await registros.lerMeta(outro.path, "execucoes", idExec);
          wsEfetivo = { id: outro.id, path: outro.path };
          break;
        } catch { }
      }
    }

    const { WorkspaceGit } = await import("../../core/contexts/workspace/workspace-git.js");
    const wsGit = new WorkspaceGit();
    if (!wsGit.temGit(wsEfetivo.path)) {
      enviar(res, 200, { ok: true, temGit: false, diff: "", arquivos: [] });
      return true;
    }

    try {
      const { execa } = await import("execa");
      const logRes = await execa(
        "git",
        ["log", `--grep=[${idExec}]`, "-n", "1", "--format=%H"],
        { cwd: wsEfetivo.path, reject: false }
      );

      const commitHash = logRes.stdout.trim();

      if (commitHash) {
        const diffCommit = await wsGit.obterDiff(wsEfetivo.path, commitHash);
        const numstat = await execa(
          "git",
          ["show", "--numstat", "--format=", commitHash],
          { cwd: wsEfetivo.path, reject: false }
        );
        const arquivos = numstat.stdout
          .split("\n")
          .filter(Boolean)
          .map((linha) => {
            const partes = linha.split("\t");
            return { caminho: partes[2], adicionadas: partes[0], removidas: partes[1] };
          });
        enviar(res, 200, {
          ok: true,
          temGit: true,
          diff: diffCommit,
          arquivos,
          commitHash,
        });
        return true;
      }

      const tagRes = await execa(
        "git",
        ["tag", "-l", `checkpoint/pre-${idExec}`],
        { cwd: wsEfetivo.path, reject: false }
      );
      if (tagRes.stdout.trim()) {
        const diffCp = await execa(
          "git",
          ["diff", `checkpoint/pre-${idExec}..HEAD`],
          { cwd: wsEfetivo.path, reject: false }
        );
        const numstatCp = await execa(
          "git",
          ["diff", "--numstat", `checkpoint/pre-${idExec}..HEAD`],
          { cwd: wsEfetivo.path, reject: false }
        );
        const arquivos = numstatCp.stdout
          .split("\n")
          .filter(Boolean)
          .map((linha) => {
            const partes = linha.split("\t");
            return { caminho: partes[2], adicionadas: partes[0], removidas: partes[1] };
          });
        enviar(res, 200, {
          ok: true,
          temGit: true,
          diff: diffCp.stdout || "",
          arquivos,
          checkpoint: `checkpoint/pre-${idExec}`,
        });
        return true;
      }

      enviar(res, 200, {
        ok: true,
        temGit: true,
        diff: "",
        arquivos: [],
        mensagem: "Nenhum commit ou alteração registrada para esta execução",
      });
    } catch (e: any) {
      enviar(res, 500, { erro: `Falha ao obter diff da execução: ${e.message || String(e)}` });
    }
    return true;
  }

  // ── GET /execucoes ─────────────────────────────────────────────
  if (rota === "/execucoes" && req.method === "GET") {
    const ws = await resolverWs(url);
    if (sessoes && typeof sessoes.reconciliarZombies === "function") {
      await sessoes.reconciliarZombies(ws.path).catch(() => []);
    }
    const filtro = {
      agente: url.searchParams.get("agente")?.trim() || undefined,
      gatilho_tipo: url.searchParams.get("gatilho")?.trim() || undefined,
      gatilho_origem: url.searchParams.get("origem")?.trim() || undefined,
      status: url.searchParams.get("status")?.trim() || undefined,
      limite: Math.min(Number(url.searchParams.get("limite")) || 100, 500),
    };
    enviar(res, 200, registros.corpDb(ws.path).listarExecucoes(filtro));
    return true;
  }

  // ── GET /telemetria/resumo ─────────────────────────────────────
  if (rota === "/telemetria/resumo" && req.method === "GET") {
    const ws = await resolverWs(url);
    const filtro = {
      sessao_id: url.searchParams.get("sessao_id")?.trim() || undefined,
      trace_id: url.searchParams.get("trace_id")?.trim() || undefined,
      agente: url.searchParams.get("agente")?.trim() || undefined,
      ferramenta: url.searchParams.get("ferramenta")?.trim() || undefined,
      status: url.searchParams.get("status")?.trim() || undefined,
      desde: url.searchParams.get("desde")?.trim() || undefined,
      ate: url.searchParams.get("ate")?.trim() || undefined,
    };
    enviar(res, 200, registros.corpDb(ws.path).resumoTelemetria(filtro));
    return true;
  }

  // ── GET /telemetria/trace/:trace_id ────────────────────────────
  const mTrace = /^\/telemetria\/trace\/([^/]+)$/.exec(rota);
  if (mTrace && req.method === "GET") {
    const ws = await resolverWs(url);
    const traceId = decodeURIComponent(mTrace[1]!);
    enviar(res, 200, registros.corpDb(ws.path).listarAcoesPorTrace(traceId));
    return true;
  }

  // ── GET /acoes ─────────────────────────────────────────────────
  if (rota === "/acoes" && req.method === "GET") {
    const ws = await resolverWs(url);
    const filtro = {
      sessao_id: url.searchParams.get("sessao_id")?.trim() || undefined,
      trace_id: url.searchParams.get("trace_id")?.trim() || undefined,
      agente: url.searchParams.get("agente")?.trim() || undefined,
      ferramenta: url.searchParams.get("ferramenta")?.trim() || undefined,
      status: url.searchParams.get("status")?.trim() || undefined,
      desde: url.searchParams.get("desde")?.trim() || undefined,
      ate: url.searchParams.get("ate")?.trim() || undefined,
      limite: Math.min(Number(url.searchParams.get("limite")) || 200, 1000),
    };
    enviar(res, 200, registros.corpDb(ws.path).listarAcoes(filtro));
    return true;
  }

  // ── GET /acoes/:sessao_id ou /sessions/:id/acoes ou /sessoes/:id/acoes ──
  const mAcoesSessao = /^\/(?:acoes|sessions|sessoes)\/([^/]+)(?:\/acoes)?$/.exec(rota);
  if (mAcoesSessao && (rota.startsWith("/acoes/") || rota.endsWith("/acoes")) && req.method === "GET") {
    const ws = await resolverWs(url);
    const sessaoId = decodeURIComponent(mAcoesSessao[1]!);
    const limite = Math.min(Number(url.searchParams.get("limite")) || 500, 1000);
    enviar(res, 200, registros.corpDb(ws.path).listarAcoesSessao(sessaoId, limite));
    return true;
  }

  // ── GET /sessions/:id/mensagens ou /sessoes/:id/mensagens ──────
  const mSessaoMensagens = /^\/(?:sessions|sessoes)\/([^/]+)\/mensagens$/.exec(rota);
  if (mSessaoMensagens && req.method === "GET") {
    const ws = await resolverWs(url);
    const sessaoId = decodeURIComponent(mSessaoMensagens[1]!);
    enviar(res, 200, registros.corpDb(ws.path).listarMensagens(sessaoId));
    return true;
  }

  // ── GET /sessoes/:id ou /sessions/:id ou /execucoes/:id ───────
  const mSessaoDetalheOuExec = /^\/(?:sessions|sessoes|execucoes)\/([^/]+)$/.exec(rota);
  if (mSessaoDetalheOuExec && req.method === "GET") {
    const ws = await resolverWs(url);
    const id = decodeURIComponent(mSessaoDetalheOuExec[1]!);
    const db = registros.corpDb(ws.path);
    const exec = db.obterExecucao(id);
    if (exec) {
      enviar(res, 200, exec);
      return true;
    }
    const sessao = db.obterSessao(id);
    if (sessao) {
      enviar(res, 200, sessao);
      return true;
    }
    try {
      const reg = await registros.obter(ws.path, "execucoes", id);
      enviar(res, 200, reg);
      return true;
    } catch {
      enviar(res, 404, { erro: `Execução ou sessão "${id}" não encontrada` });
      return true;
    }
  }

  // ── /secretario/sessoes (proxy GET /session) ────────────────────
  if (rota === "/secretario/sessoes" && req.method === "GET") {
    try {
      const porta = await getPortaOpencode(true);
      const opencodeUrl = `http://127.0.0.1:${porta}/session`;
      const [resOpencode, resStatus] = await Promise.all([
        fetchOpencode(opencodeUrl, { signal: AbortSignal.timeout(5000) }),
        fetchOpencode(`http://127.0.0.1:${porta}/session/status`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      ]);
      if (!resOpencode.ok) {
        enviar(res, 502, { erro: `opencode respondeu ${resOpencode.status}` });
        return true;
      }
      const data = await resOpencode.json();
      let statusMap: Record<string, { type?: string }> = {};
      if (resStatus && resStatus.ok) {
        try {
          statusMap = (await resStatus.json()) as Record<string, { type?: string }>;
        } catch { }
      }
      try {
        const itens = (data as Array<Record<string, unknown>>) ?? [];
        for (const s of itens) {
          const sid = String(s.id ?? "");
          const isBusy = statusMap[sid]?.type === "busy";
          s.executando = isBusy;
          s.status = isBusy ? "executando" : "idle";
        }
        const ids = itens.map((s) => String(s.id ?? "")).filter(Boolean);
        if (ids.length) {
          let ws: { id: string; path: string };
          try {
            ws = await resolverWs(url);
          } catch {
            const todos = await workspaces.listar();
            const primeiro = todos.find((w) => w.existe);
            if (!primeiro) throw new Error("nenhum workspace para enriquecer");
            ws = { id: primeiro.id, path: primeiro.path };
          }
          const db = registros.corpDb(ws.path);
          const primeiras = db.primeirasMensagensUsuario(ids);
          const sessoesDesteWs = new Set(primeiras.map((p) => p.sessao_id));
          const sessoesRegistradasNoDb = new Set(db.listarSessoes().map((s) => s.id));

          // Mapeia sessões que pertencem a outros workspaces para isolamento estrito
          const sessoesOutrosWs = new Set<string>();
          try {
            const todosWs = await workspaces.listar();
            for (const outro of todosWs) {
              if (outro.id !== ws.id && outro.existe) {
                const dbOutro = registros.corpDb(outro.path);
                const primOutro = dbOutro.primeirasMensagensUsuario(ids);
                for (const p of primOutro) sessoesOutrosWs.add(p.sessao_id);
              }
            }
          } catch { }

          const primeiraPorSessao = new Map<string, string>();
          for (const p of primeiras) {
            if (!primeiraPorSessao.has(p.sessao_id)) primeiraPorSessao.set(p.sessao_id, p.conteudo);
          }

          // Filtra sessões: inclui apenas as que pertencem a este workspace ou são novas/sem histórico em outro
          const itensFiltrados = itens.filter((s) => {
            const id = String(s.id ?? "");
            if (sessoesDesteWs.has(id) || sessoesRegistradasNoDb.has(id)) return true;
            if (sessoesOutrosWs.has(id)) return false;
            return true;
          });

          for (const s of itensFiltrados) {
            const id = String(s.id ?? "");
            const tituloAtual = String(s.title ?? "").trim();
            const real = primeiraPorSessao.get(id);
            if (real) {
              const limpo = limparPrefixoWorkspace(real);
              (s as Record<string, unknown>).titulo_real = limpo.length > 70 ? limpo.slice(0, 69) + "…" : limpo;
              (s as Record<string, unknown>).sem_conteudo = false;
            } else if (!tituloAtual || tituloAtual.startsWith("New session")) {
              (s as Record<string, unknown>).sem_conteudo = true;
            }
          }

          enviar(res, 200, itensFiltrados);
          return true;
        }
      } catch (erro) {
        console.error("[enriquecimento] falhou:", erro instanceof Error ? erro.message : erro);
      }
      try {
        const lista = (data as Array<{ id?: string; updated?: number; time?: { updated?: number } }>) ?? [];
        const recentes = [...lista]
          .sort((a, b) => (b.updated ?? b.time?.updated ?? 0) - (a.updated ?? a.time?.updated ?? 0))
          .slice(0, 5)
          .map((s) => s.id)
          .filter((id): id is string => !!id);
        for (const id of recentes) void syncSessaoNoCorp(porta, id);
      } catch { }
      enviar(res, 200, data);
    } catch {
      try {
        let ws: { id: string; path: string };
        try {
          ws = await resolverWs(url);
        } catch {
          const todos = await workspaces.listar();
          const primeiro = todos.find((w) => w.existe);
          if (!primeiro) throw new Error("nenhum workspace");
          ws = { id: primeiro.id, path: primeiro.path };
        }
        const db = registros.corpDb(ws.path);
        const sessoesLocais = db.listarSessoesLocal(30);
        const resultado = sessoesLocais.map((s) => ({
          id: s.id,
          agent: s.agente,
          model: s.modelo,
          title: s.titulo_real || `Conversa ${s.id.slice(0, 8)}`,
          titulo_real: s.titulo_real,
          updated: s.inicio ? new Date(s.inicio).getTime() : Date.now(),
          time: { updated: s.inicio ? new Date(s.inicio).getTime() : Date.now() },
          status: s.status || "idle",
          executando: false,
          sem_conteudo: !s.titulo_real,
          _fallback: true,
        }));
        console.warn(`[secretario/sessoes] opencode offline, retornando ${resultado.length} sessões do espelho local`);
        enviar(res, 200, resultado);
      } catch (fallbackErro) {
        console.error("[secretario/sessoes] fallback também falhou:", fallbackErro instanceof Error ? fallbackErro.message : fallbackErro);
        enviar(res, 200, []);
      }
    }
    return true;
  }

  // ── /secretario/sessoes/:id/mensagens ──────────────────────────
  const mMensagens = /^\/secretario\/sessoes\/([^/]+)\/mensagens$/.exec(rota);
  if (mMensagens && req.method === "GET") {
    try {
      const sessionId = decodeURIComponent(mMensagens[1]!);
      // Conversas gravadas pelo servidor (qualquer motor) vêm do log de eventos, com o status real das aprovações.
      const wsLog = await resolverWs(url);
      const entradasLog = await new EventLog(homeDir ?? opencorpHome()).ler(wsLog.id, sessionId);
      if (entradasLog.length > 0) {
        const historico = reduzirHistorico(entradasLog, streamsSecretarioAtivos.has(sessionId));
        for (const m of historico) {
          m.aprovacoes = m.aprovacoes?.map((a) => ({ ...a, workspace: wsLog.id }));
        }
        // O front usa os cabeçalhos para reassinar um turno vivo (GET /secretario/sessoes/:id/eventos?desde=N).
        enviar(res, 200, historico, {
          "x-oc-log-entradas": String(entradasLog.length),
          "x-oc-em-execucao": streamsSecretarioAtivos.has(sessionId) ? "1" : "0",
        });
        return true;
      }
      // Conversa de antes do log: o próprio motor pode reconstruir o histórico (ex.: transcrição do SDK).
      try {
        const { runtime } = await obterRuntimeSecretario(ctx, wsLog, false);
        const anterior = await runtime.history?.({ id: sessionId, engineId: runtime.engineId, workspaceId: wsLog.id });
        if (anterior && anterior.length > 0) {
          enviar(res, 200, anterior);
          return true;
        }
      } catch { /* sem runtime: segue para o opencode */ }
      const porta = await getPortaOpencode();
      const opencodeUrl = `http://127.0.0.1:${porta}/session/${sessionId}/message`;
      const [resOpencode, resStatus] = await Promise.all([
        fetchOpencode(opencodeUrl, { signal: AbortSignal.timeout(5000) }),
        fetchOpencode(`http://127.0.0.1:${porta}/session/status`, { signal: AbortSignal.timeout(3000) }).catch(() => null),
      ]);
      if (!resOpencode.ok) {
        enviar(res, resOpencode.status === 404 ? 404 : 502, {
          erro: resOpencode.status === 404 ? "sessão não encontrada" : `opencode respondeu ${resOpencode.status}`,
        });
        return true;
      }
      let isSessaoBusy = false;
      let sessaoRetryInfo: { message?: string; action?: { message?: string; link?: string } } | null = null;
      if (resStatus && resStatus.ok) {
        try {
          const statusMap = (await resStatus.json()) as Record<string, { type?: string; message?: string; action?: { message?: string; link?: string } }>;
          isSessaoBusy = statusMap[sessionId]?.type === "busy";
          if (statusMap[sessionId]?.type === "retry") {
            sessaoRetryInfo = statusMap[sessionId] ?? null;
          }
        } catch { }
      }
      const rawMsgs = ((await resOpencode.json()) as MensagemOc[]) ?? [];
      const mensagens: Array<{
        id?: string;
        indice_global?: number;
        role: string;
        content: string;
        passos?: PassoChat[];
        pensamento?: string;
        criado_em?: string;
        concluida: boolean;
        acoes?: Array<{ ferramenta?: string; resumo?: string; sucesso?: boolean }>;
        imagens?: string[];
        pergunta?: string;
        opcoes?: string[];
      }> = [];

      for (const m of rawMsgs) {
        const role = m.info?.role;
        if (role === "user") {
          const parts = m.parts ?? [];
          const rawContent = parts.filter((p: ParteOc) => p.type === "text").map((p: ParteOc) => p.text ?? "").join("\n").trim();
          const content = limparPrefixoWorkspace(rawContent);
          // Mensagens automáticas de continuação geradas por rotação/fallback interno não poluem o histórico
          if (content.startsWith("Continue a execução anterior exatamente de onde parou")) {
            continue;
          }
          const imagens = parts.filter((p: any) => p.type === "file" && typeof p.url === "string" && p.url.startsWith("data:image/")).map((p: any) => p.url);

          // Deduplicação defensiva: se o último item já for do usuário com mesmo conteúdo, descarta
          const ult = mensagens[mensagens.length - 1];
          if (ult && ult.role === "user" && ult.content === content) {
            continue;
          }
          // Se o último for assistente vazio (sem texto, pensamento, passos ou ações)
          // e o anterior for usuário com mesmo conteúdo, remove o assistente vazio e descarta o duplicado
          if (
            ult &&
            ult.role === "assistant" &&
            !ult.content &&
            !ult.pensamento &&
            (!ult.passos || ult.passos.length === 0) &&
            (!ult.acoes || ult.acoes.length === 0)
          ) {
            const penult = mensagens[mensagens.length - 2];
            if (penult && penult.role === "user" && penult.content === content) {
              mensagens.pop();
              continue;
            }
          }

          mensagens.push({
            id: m.info?.id,
            role: "user",
            content,
            criado_em: m.info?.time?.created ? new Date(m.info.time.created).toISOString() : undefined,
            concluida: true,
            imagens: imagens.length > 0 ? imagens : undefined,
          });
        } else if (role === "assistant") {
          const passos = extrairPassosMensagens([m]);
          const tools = passos.filter((p) => p.tipo === "acao").map((p) => ({
            ferramenta: p.ferramenta,
            resumo: p.resumo,
            sucesso: p.sucesso !== false,
          }));
          const pensamentosPassos = passos.filter((p) => p.tipo === "pensamento").map((p) => p.texto ?? "").filter(Boolean);
          const pensamento = pensamentosPassos.join("\n\n---\n\n");
          const textosPassos = passos.filter((p) => p.tipo === "texto").map((p) => p.texto ?? "").filter(Boolean);
          const content = textosPassos.join("\n\n");

          const agora = Date.now();
          const criadoEmMs = m.info?.time?.created ?? 0;
          const temStreamAtivo = streamsSecretarioAtivos.has(sessionId);
          // Se a sessão está reportada como busy no motor, mas não possui nenhum stream SSE ativo
          // e a mensagem foi criada há mais de 45 segundos sem progresso, o motor está em estado zumbi.
          const sessaoZumbi = isSessaoBusy && !temStreamAtivo && criadoEmMs > 0 && (agora - criadoEmMs > 45_000);
          if (sessaoZumbi) {
            isSessaoBusy = false;
            void fetchOpencode(`http://127.0.0.1:${porta}/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }).catch(() => { });
          }

          const expirou = (!isSessaoBusy || sessaoZumbi) && !m.info?.time?.completed && criadoEmMs > 0 && (agora - criadoEmMs > 45_000);
          const temErro = Boolean((m.info as any)?.error) || sessaoZumbi;
          const erroDesc = temErro
            ? (((m.info as any)?.error as any)?.data?.message || ((m.info as any)?.error as any)?.message || ((m.info as any)?.error as any)?.name || (sessaoZumbi ? "tempo limite esgotado sem resposta do modelo" : "interrompido"))
            : "";
          const isCompleted = isSessaoBusy
            ? Boolean(m.info?.time?.completed && (m.info as any)?.finish !== "tool-calls")
            : Boolean(m.info?.time?.completed || expirou || temErro || !isSessaoBusy);
          const textoFinal = content || (expirou ? (sessaoZumbi ? "⚠️ **Execução interrompida**: o processamento excedeu o tempo limite sem retorno do modelo." : "(geração anterior interrompida ou expirada)") : (temErro && !content ? `⚠️ **Erro na resposta**: ${erroDesc}` : ""));

          const modNome = (m.info as any)?.providerID && (m.info as any)?.modelID
            ? `${(m.info as any).providerID}/${(m.info as any).modelID}`
            : ((m.info as any)?.modelID || (m.info as any)?.model || "");
          const erroItemRotacao = temErro ? {
            tipo: "erro",
            modelo: modNome || undefined,
            aviso: `⚠️ O modelo ${modNome || "utilizado"} falhou: ${erroDesc}`,
            erro: true,
          } : null;

          const ult = mensagens[mensagens.length - 1];
          if (ult && ult.role === "assistant") {
            if (passos.length > 0) {
              ult.passos = [...(ult.passos ?? []), ...passos];
            }
            if (pensamento) {
              ult.pensamento = ult.pensamento ? `${ult.pensamento}\n\n---\n\n${pensamento}` : pensamento;
            }
            if (textoFinal) {
              ult.content = ult.content ? `${ult.content}\n\n${textoFinal}` : textoFinal;
            }
            if (tools.length > 0) {
              ult.acoes = [...(ult.acoes ?? []), ...tools];
            }
            if (erroItemRotacao) {
              const rot = (ult as any).rotacoes ?? [];
              rot.push(erroItemRotacao);
              (ult as any).rotacoes = rot;
            }
            if (modNome) {
              (ult as any).modelo = modNome;
            }
            const passoComPergunta = passos.find((p) => (p as any).perguntas || p.pergunta);
            if (passoComPergunta) {
              if ((passoComPergunta as any).perguntas) (ult as any).perguntas = (passoComPergunta as any).perguntas;
              if (passoComPergunta.pergunta) ult.pergunta = passoComPergunta.pergunta;
              if (passoComPergunta.opcoes) ult.opcoes = passoComPergunta.opcoes;
            }
            ult.concluida = isCompleted;
          } else {
            const temAlgo = Boolean(textoFinal || passos.length > 0 || pensamento || tools.length > 0 || temErro);
            if (temAlgo || (!isCompleted && isSessaoBusy)) {
              const passoComPergunta = passos.find((p) => (p as any).perguntas || p.pergunta);
              mensagens.push({
                id: m.info?.id,
                role: "assistant",
                content: textoFinal,
                passos: passos.length > 0 ? passos : undefined,
                pensamento: pensamento || undefined,
                criado_em: m.info?.time?.created ? new Date(m.info.time.created).toISOString() : undefined,
                concluida: isCompleted,
                acoes: tools.length > 0 ? tools : undefined,
                pergunta: passoComPergunta?.pergunta,
                opcoes: passoComPergunta?.opcoes,
                perguntas: (passoComPergunta as any)?.perguntas,
                modelo: modNome || undefined,
                rotacoes: erroItemRotacao ? [erroItemRotacao] : undefined,
              } as any);
            }
          }
        }
      }

      if (sessaoRetryInfo) {
        const msgRetry = sessaoRetryInfo.message || sessaoRetryInfo.action?.message || "Limite de cota ou taxa do provedor atingido.";
        const linkAviso = sessaoRetryInfo.action?.link ? ` [Acessar painel do provedor](${sessaoRetryInfo.action.link})` : "";
        const avisoFormatado = `⚠️ **Limite de Cota no Provedor**: ${msgRetry}${linkAviso}`;

        const ultMsg = mensagens[mensagens.length - 1];
        if (!ultMsg || ultMsg.role === "user") {
          mensagens.push({
            role: "assistant",
            content: avisoFormatado,
            concluida: true,
            criado_em: new Date().toISOString(),
          });
        } else if (ultMsg.role === "assistant" && !ultMsg.content) {
          ultMsg.content = avisoFormatado;
          ultMsg.concluida = true;
        }
      }

      if (mensagens.length > 0 && mensagens[mensagens.length - 1].role === "assistant") {
        mensagens[mensagens.length - 1].concluida = isSessaoBusy ? false : true;
      }

      const mensagensValidas = mensagens.filter((msg, idx) => {
        if (msg.role === "assistant") {
          const temTxt = Boolean(msg.content && msg.content.trim().length > 0);
          const temAcoes = Boolean(msg.acoes && msg.acoes.length > 0);
          const temPensamento = Boolean(msg.pensamento && msg.pensamento.trim().length > 0);
          const temPassos = Boolean(msg.passos && msg.passos.length > 0);
          if (!msg.concluida && idx === mensagens.length - 1) return true;
          return temTxt || temAcoes || temPensamento || temPassos;
        }
        return true;
      });

      const mensagensComIndice = mensagensValidas.map((msg, i) => ({
        ...msg,
        indice_global: i,
      }));

      const turnosParam = url.searchParams.get("turnos");
      const antesDoIndiceParam = url.searchParams.get("antes_do_indice");

      if (turnosParam) {
        const qtdTurnos = Math.max(1, parseInt(turnosParam, 10) || 2);
        const antesDoIndice = antesDoIndiceParam !== null ? parseInt(antesDoIndiceParam, 10) : null;

        const turnos: Array<{ inicio: number; fim: number }> = [];
        let inicioAtual = 0;
        for (let i = 0; i < mensagensComIndice.length; i++) {
          if (mensagensComIndice[i].role === "user" && i > 0 && i > inicioAtual) {
            turnos.push({ inicio: inicioAtual, fim: i });
            inicioAtual = i;
          }
        }
        if (mensagensComIndice.length > 0) {
          turnos.push({ inicio: inicioAtual, fim: mensagensComIndice.length });
        }

        const turnosCandidatos = antesDoIndice !== null
          ? turnos.filter((t) => t.fim <= antesDoIndice)
          : turnos;

        if (turnosCandidatos.length === 0) {
          enviar(res, 200, {
            mensagens: [],
            paginacao: {
              total_mensagens: mensagensComIndice.length,
              total_turnos: turnos.length,
              primeiro_indice: 0,
              ultimo_indice: 0,
              tem_mais: false,
            },
          });
          return true;
        }

        const turnosSelecionados = turnosCandidatos.slice(-qtdTurnos);
        const idxInicio = turnosSelecionados[0].inicio;
        const idxFim = turnosSelecionados[turnosSelecionados.length - 1].fim;
        const fatia = mensagensComIndice.slice(idxInicio, idxFim);
        const temMais = idxInicio > 0;

        enviar(res, 200, {
          mensagens: fatia,
          paginacao: {
            total_mensagens: mensagensComIndice.length,
            total_turnos: turnos.length,
            primeiro_indice: idxInicio,
            ultimo_indice: idxFim,
            tem_mais: temMais,
          },
        });
        return true;
      }

      enviar(res, 200, mensagensComIndice);
    } catch (erro) {
      if (erro instanceof SecretarioError) {
        enviar(res, erro.status ?? 409, { erro: erro.message });
      } else {
        enviar(res, 502, { erro: `proxy falhou: ${erro instanceof Error ? erro.message : String(erro)}` });
      }
    }
    return true;
  }

  // ── /secretario/sessoes/:id ────────────────────────────────────
  const mSessaoDetalhe = /^\/secretario\/sessoes\/([^/]+)$/.exec(rota);
  if (mSessaoDetalhe && req.method === "GET") {
    try {
      const porta = await getPortaOpencode();
      const sessionId = decodeURIComponent(mSessaoDetalhe[1]!);
      const opencodeUrl = `http://127.0.0.1:${porta}/session/${sessionId}`;
      const resOpencode = await fetchOpencode(opencodeUrl, { signal: AbortSignal.timeout(5000) });
      if (!resOpencode.ok) {
        if (resOpencode.status === 404) {
          enviar(res, 404, { erro: "sessão não encontrada" });
        } else {
          enviar(res, 502, { erro: `opencode respondeu ${resOpencode.status}` });
        }
        return true;
      }
      const data = await resOpencode.json();
      enviar(res, 200, data);
    } catch (erro) {
      if (erro instanceof SecretarioError) {
        enviar(res, erro.status ?? 409, { erro: erro.message });
      } else {
        enviar(res, 502, { erro: `proxy falhou: ${erro instanceof Error ? erro.message : String(erro)}` });
      }
    }
    return true;
  }

  // ── POST /secretario/sessoes/:id/truncar ───────────────────────
  const mTruncar = /^\/secretario\/sessoes\/([^/]+)\/truncar$/.exec(rota);
  if (mTruncar && req.method === "POST") {
    try {
      const porta = await getPortaOpencode();
      const sessionId = decodeURIComponent(mTruncar[1]!);
      const corpo = (await lerCorpo(req)) as { manter_ate?: unknown; mensagem_id?: string };
      const mensagemIdAlvo = typeof corpo.mensagem_id === "string" ? corpo.mensagem_id.trim() : null;
      const manter = typeof corpo.manter_ate === "number" ? Math.floor(Number(corpo.manter_ate)) : -1;

      if (!mensagemIdAlvo && (!Number.isInteger(manter) || manter < 0)) {
        enviar(res, 400, { erro: "mensagem_id ou manter_ate (número inteiro >=0) obrigatório" });
        return true;
      }

      const dirHome = homeDir ?? opencorpHome();
      const dataHome = dirOpencodeData(dirHome);
      const dbPath = join(dataHome, "opencode", "opencode.db");

      let idsParaRemover: string[] = [];

      if (mensagemIdAlvo) {
        try {
          const mod = await import("better-sqlite3");
          const BetterSqlite3 = (mod as unknown as { default: unknown }).default ?? mod;
          // @ts-ignore
          const db = new (BetterSqlite3 as unknown as new (path: string) => any)(dbPath);
          const todas = db.prepare("SELECT id, time_created FROM message WHERE session_id = ? ORDER BY time_created ASC").all(sessionId) as Array<{ id: string; time_created: number }>;
          db.close();

          const idxAlvo = todas.findIndex((m) => m.id === mensagemIdAlvo);
          if (idxAlvo >= 0) {
            idsParaRemover = todas.slice(idxAlvo).map((m) => m.id);
          }
        } catch { }
      }

      if (idsParaRemover.length === 0 && Number.isInteger(manter) && manter >= 0) {
        const opencodeUrl = `http://127.0.0.1:${porta}/session/${sessionId}/message`;
        let resOp: Response;
        try {
          resOp = await fetchOpencode(opencodeUrl, { signal: AbortSignal.timeout(5000) });
        } catch {
          enviar(res, 502, { ok: false, erro: "Sessão não encontrada ou indisponível no upstream" });
          return true;
        }

        if (!resOp.ok) {
          enviar(res, resOp.status === 404 ? 404 : 502, {
            ok: false,
            erro: "Sessão não encontrada ou indisponível no upstream",
          });
          return true;
        }

        const raw = (await resOp.json()) as Array<{
          info?: { id?: string; role?: string; time?: { completed?: number } };
          parts?: Array<{ type: string; text?: string; url?: string }>;
        }>;
        const filtrados = (Array.isArray(raw) ? raw : [])
          .map((m) => {
            const pensamento = (m.parts ?? []).filter((p) => p.type === "reasoning" || p.type === "thinking").map((p) => p.text ?? "").join("\n").trim();
            return {
              id: m.info?.id,
              role: m.info?.role ?? "",
              content: (m.parts ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n").trim(),
              pensamento: pensamento || undefined,
              imagens: (m.parts ?? []).filter((p) => p.type === "file" && typeof p.url === "string" && p.url.startsWith("data:image/")).map((p) => p.url as string),
              concluida: m.info?.role === "assistant" ? !!m.info?.time?.completed : true,
            };
          })
          .filter((m) => (m.role === "user" || m.role === "assistant") && (m.content.length > 0 || (m as unknown as { pensamento?: string }).pensamento || (m.imagens && m.imagens.length > 0) || (m.role === "assistant" && m.concluida === false)));

        if (manter > filtrados.length) {
          enviar(res, 400, {
            ok: false,
            erro: `manter_ate fora do range: sessão possui ${filtrados.length} mensagens`,
          });
          return true;
        }

        if (manter < filtrados.length) {
          idsParaRemover = filtrados.slice(manter).map((m) => m.id).filter(Boolean) as string[];
        }
      }

      if (!idsParaRemover.length) {
        enviar(res, 200, { ok: true, removidos: 0 });
        return true;
      }

      let removidos = 0;
      let dbErro: Error | null = null;
      try {
        const mod = await import("better-sqlite3");
        const BetterSqlite3 = (mod as unknown as { default: unknown }).default ?? mod;
        // @ts-ignore — construtor dinâmico
        const db: { prepare: (sql: string) => { run: (id: string) => { changes: number } }; close: () => void; transaction: (fn: (ids: string[]) => void) => (ids: string[]) => void } = new (BetterSqlite3 as unknown as new (path: string) => unknown)(dbPath) as unknown as never;
        const delPart = db.prepare("DELETE FROM part WHERE message_id = ?");
        const delMsg = db.prepare("DELETE FROM message WHERE id = ?");
        const tx = db.transaction((ids: string[]) => {
          for (const id of ids) {
            delPart.run(id);
            const inf = delMsg.run(id);
            if (inf.changes) removidos++;
          }
        });
        tx(idsParaRemover);
        db.close();
      } catch (e) {
        dbErro = e as Error;
      }
      if (removidos === 0 && idsParaRemover.length > 0) {
        try {
          const truncRes = await fetchOpencode(`http://127.0.0.1:${porta}/session/${sessionId}/truncate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ manter_ate: manter }),
            signal: AbortSignal.timeout(3000),
          });
          if (truncRes.ok) {
            const j = (await truncRes.json().catch(() => ({}))) as { removidos?: number };
            removidos = typeof j.removidos === "number" ? j.removidos : idsParaRemover.length;
            dbErro = null;
          }
        } catch { }
      }
      if (dbErro && removidos === 0) {
        enviar(res, 500, { erro: `falha ao truncar no DB: ${dbErro.message}` });
        return true;
      }
      void syncSessaoNoCorp(porta, sessionId);
      eventBus.emit("secretario.mensagem", { sessao_id: sessionId, fase: "truncar" });
      enviar(res, 200, { ok: true, removidos });
    } catch (erro) {
      if (erro instanceof SecretarioError) enviar(res, erro.status ?? 409, { erro: erro.message });
      else enviar(res, 502, { erro: `proxy falhou: ${erro instanceof Error ? erro.message : String(erro)}` });
    }
    return true;
  }

  return false;
}
