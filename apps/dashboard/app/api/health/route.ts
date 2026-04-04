import { NextResponse } from "next/server";
import { pool } from "@/lib/db";

export interface HealthResponse {
  lastTradeAt: string | null;
  lastSnapshotAt: string | null;
  lastMarketRefreshAt: string | null;
  tradesLast5Min: number;
  marketsTracked: number;
  negRiskMarketsTracked: number;
  shardsConnected: null;
}

export async function GET() {
  try {
    const [
      lastTradeResult,
      lastSnapshotResult,
      lastMarketRefreshResult,
      trades5MinResult,
      marketsTrackedResult,
      negRiskResult,
    ] = await Promise.all([
      pool.query("SELECT MAX(traded_at) AS ts FROM trades"),
      pool.query("SELECT MAX(captured_at) AS ts FROM order_book_snapshots"),
      pool.query("SELECT MAX(refreshed_at) AS ts FROM market_stats"),
      pool.query(
        "SELECT COUNT(*)::integer AS cnt FROM trades WHERE traded_at >= NOW() - INTERVAL '5 minutes'"
      ),
      pool.query(
        "SELECT COUNT(*)::integer AS cnt FROM markets WHERE active = true AND watchlisted = true"
      ),
      pool.query(
        "SELECT COUNT(*)::integer AS cnt FROM markets WHERE neg_risk = true AND active = true"
      ),
    ]);

    const toIso = (val: unknown): string | null => {
      if (val === null || val === undefined) return null;
      if (val instanceof Date) return val.toISOString();
      return String(val);
    };

    const response: HealthResponse = {
      lastTradeAt: toIso(lastTradeResult.rows[0]?.ts ?? null),
      lastSnapshotAt: toIso(lastSnapshotResult.rows[0]?.ts ?? null),
      lastMarketRefreshAt: toIso(lastMarketRefreshResult.rows[0]?.ts ?? null),
      tradesLast5Min: lastTradeResult.rows[0]?.ts
        ? (trades5MinResult.rows[0]?.cnt as number) ?? 0
        : 0,
      marketsTracked: (marketsTrackedResult.rows[0]?.cnt as number) ?? 0,
      negRiskMarketsTracked: (negRiskResult.rows[0]?.cnt as number) ?? 0,
      shardsConnected: null,
    };

    return NextResponse.json(response);
  } catch (err) {
    console.error("[api/health] DB error:", err);
    const fallback: HealthResponse = {
      lastTradeAt: null,
      lastSnapshotAt: null,
      lastMarketRefreshAt: null,
      tradesLast5Min: 0,
      marketsTracked: 0,
      negRiskMarketsTracked: 0,
      shardsConnected: null,
    };
    return NextResponse.json(fallback);
  }
}
