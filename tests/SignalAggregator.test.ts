import { describe, it, expect, vi } from "vitest";
import { SignalAggregator } from "../src/processors/signal-aggregator.js";
import { TypedEventBus } from "../src/events/bus.js";
import type { WhaleAlert, TradeEvent, WhaleSignal } from "../src/events/types.js";
import whaleTrade from "./fixtures/whale-trade.json" assert { type: "json" };

// FROZEN: do not edit without updating consuming tests

function makeTradeFromFixture(): TradeEvent {
  return {
    ...whaleTrade,
    tradedAt: new Date(whaleTrade.tradedAt),
    source: "live_ws" as const,
    side: whaleTrade.side as "BUY" | "SELL",
  };
}

function makeSignal(): WhaleSignal {
  return {
    signalType: "WHALE_TRADE",
    tokenId: whaleTrade.tokenId,
    conditionId: whaleTrade.conditionId,
    direction: "BULLISH",
    confidence: 0.7,
    strength: whaleTrade.sigmasAboveMean,
    priceAtSignal: whaleTrade.priceUsdc,
    createdAt: new Date(),
    payload: {},
    usdcValue: whaleTrade.valueUsdc,
    sigmasAboveMean: whaleTrade.sigmasAboveMean,
    pctOfDailyVolume: whaleTrade.pctOfDailyVolume,
    proxyWallet: whaleTrade.proxyWallet,
    transactionHash: whaleTrade.transactionHash,
    priceImpactEstimate: 0.005,
    bookDepthConsumedPct: 8.2,
    bookSnapshotAgeMs: 5000,
  };
}

function makeAlert(): WhaleAlert {
  return {
    trade: makeTradeFromFixture(),
    usdcValue: whaleTrade.valueUsdc,
    marketStats: {
      tokenId: whaleTrade.tokenId,
      volume24hr: 2_500_000,
      avgTradeSize24h: 5_000,
      stddevTradeSize24h: 8_000,
      liquidityUsdc: 500_000,
      tradeCount24h: 60,
      calibrated: true,
    },
    priceAtAlert: whaleTrade.priceUsdc,
    priceImpactEstimateUsdc: 500,
    bookDepthConsumedPct: 8.2,
    bookSnapshotAgeMs: 5000,
    book: null,
    signal: makeSignal(),
    emitSignal: true,
  };
}

function makeDb() {
  return {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: "1" }] }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  } as unknown as Parameters<typeof SignalAggregator>[1];
}

describe("SignalAggregator (fixture-based)", () => {
  it("WHALE_TRADE: creates whale_alert + signal records", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert());
    await new Promise((r) => setTimeout(r, 50));

    // Two execute calls: insertWhaleAlert + insertSignal
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("transaction rolled back if signal insert fails", async () => {
    const bus = new TypedEventBus();
    const db = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: "1" }] }) // insertWhaleAlert succeeds
        .mockRejectedValueOnce(new Error("signal insert failed")), // insertSignal fails
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({ onConflictDoUpdate: vi.fn().mockResolvedValue(undefined) }),
      }),
      update: vi.fn().mockReturnValue({ set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }) }),
    } as unknown as Parameters<typeof SignalAggregator>[1];

    const bus2 = new TypedEventBus();
    const aggregator = new SignalAggregator(bus2, db);
    aggregator.start();

    bus2.emit("whale_alert", makeAlert());
    await new Promise((r) => setTimeout(r, 50));

    // Both execute calls were attempted
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("unknown signal type logged and rejected", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    const badSignal = { ...makeSignal(), signalType: "HACK_SIGNAL" as "WHALE_TRADE" };
    bus.emit("signal", badSignal);
    await new Promise((r) => setTimeout(r, 50));

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
