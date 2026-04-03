import { describe, it, expect, vi } from "vitest";
import { TypedEventBus } from "./bus.js";
import type { TradeEvent } from "./types.js";

function makeTrade(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65,
    proxyWallet: "0xabc",
    transactionHash: "0xhash",
    tradedAt: new Date(),
    outcome: "Yes",
    marketSlug: "test-market",
    eventSlug: "test-event",
    marketTitle: "Test Market",
    source: "live_ws",
    ...overrides,
  };
}

describe("TypedEventBus", () => {
  it("handler receives correct typed payload", () => {
    const bus = new TypedEventBus();
    const trade = makeTrade({ tokenId: "tok-test" });
    let received: TradeEvent | null = null;

    bus.on("trade", (t) => {
      received = t;
    });
    bus.emit("trade", trade);

    expect(received).not.toBeNull();
    expect((received as TradeEvent).tokenId).toBe("tok-test");
  });

  it("multiple handlers on same event all called", () => {
    const bus = new TypedEventBus();
    const calls: number[] = [];

    bus.on("trade", () => calls.push(1));
    bus.on("trade", () => calls.push(2));
    bus.emit("trade", makeTrade());

    expect(calls).toEqual([1, 2]);
  });

  it("off() deregisters handler", () => {
    const bus = new TypedEventBus();
    const fn = vi.fn();

    bus.on("trade", fn);
    bus.off("trade", fn);
    bus.emit("trade", makeTrade());

    expect(fn).not.toHaveBeenCalled();
  });

  it("once() fires only once", () => {
    const bus = new TypedEventBus();
    const fn = vi.fn();

    bus.once("trade", fn);
    bus.emit("trade", makeTrade());
    bus.emit("trade", makeTrade());

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("different event types are independent", () => {
    const bus = new TypedEventBus();
    const tradeFn = vi.fn();
    const signalFn = vi.fn();

    bus.on("trade", tradeFn);
    bus.on("signal", signalFn);

    bus.emit("trade", makeTrade());

    expect(tradeFn).toHaveBeenCalledTimes(1);
    expect(signalFn).not.toHaveBeenCalled();
  });
});
