import { describe, it, expect, vi } from "vitest";
import { GammaPoller } from "../src/sources/gamma-poller.js";
import gammaMarket from "./fixtures/gamma-market.json" assert { type: "json" };
import gammaNegRisk from "./fixtures/gamma-market-neg-risk.json" assert { type: "json" };

// FROZEN: do not edit without updating consuming tests

function makeDb() {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });
  const limit = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { insert, select } as unknown as Parameters<typeof GammaPoller>[0]["db"];
}

function makeFetch(markets: object[]) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(markets),
  });
}

describe("GammaPoller (fixture-based)", () => {
  it("neg_risk markets stored with watchlisted=false", async () => {
    const poller = new GammaPoller({
      db: makeDb(),
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([gammaNegRisk]),
    });

    await poller.start();
    poller.stop();

    // neg_risk tokens should be in negRisk set, not watchlist
    const negRiskIds = poller.getNegRiskIds();
    const watchlist = poller.getWatchlist();

    expect(negRiskIds.length).toBeGreaterThan(0);
    for (const id of negRiskIds) {
      expect(watchlist).not.toContain(id);
    }
  });

  it("non-neg_risk markets stored with watchlisted=true", async () => {
    const poller = new GammaPoller({
      db: makeDb(),
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([gammaMarket]),
    });

    await poller.start();
    poller.stop();

    const watchlist = poller.getWatchlist();
    expect(watchlist.length).toBeGreaterThan(0);

    // All watchlisted tokens should not be in neg_risk set
    const negRiskIds = poller.getNegRiskIds();
    for (const id of watchlist) {
      expect(negRiskIds).not.toContain(id);
    }
  });

  it("markets_updated event includes neg_risk token IDs correctly", async () => {
    let emittedNormal: string[] = [];
    let emittedNegRisk: string[] = [];

    const poller = new GammaPoller({
      db: makeDb(),
      pollIntervalMs: 60000,
      watchlistSize: 200,
      fetchFn: makeFetch([gammaMarket, gammaNegRisk]),
    });

    poller.on("markets_updated", (tokenIds, negRiskIds) => {
      emittedNormal = tokenIds;
      emittedNegRisk = negRiskIds;
    });

    await poller.start();
    poller.stop();

    // Normal market token IDs should be in emittedNormal
    const normalTokens = gammaMarket.clobTokenIds ?? [];
    for (const id of normalTokens) {
      expect(emittedNormal).toContain(id);
    }

    // Neg-risk token IDs should be in emittedNegRisk
    const negRiskTokens = gammaNegRisk.clobTokenIds ?? [];
    for (const id of negRiskTokens) {
      expect(emittedNegRisk).toContain(id);
    }
  });
});
