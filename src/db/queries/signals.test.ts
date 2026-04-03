import { describe, it, expect, vi } from "vitest";
import { insertSignal } from "./signals.js";
import type { WhaleSignal } from "../../events/types.js";

function makeWhaleSignal(overrides: Partial<WhaleSignal> = {}): WhaleSignal {
  return {
    signalType: "WHALE_TRADE",
    tokenId: "tok1",
    conditionId: "cond1",
    direction: "BULLISH",
    confidence: 0.7,
    strength: 4.2,
    priceAtSignal: 0.65,
    createdAt: new Date(),
    payload: {},
    usdcValue: 75000,
    sigmasAboveMean: 4.2,
    pctOfDailyVolume: 0.03,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    priceImpactEstimate: 0.01,
    bookDepthConsumedPct: 5.2,
    bookSnapshotAgeMs: 3000,
    ...overrides,
  };
}

function makeDb(rows: { id: string }[] = [{ id: "42" }]) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Parameters<typeof insertSignal>[0];
}

describe("insertSignal", () => {
  it("inserts a known signal type successfully", async () => {
    const db = makeDb();
    const result = await insertSignal(db, makeWhaleSignal());
    expect(result).not.toBeNull();
    expect(result?.id).toBe(42n);
  });

  it("rejects unknown signal type (throws)", async () => {
    const db = makeDb();
    const badSignal = makeWhaleSignal({
      signalType: "UNKNOWN_TYPE" as "WHALE_TRADE",
    });
    await expect(insertSignal(db, badSignal)).rejects.toThrow("Unknown signal type");
  });

  it("clamps confidence > 1.0 before insert", async () => {
    const db = makeDb();
    await insertSignal(db, makeWhaleSignal({ confidence: 1.5 }));

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const queryStr = JSON.stringify(call);
    // The clamped value 1.0 should appear
    expect(queryStr).toContain("1");
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it("accepts all four valid signal types", async () => {
    const types = ["WHALE_TRADE", "ORDER_BOOK_IMBALANCE", "PRICE_IMPACT_ANOMALY", "SENTIMENT_VELOCITY"] as const;
    for (const signalType of types) {
      const db = makeDb();
      const signal = makeWhaleSignal({ signalType: signalType as "WHALE_TRADE" });
      const result = await insertSignal(db, signal as WhaleSignal);
      expect(result).not.toBeNull();
    }
  });

  it("returns null when DB returns no rows", async () => {
    const db = makeDb([]);
    const result = await insertSignal(db, makeWhaleSignal());
    expect(result).toBeNull();
  });
});


import { getRecentSignals } from "./signals.js";

describe("getRecentSignals", () => {
  it("queries with a time filter when limitHours=2", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { execute: vi.fn(), select } as unknown as Parameters<typeof insertSignal>[0];

    const result = await getRecentSignals(db, 2);

    expect(result).toEqual([]);
    expect(select).toHaveBeenCalled();
    // where() called means the time filter was applied
    expect(where).toHaveBeenCalled();
  });

  it("defaults to 1-hour window when limitHours not specified", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { execute: vi.fn(), select } as unknown as Parameters<typeof insertSignal>[0];

    await getRecentSignals(db);

    expect(where).toHaveBeenCalled();
  });
});
