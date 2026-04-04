import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export interface VolumeBucket {
  hour: string;
  type: string;
  count: number;
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

  const query = `
    SELECT
      date_trunc('hour', created_at) AS hour,
      signal_type AS type,
      COUNT(*)::integer AS count
    FROM signals
    WHERE created_at >= NOW() - $1 * INTERVAL '1 hour'
    GROUP BY hour, signal_type
    ORDER BY hour ASC
  `;

  try {
    const result = await pool.query(query, [hours]);
    const buckets: VolumeBucket[] = result.rows.map((r) => ({
      hour: r.hour instanceof Date ? r.hour.toISOString() : String(r.hour),
      type: r.type as string,
      count: r.count as number,
    }));
    return NextResponse.json({ buckets });
  } catch (err) {
    console.error("[api/signals/volume] DB error:", err);
    return NextResponse.json(
      { error: "Failed to fetch signal volume" },
      { status: 500 }
    );
  }
}
