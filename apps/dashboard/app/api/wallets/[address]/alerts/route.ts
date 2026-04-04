import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { ALERT_TRADE_JOIN_SQL } from "@/lib/alert-hydration";
import type { AlertRow } from "@/app/api/alerts/route";

export async function GET(
  _request: NextRequest,
  { params }: { params: { address: string } }
) {
  const { address } = params;

  if (!address) {
    return NextResponse.json({ alerts: [] });
  }

  const query = `
    SELECT wa.*, t.side, t.proxy_wallet, m.question, m.slug
    FROM whale_alerts wa
    ${ALERT_TRADE_JOIN_SQL}
    LEFT JOIN markets m ON m.token_id = wa.token_id
    WHERE t.proxy_wallet = $1
    ORDER BY wa.alerted_at DESC
    LIMIT 20
  `;

  try {
    const result = await pool.query(query, [address]);
    return NextResponse.json({ alerts: result.rows as AlertRow[] });
  } catch (err) {
    console.error("[api/wallets/[address]/alerts] DB error:", err);
    return NextResponse.json(
      { error: "Failed to fetch wallet alerts" },
      { status: 500 }
    );
  }
}
