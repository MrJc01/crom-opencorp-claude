import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnAsync } from "../../../utils/spawn-async.js";
import { TemplateError } from "../../shared/errors.js";
import { writeFileAtomic } from "../../../utils/fs-safe.js";
import { validarIdAgente } from "../../../schemas/agent.js";
import { opencorpHome, projectRoot } from "../../../utils/paths.js";

const PADRAO_SEGREDOS = /(^|[^a-z0-9])(secrets?|keys?)([^a-z0-9]|$)|\.env/i;

interface TemplateJson {
  name?: string;
  version?: string;
  description?: string;
  author?: string;
}

export class TemplateStore {
  private readonly homeDir: string;
  private readonly templatesDir: string;

  constructor(opts: { homeDir?: string; templatesDir?: string } = {}) {
    this.homeDir = opts.homeDir ?? opencorpHome();
    this.templatesDir =
      opts.templatesDir ??
      join(projectRoot(), "templates");
  }

  dirUsuario(): string {
    return join(this.homeDir, ".opencorp", "templates");
  }

  caminho(id: string): string {
    return join(this.dirUsuario(), id);
  }

  async listar(): Promise<{ id: string; tipo: string; descricao: string }[]> {
    const mapa = new Map<string, { id: string; tipo: string; descricao: string }>();

    // Default básico
    mapa.set("default", {
      id: "default",
      tipo: "skeleton (projeto)",
      descricao: "workspace completo padrão (agentes + categorias)",
    });

    const escanearDir = (dir: string) => {
      if (!existsSync(dir)) return;
      for (const entrada of readdirSync(dir, { withFileTypes: true })) {
        if (!entrada.isDirectory()) continue;
        if (entrada.name === "default") continue;
        const tipo = existsSync(join(dir, entrada.name, ".opencorp")) ? "skeleton" : "pacote";
        let descricao = "";
        const tj = join(dir, entrada.name, "template.json");
        if (existsSync(tj)) {
          try {
            const dados = JSON.parse(readFileSync(tj, "utf8")) as TemplateJson;
            descricao = [dados.description, dados.version ? `v${dados.version}` : null, dados.author]
              .filter((x) => Boolean(x))
              .join(" · ");
          } catch {
            descricao = "(template.json inválido)";
          }
        }
        mapa.set(entrada.name, { id: entrada.name, tipo, descricao });
      }
    };

    // 1. Templates embutidos do repositório/instalação
    escanearDir(this.templatesDir);
    // 2. Templates customizados pelo usuário em ~/.opencorp/templates
    escanearDir(this.dirUsuario());

    return Array.from(mapa.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async criar(idBruto: string): Promise<string> {
    const id = validarIdAgente(idBruto);
    const destino = this.caminho(id);
    if (existsSync(destino)) {
      throw new TemplateError(`template "${id}" já existe (${destino})`);
    }
    mkdirSync(join(destino, "agents"), { recursive: true });
    mkdirSync(join(destino, "registries"), { recursive: true });
    await writeFileAtomic(
      join(destino, "template.json"),
      `${JSON.stringify({ name: id, version: "1.0.0", description: "", author: "" }, null, 2)}\n`,
    );
    await writeFileAtomic(
      join(destino, "config.json"),
      `${JSON.stringify({ version: 1 }, null, 2)}\n`,
    );
    await writeFileAtomic(
      join(destino, "security_policy.json"),
      `${JSON.stringify(
        {
          level: "standard",
          blocklist: ["rm -rf", "shutdown", "reboot", "curl * | bash", "git push --force"],
          allowlist_extra: ["git", "node", "npm", "python3", "pytest"],
          network_allowlist: ["registry.npmjs.org", "github.com", "pypi.org"],
          hitl_patterns: ["git push", "npm publish", "DROP ", "DELETE FROM", "email"],
        },
        null,
        2,
      )}\n`,
    );
    return destino;
  }

  async exportar(
    wsPath: string,
    wsId: string,
    saida?: string,
  ): Promise<{ destino: string; excluidos: string[] }> {
    const pkg = await mkdtemp(join(tmpdir(), "opencorp-pkg-"));
    try {
      await writeFileAtomic(
        join(pkg, "template.json"),
        `${JSON.stringify(
          {
            name: wsId,
            version: "1.0.0",
            description: `template exportado do workspace "${wsId}"`,
            author: "opencorp",
          },
          null,
          2,
        )}\n`,
      );
      const excluidos: string[] = [];
      const origemOpencorp = join(wsPath, ".opencorp");
      if (existsSync(origemOpencorp)) {
        scanExcluidos(origemOpencorp, excluidos);
      }
      const origemAgents = join(wsPath, ".opencorp", "agents");
      if (existsSync(origemAgents)) {
        copyComExclusao(origemAgents, join(pkg, "agents"));
      }
      const origemRegistries = join(wsPath, ".opencorp", "registries");
      if (existsSync(origemRegistries)) {
        copyComExclusao(origemRegistries, join(pkg, "registries"));
      }
      for (const arquivo of ["config.json", "security_policy.json"]) {
        const origem = join(wsPath, ".opencorp", arquivo);
        if (existsSync(origem)) copyFileSync(origem, join(pkg, arquivo));
      }

      let destino: string;
      if (saida && saida.endsWith(".corp")) {
        mkdirSync(join(saida, ".."), { recursive: true });
        const membros = ["template.json", "agents", "registries", "config.json", "security_policy.json"].filter(
          (m) => existsSync(join(pkg, m)),
        );
        const tar = await spawnAsync("tar", ["-czf", saida, "-C", pkg, ...membros]);
        if (tar.status !== 0) {
          throw new TemplateError(`falha ao empacotar .corp: ${tar.stderr || "tar indisponível"}`);
        }
        destino = saida;
      } else if (saida) {
        if (existsSync(saida)) {
          throw new TemplateError(`destino já existe: ${saida} — escolha outro caminho`);
        }
        mkdirSync(join(saida, ".."), { recursive: true });
        cpSync(pkg, saida, { recursive: true });
        destino = saida;
      } else {
        destino = await this.instalar(pkg, wsId);
      }
      return { destino, excluidos };
    } finally {
      rmSync(pkg, { recursive: true, force: true });
    }
  }

  async importar(fonte: string, asId?: string): Promise<{ id: string; dir: string }> {
    let extraido: string | null = null;
    let dirFonte: string;
    try {
      if (/^https?:\/\//i.test(fonte)) {
        extraido = await mkdtemp(join(tmpdir(), "opencorp-clone-"));
        const git = await spawnAsync("git", ["clone", "--depth", "1", fonte, extraido]);
        if (git.status !== 0) {
          throw new TemplateError(
            `não foi possível clonar "${fonte}": ${git.stderr.trim() || "git indisponível ou repositório inacessível"}`,
          );
        }
        dirFonte = extraido;
      } else if (fonte.endsWith(".corp") || (existsSync(fonte) && statSync(fonte).isFile())) {
        if (!existsSync(fonte)) {
          throw new TemplateError(`arquivo não encontrado: ${fonte}`);
        }
        extraido = await mkdtemp(join(tmpdir(), "opencorp-corp-"));
        const tar = await spawnAsync("tar", ["-xzf", fonte, "-C", extraido]);
        if (tar.status !== 0) {
          throw new TemplateError(`falha ao extrair "${fonte}": ${tar.stderr || "tar indisponível ou arquivo inválido"}`);
        }
        dirFonte = extraido;
      } else {
        if (!existsSync(fonte) || !statSync(fonte).isDirectory()) {
          throw new TemplateError(`fonte não encontrada: ${fonte}`);
        }
        dirFonte = resolve(fonte);
      }
      return await this.instalarComValidacao(dirFonte, asId);
    } finally {
      if (extraido) rmSync(extraido, { recursive: true, force: true });
    }
  }

  private async instalarComValidacao(dirFonte: string, asId?: string): Promise<{ id: string; dir: string }> {
    const ehPacote = existsSync(join(dirFonte, "template.json")) || existsSync(join(dirFonte, "agents"));
    const ehSkeleton = existsSync(join(dirFonte, ".opencorp"));
    if (!ehPacote && !ehSkeleton) {
      throw new TemplateError(
        `"${dirFonte}" não parece um template opencorp — falta template.json/agents/ (pacote) ou .opencorp/ (workspace)`,
      );
    }
    let idBruto = asId;
    if (!idBruto) {
      const tj = join(dirFonte, "template.json");
      if (existsSync(tj)) {
        try {
          idBruto = (JSON.parse(readFileSync(tj, "utf8")) as TemplateJson).name;
        } catch {
          idBruto = undefined;
        }
      }
      idBruto = idBruto || basename(dirFonte);
    }
    let id: string;
    try {
      id = validarIdAgente(idBruto!);
    } catch (erro) {
      throw new TemplateError(`id de template inválido ("${idBruto}") — use --as <id> com kebab-case`);
    }
    return { id, dir: await this.instalar(dirFonte, id) };
  }

  private async instalar(dirFonte: string, id: string): Promise<string> {
    const destino = this.caminho(id);
    if (existsSync(destino)) {
      throw new TemplateError(
        `template "${id}" já existe (${destino}) — use outro id (--as) ou remova o existente`,
      );
    }
    mkdirSync(this.dirUsuario(), { recursive: true });
    cpSync(dirFonte, destino, { recursive: true });
    if (!existsSync(join(destino, "template.json"))) {
      await writeFileAtomic(
        join(destino, "template.json"),
        `${JSON.stringify({ name: id, version: "1.0.0", description: "", author: "" }, null, 2)}\n`,
      );
    }
    return destino;
  }
}

function scanExcluidos(dir: string, excluidos: string[]): void {
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const completo = join(dir, entrada.name);
    if (PADRAO_SEGREDOS.test(entrada.name)) {
      excluidos.push(completo);
      continue;
    }
    if (entrada.isDirectory()) scanExcluidos(completo, excluidos);
  }
}

function copyComExclusao(origem: string, destino: string): void {
  cpSync(origem, destino, {
    recursive: true,
    filter: (src: string) => src === origem || !PADRAO_SEGREDOS.test(basename(src)),
  });
}
