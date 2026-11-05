import type { Command } from "commander";
import { opencorpHome } from "../../utils/paths.js";
import {
  gravarConfigProvedores,
  lerConfigProvedores,
  PREDEFINIDOS,
  resolverProvedorClaude,
  type ProvedorClaude,
  type TipoProvedor,
} from "../../core/engines/provedor-claude.js";
import { lerEstadoRotacao, limparBloqueiosVencidos } from "../../core/engines/rotacao-provedores.js";

function paresModelo(itens: string[] | undefined): Record<string, string> {
  const mapa: Record<string, string> = {};
  for (const item of itens ?? []) {
    const i = item.indexOf("=");
    if (i <= 0 || i === item.length - 1) throw new Error(`modelo inválido "${item}": use chave=valor (ex.: haiku=glm-5.2)`);
    mapa[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  return mapa;
}

/** `opencorp provedor`: de onde o motor claude-sdk tira autenticação e modelos (arquivo provedores.json). */
export function registerProvedorCommand(program: Command): void {
  const cmd = program.command("provedor").description("escolhe o provedor e os modelos do motor claude-sdk (assinatura, API ou endpoint compatível)");

  cmd
    .command("listar", { isDefault: true })
    .description("lista os provedores e mostra o ativo")
    .action(() => {
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      const ativo = process.env.OPENCORP_PROVEDOR?.trim() || config.ativo;
      for (const [id, p] of Object.entries(config.provedores)) {
        const modelos = Object.entries(p.modelos ?? {}).map(([k, v]) => `${k}=${v}`).join(", ");
        const chave = p.chave ? "chave no arquivo" : p.chaveEnv ? `chave em $${p.chaveEnv}` : "";
        console.log(`${id === ativo ? "*" : " "} ${id}  [${p.tipo}]${p.baseUrl ? ` ${p.baseUrl}` : ""}${chave ? ` · ${chave}` : ""}${modelos ? ` · ${modelos}` : ""}`);
      }
    });

  cmd
    .command("predefinidos")
    .description("lista provedores prontos (URL e modelos já preenchidos) para criar contas com um comando")
    .action(() => {
      for (const [id, p] of Object.entries(PREDEFINIDOS)) console.log(`${id}  ${p.nome}\n    URL: ${p.baseUrl}\n    chave/conta: ${p.onde}`);
    });

  cmd
    .command("conta <predefinido> <id>")
    .description("cadastra uma conta de um provedor predefinido (ex.: conta openrouter-free conta2 --chave sk-or-...)")
    .option("--chave <chave>", "chave da conta (gravada em provedores.json, permissão 600)")
    .option("--chave-env <variavel>", "variável de ambiente com a chave (preferível)")
    .action(async (predefinido: string, id: string, o: { chave?: string; chaveEnv?: string }) => {
      const pre = PREDEFINIDOS[predefinido];
      if (!pre) throw new Error(`predefinido "${predefinido}" não existe (veja: opencorp provedor predefinidos)`);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("id em kebab-case (ex.: conta2)");
      if (!o.chave && !o.chaveEnv) throw new Error(`informe --chave ou --chave-env (onde pegar: ${pre.onde})`);
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      const novo: ProvedorClaude = {
        tipo: "compativel",
        nome: `${pre.nome} — ${id}`,
        baseUrl: pre.baseUrl,
        modelos: { ...pre.modelos },
        ...(o.chave ? { chave: o.chave } : {}),
        ...(o.chaveEnv ? { chaveEnv: o.chaveEnv } : {}),
      };
      await gravarConfigProvedores(home, { ...config, provedores: { ...config.provedores, [id]: novo } });
      console.log(`conta "${id}" cadastrada (${predefinido}). Para entrar no rodízio: opencorp provedor pool <pool> --membros ${id},...`);
    });

  cmd
    .command("pool <id>")
    .description("cria um pool: as contas em --membros se revezam quando uma esgota a cota")
    .requiredOption("--membros <lista>", "ids das contas separados por vírgula, na ordem de preferência")
    .action(async (id: string, o: { membros: string }) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("id em kebab-case (ex.: free-pool)");
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      const membros = o.membros.split(",").map((m) => m.trim()).filter(Boolean);
      for (const m of membros) {
        const p = config.provedores[m];
        if (!p) throw new Error(`membro "${m}" não existe (veja: opencorp provedor listar)`);
        if (p.tipo !== "compativel" && p.tipo !== "api") throw new Error(`membro "${m}" é ${p.tipo}; pool aceita só compativel ou api`);
      }
      await gravarConfigProvedores(home, { ...config, provedores: { ...config.provedores, [id]: { tipo: "pool", nome: `Pool ${id}`, membros } } });
      console.log(`pool "${id}" com ${membros.length} conta(s): ${membros.join(" → ")}. Ative com: opencorp provedor usar ${id}`);
    });

  cmd
    .command("rotacao")
    .description("mostra o estado do rodízio: quem está em cooldown, até quando e quantas chamadas cada conta fez")
    .option("--limpar", "apaga os cooldowns (use se a cota já voltou antes do horário previsto)")
    .action(async (o: { limpar?: boolean }) => {
      const home = opencorpHome();
      const { gravarEstadoRotacao } = await import("../../core/engines/rotacao-provedores.js");
      const estado = lerEstadoRotacao(home);
      if (o.limpar) {
        estado.bloqueios = {};
        gravarEstadoRotacao(home, estado);
        console.log("cooldowns apagados");
        return;
      }
      limparBloqueiosVencidos(estado, new Date());
      const ids = new Set([...Object.keys(estado.usos), ...Object.keys(estado.bloqueios)]);
      if (ids.size === 0) console.log("nenhuma chamada de pool registrada ainda");
      for (const id of ids) {
        const b = estado.bloqueios[id];
        console.log(`${id.padEnd(24)} usos ${String(estado.usos[id] ?? 0).padStart(5)}  ${b ? `BLOQUEADO até ${b.ate} (${b.motivo})` : "livre"}`);
      }
    });

  cmd
    .command("usar <id>")
    .description("ativa um provedor (vale para os próximos agentes e conversas; reinicie o daemon se ele guardar o ambiente)")
    .action(async (id: string) => {
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      if (!config.provedores[id]) throw new Error(`provedor "${id}" não existe (veja: opencorp provedor listar)`);
      resolverProvedorClaude(home, { ...process.env, OPENCORP_PROVEDOR: id }); // falha cedo se faltar chave/URL
      await gravarConfigProvedores(home, { ...config, ativo: id });
      console.log(`provedor ativo: ${id}`);
    });

  cmd
    .command("adicionar <id>")
    .description("cria ou atualiza um provedor")
    .requiredOption("--tipo <tipo>", "assinatura | api | compativel")
    .option("--nome <nome>", "nome de exibição")
    .option("--config-dir <pasta>", "assinatura: pasta de login de outra conta do Claude Code (ex.: ~/.claude-conta2)")
    .option("--base-url <url>", "URL base (compativel)")
    .option("--chave-env <variavel>", "variável de ambiente com a chave")
    .option("--chave <chave>", "chave gravada em provedores.json (permissão 600); prefira --chave-env")
    .option("--modelo <par...>", "tradução de modelo chave=valor (haiku=..., sonnet=..., opus=..., padrao=...)")
    .action(async (id: string, o: { tipo: string; nome?: string; configDir?: string; baseUrl?: string; chaveEnv?: string; chave?: string; modelo?: string[] }) => {
      if (!["assinatura", "api", "compativel"].includes(o.tipo)) throw new Error("tipo deve ser assinatura, api ou compativel");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("id em kebab-case (ex.: openrouter)");
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      const modelos = paresModelo(o.modelo);
      const novo: ProvedorClaude = {
        tipo: o.tipo as TipoProvedor,
        ...(o.nome ? { nome: o.nome } : {}),
        ...(o.configDir ? { configDir: o.configDir } : {}),
        ...(o.baseUrl ? { baseUrl: o.baseUrl } : {}),
        ...(o.chaveEnv ? { chaveEnv: o.chaveEnv } : {}),
        ...(o.chave ? { chave: o.chave } : {}),
        ...(Object.keys(modelos).length ? { modelos } : {}),
      };
      await gravarConfigProvedores(home, { ...config, provedores: { ...config.provedores, [id]: novo } });
      console.log(`provedor "${id}" gravado. Ative com: opencorp provedor usar ${id}`);
    });

  cmd
    .command("modelo <id> <chave> <valor>")
    .description("muda a tradução de um modelo do provedor (ex.: provedor modelo openrouter haiku z-ai/glm-5.2)")
    .action(async (id: string, chave: string, valor: string) => {
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      const p = config.provedores[id];
      if (!p) throw new Error(`provedor "${id}" não existe`);
      p.modelos = { ...(p.modelos ?? {}), [chave]: valor };
      await gravarConfigProvedores(home, config);
      console.log(`${id}: ${chave} → ${valor}`);
    });

  cmd
    .command("remover <id>")
    .description("remove um provedor (a assinatura não pode ser removida)")
    .action(async (id: string) => {
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      if (id === "assinatura") throw new Error('o provedor "assinatura" é o padrão e não pode ser removido');
      delete config.provedores[id];
      await gravarConfigProvedores(home, { ...config, ativo: config.ativo === id ? "assinatura" : config.ativo });
      console.log(`provedor "${id}" removido`);
    });
}
