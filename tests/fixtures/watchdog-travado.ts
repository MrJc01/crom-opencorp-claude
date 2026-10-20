// Processo filho dos testes do watchdog: arma o watchdog e trava o event loop de propósito.
import { createServer } from "node:http";
import { iniciarWatchdog, vigiarServidor } from "../../src/server/event-loop-watchdog.js";

const home = process.argv[2]!;
const modo = process.argv[3] ?? "travar";
const limiteMs = Number(process.argv[4] ?? 2000);

if (modo === "servidor") {
  const server = createServer((_req, res) => res.end("ok"));
  vigiarServidor(server, { home, limiteMs });
  server.listen(0, "127.0.0.1", () => {
    console.log(`porta:${(server.address() as { port: number }).port}`);
  });
} else {
  const h = iniciarWatchdog({ home, limiteMs });
  if (!h) {
    console.log("desligado");
    process.exit(0);
  }
  console.log("armado");
  setTimeout(() => {
    // eslint-disable-next-line no-constant-condition
    if (modo === "travar") while (true) { /* trava o event loop */ }
    // pausa curta, abaixo do limite: não deve disparar
    const fim = Date.now() + limiteMs / 2;
    while (Date.now() < fim) { /* ocupado */ }
    setTimeout(() => process.exit(0), limiteMs * 2);
  }, 1500);
}
