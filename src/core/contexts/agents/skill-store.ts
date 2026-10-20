import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnAsync } from "../../../utils/spawn-async.js";
import { parseYamlSimples } from "../../../schemas/agent.js";
import { AgentError } from "../../shared/errors.js";
import { projectRoot } from "../../../utils/paths.js";

export const NOME_SKILL_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const TETO_SKILLS_CHARS = 8000;

export interface Skill {
  name: string;
  description: string;
  category?: string;
  allowed_tools?: string[];
  corpo: string;
  versao?: string;
  requires?: string[];
}

export interface SkillResumo {
  id?: string;
  name: string;
  description: string;
  category?: string;
  allowed_tools: string[];
  versao?: string;
  requires: string[];
  ativa?: boolean;
}

export interface ListarSkillsOptions {
  incluirCatalogo?: boolean;
}

function msg(erro: unknown): string {
  return erro instanceof Error ? erro.message : String(erro);
}

function normalizarNome(nomeBruto: string): string {
  const nome = nomeBruto.trim();
  if (nome.length === 0 || !NOME_SKILL_RE.test(nome) || nome.length > 64) {
    throw new AgentError(
      `nome de skill inválido: "${nomeBruto}" — use kebab-case (letras minúsculas, números e hífens; ex.: auditoria-seo, no máximo 64 caracteres)`,
    );
  }
  return nome;
}

export function parseSkillMd(conteudo: string): Skill {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)([\s\S]*)$/.exec(conteudo);
  if (!m) {
    throw new AgentError(
      "SKILL.md sem frontmatter — comece com '---', o YAML (name, description e allowed-tools opcional), outro '---' e então o corpo markdown",
    );
  }
  let dados: Record<string, unknown>;
  try {
    dados = parseYamlSimples(m[1]!);
  } catch (erro) {
    throw new AgentError(`frontmatter da SKILL.md inválido: ${msg(erro)}`);
  }
  const nameBruto = dados.name;
  if (typeof nameBruto !== "string") {
    throw new AgentError("SKILL.md precisa do campo \"name\" (kebab-case) no frontmatter");
  }
  const name = normalizarNome(nameBruto);
  const description = dados.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    throw new AgentError(`skill "${name}": o campo "description" é obrigatório no frontmatter`);
  }
  const category = typeof dados.category === "string" && dados.category.trim()
    ? dados.category.trim()
    : undefined;
  const allowedTools = Array.isArray(dados["allowed-tools"])
    ? dados["allowed-tools"].map(String).filter((t) => t.length > 0)
    : undefined;
  return {
    name,
    description: description.trim(),
    category,
    allowed_tools: allowedTools,
    corpo: m[2]!.replace(/^\r?\n/, ""),
  };
}

/**
 * Monta a seção de Descoberta L1 ("## Available Skills (Progressive Disclosure)").
 * Injeta apenas o nome e descrição concisa de cada skill para que a LLM saiba que existem
 * sem sobrecarregar a janela de contexto de tokens.
 */
export function montarSumarioL1Skills(skills: SkillResumo[]): string {
  if (skills.length === 0) return "";
  const ordenadas = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  const linhas = ordenadas.map((s) => {
    const meta = s.allowed_tools && s.allowed_tools.length > 0 ? ` [tools: ${s.allowed_tools.join(", ")}]` : "";
    return `- \`${s.name}\`${meta}: ${s.description}`;
  });
  return `\n## Available Skills (Progressive Disclosure)\n${linhas.join("\n")}\n`;
}

/** Monta a seção de Ativação L2 "## Skills" com o corpo completo de cada skill declarada pelo agente. */
export function montarSecaoSkills(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const ordenadas = [...skills].sort((a, b) => a.name.localeCompare(b.name));
  let corpo = "";
  let truncada = false;
  for (const s of ordenadas) {
    const bloco = `### ${s.name}: ${s.description}\n${s.corpo.trim()}`;
    if (corpo.length + bloco.length > TETO_SKILLS_CHARS) {
      const restante = Math.max(0, TETO_SKILLS_CHARS - corpo.length - 40);
      corpo += bloco.slice(0, restante) + "\n[...]";
      truncada = true;
      break;
    }
    corpo += bloco;
  }
  const aviso = truncada
    ? "\n> [aviso] a seção de Skills excedeu o teto (~8k caracteres) e foi truncada."
    : "";
  return `\n## Skills (${ordenadas.length})\n${corpo}${aviso}\n`;
}

export class SkillStore {
  dirSkills(wsPath: string): string {
    return join(wsPath, ".opencorp", "skills");
  }

  caminhoSkill(wsPath: string, nome: string): string {
    return join(this.dirSkills(wsPath), nome);
  }

  caminhoSkillMd(wsPath: string, nome: string): string {
    return join(this.caminhoSkill(wsPath, nome), "SKILL.md");
  }

  existe(wsPath: string, nome: string): boolean {
    if (existsSync(this.caminhoSkillMd(wsPath, nome))) return true;
    if (existsSync(join(wsPath, ".agents", "skills", nome, "SKILL.md"))) return true;
    try {
      if (existsSync(join(projectRoot(), ".agents", "skills", nome, "SKILL.md"))) return true;
    } catch {}
    return false;
  }

  async listar(wsPath: string, opts?: ListarSkillsOptions): Promise<SkillResumo[]> {
    const resumos: SkillResumo[] = [];
    const nomesVistos = new Set<string>();

    const coletarDeDiretorio = (diretorio: string) => {
      if (!existsSync(diretorio)) return;
      let nomes: string[] = [];
      try {
        nomes = readdirSync(diretorio).filter((f) => !f.startsWith("."));
      } catch {
        return;
      }
      for (const nome of nomes) {
        if (nomesVistos.has(nome)) continue;
        const mdPath = join(diretorio, nome, "SKILL.md");
        if (!existsSync(mdPath)) continue;
        try {
          const skill = parseSkillMd(readFileSync(mdPath, "utf8"));
          const metaPath = join(diretorio, nome, "skill.json");
          let meta: { versao?: string; requires?: string[] } | undefined;
          if (existsSync(metaPath)) {
            try {
              const j = JSON.parse(readFileSync(metaPath, "utf8"));
              meta = {
                versao: typeof j.versao === "string" ? j.versao : undefined,
                requires: Array.isArray(j.requires) ? j.requires.map(String).filter((s: string) => s.length > 0) : undefined,
              };
            } catch {}
          }
          nomesVistos.add(skill.name);
          resumos.push({
            id: skill.name,
            name: skill.name,
            description: skill.description,
            category: skill.category,
            allowed_tools: skill.allowed_tools ?? [],
            versao: meta?.versao,
            requires: meta?.requires ?? [],
          });
        } catch {}
      }
    };

    // 1. Diretório oficial de skills do workspace (.opencorp/skills)
    coletarDeDiretorio(this.dirSkills(wsPath));

    if (opts?.incluirCatalogo) {
      // 2. Diretório local de skills sob .agents/skills (se houver)
      coletarDeDiretorio(join(wsPath, ".agents", "skills"));

      // 3. Catálogo global do repositório em .agents/skills
      try {
        const rootDir = join(projectRoot(), ".agents", "skills");
        if (resolve(rootDir) !== resolve(this.dirSkills(wsPath))) {
          coletarDeDiretorio(rootDir);
        }
      } catch {}
    }

    return resumos.sort((a, b) => a.name.localeCompare(b.name));
  }

  carregar(wsPath: string, nome: string): Skill {
    let mdPath = this.caminhoSkillMd(wsPath, nome);
    let metaDir = this.caminhoSkill(wsPath, nome);

    if (!existsSync(mdPath)) {
      const localAgentsPath = join(wsPath, ".agents", "skills", nome, "SKILL.md");
      let rootAgentsPath = "";
      try {
        rootAgentsPath = join(projectRoot(), ".agents", "skills", nome, "SKILL.md");
      } catch {}

      if (existsSync(localAgentsPath)) {
        mdPath = localAgentsPath;
        metaDir = dirname(localAgentsPath);
      } else if (rootAgentsPath && existsSync(rootAgentsPath)) {
        mdPath = rootAgentsPath;
        metaDir = dirname(rootAgentsPath);
      } else {
        throw new AgentError(
          `skill "${nome}" não instalada em ${this.dirSkills(wsPath)} — veja "oc skill listar"`,
        );
      }
    }

    const skill = parseSkillMd(readFileSync(mdPath, "utf8"));
    const meta = this.lerSkillJson(metaDir, nome);
    return {
      ...skill,
      versao: meta?.versao,
      requires: meta?.requires,
    };
  }

  async mostrar(wsPath: string, nome: string): Promise<Skill> {
    return this.carregar(wsPath, nome);
  }

  async remover(wsPath: string, nome: string): Promise<void> {
    const destino = this.caminhoSkill(wsPath, nome);
    if (!existsSync(destino)) {
      throw new AgentError(`skill "${nome}" não encontrada em ${this.dirSkills(wsPath)}`);
    }
    await rm(destino, { recursive: true, force: true });
  }

  /** Resolve skills declaradas por um agente, lançando erro legível se alguma faltar. */
  resolverInstaladas(wsPath: string, nomes: string[]): Skill[] {
    const faltando = nomes.filter((n) => !this.existe(wsPath, n));
    if (faltando.length > 0) {
      throw new AgentError(
        `skill(s) declarada(s) mas não instalada(s): ${faltando.join(", ")} — instale com "oc skill instalar <fonte>" e tente de novo`,
      );
    }
    return nomes.map((n) => this.carregar(wsPath, n));
  }

  async instalar(wsPath: string, fonte: string): Promise<Skill> {
    const origem = resolve(fonte);
    if (/^(git\+|https?:\/\/|git@|ssh:\/\/)/.test(fonte) || fonte.endsWith(".git")) {
      return this.instalarViaGit(wsPath, fonte);
    }
    if (/\.(tar|tar\.gz|tgz)$/i.test(fonte)) {
      return this.instalarViaTar(wsPath, origem);
    }
    if (!existsSync(origem) || !statSync(origem).isDirectory()) {
      throw new AgentError(
        `fonte de skill inválida: "${fonte}" — use uma pasta com SKILL.md, um repositório git ou um arquivo .tar`,
      );
    }
    return this.instalarDeDiretorio(wsPath, origem);
  }

  private async instalarViaGit(wsPath: string, url: string): Promise<Skill> {
    const tmp = await mkdtemp(join(tmpdir(), "opencorp-skill-git-"));
    try {
      const res = await spawnAsync("git", ["clone", "--depth", "1", url, tmp]);
      if (res.error || (res.status ?? 0) !== 0) {
        throw new AgentError(
          `não foi possível clonar o repositório de skill "${url}": ${res.error?.message ?? `git saiu com ${res.status}`}`,
        );
      }
      const alvo = this.localizarSkill(tmp);
      return this.instalarDeDiretorio(wsPath, alvo);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async instalarViaTar(wsPath: string, arquivo: string): Promise<Skill> {
    if (!existsSync(arquivo)) {
      throw new AgentError(`arquivo de skill não encontrado: "${arquivo}"`);
    }
    const tmp = await mkdtemp(join(tmpdir(), "opencorp-skill-tar-"));
    try {
      const res = await spawnAsync("tar", ["xf", arquivo, "-C", tmp]);
      if (res.error || (res.status ?? 0) !== 0) {
        throw new AgentError(
          `não foi possível extrair o pacote de skill "${arquivo}": ${res.error?.message ?? `tar saiu com ${res.status}`}`,
        );
      }
      const alvo = this.localizarSkill(tmp);
      return this.instalarDeDiretorio(wsPath, alvo);
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private localizarSkill(dirBase: string): string {
    if (existsSync(join(dirBase, "SKILL.md"))) return dirBase;
    let sub: string[] = [];
    try {
      sub = readdirSync(dirBase).filter((f) => !f.startsWith("."));
    } catch {
      sub = [];
    }
    for (const s of sub) {
      const p = join(dirBase, s);
      try {
        if (statSync(p).isDirectory() && existsSync(join(p, "SKILL.md"))) return p;
      } catch {
        continue;
      }
    }
    throw new AgentError(`nenhum SKILL.md encontrado em "${dirBase}" (nem em um nível abaixo)`);
  }

  private instalarDeDiretorio(wsPath: string, origem: string): Skill {
    const mdPath = join(origem, "SKILL.md");
    if (!existsSync(mdPath)) {
      throw new AgentError(`a pasta de skill "${origem}" não contém SKILL.md`);
    }
    const skill = parseSkillMd(readFileSync(mdPath, "utf8"));
    const destino = this.caminhoSkill(wsPath, skill.name);
    if (existsSync(destino)) {
      throw new AgentError(
        `skill "${skill.name}" já instalada em ${destino} — use "oc skill remover ${skill.name}" antes de reinstalar`,
      );
    }
    mkdirSync(dirname(destino), { recursive: true });
    cpSync(origem, destino, { recursive: true });
    return this.carregar(wsPath, skill.name);
  }

  private lerSkillJson(wsPath: string, nome: string): { versao?: string; requires?: string[] } | undefined {
    const path = join(this.caminhoSkill(wsPath, nome), "skill.json");
    if (!existsSync(path)) return undefined;
    try {
      const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      return {
        versao: typeof j.versao === "string" ? j.versao : undefined,
        requires: Array.isArray(j.requires) ? j.requires.map(String).filter((s) => s.length > 0) : undefined,
      };
    } catch {
      return undefined;
    }
  }
}
