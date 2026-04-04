import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { ALERT_TRADE_JOIN_SQL } from "@/lib/alert-hydration";

export interface AlertRow {
  id: string;
  trade_lookup_key: string;
  token_id: string;
  condition_id: string;
  usdc_value: string;
  absolute_min_usdc: number;
  avg_trade_size_24h_at_alert: string | null;
  stddev_24h_at_alert: string | null;
  volume_24h_at_alert: string | null;
  sigmas_above_mean: string | null;
  pct_of_daily_volume: string | null;
  price_at_alert: string | null;
  price_impact_estimate_usdc: string | null;
  book_depth_consumed_pct: string | null;
  book_snapshot_age_ms: number | null;
  wallet_total_volume_usdc: string | null;
  wallet_trade_count: number | null;
  wallet_first_seen_at: string | null;
  wallet_win_ratio: string | null;
  enriched_at: string | null;
  alerted_at: string;
  // from JOIN
  side: string | null;
  proxy_wallet: string | null;
  question: string | null;
  slug: string | null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const rawLimit = searchParams.get("limit") ?? "100";
  const rawOffset = searchParams.get("offset") ?? "0";
  const rawHours = searchParams.get("hours") ?? "24";

  const limit = parseInt(rawLimit, 10);
  const offset = parseInt(rawOffset, 10);
  const hours = parseInt(rawHours, 10);

  if (isNaN(hours) || hours < 1 || hours > 168) {
    return NextResponse.json({ error: "Invalid hours parameter (1–168)" }, { status: 400 });
  }
  if (isNaN(limit) || limit < 1) {
    return NextResponse.json({ error: "Invalid limit parameter" }, { status: 400 });
  }
  if (isNaN(offset) || offset < 0) {
    return NextResponse.json({ error: "Invalid offset parameter" }, { status: 400 });
  }

  const effectiveLimit = Math.min(limit, 500);

  try {
    const dataQuery = `
      SELECT
        wa.*,
        t.side,
        t.proxy_wallet,
        m.question,
        m.slug
      FROM whale_alerts wa
      ${ALERT_TRADE_JOIN_SQL}
      LEFT JOIN markets m ON m.token_id = wa.token_id
      WHERE wa.alerted_at >= NOW() - $1 * INTERVAL '1 hour'
      ORDER BY wa.alerted_at DESC
      LIMIT $2 OFFSET $3
    `;

    const countQuery = `
      SELECT COUNT(*) AS total
      FROM whale_alerts wa
      WHERE wa.alerted_at >= NOW() - $1 * INTERVAL '1 hour'
    `;

    const [dataResult, countResult] = await Promise.all([
      pool.query(dataQuery, [hours, effectiveLimit, offset]),
      pool.query(countQuery, [hours]),
    ]);

    return NextResponse.json({
      alerts: dataResult.rows as AlertRow[],
      total: parseInt(countResult.rows[0].total, 10),
    });
  } catch (err) {
    console.error("[api/alerts] DB error:", err);
    return NextResponse.json({ alerts: [], total: 0 });
  }
}
