/**
 * CLI do `opencode` falso usado pelo servidor do E2E (via PATH).
 * Suporta `--version` e `serve --port <n> --hostname 127.0.0.1`, com a senha
 * em OPENCODE_SERVER_PASSWORD, como o binário real.
 */
import { startFakeOpenCode } from "../../fixtures/fake-opencode-server.js";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("1.18.32");
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
