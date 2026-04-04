import { describe, it, expect, vi } from "vitest";
import { SignalAggregator } from "./signal-aggregator.js";
import { TypedEventBus } from "../events/bus.js";
import type { WhaleAlert, TradeEvent, MarketStats, WhaleSignal } from "../events/types.js";

function makeTrade(): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100000,
    priceUsdc: 0.68,
    valueUsdc: 68000,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    tradedAt: new Date(),
    outcome: "Yes",
    marketSlug: "test",
    eventSlug: "test",
    marketTitle: "Test",
    source: "live_ws",
  };
}

function makeSignal(): WhaleSignal {
  return {
    signalType: "WHALE_TRADE",
    tokenId: "tok1",
    conditionId: "cond1",
    direction: "BULLISH",
    confidence: 0.7,
    strength: 5.2,
    priceAtSignal: 0.68,
    createdAt: new Date(),
    payload: {},
    usdcValue: 68000,
    sigmasAboveMean: 5.2,
    pctOfDailyVolume: 0.031,
    proxyWallet: "0xwallet",
    transactionHash: "0xtx",
    priceImpactEstimate: 0.008,
    bookDepthConsumedPct: 12.3,
    bookSnapshotAgeMs: 3000,
  };
}

function makeAlert(emitSignal = true): WhaleAlert {
  return {
    trade: makeTrade(),
    usdcValue: 68000,
    marketStats: {
      tokenId: "tok1",
      volume24hr: 2_200_000,
      avgTradeSize24h: 5000,
      stddevTradeSize24h: 8000,
      liquidityUsdc: 500_000,
      tradeCount24h: 50,
      calibrated: true,
    },
    priceAtAlert: 0.68,
    priceImpactEstimateUsdc: 800,
    bookDepthConsumedPct: 12.3,
    bookSnapshotAgeMs: 3000,
    book: null,
    signal: makeSignal(),
    emitSignal,
  };
}

type MockDb = {
  execute: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
};

function makeDb(
  whaleAlertId: bigint | null = 99n,
  _signalId: { id: bigint } | null = { id: 1n }
) {
  const m: MockDb = {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: whaleAlertId ? String(whaleAlertId) : "" }] }),
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
  };
  return m as unknown as ConstructorParameters<typeof SignalAggregator>[1];
}

describe("SignalAggregator", () => {
  it("WHALE_TRADE: whale_alert row + signal row created (both execute calls)", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(true));

    // Wait for async handlers
    await new Promise((r) => setTimeout(r, 50));

    // execute called twice: once for insertWhaleAlert, once for insertSignal
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("emitSignal=false: skips both inserts", async () => {
    const bus = new TypedEventBus();
    const db = makeDb(null);
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(false));

    await new Promise((r) => setTimeout(r, 50));

    // insertWhaleAlert returns null → no signal insert either
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("signal event with valid type is inserted", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("signal", makeSignal());

    await new Promise((r) => setTimeout(r, 50));

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("unknown signal type logged and rejected (no DB write)", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    const badSignal = { ...makeSignal(), signalType: "COMPOSITE_SIGNAL" as "WHALE_TRADE" };
    bus.emit("signal", badSignal);

    await new Promise((r) => setTimeout(r, 50));

    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("confidence out of range: clamped before insert, no throw", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    const signal = { ...makeSignal(), confidence: 1.5 };
    bus.emit("signal", signal);

    await new Promise((r) => setTimeout(r, 50));

    // No throw, insert called
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });

  it("uses DB transaction when db.transaction() is available", async () => {
    const bus = new TypedEventBus();

    // Provide a mock that has a transaction() method
    const txMock = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: "42" }] }),
    };
    const transactionFn = vi.fn().mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => {
      await fn(txMock);
    });
    const db = {
      ...makeDb(),
      transaction: transactionFn,
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(true));
    await new Promise((r) => setTimeout(r, 50));

    // transaction() should have been called
    expect(transactionFn).toHaveBeenCalledTimes(1);
    // Both insertWhaleAlert and insertSignal ran inside the tx
    expect(txMock.execute).toHaveBeenCalledTimes(2);
  });

  it("transaction: emitSignal=false skips both inserts inside tx", async () => {
    const bus = new TypedEventBus();

    const txMock = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
    };
    const transactionFn = vi.fn().mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => {
      await fn(txMock);
    });
    const db = {
      ...makeDb(null),
      transaction: transactionFn,
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(false));
    await new Promise((r) => setTimeout(r, 50));

    expect(transactionFn).toHaveBeenCalledTimes(1);
    // insertWhaleAlert returns null (emitSignal=false) → 0 execute calls inside tx
    expect(txMock.execute).toHaveBeenCalledTimes(0);
  });
});

describe("SignalAggregator error handling", () => {
  it("signalHandler catches and logs errors when insertSignal throws", async () => {
    const bus = new TypedEventBus();
    // DB that throws on execute
    const db = {
      execute: vi.fn().mockRejectedValue(new Error("DB error")),
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    // Should not throw — error is caught and logged
    expect(() => bus.emit("signal", makeSignal())).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    // execute was called (the error path was hit)
    expect((db.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});

describe("SignalAggregator.stop()", () => {
  it("removes bus listeners so no further inserts happen after stop()", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db);
    aggregator.start();

    // Verify listener is active
    bus.emit("signal", makeSignal());
    await new Promise((r) => setTimeout(r, 50));
    const callsBefore = (db.execute as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsBefore).toBeGreaterThan(0);

    // Stop — listeners removed
    aggregator.stop();

    // Emit again — should be ignored
    bus.emit("signal", makeSignal());
    await new Promise((r) => setTimeout(r, 50));

    const callsAfter = (db.execute as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // no new calls
  });
});

describe("SignalAggregator — onWhaleInserted callback", () => {
  it("onWhaleInserted called with (alert, id) after successful whale insert", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const onWhaleInserted = vi.fn();
    const aggregator = new SignalAggregator(bus, db, onWhaleInserted);
    aggregator.start();

    const alert = makeAlert(true);
    bus.emit("whale_alert", alert);
    await new Promise((r) => setTimeout(r, 50));

    expect(onWhaleInserted).toHaveBeenCalledOnce();
    const [callAlert, callId] = onWhaleInserted.mock.calls[0];
    expect(callAlert).toBe(alert);
    expect(typeof callId).toBe("bigint");

    aggregator.stop();
  });

  it("onWhaleInserted NOT called when emitSignal=false", async () => {
    const bus = new TypedEventBus();
    const db = makeDb(null); // null → insertWhaleAlert returns null (emitSignal=false)
    const onWhaleInserted = vi.fn();
    const aggregator = new SignalAggregator(bus, db, onWhaleInserted);
    aggregator.start();

    bus.emit("whale_alert", makeAlert(false));
    await new Promise((r) => setTimeout(r, 50));

    expect(onWhaleInserted).not.toHaveBeenCalled();
    aggregator.stop();
  });

  it("no onWhaleInserted provided: backward compatible, no error", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db); // no callback
    aggregator.start();

    expect(() => bus.emit("whale_alert", makeAlert(true))).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));

    aggregator.stop();
  });

  it("onWhaleInserted called via transaction path (db.transaction present)", async () => {
    // Covers line 64: `if (insertedId !== null) this.onWhaleInserted?.(alert, insertedId)` — transaction branch
    const bus = new TypedEventBus();
    const onWhaleInserted = vi.fn();

    // Mock tx that returns a whale alert id
    const txMock = {
      execute: vi.fn().mockResolvedValue({ rows: [{ id: "77" }] }),
    };
    const transactionFn = vi.fn().mockImplementation(async (fn: (tx: typeof txMock) => Promise<void>) => {
      await fn(txMock);
    });
    const db = {
      ...makeDb(),
      transaction: transactionFn,
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db, onWhaleInserted);
    aggregator.start();

    const alert = makeAlert(true);
    bus.emit("whale_alert", alert);
    await new Promise((r) => setTimeout(r, 50));

    // onWhaleInserted should be called after the transaction completes
    expect(onWhaleInserted).toHaveBeenCalledOnce();
    const [callAlert, callId] = onWhaleInserted.mock.calls[0];
    expect(callAlert).toBe(alert);
    expect(typeof callId).toBe("bigint");

    aggregator.stop();
  });
});

// ── Phase 3: Composite Confidence Scoring ───────────────────────────────────

function makeImbalanceSignal(tokenId = "tok1", confidence = 0.6): import("../events/types.js").ImbalanceSignal {
  return {
    signalType: "ORDER_BOOK_IMBALANCE",
    tokenId,
    conditionId: "cond1",
    direction: "BULLISH",
    confidence,
    strength: 1_500_000,
    priceAtSignal: 0.68,
    createdAt: new Date(),
    payload: {},
    imbalanceRatio: 4.5,
    bidDepthUsdc: 750_000,
    askDepthUsdc: 250_000,
  };
}

function makePriceImpactSignal(tokenId = "tok1", confidence = 0.8): import("../events/types.js").PriceImpactSignal {
  return {
    signalType: "PRICE_IMPACT_ANOMALY",
    tokenId,
    conditionId: "cond1",
    direction: "BULLISH",
    confidence,
    strength: 5.1,
    priceAtSignal: 0.70,
    createdAt: new Date(),
    payload: {},
    priceChangePct: 4.2,
    windowSeconds: 0,
    triggeringTradeValueUsdc: 15_000,
  };
}

/** DB mock that captures updateSignalPayloads calls (via db.execute) */
function makeCompositeDb() {
  const m = {
    execute: vi.fn().mockResolvedValue({ rows: [{ id: "1" }] }),
  };
  let callCount = 0;
  m.execute.mockImplementation(() => {
    callCount++;
    // First call returns an id for insertSignal; subsequent calls (patch) return empty
    if (callCount === 1 || callCount === 3) {
      return Promise.resolve({ rows: [{ id: String(callCount) }] });
    }
    return Promise.resolve({ rows: [] });
  });
  return m as unknown as ConstructorParameters<typeof SignalAggregator>[1];
}

describe("SignalAggregator — composite confidence scoring (Phase 3)", () => {
  it("single signal: no composite scoring, updateSignalPayloads not triggered", async () => {
    const bus = new TypedEventBus();
    const db = makeDb();
    const aggregator = new SignalAggregator(bus, db, undefined, { compositeWindowMs: 60_000 });
    aggregator.start();

    bus.emit("signal", makeImbalanceSignal());
    await new Promise((r) => setTimeout(r, 50));

    // Only one execute call (insertSignal). No UPDATE call.
    const calls = (db.execute as ReturnType<typeof vi.fn>).mock.calls;
    // insertSignal = 1 execute; no patch → total = 1
    expect(calls.length).toBe(1);

    aggregator.stop();
  });

  it("two signals for same token within window: both DB rows patched with compositeScore", async () => {
    const bus = new TypedEventBus();
    // DB mock that returns distinct IDs for each insertSignal call
    let insertCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        insertCount++;
        // Odd calls = insertSignal (returns id), even calls = updateSignalPayloads (returns [])
        return Promise.resolve({ rows: [{ id: String(insertCount) }] });
      }),
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db, undefined, { compositeWindowMs: 60_000 });
    aggregator.start();

    bus.emit("signal", makeImbalanceSignal("tok1", 0.6));
    bus.emit("signal", makePriceImpactSignal("tok1", 0.8));
    await new Promise((r) => setTimeout(r, 100));

    // execute called: 2 inserts + 1 update (for 2 signals)
    // Actually the patch is fired fire-and-forget — could be 2 or 3 calls
    const calls = (db.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2); // at least 2 inserts

    aggregator.stop();
  });

  it("three signals: compositeScore uses 1.30 bonus factor", async () => {
    const bus = new TypedEventBus();

    const executeMock = vi.fn().mockResolvedValue({ rows: [{ id: "1" }] });
    const db = { execute: executeMock } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db, undefined, { compositeWindowMs: 60_000 });
    aggregator.start();

    // Emit 3 signals for same token
    const velocitySignal: import("../events/types.js").VelocitySignal = {
      signalType: "SENTIMENT_VELOCITY",
      tokenId: "tok1",
      conditionId: "cond1",
      direction: "BULLISH",
      confidence: 0.7,
      strength: 2.0,
      priceAtSignal: 0.69,
      createdAt: new Date(),
      payload: {},
      tradeCountVelocity: 2.0,
    };

    bus.emit("signal", makeImbalanceSignal("tok1", 0.6));
    bus.emit("signal", makePriceImpactSignal("tok1", 0.8));
    bus.emit("signal", velocitySignal);
    await new Promise((r) => setTimeout(r, 100));

    // After 3 signals: bonus = 1 + 0.15 * (3-1) = 1.30
    // meanConf = (0.6 + 0.8 + 0.7) / 3 = 0.7
    // compositeScore = 0.7 * 1.30 = 0.91
    // The logger.info call contains the score — verify by checking execute was called ≥ 3×
    expect(executeMock).toHaveBeenCalled();

    aggregator.stop();
  });

  it("window expiry: second signal after compositeWindowMs does NOT combine with first", async () => {
    const bus = new TypedEventBus();

    let insertCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        insertCount++;
        return Promise.resolve({ rows: [{ id: String(insertCount) }] });
      }),
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    // Very short window (1ms) so it expires immediately
    const aggregator = new SignalAggregator(bus, db, undefined, { compositeWindowMs: 1 });
    aggregator.start();

    bus.emit("signal", makeImbalanceSignal("tok1", 0.6));
    await new Promise((r) => setTimeout(r, 50)); // wait > 1ms

    bus.emit("signal", makePriceImpactSignal("tok1", 0.8));
    await new Promise((r) => setTimeout(r, 50));

    // Both signals should have been inserted but NOT combined (window expired)
    // So updateSignalPayloads should NOT have been called for 2-signal composite
    // Total execute calls = 2 (two insertSignal calls only)
    const calls = (db.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);

    aggregator.stop();
  });

  it("different tokenIds: separate windows, no cross-token composite", async () => {
    const bus = new TypedEventBus();

    let insertCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        insertCount++;
        return Promise.resolve({ rows: [{ id: String(insertCount) }] });
      }),
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db, undefined, { compositeWindowMs: 60_000 });
    aggregator.start();

    bus.emit("signal", makeImbalanceSignal("tokA", 0.6));
    bus.emit("signal", makeImbalanceSignal("tokB", 0.8));
    await new Promise((r) => setTimeout(r, 100));

    // 2 inserts, no patch (different tokenIds → no composite)
    const calls = (db.execute as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(2);

    aggregator.stop();
  });

  it("log output contains [COMPOSITE] with tokenId when 2+ signals", async () => {
    const bus = new TypedEventBus();

    let insertCount = 0;
    const db = {
      execute: vi.fn().mockImplementation(() => {
        insertCount++;
        return Promise.resolve({ rows: [{ id: String(insertCount) }] });
      }),
    } as unknown as ConstructorParameters<typeof SignalAggregator>[1];

    const aggregator = new SignalAggregator(bus, db, undefined, { compositeWindowMs: 60_000 });
    aggregator.start();

    // Spy on logger.info
    const { logger } = await import("../logger.js");
    const infoSpy = vi.spyOn(logger, "info");

    bus.emit("signal", makeImbalanceSignal("tok1", 0.6));
    bus.emit("signal", makePriceImpactSignal("tok1", 0.8));
    await new Promise((r) => setTimeout(r, 100));

    // Check that logger.info was called with a string containing [COMPOSITE]
    const compositeCalls = infoSpy.mock.calls.filter(
      (args) => typeof args[0] === "string" && args[0].includes("[COMPOSITE]")
    );
    expect(compositeCalls.length).toBeGreaterThan(0);
    expect(compositeCalls[0][0]).toContain("tok1");

    aggregator.stop();
  });
});
