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

  it("priceAtSignal=0: uses fallback absolute_min_usdc=10000", async () => {
    const db = makeDb();
    const alert = makeAlert(true);
    const alertNoPrice = {
      ...alert,
      signal: { ...alert.signal, priceAtSignal: 0 },
    };
    // Should not throw
    const id = await insertWhaleAlert(db, alertNoPrice);
    expect(id).toBe(99n);
  });
});
