import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema.js";
import type { SignalType } from "../events/types.js";
import type { BacktestConfig, BacktestResult, SignalOutcome } from "./types.js";
import { evaluate } from "./evaluator.js";
import { print, writeJson } from "./report.js";

type Db = NodePgDatabase<typeof schema>;

interface SignalRow extends Record<string, unknown> {
  id: string;
  signal_type: string;
  direction: string;
  confidence: string;
  token_id: string;
  created_at: Date;
  winner: boolean | null;
}

export class BacktestRunner {
  constructor(private readonly db: Db) {}

  async run(cfg: BacktestConfig): Promise<BacktestResult> {
    // Build dynamic SQL with optional filters
    const typeFilter =
      cfg.signalTypes && cfg.signalTypes.length > 0
        ? sql`AND s.signal_type = ANY(ARRAY[${sql.join(
            cfg.signalTypes.map((t) => sql`${t}`),
            sql`, `
          )}])`
        : sql``;

    const confFilter =
      cfg.minConfidence !== undefined && cfg.minConfidence > 0
        ? sql`AND s.confidence >= ${cfg.minConfidence.toString()}`
        : sql``;

    const tokenFilter =
      cfg.tokenIds && cfg.tokenIds.length > 0
        ? sql`AND s.token_id = ANY(ARRAY[${sql.join(
            cfg.tokenIds.map((t) => sql`${t}`),
            sql`, `
          )}])`
        : sql``;

    const rows = await this.db.execute<SignalRow>(sql`
      SELECT
        s.id,
        s.signal_type,
        s.direction,
        s.confidence,
        s.token_id,
        s.created_at,
        m.winner
      FROM signals s
      LEFT JOIN markets m ON s.token_id = m.token_id
      WHERE s.created_at BETWEEN ${cfg.startDate.toISOString()} AND ${cfg.endDate.toISOString()}
        ${typeFilter}
        ${confFilter}
        ${tokenFilter}
      ORDER BY s.created_at ASC
    `);

    const outcomes: SignalOutcome[] = (rows.rows as SignalRow[]).map((row) => {
      // Determine if the signal direction matched the market resolution.
      // winner=true means the outcome token "won" (resolved YES).
      // BULLISH signals are correct when winner=true, BEARISH when winner=false.
      let marketWinner: boolean | null = null;
      if (row.winner !== null && row.winner !== undefined) {
        const isBullish = row.direction === "BULLISH";
        marketWinner = isBullish ? row.winner : !row.winner;
      }

      return {
        signalId: BigInt(row.id),
        signalType: row.signal_type as SignalType,
        direction: row.direction as "BULLISH" | "BEARISH",
        confidence: Number(row.confidence),
        tokenId: row.token_id,
        createdAt: new Date(row.created_at),
        marketWinner,
      };
    });

    const result = evaluate(outcomes, cfg);
    print(result);
    writeJson(result);
    return result;
  }
}

// ── CLI entry point ──────────────────────────────────────────────────────────

function parseArgs(): BacktestConfig {
  const args = process.argv.slice(2);
  let start = "";
  let end = "";
  let signalTypesRaw = "";
  let minConfidence: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--start") start = args[++i] ?? "";
    else if (args[i] === "--end") end = args[++i] ?? "";
    else if (args[i] === "--signal-types") signalTypesRaw = args[++i] ?? "";
    else if (args[i] === "--min-confidence") minConfidence = parseFloat(args[++i] ?? "0");
  }

  if (!start || !end) {
    process.stderr.write("Usage: pnpm backtest --start YYYY-MM-DD --end YYYY-MM-DD\n");
    process.exit(1);
  }

  return {
    startDate: new Date(start),
    endDate: new Date(end),
    signalTypes:
      signalTypesRaw
        ? (signalTypesRaw.split(",").map((s) => s.trim()) as SignalType[])
        : undefined,
    minConfidence,
  };
}

async function main() {
  const { getDb, closeDb } = await import("../db/client.js");
  const db = getDb();
  const cfg = parseArgs();
  const runner = new BacktestRunner(db);
  try {
    await runner.run(cfg);
  } finally {
    await closeDb();
  }
}

// Only run when executed as the entry point (not when imported in tests)
if (process.argv[1]?.endsWith("runner.js") || process.argv[1]?.endsWith("runner.ts")) {
  main().catch((err) => {
    process.stderr.write(`Backtest failed: ${String(err)}\n`);
    process.exit(1);
  });
}
