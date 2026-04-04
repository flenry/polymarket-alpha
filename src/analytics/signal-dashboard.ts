import { sql } from "drizzle-orm";
import { getDb, closeDb } from "../db/client.js";
import { config } from "../config.js";

interface SignalTypeRow extends Record<string, unknown> {
  signal_type: string;
  last_24h: string;
  last_nd: string;
  avg_conf: string | null;
}

interface WhaleStatsRow extends Record<string, unknown> {
  cnt: string;
  avg_val: string | null;
  max_val: string | null;
}

interface WhaleTopRow extends Record<string, unknown> {
  usdc_value: string;
  proxy_wallet: string | null;
  token_id: string;
}

export interface DashboardData {
  signalTypes: Array<{
    signalType: string;
    last24h: number;
    lastNd: number;
    avgConf: number;
  }>;
  whaleCount24h: number;
  whaleAvgSize: number;
  whaleLargest: number;
  whaleLargestWallet: string;
  whaleLargestToken: string;
  days: number;
}

function parseArg(argv: string[], flag: string, defaultVal: number): number {
  const prefix = `--${flag}=`;
  const arg = argv.find((a) => a.startsWith(prefix));
  if (!arg) return defaultVal;
  const raw = arg.slice(prefix.length);
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 365) {
    console.error(`Error: --${flag} must be a positive integer (1–365), got: ${raw}`);
    process.exit(1);
  }
  return n;
}

export async function fetchDashboardData(
  db: ReturnType<typeof getDb>,
  days: number
): Promise<DashboardData> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Query 1: signal type counts and avg confidence
  const signalRows = await db.execute<SignalTypeRow>(sql`
    SELECT
      signal_type,
      COUNT(*) FILTER (WHERE created_at >= ${cutoff24h.toISOString()}::timestamptz)::text AS last_24h,
      COUNT(*)::text AS last_nd,
      AVG(confidence::numeric)::text AS avg_conf
    FROM signals
    WHERE created_at >= ${cutoff.toISOString()}::timestamptz
    GROUP BY signal_type
    ORDER BY signal_type
  `);

  // Query 2: whale stats last 24h
  const whaleStats = await db.execute<WhaleStatsRow>(sql`
    SELECT
      COUNT(*)::text AS cnt,
      AVG(usdc_value::numeric)::text AS avg_val,
      MAX(usdc_value::numeric)::text AS max_val
    FROM whale_alerts
    WHERE alerted_at >= ${cutoff24h.toISOString()}::timestamptz
  `);

  // Query 3: largest whale last 24h
  const whaleTop = await db.execute<WhaleTopRow>(sql`
    SELECT
      usdc_value::text,
      NULL::text AS proxy_wallet,
      token_id
    FROM whale_alerts
    WHERE alerted_at >= ${cutoff24h.toISOString()}::timestamptz
    ORDER BY usdc_value::numeric DESC
    LIMIT 1
  `);

  const sRows = (signalRows.rows as SignalTypeRow[]).map((r) => ({
    signalType: r.signal_type,
    last24h: parseInt(r.last_24h, 10) || 0,
    lastNd: parseInt(r.last_nd, 10) || 0,
    avgConf: Number(r.avg_conf ?? 0),
  }));

  const wStats = (whaleStats.rows as WhaleStatsRow[])[0];
  const wTop = (whaleTop.rows as WhaleTopRow[])[0];

  return {
    signalTypes: sRows,
    whaleCount24h: parseInt(wStats?.cnt ?? "0", 10),
    whaleAvgSize: Number(wStats?.avg_val ?? 0),
    whaleLargest: Number(wTop?.usdc_value ?? 0),
    whaleLargestWallet: wTop?.proxy_wallet ?? "unknown",
    whaleLargestToken: wTop?.token_id ?? "unknown",
    days,
  };
}

export function renderDashboard(data: DashboardData): string {
  const W = 66;
  const border = "═".repeat(W);
  const lines: string[] = [];

  lines.push(`╔${border}╗`);
  lines.push(`║  SIGNAL DASHBOARD  (last ${data.days} days)${"".padStart(W - 26 - String(data.days).length)}║`);
  lines.push(`╠${border}╣`);
  lines.push(`║  ${"Signal Type".padEnd(24)} ${"Last 24h".padEnd(9)} ${"Last 7d".padEnd(8)} ${"Avg Conf".padEnd(9)} ║`);
  lines.push(`╠${border}╣`);

  const allTypes = ["WHALE_TRADE", "ORDER_BOOK_IMBALANCE", "PRICE_IMPACT_ANOMALY", "SENTIMENT_VELOCITY", "NEG_RISK_ARB", "NEG_RISK_OUTLIER"];
  for (const t of allTypes) {
    const row = data.signalTypes.find((r) => r.signalType === t);
    const h24 = String(row?.last24h ?? 0);
    const nd = String(row?.lastNd ?? 0);
    const conf = (row?.avgConf ?? 0).toFixed(2);
    lines.push(`║  ${t.padEnd(24)} ${h24.padEnd(9)} ${nd.padEnd(8)} ${conf.padEnd(9)} ║`);
  }

  lines.push(`╠${border}╣`);
  const avgStr = data.whaleAvgSize > 0
    ? `$${data.whaleAvgSize.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
    : "$0";
  lines.push(`║  WHALE ALERTS (last 24h): ${data.whaleCount24h}  |  Avg size: ${avgStr}${"".padStart(W - 25 - String(data.whaleCount24h).length - 14 - avgStr.length)}║`);

  if (data.whaleLargest > 0) {
    const largestStr = `$${(data.whaleLargest / 1_000_000).toFixed(1)}M`;
    const wallet = data.whaleLargestWallet.length > 10
      ? `${data.whaleLargestWallet.slice(0, 6)}…${data.whaleLargestWallet.slice(-4)}`
      : data.whaleLargestWallet;
    const tokenShort = data.whaleLargestToken.length > 10
      ? data.whaleLargestToken.slice(0, 10) + "…"
      : data.whaleLargestToken;
    lines.push(`║  Largest: ${largestStr}  ${wallet}  ${tokenShort}${"".padStart(Math.max(0, W - 10 - largestStr.length - 2 - wallet.length - 2 - tokenShort.length))}║`);
  }

  lines.push(`╚${border}╝`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const days = parseArg(argv, "days", 7);
  const once = argv.includes("--once");

  const db = getDb();

  const render = async () => {
    try {
      const data = await fetchDashboardData(db, days);
      if (!once) {
        process.stdout.write("\x1b[2J\x1b[H");
      }
      console.log(renderDashboard(data));
    } catch (err) {
      console.error("Dashboard render failed:", err);
    }
  };

  await render();

  if (once) {
    await closeDb();
    process.exit(0);
  }

  const interval = setInterval(() => {
    render().catch((err: unknown) => console.error("Dashboard error:", err));
  }, config.dashboardRefreshMs);

  const cleanup = async () => {
    clearInterval(interval);
    await closeDb();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (process.argv[1]?.endsWith("signal-dashboard.js") || process.argv[1]?.endsWith("signal-dashboard.ts")) {
  main().catch((err: unknown) => {
    console.error("Dashboard failed:", err);
    process.exit(1);
  });
}
