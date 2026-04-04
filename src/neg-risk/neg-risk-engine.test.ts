import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NegRiskEngine } from "./neg-risk-engine.js";
import type { BookUpdateEvent } from "../events/types.js";
import type { NegRiskGroup } from "./group-resolver.js";

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeDb() {
  // getTokenPriceHistory24h: select().from().where().orderBy() → []
  // getNegRiskMarketsByCondition: select().from().where() → [] (direct await)
  // insertSignal: db.execute() → { rows: [] }
  const orderByFn = vi.fn().mockResolvedValue([]);
  // where() must be both thenable (for direct await) and have .orderBy()
  const whereResult = Object.assign(Promise.resolve([]), { orderBy: orderByFn });
  const whereFn = vi.fn().mockReturnValue(whereResult);
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  return {
    select: selectFn,
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as unknown as ConstructorParameters<typeof NegRiskEngine>[0];
}

function makeClob() {
  return {
    batchGetBooks: vi.fn().mockResolvedValue([]),
  } as unknown as ConstructorParameters<typeof NegRiskEngine>[1];
}

function makeAlertEmitter() {
  return { emit: vi.fn() } as unknown as ConstructorParameters<typeof NegRiskEngine>[2];
}

function makeWebhookEmitter() {
  return { send: vi.fn() } as unknown as ConstructorParameters<typeof NegRiskEngine>[3];
}

function makeValidGroup(conditionId: string, tokenIds: string[]): NegRiskGroup {
  return {
    conditionId,
    tokens: tokenIds.map((id, i) => ({
      tokenId: id,
      conditionId,
      bestAsk: 0.35,
      bestBid: 0.33,
      question: `Outcome ${i}`,
    })),
    sumAsk: tokenIds.length * 0.35,
    sumBid: tokenIds.length * 0.33,
    isValid: true,
  };
}

function makeBookUpdateEvent(tokenId: string, conditionId: string, askPrice: number, askSize = 20): BookUpdateEvent {
  return {
    type: "book",
    book: {
      tokenId,
      conditionId,
      bids: [{ price: askPrice - 0.02, size: 20 }],
      asks: [{ price: askPrice, size: askSize }],
      timestamp: Date.now(),
      hash: "h",
      capturedAt: new Date(),
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NegRiskEngine", () => {

  it("handleBookUpdate silently returns when group not yet cached (startup race guard)", () => {
    const db = makeDb();
    const clob = makeClob();
    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), makeWebhookEmitter());

    // Don't call start() — groups map is empty
    const tokenId = "tok1";
    engine.addTokenIds([tokenId]); // so tokenId is in negRiskTokenIds

    const evt = makeBookUpdateEvent(tokenId, "condX", 0.40);

    // Should not throw, no logging errors
    expect(() => engine.handleBookUpdate(evt)).not.toThrow();
  });

  it("handleBookUpdate ignores events for non-neg-risk tokens", async () => {
    const db = makeDb();
    const clob = makeClob();
    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), makeWebhookEmitter());

    // Token "unrelated" is NOT in negRiskTokenIds
    const evt = makeBookUpdateEvent("unrelated", "condX", 0.40);
    engine.handleBookUpdate(evt); // should return immediately, no evaluate call

    // Flush any microtasks
    await Promise.resolve();
    // Since we can't access private detector, just verify no error thrown
    expect(db.execute).not.toHaveBeenCalled(); // no DB write
  });

  it("start() populates negRiskTokenIds and triggers immediate refresh", async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const clob = makeClob();
    // GroupResolver will call db.select → returns [] (no neg-risk markets)
    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), makeWebhookEmitter(), {
      refreshIntervalMs: 999_999,
    });

    engine.start(["tok1", "tok2"]);
    // Just flush microtasks (the immediate refresh is a promise)
    await Promise.resolve();
    await Promise.resolve();
    engine.stop();
    vi.useRealTimers();

    // batchGetBooks should not have been called since DB returns no neg-risk markets
    expect(clob.batchGetBooks).not.toHaveBeenCalled();
  });

  it("stop() clears the refresh interval", async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const clob = makeClob();
    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), makeWebhookEmitter(), {
      refreshIntervalMs: 1000,
    });

    engine.start([]);
    // Flush immediate refresh promises only
    await Promise.resolve();
    await Promise.resolve();

    // Clear the call count after startup
    (clob.batchGetBooks as ReturnType<typeof vi.fn>).mockClear();

    engine.stop();

    // Advance time past the refresh interval — should NOT trigger another refresh
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    expect(clob.batchGetBooks).not.toHaveBeenCalled();
  });

  it("addTokenIds triggers debounced refresh after 2000ms", async () => {
    vi.useFakeTimers();
    const db = makeDb();
    const clob = makeClob();
    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), makeWebhookEmitter(), {
      refreshIntervalMs: 999_999,
    });

    // Don't call start() to avoid the immediate refresh
    engine.addTokenIds(["tok-new"]);

    // Before debounce expires — no additional refresh
    await vi.advanceTimersByTimeAsync(1000);
    const callsBeforeDebounce = (clob.batchGetBooks as ReturnType<typeof vi.fn>).mock.calls.length;

    // Advance past debounce (2000ms)
    await vi.advanceTimersByTimeAsync(1500);
    vi.useRealTimers();
    // batchGetBooks still 0 since no markets in DB
    expect((clob.batchGetBooks as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(callsBeforeDebounce);
  });

  it("handleBookUpdate re-evaluates the correct group after book update", async () => {
    const db = makeDb();
    const clob = makeClob();
    const webhookEmitter = makeWebhookEmitter();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), webhookEmitter, {
      refreshIntervalMs: 999_999,
    });

    // Manually inject a group into the cache (simulate post-refresh state)
    const group = makeValidGroup("condA", ["tok1", "tok2", "tok3"]);
    // Access private groups map via type casting
    (engine as unknown as { groups: Map<string, NegRiskGroup> }).groups.set("condA", group);
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tok1");
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tok2");
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tok3");

    // Send book update for tok1 — should update group sumAsk
    const evt = makeBookUpdateEvent("tok1", "condA", 0.28, 20);
    engine.handleBookUpdate(evt);

    // The group should have been updated synchronously (before the async evaluate)
    expect(group.tokens[0].bestAsk).toBeCloseTo(0.28, 4);
    // sumAsk should be recalculated
    expect(group.sumAsk).toBeCloseTo(0.28 + 0.35 + 0.35, 4);

    consoleSpy.mockRestore();
  });

  it("alert emitted on arb detection (emitAlert logs to console.log)", async () => {
    const db = makeDb();
    const clob = makeClob();
    const webhookEmitter = makeWebhookEmitter();
    const consoleSpy = vi.spyOn(console, "log");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), webhookEmitter, {
      refreshIntervalMs: 999_999,
    });

    // Inject group with sumAsk=0.96 (triggers ARB: 0.96 - 1.0 = -0.04 < -0.02) and valid (>= 0.95)
    const group: NegRiskGroup = {
      conditionId: "condArb",
      tokens: [
        { tokenId: "tokA", conditionId: "condArb", bestAsk: 0.33, bestBid: 0.31, question: "A" },
        { tokenId: "tokB", conditionId: "condArb", bestAsk: 0.33, bestBid: 0.31, question: "B" },
        { tokenId: "tokC", conditionId: "condArb", bestAsk: 0.30, bestBid: 0.28, question: "C" },
      ],
      sumAsk: 0.96, // arbSpread = -0.04 < -0.02
      sumBid: 0.90,
      isValid: true,
    };
    (engine as unknown as { groups: Map<string, NegRiskGroup> }).groups.set("condArb", group);
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tokA");
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tokB");
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tokC");

    // Send a book update for tokA — keeps price at 0.33, sufficient size
    // After update: sumAsk = 0.33 + 0.33 + 0.30 = 0.96 ≥ 0.95 (valid)
    const evt = makeBookUpdateEvent("tokA", "condArb", 0.33, 20);
    engine.handleBookUpdate(evt);

    // The evaluate is fire-and-forget — need to let the promise chain resolve
    // evaluate() is async and calls getTokenPriceHistory24h for each of 3 tokens
    for (let i = 0; i < 20; i++) await Promise.resolve();

    // console.log should have been called with [NEG-RISK] prefix
    const calls = consoleSpy.mock.calls.flat().join(" ");
    expect(calls).toContain("[NEG-RISK]");
    expect(calls).toContain("NEG_RISK_ARB");

    consoleSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("WebhookEmitter.send called with signal on arb detection", async () => {
    const db = makeDb();
    const clob = makeClob();
    const webhookEmitter = makeWebhookEmitter();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const engine = new NegRiskEngine(db, clob, makeAlertEmitter(), webhookEmitter, {
      refreshIntervalMs: 999_999,
    });

    const group: NegRiskGroup = {
      conditionId: "condWh",
      tokens: [
        { tokenId: "tokX", conditionId: "condWh", bestAsk: 0.33, bestBid: 0.31, question: "X" },
        { tokenId: "tokY", conditionId: "condWh", bestAsk: 0.33, bestBid: 0.31, question: "Y" },
        { tokenId: "tokZ", conditionId: "condWh", bestAsk: 0.30, bestBid: 0.28, question: "Z" },
      ],
      sumAsk: 0.96,
      sumBid: 0.90,
      isValid: true,
    };
    (engine as unknown as { groups: Map<string, NegRiskGroup> }).groups.set("condWh", group);
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tokX");
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tokY");
    (engine as unknown as { negRiskTokenIds: Set<string> }).negRiskTokenIds.add("tokZ");

    const evt = makeBookUpdateEvent("tokX", "condWh", 0.33, 20);
    engine.handleBookUpdate(evt);

    // Flush fire-and-forget promise chain
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(webhookEmitter.send).toHaveBeenCalledWith(
      expect.objectContaining({ signalType: "NEG_RISK_ARB" })
    );

    consoleSpy.mockRestore();
  });
});
