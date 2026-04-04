import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { SIGNAL_TYPES } from "@/lib/constants";

export type { SignalType } from "@/lib/constants";

export interface SignalRow {
  id: string;
  token_id: string;
  condition_id: string;
  signal_type: string;
  direction: string | null;
  confidence: string;
  strength: string | null;
  price_at_signal: string | null;
  spread_at_signal: string | null;
  volume_at_signal: string | null;
  whale_alert_id: string | null;
  order_book_snapshot_id: string | null;
  payload: unknown;
  created_at: string;
  // from JOIN
  question: string | null;
  slug: string | null;
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;

  const rawTypes = searchParams.get("types");
  const rawMinConf = searchParams.get("minConfidence");
  const rawHours = searchParams.get("hours") ?? "24";
  const tokenId = searchParams.get("tokenId");

  const hours = parseInt(rawHours, 10);
  if (isNaN(hours) || hours < 1 || hours > 168) {
    return NextResponse.json(
      { error: "Invalid hours parameter (1–168)" },
      { status: 400 }
    );
  }

  let types: string[] | null = null;
  if (rawTypes) {
    const requested = rawTypes.split(",").map((t) => t.trim());
    const invalid = requested.filter(
      (t) => !(SIGNAL_TYPES as readonly string[]).includes(t)
    );
    if (invalid.length > 0) {
      return NextResponse.json(
        { error: `Unknown signal type(s): ${invalid.join(", ")}` },
        { status: 400 }
      );
    }
    types = requested;
  }

  let minConf = 0;
  if (rawMinConf !== null) {
    minConf = parseFloat(rawMinConf);
    if (isNaN(minConf)) minConf = 0;
    minConf = Math.max(0, Math.min(1, minConf));
  }

  const params: unknown[] = [hours, minConf];
  const conditions: string[] = [
    `s.created_at >= NOW() - $1 * INTERVAL '1 hour'`,
    `s.confidence >= $2`,
  ];

  if (types && types.length > 0) {
    params.push(types);
    conditions.push(`s.signal_type = ANY($${params.length})`);
  }

  if (tokenId) {
    params.push(tokenId);
    conditions.push(`s.token_id = $${params.length}`);
  }

  const where = conditions.join(" AND ");

  const query = `
    SELECT
      s.*,
      m.question,
      m.slug
    FROM signals s
    LEFT JOIN markets m ON m.token_id = s.token_id
    WHERE ${where}
    ORDER BY s.created_at DESC
    LIMIT 200
  `;

  try {
    const result = await pool.query(query, params);
    return NextResponse.json({ signals: result.rows as SignalRow[] });
  } catch (err) {
    console.error("[api/signals] DB error:", err);
    return NextResponse.json({ signals: [] });
  }
}
