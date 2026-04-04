import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BacktestRunner } from "./runner.js";
import type { BacktestConfig } from "./types.js";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Mock the report module so we don't write files or print during tests
vi.mock("./report.js", () => ({
  print: vi.fn(),
  writeJson: vi.fn().mockReturnValue("backtest-results/mock.json"),
}));

function makeDbRows(rows: Array<{
  id: string;
  signal_type: string;
  direction: string;
  confidence: string;
  token_id: string;
  created_at: Date;
  winner: boolean | null;
}>) {
  return {
    execute: vi.fn().mockResolvedValue({ rows }),
  };
}

const BASE_CONFIG: BacktestConfig = {
  startDate: new Date("2025-01-01"),
  endDate: new Date("2025-04-01"),
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BacktestRunner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries DB with correct date range via execute", async () => {
    const db = makeDbRows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    await runner.run(BASE_CONFIG);

    expect(db.execute).toHaveBeenCalledOnce();
    // The SQL template should contain the start and end dates
    const [sqlArg] = db.execute.mock.calls[0];
    const sqlStr = JSON.stringify(sqlArg);
    expect(sqlStr).toContain("2025-01-01");
    expect(sqlStr).toContain("2025-04-01");
  });

  it("uses LEFT JOIN markets to obtain winner for each signal", async () => {
    const db = makeDbRows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    await runner.run(BASE_CONFIG);

    const [sqlArg] = db.execute.mock.calls[0];
    const sqlStr = JSON.stringify(sqlArg);
    // Should reference markets table and winner column
    expect(sqlStr.toLowerCase()).toContain("markets");
    expect(sqlStr.toLowerCase()).toContain("winner");
  });

  it("returns zero-signal BacktestResult gracefully", async () => {
    const db = makeDbRows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    const result = await runner.run(BASE_CONFIG);

    expect(result.overall.totalFired).toBe(0);
    expect(result.overall.precision).toBe(0);
    expect(Object.keys(result.byType)).toHaveLength(0);
  });

  it("correctly maps DB rows to SignalOutcome objects", async () => {
    const now = new Date("2025-02-15");
    const db = makeDbRows([
      {
        id: "42",
        signal_type: "WHALE_TRADE",
        direction: "BULLISH",
        confidence: "0.75",
        token_id: "tok1",
        created_at: now,
        winner: true, // BULLISH + winner=true → correct
      },
      {
        id: "43",
        signal_type: "ORDER_BOOK_IMBALANCE",
        direction: "BEARISH",
        confidence: "0.60",
        token_id: "tok2",
        created_at: now,
        winner: false, // BEARISH + winner=false → correct (market went down)
      },
      {
        id: "44",
        signal_type: "PRICE_IMPACT_ANOMALY",
        direction: "BULLISH",
        confidence: "0.50",
        token_id: "tok3",
        created_at: now,
        winner: null, // unresolved
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    const result = await runner.run(BASE_CONFIG);

    expect(result.overall.totalFired).toBe(3);
    expect(result.overall.totalResolved).toBe(2); // 2 have winner != null
    expect(result.overall.totalCorrect).toBe(2); // both resolved signals are correct
  });

  it("applies signalTypes filter in SQL when provided", async () => {
    const db = makeDbRows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    await runner.run({ ...BASE_CONFIG, signalTypes: ["WHALE_TRADE"] });

    const [sqlArg] = db.execute.mock.calls[0];
    const sqlStr = JSON.stringify(sqlArg);
    expect(sqlStr).toContain("WHALE_TRADE");
  });

  it("applies minConfidence filter in SQL when provided", async () => {
    const db = makeDbRows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    await runner.run({ ...BASE_CONFIG, minConfidence: 0.5 });

    const [sqlArg] = db.execute.mock.calls[0];
    const sqlStr = JSON.stringify(sqlArg);
    expect(sqlStr).toContain("0.5");
  });

  it("calls BacktestEvaluator.evaluate implicitly (result has byType per signal type)", async () => {
    const now = new Date("2025-02-15");
    const db = makeDbRows([
      {
        id: "10",
        signal_type: "WHALE_TRADE",
        direction: "BULLISH",
        confidence: "0.8",
        token_id: "tok1",
        created_at: now,
        winner: true,
      },
    ]);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    const result = await runner.run(BASE_CONFIG);

    expect(result.byType["WHALE_TRADE"]).toBeDefined();
    expect(result.byType["WHALE_TRADE"]!.totalFired).toBe(1);
    expect(result.byType["WHALE_TRADE"]!.totalCorrect).toBe(1);
  });

  it("calls print() and writeJson() from report module", async () => {
    const { print, writeJson } = await import("./report.js");
    const db = makeDbRows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const runner = new BacktestRunner(db as any);
    await runner.run(BASE_CONFIG);

    expect(print).toHaveBeenCalledOnce();
    expect(writeJson).toHaveBeenCalledOnce();
  });
});
