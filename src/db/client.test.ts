import { describe, it, expect, vi, beforeEach } from "vitest";

describe("db client", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
  });

  it("closeDb resolves when pool is null (no-op)", async () => {
    // We can't easily test the real pool without a DB connection,
    // but we can verify the module loads and closeDb is exported
    const { closeDb } = await import("./client.js");
    // closeDb on an unused pool should be safe
    await expect(closeDb()).resolves.toBeUndefined();
  });

  it("closeDb is a function", async () => {
    const { closeDb } = await import("./client.js");
    expect(typeof closeDb).toBe("function");
  });

  it("db export is defined", async () => {
    const { db } = await import("./client.js");
    expect(db).toBeDefined();
  });
});
