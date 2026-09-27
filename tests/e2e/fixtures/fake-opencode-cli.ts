/**
 * CLI do `opencode` falso usado pelo servidor do E2E (via PATH).
 * Suporta `--version`, `run` (one-shot) e `serve --port <n> --hostname 127.0.0.1`, com a senha
 * em OPENCODE_SERVER_PASSWORD, como o binário real.
 */
import { startFakeOpenCode } from "../../fixtures/fake-opencode-server.js";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.18.32");
  process.exit(0);
}
if (args[0] === "run") {
  // Execução one-shot (nós de agente dos fluxos): responde e sai com sucesso.
  const semFlags: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i]!.startsWith("--")) {
      if (!["--auto"].includes(args[i]!)) i++;
      continue;
    }
    semFlags.push(args[i]!);
  }
  const prompt = semFlags.join(" ").trim();
  // Contratos dos nós de equipe (review/debate): respeita o formato exigido.
  const contrato = prompt.includes("[contrato de revisão]")
    ? "APROVADO\n"
    : prompt.includes("[contrato de moderação]")
      ? "DECISÃO: seguir a proposta A\n"
      : "";
  if (args.includes("--format") && args[args.indexOf("--format") + 1] === "json") {
    console.log(JSON.stringify({ type: "text", part: { type: "text", text: `${contrato}Resposta do assistant para: ${prompt}` } }));
  } else {
    console.log(`${contrato}Resposta do assistant para: ${prompt}`);
  }
  process.exit(0);
}
if (args[0] !== "serve") {
  console.error(`fake opencode: comando não suportado: ${args.join(" ")}`);
  process.exit(2);
}
const port = Number(args[args.indexOf("--port") + 1]);
if (!Number.isInteger(port) || port <= 0) {
  console.error("fake opencode: --port obrigatório");
  process.exit(2);
}
const fake = await startFakeOpenCode(
  port,
  process.env.OPENCODE_SERVER_PASSWORD ?? "",
  "Resposta do assistant para: ",
  // Pergunta com opções numeradas: a UI renderiza botões de escolha rápida.
  (text) => (/teste pergunta/i.test(text) ? "Qual ambiente você deseja implantar?\n1. Produção\n2. Staging\n3. Desenvolvimento" : undefined),
);
const stop = () => void fake.close().finally(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
