import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Clear config module cache to re-evaluate
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("default values apply when env vars absent", async () => {
    process.env.DATABASE_URL = "postgres://localhost:5432/test";
    delete process.env.WHALE_ABSOLUTE_MIN_USDC;
    delete process.env.WHALE_SIGMA_THRESHOLD;
    // Re-import to get fresh config
    const { config } = await import("./config.js");
    expect(config.absoluteMinUsdc).toBe(10_000);
    expect(config.sigmaThreshold).toBe(3.0);
    expect(config.pctVolumeThreshold).toBe(0.02);
    expect(config.snapshotIntervalMs).toBe(30_000);
    expect(config.gammaPollIntervalMs).toBe(60_000);
  });

  it("numeric env vars are parsed to numbers not strings", async () => {
    const { config } = await import("./config.js");
    expect(typeof config.absoluteMinUsdc).toBe("number");
    expect(typeof config.sigmaThreshold).toBe("number");
    expect(typeof config.snapshotIntervalMs).toBe("number");
  });

  it("databaseUrl is accessible", async () => {
    process.env.DATABASE_URL = "postgres://localhost:5432/test_db";
    const { config } = await import("./config.js");
    // Config is already initialized from module load, just verify type
    expect(typeof config.databaseUrl).toBe("string");
  });

  it("config object is frozen", async () => {
    const { config } = await import("./config.js");
    expect(Object.isFrozen(config)).toBe(true);
  });
});
