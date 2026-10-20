import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { opencorpHome, projectRoot } from "../../../utils/paths.js";
import { writeFileAtomic } from "../../../utils/fs-safe.js";
import { OpencorpError } from "../../shared/errors.js";
import { OpenCodeBridge } from "../execution/opencode-bridge.js";

export class PackError extends OpencorpError {}

export interface PackResumo {
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
}

export interface PackItemConteudo {
  id: string;
  nome?: string;
  role?: string;
  description?: string;
  skills?: string[];
  trigger?: string;
  /** Metadados opcionais para a vitrine de modelos de agentes/fluxos. */
  template?: Record<string, any>;
}

export interface PackDetalhado extends PackResumo {
  requisitos?: {
    system?: string[];
    engines?: string[];
  };
  conteudo: {
    agentes: PackItemConteudo[];
    fluxos: PackItemConteudo[];
    skills: PackItemConteudo[];
    assets?: string[];
  };
}

export interface ResultadoInstalacaoPack {
  ok: boolean;
  packId: string;
  workspace: string;
  instalados: {
    agentes: string[];
    fluxos: string[];
    skills: string[];
  };
  avisos?: string[];
}

/** Normaliza um manifesto `pack.json` (chaves em português ou inglês) para PackDetalhado. */
function normalizarManifesto(dados: Record<string, any>, idPadrao: string): PackDetalhado {
  const lista = (pt: unknown, en: unknown): any[] => (Array.isArray(pt) ? pt : Array.isArray(en) ? en : []);
  const agentes = lista(dados.conteudo?.agentes, dados.contents?.agents) as PackItemConteudo[];
  const fluxos = lista(dados.conteudo?.fluxos, dados.contents?.flows) as PackItemConteudo[];
  const skills = lista(dados.conteudo?.skills, dados.contents?.skills) as PackItemConteudo[];
  const assets = lista(dados.conteudo?.assets, dados.contents?.assets) as string[];
  return {
    id: dados.id || idPadrao,
    nome: dados.nome || dados.name || idPadrao,
    versao: dados.versao || dados.version || "1.0.0",
    descricao: dados.descricao || dados.description || "",
    categoria: dados.categoria || dados.category || "Geral",
    autor: dados.autor || dados.author || "Custom",
    icone: dados.icone || dados.icon || "Package",
    destaque: Boolean(dados.destaque || dados.featured),
    total_agentes: agentes.length,
    total_fluxos: fluxos.length,
    total_skills: skills.length,
    requisitos: dados.requisitos || dados.requirements,
    conteudo: { agentes, fluxos, skills, assets },
  };
}

export class PackStore {
  private readonly homeDir: string;
  private readonly packsDir: string;

  constructor(opts: { homeDir?: string; packsDir?: string } = {}) {
    this.homeDir = opts.homeDir ?? opencorpHome();
    this.packsDir = opts.packsDir ?? join(projectRoot(), "templates", "packs");
  }

  /**
   * Registro de packs: o núcleo não embute nenhum domínio. Cada pack é um
   * manifesto `<dir>/<id>/pack.json` em `templates/packs` ou `~/.opencorp/packs`
   * (o segundo sobrescreve o primeiro pelo id).
   */
  private carregarRegistro(): Map<string, PackDetalhado> {
    const mapa = new Map<string, PackDetalhado>();
    for (const dir of [this.packsDir, join(this.homeDir, "packs")]) {
      if (!existsSync(dir)) continue;
      let entradas;
      try {
        entradas = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entradas) {
        if (!e.isDirectory()) continue;
        const packJsonPath = join(dir, e.name, "pack.json");
        if (!existsSync(packJsonPath)) continue;
        try {
          const pack = normalizarManifesto(JSON.parse(readFileSync(packJsonPath, "utf8")) as Record<string, any>, e.name);
          mapa.set(pack.id, pack);
        } catch {}
      }
    }
    return mapa;
  }

  async listar(): Promise<PackResumo[]> {
    const resumos: PackResumo[] = Array.from(this.carregarRegistro().values()).map(
      ({ requisitos: _r, conteudo: _c, ...resumo }) => resumo,
    );
    return resumos.sort((a, b) => {
      if (a.destaque && !b.destaque) return -1;
      if (!a.destaque && b.destaque) return 1;
      return a.nome.localeCompare(b.nome);
    });
  }

  async obter(packId: string): Promise<PackDetalhado> {
    const pack = this.carregarRegistro().get(packId);
    if (pack) return pack;
    throw new PackError(`Pack de solução "${packId}" não encontrado.`);
  }

  /**
   * Instalação Atômica de um Pack no Workspace Ativo:
   * 1. Copia/registra agentes necessários em .opencorp/agents/
   * 2. Sincroniza agentes via OpenCodeBridge
   * 3. Registra os fluxos em .opencorp/flows/
   * 4. Copia as skills para .opencorp/skills/
   */
  async instalar(
    packId: string,
    ws: { id: string; path: string },
  ): Promise<ResultadoInstalacaoPack> {
    const pack = await this.obter(packId);
    const avisos: string[] = [];

    const dirAgents = join(ws.path, ".opencorp", "agents");
    const dirFlows = join(ws.path, ".opencorp", "flows");
    const dirSkills = join(ws.path, ".opencorp", "skills");

    mkdirSync(dirAgents, { recursive: true });
    mkdirSync(dirFlows, { recursive: true });
    mkdirSync(dirSkills, { recursive: true });

    const agentesInstalados: string[] = [];
    const fluxosInstalados: string[] = [];
    const skillsInstaladas: string[] = [];

    // 1. Instalação de Skills do Pack
    for (const skillItem of pack.conteudo.skills) {
      const skillId = skillItem.id;
      const destinoSkill = join(dirSkills, skillId);
      if (!existsSync(destinoSkill)) {
        mkdirSync(destinoSkill, { recursive: true });
        const skillMdConteudo = [
          "---",
          `name: ${skillId}`,
          `description: ${skillItem.description || `Skill ${skillId} provida pelo pack ${pack.nome}`}`,
          "allowed-tools: [bash, read, write]",
          "---",
          "",
          `# ${skillItem.nome || skillId}`,
          "",
          `Instruções operacionais e procedimentos para ${skillId}.`,
        ].join("\n");
        writeFileSync(join(destinoSkill, "SKILL.md"), `${skillMdConteudo}\n`, "utf8");
      }
      skillsInstaladas.push(skillId);
    }

    // 2. Instalação de Agentes do Pack
    const bridge = new OpenCodeBridge();
    for (const ag of pack.conteudo.agentes) {
      const agentFile = join(dirAgents, `${ag.id}.md`);
      const skillsDoAgente = ag.skills || [];
      const agentFrontmatter = [
        "---",
        `id: ${ag.id}`,
        `role: ${ag.role || ag.id}`,
        "category: operario",
        "model: openrouter/nvidia/nemotron-3.5-lightning:free",
        skillsDoAgente.length > 0 ? `skills: [${skillsDoAgente.join(", ")}]` : "skills: []",
        "tools: [read, write, bash, registry]",
        "permissions: level-2",
        "ativo: true",
        "---",
        "",
        `# ${ag.role || ag.id}`,
        "",
        `Você é o agente autônomo responsável pela missão de ${ag.role || ag.id} no workspace ${ws.id}.`,
      ].join("\n");

      await writeFileAtomic(agentFile, `${agentFrontmatter}\n`);
      agentesInstalados.push(ag.id);

      // Sincroniza via bridge
      try {
        await bridge.sincronizarAgente(
          ws.path,
          {
            id: ag.id,
            role: ag.role || ag.id,
            category: "operario",
            model: "openrouter/nvidia/nemotron-3.5-lightning:free",
            skills: skillsDoAgente,
            tools: ["read", "write", "bash", "registry"],
            permissions: "level-2",
            ativo: true,
          } as any,
          `Você é o agente autônomo responsável pela missão de ${ag.role || ag.id} no workspace ${ws.id}.`,
        );
      } catch (err: unknown) {
        avisos.push(`Aviso na sincronização do agente ${ag.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Instalação de Fluxos do Pack
    for (const fl of pack.conteudo.fluxos) {
      const flowFile = join(dirFlows, `${fl.id}.json`);
      const flowConteudo = {
        id: fl.id,
        name: fl.nome || fl.id,
        ativo: true,
        nos: [
          { id: "gatilho", tipo: fl.trigger || "manual", config: {} },
          { id: "execucao", tipo: "script", config: { comando: "echo 'executando passo do pack'" } },
        ],
        arestas: [{ de: "gatilho", para: "execucao" }],
      };
      await writeFileAtomic(flowFile, `${JSON.stringify(flowConteudo, null, 2)}\n`);
      fluxosInstalados.push(fl.id);
    }

    return {
      ok: true,
      packId: pack.id,
      workspace: ws.id,
      instalados: {
        agentes: agentesInstalados,
        fluxos: fluxosInstalados,
        skills: skillsInstaladas,
      },
      avisos: avisos.length > 0 ? avisos : undefined,
    };
  }
}
