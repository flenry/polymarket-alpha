import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export interface WalletRow {
  proxy_wallet: string;
  total_volume_usdc: string | null;
  trade_count: number | null;
  whale_trade_count: number | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  resolved_trade_count: number | null;
  win_count: number | null;
  win_ratio: string | null;
  display_name: string | null;
  pseudonym: string | null;
  last_enriched_at: string | null;
  enrichment_version: number | null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const rawMinTrades = searchParams.get("minTrades") ?? "3";
  const rawMinVolume = searchParams.get("minVolume") ?? "0";
  const rawLimit = searchParams.get("limit") ?? "50";

  const minTrades = parseInt(rawMinTrades, 10);
  const minVolume = parseFloat(rawMinVolume);
  const parsedLimit = parseInt(rawLimit, 10);

  if (isNaN(minTrades) || minTrades < 0) {
    return NextResponse.json(
      { error: "Invalid minTrades parameter" },
      { status: 400 }
    );
  }

  if (isNaN(minVolume) || minVolume < 0) {
    return NextResponse.json(
      { error: "Invalid minVolume parameter" },
      { status: 400 }
    );
  }

  // Guard negative or non-numeric limit — PostgreSQL rejects LIMIT < 0 at runtime.
  // NaN (non-numeric) silently defaults to 50; negative values must be rejected.
  if (!isNaN(parsedLimit) && parsedLimit < 1) {
    return NextResponse.json(
      { error: "Invalid limit parameter" },
      { status: 400 }
    );
  }
  const limit = Math.min(isNaN(parsedLimit) ? 50 : parsedLimit, 200);

  // LAW-MAJOR-2: filter on resolved_trade_count, not trade_count
  const query = `
    SELECT *
    FROM wallet_profiles
    WHERE resolved_trade_count >= $1
      AND (total_volume_usdc IS NULL OR total_volume_usdc >= $2)
    ORDER BY win_ratio DESC NULLS LAST
    LIMIT $3
  `;

  try {
    const result = await pool.query(query, [minTrades, minVolume, limit]);
    return NextResponse.json({ wallets: result.rows as WalletRow[] });
  } catch (err) {
    console.error("[api/wallets] DB error:", err);
    return NextResponse.json(
      { error: "Failed to fetch wallets" },
      { status: 500 }
    );
  }
}
