import { rm, mkdir, writeFile, cp } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const E2E_HOME = "/dev/shm/opencorp-e2e";

export default async function globalSetup(): Promise<void> {
  await rm(E2E_HOME, { recursive: true, force: true });
  await mkdir(E2E_HOME, { recursive: true });
  await mkdir(join(E2E_HOME, "logs"), { recursive: true });
  await mkdir(join(E2E_HOME, "workspaces"), { recursive: true });

  const templatesAgents = join(__dirname, "..", "..", "templates", "default", ".opencorp", "agents");
  const ytAgents = join(__dirname, "..", "..", "templates", "youtube-video-factory", ".opencorp", "agents");

  // Diretórios canônicos dos workspaces (raiz padrão do WorkspaceManager)
  const dotWsDir = join(E2E_HOME, ".opencorp", "workspaces");
  await mkdir(dotWsDir, { recursive: true });

  const wsDir = join(dotWsDir, "e2e-corp");
  await mkdir(wsDir, { recursive: true });
  await mkdir(join(wsDir, ".opencorp"), { recursive: true });
  await writeFile(join(wsDir, ".opencorp", "config.json"), "{}");
  await cp(templatesAgents, join(wsDir, ".opencorp", "agents"), { recursive: true }).catch(() => {});
  await cp(ytAgents, join(wsDir, ".opencorp", "agents"), { recursive: true }).catch(() => {});

  // Pre-cria times e apps para que o seeder não crie arquivos untracked no Git
  const teamSpec = {
    id: "e2e-pipe",
    titulo: "Pipe E2E",
    padrao: "pipeline",
    passos: [
      { agente: "a", ordem: "x" },
      { agente: "b", ordem: "y" },
    ],
    criado_em: new Date().toISOString(),
  };
  await mkdir(join(wsDir, ".opencorp", "teams"), { recursive: true });
  await writeFile(join(wsDir, ".opencorp", "teams", "e2e-pipe.json"), JSON.stringify(teamSpec, null, 2));
  await mkdir(join(wsDir, ".opencorp", "apps"), { recursive: true });

  // Inicializar Git no workspace e2e-corp para testes de git slash commands
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: wsDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "E2E Agent"], { cwd: wsDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "e2e@opencorp.local"], { cwd: wsDir, stdio: "ignore" });
    // Cria arquivo de seed que pode ser modificado nos testes de diff/restore
    await writeFile(join(wsDir, "teste-git.txt"), "conteudo original do arquivo\n");
    // .gitignore do workspace e2e: ignora TODOS os artefatos de runtime para que
    // os testes de git (/git status limpo) sejam herméticos mesmo com a suíte
    // inteira criando flows, registros, notificações, reuniões e tasks.
    const gitignoreContent = `*.db\n*.db-wal\n*.db-shm\n.opencorp/*.db\nlogs/\n*.log\n*.jsonl\n.opencorp/events.jsonl\n.opencorp/logs/\n.opencorp/cron/\nnode_modules/\n.venv/\n__pycache__/\n*.pyc\n.opencorp/sessions/\n.opencorp/approvals/*.json\n.opencorp/tokens.json\n.opencode\n.opencorp/opencode/\n.opencorp/opencode-data/\n.opencorp/teams/\n.opencorp/apps/\n.opencorp/flows/\n.opencorp/registries/\n.opencorp/notifications.json\n*.tmp-*\n.opencorp/.*.tmp-*\n.opencorp/scheduler*.db*\n.opencorp/worktrees/\n`;
    await writeFile(join(wsDir, ".gitignore"), gitignoreContent);
    execFileSync("git", ["add", "-A"], { cwd: wsDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "feat(workspace): seed inicial para testes e2e"], { cwd: wsDir, stdio: "ignore" });
  } catch (err) {
    console.warn("Git init para e2e-corp falhou (git pode não estar instalado):", err);
  }

  // Criar workspace outro-ws para testes de alternância
  const wsDir2 = join(dotWsDir, "outro-ws");
  await mkdir(wsDir2, { recursive: true });
  await mkdir(join(wsDir2, ".opencorp"), { recursive: true });
  await writeFile(join(wsDir2, ".opencorp", "config.json"), "{}");
  await cp(templatesAgents, join(wsDir2, ".opencorp", "agents"), { recursive: true }).catch(() => {});
  await cp(ytAgents, join(wsDir2, ".opencorp", "agents"), { recursive: true }).catch(() => {});

  // Compatibilidade com testes que acessam E2E_HOME/workspaces/* diretamente
  const legacyWs1 = join(E2E_HOME, "workspaces", "e2e-corp");
  const legacyWs2 = join(E2E_HOME, "workspaces", "outro-ws");
  await cp(wsDir, legacyWs1, { recursive: true }).catch(() => {});
  await cp(wsDir2, legacyWs2, { recursive: true }).catch(() => {});

  // Registrar workspaces no arquivo de workspaces ativos
  const workspacesConfig = {
    version: 1,
    ativo: "e2e-corp",
    workspaces: [
      { id: "e2e-corp", criado_em: new Date().toISOString(), path: wsDir },
      { id: "outro-ws", criado_em: new Date().toISOString(), path: wsDir2 },
    ],
  };
  await mkdir(join(E2E_HOME, ".opencorp"), { recursive: true });
  await writeFile(join(E2E_HOME, ".opencorp", "workspaces.json"), JSON.stringify(workspacesConfig, null, 2));
  // Execução direta no host: o driver padrão (systemd-run) não existe em
  // contêineres de CI e fazia todo nó de agente falhar com "Failed to connect to bus".
  await writeFile(join(E2E_HOME, ".opencorp", "settings.json"), JSON.stringify({ execution_driver: "host" }, null, 2));
  await writeFile(join(E2E_HOME, ".opencorp", "config.json"), JSON.stringify({ execution_driver: "host" }, null, 2));
}