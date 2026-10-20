/**
 * Binário `openheinerss` falso do E2E: `version` e `serve --stdio` (JSON-RPC/NDJSON), reaproveitando o
 * servidor em memória dos testes unitários (tests/fixtures/fake-openheinerss.ts). Vocabulário dos prompts:
 * "permissão" pede aprovação e só segue após `session.permission_respond`.
 */
import { createFakeOpenheinerss } from "../../fixtures/fake-openheinerss.js";

const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("openheinerss 0.0.0-e2e");
  process.exit(0);
}
if (args[0] !== "serve") {
  console.error(`fake openheinerss: comando não suportado: ${args.join(" ")}`);
  process.exit(2);
}

const fake = createFakeOpenheinerss();
fake.stdout.on("data", (chunk: Buffer) => process.stdout.write(chunk));
process.stdin.on("data", (chunk: Buffer) => fake.write(chunk.toString("utf8")));
const encerrar = () => { fake.kill(); process.exit(0); };
process.stdin.on("end", encerrar);
process.on("SIGTERM", encerrar);
process.on("SIGINT", encerrar);
