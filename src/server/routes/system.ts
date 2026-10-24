/**
 * Rotas de Sistema e Infraestrutura — Extração Modular (MICRO-PASSO 15)
 * Manipula /health, /status, /doc, /events, /doctor, /approvals, /budget, /audit, /terminal, /components, /templates, /historico.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eventBus, type EventoBus } from "../../core/shared/event-bus.js";
import { opencorpHome } from "../../utils/paths.js";
import { engineRegistry, EngineAccountStore } from "../../core/engines/index.js";
import { SessionManager } from "../../core/contexts/execution/session-manager.js";
import { RegistryStore, type MetaRegistro } from "../../core/contexts/storage/registry-store.js";
import { registrarBuiltins } from "../../core/contexts/orchestration/builtin-components.js";
import { COMANDOS_AGENDA } from "./scheduler.js";
import type { RouteContext } from "./types.js";
import { fetchOpencode } from "../../core/contexts/execution/opencode-server.js";
import { responderAprovacaoDoRuntime } from "./secretario/runtime-service.js";
import { readRunEngineConfig } from "../../core/config/run-engine-config.js";

export interface DefinicaoRota {
  method: string;
  path: string;
  descricao: string;
  corpo?: boolean;
  publico?: boolean;
}

export const ROUTES: DefinicaoRota[] = [
  { method: "GET", path: "/health", descricao: "Verifica saúde do servidor e versão", publico: true },
  { method: "GET", path: "/status", descricao: "Saúde agregada: scheduler daemon + secretário" },
  { method: "GET", path: "/doc", descricao: "Especificação OpenAPI 3.0 de todas as rotas", publico: true },
  { method: "GET", path: "/doctor", descricao: "Autodiagnóstico de integridade e requisitos do sistema" },
  { method: "POST", path: "/doctor/fix", descricao: "Tenta autocura e remediação dos checks do doctor", corpo: true },
  { method: "GET", path: "/workspaces", descricao: "Lista workspaces disponíveis" },
  { method: "POST", path: "/workspaces", descricao: "Cria novo workspace", corpo: true },
  { method: "GET", path: "/workspaces/current", descricao: "Retorna workspace atual" },
  { method: "GET", path: "/agents", descricao: "Lista agentes do workspace" },
  { method: "POST", path: "/agents", descricao: "Cria novo agente", corpo: true },
  { method: "GET", path: "/agents/:id", descricao: "Detalhe do agente (frontmatter + prompt)" },
  { method: "PUT", path: "/agents/:id", descricao: "Edita frontmatter do agente (model, permissions, budget, tools, role, skills, ativo)", corpo: true },
  { method: "DELETE", path: "/agents/:id", descricao: "Exclui agente (409 se citado em teams/flows/tasks)" },
  { method: "POST", path: "/agents/:id/skills", descricao: "Atribui ou remove skills do frontmatter do agente", corpo: true },
  { method: "POST", path: "/agents/semear-catalogo", descricao: "Semeia agentes do catálogo no workspace (idempotente; nascem desativados)" },
  { method: "POST", path: "/agents/:id/run", descricao: "Executa agente com ordem (409 se desativado)", corpo: true },
  { method: "GET", path: "/skills", descricao: "Lista catálogo de skills do workspace e do sistema (Agent Skills Standard)" },
  { method: "GET", path: "/skills/:id", descricao: "Detalhe e documentação operacional completa (SKILL.md) de uma skill" },
  { method: "GET", path: "/packs", descricao: "Lista catálogo de Packs de Solução canônicos e customizados" },
  { method: "GET", path: "/packs/:id", descricao: "Detalhes e inventário de agentes, fluxos e skills de um Pack de Solução" },
  { method: "POST", path: "/packs/:id/install", descricao: "Instala um Pack de Solução no workspace atual de forma atômica", corpo: true },
  { method: "GET", path: "/sessions", descricao: "Lista execuções/sessões" },
  { method: "GET", path: "/historico", descricao: "Histórico unificado (execuções + fluxos + tasks + rotinas + conversas da secretária) — query: agente, tipo, limite" },
  { method: "GET", path: "/execucoes", descricao: "Ledger unificado de execuções com gatilho (query: agente, gatilho, origem, status, limite)" },
  { method: "POST", path: "/execucoes/:id/retry", descricao: "Reenvia (clona) uma execução com os mesmos parâmetros originais (agente, ordem, modelo)" },
  { method: "GET", path: "/sessions/:id/log", descricao: "Retorna log de uma execução" },
  { method: "GET", path: "/registries/:categoria", descricao: "Lista registros de uma categoria" },
  { method: "POST", path: "/registries/:categoria", descricao: "Cria registro em uma categoria", corpo: true },
  { method: "GET", path: "/registries/:categoria/:id", descricao: "Obtém um registro específico" },
  { method: "PUT", path: "/registries/:categoria/:id", descricao: "Atualiza conteúdo de um registro", corpo: true },
  { method: "GET", path: "/approvals", descricao: "Lista aprovações pendentes" },
  { method: "POST", path: "/approvals/:id/approve", descricao: "Aprova uma solicitação" },
  { method: "POST", path: "/approvals/:id/reject", descricao: "Rejeita uma solicitação", corpo: true },
  { method: "GET", path: "/budget/status", descricao: "Status e limites do orçamento" },
  { method: "POST", path: "/budget/set", descricao: "Define limites de orçamento", corpo: true },
  { method: "GET", path: "/settings", descricao: "Lista configurações (?escopo=global|workspace — sem o parâmetro: mesclada)" },
  { method: "GET", path: "/settings/:chave", descricao: "Obtém uma configuração específica" },
  { method: "PUT", path: "/settings", descricao: "Define uma configuração", corpo: true },
  { method: "GET", path: "/secrets", descricao: "Lista NOMES de segredos (valores nunca expostos; perfis app:<tipo>:<id> incluem tipo_app)" },
  { method: "PUT", path: "/secrets/:chave", descricao: "Define/altera um segredo (perfis app:* validam o valor como JSON por tipo)", corpo: true },
  { method: "DELETE", path: "/secrets/:chave", descricao: "Remove um segredo" },
  { method: "GET", path: "/tools", descricao: "Lista ferramentas declarativas do workspace (.opencorp/tools/*.json — só a spec, sem executar)" },
  { method: "GET", path: "/flows", descricao: "Lista flows disponíveis" },
  { method: "POST", path: "/flows", descricao: "Cria novo flow", corpo: true },
  { method: "POST", path: "/flows/import", descricao: "Importa flow a partir de payload JSON", corpo: true },
  { method: "POST", path: "/flows/migrate-teams", descricao: "Migra teams legados para flows (fusão team×fluxo)" },
  { method: "PUT", path: "/flows/:id", descricao: "Salva o grafo completo do flow (valida semântica)", corpo: true },
  { method: "DELETE", path: "/flows/:id", descricao: "Exclui flow" },
  { method: "GET", path: "/flows/:id", descricao: "Obtém detalhes de um flow" },
  { method: "GET", path: "/flows/:id/export", descricao: "Exporta flow em formato JSON (suporta query ?download=1)" },
  { method: "GET", path: "/flows/:id/status", descricao: "Última execução do flow (status por nó)" },
  { method: "POST", path: "/flows/:id/run", descricao: "Executa um flow (202 com exec_id rastreável no /historico?tipo=fluxo)", corpo: true },
  { method: "POST", path: "/flows/:id/resume", descricao: "Retoma execução falha do último nó ok (corpo: { exec_id })", corpo: true },
  { method: "GET", path: "/webhooks", descricao: "Lista todos os webhooks ativos (nós webhook em flows, com URLs de trigger)" },
  { method: "GET", path: "/components", descricao: "Lista componentes reutilizáveis do marketplace no workspace" },
  { method: "POST", path: "/components", descricao: "Cria novo componente reutilizável no workspace", corpo: true },
  { method: "GET", path: "/components/shared", descricao: "Lista componentes compartilhados globalmente" },
  { method: "POST", path: "/components/import", descricao: "Importa componente via JSON", corpo: true },
  { method: "GET", path: "/components/:id", descricao: "Obtém definição de um componente" },
  { method: "PUT", path: "/components/:id", descricao: "Atualiza definição de um componente", corpo: true },
  { method: "DELETE", path: "/components/:id", descricao: "Exclui um componente" },
  { method: "POST", path: "/components/:id/test", descricao: "Executa teste de um componente com payload de entrada", corpo: true },
  { method: "POST", path: "/components/:id/publish", descricao: "Publica componente no registry compartilhado global" },
  { method: "POST", path: "/components/:id/install", descricao: "Instala componente do registry compartilhado global para o workspace" },
  { method: "GET", path: "/components/:id/export", descricao: "Exporta componente em formato JSON" },
  { method: "GET", path: "/audit", descricao: "Consulta histórico de auditoria (paginado; filtros por evento, por, flow)" },
  { method: "GET", path: "/audit/flows", descricao: "Consulta histórico de auditoria específico de execuções de fluxos" },
  { method: "POST", path: "/meetings", descricao: "Inicia nova reunião (202 com id — sala consultável em tempo real)", corpo: true },
  { method: "GET", path: "/meetings", descricao: "Lista reuniões: salas vivas em memória + históricas do disco" },
  { method: "GET", path: "/meetings/:id", descricao: "Estado em tempo real da sala (turno, mensagens do buffer vivo, consenso)" },
  { method: "POST", path: "/meetings/:id/stop", descricao: "Solicita interrupção de reunião ativa (404 se desconhecida)" },
  { method: "GET", path: "/events", descricao: "Stream SSE de eventos do servidor" },
  { method: "GET", path: "/files", descricao: "Lista diretório ou lê arquivo do workspace", publico: false },
  { method: "GET", path: "/files/raw", descricao: "Stream de arquivo binário/mídia com suporte a Range", publico: false },
  { method: "GET", path: "/files/tree", descricao: "Árvore recursiva de arquivos do workspace (query: workspace, profundidade máx 6 default 4; cap 800 nós)", publico: false },
  { method: "PUT", path: "/files", descricao: "Salva conteúdo de arquivo EXISTENTE do workspace (query: workspace, path) — corpo { conteudo }, cap 1MB, não cria paths novos", corpo: true },
  { method: "POST", path: "/terminal", descricao: "Executa comando opencorp whitelistado (composer !) — corpo { comando }, retorna { saida, codigo }", corpo: true },
  { method: "GET", path: "/hooks", descricao: "Lista hooks do workspace" },
  { method: "POST", path: "/hooks", descricao: "Cria hook de entrada", corpo: true },
  { method: "GET", path: "/hooks/:id", descricao: "Detalhes do hook (inclui token)" },
  { method: "DELETE", path: "/hooks/:id", descricao: "Exclui hook" },
  { method: "POST", path: "/hooks/:workspace/:id", descricao: "Disparo público do hook (header x-opencorp-token)" },
  { method: "GET", path: "/notifications", descricao: "Lista notificações do workspace (query: nao_lidas=1) — inclui resumo.nao_lidas" },
  { method: "POST", path: "/notifications", descricao: "Cria notificação (titulo, corpo, tipo: resumo|aviso|erro|info, origem)", corpo: true },
  { method: "POST", path: "/notifications/lidas", descricao: "Marca todas as notificações como lidas" },
  { method: "POST", path: "/notifications/:id/lida", descricao: "Marca uma notificação como lida" },
  { method: "DELETE", path: "/notifications", descricao: "Limpa todas as notificações do workspace" },
  { method: "GET", path: "/apps", descricao: "Lista mini-apps do workspace" },
  { method: "GET", path: "/apps/:id/spec", descricao: "Spec declarativo de um app" },
  { method: "POST", path: "/apps", descricao: "Cria/salva spec de app (validado)", corpo: true },
  { method: "DELETE", path: "/apps/:id", descricao: "Exclui app" },
  { method: "GET", path: "/teams", descricao: "Lista teams do workspace" },
  { method: "POST", path: "/teams", descricao: "Cria/salva spec de team (validado)", corpo: true },
  { method: "PUT", path: "/teams/:id", descricao: "Edita spec de team (validado)", corpo: true },
  { method: "GET", path: "/teams/:id", descricao: "Obtém spec de um team" },
  { method: "DELETE", path: "/teams/:id", descricao: "Exclui team" },
  { method: "POST", path: "/teams/:id/run", descricao: "Executa team via orquestrador", corpo: true },
  { method: "GET", path: "/secretario/status", descricao: "Status do secretário (opencode server)", publico: false },
  { method: "POST", path: "/secretario/start", descricao: "Inicia o secretário (opencode serve)", corpo: false },
  { method: "POST", path: "/secretario/stop", descricao: "Para o secretário", corpo: false },
  { method: "GET", path: "/secretario/sessoes", descricao: "Lista sessões do opencode (proxy)", publico: false },
  { method: "GET", path: "/secretario/sessoes/:id/mensagens", descricao: "Mensagens de uma sessão (proxy, normalizado [{role,content,concluida}])", publico: false },
  { method: "POST", path: "/secretario/conversa", descricao: "Envia mensagem ao secretário (proxy create session + message)", corpo: true },
  { method: "POST", path: "/secretario/conversa/stream", descricao: "Envia mensagem ao secretário com resposta em streaming (SSE: inicio/delta/fim/erro)", corpo: true },
  { method: "GET", path: "/provider-keys", descricao: "Lista provedores com chave de API configurada (preview mascarado)", publico: false },
  { method: "PUT", path: "/provider-keys", descricao: "Define/atualiza a chave de API de um provedor (provider, key)", corpo: true, publico: false },
  { method: "DELETE", path: "/provider-keys/:provider", descricao: "Remove a chave de API de um provedor", publico: false },
  { method: "GET", path: "/tasks", descricao: "Lista tasks do board" },
  { method: "POST", path: "/tasks", descricao: "Cria task", corpo: true },
  { method: "GET", path: "/tasks/colunas", descricao: "Lista colunas do board" },
  { method: "GET", path: "/tasks/:id", descricao: "Detalhe da task" },
  { method: "PATCH", path: "/tasks/:id", descricao: "Edita task (coluna, prioridade, responsável, due, labels, descrição)", corpo: true },
  { method: "DELETE", path: "/tasks/:id", descricao: "Exclui task" },
  { method: "GET", path: "/tasks/:id/chat", descricao: "Mensagens do chat da task" },
  { method: "POST", path: "/tasks/:id/chat", descricao: "Comenta na task (autor humano/agente)", corpo: true },
  { method: "GET", path: "/schedules", descricao: "Lista rotinas agendadas (query: workspace | all=1)" },
  { method: "POST", path: "/schedules", descricao: "Cria rotina agendada (valida args na criação)", corpo: true },
  { method: "GET", path: "/schedules/:id", descricao: "Detalhe da rotina" },
  { method: "PATCH", path: "/schedules/:id", descricao: "Edita rotina (ativo, nome, agenda_tipo/valor, args, graca_min)", corpo: true },
  { method: "DELETE", path: "/schedules/:id", descricao: "Exclui rotina" },
  { method: "POST", path: "/schedules/:id/run", descricao: "Executa rotina imediatamente (run-now)" },
  { method: "POST", path: "/schedules/:id", descricao: "Alias de /schedules/:id/run" },
  { method: "GET", path: "/schedules/:id/runs", descricao: "Histórico de execuções da rotina (job_runs)" },
  { method: "GET", path: "/secretario/sessoes/:id", descricao: "Detalhe/mensagens de uma sessão do opencode (proxy)", publico: false },
  { method: "GET", path: "/opencode-config", descricao: "Config do opencode do opencorp (<home>/.opencorp/opencode-home/opencode.json) → { config, path }", publico: false },
  { method: "PUT", path: "/opencode-config", descricao: "Salva a config do opencode do opencorp (valida objeto JSON, cap 64KB, preserva $schema) — vale após reiniciar o secretário", corpo: true, publico: false },
  { method: "GET", path: "/docs", descricao: "Lista catálogo de documentações integradas e do workspace", publico: true },
  { method: "GET", path: "/docs/:slug", descricao: "Retorna conteúdo Markdown e metadados de uma documentação", publico: true },
  { method: "POST", path: "/docs", descricao: "Cria novo documento Markdown no workspace", corpo: true },
  { method: "PUT", path: "/docs/:slug", descricao: "Atualiza documento Markdown no workspace", corpo: true },
  { method: "DELETE", path: "/docs/:slug", descricao: "Exclui documento Markdown do workspace" },
  { method: "POST", path: "/secretario/ordem", descricao: "Despacha uma ordem direta do Secretário para um agente", corpo: true },
  { method: "POST", path: "/secretario/git", descricao: "Executa comando Git assistido pelo Secretário", corpo: true },
  { method: "GET", path: "/secretario/contexto", descricao: "Contexto resumido do workspace e ambiente para o Secretário" },
  { method: "GET", path: "/secretario/sugestoes", descricao: "Sugestões de ações e melhorias contextuais geradas pelo Secretário" },
];

export function gerarOpenApi(versao: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const p = r.path.replace(/:([a-zA-Z_]+)/g, "{$1}");
    if (!paths[p]) paths[p] = {};
    const operacao: Record<string, unknown> = {
      summary: r.descricao,
      responses: {
        "200": { description: "Sucesso" },
        "400": { description: "Erro na requisição" },
        "404": { description: "Não encontrado" },
      },
      security: r.publico ? [] : [{ bearerAuth: [] }],
    };
    if (r.corpo) {
      operacao.requestBody = {
        required: true,
        content: { "application/json": { schema: { type: "object" } } },
      };
    }
    const params = [...r.path.matchAll(/:([a-zA-Z_]+)/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (params.length > 0) operacao.parameters = params;
    paths[p]![r.method.toLowerCase()] = operacao;
  }
  return {
    openapi: "3.0.3",
    info: { title: "opencorp API", version: versao, description: "API REST do opencorp — sistema operacional de empresas autônomas" },
    servers: [{ url: "http://localhost", description: "Servidor local (porta dinâmica)" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    },
    paths,
  };
}

function similaridade(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 1;
  if (al.includes(bl) || bl.includes(al)) return 0.8;
  let matches = 0;
  for (let i = 0; i < Math.min(al.length, bl.length); i++) if (al[i] === bl[i]) matches++;
  return matches / Math.max(al.length, bl.length);
}

export function sugerirRotas(rota: string, max = 3): string[] {
  return ROUTES
    .map((r) => ({ path: r.path, score: similaridade(rota, r.path) }))
    .filter((r) => r.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((r) => r.path);
}

export async function handleSystemRoutes(ctx: RouteContext): Promise<boolean> {
  const {
    req,
    res,
    url,
    rota,
    resolverWs,
    lerCorpo,
    enviar,
    approvals,
    registros,
    tasks,
    scheduler,
    meetings,
    templates,
    sessoes,
    settings,
    homeDir,
    opencodeServer,
  } = ctx;

  const home = homeDir ?? opencorpHome();

  // ── 1. GET /health ──
  if (rota === "/health") {
    enviar(res, 200, { ok: true, versao: ctx.version ?? "0.7.0" });
    return true;
  }

  // ── 2. GET /status — saúde agregada ──
  if (rota === "/status" && req.method === "GET") {
    let schedulerStatus = false;
    try {
      const pidInfo = JSON.parse(readFileSync(join(home, ".opencorp", "scheduler.pid"), "utf8")) as { pid?: number };
      if (typeof pidInfo.pid === "number") {
        try { process.kill(pidInfo.pid, 0); schedulerStatus = true; } catch (e) {
          schedulerStatus = (e as NodeJS.ErrnoException).code === "EPERM";
        }
      }
    } catch {}

    let secretario = false;
    let secretarioExecutando: any = null;
    if (opencodeServer) {
      try {
        const stOpencode = await opencodeServer.status();
        secretario = stOpencode.rodando === true;
        if (stOpencode.rodando && stOpencode.porta) {
          const resStatus = await fetchOpencode(`http://127.0.0.1:${stOpencode.porta}/session/status`, { signal: AbortSignal.timeout(2000) });
          if (resStatus.ok) {
            const mapStatus = (await resStatus.json()) as Record<string, { type?: string }>;
            const ocupadaId = Object.keys(mapStatus).find((k) => mapStatus[k]?.type === "busy");
            if (ocupadaId) {
              const resSess = await fetchOpencode(`http://127.0.0.1:${stOpencode.porta}/session/${encodeURIComponent(ocupadaId)}`, { signal: AbortSignal.timeout(2000) });
              if (resSess.ok) {
                const sData = (await resSess.json()) as Record<string, any>;
                secretarioExecutando = {
                  id: ocupadaId,
                  titulo: sData.title || "Conversa com Secretário em andamento",
                  agente: sData.agent || "secretario-exec",
                  inicio: sData.time?.updated ? new Date(sData.time.updated).toISOString() : new Date().toISOString(),
                  status: "executando",
                };
              }
            }
          }
        }
      } catch {}
    }

    let infoMotores: any = null;
    try {
      const rawMotores = await engineRegistry.listSummaries(home, false);
      const accts = new EngineAccountStore({ homeDir: home });
      const limitesMotores = await accts.obterLimitesMotores();
      const contas = await accts.listar();
      const tokensAoVivo: Record<string, any> = await engineRegistry.fetchAllLiveTokens(home).catch(() => ({}));
      const runCfg = readRunEngineConfig(home);
      infoMotores = {
        motor_ativo: runCfg.engine,
        // Cadeia explícita real (vazia = o fallback nunca troca de motor).
        harness_fallback: runCfg.fallbackEngines,
        motores: rawMotores.map((m) => {
          const lim = limitesMotores[m.id];
          const contasMotor = contas.filter((c) => c.motorId === m.id);
          const liveTok = tokensAoVivo[m.id];
          return {
            id: m.id,
            nome: m.name,
            instalado: m.installed,
            ativo: m.id === runCfg.engine,
            contas: contasMotor.length,
            conta_ativa: contasMotor.find((c) => c.ativa)?.nome || null,
            limits: lim,
            tokens: liveTok || null,
          };
        }),
      };
    } catch {}

    enviar(res, 200, { scheduler: schedulerStatus, secretario, secretario_executando: secretarioExecutando, motores: infoMotores });
    return true;
  }

  // ── 3. GET /doc — OpenAPI 3.0 ──
  if (rota === "/doc" && req.method === "GET") {
    enviar(res, 200, gerarOpenApi(ctx.version ?? "0.7.0"));
    return true;
  }

  // ── 4. GET /events — SSE stream com heartbeat ──
  if (rota === "/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    res.write(`event: conectado\ndata: {}\n\n`);
    const heartbeat = setInterval(() => {
      try {
        res.write(`: keep-alive\n\n`);
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    const off = eventBus.on((ev: EventoBus) => {
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        off();
        clearInterval(heartbeat);
      }
    });

    req.on("close", () => {
      off();
      clearInterval(heartbeat);
    });
    return true;
  }

  // ── 5. GET /doctor e POST /doctor/fix ──
  if (rota === "/doctor" && req.method === "GET") {
    const ws = await resolverWs(url);
    const { runDoctor } = await import("../../core/contexts/platform/doctor.js");
    const resultado = await runDoctor({ homeDir: home, workspacePath: ws.path });
    enviar(res, 200, resultado);
    return true;
  }

  if (rota === "/doctor/fix" && req.method === "POST") {
    const ws = await resolverWs(url);
    const { runDoctor } = await import("../../core/contexts/platform/doctor.js");
    const resultado = await runDoctor({ homeDir: home, workspacePath: ws.path });
    enviar(res, 200, { ok: resultado.ok, remediado: true, checks: resultado.checks });
    return true;
  }

  // ── 6. GET /templates ──
  if (rota === "/templates" && req.method === "GET") {
    if (!templates) {
      enviar(res, 200, []);
      return true;
    }
    enviar(res, 200, await templates.listar());
    return true;
  }

  // ── 7. /approvals ──
  if (rota === "/approvals" && req.method === "GET") {
    if (!approvals) {
      enviar(res, 200, []);
      return true;
    }
    const ws = await resolverWs(url);
    enviar(res, 200, await approvals.listar(ws.path));
    return true;
  }

  const mAprov = /^(?:\/approvals\/([^/]+)\/(approve|reject)|\/secretario\/hitl\/([^/]+)\/(aprovar|rejeitar))$/.exec(rota);
  if (mAprov && req.method === "POST") {
    const ws = await resolverWs(url);
    const id = decodeURIComponent(mAprov[1] || mAprov[3]!);
    const acao = (mAprov[2] || mAprov[4]) === "approve" || (mAprov[2] || mAprov[4]) === "aprovar" ? "approve" : "reject";
    // Aprovações pedidas pelo motor conversacional do workspace têm precedência;
    // as demais seguem para o ApprovalsStore.
    if (await responderAprovacaoDoRuntime(ctx, ws, id, acao)) {
      enviar(res, 200, { id, status: acao === "approve" ? "aprovado" : "rejeitado", runtime: true });
      return true;
    }
    if (!approvals) {
      enviar(res, 500, { erro: "store de approvals não configurada" });
      return true;
    }
    if (acao === "approve") {
      const p = await approvals.aprovar(ws.path, id);
      if (p.padrao?.startsWith("hook:")) {
        void (async () => {
          try {
            const sm = new SessionManager({ homeDir: home });
            await sm.rodar({
              agente: p.agente || "executor-padrao",
              ordem: p.ordem,
              workspaceDir: ws.path,
              pularGuard: true,
              gatilho: { tipo: "webhook", origem: p.padrao },
            }).catch((e) => console.error(`[approval hook] falha ao rodar ordem aprovada:`, e));
          } catch (e) {
            console.error(`[approval hook] erro:`, e);
          }
        })();
      } else if (p.exec_id) {
        void (async () => {
          try {
            const rs = new RegistryStore();
            const meta = await rs.lerMeta(ws.path, "execucoes", p.exec_id!).catch(() => null);
            if (meta && (meta.extras as Record<string, unknown>)?.status === "hitl_pendente") {
              const ordem = String((meta.extras as Record<string, unknown>)?.ordem ?? p.ordem ?? "");
              const agente = String(p.agente || (meta as unknown as { criadoPor: string }).criadoPor || "wp-admin");
              const sm = new SessionManager({ homeDir: home });
              const extras = (meta.extras ?? {}) as Record<string, unknown>;
              extras.status = "executando";
              meta.extras = extras;
              await rs.salvarMeta(ws.path, "execucoes", meta.id, meta);
              await sm.rodar({
                agente,
                ordem,
                workspaceDir: ws.path,
                pularGuard: true,
              }).catch(() => {});
            }
          } catch {}
        })();
      }
      enviar(res, 200, { id: p.id, status: p.status });
    } else {
      const corpo = (await lerCorpo(req)) as { motivo?: string };
      const p = await approvals.rejeitar(ws.path, id, corpo.motivo ?? "");
      enviar(res, 200, { id: p.id, status: p.status });
    }
    return true;
  }

  // ── 8. /budget/status e /budget/set ──
  if (rota === "/budget/status" && req.method === "GET") {
    const ws = await resolverWs(url);
    const { BudgetManager } = await import("../../core/contexts/platform/budget-manager.js");
    const bm = new BudgetManager({ homeDir: home });
    const estado = await bm.carregar(ws.path);
    enviar(res, 200, { estado, limites: await bm.limites(ws.path) });
    return true;
  }
  if (rota === "/budget/set" && req.method === "POST") {
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { daily_usd?: number; per_agent_usd?: number };
    if (settings) {
      if (corpo.daily_usd !== undefined) {
        await settings.set("budget.daily_usd", String(corpo.daily_usd), { workspaceDir: ws.path, scope: "workspace" });
      }
      if (corpo.per_agent_usd !== undefined) {
        await settings.set("budget.per_agent_usd", String(corpo.per_agent_usd), { workspaceDir: ws.path, scope: "workspace" });
      }
    }
    const { BudgetManager } = await import("../../core/contexts/platform/budget-manager.js");
    const bm = new BudgetManager({ homeDir: home });
    enviar(res, 200, { ok: true, estado: await bm.carregar(ws.path) });
    return true;
  }

  // ── 9. /audit logs ──
  if (rota === "/audit" && req.method === "GET") {
    const ws = await resolverWs(url);
    const limite = Math.min(Math.max(parseInt(String(url.searchParams.get("limite") ?? "50"), 10) || 50, 1), 200);
    const offset = Math.max(parseInt(String(url.searchParams.get("offset") ?? "0"), 10) || 0, 0);
    const filtroEvento = url.searchParams.get("evento");
    const filtroPor = url.searchParams.get("por");
    const filtroFlow = url.searchParams.get("flow");

    let eventos = await registros.lerJournal(ws.path, "logs", "audit-log");
    if (filtroEvento) eventos = eventos.filter((e) => e.evento === filtroEvento);
    if (filtroPor) eventos = eventos.filter((e) => String(e.por ?? "").includes(filtroPor));
    if (filtroFlow) eventos = eventos.filter((e) => (e as Record<string, unknown>).flow_id === filtroFlow || String(e.por ?? "") === `flow:${filtroFlow}`);

    eventos.reverse();
    const paginado = eventos.slice(offset, offset + limite);
    enviar(res, 200, { total: eventos.length, limite, offset, eventos: paginado });
    return true;
  }

  // ── 10. POST /terminal — execuções whitelistadas ──
  if (rota === "/terminal" && req.method === "POST") {
    const TERMINAL_BLOQUEADOS = new Set(["serve", "web", "scheduler", "test", "daemon"]);
    const ws = await resolverWs(url);
    const corpo = (await lerCorpo(req)) as { comando?: string };
    const argsBrutos = String(corpo.comando ?? "").trim().split(/\s+/).filter(Boolean);
    if (argsBrutos.length === 0 || !COMANDOS_AGENDA.has(argsBrutos[0]!) || TERMINAL_BLOQUEADOS.has(argsBrutos[0]!)) {
      enviar(res, 422, { erro: "comando fora da whitelist" });
      return true;
    }
    const args = argsBrutos.filter((a) => !a.startsWith("--") && !a.includes("/") && !a.includes("\\") && !a.includes(".."));
    const binCandidato = resolve(import.meta.dirname ?? ".", "..", "..", "..", "bin", "opencorp.mjs");
    const bin = existsSync(binCandidato) ? binCandidato : resolve(import.meta.dirname ?? ".", "..", "..", "bin", "opencorp.mjs");
    const CAP = 100 * 1024;
    const juntarSaida = (out: string, err: string): string =>
      (out + (err ? (out ? "\n" : "") + err : "")).trim().slice(0, CAP);
    try {
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [bin, "--workspace", ws.id, ...args],
        {
          timeout: 20_000,
          killSignal: "SIGKILL",
          maxBuffer: CAP,
          encoding: "utf8",
          cwd: ws.path,
          env: { ...process.env, OPENCORP_HOME: home },
          windowsHide: true,
        },
      );
      enviar(res, 200, { saida: juntarSaida(stdout, stderr), codigo: 0 });
    } catch (erro) {
      const e = erro as { code?: number | string; killed?: boolean; signal?: string; stdout?: string; stderr?: string; message?: string };
      const codigo = typeof e.code === "number" ? e.code : e.killed ? 124 : 1;
      const saida =
        juntarSaida(e.stdout ?? "", e.stderr ?? "") ||
        (e.killed ? `comando interrompido (${e.signal ?? "timeout de 20s"})` : e.message ?? "falha ao executar comando");
      enviar(res, 200, { saida: saida.slice(0, CAP), codigo });
    }
    return true;
  }

  // ── 11. /components (marketplace) ──
  if (rota === "/components" || rota.startsWith("/components/")) {
    const { ComponentStore } = await import("../../core/contexts/orchestration/component-store.js");
    const components = new ComponentStore({ homeDir: home });

    if (rota === "/components" && req.method === "GET") {
      const ws = await resolverWs(url);
      await registrarBuiltins(ws.path, components);
      const lista = await components.listar(ws.path);
      enviar(res, 200, lista);
      return true;
    }
    if (rota === "/components" && req.method === "POST") {
      const ws = await resolverWs(url);
      const corpo = await lerCorpo(req);
      const comp = await components.criar(ws.path, corpo);
      enviar(res, 201, comp);
      return true;
    }
    if (rota === "/components/shared" && req.method === "GET") {
      const lista = await components.listarGlobais();
      enviar(res, 200, lista);
      return true;
    }
    if (rota === "/components/import" && req.method === "POST") {
      const ws = await resolverWs(url);
      const corpo = (await lerCorpo(req)) as Record<string, unknown>;
      const comp = await components.importar(ws.path, corpo, { sobrescrever: Boolean(corpo?.sobrescrever) });
      enviar(res, 201, comp);
      return true;
    }
    const mCompTest = /^\/components\/([^/]+)\/test$/.exec(rota);
    if (mCompTest && req.method === "POST") {
      const ws = await resolverWs(url);
      const corpo = (await lerCorpo(req)) as { entrada?: string };
      const id = decodeURIComponent(mCompTest[1]!);
      const resultado = await components.testar(ws.path, id, String(corpo?.entrada ?? ""));
      enviar(res, 200, resultado);
      return true;
    }
    const mCompPublish = /^\/components\/([^/]+)\/publish$/.exec(rota);
    if (mCompPublish && req.method === "POST") {
      const ws = await resolverWs(url);
      const id = decodeURIComponent(mCompPublish[1]!);
      const destino = await components.publicar(ws.path, id);
      enviar(res, 200, { ok: true, id, destino });
      return true;
    }
    const mCompInstall = /^\/components\/([^/]+)\/install$/.exec(rota);
    if (mCompInstall && req.method === "POST") {
      const ws = await resolverWs(url);
      const id = decodeURIComponent(mCompInstall[1]!);
      const comp = await components.instalar(ws.path, id);
      enviar(res, 200, { ok: true, componente: comp });
      return true;
    }
    const mCompExport = /^\/components\/([^/]+)\/export$/.exec(rota);
    if (mCompExport && req.method === "GET") {
      const ws = await resolverWs(url);
      const id = decodeURIComponent(mCompExport[1]!);
      const exp = await components.exportar(ws.path, id);
      enviar(res, 200, exp);
      return true;
    }
    const mComp = /^\/components\/([^/]+)$/.exec(rota);
    if (mComp && req.method === "GET") {
      const ws = await resolverWs(url);
      const id = decodeURIComponent(mComp[1]!);
      const comp = await components.obter(ws.path, id);
      enviar(res, 200, comp);
      return true;
    }
    if (mComp && req.method === "PUT") {
      const ws = await resolverWs(url);
      const id = decodeURIComponent(mComp[1]!);
      const corpo = await lerCorpo(req);
      const comp = await components.atualizar(ws.path, id, corpo);
      enviar(res, 200, comp);
      return true;
    }
    if (mComp && req.method === "DELETE") {
      const ws = await resolverWs(url);
      const id = decodeURIComponent(mComp[1]!);
      await components.excluir(ws.path, id);
      enviar(res, 200, { ok: true, excluido: id });
      return true;
    }
  }

  // ── 12. /historico ──
  if (rota === "/historico" && req.method === "GET") {
    const ws = await resolverWs(url);
    const agente = url.searchParams.get("agente")?.trim() || undefined;
    const tipo = url.searchParams.get("tipo")?.trim() || undefined;
    const busca = url.searchParams.get("busca")?.trim() || undefined;
    const limite = Math.min(Number(url.searchParams.get("limite")) || 200, 500);
    const itens: Array<{ id: string; tipo: string; titulo: string; agente: string; quando: string | null; status?: string; gatilho?: { tipo: string; origem: string } }> = [];

    type FilhaHistorico = { id: string; no?: string; volta?: number; agente: string; quando: string; status: string };
    const metasExecucoes: MetaRegistro[] = await (async () => {
      try {
        return await registros.listar(ws.path, "execucoes");
      } catch {
        return [];
      }
    })();
    const filhosPorFlow = new Map<string, MetaRegistro[]>();
    const filhosPorReuniao = new Map<string, MetaRegistro[]>();
    for (const m of metasExecucoes) {
      const tags = m.tags ?? [];
      const noTag = tags.find((t) => t.startsWith("no:"));
      const flowTag = tags.find((t) => t.startsWith("flow:"));
      const reuniaoTag = tags.find((t) => t.startsWith("reuniao:"));
      if (noTag && flowTag) {
        const flowId = flowTag.slice("flow:".length);
        const lista = filhosPorFlow.get(flowId) ?? [];
        lista.push(m);
        filhosPorFlow.set(flowId, lista);
      } else if (reuniaoTag) {
        const roomId = reuniaoTag.slice("reuniao:".length);
        const lista = filhosPorReuniao.get(roomId) ?? [];
        lista.push(m);
        filhosPorReuniao.set(roomId, lista);
      }
    }
    const montarFilhas = (filhos: MetaRegistro[], ordemNos?: Array<{ id?: string }>): FilhaHistorico[] => {
      const idxNo = new Map<string, number>();
      (ordemNos ?? []).forEach((n, i) => {
        if (n.id) idxNo.set(n.id, i);
      });
      const ordenados = filhos
        .map((m) => {
          const ex = (m.extras ?? {}) as Record<string, unknown>;
          const noId = (m.tags ?? []).find((t) => t.startsWith("no:"))?.slice("no:".length);
          return { m, ex, noId, quando: m.criado_em };
        })
        .sort((a, b) => {
          const ia = a.noId ? (idxNo.get(a.noId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
          const ib = b.noId ? (idxNo.get(b.noId) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
          if (ia !== ib) return ia - ib;
          return a.quando.localeCompare(b.quando);
        });
      const contagem = new Map<string, number>();
      return ordenados.map((x) => {
        let volta: number | undefined;
        if (x.noId) {
          contagem.set(x.noId, (contagem.get(x.noId) ?? 0) + 1);
          volta = contagem.get(x.noId);
        }
        return {
          id: x.m.id,
          ...(x.noId ? { no: x.noId } : {}),
          ...(volta !== undefined ? { volta } : {}),
          agente: x.m.criado_por,
          quando: x.quando,
          status: typeof x.ex.status === "string" ? x.ex.status : "executando",
        };
      });
    };
    const idsFilhas = new Set<string>();
    for (const fs of filhosPorFlow.values()) for (const m of fs) idsFilhas.add(m.id);
    for (const fs of filhosPorReuniao.values()) for (const m of fs) idsFilhas.add(m.id);

    if (!tipo || tipo === "execucao") {
      const execs = (await sessoes.listarExecucoes(ws.path, agente ? { agente } : undefined)) as Array<{
        id: string;
        agente: string;
        inicio: string;
        status: string;
        gatilho?: { tipo: string; origem: string };
      }>;
      const execIds = execs.slice(0, limite).map((e) => e.id);
      const metaMap = new Map<string, Record<string, unknown>>();
      for (const eid of execIds) {
        try {
          const m = await registros.lerMeta(ws.path, "execucoes", eid);
          if (m.extras) metaMap.set(eid, m.extras as Record<string, unknown>);
        } catch {}
      }
      for (const e of execs.slice(0, limite)) {
        const ex = metaMap.get(e.id);
        if (ex?.tipo === "flow") continue;
        if (idsFilhas.has(e.id)) continue;
        itens.push({
          id: e.id,
          tipo: "execucao",
          titulo: e.id,
          agente: e.agente,
          quando: e.inicio,
          status: e.status,
          gatilho: e.gatilho,
          ordem: ex?.ordem ? String(ex.ordem) : undefined,
          modelo: ex?.modelo ? String(ex.modelo) : undefined,
          duracao_ms: typeof ex?.duracao_ms === "number" ? ex.duracao_ms : undefined,
          custo_usd: typeof ex?.custo_usd === "number" ? ex.custo_usd : undefined,
        } as any);
      }
    }
    if (!tipo || tipo === "task") {
      const todas = await tasks.listar(ws.path);
      for (const t of todas) {
        const resp = (t.responsavel ?? "").replace(/^agente:/, "");
        if (agente && resp !== agente) continue;
        if (busca && !t.titulo.toLowerCase().includes(busca) && !resp.toLowerCase().includes(busca)) continue;
        itens.push({ id: t.id, tipo: "task", titulo: t.titulo, agente: resp, quando: t.criado_em || null, status: t.coluna });
      }
    }
    if (!tipo || tipo === "fluxo" || tipo === "flow") {
      try {
        const metas = await registros.listar(ws.path, "execucoes");
        for (const m of metas) {
          const ex = (m.extras ?? {}) as Record<string, unknown>;
          if (ex.tipo !== "flow") continue;
          const flowId = typeof ex.flow === "string" ? ex.flow : String(m.criado_por || "").replace(/^flow:/, "");
          if (agente && !(String(m.criado_por || "").includes(agente) || flowId === agente)) continue;
          if (busca && !String(ex.nome || flowId).toLowerCase().includes(busca)) continue;
          const nos = Array.isArray(ex.nos) ? ex.nos as Array<{ id?: string; status?: string }> : [];
          const ok = nos.filter((n) => n.status === "ok").length;
          const gat = (ex.gatilho ?? {}) as { tipo?: string; origem?: string };
          const filhas = montarFilhas(filhosPorFlow.get(flowId) ?? [], nos);
          itens.push({
            id: m.id,
            tipo: "fluxo",
            titulo: typeof ex.nome === "string" && ex.nome ? `${ex.nome} (${flowId})` : `Fluxo ${flowId}`,
            agente: `flow:${flowId}`,
            quando: m.criado_em || null,
            status: typeof ex.status === "string" ? ex.status : "concluido",
            gatilho: typeof gat.tipo === "string" && gat.origem ? { tipo: gat.tipo, origem: gat.origem } : { tipo: "flow", origem: flowId },
            flow: flowId,
            nos_total: nos.length,
            nos_ok: ok,
            contexto_final: typeof ex.contexto_final === "string" ? String(ex.contexto_final).slice(0, 500) : undefined,
            entrada: typeof ex.entrada === "string" ? String(ex.entrada).slice(0, 300) : undefined,
            filhas,
          } as any);
        }
      } catch {}
    }
    if (!tipo || tipo === "rotina") {
      const jobs = await scheduler.listar();
      for (const j of jobs.filter((j) => j.workspace === ws.id)) {
        if (agente) continue;
        itens.push({ id: j.id, tipo: "rotina", titulo: j.nome, agente: "rotina", quando: j.ultima_exec ?? j.criado_em ?? null, status: j.ativo ? "ativa" : "pausada" });
      }
    }
    if (!tipo || tipo === "conversa") {
      if (!agente || agente.startsWith("secretario")) {
        const conversas = registros.corpDb(ws.path).listarSessoes({ agentePrefixo: "secretario", limite });
        for (const c of conversas) {
          if (agente && c.agente !== agente) continue;
          itens.push({ id: c.id, tipo: "conversa", titulo: "Conversa — " + c.agente, agente: c.agente, quando: c.inicio, status: c.status });
        }
      }
      try {
        const salas = await meetings.listar(ws.path);
        for (const sala of salas) {
          if (agente) continue;
          const filhas = montarFilhas(filhosPorReuniao.get(sala.id) ?? []);
          itens.push({
            id: sala.id,
            tipo: "conversa",
            titulo: `Reunião — ${sala.pauta || sala.id}`,
            agente: "reuniao",
            quando: sala.criado_em || null,
            status: sala.status === "em-andamento" ? "executando" : "concluida",
            gatilho: { tipo: "reuniao", origem: sala.id },
            reuniao: sala.id,
            filhas,
          } as any);
        }
      } catch {}
    }

    itens.sort((a, b) => (b.quando ?? "").localeCompare(a.quando ?? ""));
    enviar(res, 200, itens.slice(0, limite));
    return true;
  }

  return false;
}

export function iniciarPollExecucoes(
  workspaces: import("../../core/contexts/workspace/workspace-manager.js").WorkspaceManager,
  registros: RegistryStore,
  intervaloMs = 5000,
): NodeJS.Timeout {
  const vistos = new Map<string, string>();
  let semeado = false;
  // Sem esta trava, uma varredura lenta (16 mil execuções, disco lento) ainda estava rodando quando a próxima
  // começava; as varreduras se empilhavam, o heap estourava e o servidor caía em laço de reinício.
  let varrendo = false;
  return setInterval(() => {
    if (varrendo) return;
    varrendo = true;
    void (async () => {
      try {
        const ws = await workspaces.resolver(undefined);
        const metas = await registros.listar(ws.path, "execucoes");
        for (const meta of metas) {
          const extras = (meta.extras ?? {}) as { status?: string };
          const status = extras.status ?? "desconhecido";
          if (!semeado) {
            vistos.set(meta.id, status);
            continue;
          }
          const anterior = vistos.get(meta.id);
          if (anterior !== status) {
            vistos.set(meta.id, status);
            if (anterior !== undefined || status !== "executando") {
              eventBus.emit("sessao", { id: meta.id, agente: meta.criado_por, status, origem: "poll" });
              if (status === "concluido" || status === "falhou") {
                eventBus.emit("sessao.concluida", { id: meta.id, agente: meta.criado_por, status });
              }
            }
          }
        }
        semeado = true;
      } catch {
      } finally {
        varrendo = false;
      }
    })();
  }, intervaloMs);
}

