import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { WebhookEmitter } from "./webhook-emitter.js";
import type { WhaleAlert, TradeEvent, WhaleSignal, ImbalanceSignal } from "../events/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeMockFetch(responses: { status: number; headers?: Record<string, string> }[]) {
  let callIndex = 0;
  return vi.fn().mockImplementation(() => {
    const resp = responses[callIndex] ?? { status: 200 };
    callIndex++;
    return Promise.resolve({
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      headers: {
        get: (key: string) => resp.headers?.[key] ?? null,
      },
    });
  });
}

function makeWhaleAlert(): WhaleAlert {
  const trade: TradeEvent = {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65000,
    proxyWallet: "0xabc123def456ghi",
    transactionHash: "0xhash",
    tradedAt: new Date("2026-04-03T12:00:00.000Z"),
    outcome: "Yes",
    marketSlug: "test-market",
    eventSlug: "test-event",
    marketTitle: "Test Market",
    source: "live_ws",
  };
  const signal: WhaleSignal = {
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
    proxyWallet: "0xabc123def456ghi",
    transactionHash: "0xhash",
    priceImpactEstimate: 0.01,
    bookDepthConsumedPct: 5.2,
    bookSnapshotAgeMs: 3000,
  };
  return {
    trade,
    usdcValue: 65000,
    marketStats: {
      tokenId: "tok1",
      volume24hr: 2_000_000,
      avgTradeSize24h: 5_000,
      stddevTradeSize24h: 8_000,
      liquidityUsdc: 500_000,
      tradeCount24h: 50,
      calibrated: true,
    },
    priceAtAlert: 0.65,
    priceImpactEstimateUsdc: 650,
    bookDepthConsumedPct: 5.2,
    bookSnapshotAgeMs: 3000,
    book: null,
    signal,
    emitSignal: true,
  };
}

function makeImbalanceSignal(): ImbalanceSignal {
  return {
    signalType: "ORDER_BOOK_IMBALANCE",
    tokenId: "tok2",
    conditionId: "cond2",
    direction: "BULLISH",
    confidence: 0.5,
    strength: 50000,
    priceAtSignal: 0.75,
    createdAt: new Date(),
    payload: {},
    imbalanceRatio: 4.5,
    bidDepthUsdc: 40000,
    askDepthUsdc: 10000,
  };
}

describe("WebhookEmitter", () => {
  it("no-op when both URLs empty: fetch never called", async () => {
    const mockFetch = makeMockFetch([]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({ discordUrl: "", slackUrl: "" });
    await emitter.send(makeWhaleAlert());

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("Discord embed shape for whale alert: correct color and fields", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(makeWhaleAlert());

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{
        color: number;
        fields: Array<{ name: string; value: string }>;
      }>;
    };
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].color).toBe(0xff4444);
    const fieldNames = body.embeds[0].fields.map((f) => f.name);
    expect(fieldNames).toContain("Value (USDC)");
    expect(fieldNames).toContain("Wallet");
    expect(fieldNames).toContain("Sigma Score");
    expect(fieldNames).toContain("% Daily Volume");
  });

  it("Discord embed shape for imbalance signal: color 0xFFAA00, fields present", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(makeImbalanceSignal());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ color: number; fields: Array<{ name: string }> }>;
    };
    expect(body.embeds[0].color).toBe(0xffaa00);
    const fieldNames = body.embeds[0].fields.map((f) => f.name);
    expect(fieldNames).toContain("Ratio");
    expect(fieldNames).toContain("Direction");
    expect(fieldNames).toContain("Total Depth (USDC)");
  });

  it("Slack block shape for whale alert: section block with mrkdwn text containing 'Whale Alert'", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "",
      slackUrl: "https://hooks.slack.com/services/test",
    });
    await emitter.send(makeWhaleAlert());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      blocks: Array<{ type: string; text: { type: string; text: string } }>;
    };
    expect(body.blocks[0].type).toBe("section");
    expect(body.blocks[0].text.type).toBe("mrkdwn");
    expect(body.blocks[0].text.text).toContain("Whale Alert");
  });

  it("Slack block shape for imbalance signal: text contains direction", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "",
      slackUrl: "https://hooks.slack.com/services/test",
    });
    await emitter.send(makeImbalanceSignal());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      blocks: Array<{ type: string; text: { text: string } }>;
    };
    expect(body.blocks[0].text.text).toContain("BULLISH");
  });

  it("429 retry: fetch called twice for one send(), second call succeeds", async () => {
    const mockFetch = makeMockFetch([
      { status: 429, headers: { "Retry-After": "0" } },
      { status: 200 },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(makeWhaleAlert());

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("network error: fetch throws → send() resolves without propagating", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network failure"));
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });

    await expect(emitter.send(makeWhaleAlert())).resolves.toBeUndefined();
  });

  it("both Discord and Slack URLs set: two fetch calls per send", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }, { status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "https://hooks.slack.com/services/test",
    });
    await emitter.send(makeWhaleAlert());

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("wallet truncated to 12 chars + ellipsis in Discord embed", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(makeWhaleAlert());

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const walletField = body.embeds[0].fields.find((f) => f.name === "Wallet");
    expect(walletField?.value).toContain("…");
    expect(walletField?.value.length).toBeLessThanOrEqual(13); // 12 chars + ellipsis
  });
});
