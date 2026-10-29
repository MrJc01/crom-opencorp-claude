import type { Command } from "commander";
import { opencorpHome } from "../../utils/paths.js";
import {
  gravarConfigProvedores,
  lerConfigProvedores,
  resolverProvedorClaude,
  type ProvedorClaude,
  type TipoProvedor,
} from "../../core/engines/provedor-claude.js";

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
    .option("--base-url <url>", "URL base (compativel)")
    .option("--chave-env <variavel>", "variável de ambiente com a chave")
    .option("--chave <chave>", "chave gravada em provedores.json (permissão 600); prefira --chave-env")
    .option("--modelo <par...>", "tradução de modelo chave=valor (haiku=..., sonnet=..., opus=..., padrao=...)")
    .action(async (id: string, o: { tipo: string; nome?: string; baseUrl?: string; chaveEnv?: string; chave?: string; modelo?: string[] }) => {
      if (!["assinatura", "api", "compativel"].includes(o.tipo)) throw new Error("tipo deve ser assinatura, api ou compativel");
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error("id em kebab-case (ex.: openrouter)");
      const home = opencorpHome();
      const config = lerConfigProvedores(home);
      const modelos = paresModelo(o.modelo);
      const novo: ProvedorClaude = {
        tipo: o.tipo as TipoProvedor,
        ...(o.nome ? { nome: o.nome } : {}),
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
