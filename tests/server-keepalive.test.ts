import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiServer } from "../src/server/index.js";

describe("servidor HTTP: keep-alive", () => {
  let home: string;
  let server: ReturnType<typeof createApiServer>["server"];

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "opencorp-keepalive-"));
    ({ server } = createApiServer({ homeDir: home, cwd: home, token: "t" } as never));
  });
  afterAll(async () => {
    server.close();
    await rm(home, { recursive: true, force: true });
  });

  it("mantém conexões ociosas por mais que os 5 s do Node (evita ECONNRESET em clientes que reaproveitam o socket)", () => {
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(60_000);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });
});
