import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { BacktestResult, BacktestMetrics } from "./types.js";
import type { SignalType } from "../events/types.js";

const COL = {
  type: 22,
  precision: 10,
  hitRate: 9,
  f1: 7,
  fired: 7,
};

const TOTAL_WIDTH = COL.type + COL.precision + COL.hitRate + COL.f1 + COL.fired + 5; // 5 = separators

function pad(s: string, width: number, right = false): string {
  const str = String(s);
  if (str.length >= width) return str.substring(0, width);
  const padding = " ".repeat(width - str.length);
  return right ? padding + str : str + padding;
}

function fmtNum(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

function fmtRow(
  type: string,
  m: BacktestMetrics
): string {
  return (
    "║  " +
    pad(type, COL.type) +
    pad(fmtNum(m.precision), COL.precision) +
    pad(fmtNum(m.resolvedHitRate), COL.hitRate) +
    pad(fmtNum(m.f1), COL.f1) +
    pad(String(m.totalFired), COL.fired) +
    "║"
  );
}

function headerRow(): string {
  return (
    "║  " +
    pad("Signal Type", COL.type) +
    pad("Precision", COL.precision) +
    pad("HitRate", COL.hitRate) +
    pad("F1", COL.f1) +
    pad("Fired", COL.fired) +
    "║"
  );
}

function border(char: string, left: string, right: string): string {
  return left + char.repeat(TOTAL_WIDTH + 4) + right;
}

function formatDateRange(start: Date, end: Date): string {
  return `${start.toISOString().slice(0, 10)} \u2192 ${end.toISOString().slice(0, 10)}`;
}

/**
 * Print a formatted backtest results table to process.stdout.
 */
export function print(result: BacktestResult): void {
  const dateRange = formatDateRange(result.config.startDate, result.config.endDate);
  const title = `BACKTEST RESULTS  ${dateRange}`;

  const topLine = border("═", "╔", "╗");
  const midLine = border("═", "╠", "╣");
  const botLine = border("═", "╚", "╝");

  const titleRow = "║  " + pad(title, TOTAL_WIDTH + 1) + "║";

  const lines: string[] = [
    topLine,
    titleRow,
    midLine,
    headerRow(),
  ];

  // Per-type rows
  const typeOrder: SignalType[] = [
    "WHALE_TRADE",
    "ORDER_BOOK_IMBALANCE",
    "PRICE_IMPACT_ANOMALY",
    "SENTIMENT_VELOCITY",
  ];

  for (const type of typeOrder) {
    const m = result.byType[type];
    if (m) {
      lines.push(fmtRow(type, m));
    }
  }

  // Any types not in canonical order (future-proofing)
  for (const [type, m] of Object.entries(result.byType) as [SignalType, BacktestMetrics][]) {
    if (!typeOrder.includes(type)) {
      lines.push(fmtRow(type, m));
    }
  }

  lines.push(midLine);
  lines.push(fmtRow("OVERALL", result.overall));
  lines.push(botLine);

  process.stdout.write(lines.join("\n") + "\n");
}

/**
 * Write backtest result as JSON to `{dir}/{startDate}_{endDate}.json`.
 * Creates the directory if it doesn't exist.
 * @returns The absolute path of the written file.
 */
export function writeJson(result: BacktestResult, dir = "backtest-results"): string {
  mkdirSync(dir, { recursive: true });
  const startStr = result.config.startDate.toISOString().slice(0, 10);
  const endStr = result.config.endDate.toISOString().slice(0, 10);
  const fileName = `${startStr}_${endStr}.json`;
  const filePath = join(dir, fileName);
  writeFileSync(filePath, JSON.stringify(result, null, 2), "utf-8");
  return filePath;
}
