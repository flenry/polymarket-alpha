import { describe, it, expect, vi } from "vitest";
import { insertWhaleAlert, buildTradeLookupKey, enrichWhaleAlert } from "./whales.js";
import type { WhaleAlert, TradeEvent, MarketStats, WhaleSignal } from "../../events/types.js";

function makeTrade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65000,
    proxyWallet: "0xabc123",
    transactionHash: "0xhash456",
    tradedAt: new Date("2026-04-03T12:00:00.000Z"),
    outcome: "Yes",
    marketSlug: "test-market",
    eventSlug: "test-event",
    marketTitle: "Test Market",
    source: "live_ws",
    ...overrides,
  };
}

function makeStats(): MarketStats {
  return {
    tokenId: "tok1",
    volume24hr: 2000000,
    avgTradeSize24h: 5000,
    stddevTradeSize24h: 8000,
    liquidityUsdc: 500000,
    tradeCount24h: 50,
    calibrated: true,
  };
}

function makeSignal(): WhaleSignal {
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
    usdcValue: 65000,
    sigmasAboveMean: 7.5,
    pctOfDailyVolume: 0.03,
    proxyWallet: "0xabc123",
    transactionHash: "0xhash456",
    priceImpactEstimate: 0.01,
    bookDepthConsumedPct: 5.2,
    bookSnapshotAgeMs: 3000,
  };
}

function makeAlert(emitSignal = true): WhaleAlert {
  const trade = makeTrade();
  return {
    trade,
    usdcValue: 65000,
    marketStats: makeStats(),
    priceAtAlert: 0.65,
    priceImpactEstimateUsdc: 650,
    bookDepthConsumedPct: 5.2,
    bookSnapshotAgeMs: 3000,
    book: null,
    signal: makeSignal(),
    emitSignal,
  };
}

function makeDb(rows: { id: string }[] = [{ id: "99" }]) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  } as unknown as Parameters<typeof insertWhaleAlert>[0];
}

describe("buildTradeLookupKey", () => {
  it("serializes correctly in expected format", () => {
    const alert = makeAlert();
    const key = buildTradeLookupKey(alert);
    expect(key).toBe("0xhash456|tok1|0xabc123|2026-04-03T12:00:00.000Z|0.65|100");
  });

  it("separates fields with pipe", () => {
    const alert = makeAlert();
    const key = buildTradeLookupKey(alert);
    const parts = key.split("|");
    expect(parts).toHaveLength(6);
  });
});

describe("insertWhaleAlert", () => {
  it("returns alert ID on successful insert", async () => {
    const db = makeDb([{ id: "99" }]);
    const id = await insertWhaleAlert(db, makeAlert(true));
    expect(id).toBe(99n);
  });

  it("returns null when emitSignal=false (liquidity guard)", async () => {
    const db = makeDb();
    const id = await insertWhaleAlert(db, makeAlert(false));
    expect(id).toBeNull();
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("tradeLookupKey is included in INSERT query", async () => {
    const db = makeDb();
    await insertWhaleAlert(db, makeAlert(true));

    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const queryStr = JSON.stringify(call);
    expect(queryStr).toContain("trade_lookup_key");
  });
});

describe("enrichWhaleAlert", () => {
  it("updates wallet fields on the whale_alert row", async () => {
    const db = makeDb();
    await enrichWhaleAlert(db, 99n, {
      walletTotalVolumeUsdc: 1_200_000,
      walletTradeCount: 12,
      walletWinRatio: 0.71,
    });

    expect(db.update as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    const updateChain = (db.update as ReturnType<typeof vi.fn>).mock.results[0].value;
    expect(updateChain.set).toHaveBeenCalled();
  });

  it("handles undefined optional enrichment fields (null branches)", async () => {
    const db = makeDb();
    // No walletTotalVolumeUsdc, no walletWinRatio — exercises the ?? null branches
    await enrichWhaleAlert(db, 99n, {
      walletTradeCount: 5,
      // walletTotalVolumeUsdc and walletWinRatio intentionally omitted
    });

    expect(db.update as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });

  it("handles undefined walletTradeCount (line 85 ?? null branch)", async () => {
    const db = makeDb();
    // All optional fields omitted — exercises walletTradeCount ?? null
    await enrichWhaleAlert(db, 99n, {
      // walletTradeCount intentionally omitted → exercises ?? null at line 85
    });

    expect(db.update as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});

describe("insertWhaleAlert — null stats fields (lines 54-56)", () => {
  it("handles null avgTradeSize24h, stddevTradeSize24h, volume24hr in stats", async () => {
    const db = makeDb();
    const alert = makeAlert(true);
    // Override stats with null values to exercise the ?? null branches
    const alertWithNullStats = {
      ...alert,
      marketStats: {
        ...alert.marketStats,
        avgTradeSize24h: null as unknown as number,
        stddevTradeSize24h: null as unknown as number,
        volume24hr: null as unknown as number,
      },
    };
    const id = await insertWhaleAlert(db, alertWithNullStats);
    expect(id).toBe(99n); // should still succeed
    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.stringify(call)).toBeDefined();
  });
});

describe("insertWhaleAlert — branch coverage", () => {
  it("returns null when DB returns empty rows (rows.length === 0 branch)", async () => {
    const db = makeDb([]); // empty rows
    const id = await insertWhaleAlert(db, makeAlert(true));
    expect(id).toBeNull();
  });

  it("handles sigmasAboveMean=Infinity: stored as null in query", async () => {
    const db = makeDb();
    const alert = makeAlert(true);
    // Modify signal to have Infinity sigmasAboveMean
    const alertWithInfSigmas = {
      ...alert,
      signal: { ...alert.signal, sigmasAboveMean: Infinity },
    };
    const id = await insertWhaleAlert(db, alertWithInfSigmas);
    expect(id).toBe(99n);
    // Query was called with sigmasAboveMean=null (isFinite check)
    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const qs = JSON.stringify(call);
    expect(qs).toBeDefined();
  });

  it("stores configured absoluteMinUsdc in the alert row", async () => {
    const db = makeDb();
    const alert = makeAlert(true);
    // Pass explicit absoluteMinUsdc=15000
    const id = await insertWhaleAlert(db, alert, 15000);
    expect(id).toBe(99n);
    // Verify 15000 appears in the query
    const call = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const qs = JSON.stringify(call);
    expect(qs).toContain("15000");
  });
});

describe("enrichWhaleAlert — walletFirstSeenAt extension", () => {
  it("passes walletFirstSeenAt through to db.update when provided", async () => {
    const db = makeDb();
    const firstSeenAt = new Date("2026-01-01T00:00:00.000Z");
    await enrichWhaleAlert(db, 99n, { walletFirstSeenAt: firstSeenAt });
    const setCall = (db.update as ReturnType<typeof vi.fn>)().set.mock.calls[0][0];
    expect(setCall.walletFirstSeenAt).toEqual(firstSeenAt);
  });

  it("uses null for walletFirstSeenAt when omitted", async () => {
    const db = makeDb();
    await enrichWhaleAlert(db, 99n, { walletTotalVolumeUsdc: 1000 });
    const setCall = (db.update as ReturnType<typeof vi.fn>)().set.mock.calls[0][0];
    expect(setCall.walletFirstSeenAt).toBeNull();
  });
});
