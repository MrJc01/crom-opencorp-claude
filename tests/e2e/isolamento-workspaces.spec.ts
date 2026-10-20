import { test, expect } from "@playwright/test";
import { chmod, mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "../../src/core/contexts/execution/session-manager.js";

// F6-T02 — Prova de isolamento entre workspaces.
//
// O que este spec comprova (e como):
//  - O driver de execução (src/core/execution-driver.ts, SandboxDriver via
//    bwrap) é o responsável pelo isolamento. Para QUALQUER harness, o comando
//    final é embrulhado por bwrap com:
//      * `--bind <workspaceA> <workspaceA>` (única montagem gravável);
//      * `--ro-bind` de /usr, /lib, /bin, /etc, /lib64 e do diretório do
//        binário do harness;
//      * `--tmpfs /tmp` (temp isolado por execução);
//      * XDG_* do opencorp montados rw apenas quando existirem;
//      * `--chdir <workspaceA>` — logo o cwd do processo é a pasta de A.
//    O home do usuário e os demais workspaces NÃO são montados → ficam
//    inacessíveis dentro do sandbox (o binário só enxerga o que é montado).
//
//  - Em vez de um LLM real (não-hermético), instalamos um runner FAKE
//    (shell script) no bin gerenciado `~/.opencorp/bin/<harness>`. Esse runner
//    é o "agente": tenta ler/escrever fora de A via caminho absoluto e imprime
//    marcadores ISO_*. Como ele roda DENTRO do bwrap, o resultado demonstra,
//    deterministicamente, o que o sandbox permite/bloqueia — sem rede/credencial.
//
//  - A matriz roda por harness INSTALADO no sistema (opencode, claude, agy,
//    copilot, codex, cursor). Harness ausente = `test.skip` explícito (não
//    falha). Se bwrap não existir, o sandbox cai para "host" (sem isolamento)
//    e a prova não faz sentido → todo o spec pula.
//
// Riscos/limitações documentados (observados ao validar o sandbox):
//  1. Para o harness opencode, o env isolado (envOpencodeIsolado) monta
//     XDG_DATA_HOME em `~/.opencorp/opencode-data/...`. O bwrap CRIA os diretórios
//     pais dessa montagem como diretórios efêmeros (tmpfs) — logo um `echo >
//     ~/.opencorp/vazou.txt` DENTRO do sandbox "funciona", mas grava num tmpfs
//     que morre ao fim da execução e NUNCA chega ao host. O marcador
//     ISO_ESCRITA_HOME pode reportar "VAZOU" por isso; a garantia real é o
//     checksum do host (nenhum arquivo aparece no disco). Tratamos isso com
//     asserção no nível do host (não no marcador in-sandbox).
//  2. Harnesses não-opencode (claude/agy/copilot/codex/cursor) herdam o env do
//     processo (`...process.env`) e NÃO isolam XDG; se o usuário tiver
//     XDG_CONFIG_HOME/etc. apontando para caminhos reais, o SandboxDriver monta
//     esses caminhos rw (loop de XDG_* em execution-driver.ts). Isso não afeta o
//     isolamento ENTRE workspaces, mas é um risco de vazamento para o home real
//     do usuário nesses harnesses. Documentado, não corrigido (fora do escopo).
//  3. O `isInstalled`/`checkHealth` de cada driver executa o binário do harness
//     com `--version` DIRETO no host (fora do sandbox). Para harnesses reais isso
//     é inócuo (só imprime a versão), mas é o motivo pelo qual o runner fake
//     deste spec precisa ignorar `--version` (senão ele "vazaria" no host e daria
//     falso positivo). É também um lembrete de que o binário do harness roda
//     confiado no host durante as sondas.

const AGENTE = "iso-agente";

const AGENTE_MD = `---
id: ${AGENTE}
role: Operário
category: operario
model: openrouter/auto
tools: [read, write, edit, bash, registry]
permissions: level-2
budget:
  daily_usd: 1.00
  max_turns: 40
memory:
  reads: [execucoes]
  writes: [execucoes]
---

Agente usado apenas na prova de isolamento entre workspaces (F6-T02).
`;

// Matriz de harnesses. `engine` é o id canônico passado a SessionManager.rodar;
// `deteccao` são os nomes de binário consultados via `which` (espelha o
// fallback de cada driver em src/core/engines/drivers/); `fake` é o nome do
// bin gerenciado em `~/.opencorp/bin/` que o driver/session-manager resolve.
const CASOS: ReadonlyArray<{ engine: string; rotulo: string; deteccao: string[]; fake: string }> = [
  { engine: "opencode", rotulo: "opencode", deteccao: ["opencode"], fake: "opencode" },
  { engine: "claude-code", rotulo: "claude", deteccao: ["claude"], fake: "claude" },
  { engine: "antigravity", rotulo: "agy", deteccao: ["agy"], fake: "agy" },
  { engine: "copilot", rotulo: "copilot", deteccao: ["copilot"], fake: "copilot" },
  { engine: "codex", rotulo: "codex", deteccao: ["codex"], fake: "codex" },
  // O driver cursor procura o binário "agent" (Cursor Agent CLI), não "cursor".
  { engine: "cursor", rotulo: "cursor", deteccao: ["agent", "cursor-agent", "cursor"], fake: "cursor-agent" },
];

function binarioNoPath(...nomes: string[]): string | null {
  for (const n of nomes) {
    try {
      const p = execFileSync("which", [n], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch {
      /* tenta o próximo nome */
    }
  }
  return null;
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function montarFakeRunner(wsA: string, wsB: string, isoHome: string): string {
  return `#!/bin/sh
# Os drivers chamam <binario> --version (isInstalled/checkHealth) FORA do
# sandbox, no host. Se o fake fizesse efeito colateral aí, o teste daria um
# falso positivo de vazamento. Sondas de versão respondem e saem sem efeito.
case " $* " in
  *" --version "*|*" version "*|*" -v "*) echo "fake 1.0.0"; exit 0 ;;
esac
echo "ISO_CWD:$(pwd)"
if echo "vazou" > ${shQuote(`${wsB}/vazou-iso.txt`)} 2>/dev/null; then echo "ISO_ESCRITA_B:VAZOU"; else echo "ISO_ESCRITA_B:BLOQUEADA"; fi
if cat ${shQuote(`${wsB}/segredo-b.txt`)} >/dev/null 2>&1; then echo "ISO_LEITURA_B:VAZOU"; else echo "ISO_LEITURA_B:BLOQUEADA"; fi
if echo "vazou" > ${shQuote(`${isoHome}/.opencorp/vazou-home.txt`)} 2>/dev/null; then echo "ISO_ESCRITA_HOME:VAZOU"; else echo "ISO_ESCRITA_HOME:BLOQUEADA"; fi
if cat ${shQuote(`${wsA}/segredo-a.txt`)} >/dev/null 2>&1; then echo "ISO_LEITURA_A:OK"; else echo "ISO_LEITURA_A:FALHOU"; fi
if echo "escrito" > ${shQuote(`${wsA}/escrita-a.txt`)} 2>/dev/null; then echo "ISO_ESCRITA_A:OK"; else echo "ISO_ESCRITA_A:FALHOU"; fi
exit 0
`;
}

test.describe.serial("F6-T02 — Prova de isolamento entre workspaces", () => {
  let isoHome: string;
  let wsA: string;
  let wsB: string;
  let bwrapDisponivel: boolean;

  test.beforeAll(async () => {
    // /var/tmp (e NÃO /tmp): o SandboxDriver monta `--tmpfs /tmp`, o que
    // esconderia um OPENCORP_HOME sob /tmp. Fora de /tmp o bind do workspace
    // A e do binário sobrevive à montagem do tmpfs.
    isoHome = await mkdtemp("/var/tmp/opencorp-iso-");
    wsA = join(isoHome, ".opencorp", "workspaces", "iso-a");
    wsB = join(isoHome, ".opencorp", "workspaces", "iso-b");
    bwrapDisponivel = binarioNoPath("bwrap") !== null;

    await mkdir(join(wsA, ".opencorp", "agents"), { recursive: true });
    await mkdir(join(wsB, ".opencorp"), { recursive: true });
    await mkdir(join(isoHome, ".opencorp", "bin"), { recursive: true });
    await writeFile(join(wsA, ".opencorp", "config.json"), "{}");
    await writeFile(join(wsB, ".opencorp", "config.json"), "{}");
    await writeFile(join(wsA, ".opencorp", "agents", `${AGENTE}.md`), AGENTE_MD);
  });

  test.afterAll(async () => {
    await rm(isoHome, { recursive: true, force: true }).catch(() => undefined);
  });

  for (const caso of CASOS) {
    test(`isola A do B e do home global — harness ${caso.rotulo}`, async () => {
      test.skip(!bwrapDisponivel, "bwrap não disponível — sandbox inativo, prova de isolamento sem efeito");
      const instalado = binarioNoPath(...caso.deteccao);
      test.skip(!instalado, `harness "${caso.rotulo}" não detectado no PATH do sistema (procurado: ${caso.deteccao.join(", ")})`);

      // Sentinela único por execução: B não pode mudar, A deve ser legível/gravável.
      const segredoB = `segredo-b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const segredoA = `segredo-a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      await writeFile(join(wsA, "segredo-a.txt"), segredoA);
      await writeFile(join(wsB, "segredo-b.txt"), segredoB);
      // Remove resíduos de execuções anteriores (serial, mesmo wsB/wsA).
      await rm(join(wsB, "vazou-iso.txt"), { force: true }).catch(() => undefined);
      await rm(join(isoHome, ".opencorp", "vazou-home.txt"), { force: true }).catch(() => undefined);
      await rm(join(wsA, "escrita-a.txt"), { force: true }).catch(() => undefined);

      const fakePath = join(isoHome, ".opencorp", "bin", caso.fake);
      // O resolvedor procura todos os aliases do harness no PATH (ex.: cursor usa `agent`):
      // o fake precisa sombrear cada um deles.
      const nomesFake = [...new Set([caso.fake, ...caso.deteccao])];
      for (const nome of nomesFake) {
        const caminho = join(isoHome, ".opencorp", "bin", nome);
        await writeFile(caminho, montarFakeRunner(wsA, wsB, isoHome), "utf8");
        await chmod(caminho, 0o755);
      }

      // PATH vem antes da instalação gerenciada na resolução do binário: sem isto o harness real
      // do PC venceria o fake.
      const pathOriginal = process.env.PATH;
      process.env.PATH = `${dirname(fakePath)}:${pathOriginal ?? ""}`;
      try {
        const sm = new SessionManager({ homeDir: isoHome });
        const resultado = await sm.rodar({
          agente: AGENTE,
          ordem: `prova de isolamento (harness ${caso.rotulo})`,
          engine: caso.engine,
          workspaceDir: wsA,
          pularGuard: true,
        });

        expect(resultado.status, `execução deveria concluir, mas: ${resultado.captura}`).toBe("concluido");
        const captura = resultado.captura;

        // (a) cwd da execução é a pasta de A.
        expect(captura).toContain(`ISO_CWD:${wsA}`);

        // (c) tentativa de criar arquivo em B por caminho absoluto falha/bloqueia.
        expect(captura).toContain("ISO_ESCRITA_B:BLOQUEADA");
        // (c, leitura) tentativa de ler o sentinela de B também é bloqueada.
        expect(captura).toContain("ISO_LEITURA_B:BLOQUEADA");

        // A é o próprio workspace: legível e gravável (sanity do sandbox).
        expect(captura).toContain("ISO_LEITURA_A:OK");
        expect(captura).toContain("ISO_ESCRITA_A:OK");

        // (b) arquivo criado em B antes da execução permanece intacto.
        expect(await readFile(join(wsB, "segredo-b.txt"), "utf8")).toBe(segredoB);

        // Nenhum vazamento no nível do host (B e home global intocados).
        expect(existsSync(join(wsB, "vazou-iso.txt")), "vazou-iso.txt não deveria existir em B").toBe(false);
        expect(existsSync(join(isoHome, ".opencorp", "vazou-home.txt")), "vazou-home.txt não deveria existir no home global").toBe(false);
        // Sanity: a escrita em A efetivamente aconteceu no host.
        expect(existsSync(join(wsA, "escrita-a.txt"))).toBe(true);
      } finally {
        process.env.PATH = pathOriginal;
        for (const nome of nomesFake) {
          await rm(join(isoHome, ".opencorp", "bin", nome), { force: true }).catch(() => undefined);
        }
      }
    });
  }
});
