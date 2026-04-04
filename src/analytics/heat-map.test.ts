import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchHeatMapData, renderHeatMap } from "./heat-map.js";

// ── Mock DB factory ───────────────────────────────────────────────────────────

function makeDb(rows: object[]) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Parameters<typeof fetchHeatMapData>[0];
}

function makeRow(
  tokenId: string,
  question: string,
  signalCount: number,
  whaleCount = 0,
  maxConf = 0.80
) {
  return {
    token_id: tokenId,
    question,
    slug: null,
    signal_count: String(signalCount),
    whale_count: String(whaleCount),
    max_conf: String(maxConf),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("fetchHeatMapData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-04-01T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("correct ranking: market with 23 signals ranks above market with 14", async () => {
    const rows = [
      makeRow("tok1", "FIFA World Cup 2026", 23, 3, 0.91),
      makeRow("tok2", "US Presidential 2028", 14, 1, 0.88),
    ];
    const db = makeDb(rows);
    const entries = await fetchHeatMapData(db, 24);

    expect(entries).toHaveLength(2);
    expect(entries[0].signalCount).toBe(23);
    expect(entries[0].market).toBe("FIFA World Cup 2026");
    expect(entries[1].signalCount).toBe(14);
  });

  it("--hours=12: cutoff is computed as 12h before now", async () => {
    const db = makeDb([]);
    await fetchHeatMapData(db, 12);

    // Verify execute was called with a cutoff 12 hours in the past
    expect(db.execute).toHaveBeenCalledOnce();
    const queryStr = JSON.stringify((db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const expected = new Date(new Date("2025-04-01T12:00:00Z").getTime() - 12 * 3600 * 1000);
    expect(queryStr).toContain(expected.toISOString().slice(0, 16));
  });

  it("empty result when no signals in period", async () => {
    const db = makeDb([]);
    const entries = await fetchHeatMapData(db, 24);
    expect(entries).toHaveLength(0);
  });

  it("market name falls back to tokenId when question is null", async () => {
    const rows = [{
      token_id: "tok999",
      question: null,
      slug: null,
      signal_count: "5",
      whale_count: "0",
      max_conf: "0.60",
    }];
    const db = makeDb(rows);
    const entries = await fetchHeatMapData(db, 24);
    expect(entries[0].market).toBe("tok999");
  });
});

describe("renderHeatMap", () => {
  it("bar length proportional: max-count market gets 8 █ chars", () => {
    const entries = [
      { tokenId: "tok1", market: "Market A", signalCount: 23, whaleCount: 3, maxConf: 0.91 },
      { tokenId: "tok2", market: "Market B", signalCount: 11, whaleCount: 1, maxConf: 0.80 },
    ];
    const output = renderHeatMap(entries, 24);
    // Max bar = 8 █
    expect(output).toContain("████████");
    // ~half count → ~4 █ (round(11/23 * 8) = round(3.8) = 4)
    expect(output).toContain("████░░░░");
  });

  it("empty entries: shows 'No signals' message", () => {
    const output = renderHeatMap([], 24);
    expect(output).toContain("No signals");
  });

  it("market name truncated at 24 chars with ellipsis", () => {
    const longName = "This Is A Very Long Market Name That Exceeds The Limit";
    const entries = [
      { tokenId: "tok1", market: longName, signalCount: 5, whaleCount: 0, maxConf: 0.70 },
    ];
    const output = renderHeatMap(entries, 24);
    expect(output).toContain("…");
  });

  it("hours shown in header", () => {
    const output = renderHeatMap([], 48);
    expect(output).toContain("48h");
  });
});
