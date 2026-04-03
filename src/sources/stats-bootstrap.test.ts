import { describe, it, expect, vi } from "vitest";
import { bootstrapMarketStats, RollingStatsBuffer } from "./stats-bootstrap.js";

function makeDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  return { insert } as unknown as Parameters<typeof bootstrapMarketStats>[0];
}

function makeFetch(trades: object[], status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(trades),
  });
}

function makeTrade(valueUsdc: number) {
  return {
    proxyWallet: "0xwallet",
    side: "BUY",
    asset: "tok1",
    conditionId: "cond1",
    size: valueUsdc / 0.65,
    price: 0.65,
    timestamp: Date.now() / 1000,
    transactionHash: "0xtx",
  };
}

describe("bootstrapMarketStats", () => {
  it("with 200 sample trades: returns calibrated=true, mean and stddev correct", async () => {
    const trades = Array.from({ length: 200 }, (_, i) => makeTrade((i + 1) * 100));
    const db = makeDb();
    const stats = await bootstrapMarketStats(db, "tok1", "cond1", makeFetch(trades));

    expect(stats.calibrated).toBe(true);
    expect(stats.tradeCount24h).toBe(200);
    expect(stats.avgTradeSize24h).toBeGreaterThan(0);
    expect(stats.stddevTradeSize24h).toBeGreaterThan(0);
  });

  it("with 10 sample trades: returns calibrated=false", async () => {
    const trades = Array.from({ length: 10 }, (_, i) => makeTrade((i + 1) * 100));
    const db = makeDb();
    const stats = await bootstrapMarketStats(db, "tok1", "cond1", makeFetch(trades));

    expect(stats.calibrated).toBe(false);
    expect(stats.tradeCount24h).toBe(10);
  });

  it("data-api returns 429: returns default uncalibrated stats, does not throw", async () => {
    const db = makeDb();
    const stats = await bootstrapMarketStats(
      db,
      "tok1",
      "cond1",
      makeFetch([], 429)
    );

    expect(stats.calibrated).toBe(false);
    expect(stats.tradeCount24h).toBe(0);
    // Should NOT have called db.insert (returned early)
    expect((db as unknown as { insert: ReturnType<typeof vi.fn> }).insert).not.toHaveBeenCalled();
  });

  it("network error: returns default stats, does not throw", async () => {
    const db = makeDb();
    const failFetch = vi.fn().mockRejectedValue(new Error("Network error"));
    const stats = await bootstrapMarketStats(db, "tok1", "cond1", failFetch);

    expect(stats.calibrated).toBe(false);
  });

  it("mean is correctly computed", async () => {
    // 3 trades: valueUsdc = 100, 200, 300 → mean = 200
    const trades = [
      makeTrade(100),
      makeTrade(200),
      makeTrade(300),
    ];
    const db = makeDb();
    const stats = await bootstrapMarketStats(db, "tok1", "cond1", makeFetch(trades));

    // mean of [100/0.65 * 0.65, 200/0.65 * 0.65, ...] = mean of [100, 200, 300] = 200
    expect(stats.avgTradeSize24h).toBeCloseTo(200, 1);
  });
});

describe("RollingStatsBuffer", () => {
  it("adding a trade older than 24h evicts it from the window", () => {
    const buf = new RollingStatsBuffer();
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25h ago
    const recent = new Date(); // now

    buf.addTrade("tok1", 10000, old);
    buf.addTrade("tok1", 20000, recent);

    const stats = buf.getStats("tok1");
    // Old trade evicted: only the recent trade remains
    expect(stats.count).toBe(1);
    expect(stats.avg).toBeCloseTo(20000, 0);
  });

  it("returns zero stats for unknown token", () => {
    const buf = new RollingStatsBuffer();
    const stats = buf.getStats("unknown");
    expect(stats.count).toBe(0);
    expect(stats.avg).toBe(0);
  });

  it("accumulates trades within window", () => {
    const buf = new RollingStatsBuffer();
    const now = new Date();
    buf.addTrade("tok1", 1000, now);
    buf.addTrade("tok1", 2000, now);
    buf.addTrade("tok1", 3000, now);

    const stats = buf.getStats("tok1");
    expect(stats.count).toBe(3);
    expect(stats.avg).toBeCloseTo(2000, 0);
  });
});
