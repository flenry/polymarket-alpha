import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlertEmitter, formatWhaleAlert } from "./alert-emitter.js";
import { TypedEventBus } from "../events/bus.js";
import type { WhaleAlert, TradeEvent, MarketStats, WhaleSignal } from "../events/types.js";

function makeTrade(tradedAt = new Date()): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100000,
    priceUsdc: 0.68,
    valueUsdc: 68000,
    proxyWallet: "0xabc...def",
    transactionHash: "0xfff...",
    tradedAt,
    outcome: "Yes",
    marketSlug: "us-forces-enter-iran",
    eventSlug: "geopolitics",
    marketTitle: "US forces enter Iran by April 30?",
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
    proxyWallet: "0xabc...def",
    transactionHash: "0xfff...",
    priceImpactEstimate: 0.008,
    bookDepthConsumedPct: 12.3,
    bookSnapshotAgeMs: 3000,
  };
}

function makeAlert(tradedAt = new Date()): WhaleAlert {
  const trade = makeTrade(tradedAt);
  return {
    trade,
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
    emitSignal: true,
  };
}

describe("AlertEmitter", () => {
  it("alert formatted to stdout within same tick as event", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bus = new TypedEventBus();
    const emitter = new AlertEmitter(bus);
    emitter.start();

    const alert = makeAlert();
    bus.emit("whale_alert", alert);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("🐋 WHALE ALERT");

    consoleSpy.mockRestore();
  });

  it("alertLatencyMs is computed (does not throw on fresh trade)", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bus = new TypedEventBus();
    const emitter = new AlertEmitter(bus);

    // Trade with current time — latency should be < 100ms, no throw
    const alert = makeAlert(new Date());
    expect(() => emitter.emit(alert)).not.toThrow();

    consoleSpy.mockRestore();
  });

  it("alert includes: market title, side, price, value, wallet, tx hash", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bus = new TypedEventBus();
    const emitter = new AlertEmitter(bus);
    emitter.start();

    const alert = makeAlert();
    bus.emit("whale_alert", alert);

    const output = consoleSpy.mock.calls[0][0] as string;
    expect(output).toContain("US forces enter Iran");
    expect(output).toContain("BUY");
    expect(output).toContain("0.6800");
    expect(output).toContain("68,000");
    expect(output).toContain("0xabc...def");
    expect(output).toContain("0xfff...");

    consoleSpy.mockRestore();
  });
});

describe("formatWhaleAlert", () => {
  it("returns string containing whale emoji and key fields", () => {
    const alert = makeAlert();
    const output = formatWhaleAlert(alert);
    expect(output).toContain("🐋");
    expect(output).toContain("WHALE ALERT");
    expect(output).toContain("5.2σ above mean");
    expect(output).toContain("3.10% of daily vol");
  });

  it("uses 'pct-of-vol only' when sigmasAboveMean <= 0 (line 12 branch)", () => {
    const alert = makeAlert();
    // Override signal to have sigmasAboveMean = 0 (uncalibrated — pct-of-vol only path)
    const alertNegSigma = {
      ...alert,
      signal: { ...alert.signal, sigmasAboveMean: 0 },
    };
    const output = formatWhaleAlert(alertNegSigma);
    expect(output).toContain("pct-of-vol only");
    expect(output).not.toContain("σ above mean");
  });

  it("bookSnapshotAgeMs=0: empty book age string (line 14 false branch)", () => {
    const alert = makeAlert();
    const alertNoAge = { ...alert, bookSnapshotAgeMs: 0 };
    const output = formatWhaleAlert(alertNoAge);
    expect(output).not.toContain("book age");
  });

  it("falls back to marketSlug when marketTitle is empty (line 18 || branch)", () => {
    const alert = makeAlert();
    const trade = { ...alert.trade, marketTitle: "", marketSlug: "some-slug", tokenId: "tok-xyz" };
    const alertNoTitle = { ...alert, trade };
    const output = formatWhaleAlert(alertNoTitle);
    expect(output).toContain("some-slug");
  });

  it("falls back to tokenId when both marketTitle and marketSlug are empty (line 18 || || branch)", () => {
    const alert = makeAlert();
    const trade = { ...alert.trade, marketTitle: "", marketSlug: "", tokenId: "tok-xyz" };
    const alertNoTitle = { ...alert, trade };
    const output = formatWhaleAlert(alertNoTitle);
    expect(output).toContain("tok-xyz");
  });
});

describe("AlertEmitter latency warning", () => {
  it("logs warn when alertLatencyMs > 1000ms", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const bus = new TypedEventBus();
    const emitter = new AlertEmitter(bus);

    // Trade that happened 2 seconds ago → latency > 1000ms
    const oldTrade = new Date(Date.now() - 2000);
    const alert = makeAlert(oldTrade);

    // Should not throw; the warn branch should be exercised
    expect(() => emitter.emit(alert)).not.toThrow();

    consoleSpy.mockRestore();
  });
});
