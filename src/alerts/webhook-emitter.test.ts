import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { WebhookEmitter } from "./webhook-emitter.js";
import type { WhaleAlert, TradeEvent, WhaleSignal, ImbalanceSignal, VelocitySignal, Signal, NegRiskSignal } from "../events/types.js";

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

  it("rate limit: with rps=2, 3 sends are spaced apart by token refill", async () => {
    // Use rps=2 (one token per 500ms). With 1 pre-filled token, the second send
    // should be near-instant, and the third should be delayed ~500ms.
    const timings: number[] = [];
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      timings.push(Date.now());
      callCount++;
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => null } });
    });
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
      rps: 2,
    });

    const start = Date.now();
    // Fire 3 sends concurrently
    await Promise.all([
      emitter.send(makeWhaleAlert()),
      emitter.send(makeWhaleAlert()),
      emitter.send(makeWhaleAlert()),
    ]);

    const elapsed = Date.now() - start;
    // 3 sends at 2 rps = at least 1 token-refill wait (~500ms) for the third send
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeGreaterThanOrEqual(400); // at least one refill period
  });

  it("429 retry response non-OK (not 204): send() still resolves", async () => {
    // First call: 429 with Retry-After:0, second call: 500 → should log warn but not throw
    const mockFetch = makeMockFetch([
      { status: 429, headers: { "Retry-After": "0" } },
      { status: 500 },
    ]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await expect(emitter.send(makeWhaleAlert())).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("non-OK response (not 204) on first call: send() resolves", async () => {
    // Covers the logger.warn branch for non-OK, non-204 on first response (lines 208-209)
    const mockFetch = makeMockFetch([{ status: 403 }]);
    vi.stubGlobal("fetch", mockFetch);

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await expect(emitter.send(makeWhaleAlert())).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("fallback Discord payload for non-whale non-imbalance signal: title='Signal'", async () => {
    // Covers the third branch in buildDiscordPayload (line 172)
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const velocitySignal: VelocitySignal = {
      signalType: "SENTIMENT_VELOCITY",
      tokenId: "tok3",
      conditionId: "cond3",
      direction: "BULLISH",
      confidence: 0.6,
      strength: 100,
      priceAtSignal: 0.5,
      createdAt: new Date(),
      payload: {},
      tradeCountVelocity: 3.1,
    };

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(velocitySignal as Signal);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ title: string; color: number }>;
    };
    expect(body.embeds[0].title).toBe("Signal");
    expect(body.embeds[0].color).toBe(0x888888);
  });

  it("fallback Slack payload for non-whale non-imbalance signal: block text is JSON", async () => {
    // Covers lines 178-180
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const velocitySignal: VelocitySignal = {
      signalType: "SENTIMENT_VELOCITY",
      tokenId: "tok3",
      conditionId: "cond3",
      direction: "BULLISH",
      confidence: 0.6,
      strength: 100,
      priceAtSignal: 0.5,
      createdAt: new Date(),
      payload: {},
      tradeCountVelocity: 3.1,
    };

    const emitter = new WebhookEmitter({
      discordUrl: "",
      slackUrl: "https://hooks.slack.com/services/test",
    });
    await emitter.send(velocitySignal as Signal);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      blocks: Array<{ type: string; text: { text: string } }>;
    };
    expect(body.blocks[0].type).toBe("section");
    // Should JSON.stringify the signal
    expect(body.blocks[0].text.text).toContain("SENTIMENT_VELOCITY");
  });

  it("429 without Retry-After header: uses 10s fallback wait then retries", async () => {
    // Mock setTimeout to instantly fire when waitMs=10_000 (no Retry-After header)
    // This covers the `retryAfter ? ... : 10_000` branch (line 193 in webhook-emitter.ts)
    const origSetTimeout = globalThis.setTimeout;
    const fastSetTimeout = vi.fn().mockImplementation(
      (fn: () => void, ms: number, ...args: unknown[]) => {
        if (ms >= 10_000) {
          // Skip the long wait — call immediately
          fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return origSetTimeout(fn as Parameters<typeof origSetTimeout>[0], ms);
      }
    );
    vi.stubGlobal("setTimeout", fastSetTimeout);

    const mockFetch = makeMockFetch([
      { status: 429 }, // no Retry-After header — triggers 10_000ms fallback
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

  it("Discord/Slack whale payload: falls back to tokenId when marketTitle empty", async () => {
    // Covers: `trade.marketTitle || trade.tokenId` (line 122 Slack, line ~74 Discord)
    // when marketTitle is empty string, falls back to tokenId
    const mockFetch = makeMockFetch([{ status: 200 }, { status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const alert = makeWhaleAlert();
    // Clear marketTitle so the || fallback triggers
    (alert.trade as { marketTitle: string }).marketTitle = "";

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "https://hooks.slack.com/services/test",
    });
    await emitter.send(alert);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Discord description should fall back to marketSlug, then tokenId
    const discordBody = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ description: string }>;
    };
    // marketSlug is "test-market" which is truthy
    expect(discordBody.embeds[0].description).toBe("test-market");
  });

  it("constructor without opts: reads discordUrl and slackUrl from config (branch covers ?? config.* defaults)", async () => {
    // Covers lines 149-150: `this.discordUrl = opts?.discordUrl ?? config.discordWebhookUrl`
    // When opts is undefined, uses config defaults (both empty strings in test env)
    const mockFetch = makeMockFetch([]);
    vi.stubGlobal("fetch", mockFetch);

    // No opts — discordUrl and slackUrl both default to "" via config
    const emitter = new WebhookEmitter();
    await emitter.send(makeWhaleAlert());

    // Both URLs empty from config → no-op
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("truncateWallet: short wallet (≤12 chars) returned unchanged — no truncation", async () => {
    // Covers the `else` branch of `wallet.length > len ? ... : wallet` (line 16)
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const alert = makeWhaleAlert();
    // Set a short wallet (≤12 chars) so truncation does NOT apply
    (alert.trade as { proxyWallet: string }).proxyWallet = "0xshort";
    (alert.signal as { proxyWallet: string }).proxyWallet = "0xshort";

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(alert);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ fields: Array<{ name: string; value: string }> }>;
    };
    const walletField = body.embeds[0].fields.find((f) => f.name === "Wallet");
    // Short wallet — returned unchanged, no ellipsis
    expect(walletField?.value).toBe("0xshort");
    expect(walletField?.value).not.toContain("…");
  });

  it("Discord description falls back to tokenId when both marketTitle and marketSlug empty", async () => {
    // Covers: `trade.marketTitle || trade.marketSlug || trade.tokenId` (line 70)
    // Both marketTitle="" and marketSlug="" → falls back to tokenId
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);

    const alert = makeWhaleAlert();
    (alert.trade as { marketTitle: string }).marketTitle = "";
    (alert.trade as { marketSlug: string }).marketSlug = "";

    const emitter = new WebhookEmitter({
      discordUrl: "https://discord.com/api/webhooks/test",
      slackUrl: "",
    });
    await emitter.send(alert);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ description: string }>;
    };
    expect(body.embeds[0].description).toBe(alert.trade.tokenId);
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

  // ── Neg-Risk signal tests ──────────────────────────────────────

  function makeNegRiskSignal(overrides: Partial<NegRiskSignal> = {}): NegRiskSignal {
    return {
      signalType: "NEG_RISK_ARB",
      tokenId: "tok1",
      conditionId: "cond1",
      conditionIdGroup: "cond1",
      direction: "BULLISH",
      confidence: 0.80,
      strength: 0.10,
      priceAtSignal: 0.33,
      createdAt: new Date(),
      payload: {},
      negRiskGroupSize: 3,
      negRiskSumBid: 0.90,
      negRiskSumAsk: 0.96,
      arbSpread: -0.04,
      ...overrides,
    };
  }

  it("Discord embed for NEG_RISK_ARB uses purple color 0x9B59B6", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);
    const emitter = new WebhookEmitter({ discordUrl: "https://discord.com/test", slackUrl: "" });
    await emitter.send(makeNegRiskSignal());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ color: number; title: string; fields: Array<{ name: string }> }>;
    };
    expect(body.embeds[0].color).toBe(0x9B59B6);
    expect(body.embeds[0].title).toContain("Arb");
    expect(body.embeds[0].fields.some((f) => f.name === "Arb Spread")).toBe(true);
  });

  it("Discord embed for NEG_RISK_OUTLIER shows Price Deviation field and purple color", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);
    const emitter = new WebhookEmitter({ discordUrl: "https://discord.com/test", slackUrl: "" });
    await emitter.send(makeNegRiskSignal({ signalType: "NEG_RISK_OUTLIER", arbSpread: undefined, priceDeviation: 4.2 }));
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ color: number; title: string; fields: Array<{ name: string }> }>;
    };
    expect(body.embeds[0].color).toBe(0x9B59B6);
    expect(body.embeds[0].title).toContain("Outlier");
    expect(body.embeds[0].fields.some((f) => f.name === "Price Deviation")).toBe(true);
  });

  it("Slack payload for NEG_RISK_ARB contains 'Neg-Risk Arb' and Arb Spread", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);
    const emitter = new WebhookEmitter({ discordUrl: "", slackUrl: "https://hooks.slack.com/test" });
    await emitter.send(makeNegRiskSignal());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      blocks: Array<{ text: { text: string } }>;
    };
    expect(body.blocks[0].text.text).toContain("Neg-Risk Arb");
    expect(body.blocks[0].text.text).toContain("Arb Spread");
  });

  it("fallback NOT hit for NEG_RISK_ARB — explicit purple builder used", async () => {
    const mockFetch = makeMockFetch([{ status: 200 }]);
    vi.stubGlobal("fetch", mockFetch);
    const emitter = new WebhookEmitter({ discordUrl: "https://discord.com/test", slackUrl: "" });
    await emitter.send(makeNegRiskSignal());
    const body = JSON.parse(mockFetch.mock.calls[0][1].body) as {
      embeds: Array<{ title: string }>;
    };
    // Fallback gives title="Signal"; explicit builder must be used instead
    expect(body.embeds[0].title).not.toBe("Signal");
  });
});
