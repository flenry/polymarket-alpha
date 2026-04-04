import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { envNumber } from "./config.js";

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

  it("databaseUrl is a string (possibly empty if not set)", async () => {
    const { config } = await import("./config.js");
    expect(typeof config.databaseUrl).toBe("string");
  });

  it("config object is frozen", async () => {
    const { config } = await import("./config.js");
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("Phase 2 fields have correct defaults", async () => {
    delete process.env.CLOB_WS_URL;
    delete process.env.CLOB_WS_MAX_RECONNECT_DELAY_MS;
    delete process.env.IMBALANCE_COOLDOWN_MS;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.WALLET_ENRICHMENT_TIMEOUT_MS;
    delete process.env.WALLET_ENRICHMENT_RATE_LIMIT_RPS;
    delete process.env.WALLET_ENRICHMENT_RECENCY_HOURS;
    const { config } = await import("./config.js");
    expect(config.clobWsUrl).toBe("wss://ws-subscriptions-clob.polymarket.com/ws/market");
    expect(config.clobWsMaxReconnectDelayMs).toBe(30_000);
    expect(config.imbalanceCooldownMs).toBe(60_000);
    expect(config.discordWebhookUrl).toBe("");
    expect(config.slackWebhookUrl).toBe("");
    expect(config.walletEnrichmentTimeoutMs).toBe(5_000);
    expect(config.walletEnrichmentRateLimitRps).toBe(2);
    expect(config.walletEnrichmentRecencyHours).toBe(24);
  });

});

describe("envNumber", () => {
  it("returns defaultVal when env var is not set", () => {
    delete process.env.TEST_NUMERIC_VAR_XYZ;
    expect(envNumber("TEST_NUMERIC_VAR_XYZ", 42)).toBe(42);
  });

  it("returns parsed number when env var is a valid number", () => {
    process.env.TEST_NUMERIC_VAR_XYZ = "99";
    expect(envNumber("TEST_NUMERIC_VAR_XYZ", 0)).toBe(99);
    delete process.env.TEST_NUMERIC_VAR_XYZ;
  });

  it("throws when env var is set to a non-numeric string (isNaN branch)", () => {
    process.env.TEST_NUMERIC_VAR_XYZ = "not-a-number";
    expect(() => envNumber("TEST_NUMERIC_VAR_XYZ", 0)).toThrow(
      "Environment variable TEST_NUMERIC_VAR_XYZ must be a number"
    );
    delete process.env.TEST_NUMERIC_VAR_XYZ;
  });
});
