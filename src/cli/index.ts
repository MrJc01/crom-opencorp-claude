import { Command, CommanderError } from "commander";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerAgentCommand } from "./commands/agent.js";
import { registerSkillCommand } from "./commands/skill.js";
import { registerAssetCommand } from "./commands/asset.js";
import { registerPromptCommand } from "./commands/prompt.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerRunCommand } from "./commands/run.js";
import { registerSessionCommand } from "./commands/session.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerRegistryCommand } from "./commands/registry.js";
import { registerApprovalsCommand } from "./commands/approvals.js";
import { registerBudgetCommand } from "./commands/budget.js";
import { registerMeetingCommand } from "./commands/meeting.js";
import { registerSubcorpCommand } from "./commands/subcorp.js";
import { registerFlowCommand } from "./commands/flow.js";
import { registerComponentCommand } from "./commands/component.js";
import { registerTaskCommand } from "./commands/task.js";
import { registerScheduleCommands } from "./commands/schedule.js";
import { registerHookCommands } from "./commands/hook.js";
import { registerToolCommands } from "./commands/tool.js";
import { registerAppCommand } from "./commands/app.js";
import { registerTeamCommand } from "./commands/team.js";
import { registerSupervisorCommand } from "./commands/supervisor.js";
import { registerDaemonCommand } from "./commands/daemon.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerWebCommand } from "./commands/web.js";
import { registerTemplateCommand } from "./commands/template.js";
import { registerWorkspaceCommands } from "./commands/workspace.js";
import { registerOpenCommand } from "./commands/open.js";
import { registerTestCommand } from "./commands/test.js";
import { registerMonitorCommand } from "./commands/monitor.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerContextCommand } from "./commands/context.js";
import { registerHistoricoCommand } from "./commands/historico.js";
import { registerSecretarioCommand } from "./commands/secretario.js";
import { registerSaudeCommand } from "./commands/saude.js";
import { registerRelatorioCommand } from "./commands/relatorio.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerSecretsCommand } from "./commands/secrets.js";
import { registerTokensCommand } from "./commands/tokens.js";
import { registerMotoresCommand } from "./commands/motores.js";
import { registerModelosCommand } from "./commands/modelos.js";
import { registerProvedorCommand } from "./commands/provedor.js";
import { registerMigrateConfigsCommand } from "./commands/migrate-configs.js";
import { notImplementedAction } from "./placeholder.js";
import { instalarTriggers, pendentesTriggers } from "../core/contexts/scheduling/trigger-runner.js";
import { instalarMencoes, pendentesMencoes } from "../core/contexts/meetings/mention-runner.js";

export { obterConfiguracaoServidor, cliFetch, CliHttpError, type ServerConfig, type ClientOptions } from "./client.js";

const require = createRequire(import.meta.url);

export function resolveVersion(): string {
  try {
    const pkg = require("../../package.json") as { version?: string };
    return typeof pkg?.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function isModoOc(argv: string[] = process.argv): boolean {
  if (process.env.OPENCORP_CLI_MODE === "oc") return true;
  const invocado = argv[1] || "";
  const nome = invocado.split("/").pop() ?? "";
  return nome === "oc" || nome.startsWith("oc.") || nome.startsWith("oc-");
}

export function buildProgram(isOc: boolean = isModoOc()): Command {
  const program = new Command();
  if (isOc) {
    program
      .name("oc")
      .description(
        "oc — CLI Operacional de Workspaces da OpenCorp (tarefas, agentes, rotinas, apps e governança local)",
      )
      .version(resolveVersion(), "--version", "imprime a versão do oc")
      .helpOption("-h, --help", "mostra a ajuda do comando")
      .option("-t, --target <id>", "workspace alvo da operação (padrão: auto-detectado pelo diretório atual)")
      .option("-w, --workspace <id>", "alias para --target");
  } else {
    program
      .name("opencorp")
      .description(
        "OpenCorp — Sistema Operacional de Empresas Autônomas (governança, daemons e infraestrutura global)",
      )
      .version(resolveVersion(), "--version", "imprime a versão do opencorp")
      .helpOption("-h, --help", "mostra a ajuda do comando")
      .option("-t, --target <id>", "workspace alvo para comandos de workspace (alias: -w, --workspace)")
      .option("-w, --workspace <id>", "workspace alvo da operação");
  }

  program.hook("preAction", (thisCommand) => {
    const opts = thisCommand.opts<{ target?: string; workspace?: string }>();
    const alvo = opts.target || opts.workspace;
    if (alvo && alvo.trim()) {
      process.env.OPENCORP_WORKSPACE = alvo.trim();
      process.env.OPENCORP_ACTIVE_WS = alvo.trim();
    }
  });

  // Comandos de Workspace (disponíveis tanto em oc quanto em opencorp)
  registerTaskCommand(program);
  registerWorkspaceCommands(program);
  registerAgentCommand(program);
  registerSkillCommand(program);
  registerAssetCommand(program);
  registerPromptCommand(program);
  registerScheduleCommands(program);
  registerAppCommand(program);
  registerFlowCommand(program);
  registerComponentCommand(program);
  registerSecretsCommand(program);
  registerTokensCommand(program);
  registerMotoresCommand(program);
  registerModelosCommand(program);
  registerProvedorCommand(program);
  registerMigrateConfigsCommand(program);
  registerStatusCommand(program);
  registerContextCommand(program);
  registerHistoricoCommand(program);
  registerSecretarioCommand(program);
  registerSaudeCommand(program);
  registerRelatorioCommand(program);
  registerLogsCommand(program);
  registerRegistryCommand(program);
  registerBudgetCommand(program);
  registerApprovalsCommand(program);
  registerMeetingCommand(program);
  registerTeamCommand(program);
  registerHookCommands(program);
  registerToolCommands(program);
  registerMonitorCommand(program);
  registerTestCommand(program);
  registerOpenCommand(program);
  registerRunCommand(program);
  registerSessionCommand(program);
  registerSupervisorCommand(program);

  if (isOc) {
    // No modo "oc", comandos de infraestrutura global exibem erro educativo e explicativo
    const comandosGlobaisBloqueados = [
      {
        cmd: "daemon",
        desc: "supervisor do sistema operacional (systemd / daemons)",
        dica: 'Para gerenciar daemons ou serviços do host, use: "opencorp daemon ..."',
      },
      {
        cmd: "serve",
        desc: "servidor HTTP da API global e web-dist",
        dica: 'O servidor atende a todos os workspaces em segundo plano. Para subir manualmente, use: "opencorp serve ..."',
      },
      {
        cmd: "init",
        desc: "inicialização global da plataforma",
        dica: 'Para inicializar um repositório como plataforma, use: "opencorp init ..."',
      },
    ];

    for (const { cmd, desc, dica } of comandosGlobaisBloqueados) {
      program
        .command(`${cmd} [args...]`)
        .description(`(Infraestrutura Global) ${desc}`)
        .allowUnknownOption()
        .allowExcessArguments(true)
        .helpOption(false)
        .action(() => {
          console.error(`\x1b[31merro:\x1b[0m o comando "${cmd}" é de infraestrutura global da plataforma.`);
          console.error(`O CLI "oc" é restrito ao contexto operacional de workspaces.`);
          console.error(`\x1b[36m${dica}\x1b[0m\n`);
          process.exit(1);
        });
    }
  } else {
    // No modo "opencorp", registra comandos de infraestrutura e governança da plataforma
    program
      .command("init")
      .argument("[dir]", "diretório alvo (padrão: .)")
      .description("prepara um repositório: estrutura, settings global e template default")
      .action(notImplementedAction("opencorp init"));

    registerSettingsCommand(program);
    registerTemplateCommand(program);
    registerSubcorpCommand(program);
    registerDaemonCommand(program);
    registerServeCommand(program);
    registerWebCommand(program);

    const cloud = program.command("cloud").description("backup/sync (opcional)");
    cloud
      .command("configure")
      .description("wizard de perfis (backup-local | backup-nuvem | mirror-remoto)")
      .action(notImplementedAction("opencorp cloud configure"));
    cloud
      .command("backup")
      .description("executa o backup agora")
      .action(notImplementedAction("opencorp cloud backup"));
    cloud
      .command("sync")
      .option("--dry-run", "simula sem alterar nada")
      .description("sincroniza os alvos do perfil")
      .action(notImplementedAction("opencorp cloud sync"));
    cloud
      .command("status")
      .description("último backup, diffs pendentes, saúde dos remotos")
      .action(notImplementedAction("opencorp cloud status"));

    registerDoctorCommand(program);
  }

  return program;
}

function primeiraCitacao(mensagem: string): string | undefined {
  const m = /'([^']+)'/.exec(mensagem);
  return m?.[1];
}

function handleCommanderError(err: CommanderError, isOc: boolean = isModoOc()): void {
  const binName = isOc ? "oc" : "opencorp";
  switch (err.code) {
    case "commander.version":
    case "commander.helpDisplayed":
    case "commander.help":
      process.exitCode = err.exitCode;
      return;
    case "commander.unknownCommand": {
      console.error(`Dica: rode "${binName} --help" para listar os comandos disponíveis.`);
      process.exitCode = 1;
      return;
    }
    case "commander.unknownOption": {
      console.error(`Dica: use "${binName} <comando> --help" para ver as opções válidas.`);
      process.exitCode = 1;
      return;
    }
    case "commander.missingArgument":
    case "commander.missingMandatoryParameterValue": {
      const nome = primeiraCitacao(err.message);
      console.error(
        `erro: argumento obrigatório ausente${nome ? ` (${nome})` : ""} — use "${binName} <comando> --help" para ver o uso.`,
      );
      process.exitCode = 1;
      return;
    }
    default: {
      console.error(`Dica: rode "${binName} --help" para ajuda.`);
      process.exitCode = err.exitCode || 1;
    }
  }
}

export async function main(argv: string[] = process.argv): Promise<void> {
  instalarTriggers();
  instalarMencoes();
  const isOc = isModoOc(argv);
  const program = buildProgram(isOc);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    await Promise.allSettled([...pendentesTriggers(), ...pendentesMencoes()]);
  } catch (err) {
    if (err instanceof CommanderError) {
      handleCommanderError(err, isOc);
      return;
    }
    console.error(`erro inesperado: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const invocadoDireto =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invocadoDireto) {
  await main(process.argv);
}
