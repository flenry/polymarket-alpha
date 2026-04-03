import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { WalletEnricher } from "./wallet-enricher.js";
import type { WhaleAlert, TradeEvent, WhaleSignal } from "../events/types.js";

// Mock DB query modules
vi.mock("../db/queries/wallets.js", () => ({
  upsertWalletProfile: vi.fn().mockResolvedValue(undefined),
  getWalletProfile: vi.fn().mockResolvedValue(null),
}));

vi.mock("../db/queries/whales.js", () => ({
  enrichWhaleAlert: vi.fn().mockResolvedValue(undefined),
  insertWhaleAlert: vi.fn().mockResolvedValue(99n),
  buildTradeLookupKey: vi.fn().mockReturnValue("key"),
}));

import { upsertWalletProfile, getWalletProfile } from "../db/queries/wallets.js";
import { enrichWhaleAlert } from "../db/queries/whales.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(upsertWalletProfile).mockClear();
  vi.mocked(getWalletProfile).mockClear();
  vi.mocked(enrichWhaleAlert).mockClear();
});

function makeDb() {
  return {} as Parameters<typeof WalletEnricher.prototype._enrich>[0];
}

function makeAlert(proxyWallet = "0xabc123"): WhaleAlert {
  const trade: TradeEvent = {
    tokenId: "tok1",
    conditionId: "cond1",
    side: "BUY",
    sizeTokens: 100,
    priceUsdc: 0.65,
    valueUsdc: 65000,
    proxyWallet,
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
    proxyWallet,
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

function makeTrades(overrides: Partial<{
  size: number;
  price: number;
  timestamp: number;
}>[] = []) {
  return overrides.map((o, i) => ({
    proxyWallet: "0xabc123",
    side: "BUY",
    asset: "tok1",
    conditionId: "cond1",
    size: o.size ?? 100,
    price: o.price ?? 0.5,
    timestamp: o.timestamp ?? 1_700_000_000 + i,
    transactionHash: `0xhash${i}`,
    outcome: "Yes",
    title: "Test",
    slug: "test",
    pseudonym: null,
    name: null,
  }));
}

describe("WalletEnricher", () => {
  it("happy path: 5 trades (2 > $10k) → upsert called with whaleTradeCount=2, enrich called with walletFirstSeenAt", async () => {
    const trades = makeTrades([
      { size: 100_000, price: 0.5, timestamp: 1_700_000_000 }, // $50k — whale
      { size: 100_000, price: 0.15, timestamp: 1_700_001_000 }, // $15k — whale
      { size: 1_000, price: 0.5, timestamp: 1_700_002_000 }, // $500 — not whale
      { size: 500, price: 0.5, timestamp: 1_700_003_000 }, // $250 — not whale
      { size: 200, price: 0.5, timestamp: 1_699_999_000 }, // $100 — not whale, earliest
    ]);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(trades),
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(upsertWalletProfile).toHaveBeenCalledOnce();
    const upsertArg = vi.mocked(upsertWalletProfile).mock.calls[0][1];
    expect(upsertArg.whaleTradeCount).toBe(2);
    expect(upsertArg.tradeCount).toBe(5);
    expect(upsertArg.firstSeenAt).toEqual(new Date(1_699_999_000 * 1000));

    expect(enrichWhaleAlert).toHaveBeenCalledOnce();
    const enrichArg = vi.mocked(enrichWhaleAlert).mock.calls[0][2];
    expect(enrichArg.walletFirstSeenAt).toEqual(new Date(1_699_999_000 * 1000));
    expect(enrichArg.walletTradeCount).toBe(5);
  });

  it("429 retry: first call returns 429 with Retry-After:0, second returns 200 → fetch called twice, upsert called", async () => {
    const trades = makeTrades([{ size: 1000, price: 0.5, timestamp: 1_700_000_000 }]);
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (k: string) => (k === "Retry-After" ? "0" : null) },
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(trades),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(upsertWalletProfile).toHaveBeenCalledOnce();
  });

  it("timeout: fetch hangs → _enrich resolves, no DB calls made", async () => {
    const mockFetch = vi.fn().mockImplementation(
      (_url: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener("abort", () => {
              reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
            });
          }
        })
    );
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 50, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(upsertWalletProfile).not.toHaveBeenCalled();
    expect(enrichWhaleAlert).not.toHaveBeenCalled();
  });

  it("recency guard hit: getWalletProfile returns row updated 1h ago → fetch NOT called, enrichWhaleAlert called with cached data", async () => {
    const cachedProfile = {
      proxyWallet: "0xabc123",
      totalVolumeUsdc: 999_000,
      tradeCount: 50,
      whaleTradeCount: 3,
      firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-04-01T00:00:00.000Z"),
      lastEnrichedAt: new Date(Date.now() - 3_600_000), // 1h ago
    };
    vi.mocked(getWalletProfile).mockResolvedValueOnce(cachedProfile);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(mockFetch).not.toHaveBeenCalled();
    expect(enrichWhaleAlert).toHaveBeenCalledOnce();
    const enrichArg = vi.mocked(enrichWhaleAlert).mock.calls[0][2];
    expect(enrichArg.walletTotalVolumeUsdc).toBe(999_000);
    expect(enrichArg.walletTradeCount).toBe(50);
  });

  it("recency guard miss: getWalletProfile returns row updated 25h ago → fetch called", async () => {
    const staleProfile = {
      proxyWallet: "0xabc123",
      totalVolumeUsdc: 999_000,
      tradeCount: 50,
      whaleTradeCount: 3,
      firstSeenAt: new Date("2026-01-01T00:00:00.000Z"),
      lastSeenAt: new Date("2026-04-01T00:00:00.000Z"),
      lastEnrichedAt: new Date(Date.now() - 25 * 3_600_000), // 25h ago
    };
    vi.mocked(getWalletProfile).mockResolvedValueOnce(staleProfile);

    const trades = makeTrades([{ size: 100, price: 0.5, timestamp: 1_700_000_000 }]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(trades),
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(upsertWalletProfile).toHaveBeenCalledOnce();
  });

  it("empty trades: upsert called with zeros, enrich called", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(upsertWalletProfile).toHaveBeenCalledOnce();
    const upsertArg = vi.mocked(upsertWalletProfile).mock.calls[0][1];
    expect(upsertArg.tradeCount).toBe(0);
    expect(upsertArg.totalVolumeUsdc).toBe(0);
    expect(upsertArg.whaleTradeCount).toBe(0);
    expect(enrichWhaleAlert).toHaveBeenCalledOnce();
  });

  it("429 retry: retry fetch throws network error → _enrich resolves, no DB writes", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (k: string) => (k === "Retry-After" ? "0" : null) },
          json: () => Promise.resolve([]),
        });
      }
      // retry throws a network error
      return Promise.reject(new Error("network failure"));
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(upsertWalletProfile).not.toHaveBeenCalled();
    expect(enrichWhaleAlert).not.toHaveBeenCalled();
  });

  it("429 retry: retry fetch times out (AbortError on retry) → _enrich resolves, no DB writes", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: (k: string) => (k === "Retry-After" ? "0" : null) },
        });
      }
      // retry hangs then AbortError fires via signal
      return new Promise((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
          });
        }
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 50, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(upsertWalletProfile).not.toHaveBeenCalled();
    expect(enrichWhaleAlert).not.toHaveBeenCalled();
  });

  it("outer fetch error (non-abort network error): _enrich resolves, no DB writes", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(upsertWalletProfile).not.toHaveBeenCalled();
    expect(enrichWhaleAlert).not.toHaveBeenCalled();
  });

  it("wallet address > 42 chars: truncated to 42, enrichment proceeds", async () => {
    const longWallet = "0x" + "a".repeat(50); // 52 chars
    const trades = makeTrades([{ size: 100, price: 0.5, timestamp: 1_700_000_000 }]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(trades),
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(longWallet), 99n);

    expect(upsertWalletProfile).toHaveBeenCalledOnce();
    const upsertArg = vi.mocked(upsertWalletProfile).mock.calls[0][1];
    expect(upsertArg.proxyWallet.length).toBe(42);
  });

  it("429 double: both first and retry return 429 → gives up, no DB writes", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: false,
        status: 429,
        headers: { get: (k: string) => (k === "Retry-After" ? "0" : null) },
        json: () => Promise.resolve([]),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(upsertWalletProfile).not.toHaveBeenCalled();
    expect(enrichWhaleAlert).not.toHaveBeenCalled();
  });

  it("recency guard: cached profile with null volume/count/firstSeenAt → enrichWhaleAlert called with undefineds", async () => {
    // Covers lines 91-93: `existing.totalVolumeUsdc ?? undefined` etc. when fields are null
    const cachedProfile = {
      proxyWallet: "0xabc123",
      totalVolumeUsdc: null,   // null → ?? undefined
      tradeCount: null,         // null → ?? undefined
      whaleTradeCount: null,
      firstSeenAt: null,        // null → ?? undefined
      lastSeenAt: null,
      lastEnrichedAt: new Date(Date.now() - 3_600_000), // 1h ago — within recency window
    };
    vi.mocked(getWalletProfile).mockResolvedValueOnce(cachedProfile);

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    // Fetch NOT called (recency hit)
    expect(mockFetch).not.toHaveBeenCalled();
    // enrichWhaleAlert still called with undefined values (not null)
    expect(enrichWhaleAlert).toHaveBeenCalledOnce();
    const enrichArg = vi.mocked(enrichWhaleAlert).mock.calls[0][2];
    expect(enrichArg.walletTotalVolumeUsdc).toBeUndefined();
    expect(enrichArg.walletTradeCount).toBeUndefined();
    expect(enrichArg.walletFirstSeenAt).toBeUndefined();
  });

  it("429 without Retry-After in wallet-enricher: uses 10s fallback (covered via Retry-After: null)", async () => {
    // Covers line 114: `retryAfter ? ... : 10_000` — the 10_000ms branch when no Retry-After header
    // We mock setTimeout to skip the 10s wait; capture only values > 9000 to distinguish from timeoutMs
    const origSetTimeout = globalThis.setTimeout;
    const capturedWaits: number[] = [];
    const fastSetTimeout = vi.fn().mockImplementation(
      (fn: () => void, ms: number) => {
        if (ms >= 9_000) {
          // This is the 10s Retry-After wait — capture it and call immediately
          capturedWaits.push(ms);
          fn();
          return 0 as unknown as ReturnType<typeof setTimeout>;
        }
        return origSetTimeout(fn as Parameters<typeof origSetTimeout>[0], ms);
      }
    );
    vi.stubGlobal("setTimeout", fastSetTimeout);

    const trades = makeTrades([{ size: 100, price: 0.5, timestamp: 1_700_000_000 }]);
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 429,
          headers: { get: () => null }, // No Retry-After header → fallback to 10_000ms
          json: () => Promise.resolve([]),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(trades),
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Should have captured the 10_000ms fallback wait
    expect(capturedWaits).toContain(10_000);
    expect(upsertWalletProfile).toHaveBeenCalledOnce();
  });

  it("parseTrades: non-array response from API → treated as empty trades list", async () => {
    // Covers line 191: `if (!Array.isArray(raw)) return []`
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve({ error: "not an array" }), // non-array response
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    await enricher._enrich(makeAlert(), 99n);

    // parseTrades returns [] for non-array → upsert called with zero counts
    expect(upsertWalletProfile).toHaveBeenCalledOnce();
    const upsertArg = vi.mocked(upsertWalletProfile).mock.calls[0][1];
    expect(upsertArg.tradeCount).toBe(0);
  });

  it("token bucket: when bucket empty, acquire() waits for refill before resolving", async () => {
    // Use rps=1 (one token per 1000ms). Fire 2 concurrent _enrich calls.
    // The second must wait for the token bucket to refill (≥1s gap).
    const trades = makeTrades([{ size: 100, price: 0.5, timestamp: 1_700_000_000 }]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(trades),
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    // rps=1: one token available immediately, second must wait ~1000ms
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 1, recencyHours: 24 });

    const start = Date.now();
    // Fire two concurrent _enrich calls (each needs one bucket token)
    await Promise.all([
      enricher._enrich(makeAlert("0xwallet1"), 1n),
      enricher._enrich(makeAlert("0xwallet2"), 2n),
    ]);
    const elapsed = Date.now() - start;

    // First call takes token immediately; second must wait for refill (~1000ms)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(elapsed).toBeGreaterThanOrEqual(900); // at least one 1s refill cycle
  });

  it("constructor without opts: uses config defaults for timeoutMs/recencyHours/rps", async () => {
    // Covers lines 63-65: `opts?.timeoutMs ?? config.*` defaults when opts is undefined
    const trades = makeTrades([{ size: 100, price: 0.5, timestamp: 1_700_000_000 }]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: () => Promise.resolve(trades),
    });
    vi.stubGlobal("fetch", mockFetch);

    const db = makeDb();
    // No opts — uses config defaults (timeoutMs=5000, recencyHours=24, rps=2)
    const enricher = new WalletEnricher(db as never);
    // _enrich should work with config defaults
    await enricher._enrich(makeAlert(), 99n);

    expect(upsertWalletProfile).toHaveBeenCalledOnce();
    expect(enrichWhaleAlert).toHaveBeenCalledOnce();
  });

  it("enrich() never throws even if _enrich rejects", async () => {
    const db = makeDb();
    const enricher = new WalletEnricher(db as never, { timeoutMs: 5000, rps: 100, recencyHours: 24 });
    // Force _enrich to reject by providing a bad profile mock
    vi.mocked(getWalletProfile).mockRejectedValueOnce(new Error("DB exploded"));

    await expect(() => {
      enricher.enrich(makeAlert(), 99n);
      return Promise.resolve();
    }).not.toThrow();
  });
});
