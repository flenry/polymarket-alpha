import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { print, writeJson } from "./report.js";
import type { BacktestResult } from "./types.js";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";

// ── Fixture ───────────────────────────────────────────────────────────────────

function makeResult(): BacktestResult {
  return {
    config: {
      startDate: new Date("2025-01-01"),
      endDate: new Date("2025-04-01"),
    },
    byType: {
      WHALE_TRADE: {
        totalFired: 124,
        totalResolved: 89,
        totalCorrect: 60,
        precision: 0.484,
        resolvedHitRate: 0.674,
        f1: 0.563,
        avgConfidence: 0.68,
      },
      ORDER_BOOK_IMBALANCE: {
        totalFired: 89,
        totalResolved: 49,
        totalCorrect: 30,
        precision: 0.337,
        resolvedHitRate: 0.612,
        f1: 0.434,
        avgConfidence: 0.55,
      },
    },
    overall: {
      totalFired: 213,
      totalResolved: 138,
      totalCorrect: 90,
      precision: 0.423,
      resolvedHitRate: 0.652,
      f1: 0.513,
      avgConfidence: 0.63,
    },
  };
}

const TEST_DIR = "backtest-results-test-tmp";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BacktestReport — writeJson", () => {
  afterEach(() => {
    // Clean up temp dir
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  it("writes a JSON file to the specified directory", () => {
    const result = makeResult();
    const path = writeJson(result, TEST_DIR);
    expect(existsSync(path)).toBe(true);
  });

  it("file path matches {startDate}_{endDate}.json", () => {
    const result = makeResult();
    const path = writeJson(result, TEST_DIR);
    expect(path).toContain("2025-01-01_2025-04-01.json");
  });

  it("JSON output shape matches BacktestResult", () => {
    const result = makeResult();
    const path = writeJson(result, TEST_DIR);
    const content = JSON.parse(readFileSync(path, "utf-8")) as BacktestResult;

    expect(content.overall.totalFired).toBe(213);
    expect(content.overall.precision).toBeCloseTo(0.423, 3);
    expect(content.overall.resolvedHitRate).toBeCloseTo(0.652, 3);
    expect(content.byType["WHALE_TRADE"]).toBeDefined();
    expect(content.byType["ORDER_BOOK_IMBALANCE"]).toBeDefined();
  });

  it("creates directory if it doesn't exist", () => {
    const nestedDir = join(TEST_DIR, "nested", "path");
    const result = makeResult();
    const path = writeJson(result, nestedDir);
    expect(existsSync(path)).toBe(true);
  });

  it("returns the absolute or relative path of the written file", () => {
    const result = makeResult();
    const path = writeJson(result, TEST_DIR);
    expect(typeof path).toBe("string");
    expect(path.endsWith(".json")).toBe(true);
  });
});

describe("BacktestReport — print (stdout)", () => {
  let stdoutOutput = "";
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutOutput = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutOutput += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it("prints a box-format table to stdout", () => {
    print(makeResult());
    expect(stdoutOutput).toContain("╔");
    expect(stdoutOutput).toContain("╗");
    expect(stdoutOutput).toContain("╚");
    expect(stdoutOutput).toContain("╝");
    expect(stdoutOutput).toContain("╠");
    expect(stdoutOutput).toContain("╣");
  });

  it("table contains BACKTEST RESULTS header with date range", () => {
    print(makeResult());
    expect(stdoutOutput).toContain("BACKTEST RESULTS");
    expect(stdoutOutput).toContain("2025-01-01");
    expect(stdoutOutput).toContain("2025-04-01");
  });

  it("table contains HitRate column (not Recall)", () => {
    print(makeResult());
    expect(stdoutOutput).toContain("HitRate");
    expect(stdoutOutput).not.toContain("Recall");
  });

  it("table contains Signal Type, Precision, F1, Fired columns", () => {
    print(makeResult());
    expect(stdoutOutput).toContain("Signal Type");
    expect(stdoutOutput).toContain("Precision");
    expect(stdoutOutput).toContain("F1");
    expect(stdoutOutput).toContain("Fired");
  });

  it("table contains WHALE_TRADE and ORDER_BOOK_IMBALANCE rows", () => {
    print(makeResult());
    expect(stdoutOutput).toContain("WHALE_TRADE");
    expect(stdoutOutput).toContain("ORDER_BOOK_IMBALANCE");
  });

  it("table contains OVERALL row", () => {
    print(makeResult());
    expect(stdoutOutput).toContain("OVERALL");
  });

  it("prints empty overall row gracefully when no signals", () => {
    const emptyResult: BacktestResult = {
      config: {
        startDate: new Date("2025-01-01"),
        endDate: new Date("2025-04-01"),
      },
      byType: {},
      overall: {
        totalFired: 0,
        totalResolved: 0,
        totalCorrect: 0,
        precision: 0,
        resolvedHitRate: 0,
        f1: 0,
        avgConfidence: 0,
      },
    };
    expect(() => print(emptyResult)).not.toThrow();
    expect(stdoutOutput).toContain("OVERALL");
  });
});
