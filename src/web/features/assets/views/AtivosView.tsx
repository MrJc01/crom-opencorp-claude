import React, { useState, useEffect, useCallback, useMemo, type FC } from "react";
import { useParams } from "react-router-dom";
import {
  Search,
  Layers,
  Sparkles,
  Package,
  CheckCircle2,
  RefreshCw,
  Wrench,
  ShieldCheck,
  AlertCircle,
  Bot,
  Workflow,
  ExternalLink,
  BookOpen,
  ArrowRight,
  X,
  Plus,
  Check,
  Info,
  Sliders,
  Download,
  Terminal,
  Cpu,
  Eye,
} from "lucide-react";
import { useOpenCorp } from "../../../providers/OpenCorpProvider.js";
import { showToast } from "../../../shared/ui/Toast.js";
import { renderMarkdown } from "../../../md.js";
import type { AgentResumo } from "@opencorp/sdk";

export interface SkillItem {
  id: string;
  name: string;
  description: string;
  category?: string;
  allowed_tools?: string[];
  versao?: string;
  requires?: string[];
  corpo?: string;
}

export interface PackItemConteudo {
  id: string;
  nome?: string;
  role?: string;
  description?: string;
  skills?: string[];
  trigger?: string;
  template?: Record<string, any>;
}

export interface PackItem {
  id: string;
  nome: string;
  versao: string;
  descricao: string;
  categoria: string;
  autor: string;
  icone?: string;
  total_agentes: number;
  total_fluxos: number;
  total_skills: number;
  destaque?: boolean;
  requisitos?: {
    system?: string[];
    engines?: string[];
  };
  conteudo?: {
    agentes: PackItemConteudo[];
    fluxos: PackItemConteudo[];
    skills: PackItemConteudo[];
    assets?: string[];
  };
}

export interface AgentTemplateItem {
  id: string;
  role: string;
  category: string;
  model: string;
  skills: string[];
  tools: string[];
  permissions: string;
  descricao: string;
}

export interface FlowTemplateItem {
  id: string;
  nome: string;
  descricao: string;
  trigger: string;
  nos: number;
  tags: string[];
}

/** Deriva os modelos de agentes e fluxos a partir dos manifestos dos packs (sem catálogo fixo na UI). */
function derivarTemplates(packs: PackItem[]): { agentes: AgentTemplateItem[]; fluxos: FlowTemplateItem[] } {
  const agentes = new Map<string, AgentTemplateItem>();
  const fluxos = new Map<string, FlowTemplateItem>();
  for (const pack of packs) {
    for (const ag of pack.conteudo?.agentes ?? []) {
      const t = (ag.template ?? {}) as Partial<AgentTemplateItem>;
      if (agentes.has(ag.id)) continue;
      agentes.set(ag.id, {
        id: ag.id,
        role: t.role || ag.role || ag.id,
        category: t.category || "operario",
        model: t.model || "",
        skills: t.skills || ag.skills || [],
        tools: t.tools || [],
        permissions: t.permissions || "level-2",
        descricao: t.descricao || `Agente do pack ${pack.nome}.`,
      });
    }
    for (const fl of pack.conteudo?.fluxos ?? []) {
      const t = (fl.template ?? {}) as Partial<FlowTemplateItem>;
      if (fluxos.has(fl.id)) continue;
      fluxos.set(fl.id, {
        id: fl.id,
        nome: t.nome || fl.nome || fl.id,
        descricao: t.descricao || `Fluxo do pack ${pack.nome}.`,
        trigger: t.trigger || fl.trigger || "manual",
        nos: t.nos ?? 0,
        tags: t.tags || [pack.categoria],
      });
    }
  }
  return { agentes: Array.from(agentes.values()), fluxos: Array.from(fluxos.values()) };
}

export const AtivosView: FC = () => {
  const { client, workspaceId: ctxWorkspaceId, tratarErro } = useOpenCorp();
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params.workspaceId || ctxWorkspaceId || "";

  // Abas
  const [abaAtiva, setAbaAtiva] = useState<"packs" | "skills" | "agent-templates" | "flow-templates">("packs");

  // Estado geral
  const [busca, setBusca] = useState("");
  const [categoriaFiltro, setCategoriaFiltro] = useState<string>("todas");
  const [carregando, setCarregando] = useState(true);

  // Dados
  const [packs, setPacks] = useState<PackItem[]>([]);
  const templates = useMemo(() => derivarTemplates(packs), [packs]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [agentesWorkspace, setAgentesWorkspace] = useState<AgentResumo[]>([]);

  // Modais e Drawers
  const [packSelecionado, setPackSelecionado] = useState<PackItem | null>(null);
  const [instalandoPackId, setInstalandoPackId] = useState<string | null>(null);

  const [skillInspecionada, setSkillInspecionada] = useState<SkillItem | null>(null);
  const [carregandoDetalheSkill, setCarregandoDetalheSkill] = useState(false);
  const [atualizandoSkillAgente, setAtualizandoSkillAgente] = useState<string | null>(null);

  const [clonandoAgenteId, setClonandoAgenteId] = useState<string | null>(null);

  // Carregamento de dados
  const carregarTudo = useCallback(
    async (silencioso = false) => {
      if (!silencioso) setCarregando(true);
      try {
        const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
        const headers = {
          Accept: "application/json",
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        };

        const [resPacks, resSkills, listaAgentes] = await Promise.all([
          fetch(`/packs${qs}`, { headers }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
          fetch(`/skills${qs}`, { headers }).then((r) => (r.ok ? r.json() : [])).catch(() => []),
          client.agents.listar().catch(() => []),
        ]);

        const packsReais: PackItem[] = Array.isArray(resPacks) ? resPacks : [];
        const skillsReais: SkillItem[] = (Array.isArray(resSkills) ? resSkills : []).map((s: any) => ({
          id: s.id || s.name,
          name: s.name || s.id,
          description: s.description || "",
          category: s.category || "Geral",
          allowed_tools: Array.isArray(s.allowed_tools) ? s.allowed_tools : [],
          versao: s.versao,
          requires: Array.isArray(s.requires) ? s.requires : [],
          corpo: s.corpo,
        }));

        // Detalhe de cada pack alimenta as abas de modelos de agentes e fluxos.
        const packsDetalhados = await Promise.all(
          packsReais.map((p) =>
            fetch(`/packs/${encodeURIComponent(p.id)}${qs}`, { headers })
              .then((r) => (r.ok ? (r.json() as Promise<PackItem>) : p))
              .catch(() => p),
          ),
        );
        setPacks(packsDetalhados);
        setSkills(skillsReais);
        setAgentesWorkspace(listaAgentes || []);
      } catch (err) {
        if (!silencioso) {
          tratarErro(err, "Falha ao carregar Hub de Soluções e Ativos");
        }
      } finally {
        if (!silencioso) setCarregando(false);
      }
    },
    [client, workspaceId, tratarErro],
  );

  useEffect(() => {
    void carregarTudo();
  }, [carregarTudo]);

  // Carrega detalhe completo da skill para o Drawer
  const abrirInspecaoSkill = async (skill: SkillItem) => {
    setSkillInspecionada(skill);
    setCarregandoDetalheSkill(true);
    try {
      const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
      const res = await fetch(`/skills/${encodeURIComponent(skill.name || skill.id)}${qs}`, {
        headers: {
          Accept: "application/json",
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
      });
      if (res.ok) {
        const detalhe = await res.json();
        setSkillInspecionada((prev) => (prev ? { ...prev, ...detalhe } : detalhe));
      }
    } catch {
      // Usa dados locais se houver falha de rede
    } finally {
      setCarregandoDetalheSkill(false);
    }
  };

  // Atribuir ou remover skill do frontmatter do agente (Agent Skills Standard)
  const handleToggleSkillAgente = async (agenteId: string, skillName: string, jaPossui: boolean) => {
    const acao = jaPossui ? "remover" : "adicionar";
    setAtualizandoSkillAgente(agenteId);
    try {
      const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
      const res = await fetch(`/agents/${encodeURIComponent(agenteId)}/skills${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
        body: JSON.stringify({
          skill: skillName,
          acao,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.erro || `Erro HTTP ${res.status}`);
      }

      // Atualiza lista de agentes local
      setAgentesWorkspace((prev) =>
        prev.map((ag) => {
          if (ag.id !== agenteId) return ag;
          const atuais = ag.skills || [];
          const novas = jaPossui
            ? atuais.filter((s) => s !== skillName)
            : [...atuais, skillName];
          return { ...ag, skills: novas };
        }),
      );

      const msgSucesso = jaPossui
        ? `Skill "${skillName}" desvinculada do agente "${agenteId}".`
        : `Skill "${skillName}" ativada e injetada no agente "${agenteId}".`;
      showToast(msgSucesso, "sucesso");
    } catch (err) {
      tratarErro(err, `Falha ao ${acao} skill no agente`);
    } finally {
      setAtualizandoSkillAgente(null);
    }
  };

  // Instalação atômica de Pack de Solução
  const handleInstalarPack = async (packId: string) => {
    setInstalandoPackId(packId);
    try {
      const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
      const res = await fetch(`/packs/${encodeURIComponent(packId)}/install${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
        body: JSON.stringify({ workspace: workspaceId }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.erro || `Erro HTTP ${res.status}`);
      }

      const resultado = await res.json();
      showToast(`Pack "${packId}" instalado com sucesso!`, "sucesso");
      if (resultado?.avisos && resultado.avisos.length > 0) {
        resultado.avisos.forEach((av: string) => showToast(av, "aviso"));
      }

      // Recarrega lista de agentes e estado
      void carregarTudo(true);
      setPackSelecionado(null);
    } catch (err) {
      tratarErro(err, "Falha ao instalar Pack de Solução");
    } finally {
      setInstalandoPackId(null);
    }
  };

  // Clonar template de agente para o workspace
  const handleClonarAgente = async (tpl: AgentTemplateItem) => {
    setClonandoAgenteId(tpl.id);
    try {
      const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
      const res = await fetch(`/agents${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
        body: JSON.stringify({
          id: tpl.id,
          role: tpl.role,
          category: tpl.category,
          model: tpl.model,
          skills: tpl.skills,
          tools: tpl.tools,
          permissions: tpl.permissions,
          ativo: true,
          corpo_prompt: `# ${tpl.role}\n\n${tpl.descricao}\n\n## Diretrizes Operacionais\n1. Atuar de acordo com as permissões ${tpl.permissions}.\n2. Utilizar as ferramentas declaradas com máxima precisão.\n3. Seguir os padrões arquiteturais do OpenCorp.`,
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.erro || `Erro HTTP ${res.status}`);
      }

      showToast(`Agente "${tpl.id}" criado no workspace com sucesso!`, "sucesso");
      void carregarTudo(true);
    } catch (err) {
      tratarErro(err, "Falha ao criar agente a partir do template");
    } finally {
      setClonandoAgenteId(null);
    }
  };

  // Importar template de fluxo para o workspace
  const handleImportarFluxo = async (fl: FlowTemplateItem) => {
    try {
      const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : "";
      const res = await fetch(`/flows${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(workspaceId ? { "x-opencorp-workspace": workspaceId } : {}),
        },
        body: JSON.stringify({
          id: fl.id,
          name: fl.nome,
          descricao: fl.descricao,
          ativo: true,
          nos: [
            { id: "gatilho", tipo: fl.trigger.includes("cron") ? "cron" : "manual", config: {} },
            { id: "execucao", tipo: "script", config: { comando: "echo 'iniciando esteira do fluxo'" } },
          ],
          arestas: [{ de: "gatilho", para: "execucao" }],
        }),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.erro || `Erro HTTP ${res.status}`);
      }

      showToast(`Fluxo "${fl.nome}" importado no workspace com sucesso!`, "sucesso");
    } catch (err) {
      tratarErro(err, "Falha ao importar fluxo para o workspace");
    }
  };

  // Filtro de Skills
  const categoriasSkills = useMemo(() => {
    const lista = Array.from(new Set(skills.map((s) => s.category || "Geral")));
    return ["todas", ...lista.sort()];
  }, [skills]);

  const skillsFiltradas = useMemo(() => {
    return skills.filter((s) => {
      const matchBusca =
        s.name.toLowerCase().includes(busca.toLowerCase()) ||
        s.description.toLowerCase().includes(busca.toLowerCase()) ||
        s.id.toLowerCase().includes(busca.toLowerCase());
      const matchCat =
        categoriaFiltro === "todas" || (s.category || "Geral") === categoriaFiltro;
      return matchBusca && matchCat;
    });
  }, [skills, busca, categoriaFiltro]);

  // Filtro de Packs
  const packsFiltrados = useMemo(() => {
    return packs.filter(
      (p) =>
        p.nome.toLowerCase().includes(busca.toLowerCase()) ||
        p.descricao.toLowerCase().includes(busca.toLowerCase()) ||
        p.categoria.toLowerCase().includes(busca.toLowerCase()),
    );
  }, [packs, busca]);

  // Filtro de Templates de Agentes
  const agentTemplatesFiltrados = useMemo(() => {
    return templates.agentes.filter(
      (t) =>
        t.role.toLowerCase().includes(busca.toLowerCase()) ||
        t.id.toLowerCase().includes(busca.toLowerCase()) ||
        t.descricao.toLowerCase().includes(busca.toLowerCase()),
    );
  }, [busca, templates]);

  // Filtro de Templates de Fluxos
  const flowTemplatesFiltrados = useMemo(() => {
    return templates.fluxos.filter(
      (f) =>
        f.nome.toLowerCase().includes(busca.toLowerCase()) ||
        f.descricao.toLowerCase().includes(busca.toLowerCase()) ||
        f.tags.some((t) => t.toLowerCase().includes(busca.toLowerCase())),
    );
  }, [busca, templates]);

  return (
    <div className="flex flex-col h-full w-full p-6 md:p-8 space-y-6 overflow-y-auto">
      {/* Header com Estatísticas */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-100 flex items-center gap-2.5">
            <Package className="text-emerald-400" size={22} />
            Hub de Soluções & Ativos Operacionais
          </h1>
          <p className="text-xs text-zinc-400 mt-1">
            Packs completos ponta a ponta, catálogo canônico de Agent Skills, personas especializadas e pipelines reutilizáveis.
          </p>
        </div>

        {/* Barra de Busca e Atualização */}
        <div className="flex items-center gap-2.5 w-full md:w-auto">
          <div className="relative w-full md:w-72">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
            <input
              type="text"
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar packs, skills, agentes..."
              className="w-full pl-9 pr-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-xl text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-emerald-500/60 transition-colors"
            />
          </div>

          <button
            type="button"
            onClick={() => void carregarTudo()}
            disabled={carregando}
            title="Recarregar catálogo"
            className="p-2 rounded-xl bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw size={14} className={carregando ? "animate-spin text-emerald-400" : ""} />
          </button>
        </div>
      </div>

      {/* Navegação por Abas do Hub */}
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/80 pb-3 overflow-x-auto overflow-y-hidden text-xs">
        <button
          type="button"
          onClick={() => setAbaAtiva("packs")}
          className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-all cursor-pointer ${
            abaAtiva === "packs"
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm shadow-emerald-950/20"
              : "bg-zinc-900/60 text-zinc-400 border border-zinc-800/80 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          <Package size={15} />
          <span>Packs de Solução</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-zinc-800/80 text-zinc-300">
            {packs.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setAbaAtiva("skills")}
          className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-all cursor-pointer ${
            abaAtiva === "skills"
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm shadow-emerald-950/20"
              : "bg-zinc-900/60 text-zinc-400 border border-zinc-800/80 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          <Layers size={15} />
          <span>Catálogo de Skills</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-zinc-800/80 text-zinc-300">
            {skills.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setAbaAtiva("agent-templates")}
          className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-all cursor-pointer ${
            abaAtiva === "agent-templates"
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm shadow-emerald-950/20"
              : "bg-zinc-900/60 text-zinc-400 border border-zinc-800/80 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          <Bot size={15} />
          <span>Templates de Agentes</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-zinc-800/80 text-zinc-300">
            {templates.agentes.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setAbaAtiva("flow-templates")}
          className={`shrink-0 whitespace-nowrap px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-all cursor-pointer ${
            abaAtiva === "flow-templates"
              ? "bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shadow-sm shadow-emerald-950/20"
              : "bg-zinc-900/60 text-zinc-400 border border-zinc-800/80 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`}
        >
          <Workflow size={15} />
          <span>Templates de Fluxos</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-zinc-800/80 text-zinc-300">
            {templates.fluxos.length}
          </span>
        </button>
      </div>

      {/* ── ABA 1: PACKS DE SOLUÇÃO ────────────────────────────────────── */}
      {abaAtiva === "packs" && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 flex items-start gap-3.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-950/80 border border-emerald-700/40 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
              <Sparkles size={18} />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-100">Packs de Soluções Autônomas</h3>
              <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">
                Soluções completas e empacotadas com agentes pré-configurados, fluxos orquestrados, skills canônicas e assets operacionais prontos para instalação com um clique no workspace.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {packsFiltrados.map((pack) => (
              <div
                key={pack.id}
                className="flex flex-col justify-between p-5 rounded-2xl bg-zinc-900/50 border border-zinc-800/80 hover:border-zinc-700/80 transition-all space-y-4"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center text-emerald-400 shrink-0">
                        <Package size={20} />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-sm font-bold text-zinc-100">{pack.nome}</h3>
                          {pack.destaque && (
                            <span className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                              Oficial
                            </span>
                          )}
                        </div>
                        <span className="text-[11px] text-zinc-400 font-mono">
                          {pack.categoria} • v{pack.versao}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setPackSelecionado(pack)}
                      className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors cursor-pointer"
                      title="Ver inventário detalhado"
                    >
                      <Eye size={16} />
                    </button>
                  </div>

                  <p className="text-xs text-zinc-300 mt-3 line-clamp-2 leading-relaxed">
                    {pack.descricao}
                  </p>

                  {/* Pills de Inventário */}
                  <div className="flex flex-wrap items-center gap-2 mt-4 text-[11px]">
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 flex items-center gap-1.5 font-mono">
                      <Bot size={13} className="text-indigo-400" />
                      {pack.total_agentes} Agentes
                    </span>
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 flex items-center gap-1.5 font-mono">
                      <Workflow size={13} className="text-emerald-400" />
                      {pack.total_fluxos} Fluxos
                    </span>
                    <span className="px-2.5 py-1 rounded-lg bg-zinc-800/60 border border-zinc-700/50 text-zinc-300 flex items-center gap-1.5 font-mono">
                      <Layers size={13} className="text-amber-400" />
                      {pack.total_skills} Skills
                    </span>
                  </div>

                  {/* Requisitos do Sistema */}
                  {pack.requisitos?.system && pack.requisitos.system.length > 0 && (
                    <div className="mt-3 flex items-center gap-1.5 text-[10px] text-zinc-400 font-mono">
                      <Terminal size={11} className="text-zinc-500" />
                      <span>Requisitos: {pack.requisitos.system.join(", ")}</span>
                    </div>
                  )}
                </div>

                {/* Ações */}
                <div className="pt-3 border-t border-zinc-800/70 flex items-center justify-between gap-3">
                  <span className="text-[10px] text-zinc-500 font-mono">Por {pack.autor}</span>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setPackSelecionado(pack)}
                      className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium transition-colors cursor-pointer"
                    >
                      Inventário
                    </button>
                    <button
                      type="button"
                      disabled={instalandoPackId === pack.id}
                      onClick={() => void handleInstalarPack(pack.id)}
                      className="px-3.5 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {instalandoPackId === pack.id ? (
                        <>
                          <RefreshCw size={13} className="animate-spin" />
                          <span>Instalando...</span>
                        </>
                      ) : (
                        <>
                          <Download size={13} />
                          <span>Instalar Pack</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── ABA 2: CATÁLOGO DE SKILLS (AGENT SKILLS STANDARD) ─────────── */}
      {abaAtiva === "skills" && (
        <div className="space-y-5">
          {/* Banner Educativo de Progressive Disclosure */}
          <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 flex items-start gap-3.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-950/80 border border-emerald-700/40 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
              <Info size={18} />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-100">
                Padrão Canônico Agent Skills Standard (Divulgação Progressiva)
              </h3>
              <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">
                Skills operam em 3 camadas para proteger a janela de contexto de tokens da LLM:{" "}
                <span className="text-zinc-200 font-medium">L1 Descoberta</span> (sumário compacto injetado no preâmbulo de todos os agentes),{" "}
                <span className="text-zinc-200 font-medium">L2 Ativação</span> (corpo integral de <code className="text-emerald-400">SKILL.md</code> carregado apenas nos agentes que declaram a skill), e{" "}
                <span className="text-zinc-200 font-medium">L3 Execução</span> (scripts em <code className="text-emerald-400">scripts/</code> e referências sob demanda).
              </p>
            </div>
          </div>

          {/* Filtros de Categoria */}
          {categoriasSkills.length > 2 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
              {categoriasSkills.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoriaFiltro(cat)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer capitalize ${
                    categoriaFiltro === cat
                      ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40"
                      : "bg-zinc-900/60 text-zinc-400 border border-zinc-800/80 hover:bg-zinc-800/60 hover:text-zinc-200"
                  }`}
                >
                  {cat === "todas" ? "Todas as Categorias" : cat}
                </button>
              ))}
            </div>
          )}

          {/* Grid de Skills Reais */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {skillsFiltradas.map((skill) => {
              // Verifica quantos e quais agentes do workspace possuem esta skill
              const agentesVinculados = agentesWorkspace.filter((ag) =>
                (ag.skills || []).includes(skill.name || skill.id),
              );

              return (
                <div
                  key={skill.id}
                  className="flex flex-col justify-between p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 hover:border-zinc-700/80 transition-all space-y-3"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-emerald-400">
                        <Package size={15} />
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                        {skill.category || "Geral"}
                      </span>
                    </div>

                    <h3 className="text-xs font-bold text-zinc-100 font-mono">{skill.name}</h3>
                    <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                      {skill.description}
                    </p>

                    {skill.allowed_tools && skill.allowed_tools.length > 0 && (
                      <div className="mt-2.5 pt-2 border-t border-zinc-800/60 flex items-center gap-1.5 overflow-hidden">
                        <Wrench size={11} className="text-zinc-500 shrink-0" />
                        <span className="text-[10px] text-zinc-400 font-mono truncate">
                          {skill.allowed_tools.join(", ")}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Rodapé com Agentes Atribuídos e Botão de Inspeção */}
                  <div className="pt-2 border-t border-zinc-800/60 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1 text-[10px] text-zinc-400">
                      <Bot size={12} className={agentesVinculados.length > 0 ? "text-emerald-400" : "text-zinc-500"} />
                      <span>{agentesVinculados.length} agentes</span>
                    </div>

                    <button
                      type="button"
                      onClick={() => void abrirInspecaoSkill(skill)}
                      className="px-2.5 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                    >
                      <BookOpen size={12} />
                      <span>Inspecionar & Atribuir</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── ABA 3: TEMPLATES DE AGENTES (PERSONAS PRONTAS) ─────────────── */}
      {abaAtiva === "agent-templates" && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 flex items-start gap-3.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-950/80 border border-emerald-700/40 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
              <Bot size={18} />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-100">Personas e Papéis Especializados</h3>
              <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">
                Modelos de agentes pré-calibrados com permissões de segurança, modelos adequados por complexidade xB e skills canônicas prontas para atuar no workspace.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agentTemplatesFiltrados.map((tpl) => {
              const jaExisteNoWs = agentesWorkspace.some((a) => a.id === tpl.id);

              return (
                <div
                  key={tpl.id}
                  className="flex flex-col justify-between p-5 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 hover:border-zinc-700/80 transition-all space-y-3"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-indigo-400">
                        <Bot size={16} />
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400 border border-zinc-700/50">
                        {tpl.category}
                      </span>
                    </div>

                    <h3 className="text-xs font-bold text-zinc-100">{tpl.role}</h3>
                    <span className="text-[10px] text-zinc-500 font-mono">ID: {tpl.id}</span>
                    <p className="text-[11px] text-zinc-400 mt-2 line-clamp-2 leading-relaxed">
                      {tpl.descricao}
                    </p>

                    <div className="mt-3 space-y-1.5 text-[10px] font-mono text-zinc-400">
                      <div className="flex items-center gap-1.5">
                        <Cpu size={12} className="text-zinc-500" />
                        <span className="truncate">{tpl.model}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <ShieldCheck size={12} className="text-zinc-500" />
                        <span>Permissão: {tpl.permissions}</span>
                      </div>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-zinc-800/70 flex items-center justify-between gap-2">
                    {jaExisteNoWs ? (
                      <span className="text-[10px] text-emerald-400 flex items-center gap-1 font-medium">
                        <CheckCircle2 size={12} />
                        Presente no Workspace
                      </span>
                    ) : (
                      <span className="text-[10px] text-zinc-500">Pronto para clonar</span>
                    )}

                    <button
                      type="button"
                      disabled={clonandoAgenteId === tpl.id}
                      onClick={() => void handleClonarAgente(tpl)}
                      className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-emerald-600 hover:text-white text-zinc-200 text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {clonandoAgenteId === tpl.id ? (
                        <RefreshCw size={12} className="animate-spin" />
                      ) : (
                        <Plus size={12} />
                      )}
                      <span>{jaExisteNoWs ? "Re-sincronizar" : "Criar no Workspace"}</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── ABA 4: TEMPLATES DE FLUXOS (PIPELINES PRONTOS) ────────────── */}
      {abaAtiva === "flow-templates" && (
        <div className="space-y-4">
          <div className="p-4 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 flex items-start gap-3.5">
            <div className="h-9 w-9 rounded-xl bg-emerald-950/80 border border-emerald-700/40 flex items-center justify-center text-emerald-400 shrink-0 mt-0.5">
              <Workflow size={18} />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-zinc-100">Pipelines & Grafos Declarativos</h3>
              <p className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">
                Estruturas de automação no padrão n8n do OpenCorp com gatilhos periódicos (cron), nós de execução determinística e encadeamento de agentes.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {flowTemplatesFiltrados.map((fl) => (
              <div
                key={fl.id}
                className="flex flex-col justify-between p-5 rounded-2xl bg-zinc-900/40 border border-zinc-800/80 hover:border-zinc-700/80 transition-all space-y-3"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="h-8 w-8 rounded-lg bg-zinc-800 flex items-center justify-center text-emerald-400">
                      <Workflow size={16} />
                    </span>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                      {fl.trigger}
                    </span>
                  </div>

                  <h3 className="text-xs font-bold text-zinc-100">{fl.nome}</h3>
                  <p className="text-[11px] text-zinc-400 mt-1 line-clamp-2 leading-relaxed">
                    {fl.descricao}
                  </p>

                  <div className="flex flex-wrap gap-1.5 mt-3">
                    {fl.tags.map((tg) => (
                      <span
                        key={tg}
                        className="text-[9px] font-mono px-2 py-0.5 rounded bg-zinc-800/80 text-zinc-400"
                      >
                        {tg}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="pt-3 border-t border-zinc-800/70 flex items-center justify-between gap-2">
                  <span className="text-[10px] text-zinc-500 font-mono">{fl.nos} nós no grafo</span>

                  <button
                    type="button"
                    onClick={() => void handleImportarFluxo(fl)}
                    className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-emerald-600 hover:text-white text-zinc-200 text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download size={12} />
                    <span>Importar Fluxo</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── MODAL DE DETALHES DO PACK ───────────────────────────────────── */}
      {packSelecionado && (
        <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            {/* Modal Header */}
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-950/80 border border-emerald-700/50 flex items-center justify-center text-emerald-400">
                  <Package size={20} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-bold text-zinc-100">{packSelecionado.nome}</h2>
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                      v{packSelecionado.versao}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 font-mono">{packSelecionado.categoria}</p>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setPackSelecionado(null)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Modal Body */}
            <div className="p-5 overflow-y-auto space-y-5 text-xs">
              <div>
                <h4 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider mb-1">
                  Descrição Geral
                </h4>
                <p className="text-zinc-300 leading-relaxed">{packSelecionado.descricao}</p>
              </div>

              {/* Inventário do Pack */}
              {packSelecionado.conteudo && (
                <div className="space-y-4">
                  {/* Agentes Inclusos */}
                  <div>
                    <h4 className="text-[11px] font-semibold text-indigo-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Bot size={13} />
                      Agentes Inclusos ({packSelecionado.conteudo.agentes?.length || 0})
                    </h4>
                    <div className="space-y-1.5">
                      {packSelecionado.conteudo.agentes?.map((ag) => (
                        <div
                          key={ag.id}
                          className="p-2.5 rounded-xl bg-zinc-800/40 border border-zinc-700/40 flex items-center justify-between"
                        >
                          <div>
                            <span className="font-semibold text-zinc-200">{ag.role || ag.id}</span>
                            <span className="text-[10px] text-zinc-500 font-mono ml-2">({ag.id})</span>
                          </div>
                          {ag.skills && ag.skills.length > 0 && (
                            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-emerald-400 border border-zinc-700/50">
                              skills: {ag.skills.join(", ")}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Fluxos Inclusos */}
                  <div>
                    <h4 className="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Workflow size={13} />
                      Fluxos & Pipelines ({packSelecionado.conteudo.fluxos?.length || 0})
                    </h4>
                    <div className="space-y-1.5">
                      {packSelecionado.conteudo.fluxos?.map((fl) => (
                        <div
                          key={fl.id}
                          className="p-2.5 rounded-xl bg-zinc-800/40 border border-zinc-700/40 flex items-center justify-between"
                        >
                          <span className="font-semibold text-zinc-200">{fl.nome || fl.id}</span>
                          <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
                            gatilho: {fl.trigger || "manual"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Skills Inclusas */}
                  <div>
                    <h4 className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                      <Layers size={13} />
                      Skills ({packSelecionado.conteudo.skills?.length || 0})
                    </h4>
                    <div className="space-y-1.5">
                      {packSelecionado.conteudo.skills?.map((sk) => (
                        <div
                          key={sk.id}
                          className="p-2.5 rounded-xl bg-zinc-800/40 border border-zinc-700/40 flex items-center justify-between"
                        >
                          <span className="font-mono text-zinc-200">{sk.id}</span>
                          <span className="text-[10px] text-zinc-400">{sk.description}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-4 border-t border-zinc-800 flex items-center justify-between">
              <span className="text-[11px] text-zinc-400 font-mono">Workspace: {workspaceId}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPackSelecionado(null)}
                  className="px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium cursor-pointer"
                >
                  Fechar
                </button>
                <button
                  type="button"
                  disabled={instalandoPackId === packSelecionado.id}
                  onClick={() => void handleInstalarPack(packSelecionado.id)}
                  className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {instalandoPackId === packSelecionado.id ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Instalando...</span>
                    </>
                  ) : (
                    <>
                      <Download size={13} />
                      <span>Instalar Pack no Workspace</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DRAWER LATERAL DE INSPEÇÃO DE SKILL & GOVERNANÇA ───────────── */}
      {skillInspecionada && (
        <div className="fixed inset-y-0 right-0 z-50 w-full max-w-xl bg-zinc-900 border-l border-zinc-800 shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
          {/* Header do Drawer */}
          <div className="p-5 border-b border-zinc-800 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-xl bg-emerald-950/80 border border-emerald-700/50 flex items-center justify-center text-emerald-400">
                <Layers size={20} />
              </div>
              <div>
                <h2 className="text-sm font-bold text-zinc-100 font-mono">{skillInspecionada.name}</h2>
                <span className="text-[10px] text-zinc-400 font-mono">
                  Categoria: {skillInspecionada.category || "Geral"}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setSkillInspecionada(null)}
              className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>
          </div>

          {/* Conteúdo do Drawer */}
          <div className="p-5 overflow-y-auto space-y-6 flex-1 text-xs">
            {/* Metadados e Ferramentas */}
            <div className="p-3.5 rounded-xl bg-zinc-800/40 border border-zinc-700/40 space-y-2">
              <div className="text-zinc-300 leading-relaxed font-sans">
                {skillInspecionada.description}
              </div>
              {skillInspecionada.allowed_tools && skillInspecionada.allowed_tools.length > 0 && (
                <div className="pt-2 border-t border-zinc-700/40 flex items-center gap-1.5 text-[10px] text-zinc-400 font-mono">
                  <Wrench size={11} className="text-zinc-500" />
                  <span className="font-semibold text-zinc-300">Allowed Tools:</span>
                  <span>{skillInspecionada.allowed_tools.join(", ")}</span>
                </div>
              )}
            </div>

            {/* Seção de Atribuição aos Agentes do Workspace */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                  <Bot size={14} className="text-indigo-400" />
                  Atribuição nos Agentes do Workspace
                </h3>
                <span className="text-[10px] text-zinc-500 font-mono">
                  Injeção L2 em agent.md
                </span>
              </div>

              <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                {agentesWorkspace.map((ag) => {
                  const jaPossui = (ag.skills || []).includes(skillInspecionada.name);
                  const isAtualizando = atualizandoSkillAgente === ag.id;

                  return (
                    <div
                      key={ag.id}
                      className="p-3 rounded-xl bg-zinc-800/30 border border-zinc-700/50 flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-zinc-200">{ag.role || ag.id}</span>
                          <span className="text-[10px] text-zinc-500 font-mono">({ag.id})</span>
                        </div>
                        <span className="text-[10px] text-zinc-400 font-mono">{ag.model}</span>
                      </div>

                      <button
                        type="button"
                        disabled={isAtualizando}
                        onClick={() => void handleToggleSkillAgente(ag.id, skillInspecionada.name, jaPossui)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50 ${
                          jaPossui
                            ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-red-500/20 hover:text-red-400 hover:border-red-500/40"
                            : "bg-zinc-800 text-zinc-300 border border-zinc-700 hover:bg-zinc-700 hover:text-zinc-100"
                        }`}
                      >
                        {isAtualizando ? (
                          <RefreshCw size={12} className="animate-spin" />
                        ) : jaPossui ? (
                          <>
                            <Check size={12} />
                            <span>Ativa</span>
                          </>
                        ) : (
                          <>
                            <Plus size={12} />
                            <span>Atribuir</span>
                          </>
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Documentação Operacional SKILL.md */}
            <div className="space-y-2">
              <h3 className="text-xs font-bold text-zinc-200 flex items-center gap-1.5">
                <BookOpen size={14} className="text-emerald-400" />
                Documentação Operacional (SKILL.md)
              </h3>

              {carregandoDetalheSkill ? (
                <div className="p-8 text-center text-zinc-500">
                  <RefreshCw size={18} className="animate-spin mx-auto mb-2 text-emerald-400" />
                  <span>Carregando instruções de SKILL.md...</span>
                </div>
              ) : skillInspecionada.corpo ? (
                <div
                  className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-300 font-mono text-[11px] leading-relaxed overflow-x-auto whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdown(skillInspecionada.corpo),
                  }}
                />
              ) : (
                <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-500 text-center font-mono">
                  Instruções L2 detalhadas residem no arquivo SKILL.md do catálogo.
                </div>
              )}
            </div>
          </div>

          {/* Footer do Drawer */}
          <div className="p-4 border-t border-zinc-800 flex items-center justify-end">
            <button
              type="button"
              onClick={() => setSkillInspecionada(null)}
              className="px-4 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium cursor-pointer"
            >
              Concluído
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
