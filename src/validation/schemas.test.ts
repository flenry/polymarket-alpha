import { describe, it, expect } from "vitest";
import {
  ZGammaMarket,
  ZLiveTradeEvent,
  ZClobBookEvent,
  ZDataApiTrade,
} from "./schemas.js";

describe("ZGammaMarket", () => {
  const valid = {
    conditionId: "0xabc123",
    question: "Will X happen?",
    negRisk: false,
  };

  it("valid payload parses successfully", () => {
    const result = ZGammaMarket.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("missing required field conditionId returns { success: false }", () => {
    const result = ZGammaMarket.safeParse({ question: "test" });
    expect(result.success).toBe(false);
  });

  it("extra unknown fields are stripped not rejected", () => {
    const result = ZGammaMarket.safeParse({ ...valid, unknownField: "extra" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).unknownField).toBeUndefined();
    }
  });

  it("numeric string fields coerced to numbers", () => {
    const result = ZGammaMarket.safeParse({
      ...valid,
      volume24hr: "12345.67",
      bestBid: "0.65",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.volume24hr).toBe("number");
      expect(result.data.volume24hr).toBe(12345.67);
      expect(result.data.bestBid).toBe(0.65);
    }
  });

  it("negRisk defaults to false when absent", () => {
    const result = ZGammaMarket.safeParse({ conditionId: "0x1" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.negRisk).toBe(false);
    }
  });
});

describe("ZLiveTradeEvent", () => {
  const valid = {
    asset: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    conditionId: "0xcond",
    side: "BUY",
    size: 150,
    price: 0.65,
    proxyWallet: "0xwallet",
    transactionHash: "0xtxhash",
    timestamp: 1700000000,
  };

  it("valid trade event parses successfully", () => {
    const result = ZLiveTradeEvent.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("missing proxyWallet returns { success: false }", () => {
    const { proxyWallet: _, ...rest } = valid;
    const result = ZLiveTradeEvent.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("extra unknown fields stripped", () => {
    const result = ZLiveTradeEvent.safeParse({ ...valid, extra: "ignored" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).extra).toBeUndefined();
    }
  });

  it("numeric string size coerced", () => {
    const result = ZLiveTradeEvent.safeParse({ ...valid, size: "100.5" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(typeof result.data.size).toBe("number");
    }
  });
});

describe("ZClobBookEvent", () => {
  const valid = {
    asset_id: "tok1",
    timestamp: "1700000000000",
    hash: "abc123",
    bids: [{ price: "0.65", size: "100" }],
    asks: [{ price: "0.66", size: "50" }],
  };

  it("valid book event parses", () => {
    expect(ZClobBookEvent.safeParse(valid).success).toBe(true);
  });

  it("missing bids returns failure", () => {
    const { bids: _, ...rest } = valid;
    expect(ZClobBookEvent.safeParse(rest).success).toBe(false);
  });
});

describe("ZDataApiTrade", () => {
  const valid = {
    proxyWallet: "0xwallet",
    side: "SELL",
    asset: "tok1",
    conditionId: "0xcond",
    size: 200,
    price: 0.45,
    timestamp: 1700000001,
  };

  it("valid data-api trade parses", () => {
    expect(ZDataApiTrade.safeParse(valid).success).toBe(true);
  });

  it("invalid side fails", () => {
    expect(ZDataApiTrade.safeParse({ ...valid, side: "HOLD" }).success).toBe(false);
  });
});
