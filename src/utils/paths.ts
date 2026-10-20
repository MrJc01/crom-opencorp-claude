import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function expandTilde(caminho: string, home = homedir()): string {
  if (caminho === "~") return home;
  if (caminho.startsWith("~/")) return join(home, caminho.slice(2));
  return caminho;
}

export function resolvePath(caminho: string, base = process.cwd()): string {
  const expandido = expandTilde(caminho);
  return isAbsolute(expandido) ? expandido : resolve(base, expandido);
}

export function opencorpHome(): string {
  const env = process.env.OPENCORP_HOME;
  if (env !== undefined && env.trim().length > 0) {
    return resolve(env.trim());
  }
  return homedir();
}

// ---------------------------------------------------------------------------
// projectRoot — descobre a raiz do repositório OpenCorp de forma resiliente
// ---------------------------------------------------------------------------

let _projectRootCache: string | undefined;

/**
 * Descobre a raiz do projeto OpenCorp.
 *
 * Estratégia (em ordem):
 *  1. Variável de ambiente `OPENCORP_PROJECT_ROOT` (override explícito)
 *  2. Sobe a árvore a partir de `import.meta.url` deste arquivo procurando
 *     `package.json` com `"name": "opencorp"`.
 *  3. Sobe a árvore a partir de `process.argv[1]` (o binário que iniciou).
 *  4. Sobe a árvore a partir de `process.cwd()`.
 *
 * O resultado é cacheado em variável de módulo para não re-resolver a cada chamada.
 */
export function projectRoot(): string {
  if (_projectRootCache !== undefined) return _projectRootCache;

  // 1. Override explícito
  const envRoot = process.env.OPENCORP_PROJECT_ROOT;
  if (envRoot && envRoot.trim().length > 0 && existsSync(join(envRoot.trim(), "package.json"))) {
    _projectRootCache = resolve(envRoot.trim());
    return _projectRootCache;
  }

  // 2. A partir deste arquivo (src/utils/paths.ts → dist/utils/paths.js)
  const aqui = dirname(fileURLToPath(import.meta.url));
  const fromSelf = _encontrarRaiz(aqui);
  if (fromSelf) {
    _projectRootCache = fromSelf;
    return _projectRootCache;
  }

  // 3. A partir do binário que iniciou o processo
  if (process.argv[1]) {
    const fromBin = _encontrarRaiz(dirname(resolve(process.argv[1])));
    if (fromBin) {
      _projectRootCache = fromBin;
      return _projectRootCache;
    }
  }

  // 4. A partir do CWD
  const fromCwd = _encontrarRaiz(process.cwd());
  if (fromCwd) {
    _projectRootCache = fromCwd;
    return _projectRootCache;
  }

  // Fallback final: diretório pai de import.meta.url (melhor que nada)
  _projectRootCache = resolve(aqui, "..", "..");
  return _projectRootCache;
}

/**
 * Sobe a árvore de diretórios a partir de `inicio` procurando
 * package.json cujo "name" seja "opencorp".
 */
function _encontrarRaiz(inicio: string): string | null {
  let dir = resolve(inicio);
  const raizFs = resolve("/");
  for (let i = 0; i < 20; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string };
        if (json.name === "opencorp") return dir;
      } catch {
        // package.json corrompido — continua subindo
      }
    }
    const pai = dirname(dir);
    if (pai === dir || pai === raizFs) break;
    dir = pai;
  }
  return null;
}

/**
 * PATH com o `oc`/`opencorp` deste checkout na frente. O `oc` global do sistema pode ser de outra
 * instalação do OpenCorp (ex.: o repositório original); agentes, Secretário e scripts de flow
 * precisam chamar este.
 */
export function pathComCliLocal(pathAtual: string = process.env.PATH ?? ""): string {
  const dir = join(projectRoot(), "bin", "path");
  if (!existsSync(dir)) return pathAtual;
  return [dir, ...pathAtual.split(":").filter((p) => p && p !== dir)].join(":");
}
