import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export interface MarketRow {
  token_id: string;
  question: string | null;
  slug: string | null;
  signal_count: number;
  whale_count: number;
  top_signal_type: string | null;
  volume_24h: string | null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const rawHours = searchParams.get("hours") ?? "24";

  let hours = parseInt(rawHours, 10);
  if (isNaN(hours) || hours < 1) {
    return NextResponse.json(
      { error: "Invalid hours parameter" },
      { status: 400 }
    );
  }
  hours = Math.min(hours, 168);

  try {
    // Step 1: top 20 markets by signal count in window
    const top20Query = `
      SELECT
        s.token_id,
        COUNT(*)::integer AS signal_count,
        COUNT(CASE WHEN s.signal_type = 'WHALE_TRADE' THEN 1 END)::integer AS whale_count,
        m.question,
        m.slug,
        ms.volume_24hr AS volume_24h
      FROM signals s
      LEFT JOIN markets m ON m.token_id = s.token_id
      LEFT JOIN market_stats ms ON ms.token_id = s.token_id
      WHERE s.created_at >= NOW() - $1 * INTERVAL '1 hour'
      GROUP BY s.token_id, m.question, m.slug, ms.volume_24hr
      ORDER BY signal_count DESC
      LIMIT 20
    `;

    const top20Result = await pool.query(top20Query, [hours]);
    const rows = top20Result.rows as {
      token_id: string;
      signal_count: number;
      whale_count: number;
      question: string | null;
      slug: string | null;
      volume_24h: string | null;
    }[];

    if (rows.length === 0) {
      return NextResponse.json({ markets: [] });
    }

    const top20TokenIds = rows.map((r) => r.token_id);

    // Step 2: deterministic top signal type per token (LAW-MINOR-4)
    // Tie-break: COUNT DESC → MAX(confidence) DESC NULLS LAST → signal_type ASC
    const topTypeQuery = `
      SELECT DISTINCT ON (s.token_id)
        s.token_id,
        s.signal_type AS top_signal_type
      FROM signals s
      WHERE s.created_at >= NOW() - $1 * INTERVAL '1 hour'
        AND s.token_id = ANY($2)
      GROUP BY s.token_id, s.signal_type
      ORDER BY s.token_id,
               COUNT(*) DESC,
               MAX(s.confidence) DESC NULLS LAST,
               s.signal_type ASC
    `;

    const topTypeResult = await pool.query(topTypeQuery, [hours, top20TokenIds]);
    const topTypeMap = new Map<string, string>();
    for (const row of topTypeResult.rows as { token_id: string; top_signal_type: string }[]) {
      topTypeMap.set(row.token_id, row.top_signal_type);
    }

    const markets: MarketRow[] = rows.map((r) => ({
      token_id: r.token_id,
      question: r.question,
      slug: r.slug,
      signal_count: r.signal_count,
      whale_count: r.whale_count,
      top_signal_type: topTypeMap.get(r.token_id) ?? null,
      volume_24h: r.volume_24h,
    }));

    return NextResponse.json({ markets });
  } catch (err) {
    console.error("[api/markets] DB error:", err);
    return NextResponse.json(
      { error: "Failed to fetch markets" },
      { status: 500 }
    );
  }
}
