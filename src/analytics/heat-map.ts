import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../db/client.js";

interface HeatMapRow extends Record<string, unknown> {
  token_id: string;
  question: string | null;
  slug: string | null;
  signal_count: string;
  whale_count: string;
  max_conf: string | null;
}

export interface HeatMapEntry {
  tokenId: string;
  market: string;
  signalCount: number;
  whaleCount: number;
  maxConf: number;
}

function parseArg(argv: string[], flag: string, defaultVal: number, max = 168): number {
  const prefix = `--${flag}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  if (!arg) return defaultVal;
  const raw = arg.slice(prefix.length);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > max) {
    console.error(`Error: --${flag} must be a positive integer (1–${max}), got: ${raw}`);
    process.exit(1);
  }
  return n;
}

export async function fetchHeatMapData(
  db: ReturnType<typeof getDb>,
  hours: number
): Promise<HeatMapEntry[]> {
  const cutoff = new Date(Date.now() - hours * 3600 * 1000);

  const rows = await db.execute<HeatMapRow>(sql`
    SELECT
      s.token_id,
      m.question,
      m.slug,
      COUNT(*)::text AS signal_count,
      COUNT(*) FILTER (WHERE s.signal_type = 'WHALE_TRADE')::text AS whale_count,
      MAX(s.confidence::numeric)::text AS max_conf
    FROM signals s
    LEFT JOIN markets m ON s.token_id = m.token_id
    WHERE s.created_at >= ${cutoff.toISOString()}::timestamptz
    GROUP BY s.token_id, m.question, m.slug
    ORDER BY signal_count::int DESC
    LIMIT 20
  `);

  return (rows.rows as HeatMapRow[]).map((r) => ({
    tokenId: r.token_id,
    market: r.question || r.slug || r.token_id.slice(0, 20),
    signalCount: parseInt(r.signal_count, 10) || 0,
    whaleCount: parseInt(r.whale_count, 10) || 0,
    maxConf: Number(r.max_conf ?? 0),
  }));
}

export function renderHeatMap(entries: HeatMapEntry[], hours: number): string {
  const W = 66;
  const border = "═".repeat(W);
  const lines: string[] = [];

  lines.push(`╔${border}╗`);
  lines.push(`║  MARKET SIGNAL HEAT MAP  (last ${hours}h)${"".padStart(W - 30 - String(hours).length)}║`);
  lines.push(`╠${border}╣`);
  lines.push(`║  ${"Market".padEnd(26)} ${"Signals".padEnd(9)} ${"Whales".padEnd(7)} ${"Max Conf".padEnd(9)} ║`);
  lines.push(`╠${border}╣`);

  if (entries.length === 0) {
    lines.push(`║  ${"No signals in this period".padEnd(W - 2)} ║`);
  } else {
    const maxCount = entries[0].signalCount;
    for (const e of entries) {
      const barLen = maxCount > 0 ? Math.round((e.signalCount / maxCount) * 8) : 0;
      const bar = "█".repeat(barLen).padEnd(8, "░");
      const market = e.market.length > 24 ? e.market.slice(0, 23) + "…" : e.market;
      const conf = e.maxConf.toFixed(2);
      lines.push(`║  ${market.padEnd(26)} ${bar} ${String(e.signalCount).padEnd(5)} ${String(e.whaleCount).padEnd(7)} ${conf.padEnd(9)} ║`);
    }
  }

  lines.push(`╚${border}╝`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const hours = parseArg(argv, "hours", 24, 168);

  const db = getDb();

  try {
    const entries = await fetchHeatMapData(db, hours);
    console.log(renderHeatMap(entries, hours));
  } finally {
    await closeDb();
    process.exit(0);
  }
}

if (process.argv[1]?.endsWith("heat-map.js") || process.argv[1]?.endsWith("heat-map.ts")) {
  main().catch((err: unknown) => {
    console.error("Heatmap failed:", err);
    process.exit(1);
  });
}
