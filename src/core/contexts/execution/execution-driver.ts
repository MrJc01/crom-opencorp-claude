import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import { projectRoot } from "../../../utils/paths.js";

export type TipoDriver = "sandbox" | "host" | "docker" | "podman";

export interface LimitesRecursos {
  ramMb?: number;
  cpuPct?: number;
  /** Quando true, isola a rede do sandbox (bwrap --unshare-net). Padrão: false (rede compartilhada). */
  redeIsolada?: boolean;
  /** Domínios permitidos (allowlist lógica; com rede isolada todo tráfego externo é bloqueado). */
  dominiosPermitidos?: string[];
}

export interface OpcoesPreparacaoDriver {
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  workspaceId: string;
  workspacePath: string;
  limites?: LimitesRecursos;
}

export interface ComandoPreparado {
  driver: TipoDriver;
  binary: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  aviso?: string;
}

export interface ExecutionDriver {
  readonly tipo: TipoDriver;
  disponivel(): Promise<boolean>;
  preparar(opts: OpcoesPreparacaoDriver): Promise<ComandoPreparado>;
}

/**
 * Driver Nativo Direto na Máquina (Host)
 */
export class HostDriver implements ExecutionDriver {
  readonly tipo: TipoDriver = "host";

  async disponivel(): Promise<boolean> {
    return true;
  }

  async preparar(opts: OpcoesPreparacaoDriver): Promise<ComandoPreparado> {
    // Se houver limites de recursos e systemd-run estiver disponível, envolve
    if ((opts.limites?.ramMb || opts.limites?.cpuPct) && (await checarBinario("systemd-run"))) {
      const scopeArgs = ["--user", "--scope", "--quiet"];
      if (opts.limites.ramMb) scopeArgs.push(`-p`, `MemoryMax=${opts.limites.ramMb}M`);
      if (opts.limites.cpuPct) scopeArgs.push(`-p`, `CPUQuota=${opts.limites.cpuPct}%`);

      return {
        driver: "host",
        binary: "systemd-run",
        args: [...scopeArgs, opts.binary, ...opts.args],
        cwd: opts.cwd,
        env: opts.env,
      };
    }

    return {
      driver: "host",
      binary: opts.binary,
      args: opts.args,
      cwd: opts.cwd,
      env: opts.env,
    };
  }
}

/**
 * Diretórios a montar (ro) para que o binário do motor exista dentro do
 * sandbox. Resolve caminho absoluto (incluindo symlink → alvo) ou procura
 * no PATH do host quando vier só o nome ("opencode").
 */
export function dirsDoBinario(binario: string): string[] {
  const candidatos: string[] = [binario];
  if (!isAbsolute(binario)) {
    for (const p of (process.env.PATH || "/usr/local/bin:/usr/bin:/bin").split(":")) {
      if (p) candidatos.push(resolve(p, binario));
    }
  }
  const dirs = new Set<string>();
  for (const c of candidatos) {
    if (!existsSync(c)) continue;
    let atual = c;
    dirs.add(dirname(atual));
    for (let hop = 0; hop < 10; hop++) {
      try {
        const stat = lstatSync(atual);
        if (stat.isSymbolicLink()) {
          const alvo = readlinkSync(atual);
          atual = resolve(dirname(atual), alvo);
          dirs.add(dirname(atual));
        } else {
          break;
        }
      } catch {
        break;
      }
    }
    try {
      const real = realpathSync(c);
      dirs.add(dirname(real));
    } catch {}

    // Se o binário residir em um node_modules, garante a montagem da raiz do node_modules
    for (const d of [...dirs]) {
      const nmIdx = d.lastIndexOf("/node_modules");
      if (nmIdx !== -1) {
        dirs.add(d.slice(0, nmIdx + "/node_modules".length));
      }
    }

    if (dirs.size > 0) return [...dirs];
  }
  return [];
}

/**
 * Driver Seguro Ultraleve via Bubblewrap (Sandbox)
 * Isola o sistema de arquivos, monta /usr, /lib, /bin como read-only e protege o /home.
 */
export class SandboxDriver implements ExecutionDriver {
  readonly tipo: TipoDriver = "sandbox";

  async disponivel(): Promise<boolean> {
    return checarBinario("bwrap");
  }

  async preparar(opts: OpcoesPreparacaoDriver): Promise<ComandoPreparado> {
    const temBwrap = await this.disponivel();
    if (!temBwrap) {
      const host = new HostDriver();
      const prep = await host.preparar(opts);
      prep.aviso = "[SandboxDriver] bwrap não encontrado no sistema — fallback para modo host";
      return prep;
    }

    const homeBase =
      (typeof opts.env.OPENCORP_HOME === "string" && opts.env.OPENCORP_HOME) ||
      process.env.HOME ||
      "";

    const bwrapArgs: string[] = [
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/bin", "/bin",
      "--ro-bind", "/etc", "/etc",
      "--proc", "/proc",
      "--dev", "/dev",
      "--unshare-pid",
      "--unshare-uts",
      "--unshare-ipc",
      "--die-with-parent",
    ];

    if (existsSync("/lib64")) {
      bwrapArgs.unshift("--ro-bind", "/lib64", "/lib64");
    }

    // /tmp gravável (opencode/node precisam de temp)
    bwrapArgs.push("--tmpfs", "/tmp");

    // Monta o workspace garantindo que o ponto de montagem exista se estiver dentro de /tmp
    if (opts.workspacePath.startsWith("/tmp/") || opts.workspacePath === "/tmp") {
      bwrapArgs.push("--dir", opts.workspacePath);
    }
    bwrapArgs.push("--bind", opts.workspacePath, opts.workspacePath);

    if (opts.cwd.startsWith("/tmp/") && opts.cwd !== opts.workspacePath) {
      bwrapArgs.push("--dir", opts.cwd);
    }
    bwrapArgs.push("--chdir", opts.cwd);

    // Isolamento de rede: allowlist lógica — sem domínios liberados, bloqueia rede via --unshare-net
    const temAllowlist = (opts.limites?.dominiosPermitidos?.length ?? 0) > 0;
    const redeIsolada = opts.limites?.redeIsolada ?? false;
    if (redeIsolada && !temAllowlist) {
      bwrapArgs.push("--unshare-net");
    }

    // DNS dentro do sandbox: /etc/resolv.conf costuma ser symlink para
    // /run/systemd/resolve/* (fora dos binds) — sem isso, toda chamada de
    // rede falha (foi o que derrubou models.opencode.ai → "Model not found"
    // em TODAS as rondas). Monta o diretório-alvo (bwrap não monta arquivo
    // sobre symlink — dá "Can't create file").
    try {
      const resolvReal = realpathSync("/etc/resolv.conf");
      if (resolvReal !== "/etc/resolv.conf" && existsSync(resolvReal)) {
        const dirAlvo = dirname(resolvReal);
        bwrapArgs.push("--ro-bind", dirAlvo, dirAlvo);
      }
    } catch {
      /* sem resolv.conf no host — nada a fazer */
    }

    // Permite leitura de dependências globais ou symlinks comuns (ex: myvoice/piper, node_modules).
    // Só DIRETÓRIOS: bind de arquivo dentro de /usr (já montado ro) falha com
    // "Can't create file" — Chrome/Playwright resolve pelo cache ms-playwright.
    const caminhosLeituraOpcionais = [
      "/home/j/.local/share/myvoice",
      "/usr/local",
      "/home/j/.cache/ms-playwright",
      join(projectRoot(), "node_modules"),
      homeBase ? resolve(homeBase, ".opencorp", "node_modules") : "",
      homeBase ? resolve(homeBase, ".opencorp", "bin") : "",
      homeBase ? resolve(homeBase, ".opencorp", "lib") : "",
    ].filter(Boolean);
    for (const c of caminhosLeituraOpcionais) {
      if (existsSync(c)) {
        bwrapArgs.push("--ro-bind", c, c);
      }
    }

    // ── Binário do motor dentro do sandbox ──
    // Sem isso, qualquer caminho absoluto fora dos binds (ex.:
    // ~/.opencorp/bin/opencode) morre com ENOENT no execvp — foi o que
    // quebrou TODAS as rondas quando o sandbox virou padrão.
    for (const dir of dirsDoBinario(opts.binary)) {
      bwrapArgs.push("--ro-bind", dir, dir);
    }
    // Se o primeiro argumento for um script com caminho (ex: node script.js / codex.js)
    if (opts.args && opts.args[0] && typeof opts.args[0] === "string") {
      const possivelScript = opts.args[0];
      if (possivelScript.startsWith("/") && existsSync(possivelScript)) {
        for (const dir of dirsDoBinario(possivelScript)) {
          bwrapArgs.push("--ro-bind", dir, dir);
        }
      }
    }

    // Caminhos extras, somente leitura, que o motor informa (ex.: SDK e binário do motor).
    const extrasRo = typeof opts.env.OPENCORP_SANDBOX_RO_BIND === "string" ? opts.env.OPENCORP_SANDBOX_RO_BIND : "";
    for (const extra of extrasRo.split(":")) {
      if (extra && isAbsolute(extra) && existsSync(extra)) bwrapArgs.push("--ro-bind", extra, extra);
    }
    // Caminhos extras com escrita que o motor informa (ex.: pasta de login do motor). Só entram se existirem.
    const extrasRw = typeof opts.env.OPENCORP_SANDBOX_RW_BIND === "string" ? opts.env.OPENCORP_SANDBOX_RW_BIND : "";
    for (const extra of extrasRw.split(":")) {
      if (extra && isAbsolute(extra) && existsSync(extra)) bwrapArgs.push("--bind", extra, extra);
    }
    // Segredos globais (wp.cjs e scripts legados leem ~/.opencorp/secrets.json
    // direto do disco). Monta SOMENTE esse arquivo, read-only — sem ele,
    // todo agente que publica/edita quebra em silêncio no sandbox.
    // (Os agentes já recebem segredos via OPENCORP_SECRET por design; isto
    // apenas restaura o comportamento pré-sandbox.)
    {
      const segredos = homeBase ? resolve(homeBase, ".opencorp", "secrets.json") : "";
      if (segredos && existsSync(segredos)) {
        bwrapArgs.push("--ro-bind", segredos, segredos);
      }
    }
    if (existsSync("/dev/shm")) {
      bwrapArgs.push("--bind", "/dev/shm", "/dev/shm");
    }
    for (const chave of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const) {
      const v = opts.env[chave];
      if (typeof v === "string" && v.length > 0 && v.startsWith("/") && existsSync(v)) {
        bwrapArgs.push("--bind", v, v);
      }
    }

    let binFinal = "bwrap";
    let argsFinal = [...bwrapArgs, opts.binary, ...opts.args];

    // Se houver limites de memória ou CPU, encapsula o bwrap dentro do systemd-run
    if ((opts.limites?.ramMb || opts.limites?.cpuPct) && (await checarBinario("systemd-run"))) {
      const scopeArgs = ["--user", "--scope", "--quiet"];
      if (opts.limites.ramMb) scopeArgs.push(`-p`, `MemoryMax=${opts.limites.ramMb}M`);
      if (opts.limites.cpuPct) scopeArgs.push(`-p`, `CPUQuota=${opts.limites.cpuPct}%`);

      binFinal = "systemd-run";
      argsFinal = [...scopeArgs, "bwrap", ...argsFinal];
    }

    // Garante que o PATH dentro do sandbox encontre os binários padrão
    const envFinal: Record<string, string | undefined> = {
      ...opts.env,
      PATH: opts.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    };

    return {
      driver: "sandbox",
      binary: binFinal,
      args: argsFinal,
      cwd: opts.cwd,
      env: envFinal,
    };
  }
}

/**
 * Driver de Container Completo OCI (Docker / Podman)
 */
export class ContainerDriver implements ExecutionDriver {
  readonly tipo: TipoDriver;
  private readonly cli: "docker" | "podman";
  private readonly imagem: string;

  constructor(tipo: "docker" | "podman" = "docker", imagem = "opencorp/workspace-base:latest") {
    this.tipo = tipo;
    this.cli = tipo;
    this.imagem = imagem;
  }

  async disponivel(): Promise<boolean> {
    return checarBinario(this.cli);
  }

  async preparar(opts: OpcoesPreparacaoDriver): Promise<ComandoPreparado> {
    const disponivel = await this.disponivel();
    if (!disponivel) {
      const sand = new SandboxDriver();
      const prep = await sand.preparar(opts);
      prep.aviso = `[ContainerDriver] ${this.cli} não encontrado — fallback para sandbox`;
      return prep;
    }

    const containerArgs = [
      "run",
      "--rm",
      "-i",
      "-v", `${resolve(opts.workspacePath)}:${resolve(opts.workspacePath)}:rw`,
      "-w", opts.cwd,
    ];

    if (this.cli === "podman") {
      containerArgs.push("--userns=keep-id");
    }

    if (opts.limites?.ramMb) {
      containerArgs.push(`--memory=${opts.limites.ramMb}m`);
    }
    if (opts.limites?.cpuPct) {
      containerArgs.push(`--cpus=${(opts.limites.cpuPct / 100).toFixed(1)}`);
    }

    for (const [k, v] of Object.entries(opts.env)) {
      if (v !== undefined && k !== "PATH") {
        containerArgs.push("-e", `${k}=${v}`);
      }
    }

    return {
      driver: this.tipo,
      binary: this.cli,
      args: [...containerArgs, this.imagem, opts.binary, ...opts.args],
      cwd: opts.cwd,
      env: opts.env,
    };
  }
}

/**
 * Utilitário para verificar a presença de um executável no PATH
 */
async function checarBinario(bin: string): Promise<boolean> {
  try {
    const res = await execa("which", [bin], { reject: false });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Resolve o driver com precedência: agente > workspace > global.
 * `container` é alias de `docker` para compatibilidade com frontmatter legado.
 */
export function escolherPreferenciaDriver(agentDriver?: string, workspaceDriver?: string, globalDriver = "sandbox"): string {
  const norm = (v?: string) => (v ?? "").toLowerCase().trim();
  const a = norm(agentDriver);
  if (a === "container") return "docker";
  if (a === "sandbox" || a === "host" || a === "docker" || a === "podman") return a;
  const w = norm(workspaceDriver);
  if (w === "container") return "docker";
  if (w) return w;
  return norm(globalDriver) || "sandbox";
}

/**
 * Resolve o driver adequado conforme preferências do workspace ou globais
 */
export async function resolverDriverExecucao(
  preferencia: string = "sandbox",
  imagemContainer?: string,
): Promise<ExecutionDriver> {
  const normalizada = preferencia.toLowerCase().trim();

  if (normalizada === "host") {
    return new HostDriver();
  }

  if (normalizada === "docker") {
    const d = new ContainerDriver("docker", imagemContainer);
    if (await d.disponivel()) return d;
  }

  if (normalizada === "podman") {
    const p = new ContainerDriver("podman", imagemContainer);
    if (await p.disponivel()) return p;
  }

  // Padrão de fábrica: Sandbox (Bubblewrap)
  const sandbox = new SandboxDriver();
  if (await sandbox.disponivel()) {
    return sandbox;
  }

  // Fallback seguro se bwrap não estiver presente no OS
  return new HostDriver();
}
