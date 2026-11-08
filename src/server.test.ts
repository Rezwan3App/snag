import { describe, expect, test, afterAll } from "bun:test";
import { existsSync, rmSync } from "fs";

// Env must be set before server.ts is imported (SMS_CONFIGURED is read at load).
// The db singleton is shared with scanner.test.ts, which cleans up at exit.
process.env.SNAG_DB_PATH ??= `./snag.shared.test.${process.pid}.db`;
process.env.ADMIN_TOKEN = "s3cret";
const { default: server } = await import("./server");

const { db } = await import("./db");
afterAll(() => {
  db.close();
  const p = process.env.SNAG_DB_PATH!;
  for (const f of [p, `${p}-wal`, `${p}-shm`]) if (existsSync(f)) rmSync(f);
});

const call = (method: string, auth?: string) =>
  server.fetch(new Request("http://localhost/api/sms", { method, headers: { Origin: "http://localhost", ...(auth ? { Authorization: auth } : {}) } }));

describe("admin token", () => {
  test("GET passes and reports adminRequired", async () => {
    const res = await call("GET");
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).adminRequired).toBe(true);
  });

  test("non-GET without or with a wrong token is a JSON 401", async () => {
    for (const auth of [undefined, "Bearer nope", "garbage"]) {
      const res = await call("DELETE", auth);
      expect(res.status).toBe(401);
      expect(typeof ((await res.json()) as any).error).toBe("string");
    }
  });

  test("non-GET with the right token goes through", async () => {
    expect((await call("DELETE", "Bearer s3cret")).status).toBe(200);
  });
});
