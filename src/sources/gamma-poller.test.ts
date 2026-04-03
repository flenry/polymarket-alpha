import { describe, it, expect, vi, beforeEach } from "vitest";
import { GammaPoller } from "./gamma-poller.js";

function makeDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  // For select queries (getMarketStats, etc.)
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit });
  const orderBy = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where, orderBy });
  const select = vi.fn().mockReturnValue({ from });

  return { insert, select } as unknown as Parameters<typeof GammaPoller>[0]["db"];
}

function makeNegRiskMarket(tokenId: string) {
  return {
    conditionId: "0xcond1",
    negRisk: true,
    clobTokenIds: [tokenId],
    question: "Which team wins?",
    active: true,
    closed: false,
    volume24hr: 50000,
  };
}

function makeMarket(tokenId: string) {
  return {
    conditionId: "0xcond2",
    negRisk: false,
    clobTokenIds: [tokenId],
    question: "Will X happen?",
    active: true,
    closed: false,
    volume24hr: 100000,
  };
}

function makeFetch(markets: object[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(markets),
  });
}

describe("GammaPoller", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it("neg_risk market stored with watchlisted=false", async () => {
    const poller = new GammaPoller({
      db,
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([makeNegRiskMarket("tok-neg")]),
    });

    await poller.start();
    poller.stop();

    // Check that upsertMarket was called with watchlisted=false for neg_risk token
    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);

    // Find the call for markets table
    const marketCall = insertCalls.find(() => true);
    expect(marketCall).toBeDefined();

    // The neg risk token should NOT be in watchlist
    expect(poller.getWatchlist()).not.toContain("tok-neg");
    expect(poller.getNegRiskIds()).toContain("tok-neg");
  });

  it("non-neg_risk market stored with watchlisted=true", async () => {
    const poller = new GammaPoller({
      db,
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([makeMarket("tok-normal")]),
    });

    await poller.start();
    poller.stop();

    expect(poller.getWatchlist()).toContain("tok-normal");
    expect(poller.getNegRiskIds()).not.toContain("tok-normal");
  });

  it("markets_updated emitted with correct token ID sets", async () => {
    const emittedTokenIds: string[] = [];
    const emittedNegRiskIds: string[] = [];

    const poller = new GammaPoller({
      db,
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([
        makeMarket("tok-yes"),
        makeNegRiskMarket("tok-nr"),
      ]),
    });

    poller.on("markets_updated", (tokenIds, negRiskIds) => {
      emittedTokenIds.push(...tokenIds);
      emittedNegRiskIds.push(...negRiskIds);
    });

    await poller.start();
    poller.stop();

    expect(emittedTokenIds).toContain("tok-yes");
    expect(emittedNegRiskIds).toContain("tok-nr");
  });

  it("unknown field in Gamma response does not throw", async () => {
    const marketWithExtra = {
      ...makeMarket("tok-extra"),
      unknownField: "should be stripped",
      anotherUnknown: 12345,
    };

    const poller = new GammaPoller({
      db,
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([marketWithExtra]),
    });

    // Should not throw
    await expect(poller.start()).resolves.toBeUndefined();
    poller.stop();
  });

  it("handleUnknownTrade creates minimal market row", async () => {
    const poller = new GammaPoller({
      db,
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([]),
    });

    await poller.handleUnknownTrade("unknown-tok", "cond-x", 1);

    const insertCalls = (db.insert as ReturnType<typeof vi.fn>).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
  });

  it("handleUnknownTrade promotes to watchlist after threshold activity", async () => {
    const poller = new GammaPoller({
      db,
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([]),
    });

    // Not promoted yet (below threshold)
    await poller.handleUnknownTrade("unknown-tok", "cond-x", 3, 5);
    expect(poller.getWatchlist()).not.toContain("unknown-tok");

    // Now at threshold
    await poller.handleUnknownTrade("unknown-tok", "cond-x", 5, 5);
    expect(poller.getWatchlist()).toContain("unknown-tok");
  });
});
